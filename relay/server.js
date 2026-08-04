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

config.require(); // exits with an actionable message if the key is missing

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// Small on purpose — this endpoint exists to prove the key works, not to do real
// work. Note max_tokens caps thinking *and* response text together, and thinking
// is on for both models, so too small a value returns nothing but truncated
// reasoning. 4096 leaves room for both.
const DEBUG_MAX_TOKENS = 4096;

// Ceiling for a real streamed message. Deliberately server-side: if the client
// could name this, a student could ask for 128k of Fable 5 output in one go.
// This is a hard cap on runaway length, not a budget — step 7's balance check
// is what actually stops overspending.
const STREAM_MAX_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || 8000;

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

// Shared by both endpoints so validation can't drift between them.
// Returns { error: [code, message] } or { prompt, model, effort }.
function validateMessageBody(body) {
  const { prompt, model, effort } = body;

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { error: ['missing_prompt', 'Send a non-empty "prompt" string.'] };
  }
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
  return { prompt, model, effort };
}

// One place that assembles a Claude request, so the model-specific rules in
// models.js apply identically to the streaming and non-streaming paths.
function buildRequest({ prompt, model, effort, maxTokens }) {
  const spec = models.get(model);
  const request = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (spec.thinkingParam) request.thinking = spec.thinkingParam;
  // effort lives inside output_config, not at the top level.
  if (effort !== undefined) request.output_config = { effort };
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
  const { prompt, model, effort } = valid;

  try {
    const message = await anthropic.messages.create(
      buildRequest({ prompt, model, effort, maxTokens: DEBUG_MAX_TOKENS })
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
      usage: message.usage, // raw, unmassaged — step 5 prices this shape
    });
  } catch (err) {
    const [status, code, message] = describeApiError(err);
    fail(res, status, code, message);
  }
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
  const { prompt, model, effort } = valid;

  // Everything below this line is streamed, so the status code is already
  // committed — failures arrive as an `error` event, not an HTTP status.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // stops proxies buffering the stream into one lump
  });

  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('start', { model, effort: effort || models.DEFAULT_EFFORT });

  let stream;
  // If the student closes the tab, stop generating. Tokens already produced are
  // still billed, but there's no reason to keep paying for output nobody reads.
  req.on('close', () => {
    if (stream && !res.writableEnded) {
      try { stream.abort(); } catch (e) { /* already finished */ }
    }
  });

  try {
    stream = anthropic.messages.stream(
      buildRequest({ prompt, model, effort, maxTokens: STREAM_MAX_TOKENS })
    );

    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue;
      const delta = event.delta;
      if (delta.type === 'text_delta') {
        send('text', { text: delta.text });
      } else if (delta.type === 'thinking_delta') {
        // Summarized reasoning — gives the UI something to show during the
        // long pause before the answer starts.
        send('thinking', { text: delta.thinking });
      }
    }

    const message = await stream.finalMessage();

    // Check stop_reason before trusting content. A safety refusal arrives as a
    // successful response with empty content.
    send('done', {
      model: message.model,
      effort: effort || models.DEFAULT_EFFORT,
      stop_reason: message.stop_reason,
      refused: message.stop_reason === 'refusal',
      stop_details: message.stop_details || null,
      truncated: message.stop_reason === 'max_tokens',
      usage: message.usage, // step 5 prices this; step 7 settles against it
    });
  } catch (err) {
    const [, code, message] = describeApiError(err);
    send('error', { code, message });
  } finally {
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
