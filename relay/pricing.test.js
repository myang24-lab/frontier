// Run: npm test        (node --test, no dependencies, no network)
const test = require('node:test');
const assert = require('node:assert');
const { costOf, formatUSD } = require('./pricing');

// Floats: compare to a tolerance, never with ===.
const close = (actual, expected, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tol, `expected ~${expected}, got ${actual}`);

// ── Real responses recorded during steps 2-4. These are the regression anchor:
// if a rate is ever mistyped, these numbers move. ──────────────────────────────

test('opus-5, real step 3 usage at effort=low', () => {
  const c = costOf('claude-opus-5', { input_tokens: 87, output_tokens: 724 });
  close(c.usd.input, 0.000435);   // 87 * $5 / 1M
  close(c.usd.output, 0.0181);    // 724 * $25 / 1M
  close(c.totalUSD, 0.018535);
  assert.strictEqual(c.totalMicroUSD, 18535);
});

test('opus-5, real step 3 usage at effort=max — costs 2x low', () => {
  const low = costOf('claude-opus-5', { input_tokens: 87, output_tokens: 724 });
  const max = costOf('claude-opus-5', {
    input_tokens: 87,
    output_tokens: 1465,
    output_tokens_details: { thinking_tokens: 551 },
  });
  close(max.totalUSD, 0.037060);
  assert.ok(max.totalUSD / low.totalUSD > 1.9, 'max should cost about double low');
  // Thinking is a breakdown of output, not an extra charge on top.
  assert.strictEqual(max.tokens.thinking, 551);
  assert.strictEqual(max.tokens.visibleOutput, 914);
});

test('fable-5 is priced at 2x opus-5 on identical usage', () => {
  const usage = { input_tokens: 1000, output_tokens: 1000 };
  const opus = costOf('claude-opus-5', usage);
  const fable = costOf('claude-fable-5', usage);
  close(fable.totalUSD, opus.totalUSD * 2);
  close(fable.totalUSD, 0.06); // 1000*$10/1M + 1000*$50/1M
});

// ── Cache accounting ─────────────────────────────────────────────────────────

test('cache reads bill at 0.1x the input rate', () => {
  const c = costOf('claude-opus-5', { input_tokens: 0, cache_read_input_tokens: 10_000 });
  close(c.usd.cacheRead, 0.005); // 10k * $5 * 0.1 / 1M
  close(c.totalUSD, 0.005);
});

test('cache writes carry a premium: 1.25x at 5m, 2x at 1h', () => {
  const c = costOf('claude-opus-5', {
    cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 10_000 },
  });
  close(c.usd.cacheWrite, 0.0625 + 0.1); // 1.25x + 2x on $5/1M
});

test('an undifferentiated cache_creation_input_tokens total is treated as 5m', () => {
  const c = costOf('claude-opus-5', { cache_creation_input_tokens: 10_000 });
  close(c.usd.cacheWrite, 0.0625);
});

test('input_tokens is the uncached remainder — the three are never double-counted', () => {
  const c = costOf('claude-opus-5', {
    input_tokens: 100,
    cache_read_input_tokens: 200,
    cache_creation: { ephemeral_5m_input_tokens: 300 },
  });
  assert.strictEqual(c.tokens.promptTotal, 600);
  close(c.usd.input, 0.0005);          // only the 100 at full rate
  close(c.usd.cacheRead, 0.0001);      // 200 at 0.1x
  close(c.usd.cacheWrite, 0.001875);   // 300 at 1.25x
});

// ── Robustness ───────────────────────────────────────────────────────────────

test('an unpriced model throws rather than costing zero', () => {
  assert.throws(() => costOf('claude-sonnet-5', { output_tokens: 1000 }), /No price on file/);
});

test('missing, null and negative fields count as zero', () => {
  assert.strictEqual(costOf('claude-opus-5', {}).totalUSD, 0);
  assert.strictEqual(costOf('claude-opus-5', undefined).totalUSD, 0);
  const c = costOf('claude-opus-5', { input_tokens: -5, output_tokens: null });
  assert.strictEqual(c.totalUSD, 0);
});

test('thinking is null, not zero, when the API omits the breakdown', () => {
  // Streaming responses have been observed without output_tokens_details.
  const c = costOf('claude-opus-5', { input_tokens: 30, output_tokens: 1195 });
  assert.strictEqual(c.tokens.thinking, null);
  assert.strictEqual(c.tokens.visibleOutput, null);
  // 30 * $5/1M + 1195 * $25/1M — billing is unaffected by the missing breakdown
  close(c.totalUSD, 0.000150 + 0.029875);
});

test('micro-dollars are whole numbers, for drift-free ledger arithmetic', () => {
  const c = costOf('claude-fable-5', { input_tokens: 22, output_tokens: 39 });
  assert.strictEqual(Number.isInteger(c.totalMicroUSD), true);
  assert.strictEqual(c.totalMicroUSD, 2170); // $0.00217
});

// ── Reasoning split ──────────────────────────────────────────────────────────

test('the exact breakdown is used when the API provides it', () => {
  const s = require('./pricing').splitOutput(
    { output_tokens: 1465, output_tokens_details: { thinking_tokens: 551 } },
    { thinkingChars: 999, textChars: 1 } // ignored — exact wins
  );
  assert.strictEqual(s.thinkingTokens, 551);
  assert.strictEqual(s.visibleTokens, 914);
  assert.strictEqual(s.estimated, false);
});

test('streamed responses split the output total by characters', () => {
  // Streaming omits output_tokens_details, so allocate the known total in
  // proportion to how much of each kind came down the wire.
  const s = require('./pricing').splitOutput(
    { output_tokens: 1000 },
    { thinkingChars: 3000, textChars: 1000 }
  );
  assert.strictEqual(s.thinkingTokens, 750);
  assert.strictEqual(s.visibleTokens, 250);
  assert.strictEqual(s.thinkingShare, 0.75);
  assert.strictEqual(s.estimated, true, 'must be labelled an estimate');
});

test('no characters and no breakdown yields null, not a fake zero', () => {
  const s = require('./pricing').splitOutput({ output_tokens: 100 }, {});
  assert.strictEqual(s.thinkingTokens, null);
  assert.strictEqual(s.estimated, true);
});

test('formatUSD keeps sub-cent amounts legible', () => {
  assert.strictEqual(formatUSD(0), '$0.00');
  assert.strictEqual(formatUSD(0.00217), '$0.00217');
  assert.strictEqual(formatUSD(0.0371), '$0.0371');
});
