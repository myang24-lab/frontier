// Verification for step 6: fire 10 concurrent debits at a balance of 5.
// Exactly 5 must succeed, 5 must be refused, and the balance must land on 0 —
// never negative, not even momentarily in the log.
//
// Run: npm run check:concurrency
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Ledger } = require('../ledger');

const DB = path.join(os.tmpdir(), `ledger-concurrency-${process.pid}.sqlite`);
const STUDENT = 'student-under-test';
const STARTING_BALANCE = 5;
const ATTEMPTS = 10;

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + suffix); } catch (e) { /* not there */ }
  }
}

function debitInChildProcess() {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(__dirname, 'debit-once.js'), DB, STUDENT, '1'],
      (err, stdout) => {
        if (err && !stdout) return resolve({ ok: false, reason: 'spawn_failed', message: err.message });
        try { resolve(JSON.parse(stdout)); } catch (e) { resolve({ ok: false, reason: 'unparseable', stdout }); }
      }
    );
  });
}

(async () => {
  cleanup();

  const seed = new Ledger(DB);
  seed.credit(STUDENT, STARTING_BALANCE, { note: 'concurrency test seed' });
  console.log(`seeded ${STUDENT} with ${seed.getBalance(STUDENT)} tokens`);
  seed.close();

  // All ten launched before any of them finishes — genuinely overlapping.
  console.log(`firing ${ATTEMPTS} concurrent debits of 1...`);
  const results = await Promise.all(Array.from({ length: ATTEMPTS }, debitInChildProcess));

  const succeeded = results.filter((r) => r.ok).length;
  const refused = results.filter((r) => !r.ok && r.reason === 'insufficient_balance').length;
  const broken = results.filter((r) => !r.ok && r.reason !== 'insufficient_balance');

  const after = new Ledger(DB);
  const finalBalance = after.getBalance(STUDENT);
  const log = after.history(STUDENT, 100);
  const debits = log.filter((e) => e.kind === 'debit');
  const lowestRecorded = Math.min(...log.map((e) => e.balance_after));
  after.close();

  console.log(`\n  succeeded          ${succeeded}  (expected ${STARTING_BALANCE})`);
  console.log(`  refused            ${refused}  (expected ${ATTEMPTS - STARTING_BALANCE})`);
  console.log(`  final balance      ${finalBalance}  (expected 0)`);
  console.log(`  debits logged      ${debits.length}  (expected ${STARTING_BALANCE})`);
  console.log(`  lowest balance     ${lowestRecorded}  (must be >= 0)`);
  if (broken.length) console.log(`  unexpected errors  ${JSON.stringify(broken)}`);

  const failures = [];
  if (succeeded !== STARTING_BALANCE) failures.push(`${succeeded} debits succeeded, expected ${STARTING_BALANCE}`);
  if (refused !== ATTEMPTS - STARTING_BALANCE) failures.push(`${refused} refused, expected ${ATTEMPTS - STARTING_BALANCE}`);
  if (finalBalance !== 0) failures.push(`final balance ${finalBalance}, expected 0`);
  if (finalBalance < 0) failures.push('BALANCE WENT NEGATIVE');
  if (lowestRecorded < 0) failures.push(`log shows a negative balance (${lowestRecorded})`);
  if (debits.length !== STARTING_BALANCE) failures.push(`${debits.length} debits logged, expected ${STARTING_BALANCE}`);
  if (broken.length) failures.push(`${broken.length} attempts failed unexpectedly`);

  cleanup();

  if (failures.length) {
    console.error(`\n✕ FAILED\n  - ${failures.join('\n  - ')}\n`);
    process.exit(1);
  }
  console.log('\n✓ PASSED — five tokens bought exactly five messages, and the balance never went negative.\n');
})();
