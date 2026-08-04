// Step 8 — measure what student messages actually cost, then derive the
// exchange rate from real numbers instead of a guess.
//
// ⚠ SPENDS REAL MONEY. Prints an estimate and refuses to run without --confirm.
//
//   npm run calibrate            # show the plan and the cost estimate
//   npm run calibrate -- --confirm
//   npm run calibrate -- --confirm --quick   # 4 prompts instead of 12
//
// Calls the Anthropic API directly rather than going through /message: this is
// measuring raw cost, and routing it through the ledger would mean inventing
// balances big enough not to interfere with what we're trying to observe.
//
// Also records latency, which the step-9 design brief needs — a loading state
// has to be designed against how long the pause actually is.
const fs = require('node:fs');
const path = require('node:path');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./../config');
const models = require('./../models');
const pricing = require('./../pricing');

config.require();
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// Representative of what a student would actually send: homework, code, essays,
// research, maths. Deliberately mixed in length and difficulty — calibrating on
// only short prompts would set a rate that collapses on the first real essay.
const PROMPTS = [
  { id: 'quick-fact', text: 'What causes the seasons on Earth? Answer in a short paragraph.' },
  { id: 'homework-math', text: 'Solve 3x^2 - 12x + 9 = 0 and explain each step so I could redo it myself.' },
  { id: 'code-debug', text: 'This Python function returns None sometimes and I do not know why:\n\ndef find_max(nums):\n    best = 0\n    for n in nums:\n        if n > best:\n            best = n\n    return best\n\nWhat is wrong and how do I fix it?' },
  { id: 'code-write', text: 'Write a Python function that takes a list of student names and test scores and returns the three highest scorers, handling ties sensibly. Include comments explaining your choices.' },
  { id: 'essay-outline', text: 'Help me outline a five-paragraph essay arguing that schools should teach students how AI models actually work, not just how to use them.' },
  { id: 'essay-feedback', text: 'Give me feedback on this thesis: "Social media is bad for teenagers because it makes them sad and wastes their time." Be specific about what would make it stronger.' },
  { id: 'explain-concept', text: 'Explain what a neural network is to someone who understands basic algebra but has never programmed.' },
  { id: 'compare', text: 'Compare running an AI model on my own laptop versus using a cloud API. What are the real tradeoffs?' },
  { id: 'reasoning-puzzle', text: 'Three people check into a hotel room costing $30 and each pays $10. The manager realises the room is only $25 and sends $5 back with the bellhop, who keeps $2 and returns $1 to each guest. So each paid $9, totalling $27, plus the bellhop\'s $2 is $29. Where is the missing dollar?' },
  { id: 'science-deep', text: 'Why is the speed of light the same for every observer regardless of how fast they are moving? Explain the reasoning, not just the fact.' },
  { id: 'history-analysis', text: 'What were the main causes of the 2008 financial crisis, and which of them do you think mattered most? Defend your ranking.' },
  { id: 'long-task', text: 'I am building a small app that tracks how much time I spend on homework per subject. Walk me through how you would design it: data model, the screens I need, and what I should build first. Assume I know basic Python but have never built an app.' },
];

const QUICK_PROMPTS = ['quick-fact', 'homework-math', 'essay-outline', 'long-task'];
const EFFORTS = ['low', 'medium', 'max'];
const MAX_TOKENS = 4000; // enough to finish these tasks without capping them early

const args = process.argv.slice(2);
const CONFIRMED = args.includes('--confirm');
const QUICK = args.includes('--quick');
const prompts = QUICK ? PROMPTS.filter((p) => QUICK_PROMPTS.includes(p.id)) : PROMPTS;

// ── Cost estimate, so nobody is surprised ────────────────────────────────────
// Rough per-call output guesses from what steps 3-7 actually produced.
const ASSUMED_OUTPUT = { low: 700, medium: 1100, max: 1800 };
function estimateUSD() {
  let total = 0;
  for (const id of models.ALLOWED) {
    const rate = models.get(id).pricePerMTok;
    for (const effort of EFFORTS) {
      total += prompts.length * ((150 * rate.input + ASSUMED_OUTPUT[effort] * rate.output) / 1e6);
    }
  }
  return total;
}

