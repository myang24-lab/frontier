// What a message *typically* costs, as opposed to the ceiling.
//
// The design shows two numbers side by side: "up to 13 tokens" and
// "usually ~7". The first is computed per-request from the balance and the
// prompt; the second can only come from having measured real messages.
//
// Without the second number the ceiling reads as the price, and it overstates
// by roughly 4x — which is exactly the mistake the whole cost-teaching design
// is built to avoid.
//
// Values are median micro-dollars from `npm run calibrate`: 12 representative
// student prompts per cell. A `null` means that combination has not been
// measured — the API returns null rather than a guess, and the UI omits the
// "usually" line rather than inventing one.
const models = require('./models');
const { appTokensForMicroUSD } = require('./ledger');

const TYPICAL_MICRO_USD = {
  'claude-opus-5': {
    low: 33200,     // measured
    medium: 51400,  // measured
    high: null,     // not yet measured
    xhigh: null,    // not yet measured
    max: 76600,     // measured
  },
  'claude-fable-5': {
    low: 47500,     // measured
    medium: 49700,  // measured
    high: null,     // not yet measured
    xhigh: null,    // not yet measured
    max: 200400,    // measured — every sample hit the 4000-token ceiling,
                    // so this is a floor as much as a median
  },
};

/** Median micro-dollars for a model/effort pair, or null if unmeasured. */
function typicalMicroUSD(modelId, effort) {
  const row = TYPICAL_MICRO_USD[modelId];
  if (!row) return null;
  const value = row[effort || models.DEFAULT_EFFORT];
  return typeof value === 'number' ? value : null;
}

/** Typical charge in app tokens, or null if that cell hasn't been measured. */
function typicalTokenCost(modelId, effort) {
  const micro = typicalMicroUSD(modelId, effort);
  return micro === null ? null : appTokensForMicroUSD(micro);
}

module.exports = { TYPICAL_MICRO_USD, typicalMicroUSD, typicalTokenCost };
