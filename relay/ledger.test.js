// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Ledger, appTokensForMicroUSD } = require('./ledger');

let n = 0;
function freshLedger() {
  const file = path.join(os.tmpdir(), `ledger-test-${process.pid}-${n++}.sqlite`);
  const ledger = new Ledger(file);
  return {
    ledger,
    cleanup() {
      ledger.close();
      for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + s); } catch (e) {} }
    },
  };
}

test('an unknown student has a zero balance, not an error', () => {
  const { ledger, cleanup } = freshLedger();
  assert.strictEqual(ledger.getBalance('never-seen-before'), 0);
  cleanup();
});

test('credit then debit moves the balance and logs both', () => {
  const { ledger, cleanup } = freshLedger();
  ledger.credit('s1', 10, { note: 'quest reward' });
  assert.strictEqual(ledger.getBalance('s1'), 10);

  const result = ledger.debit('s1', 3, { model: 'claude-opus-5', effort: 'medium', costMicroUSD: 11000 });
  assert.deepStrictEqual(result, { ok: true, balance: 7, charged: 3 });

  const log = ledger.history('s1');
  assert.strictEqual(log.length, 2);
  assert.strictEqual(log[0].kind, 'debit');
  assert.strictEqual(log[0].balance_after, 7);
  assert.strictEqual(log[0].model, 'claude-opus-5');
  assert.strictEqual(log[0].cost_micro_usd, 11000);
  cleanup();
});

test('a debit larger than the balance is refused and changes nothing', () => {
  const { ledger, cleanup } = freshLedger();
  ledger.credit('s2', 2);
  const result = ledger.debit('s2', 5);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'insufficient_balance');
  assert.strictEqual(ledger.getBalance('s2'), 2, 'balance must be untouched');
  // A refusal is not a movement, so nothing is logged for it.
  assert.strictEqual(ledger.history('s2').filter((e) => e.kind === 'debit').length, 0);
  cleanup();
});

test('spending down to exactly zero is allowed; one more is not', () => {
  const { ledger, cleanup } = freshLedger();
  ledger.credit('s3', 3);
  assert.strictEqual(ledger.debit('s3', 3).ok, true);
  assert.strictEqual(ledger.getBalance('s3'), 0);
  assert.strictEqual(ledger.debit('s3', 1).ok, false);
  assert.strictEqual(ledger.getBalance('s3'), 0);
  cleanup();
});

test('balances are per student and never bleed across', () => {
  const { ledger, cleanup } = freshLedger();
  ledger.credit('alice', 5);
  ledger.credit('bob', 1);
  ledger.debit('alice', 5);
  assert.strictEqual(ledger.getBalance('alice'), 0);
  assert.strictEqual(ledger.getBalance('bob'), 1);
  cleanup();
});

test('nonsense amounts are rejected outright', () => {
  const { ledger, cleanup } = freshLedger();
  assert.throws(() => ledger.credit('s4', 0), /positive whole number/);
  assert.throws(() => ledger.credit('s4', -5), /positive whole number/);
  assert.throws(() => ledger.debit('s4', -1), /non-negative/);
  cleanup();
});

test('a zero-cost message is free rather than an error', () => {
  const { ledger, cleanup } = freshLedger();
  ledger.credit('s5', 1);
  assert.deepStrictEqual(ledger.debit('s5', 0), { ok: true, balance: 1, charged: 0 });
  cleanup();
});

test('the log survives reopening — it is the record, the balance is a total', () => {
  const file = path.join(os.tmpdir(), `ledger-persist-${process.pid}.sqlite`);
  let ledger = new Ledger(file);
  ledger.credit('s6', 4);
  ledger.debit('s6', 1);
  ledger.close();

  ledger = new Ledger(file);
  assert.strictEqual(ledger.getBalance('s6'), 3);
  assert.strictEqual(ledger.history('s6').length, 2);
  ledger.close();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + s); } catch (e) {} }
});

test('cost converts to whole app tokens, always rounding up', () => {
  // Rounding down would make a stream of cheap messages genuinely free.
  assert.strictEqual(appTokensForMicroUSD(0), 0);
  assert.strictEqual(appTokensForMicroUSD(1), 1);
  assert.strictEqual(appTokensForMicroUSD(4000), 1);
  assert.strictEqual(appTokensForMicroUSD(4001), 2);
  assert.strictEqual(appTokensForMicroUSD(18535), 5); // the real step-3 low-effort message
  assert.strictEqual(appTokensForMicroUSD(37060), 10); // the real step-3 max-effort message
});
