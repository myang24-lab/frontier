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

test('settle charges the real cost and refunds the rest of the hold', () => {
  const { ledger, cleanup } = freshLedger();
  ledger.credit('s7', 20);
  ledger.debit('s7', 10, { note: 'hold' });
  assert.strictEqual(ledger.getBalance('s7'), 10);

  // Real cost came in at $0.012 = 3 tokens. Seven go back.
  const outcome = ledger.settle('s7', 10, 12000, { model: 'claude-opus-5', effort: 'low' });
  assert.strictEqual(outcome.charged, 3);
  assert.strictEqual(outcome.refunded, 7);
  assert.strictEqual(outcome.balance, 17);
  assert.strictEqual(ledger.getBalance('s7'), 17);

  // The settle row carries the real usage — this is what step 8 reads.
  const settleRow = ledger.history('s7').find((e) => e.kind === 'settle');
  assert.strictEqual(settleRow.cost_micro_usd, 12000);
  assert.strictEqual(settleRow.model, 'claude-opus-5');
  cleanup();
});

test('a refused message costs almost nothing and returns almost all the hold', () => {
  const { ledger, cleanup } = freshLedger();
  ledger.credit('s8', 12);
  ledger.debit('s8', 12, { note: 'hold' });
  // Safety refusals arrive with near-zero usage.
  const outcome = ledger.settle('s8', 12, 0, { note: 'refused by safety classifier' });
  assert.strictEqual(outcome.charged, 0);
  assert.strictEqual(outcome.refunded, 12);
  assert.strictEqual(ledger.getBalance('s8'), 12, 'a refusal must not cost the student anything');
  cleanup();
});

test('an under-held message is absorbed, never pushed negative', () => {
  const { ledger, cleanup } = freshLedger();
  ledger.credit('s9', 5);
  ledger.debit('s9', 5, { note: 'hold' });
  // Cost came in above the hold — shouldn't be possible, but must be survivable.
  const outcome = ledger.settle('s9', 5, 40000, {}); // $0.04 = 10 tokens
  assert.strictEqual(outcome.charged, 5, 'capped at what was held');
  assert.strictEqual(outcome.underHeld, 5);
  assert.strictEqual(ledger.getBalance('s9'), 0);
  assert.match(ledger.history('s9')[0].note, /under-held by 5/);
  cleanup();
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
