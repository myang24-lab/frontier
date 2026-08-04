// Decides, before a single token is generated, what a student can afford.
//
// The hard problem: cost depends on output length, and output length isn't
// knowable until after you've paid for it. Holding a worst-case amount against
// the 8000-token ceiling would mean a student needs ~100 tokens in hand to send
// any message at all.
//
// The fix is to make the worst case small instead of guessing it: cap
// `max_tokens` to what this student's balance can actually cover. The model
// physically cannot generate more than the balance pays for, so the hold is
// bounded, and settling afterwards refunds whatever wasn't used.
//
// Pure arithmetic — no network, no database. That's what makes it testable.
const models = require('./models');
const { MICRO_USD_PER_APP_TOKEN, appTokensForMicroUSD } = require('./ledger');

// Below this, a reply isn't worth sending — it would be cut off mid-sentence
// and the student would have paid for a fragment. Better to say "out of tokens"
// honestly and fall back to the local model.
const MIN_USEFUL_OUTPUT_TOKENS = 256;

// microUSD = tokens × pricePerMTok exactly:
//   dollars = tokens × rate / 1e6, and microUSD = dollars × 1e6.
// The two factors of a million cancel, so this stays whole-number arithmetic.
function microUSDFor(tokens, ratePerMTok) {
  return tokens * ratePerMTok;
}

/**
 * @returns {{ok:true, maxTokens, holdTokens, estimatedInputTokens, worstCaseMicroUSD}}
 *        | {ok:false, reason:'insufficient_balance', balanceTokens, neededTokens}
 */
function planSpend({ modelId, balanceTokens, estimatedInputTokens, hardCapTokens }) {
  const spec = models.get(modelId);
  if (!spec) throw new Error(`No price on file for model "${modelId}".`);
  const rate = spec.pricePerMTok;

  const budgetMicroUSD = balanceTokens * MICRO_USD_PER_APP_TOKEN;
  const inputMicroUSD = microUSDFor(estimatedInputTokens, rate.input);

  // The prompt alone costs more than they have.
  if (inputMicroUSD >= budgetMicroUSD) {
    return {
      ok: false,
      reason: 'insufficient_balance',
      balanceTokens,
      neededTokens: appTokensForMicroUSD(inputMicroUSD + MIN_USEFUL_OUTPUT_TOKENS * rate.output),
      estimatedInputTokens,
    };
  }

  const remainingMicroUSD = budgetMicroUSD - inputMicroUSD;
  const affordableOutputTokens = Math.floor(remainingMicroUSD / rate.output);
  const maxTokens = Math.min(hardCapTokens, affordableOutputTokens);

  if (maxTokens < MIN_USEFUL_OUTPUT_TOKENS) {
    return {
      ok: false,
      reason: 'insufficient_balance',
      balanceTokens,
      neededTokens: appTokensForMicroUSD(inputMicroUSD + MIN_USEFUL_OUTPUT_TOKENS * rate.output),
      estimatedInputTokens,
    };
  }

  const worstCaseMicroUSD = inputMicroUSD + microUSDFor(maxTokens, rate.output);
  // Rounding up to whole tokens can overshoot the balance by one; never hold
  // more than they have, or the debit fails on a plan we just said was fine.
  const holdTokens = Math.min(balanceTokens, appTokensForMicroUSD(worstCaseMicroUSD));

  return { ok: true, maxTokens, holdTokens, estimatedInputTokens, worstCaseMicroUSD };
}

// ── Cost warnings ────────────────────────────────────────────────────────────
// A conversation gets more expensive every turn, because the whole history is
// resent each time. Caching softens that but doesn't remove it. Rather than
// silently trimming old turns — which makes the model quietly forget things,
// confusing when you notice and worse when you don't — say so and let the
// student decide whether to start fresh.

const WARN_AT_BALANCE_FRACTION = 0.25; // one message eating a quarter of the balance
const WARN_AT_INPUT_TOKENS = 20_000;   // history long enough to dominate the cost

function warningsFor({ plan, balanceTokens, estimatedInputTokens, messageCount }) {
  const warnings = [];
  if (!plan.ok) return warnings;

  if (balanceTokens > 0 && plan.holdTokens / balanceTokens >= WARN_AT_BALANCE_FRACTION) {
    warnings.push({
      code: 'expensive_message',
      message: `This message could use up to ${plan.holdTokens} of your ${balanceTokens} tokens.`,
    });
  }
  if (estimatedInputTokens >= WARN_AT_INPUT_TOKENS) {
    warnings.push({
      code: 'long_conversation',
      message:
        `This conversation is ${estimatedInputTokens.toLocaleString()} tokens long and gets resent every turn, ` +
        `so each message costs more than the last. Starting a new conversation resets that.`,
    });
  }
  if (messageCount >= 40) {
    warnings.push({
      code: 'many_turns',
      message: `${messageCount} messages in this conversation. A fresh one will be cheaper and often sharper.`,
    });
  }
  return warnings;
}

module.exports = {
  planSpend,
  microUSDFor,
  warningsFor,
  MIN_USEFUL_OUTPUT_TOKENS,
  WARN_AT_BALANCE_FRACTION,
  WARN_AT_INPUT_TOKENS,
};
