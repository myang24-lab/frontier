# Coding Spaces — Design Brief

Everything the frontier-model screen can show, what it actually feels like to use,
and the exact words each failure should say. Written for someone designing the
screen who has never seen the code.

The backend is built and verified. **Every number below is measured, not
estimated** — from 72 real API calls plus a set of live integration runs.

---

## 1. What this screen is

Local AI OS teaches students how AI works by having them run a small model
(`qwen2.5:0.5b`) entirely on their own laptop — no cloud, no account, no cost.
They progress through quests, unlock a marketplace, and earn a currency called
**tokens**.

**Coding Spaces is the final unlock.** It lets a student spend those earned
tokens to talk to a frontier model — Claude Opus 5 or Claude Fable 5 — running
in a data centre rather than on their machine.

Three things it has to teach, in order of importance:

1. **The capability tradeoff.** When is a task genuinely too big for the local
   model, and when are you just reaching for the expensive option out of habit?
2. **Real cost.** Tokens stop being a game score here. They buy actual inference
   that actually costs money.
3. **Effort as a dial.** More thinking means better answers on hard problems,
   and costs more, and takes longer. Students should feel all three.

**The design tension to hold:** the cost information has to be present enough to
teach, without making students anxious about experimenting. A student who is
afraid to press send has learned the wrong lesson.

**The screen has a front door.** Immediately after unlocking, and before reaching
the conversation itself, the student sees a one-time introduction explaining what
a frontier model is, what the tradeoff is, and what their tokens now buy. That
moment carries most of the teaching — it's the only point where full attention is
guaranteed — and everything described below reinforces it rather than establishes
it. Nothing on the conversation screen has to explain the concept from scratch.

---

## 2. The numbers that should shape the design

### Waiting is the dominant experience

This is the single most important fact on the page. **At high effort, a student
waits half a minute before seeing a single word of the answer.**

| Model | Effort | First *anything* on screen | First word of the **answer** | Complete |
|---|---|---:|---:|---:|
| Opus 5 | low | 4.1s | 4.3s | 22.1s |
| Opus 5 | medium | 4.7s | **9.3s** | 32.6s |
| Opus 5 | high | 4.5s | **14.3s** | 43.3s |
| Opus 5 | xhigh | 4.6s | **18.5s** | 44.4s |
| Opus 5 | max | 5.0s | **25.2s** | 46.8s |
| Fable 5 | low | 3.9s | 3.9s | 16.6s |
| Fable 5 | medium | 5.8s | 6.1s | 17.3s |
| Fable 5 | high | 5.9s | 6.2s | 19.3s |
| Fable 5 | xhigh | 6.2s | 6.7s | 21.3s |
| Fable 5 | max | 6.4s | **37.5s** | 55.9s |

*Medians across 12 varied student prompts per cell, 120 calls in total.
Individual messages ran longer.*

The gap between column 3 and column 4 is **the model thinking**. The backend
streams that reasoning live as a summary, so the screen is never actually blank
— but for 25–37 seconds at max effort, **what the student sees is reasoning, not
answer.** That has to be designed, not patched over with a spinner.

Concretely: a design that shows reasoning in a small collapsed strip will leave
students staring at a near-empty screen for 30 seconds. The reasoning probably
needs to be the main event while it's happening, then yield to the answer.

### What things cost

At the calibrated rate of one token = $0.0083:

| Model | Effort | Typical cost | Real money |
|---|---|---:|---:|
| Opus 5 | low | **4 tokens** | $0.033 |
| Opus 5 | medium | **7 tokens** | $0.051 |
| Opus 5 | high | **9 tokens** | $0.070 |
| Opus 5 | xhigh | **9 tokens** | $0.070 |
| Opus 5 | max | **10 tokens** | $0.077 |
| Fable 5 | low | **6 tokens** | $0.048 |
| Fable 5 | medium | **6 tokens** | $0.050 |
| Fable 5 | high | **7 tokens** | $0.056 |
| Fable 5 | xhigh | **8 tokens** | $0.065 |
| Fable 5 | max | **25 tokens** | $0.200 |

**On Opus 5, `high` and `xhigh` cost the same** — $0.0703 against $0.0701, close
enough to be the same number — **but xhigh takes 4 seconds longer to say
anything** (18.5s vs 14.3s). Paying nothing extra to wait longer is a bad trade,
so `high` is the better default there. The dial will show two bars of equal
height at those stops; that's the truth, not a rendering fault.

