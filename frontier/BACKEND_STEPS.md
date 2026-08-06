# Frontier Backend — Build Steps

Backend for the frontier-model tier (Coding Spaces) in Local AI OS. Nine small steps,
each self-contained. Paste the **Context block** plus one step into a fresh session.

Do them in order. Each ends in something you can verify yourself.

---

## Context block — paste this with every step

> I'm building a "frontier model" tier for Local AI OS, a local-first AI learning app for
> students (see `HANDOVER.md`). The existing app runs qwen2.5 locally via Ollama with no
> cloud, no keys, no cost. The new tier lets students spend an in-app currency to talk to
> Claude frontier models, brokered through a relay service I own so the API key never
> touches a student machine.
>
> Architecture:
> `browser → local bridge :3001 (no key) → relay (holds key + ledger) → Claude API`
>
> Decisions already made:
> - Two models: `claude-opus-5` (workhorse) and `claude-fable-5` (top tier, ~2x price).
> - Students earn tokens through the local track (quests, local model use) and spend them here.
> - At zero balance, the app falls back to the local model, clearly labeled. Never a hard block.
> - Accounts already exist elsewhere in my project. The relay trusts a verified student id.
> - Hard rule inherited from the project: **no mock fallbacks in the inference path.**
>   Failures state exactly what broke and how to fix it.
>
> Relay lives in a new `frontier/relay/` directory, separate from `server/`. Node, using the official
> `@anthropic-ai/sdk`. Do not modify `server/agent.py`, the pty terminal, or the Ollama path —
> the local tier must keep working with zero network dependency.

---

## Step 1 — Relay skeleton

Create `frontier/relay/` as a standalone Node service: `package.json`, an HTTP server on a
configurable port, `GET /health`, env-var config loading (`ANTHROPIC_API_KEY`, `PORT`),
and a `.env.example`. Install `@anthropic-ai/sdk`. No Claude calls yet.

**Verify:** `curl localhost:8787/health` returns ok. The service refuses to start with a
clear message if `ANTHROPIC_API_KEY` is missing.

---

## Step 2 — One real non-streaming call

Add `POST /debug/message` taking `{ prompt, model }` and returning the full text plus the
raw `usage` object. Hardcode a small `max_tokens`. This exists to prove the key works and
to show me the real shape of a response.

**Allowlist the model server-side.** Only `claude-opus-5` and `claude-fable-5` are
permitted; anything else is a clear 400, rejected before any call is made. The client
picks from this list — it never gets to name an arbitrary model, or it could spend against
the key on something unpriced. Keep the allowlist in one config constant shared with the
pricing module in Step 5, so a model can never be callable without a price attached.

Constraints that will 400 if ignored:
- `claude-fable-5`: **omit the `thinking` parameter entirely** — an explicit
  `{type:"disabled"}` is rejected. It also requires 30-day data retention; it fails on
  zero-retention orgs.
- `claude-opus-5`: thinking is on by default.
- **Neither** accepts `temperature`, `top_p`, or `top_k`.

**Verify:** a curl against both model ids returns text and a usage block with
`input_tokens` / `output_tokens`.

---

## Step 3 — Effort parameter

Add an `effort` field to `/debug/message`, passed as `output_config: { effort }`.
Accept `low | medium | high | xhigh | max`; reject anything else with a clear 400.

**Verify:** the same prompt at `low` and at `max` returns visibly different
`output_tokens` counts. Record a few numbers — they matter in Step 8.

---

## Step 4 — Streaming

Convert to `POST /message` with streaming, so the browser can render tokens as they
arrive. Stream text deltas to the client and emit a final event carrying the complete
`usage` object. Use streaming for anything with a large `max_tokens` — non-streaming
requests risk HTTP timeouts above ~16k.

Also opt into summarized reasoning (`thinking.display: "summarized"` on Opus 5) so the
frontend can show thinking progress instead of a long blank pause. Note the default is
omitted, which streams empty thinking blocks.

**Verify:** `curl -N` shows text arriving incrementally, ending with a usage payload.

---

## Step 5 — Pricing and cost calculation

Add a pricing module converting a `usage` object into a real dollar cost:
- `claude-opus-5` — $5 / $25 per million input / output tokens
- `claude-fable-5` — $10 / $50 per million

Account for `cache_read_input_tokens` separately (~0.1x input rate). Include the computed
cost in the stream's final event. Unit tests, no network.

**Verify:** tests pass; a real call reports a cost that matches hand-arithmetic on its usage.

---

## Step 6 — Ledger

SQLite in the relay. A balance per student id and an append-only spend log
(timestamp, student, model, effort, tokens in/out, cost, app-token cost).
Endpoints: `GET /balance/:studentId`, plus internal debit/credit. Debits must be atomic —
two concurrent messages must not both spend the last token.

Exchange rate lives in one config constant for now; Step 8 sets its real value.

**Verify:** a script that fires 10 concurrent debits against a balance of 5 leaves the
balance at 0 and never negative.

---

## Step 7 — Wire metering to the ledger

Two-phase, because cost isn't knowable before generating:
1. **Hold** — before the call, estimate input cost via `count_tokens`, check the balance,
   reserve. Insufficient balance returns a structured `INSUFFICIENT_BALANCE` (not a 500) so
   the frontend can trigger the local fallback.
2. **Settle** — when the stream ends, reconcile against the real `usage` and write the
   spend log.

Handle these failures distinctly and honestly — no silent fallbacks:
- `stop_reason: "refusal"` — the frontier models run safety classifiers and can decline
  with an **HTTP 200 and empty content**. Check `stop_reason` before reading `content[0]`
  or the code breaks. Opt into `fallbacks: "default"` with beta header
  `server-side-fallback-2026-07-01` so a decline reroutes server-side.
- Rate limited (429), relay unreachable, stream dropped mid-message (settle what was used).

**Verify:** a student with 3 tokens can send until the balance hits zero, then gets a clean
`INSUFFICIENT_BALANCE`. The spend log matches the real usage.

---

## Step 8 — Rate calibration

**This spends real money — a few dollars.** Write a script that runs ~20 representative
student prompts across both models at `low`, `medium`, and `max`, recording real cost and
wall-clock latency to first token and to completion.

Then set the exchange rate so a typical Opus 5 message at medium effort costs about
**5 app tokens** and a max-effort Fable 5 message costs about **30** — students arrive at
this tier with roughly 60–80 tokens earned from the local track, so those numbers give them
room to experiment while making the top tier feel genuinely expensive.

**Verify:** a results table, and the exchange rate constant updated with a comment
explaining how it was derived.

---

## Step 9 — Design brief

Produce a markdown brief for the frontend designer containing:
- Every field the frontend can display, with real example values from Step 8
- Real latency ranges per model and effort level (what a loading state must cover)
- Every failure state, with the exact copy each should show
- The full request/response contract for `/message` and `/balance`

This is the handoff document. The design gets made against these facts, then coded against
these same contracts.

**Verify:** someone who has never seen the codebase could design the screen from this alone.

---

## Also needed, small

A route on the existing local bridge (`server/server.js`) that forwards `/frontier` to the
relay and passes through the stream. The bridge never sees the API key. Fold this into
Step 4 or do it standalone after.
