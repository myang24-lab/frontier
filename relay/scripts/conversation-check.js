// Verification for step 10: does the model remember, and does caching engage?
//
// ⚠ Makes REAL API calls — a few cents.
// Relay must be running with ALLOW_DEBUG_CREDIT=1.
// Run: npm run check:conversation
const RELAY = process.env.RELAY_URL || 'http://localhost:8787';
const STUDENT = `convo-check-${Date.now()}`;
const MODEL = 'claude-opus-5';

// Caching needs a prefix of at least 512 tokens before it engages at all —
// below that the API silently declines to cache and you'd wrongly conclude the
// feature is broken. This opener is deliberately long enough to clear that bar.
const OPENER = `I'm learning about how AI models work and I want to keep a running conversation with you about it.

Here is what I understand so far, and I'd like you to correct me where I'm wrong.

A language model is trained on a very large amount of text. During training it repeatedly tries to predict the next piece of text given everything before it, and each time it gets that wrong the model's internal numbers get nudged. Over many repetitions the model gets good at this prediction task. The claim I keep reading is that being good at predicting text requires learning something about the world the text describes, because you can't reliably predict how a sentence about physics ends without something like an understanding of physics.

When I actually use a model, it doesn't remember me between conversations. Each time I send a message, the entire conversation so far gets sent along with it, and the model reads all of it fresh before answering. So the "memory" inside a single conversation is really just the transcript being resent.

I also understand that models are charged by the token, that a token is roughly three quarters of a word, and that I pay for both what I send and what comes back.

Please tell me which parts of that are right, which are wrong, and which are oversimplified in a way that will mislead me later. My name is Marcus, and I'm going to refer back to this conversation, so please remember it.`;

async function turn(messages, label) {
  const started = Date.now();
  const res = await fetch(`${RELAY}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentId: STUDENT, model: MODEL, effort: 'low', messages }),
  });
  if (res.status === 402) throw new Error(`out of tokens: ${JSON.stringify(await res.json())}`);
  if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);

  const raw = await res.text();
  let start = null;
  let done = null;
  let text = '';
  for (const block of raw.split('\n\n')) {
    const evt = /^event: (\w+)$/m.exec(block);
    const data = /^data: (.*)$/m.exec(block);
    if (!evt || !data) continue;
    const payload = JSON.parse(data[1]);
    if (evt[1] === 'start') start = payload;
    if (evt[1] === 'text') text += payload.text;
    if (evt[1] === 'done') done = payload;
    if (evt[1] === 'error') throw new Error(`${payload.code}: ${payload.message}`);
  }
  if (!done) throw new Error('no done event');

  const u = done.usage;
  console.log(
    `${label}\n` +
      `    sent ${start.messageCount} message(s), ${start.estimatedInputTokens} input tokens, caching ${start.cached ? 'on' : 'off'}\n` +
      `    billed: ${u.input_tokens} fresh in, ${u.cache_creation_input_tokens || 0} cache write, ` +
      `${u.cache_read_input_tokens || 0} cache read, ${u.output_tokens} out\n` +
      `    cost $${done.cost.totalUSD.toFixed(5)} · charged ${done.charged} tokens · balance ${done.balance} · ${((Date.now() - started) / 1000).toFixed(1)}s` +
      (start.warnings.length ? `\n    warnings: ${start.warnings.map((w) => w.code).join(', ')}` : '')
  );
  return { text, done, start };
}

(async () => {
  await fetch(`${RELAY}/debug/credit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentId: STUDENT, tokens: 60 }),
  });
  console.log(`student ${STUDENT} credited 60 tokens\n`);

  const messages = [{ role: 'user', content: OPENER }];

  // Free preview of what the message will cost, before spending anything.
  const est = await (
    await fetch(`${RELAY}/estimate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ studentId: STUDENT, model: MODEL, effort: 'low', messages }),
    })
  ).json();
  console.log(`estimate before sending: up to ${est.maxTokenCost} tokens (${est.estimatedInputTokens} input tokens)\n`);

  const t1 = await turn(messages, 'turn 1 — opener');
  messages.push({ role: 'assistant', content: t1.text });

  // The memory test: this only works if the history was actually resent.
  messages.push({ role: 'user', content: 'What is my name, and what did I say I wanted you to correct?' });
  const t2 = await turn(messages, '\nturn 2 — memory check');
  messages.push({ role: 'assistant', content: t2.text });
  console.log(`    reply: "${t2.text.slice(0, 140).replace(/\n/g, ' ')}..."`);

  messages.push({ role: 'user', content: 'Now give me one concrete exercise I could do to test my understanding.' });
  const t3 = await turn(messages, '\nturn 3 — cache should be reading now');

  // ── Checks ────────────────────────────────────────────────────────────────
  const remembered = /marcus/i.test(t2.text);
  const cacheWrote = (t2.done.usage.cache_creation_input_tokens || 0) > 0;
  const cacheRead = (t3.done.usage.cache_read_input_tokens || 0) > 0;

  console.log('\n  memory works       ' + (remembered ? 'yes — recalled the name from turn 1' : 'NO'));
  console.log('  cache written      ' + (cacheWrote ? 'yes, on turn 2' : 'no'));
  console.log('  cache read         ' + (cacheRead ? `yes — ${t3.done.usage.cache_read_input_tokens} tokens at ~10% price` : 'no'));

  const failures = [];
  if (!remembered) failures.push('the model did not recall the name — history is not reaching it');
  if (!cacheRead && !cacheWrote) {
    failures.push('caching never engaged — check the prefix cleared the 512-token minimum');
  }

  if (failures.length) {
    console.error(`\n✕ FAILED\n  - ${failures.join('\n  - ')}\n`);
    process.exit(1);
  }
  console.log('\n✓ PASSED — the conversation has memory, and history is being cached rather than re-billed.\n');
})().catch((err) => {
  console.error(`\n✕ ${err.message}\n`);
  process.exit(1);
});