const runs = prompts.length * models.ALLOWED.length * EFFORTS.length;
console.log(`\nCalibration sweep`);
console.log(`  ${prompts.length} prompts x ${models.ALLOWED.length} models x ${EFFORTS.length} effort levels = ${runs} calls`);
console.log(`  estimated cost: ~$${estimateUSD().toFixed(2)} (a rough guess; the point of this is that we don't know yet)\n`);

if (!CONFIRMED) {
  console.log('Not running. Re-run with --confirm to spend real money:\n');
  console.log('    npm run calibrate -- --confirm');
  console.log('    npm run calibrate -- --confirm --quick   (fewer prompts, cheaper)\n');
  process.exit(0);
}

// ── One measured call ────────────────────────────────────────────────────────
async function measure(model, effort, prompt) {
  const spec = models.get(model);
  const request = {
    model,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt.text }],
    output_config: { effort },
  };
  if (spec.thinkingParam) request.thinking = spec.thinkingParam;

  const startedAt = Date.now();
  let firstTokenAt = null;
  let firstTextAt = null;

  const stream = anthropic.messages.stream(request);
  for await (const event of stream) {
    if (event.type !== 'content_block_delta') continue;
    if (firstTokenAt === null) firstTokenAt = Date.now();
    if (event.delta.type === 'text_delta' && firstTextAt === null) firstTextAt = Date.now();
  }
  const message = await stream.finalMessage();
  const finishedAt = Date.now();

  const cost = pricing.costOf(model, message.usage);
  return {
    model,
    effort,
    prompt: prompt.id,
    stopReason: message.stop_reason,
    truncated: message.stop_reason === 'max_tokens',
    inputTokens: cost.tokens.input,
    outputTokens: cost.tokens.output,
    thinkingTokens: cost.tokens.thinking,
    totalUSD: cost.totalUSD,
    totalMicroUSD: cost.totalMicroUSD,
    // Time to *anything* on screen vs time to the actual answer starting. The
    // gap between them is how long a student stares at a thinking indicator.
    msToFirstToken: firstTokenAt ? firstTokenAt - startedAt : null,
    msToFirstText: firstTextAt ? firstTextAt - startedAt : null,
    msTotal: finishedAt - startedAt,
  };
}

// ── Summarising ──────────────────────────────────────────────────────────────
const median = (xs) => {
  const s = [...xs].filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

function summarise(results) {
  const groups = [];
  for (const model of models.ALLOWED) {
    for (const effort of EFFORTS) {
      const rows = results.filter((r) => r.model === model && r.effort === effort);
      if (!rows.length) continue;
      groups.push({
        model,
        effort,
        n: rows.length,
        medianMicroUSD: median(rows.map((r) => r.totalMicroUSD)),
        maxMicroUSD: Math.max(...rows.map((r) => r.totalMicroUSD)),
        medianOutput: median(rows.map((r) => r.outputTokens)),
        medianThinking: median(rows.map((r) => r.thinkingTokens)),
        medianMsToFirstToken: median(rows.map((r) => r.msToFirstToken)),
        medianMsToFirstText: median(rows.map((r) => r.msToFirstText)),
        medianMsTotal: median(rows.map((r) => r.msTotal)),
        maxMsTotal: Math.max(...rows.map((r) => r.msTotal)),
      });
    }
  }
  return groups;
}

function printTable(groups) {
  console.log('\n## Measured results (medians)\n');
  console.log('| model | effort | n | cost | output tok | thinking tok | to 1st token | to 1st text | total |');
  console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const g of groups) {
    console.log(
      `| ${g.model} | ${g.effort} | ${g.n} | $${(g.medianMicroUSD / 1e6).toFixed(4)} | ${g.medianOutput} | ` +
        `${g.medianThinking ?? '—'} | ${(g.medianMsToFirstToken / 1000).toFixed(1)}s | ` +
        `${g.medianMsToFirstText ? (g.medianMsToFirstText / 1000).toFixed(1) + 's' : '—'} | ` +
        `${(g.medianMsTotal / 1000).toFixed(1)}s |`
    );
  }
}

