// Frontier relay. Holds the Claude API key and (from step 6) the token ledger.
// The student's local bridge on :3001 forwards here; the key never reaches a
// student machine. Nothing in server/ depends on this — if the relay is down,
// the local Ollama tier keeps working exactly as before.
//
// Run: npm start   (from relay/)
const http = require('http');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const models = require('./models');
const pricing = require('./pricing');
const { Ledger } = require('./ledger');
const metering = require('./metering');

config.require(); // exits with an actionable message if the key is missing

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
const ledger = new Ledger();

// Topping up a balance by HTTP is a development convenience. Left open on a
// hosted relay it would be an endpoint that mints free inference for anyone who
// finds it, so it stays off unless explicitly switched on.
const ALLOW_DEBUG_CREDIT = process.env.ALLOW_DEBUG_CREDIT === '1';

// A safety classifier can decline a request outright. Rerouting server-side
// recovers the message instead of leaving the student staring at a refusal.
// Set DISABLE_FALLBACK=1 if this beta ever stops being accepted.
const SERVER_SIDE_FALLBACK =
  process.env.DISABLE_FALLBACK === '1'
    ? null
    : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

// Small on purpose — this endpoint exists to prove the key works, not to do real
// work. Note max_tokens caps thinking *and* response text together, and thinking
// is on for both models, so too small a value returns nothing but truncated
// reasoning. 4096 leaves room for both.
const DEBUG_MAX_TOKENS = 4096;

// Ceiling for a real streamed message. Deliberately server-side: if the client
// could name this, a student could ask for 128k of Fable 5 output in one go.
// This is a hard cap on runaway length, not a budget — step 7's balance check
// is what actually stops overspending.
//
// Pinned to 4000 to match the step-8 calibration run. Every fable-5/max sample
// in that sweep hit this ceiling, so the measured cost is the worst case only
// while the two numbers agree. Raising this without re-running `npm run
// calibrate` would let a single message cost roughly double what the exchange
// rate was derived against.
const STREAM_MAX_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || 4000;

const startedAt = Date.now();

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// One error envelope for the whole relay. Step 7 leans on `code` to tell the
// frontend apart: an empty balance should fall back to the local model, a dead
// relay should say so plainly.
function fail(res, status, code, message) {
  json(res, status, { error: { code, message } });
}