A student arrives at this screen with roughly **60–80 tokens** earned on the
local track. So: about **ten** medium Opus 5 messages, or **two** max-effort
Fable 5 messages.

**Three things in that table are worth designing around:**

- **Fable 5 barely distinguishes low from medium** — 6 tokens either way, 16.6s
  vs 17.3s. Then max is 4× the cost. On this model the dial is nearly a
  two-position switch, not a smooth slider. A five-stop control implies a
  gradation that doesn't exist here.
- **Cost is driven by how much the model writes, not by the price on the label.**
  In one test Opus 5 cost *four times* what Fable 5 did on the same prompt,
  despite being half the price per token — because it wrote eight times more.
- **The top tier should feel like a decision.** 25 tokens of a 70-token balance
  in one message. That's the intended weight.

### Conversations get *cheaper* after the first message

Counterintuitive, and a genuinely good lesson. Measured on a real three-turn
conversation:

| Turn | Sent | Charged | Why |
|---|---|---:|---|
| 1 | 403 tokens of prompt | **8 tokens** | Long answer, nothing cached yet |
| 2 | 2,186 tokens of history | **3 tokens** | Short answer; history stored in cache |
| 3 | 2,577 tokens of history | **3 tokens** | 2,184 tokens read from cache at ~10% |

The whole conversation is re-sent to the model on every single turn — it has no
memory otherwise. Caching means that re-sent history bills at about a tenth of
the normal price. Without it, turn 3 would have cost roughly three times more.

If there's room for one piece of "how this actually works" education on the
screen, this is the most surprising and useful one.

---

## 3. Every field you can put on screen

### Before sending — from `POST /estimate` (free, no charge, instant)

Use this to price a message **before** the student commits. This is what makes
the effort dial teachable: drag it, watch the number move, spend nothing.

| Field | Example | What it means |
|---|---|---|
| `balanceTokens` | `52` | Tokens the student has right now |
| `estimatedInputTokens` | `2186` | Size of the conversation being sent |
| `messageCount` | `3` | Messages in the conversation so far |
| `affordable` | `true` | Whether this can be sent at all |
| `maxTokenCost` | `13` | **Ceiling**, not a prediction — see warning below |
| `maxOutputTokens` | `4000` | Longest reply possible with this balance |
| `neededTokens` | `9` | Only when `affordable: false` |
| `warnings` | `[]` | See §5 |

> ⚠️ **`maxTokenCost` is a worst case and typically overstates by about 4×.** In
> testing, a message showing 13 was charged 3. Never label it "cost" — use
> "up to", or show a range. A student told 13 who is then charged 3 stops
> believing every number on the screen.

### While streaming — from `POST /message`

Events arrive in this order. See §6 for the wire format.

| Event | Carries | Design use |
|---|---|---|
| `start` | the plan: held tokens, max output, warnings | Show what's reserved before text appears |
| `thinking` | summarised reasoning, word by word | **The main content for the first 4–37 seconds** |
| `text` | the answer, word by word | The reply |
| `done` | usage, cost, charged, refunded, balance | The receipt |
| `cancelled` | what was charged despite stopping | After a student presses stop |
| `error` | code + message | See §4 |

### After it finishes — from the `done` event

| Field | Example | Notes |
|---|---|---|
| `charged` | `3` | **What the student actually paid.** The number that matters. |
| `refunded` | `10` | Returned from the hold — usually most of it |
| `held` | `13` | What was reserved up front |
| `balance` | `49` | New balance |
| `cost.totalUSD` | `0.02286` | Real money. Sub-cent — needs 4–5 decimal places. |
| `usage.input_tokens` | `2` | *Fresh* input only |
| `usage.cache_read_input_tokens` | `2184` | Read from cache at ~10% price |
| `usage.cache_creation_input_tokens` | `391` | Written to cache this turn |
| `usage.output_tokens` | `832` | Everything the model produced, thinking included |
| `reasoning.thinkingTokens` | `551` | Reasoning the student never saw |
| `reasoning.visibleTokens` | `914` | The answer itself |
| `reasoning.thinkingShare` | `0.38` | Fraction spent on thinking |
| `reasoning.estimated` | `true` | **Almost always true** — see below |
| `stop_reason` | `"end_turn"` | `"max_tokens"` means the reply was cut off |
| `truncated` | `false` | Reply hit the length ceiling |
| `refused` | `false` | Safety classifier declined — see §4 |

