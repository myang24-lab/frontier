// The single place a model becomes callable.
//
// Prices live here alongside the allowlist on purpose: a model cannot be added
// to one without the other, so nothing can ever be called at a price we don't
// know. Step 5's cost calculation reads these same rates.
//
// Rates are USD per million tokens.
const MODELS = {
  'claude-opus-5': {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    tier: 'workhorse',
    pricePerMTok: { input: 5, output: 25 },
  },
  'claude-fable-5': {
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    tier: 'frontier',
    pricePerMTok: { input: 10, output: 50 },
    // Requires 30-day data retention. Under zero data retention every request
    // returns a 400 regardless of how valid the payload is.
    requiresDataRetention: true,
  },
};

// Neither model is sent a `thinking` parameter.
//   - claude-fable-5: thinking is always on; sending the parameter at all is a 400.
//   - claude-opus-5: thinking is on by default, so omitting it is the same as
//     asking for adaptive.
// Neither accepts temperature / top_p / top_k — don't reintroduce them.

// Effort controls how much the model thinks before answering — and thinking
// bills as output tokens, so this is the main cost dial students will hold.
// Both models support all five levels. Omitting it means the API default, `high`.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_EFFORT = 'high'; // what the API does when output_config is absent

function isValidEffort(effort) {
  return EFFORT_LEVELS.includes(effort);
}

const ALLOWED = Object.keys(MODELS);

function isAllowed(id) {
  return Object.prototype.hasOwnProperty.call(MODELS, id);
}

function get(id) {
  return MODELS[id] || null;
}

module.exports = {
  MODELS,
  ALLOWED,
  isAllowed,
  get,
  EFFORT_LEVELS,
  DEFAULT_EFFORT,
  isValidEffort,
};
