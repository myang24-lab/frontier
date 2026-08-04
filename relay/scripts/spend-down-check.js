// Verification for step 7. Gives a student 3 tokens and keeps sending messages
// until the relay refuses, then checks the ledger tells the same story.
//
// ⚠ This makes REAL API calls and spends REAL money — a few cents.
//
// The relay must be running with ALLOW_DEBUG_CREDIT=1.
// Run: npm run check:spend
const { Ledger } = require('../ledger');

const RELAY = process.env.RELAY_URL || 'http://localhost:8787';
const STUDENT = `spend-check-${Date.now()}`;
const STARTING_TOKENS = 3;
const MAX_ATTEMPTS = 8; // safety net so a bug can't loop forever spending money

async function credit(tokens) {
  const res = await fetch(`${RELAY}/debug/credit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentId: STUDENT, tokens }),
  });
  if (!res.ok) throw new Error(`credit failed (${res.status}) — is the relay running with ALLOW_DEBUG_CREDIT=1?`);
  return res.json();
}

// Returns { refused } or { done } — parses the SSE stream just enough to find
// the terminal event.
async function sendMessage(n) {
  const res = await fetch(`${RELAY}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      studentId: STUDENT,
      model: 'claude-opus-5',
      effort: 'low',
      prompt: `Reply with exactly one short sentence about the number ${n}.`,
    }),
  });

  if (res.status === 402) return { refused: true, body: await res.json() };
  if (!res.ok) throw new Error(`unexpected status ${res.status}: ${await res.text()}`);

  const text = await res.text();
  let done = null;
  let error = null;
  for (const block of text.split('\n\n')) {
    const evt = /^event: (\w+)$/m.exec(block);
    const data = /^data: (.*)$/m.exec(block);
    if (!evt || !data) continue;
    if (evt[1] === 'done') done = JSON.parse(data[1]);
    if (evt[1] === 'error') error = JSON.parse(data[1]);
  }
  if (error) throw new Error(`stream error: ${error.code} — ${error.message}`);
  if (!done) throw new Error('stream ended without a done event');
  return { done };
}

(async () => {
  console.log(`student: ${STUDENT}`);
  await credit(STARTING_TOKENS);
  console.log(`credited ${STARTING_TOKENS} tokens\n`);

  let sent = 0;
  let refusal = null;

  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const result = await sendMessage(n);
    if (result.refused) {
      refusal = result.body;
      console.log(`message ${n}: REFUSED — ${refusal.error.code}`);
      console.log(`             "${refusal.error.message}"`);
      break;
    }
    sent++;
    const d = result.done;
    console.log(
      `message ${n}: ok — held ${d.held}, charged ${d.charged}, refunded ${d.refunded}, ` +
        `balance ${d.balance}  (${d.usage.input_tokens} in / ${d.usage.output_tokens} out, $${d.cost.totalUSD.toFixed(5)})`
    );
  }

  // Now check the ledger agrees with what the API reported.
  const ledger = new Ledger();
  const finalBalance = ledger.getBalance(STUDENT);
  const log = ledger.history(STUDENT, 100);
  const settles = log.filter((e) => e.kind === 'settle');
  const totalCharged = settles.reduce((sum, e) => sum + e.app_tokens, 0);
  const totalMicroUSD = settles.reduce((sum, e) => sum + (e.cost_micro_usd || 0), 0);
  ledger.close();

  console.log(`\n  messages sent      ${sent}`);
  console.log(`  final balance      ${finalBalance}`);
  console.log(`  settlements logged ${settles.length}`);
  console.log(`  tokens charged     ${totalCharged}  (started with ${STARTING_TOKENS})`);
  console.log(`  real cost          $${(totalMicroUSD / 1e6).toFixed(5)}`);

  const failures = [];
  if (!refusal) failures.push(`never hit INSUFFICIENT_BALANCE within ${MAX_ATTEMPTS} messages`);
  if (refusal && refusal.error.code !== 'INSUFFICIENT_BALANCE') failures.push(`refused with ${refusal.error.code}`);
  if (finalBalance < 0) failures.push('BALANCE WENT NEGATIVE');
  if (settles.length !== sent) failures.push(`${settles.length} settlements for ${sent} messages — every message must settle`);
  if (totalCharged + finalBalance !== STARTING_TOKENS) {
    failures.push(`charged ${totalCharged} + remaining ${finalBalance} != ${STARTING_TOKENS} — tokens went missing`);
  }
  if (log.some((e) => e.balance_after < 0)) failures.push('log shows a negative balance');

  if (failures.length) {
    console.error(`\n✕ FAILED\n  - ${failures.join('\n  - ')}\n`);
    process.exit(1);
  }
  console.log('\n✓ PASSED — spent down to a clean refusal, and the ledger balances exactly.\n');
})().catch((err) => {
  console.error(`\n✕ ${err.message}\n`);
  process.exit(1);
});