> **On `reasoning`:** the API doesn't return an exact thinking/answer split on
> streamed responses, so the backend estimates it from how much of each type of
> text came down the wire. It's close, but it's an estimate and `estimated: true`
> says so. Word it as "about 40% of this went on thinking", never "exactly 551
> tokens". This is the best number available for teaching where the money goes —
> at max effort a message spent **46× more** on thinking than at low, while the
> visible answer grew only 28%.

### Anywhere — from `GET /balance/:studentId`

| Field | Example |
|---|---|
| `tokens` | `52` |
| `microUSDPerToken` | `8300` (one token = $0.0083) |

---

## 4. Failure states, with copy

The project has a hard rule inherited from the local tier: **no silent failures
and no fake responses.** Every failure says what happened and what to do. The
copy below is written to be shown to a student as-is.

### Out of tokens — the important one

Arrives as HTTP **402** *before* any streaming starts, so the UI can switch
cleanly rather than abandoning a half-rendered reply.

> **You're out of tokens for this one.**
> This message needs about **9** and you have **4**. Earn more by using your
> local model and finishing quests — or send it to Qwen 2.5 running on your
> laptop right now, free.
>
> `[Send to local model instead]`  `[See how to earn tokens]`

**This must never be a dead end.** Falling back to the local model is a deliberate
product decision: the student keeps working, and the contrast between the two
tiers is exactly the lesson. Label the fallback reply unmistakably so nobody
thinks they got the frontier model.

### The model declined to answer

`done` arrives with `refused: true` and empty text. **The student is not charged.**

> **This one came back declined.**
> The model's safety checks stopped this request. You weren't charged. Rephrasing
> usually helps — or try the local model, which has different limits.

### Student pressed stop

> **Stopped.**
> You were charged **1 token** for what had already been generated. The other
> **12** went back.

> ⚠️ **Design note.** Stopping halts generation but **is not free** — tokens
> already produced were really billed. The button should say so before it's
> pressed, e.g. *"Stop (you'll be charged for what's written so far)"*.
> Verified behaviour: stops within ~1 second, charged 1 of 13 held tokens.

### Reply was cut off

`truncated: true`.

> **This answer hit the length limit.**
> You paid for what's here. Ask a narrower question, or ask it to continue.

### Relay unreachable

No HTTP response at all.

> **Can't reach the frontier models.**
> Your local model is still working normally — nothing on your machine is
> affected. Try again in a moment.

### Rate limited

> **Too many requests right now.**
> Wait about a minute and try again. Nothing was charged.

### Everything is busy / server error

> **Something went wrong on our side.**
> You weren't charged. Try again, or use your local model in the meantime.

### Developer-facing errors (never show these raw)

These indicate a bug or misconfiguration, not a student mistake. Log them; show
the generic message above.

| Code | Meaning |
|---|---|
| `missing_student` | No student id sent |
| `model_not_allowed` | Model isn't on the server allowlist |
| `invalid_effort` | Effort wasn't one of the five levels |
| `invalid_message` | Conversation malformed (roles must alternate, starting with user) |
| `conversation_too_long` | Over 200 messages |
| `bad_api_key` / `key_not_permitted` | Relay misconfigured |
| `api_unreachable` | Relay can't reach the Claude API |

---

## 5. Warnings

Advisory, non-blocking. They appear in `warnings` on both `/estimate` and the
`start` event. Designed to inform, not to stop anyone.

| Code | Fires when | Copy |
|---|---|---|
| `expensive_message` | Could use ≥50% of the balance | *"This message could use up to 25 of your 40 tokens — usually much less."* |
| `long_conversation` | Over 20,000 tokens of history | *"This conversation gets re-sent every turn, so each message costs a little more than the last. Starting a new one resets that."* |
| `many_turns` | 40+ messages | *"40 messages deep. A fresh conversation will be cheaper and often sharper."* |

The threshold was raised from 25% to 50% after testing, because at 25% it fired
on completely ordinary messages. **A warning that appears every time is
wallpaper.** If the design makes these prominent, they must stay rare.

---

## 6. API contracts

Base URL is the relay. The browser reaches it through the local bridge on
`:3001`; the API key never leaves the relay.

### `GET /balance/:studentId`

```json
{ "studentId": "student-123", "tokens": 52, "microUSDPerToken": 8300 }
```

