// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { planSpend, microUSDFor, MIN_USEFUL_OUTPUT_TOKENS } = require('./metering');
const { MICRO_USD_PER_APP_TOKEN } = require('./ledger');

const HARD_CAP = 8000;
const plan = (over) =>
  planSpend({ modelId: 'claude-opus-5', balanceTokens: 20, estimatedInputTokens: 100, hardCapTokens: HARD_CAP, ...over });

test('micro-dollars are tokens x rate — the millions cancel', () => {
  assert.strictEqual(microUSDFor(1000, 25), 25000); // 1000 output tokens on opus = $0.025
  assert.strictEqual(microUSDFor(87, 5), 435);      // the real step-3 input
});

test('a healthy balance gets the full hard cap', () => {
  // 200 tokens = $0.80; 8000 output tokens on opus = $0.20. Plenty.
  const p = plan({ balanceTokens: 200 });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.maxTokens, HARD_CAP);
});

test('a small balance caps max_tokens instead of refusing', () => {
  // This is the whole design: the model physically cannot generate more than
  // the student can pay for, so the worst case is bounded by the balance.
  const p = plan({ balanceTokens: 3 });
  assert.strictEqual(p.ok, true);
  assert.ok(p.maxTokens < HARD_CAP, 'should be capped below the hard cap');
  assert.ok(p.maxTokens >= MIN_USEFUL_OUTPUT_TOKENS);

  // Worst case must fit inside the balance.
  const budget = 3 * MICRO_USD_PER_APP_TOKEN;
  assert.ok(p.worstCaseMicroUSD <= budget, `worst case ${p.worstCaseMicroUSD} exceeds budget ${budget}`);
});

test('the hold never exceeds the balance', () => {
  for (const balanceTokens of [1, 2, 3, 5, 9, 20, 137]) {
    const p = plan({ balanceTokens });
    if (p.ok) assert.ok(p.holdTokens <= balanceTokens, `hold ${p.holdTokens} > balance ${balanceTokens}`);
  }
});

test('a balance too small for a useful reply is refused, not truncated', () => {
  // Better an honest "out of tokens" than a reply cut off mid-sentence that the
  // student still paid for. A long prompt eats most of one token's budget,
  // leaving too little output to be worth generating.
  const p = plan({ balanceTokens: 1, estimatedInputTokens: 1500 });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, 'insufficient_balance');
  assert.ok(p.neededTokens > 1);
});

test('zero balance is refused', () => {
  const p = plan({ balanceTokens: 0 });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, 'insufficient_balance');
});

test('a prompt costing more than the balance is refused before any call', () => {
  const p = plan({ balanceTokens: 2, estimatedInputTokens: 5_000_000 });
  assert.strictEqual(p.ok, false);
});

test('fable-5 affords half as much output as opus-5 on the same balance', () => {
  const opus = planSpend({ modelId: 'claude-opus-5', balanceTokens: 5, estimatedInputTokens: 100, hardCapTokens: HARD_CAP });
  const fable = planSpend({ modelId: 'claude-fable-5', balanceTokens: 5, estimatedInputTokens: 100, hardCapTokens: HARD_CAP });
  assert.ok(opus.ok && fable.ok);
  const ratio = opus.maxTokens / fable.maxTokens;
  assert.ok(ratio > 1.9 && ratio < 2.1, `expected ~2x, got ${ratio}`);
});

test('an unpriced model throws rather than planning a free spend', () => {
  assert.throws(() => plan({ modelId: 'claude-sonnet-5' }), /No price on file/);
});