// Bounded so a malformed or hostile request can't buffer unlimited memory.
const MAX_BODY_BYTES = 256 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large.'), { code: 'body_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(Object.assign(new Error('Body is not valid JSON.'), { code: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

// Turn an SDK error into something that says what to do about it. Most specific
// first — a 401 and a 429 need completely different responses from the caller.
function describeApiError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return [401, 'bad_api_key', 'The Claude API rejected the key. Check ANTHROPIC_API_KEY in relay/.env, and that the key has not been revoked.'];
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return [403, 'key_not_permitted', 'The key is valid but not permitted to use this model. Check the workspace has access, and that billing is active.'];
  }
  if (err instanceof Anthropic.NotFoundError) {
    return [404, 'model_not_found', `The API does not recognise that model id. Allowed here: ${models.ALLOWED.join(', ')}.`];
  }
  if (err instanceof Anthropic.RateLimitError) {
    return [429, 'rate_limited', 'Rate limited by the Claude API. Wait and retry — this is not a code problem.'];
  }
  if (err instanceof Anthropic.BadRequestError) {
    // The likeliest cause here is a zero-data-retention org calling fable-5,
    // which 400s on every request no matter how correct the payload.
    return [400, 'bad_request', `The API rejected the request: ${err.message} — if this is claude-fable-5, check the org is not set to zero data retention (it requires 30-day retention).`];
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return [502, 'api_unreachable', 'Could not reach the Claude API. Check this machine has network access.'];
  }
  return [500, 'api_error', err && err.message ? err.message : 'Unknown error calling the Claude API.'];
}

// A conversation is resent in full on every turn — the API has no memory
// between calls. This is the ceiling on that; past it, cost per message climbs
// and the student should start a fresh conversation.
const MAX_MESSAGES = 200;

// Accepts either a conversation (`messages`) or a single `prompt`, and returns
// the conversation form. The prompt form is what the debug endpoint and the
// calibration script use.
function normaliseMessages(body) {
  if (Array.isArray(body.messages)) {
    const { messages } = body;
    if (!messages.length) return { error: ['empty_conversation', 'Send at least one message.'] };
    if (messages.length > MAX_MESSAGES) {
      return { error: ['conversation_too_long', `A conversation is capped at ${MAX_MESSAGES} messages. Start a new one.`] };
    }
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
        return { error: ['invalid_message', `messages[${i}].role must be "user" or "assistant".`] };
      }
      if (typeof m.content !== 'string' || !m.content.trim()) {
        return { error: ['invalid_message', `messages[${i}].content must be a non-empty string.`] };
      }
      // The API rejects these itself, but catching them here means a clear
      // message instead of a 400 from somewhere deeper.
      const expected = i % 2 === 0 ? 'user' : 'assistant';
      if (m.role !== expected) {
        return { error: ['invalid_message', `messages must alternate starting with "user"; messages[${i}] is "${m.role}", expected "${expected}".`] };
      }
    }
    if (messages[messages.length - 1].role !== 'user') {
      return { error: ['invalid_message', 'The last message must be from "user" — that is the one being answered.'] };
    }
    return { messages };
  }

  if (typeof body.prompt === 'string' && body.prompt.trim()) {
    return { messages: [{ role: 'user', content: body.prompt }] };
  }
  return { error: ['missing_prompt', 'Send either a "messages" array or a non-empty "prompt" string.'] };
}

// Shared by all endpoints so validation can't drift between them.
// Returns { error: [code, message] } or { messages, model, effort }.
function validateMessageBody(body) {
  const { model, effort } = body;

  const normalised = normaliseMessages(body);
  if (normalised.error) return normalised;
  // Allowlist check happens before any call, so an unknown model never costs
  // anything and never runs at a price we haven't recorded.
  if (typeof model !== 'string' || !models.isAllowed(model)) {
    return { error: ['model_not_allowed', `"${model}" is not an allowed model. Allowed: ${models.ALLOWED.join(', ')}.`] };
  }
  // Effort is optional. Reject a bad value rather than silently falling back —
  // a typo'd "hight" that quietly ran at the default would make the cost numbers
  // in step 8 wrong and take a long time to notice.
  if (effort !== undefined && !models.isValidEffort(effort)) {
    return { error: ['invalid_effort', `"${effort}" is not a valid effort level. Allowed: ${models.EFFORT_LEVELS.join(', ')}.`] };
  }
  return { messages: normalised.messages, model, effort };
}

// One place that assembles a Claude request, so the model-specific rules in
// models.js apply identically to every path.
function buildRequest({ messages, model, effort, maxTokens }) {
  const spec = models.get(model);
  const request = { model, max_tokens: maxTokens, messages };
  if (spec.thinkingParam) request.thinking = spec.thinkingParam;
  // effort lives inside output_config, not at the top level.
  if (effort !== undefined) request.output_config = { effort };

  // Prompt caching. Every turn resends the whole conversation, so without this
  // a ten-message chat pays full price to reprocess the first nine turns each
  // time. Cached history bills at ~10%, which is close to a 10x saving on the
  // long conversations students actually have.
  //
  // Only from the second turn onward: a cache write costs a 25% premium, and on
  // a one-shot message there is no later turn to earn it back.
  if (messages.length > 1) request.cache_control = { type: 'ephemeral' };

  return request;
}

