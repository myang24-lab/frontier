# Frontier tier

Everything for **Coding Spaces** — the tier that lets a student spend earned
tokens to talk to a Claude frontier model in a data centre, instead of the small
model running on their laptop.

Kept separate from the original app on purpose. The local tier has no dependency
on any of this: if the relay is off, unreachable, or deleted, the Ollama chat,
the terminal and the sub-agent all behave exactly as they always have.

## What's in here

| | |
|---|---|
| `relay/` | The service that holds the Anthropic API key and the token ledger. Complete and tested — 37 unit tests plus four integration checks. |
| `DESIGN_BRIEF.md` | Measured facts: real cost and latency per model and effort level, every failure state with its copy, and the full API contract. |
| `DESIGN_PROMPT.md` | The brief given to Claude Design to produce the screen. |
| `design-handoff/` | What came back — a working HTML prototype of all ten states, plus its rationale. |
| `BACKEND_STEPS.md` | How the relay was built, step by step. Useful as a record of why things are the way they are. |

## Running it

```
cd frontier/relay
npm install
cp .env.example .env      # paste your Anthropic API key
ALLOW_DEBUG_CREDIT=1 npm start
```

Listens on `:8787`. The local bridge on `:3001` forwards `/frontier/*` to it, so
the browser never sees the key.

```
npm test                     # 37 unit tests, no network, no cost
npm run check:concurrency    # proves a balance can't go negative, no cost
npm run check:spend          # spends down to a refusal — a few cents
npm run check:conversation   # memory + caching — a few cents
npm run check:cancel         # stop mid-generation — a few cents
npm run calibrate            # re-derive the exchange rate — a few dollars
```

## Two files that live outside this folder

The tier isn't fully separable, because the screen has to exist inside the app:

- **`../Local AI OS.dc.html`** — the Coding Spaces panel, sidebar grouping,
  effort dial and live pricing. Search for `Coding Spaces` or the `.cs` CSS
  block.
- **`../server/server.js`** — one added route that forwards `/frontier/*` to
  the relay. Nothing else in that file changed.

## Status

The backend is finished and verified. The frontend is partly built: the panel,
the sidebar, the effort dial and live pricing all work against the real relay.
**Sending is not wired up yet** — pressing send shows a placeholder.

Still to do: the streaming conversation, the unlock introduction, verifying
student identity (the relay currently trusts whatever id it's given — fine
locally, not fine once hosted), connecting the local track's quest rewards to
the ledger, and hosting the relay somewhere students can reach.