// The two targets from the plan: a typical Opus 5 medium message should cost
// ~5 app tokens, a max-effort Fable 5 message ~30. They imply different rates;
// the honest thing is to show both and the gap between them.
function recommendRate(groups) {
  const opusMedium = groups.find((g) => g.model === 'claude-opus-5' && g.effort === 'medium');
  const fableMax = groups.find((g) => g.model === 'claude-fable-5' && g.effort === 'max');
  if (!opusMedium || !fableMax) return null;

  const fromOpus = Math.round(opusMedium.medianMicroUSD / 5);
  const fromFable = Math.round(fableMax.medianMicroUSD / 30);

  console.log('\n## Deriving the exchange rate\n');
  console.log(`  Opus 5 @ medium   median $${(opusMedium.medianMicroUSD / 1e6).toFixed(4)}  → 5 tokens implies ${fromOpus} microUSD/token`);
  console.log(`  Fable 5 @ max     median $${(fableMax.medianMicroUSD / 1e6).toFixed(4)}  → 30 tokens implies ${fromFable} microUSD/token`);

  // Geometric mean lands between them without letting either target dominate.
  const recommended = Math.round(Math.sqrt(fromOpus * fromFable));
  const rounded = Number(recommended.toPrecision(2)); // a memorable number

  console.log(`\n  recommended: ${rounded} microUSD per app token ($${(rounded / 1e6).toFixed(6)})\n`);
  console.log('  At that rate:');
  for (const g of groups) {
    console.log(
      `    ${g.model.padEnd(16)} @ ${g.effort.padEnd(6)} → ${Math.ceil(g.medianMicroUSD / rounded)} tokens typical, ` +
        `${Math.ceil(g.maxMicroUSD / rounded)} worst case`
    );
  }
  console.log(`\n  A student arriving with 60-80 tokens could send roughly ` +
    `${Math.floor(70 / Math.ceil(groups.find((g) => g.model === 'claude-opus-5' && g.effort === 'medium').medianMicroUSD / rounded))} ` +
    `medium Opus 5 messages, or ${Math.floor(70 / Math.ceil(fableMax.medianMicroUSD / rounded))} max-effort Fable 5 messages.\n`);

  return { fromOpus, fromFable, recommended: rounded };
}

// ── Run ──────────────────────────────────────────────────────────────────────
(async () => {
  const results = [];
  let done = 0;
  let spentMicroUSD = 0;

  for (const model of models.ALLOWED) {
    for (const effort of EFFORTS) {
      for (const prompt of prompts) {
        done++;
        process.stdout.write(`[${String(done).padStart(3)}/${runs}] ${model} ${effort.padEnd(6)} ${prompt.id.padEnd(18)} `);
        try {
          const r = await measure(model, effort, prompt);
          results.push(r);
          spentMicroUSD += r.totalMicroUSD;
          console.log(
            `$${r.totalUSD.toFixed(4)}  ${r.outputTokens} out  ${(r.msTotal / 1000).toFixed(1)}s` +
              (r.truncated ? '  ⚠ truncated' : '')
          );
        } catch (err) {
          console.log(`FAILED — ${err.message}`);
          results.push({ model, effort, prompt: prompt.id, error: err.message });
        }
      }
    }
  }

  const ok = results.filter((r) => !r.error);
  const groups = summarise(ok);
  printTable(groups);
  const rate = recommendRate(groups);

  console.log(`\n  total spent on this sweep: $${(spentMicroUSD / 1e6).toFixed(4)} across ${ok.length} calls\n`);

  const outFile = path.join(__dirname, '..', 'calibration-results.json');
  fs.writeFileSync(
    outFile,
    JSON.stringify({ ranAt: new Date().toISOString(), maxTokens: MAX_TOKENS, results, groups, rate, spentMicroUSD }, null, 2)
  );
  console.log(`  raw results written to ${outFile}\n`);
})().catch((err) => {
  console.error(`\n✕ ${err.message}\n`);
  process.exit(1);
});