async function handleDebugMessage(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return fail(res, 400, e.code || 'invalid_body', e.message);
  }

  const valid = validateMessageBody(body);
  if (valid.error) return fail(res, 400, valid.error[0], valid.error[1]);
  const { messages: conversation, model, effort } = valid;

  try {
    const message = await anthropic.messages.create(
      buildRequest({ messages: conversation, model, effort, maxTokens: DEBUG_MAX_TOKENS })
    );

    // Check stop_reason before reading content. A safety refusal arrives as a
    // successful 200 with an empty content array; indexing content[0] blindly
    // is the classic way to break on it.
    if (message.stop_reason === 'refusal') {
      return json(res, 200, {
        model: message.model,
        effort: effort || models.DEFAULT_EFFORT,
        refused: true,
        text: '',
        stop_reason: message.stop_reason,
        stop_details: message.stop_details || null,
        usage: message.usage,
      });
    }

    const text = (message.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    json(res, 200, {
      model: message.model,
      // Echoed so recorded results are unambiguous about which level produced
      // them — including when the caller sent nothing and got the API default.
      effort: effort || models.DEFAULT_EFFORT,
      effortExplicit: effort !== undefined,
      text,
      stop_reason: message.stop_reason,
      truncated: message.stop_reason === 'max_tokens',
      usage: message.usage,
      cost: pricing.costOf(model, message.usage),
    });
  } catch (err) {
    const [status, code, message] = describeApiError(err);
    fail(res, status, code, message);
  }
}

// ── POST /estimate — what would this message cost? ──────────────────────────
//
// Token counting is free, so the UI can show a price before the student commits
// rather than after. This is what makes the effort dial teachable: drag it and
// watch the number move, without spending anything to find out.
async function handleEstimate(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return fail(res, 400, e.code || 'invalid_body', e.message);
  }

  const valid = validateMessageBody(body);
  if (valid.error) return fail(res, 400, valid.error[0], valid.error[1]);
  const { messages: conversation, model, effort } = valid;

  const studentId = body.studentId;
  if (typeof studentId !== 'string' || !studentId.trim()) {
    return fail(res, 400, 'missing_student', 'Send a "studentId".');
  }

  let estimatedInputTokens;
  try {
    const counted = await anthropic.messages.countTokens({ model, messages: conversation });
    estimatedInputTokens = counted.input_tokens;
  } catch (err) {
    const [status, code, message] = describeApiError(err);
    return fail(res, status, code, message);
  }

  const balanceTokens = ledger.getBalance(studentId);
  const plan = metering.planSpend({
    modelId: model,
    balanceTokens,
    estimatedInputTokens,
    hardCapTokens: STREAM_MAX_TOKENS,
  });

  json(res, 200, {
    studentId,
    model,
    effort: effort || models.DEFAULT_EFFORT,
    balanceTokens,
    estimatedInputTokens,
    messageCount: conversation.length,
    affordable: plan.ok,
    // The ceiling, not a prediction: what this message costs if the model uses
    // every token available to it. Nearly always less in practice, which is why
    // the `done` event reports the refund.
    maxTokenCost: plan.ok ? plan.holdTokens : null,
    maxOutputTokens: plan.ok ? plan.maxTokens : null,
    neededTokens: plan.ok ? null : plan.neededTokens,
    warnings: metering.warningsFor({ plan, balanceTokens, estimatedInputTokens, messageCount: conversation.length }),
  });
}

