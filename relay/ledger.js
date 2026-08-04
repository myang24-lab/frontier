// The token ledger: who has what, and where it went.
//
// Uses node:sqlite (built into Node) so there's no native module to compile —
// the project already had trouble with node-pty's prebuilt binary, and this is
// the piece that must not be flaky.
//
// Two rules this file exists to enforce:
//
//   1. A balance can never go negative. Not "shouldn't" — can't. The debit is a
//      single conditional UPDATE, so a balance of 1 cannot satisfy two
//      simultaneous debits of 1 no matter how the requests interleave.
//
//   2. Every movement is logged, append-only. The balance is a running total,
//      but the log is the record. If they ever disagree, the log is right.
//
// Money is stored as integer micro-dollars ($0.000001) and app tokens as whole
// integers. No floats anywhere in here — repeated float addition drifts, and a
// balance that slowly diverges from reality is a miserable bug to chase.
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// ── Exchange rate ────────────────────────────────────────────────────────────
// How much real money one app token is worth. PLACEHOLDER — step 8 replaces
// this with a value derived from measured usage across both models and all
// five effort levels.
//
// Working figure: 4000 micro-dollars = $0.004 per app token. On the numbers
// recorded in step 3, that puts a medium-effort Opus 5 message at ~5 tokens and
// a max-effort one at ~10.
const MICRO_USD_PER_APP_TOKEN = 4000;

// Students are never charged a fraction of a token, and rounding down would let
// a stream of cheap messages cost nothing at all. Always round up.
function appTokensForMicroUSD(microUSD) {
  if (!microUSD || microUSD <= 0) return 0;
  return Math.ceil(microUSD / MICRO_USD_PER_APP_TOKEN);
}

// ── Storage ──────────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = process.env.LEDGER_DB || path.join(__dirname, 'ledger.sqlite');

// A spend_log row created before step 7 only permits 'debit' and 'credit'.
// Rebuild it so settlements can be recorded. SQLite can't ALTER a CHECK
// constraint, so the table is recreated and the rows copied across.
function migrateSpendLogKinds(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='spend_log'").get();
  if (!row || row.sql.includes("'settle'")) return;
  db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE spend_log RENAME TO spend_log_old;
    CREATE TABLE spend_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              TEXT    NOT NULL,
      student_id      TEXT    NOT NULL,
      kind            TEXT    NOT NULL CHECK (kind IN ('debit','credit','settle')),
      app_tokens      INTEGER NOT NULL,
      balance_after   INTEGER NOT NULL,
      model           TEXT,
      effort          TEXT,
      input_tokens    INTEGER,
      output_tokens   INTEGER,
      thinking_tokens INTEGER,
      cost_micro_usd  INTEGER,
      note            TEXT
    );
    INSERT INTO spend_log SELECT * FROM spend_log_old;
    DROP TABLE spend_log_old;
    COMMIT;
  `);
}

function open(dbPath = DEFAULT_DB_PATH) {
  const db = new DatabaseSync(dbPath);
  // WAL lets readers work while a writer holds the lock; busy_timeout makes a
  // contended writer wait its turn instead of failing instantly.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS balances (
      student_id  TEXT PRIMARY KEY,
      tokens      INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),
      updated_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS spend_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              TEXT    NOT NULL,
      student_id      TEXT    NOT NULL,
      kind            TEXT    NOT NULL CHECK (kind IN ('debit','credit','settle')),
      app_tokens      INTEGER NOT NULL,
      balance_after   INTEGER NOT NULL,
      model           TEXT,
      effort          TEXT,
      input_tokens    INTEGER,
      output_tokens   INTEGER,
      thinking_tokens INTEGER,
      cost_micro_usd  INTEGER,
      note            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_spend_student_ts ON spend_log (student_id, ts);
  `);
  migrateSpendLogKinds(db);
  return db;
}

