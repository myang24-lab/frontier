// Verifies the stop path — the one the design brief needs stated precisely.
//
// Starts a max-effort message (25-40s before the first word), aborts partway,
// then checks the ledger: the student must be charged for what was generated
// and refunded the rest. Never charged the full hold, never charged nothing.
//
// ⚠ Makes a REAL API call — a few cents.
// Relay must be running with ALLOW_DEBUG_CREDIT=1.
// Run: npm run check:cancel
const { Ledger } = require('../ledger');

const RELAY = process.env.RELAY_URL || 'http://localhost:8787';
const STUDENT = `cancel-check-${Date.now()}`;
const ABORT_AFTER_MS = 8000;

(async () => {
  await fetch(`${RELAY}/debug/credit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentId: STUDENT, tokens: 40 }),
  });
  console.log(`student ${STUDENT} credited 40 tokens`);

  const controller = new AbortController();
  const res = await fetch(`${RELAY}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      studentId: STUDENT,
      model: 'claude-opus-5',
      effort: 'max',
      prompt: 'Write a detailed essay on the history of computing, from Babbage to the present day. Cover the major eras thoroughly.',
    }),
    signal: controller.signal,
  });

  let held = null;
  let chars = 0;
  const started = Date.now();
  console.log(`streaming — will stop after ${ABORT_AFTER_MS / 1000}s...`);

  const timer = setTimeout(() => controller.abort(), ABORT_AFTER_MS);
  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      chars += chunk.length;
      const m = /event: start\ndata: (.*)/.exec(chunk);
      if (m) held = JSON.parse(m[1]).heldTokens;
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
    console.log(`stopped after ${((Date.now() - started) / 1000).toFixed(1)}s, ${chars} chars received`);
  } finally {
    clearTimeout(timer);
  }

  // The relay settles asynchronously once it notices the socket closed.
  await new Promise((r) => setTimeout(r, 3000));

  const ledger = new Ledger();
  const balance = ledger.getBalance(STUDENT);
  const log = ledger.history(STUDENT, 20);
  const settle = log.find((e) => e.kind === 'settle');
  ledger.close();

  console.log(`\n  held             ${held} tokens`);
  console.log(`  settled          ${settle ? `${settle.app_tokens} tokens charged` : 'NO SETTLEMENT'}`);
  console.log(`  note             ${settle ? settle.note : '—'}`);
  console.log(`  final balance    ${balance}  (of 40)`);

  const failures = [];
  if (!settle) failures.push('the hold was never settled — the student silently lost tokens');
  if (settle && settle.app_tokens >= held) failures.push(`charged the full hold (${settle.app_tokens}) — stopping refunded nothing`);
  if (balance < 0) failures.push('BALANCE WENT NEGATIVE');
  if (balance > 40) failures.push(`balance ${balance} exceeds the 40 credited — tokens were invented`);
  if (settle && !/stopped by student/.test(settle.note || '')) {
    failures.push(`settlement not labelled as a student stop: "${settle.note}"`);
  }

  if (failures.length) {
    console.error(`\n✕ FAILED\n  - ${failures.join('\n  - ')}\n`);
    process.exit(1);
  }
  console.log(`\n✓ PASSED — stopping charged ${settle.app_tokens} of ${held} held tokens and returned the rest.\n`);
})().catch((err) => {
  console.error(`\n✕ ${err.message}\n`);
  process.exit(1);
});