// ── POST /message — the real path. Server-Sent Events. ──────────────────────
//
// Streaming isn't a nicety here. These models think for a long time before the
// first visible token, and a non-streaming request at a large max_tokens risks
// an HTTP timeout with nothing to show for the tokens already paid for.
async function handleStreamMessage(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return fail(res, 400, e.code || 'invalid_body', e.message);
  }

  const valid = validateMessageBody(body);
  if (valid.error) return fail(res, 400, valid.error[0], valid.error[1]);
  const { messages: conversation, model, effort } = valid;

  const studentId = body.studentId;
  if (typeof studentId !== 'string' || !studentId.trim()) {
    return fail(res, 400, 'missing_student', 'Send a "studentId" — the relay has to know whose balance to charge.');
  }

  // ── HOLD ──────────────────────────────────────────────────────────────────
  // All of this happens before a single byte is streamed, so an unaffordable
  // message gets a clean HTTP status the frontend can branch on, rather than an
  // error buried inside a stream it has already started rendering.
  let estimatedInputTokens;
  try {
    // Counts the whole conversation, not just the newest message — the history
    // is resent every turn and is billed every turn.
    const counted = await anthropic.messages.countTokens({ model, messages: conversation });
    estimatedInputTokens = counted.input_tokens;
  } catch (err) {
    const [status, code, message] = describeApiError(err);
    return fail(res, status, code, message);
  }

  const balanceTokens = ledger.getBalance(studentId);
  const plan = metering.planSpend({
    modelId: model,
    balanceTokens,
    estimatedInputTokens,
    hardCapTokens: STREAM_MAX_TOKENS,
  });

  if (!plan.ok) {
    // 402 Payment Required. Not an error in the code — an ordinary thing that
    // happens to students, and the frontend's cue to fall back to the local
    // model with a clear label.
    return json(res, 402, {
      error: {
        code: 'INSUFFICIENT_BALANCE',
        message: `Not enough tokens for this message on ${model}. Balance is ${balanceTokens}; this needs about ${plan.neededTokens}.`,
      },
      studentId,
      balanceTokens,
      neededTokens: plan.neededTokens,
      estimatedInputTokens,
      model,
      effort: effort || models.DEFAULT_EFFORT,
    });
  }

  const held = ledger.debit(studentId, plan.holdTokens, {
    model,
    effort: effort || models.DEFAULT_EFFORT,
    inputTokens: estimatedInputTokens,
    note: 'hold',
  });
  if (!held.ok) {
    // Lost a race with a concurrent message. The guarantee held; this one just
    // arrived second.
    return json(res, 402, {
      error: {
        code: 'INSUFFICIENT_BALANCE',
        message: `Balance changed while this message was being prepared. Balance is now ${held.balance}.`,
      },
      studentId,
      balanceTokens: held.balance,
      neededTokens: plan.holdTokens,
    });
  }

  // ── STREAM ────────────────────────────────────────────────────────────────
  // Past this point the status code is committed, so failures arrive as an
  // `error` event rather than an HTTP status. The hold is now outstanding and
  // MUST be settled on every exit path below, or a student loses tokens to a
  // message they never received.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // stops proxies buffering the stream into one lump
  });

  // `destroyed` matters as much as `writableEnded`: when a student closes the
  // tab the socket is gone but the response object hasn't been ended, and
  // writing to it produces noise instead of an error anyone can act on.
  const send = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      /* client vanished mid-write; settlement still happens below */
    }
  };
  res.on('error', () => { /* client vanished; nothing to do but not crash */ });

  send('start', {
    model,
    effort: effort || models.DEFAULT_EFFORT,
    estimatedInputTokens,
    heldTokens: plan.holdTokens,
    balanceAfterHold: held.balance,
    maxOutputTokens: plan.maxTokens,
    messageCount: conversation.length,
    cached: conversation.length > 1,
    warnings: metering.warningsFor({
      plan,
      balanceTokens,
      estimatedInputTokens,
      messageCount: conversation.length,
    }),
  });

  let stream;
  let settled = false;
  let outputChars = 0;
  // Tracked separately so the student can be shown how much of what they paid
  // for was reasoning rather than answer.
  let thinkingChars = 0;
  let textChars = 0;
  let clientCancelled = false;

  const settle = (actualMicroUSD, note) => {
    if (settled) return null;
    settled = true;
    return ledger.settle(studentId, plan.holdTokens, actualMicroUSD, {
      model,
      effort: effort || models.DEFAULT_EFFORT,
      inputTokens: estimatedInputTokens,
      note,
    });
  };

  // Stopping is a real affordance, not an edge case: at max effort a student
  // waits 25-37 seconds before the first word, and some will change their mind.
  //
  // Stopping halts generation but does NOT make the message free — tokens
  // already produced were genuinely billed to us, so they are genuinely
  // charged. The unused remainder of the hold comes back. The UI has to say
  // this plainly, or "stop" reads as "cancel, no charge".
  //
  // Listen on both req and res: which one fires on a dropped connection varies
  // with how the client disconnects, and missing it means the model keeps
  // generating — billing the student for output nobody will ever see.
  let clientGone = false;
  const onClientGone = () => {
    if (clientGone || settled) return;
    clientGone = true;
    clientCancelled = true;
    console.log(`[cancel] ${studentId} disconnected after ${outputChars} chars — aborting generation`);
    if (stream) {
      try { stream.abort(); } catch (e) { /* already finished */ }
    }
  };
  req.on('close', onClientGone);
  res.on('close', onClientGone);
  req.on('aborted', onClientGone);

  try {
    const request = buildRequest({ messages: conversation, model, effort, maxTokens: plan.maxTokens });
    // Server-side fallback: a safety classifier can decline a request, and
    // rerouting it server-side recovers the message instead of dead-ending the
    // student. "default" lets Anthropic pick the substitute by refusal
    // category, so there's no model list here to go stale.
    stream = SERVER_SIDE_FALLBACK
      ? anthropic.beta.messages.stream({ ...request, ...SERVER_SIDE_FALLBACK })
      : anthropic.messages.stream(request);

    // The client can vanish during the countTokens/hold work above, before
    // `stream` exists for onClientGone to abort. Catch that here.
    if (clientGone) {
      try { stream.abort(); } catch (e) { /* nothing started yet */ }
    }

    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue;
      const delta = event.delta;
      if (delta.type === 'text_delta') {
        outputChars += delta.text.length;
        textChars += delta.text.length;
        send('text', { text: delta.text });
      } else if (delta.type === 'thinking_delta') {
        // Summarized reasoning — gives the UI something to show during the
        // long pause before the answer starts.
        outputChars += delta.thinking.length;
        thinkingChars += delta.thinking.length;
        send('thinking', { text: delta.thinking });
      }
    }

    const message = await stream.finalMessage();

    // ── SETTLE ──────────────────────────────────────────────────────────────
    // A safety refusal arrives as a *successful* response with empty content and
    // near-zero usage, so this path handles it correctly without a special case:
    // the real cost is tiny, and nearly the whole hold is refunded.
    const cost = pricing.costOf(model, message.usage);
    const outcome = settle(cost.totalMicroUSD, message.stop_reason === 'refusal' ? 'refused by safety classifier' : null);

    send('done', {
      model: message.model,
      effort: effort || models.DEFAULT_EFFORT,
      stop_reason: message.stop_reason,
      refused: message.stop_reason === 'refusal',
      stop_details: message.stop_details || null,
      truncated: message.stop_reason === 'max_tokens',
      usage: message.usage,
      cost,
      // How much of the output was reasoning the student never saw. Estimated
      // from streamed characters when the API omits the exact breakdown, which
      // on a streamed response is always.
      reasoning: pricing.splitOutput(message.usage, { thinkingChars, textChars }),
      // What the student actually paid, and what they have left.
      charged: outcome.charged,
      refunded: outcome.refunded,
      held: outcome.held,
      balance: outcome.balance,
    });
  } catch (err) {
    // The stream died partway. Tokens were generated and billed, so the honest
    // thing is to charge for them — but usage never arrived, so estimate from
    // what was streamed and label the log entry as an estimate.
    const spec = models.get(model);
    const estimatedOutputTokens = Math.ceil(outputChars / 4); // ~4 chars/token
    const estimatedMicroUSD =
      metering.microUSDFor(estimatedInputTokens, spec.pricePerMTok.input) +
      metering.microUSDFor(estimatedOutputTokens, spec.pricePerMTok.output);
    const outcome = settle(
      estimatedMicroUSD,
      clientCancelled ? 'stopped by student — cost estimated from streamed output' : 'stream failed — cost estimated from streamed output'
    );

    const [, code, message] = describeApiError(err);
    send(clientCancelled ? 'cancelled' : 'error', {
      code: clientCancelled ? 'cancelled_by_student' : code,
      message: clientCancelled
        ? 'Stopped. You were charged for what had already been generated; the rest was returned.'
        : message,
      charged: outcome ? outcome.charged : 0,
      refunded: outcome ? outcome.refunded : 0,
      balance: outcome ? outcome.balance : ledger.getBalance(studentId),
      reasoning: pricing.splitOutput(
        { output_tokens: Math.ceil(outputChars / 4) },
        { thinkingChars, textChars }
      ),
      estimated: true,
    });
  } finally {
    // Belt and braces: if any path above escaped without settling, refund the
    // entire hold rather than silently keeping a student's tokens.
    if (!settled) settle(0, 'unsettled hold refunded');
    if (!res.writableEnded) res.end();
  }
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    // Reports that a key is configured — never the key itself.
    return json(res, 200, {
      status: 'ok',
      service: 'local-ai-os-relay',
      keyConfigured: true,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      models: models.ALLOWED,
    });
  }

  // GET /balance/:studentId
  if (req.method === 'GET' && url.startsWith('/balance/')) {
    const studentId = decodeURIComponent(url.slice('/balance/'.length));
    if (!studentId) return fail(res, 400, 'missing_student', 'Include a student id: /balance/:studentId');
    return json(res, 200, {
      studentId,
      tokens: ledger.getBalance(studentId),
      microUSDPerToken: require('./ledger').MICRO_USD_PER_APP_TOKEN,
    });
  }

  // POST /debug/credit — development only, see ALLOW_DEBUG_CREDIT above.
  if (req.method === 'POST' && url === '/debug/credit') {
    if (!ALLOW_DEBUG_CREDIT) {
      return fail(res, 403, 'debug_credit_disabled', 'Crediting over HTTP is off. Start the relay with ALLOW_DEBUG_CREDIT=1 to enable it in development.');
    }
    return readJson(req)
      .then((body) => {
        const { studentId, tokens } = body;
        if (typeof studentId !== 'string' || !studentId.trim()) {
          return fail(res, 400, 'missing_student', 'Send a "studentId" string.');
        }
        if (!Number.isInteger(tokens) || tokens <= 0) {
          return fail(res, 400, 'invalid_amount', 'Send "tokens" as a positive whole number.');
        }
        const result = ledger.credit(studentId, tokens, { note: 'debug credit' });
        json(res, 200, { studentId, ...result });
      })
      .catch((e) => fail(res, 400, e.code || 'invalid_body', e.message));
  }

  if (req.method === 'POST' && url === '/estimate') {
    return handleEstimate(req, res).catch((err) => {
      fail(res, 500, 'relay_error', err.message || 'Unhandled relay error.');
    });
  }

  if (req.method === 'POST' && url === '/message') {
    return handleStreamMessage(req, res).catch((err) => {
      if (!res.headersSent) fail(res, 500, 'relay_error', err.message || 'Unhandled relay error.');
      else res.end();
    });
  }

  if (req.method === 'POST' && url === '/debug/message') {
    return handleDebugMessage(req, res).catch((err) => {
      fail(res, 500, 'relay_error', err && err.message ? err.message : 'Unhandled relay error.');
    });
  }

  fail(res, 404, 'not_found', `No route for ${req.method} ${url}`);
});

// Same rule as the rest of the project: say what broke and how to fix it,
// rather than dumping a stack trace.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`
✕ Port ${config.port} is already in use — most likely an earlier relay still running.

  Fix: stop it with Ctrl-C in its terminal, or:
      lsof -ti:${config.port} | xargs kill

  Or run this one on a different port:
      PORT=8788 npm start
`);
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error(`\n✕ Not allowed to listen on port ${config.port}. Ports below 1024 need elevated privileges — pick a higher one:\n\n      PORT=8787 npm start\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(config.port, () => {
  console.log(`relay listening → http://localhost:${config.port}  ·  health: /health`);
});
