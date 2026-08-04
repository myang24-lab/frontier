# Local AI OS — Handover

Interactive prototype of a local-first "AI operating system" for students: pick a model → pull it in a **real terminal** → chat with it → unlock sub-agents through quests and a marketplace. Everything runs on the user's own machine. **No cloud, no accounts, no API keys, no cost.**

## Run it

Prereqs: **Ollama** running, **Node 18+**, **Python 3**.

```
./run.sh
```
Then open **http://localhost:3001** — not the .html file directly (file:// breaks CORS to Ollama).

`run.sh` installs deps, fixes a node-pty permission quirk, warns if Ollama is down, and starts the bridge.

Models used (the setup screen pulls both and won't advance until Ollama reports them installed):
- `qwen2.5:0.5b` — chat
- `qwen2.5:1.5b` — sub-agent

## The 5-minute demo path

1. Pick **Qwen 2.5 · 0.5B** → Continue.
2. Setup screen shows both pull commands. **Grant terminal access** → a real shell appears. Paste/run `ollama pull …` for any model not yet green.
3. **Open your AI OS** → chat. Replies stream live from local Ollama.
4. Send 5 prompts → unlocks **Marketplace**.
5. Find **swarmkit** → Download → scroll the README → Finish install.
6. Pass the 3-question quiz → **Sub-agents** toggle appears in the chat bar.
7. Toggle it on, set the thinking slider, and ask *"summarize https://example.com"* → the real sub-agent loop runs and fetches the page.

## What's real vs. what isn't

**Real (actual inference / actual system access):**
- **Terminal** — genuine pty via node-pty over WebSocket. Deliberately scoped: only `ollama pull|list|ps|show|rm` execute; anything else is blocked.
- **Chat** — streams from Ollama's OpenAI-compatible `/v1/chat/completions`.
- **Sub-agent** — `server/agent.py`, a real LLM-in-a-loop with one real tool (fetch a URL or local file). The thinking slider = max loop iterations.
- **Model detection** — polls Ollama `/api/tags`; the green "installed ✓" state is ground truth.

**UI state only (by design — progression, not technical claims):** quests, token economy, the marketplace catalogue, the quiz.

**Hard rule kept throughout: no mock fallbacks in the inference path.** If Ollama is down or a model is missing, the UI says so with the exact fix. Nothing fakes a response.

## Files

| File | Role |
|---|---|
| `Local AI OS.dc.html` | The entire app — all screens, styles, and logic. Config (endpoints, models) is at the top of the `<script>` block. |
| `support.js` | Rendering runtime the HTML depends on. Don't edit. |
| `server/server.js` | Bridge on **:3001** — serves the app, vendors front-end libs from `node_modules`, runs the scoped pty, exposes `POST /agent`. |
| `server/agent.py` | The sub-agent (~85 lines, no framework). Lenient tool-call parsing because small models mangle the syntax. |
| `run.sh` | One-command start. |

## Gotchas

- **Orphaned files:** `server/assistant.py` and `server/memory.json` are **not wired into anything** — they came from outside this build. Ignore or delete.
- The app is served over HTTP specifically so Ollama's default localhost CORS policy works. No `OLLAMA_ORIGINS` needed.
- Front-end libs (React, xterm) are vendored via npm and served locally, so it works offline. `file://` falls back to CDN.
- Sub-agent tool parsing is prose-based (`TOOL fetch <url>`); small models mangle it, hence the lenient regex + retry. **Moving to Ollama's native tool-calling is the obvious next improvement.**

## Where to build next

The honest gap: the sub-agent has exactly **one** tool (fetch). Adding a second — e.g. write to a sandboxed file — makes the "it does real work" story much stronger. Beyond that: persist quest/token state across reloads, and replace prose tool-parsing with structured output.