### `POST /estimate`

Free and instant. Call it whenever the model, effort, or draft message changes.

```json
{
  "studentId": "student-123",
  "model": "claude-opus-5",
  "effort": "medium",
  "messages": [{ "role": "user", "content": "Explain recursion." }]
}
```

```json
{
  "studentId": "student-123", "model": "claude-opus-5", "effort": "medium",
  "balanceTokens": 52, "estimatedInputTokens": 403, "messageCount": 1,
  "affordable": true, "maxTokenCost": 13, "maxOutputTokens": 4000,
  "neededTokens": null, "warnings": []
}
```

### `POST /message`

Same body as `/estimate`. Responds with Server-Sent Events.

`messages` must alternate `user` / `assistant`, start with `user`, and end with
`user`. **The full conversation is re-sent every turn** — the model has no memory
otherwise. History lives in the browser; the relay stores nothing.

`model`: `"claude-opus-5"` | `"claude-fable-5"`
`effort`: `"low"` | `"medium"` | `"high"` | `"xhigh"` | `"max"` *(default `high`)*

```
event: start
data: {"model":"claude-opus-5","effort":"medium","estimatedInputTokens":2186,
       "heldTokens":13,"balanceAfterHold":39,"maxOutputTokens":4000,
       "messageCount":3,"cached":true,"warnings":[]}

event: thinking
data: {"text":"The student is asking about..."}

event: text
data: {"text":"Recursion is when a function"}

event: done
data: {"model":"claude-opus-5","stop_reason":"end_turn","refused":false,
       "truncated":false,
       "usage":{"input_tokens":2,"cache_creation_input_tokens":391,
                "cache_read_input_tokens":2184,"output_tokens":832},
       "cost":{"totalUSD":0.02435},
       "reasoning":{"thinkingTokens":316,"visibleTokens":516,
                    "thinkingShare":0.38,"estimated":true},
       "charged":3,"refunded":10,"held":13,"balance":49}
```

**402 — out of tokens** (before any streaming):

```json
{
  "error": { "code": "INSUFFICIENT_BALANCE",
             "message": "Not enough tokens for this message on claude-opus-5..." },
  "balanceTokens": 4, "neededTokens": 9, "estimatedInputTokens": 403
}
```

**Stop:** close the connection. Generation halts within ~1s and a `cancelled`
event settles the charge.

---

## 7. What the backend does *not* provide

Be aware of these — designing around them costs nothing, discovering them late costs a rebuild.

- **No conversation storage.** History lives in the browser. A closed tab loses
  it unless the frontend persists it locally. Deliberate: student conversations
  never touch the server.
- **No exact thinking/answer split.** Estimated, and flagged as such.
- **No teacher view.** No dashboard, no per-class reporting, no way to see
  another student's spend.
- **No "explain what this cost" endpoint.** Any breakdown must be built from the
  `usage` and `cost` fields.
- **No streaming of the final answer's markdown structure.** Text arrives as
  plain deltas; if replies should render headings, code blocks, and lists — and
  they should, these replies are long — the frontend renders that itself.

---

## 8. Questions the design should answer

1. **What fills 25–37 seconds at max effort?** The reasoning stream exists and is
   live. Is it the main content, a side panel, a collapsible strip? Everything
   else on this page is downstream of that decision.
2. **How does the price appear on the effort dial?** It should move as the dial
   moves — that interaction is the lesson.
3. **How do local and frontier tiers stay visually distinct?** A student must
   never be unsure which one answered.
4. **How prominent is the running cost?** Present enough to teach, quiet enough
   that experimenting still feels safe.
5. **What does a student see at zero balance** — and how does the local fallback
   read as "here's the other tier" rather than "you're locked out"?
6. **Does the frontier conversation live in the existing sidebar** alongside
   local chats, or somewhere separate?

---

## Appendix — where these numbers came from

- **Costs and latency**: `npm run calibrate` — 12 representative student prompts
  × 2 models × 3 effort levels = 72 real calls, $4.91.
- **Conversation economics**: `npm run check:conversation` — a real three-turn
  conversation with caching.
- **Stop behaviour**: `npm run check:cancel` — max-effort message aborted at 8
  seconds.
- **Exchange rate**: derived in `frontier/relay/ledger.js`, with the full derivation in
  the comment there.

Re-run any of these to reproduce or update the figures.