class Ledger {
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.db = open(dbPath);
  }

  close() {
    this.db.close();
  }

  getBalance(studentId) {
    const row = this.db.prepare('SELECT tokens FROM balances WHERE student_id = ?').get(studentId);
    return row ? row.tokens : 0;
  }

  /** Add tokens. Used by quest rewards and local-model use. */
  credit(studentId, appTokens, meta = {}) {
    const amount = Math.trunc(appTokens);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('credit amount must be a positive whole number of app tokens');
    }
    return this.#transact(() => {
      this.db
        .prepare(`
          INSERT INTO balances (student_id, tokens, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(student_id) DO UPDATE SET tokens = tokens + excluded.tokens, updated_at = excluded.updated_at
        `)
        .run(studentId, amount, new Date().toISOString());
      const balance = this.getBalance(studentId);
      this.#log(studentId, 'credit', amount, balance, meta);
      return { ok: true, balance };
    });
  }

  /**
   * Spend tokens. Returns { ok:false, reason:'insufficient_balance' } rather
   * than throwing — running out is an ordinary thing that happens to students,
   * not an exceptional condition. Step 7 turns that into the local fallback.
   */
  debit(studentId, appTokens, meta = {}) {
    const amount = Math.trunc(appTokens);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error('debit amount must be a non-negative whole number of app tokens');
    }
    if (amount === 0) return { ok: true, balance: this.getBalance(studentId), charged: 0 };

    return this.#transact(() => {
      // The whole safety property lives in this one statement. The `tokens >= ?`
      // guard is evaluated by SQLite while it holds the write lock, so a check
      // followed by a separate write — which could interleave — never happens.
      const result = this.db
        .prepare('UPDATE balances SET tokens = tokens - ?, updated_at = ? WHERE student_id = ? AND tokens >= ?')
        .run(amount, new Date().toISOString(), studentId, amount);

      if (result.changes === 0) {
        const balance = this.getBalance(studentId);
        return { ok: false, reason: 'insufficient_balance', balance, needed: amount, charged: 0 };
      }
      const balance = this.getBalance(studentId);
      this.#log(studentId, 'debit', amount, balance, meta);
      return { ok: true, balance, charged: amount };
    });
  }

  /**
   * Close out a message: the hold was taken up front against a worst case, and
   * the real cost is nearly always lower. Refund the difference and record what
   * actually happened.
   *
   * The settle row carries the real usage, so the spend log — not the balance —
   * is what step 8 reads to calibrate the exchange rate.
   */
  settle(studentId, heldTokens, actualMicroUSD, meta = {}) {
    const held = Math.trunc(heldTokens);
    let charged = appTokensForMicroUSD(actualMicroUSD);

    // Shouldn't happen: max_tokens is capped to what the balance can cover, so
    // actual can't exceed the hold. If it ever does, absorb the difference
    // rather than pushing a student negative — and leave a note saying so.
    let underHeld = 0;
    if (charged > held) {
      underHeld = charged - held;
      charged = held;
    }
    const refund = held - charged;

    return this.#transact(() => {
      if (refund > 0) {
        this.db
          .prepare('UPDATE balances SET tokens = tokens + ?, updated_at = ? WHERE student_id = ?')
          .run(refund, new Date().toISOString(), studentId);
      }
      const balance = this.getBalance(studentId);
      this.#log(studentId, 'settle', charged, balance, {
        ...meta,
        costMicroUSD: actualMicroUSD,
        note: underHeld
          ? `${meta.note ? meta.note + '; ' : ''}under-held by ${underHeld} tokens, absorbed`
          : meta.note ?? null,
      });
      return { charged, refunded: refund, held, balance, underHeld };
    });
  }

  /** Most recent movements, newest first. For the student's own spend history. */
  history(studentId, limit = 50) {
    return this.db
      .prepare('SELECT * FROM spend_log WHERE student_id = ? ORDER BY id DESC LIMIT ?')
      .all(studentId, Math.min(Math.max(1, limit | 0), 500));
  }

  // BEGIN IMMEDIATE takes the write lock up front rather than upgrading to it
  // mid-transaction, which is where SQLite's deadlock-ish failures come from.
  #transact(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch (e) { /* already unwound */ }
      throw err;
    }
  }

  #log(studentId, kind, appTokens, balanceAfter, meta) {
    this.db
      .prepare(`
        INSERT INTO spend_log
          (ts, student_id, kind, app_tokens, balance_after, model, effort,
           input_tokens, output_tokens, thinking_tokens, cost_micro_usd, note)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      .run(
        new Date().toISOString(),
        studentId,
        kind,
        appTokens,
        balanceAfter,
        meta.model ?? null,
        meta.effort ?? null,
        meta.inputTokens ?? null,
        meta.outputTokens ?? null,
        meta.thinkingTokens ?? null,
        meta.costMicroUSD ?? null,
        meta.note ?? null
      );
  }
}

module.exports = { Ledger, appTokensForMicroUSD, MICRO_USD_PER_APP_TOKEN, DEFAULT_DB_PATH };
