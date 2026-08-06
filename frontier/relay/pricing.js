// Turns a Claude `usage` object into real money.
//
// Rates come from models.js, so a model cannot be priced unless it is also on
// the allowlist — and vice versa. Everything here is pure arithmetic: no
// network, no clock, no state. That's what makes it testable.
//
// Two things about the usage shape that are easy to get wrong:
//
//  1. `input_tokens` is the UNCACHED REMAINDER, not the whole prompt. Total
//     prompt size is input_tokens + cache_creation_* + cache_read_*. So the
//     three are summed separately and never double-counted.
//
//  2. `output_tokens` ALREADY INCLUDES thinking tokens. Thinking is billed at
//     the output rate like any other output. `output_tokens_details.thinking_tokens`
//     is a breakdown of that total, not an extra charge on top — adding it
//     would roughly double the bill on a high-effort message.
const models = require('./models');

// Cache reads are ~0.1x the input rate. Writes carry a premium for the privilege
// of populating the cache: 1.25x at the 5-minute TTL, 2x at the 1-hour TTL.
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2.0;

const PER_MILLION = 1_000_000;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * @param {string} modelId  must be on the allowlist in models.js
 * @param {object} usage    the raw `usage` object from the API
 * @returns {{model, tokens, usd, totalUSD, totalMicroUSD}}
 */
function costOf(modelId, usage) {
  const spec = models.get(modelId);
  if (!spec) {
    // Loud on purpose. Silently pricing an unknown model at zero would let
    // spending happen that no ledger ever sees.
    throw new Error(`No price on file for model "${modelId}". Add it to models.js before it can be called.`);
  }
  const rate = spec.pricePerMTok;
  const u = usage || {};

  const uncachedInput = num(u.input_tokens);
  const cacheRead = num(u.cache_read_input_tokens);

  // Newer responses break cache writes down by TTL; older ones report a single
  // total. Fall back to treating an undifferentiated total as 5-minute.
  const creation = u.cache_creation || {};
  let cacheWrite5m = num(creation.ephemeral_5m_input_tokens);
  const cacheWrite1h = num(creation.ephemeral_1h_input_tokens);
  if (!cacheWrite5m && !cacheWrite1h) cacheWrite5m = num(u.cache_creation_input_tokens);

  const output = num(u.output_tokens);

  // Reported when available; purely informational — already inside `output`.
  const details = u.output_tokens_details || {};
  const thinking = typeof details.thinking_tokens === 'number' ? details.thinking_tokens : null;

  const usd = {
    input: (uncachedInput * rate.input) / PER_MILLION,
    cacheRead: (cacheRead * rate.input * CACHE_READ_MULTIPLIER) / PER_MILLION,
    cacheWrite:
      (cacheWrite5m * rate.input * CACHE_WRITE_5M_MULTIPLIER) / PER_MILLION +
      (cacheWrite1h * rate.input * CACHE_WRITE_1H_MULTIPLIER) / PER_MILLION,
    output: (output * rate.output) / PER_MILLION,
  };
  const totalUSD = usd.input + usd.cacheRead + usd.cacheWrite + usd.output;

  return {
    model: modelId,
    rate,
    tokens: {
      input: uncachedInput,
      cacheRead,
      cacheWrite: cacheWrite5m + cacheWrite1h,
      output,
      thinking, // null when the API didn't break it out
      visibleOutput: thinking === null ? null : output - thinking,
      promptTotal: uncachedInput + cacheRead + cacheWrite5m + cacheWrite1h,
    },
    usd,
    totalUSD,
    // Integer micro-dollars ($0.000001). The ledger in step 6 does its
    // arithmetic in whole numbers so repeated float addition can't drift.
    totalMicroUSD: Math.round(totalUSD * PER_MILLION),
  };
}

/**
 * How much of the output was reasoning the student never saw?
 *
 * This is the most useful number the feature has for teaching — at max effort
 * a message can spend 46x more on thinking than at low, while the visible
 * answer barely grows. But `output_tokens_details.thinking_tokens` is only
 * returned on non-streaming responses, and every real message is streamed.
 *
 * So: when the exact breakdown is there, use it. Otherwise split the known
 * output total in proportion to the characters of each kind that came down the
 * stream. Both are prose at a similar characters-per-token ratio, which makes
 * this close — but it's an estimate, and it says so.
 */
function splitOutput(usage, { thinkingChars = 0, textChars = 0 } = {}) {
  const output = num((usage || {}).output_tokens);
  const exact = ((usage || {}).output_tokens_details || {}).thinking_tokens;

  if (typeof exact === 'number') {
    return { thinkingTokens: exact, visibleTokens: output - exact, thinkingShare: output ? exact / output : 0, estimated: false };
  }
  const total = thinkingChars + textChars;
  if (!total || !output) {
    return { thinkingTokens: null, visibleTokens: null, thinkingShare: null, estimated: true };
  }
  const thinkingTokens = Math.round((output * thinkingChars) / total);
  return {
    thinkingTokens,
    visibleTokens: output - thinkingTokens,
    thinkingShare: thinkingChars / total,
    estimated: true,
  };
}

// Costs here run to fractions of a cent, so the usual 2dp is useless.
function formatUSD(usd) {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}

module.exports = {
  costOf,
  splitOutput,
  formatUSD,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
};
