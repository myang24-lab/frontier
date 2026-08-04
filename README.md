# Local AI OS — real local prototype

Everything runs on your own machine. No cloud, no GPU rental, no hosting.

## Prereqs
- [Ollama](https://ollama.com) (free) — just have it running (the menu-bar app, or `ollama serve`)
- Node 18+ and Python 3

## Run
```
./run.sh          # installs deps + starts the app on :3001
```
Then open **http://localhost:3001** in your browser.

That's it. The app is served by the local bridge, so React/xterm are loaded from
vendored copies (works offline) and Ollama's default localhost CORS policy applies —
no `OLLAMA_ORIGINS` needed.

## What's real (everything — there are no mocked responses)
- **Setup terminal** — xterm.js in the browser ↔ node-pty over WebSocket (`server/server.js`). The shell is scoped: only `ollama pull/list/ps/show/rm` commands execute. The screen shows both pull commands and marks each model "installed ✓" by polling Ollama's `/api/tags` — you can't enter the OS until both models are really on disk.
- **Chat** — streams from Ollama's OpenAI-compatible `/v1/chat/completions` with `qwen2.5:0.5b`. The sidebar dot is a live status: green = model ready, amber = model missing, red = Ollama down.
- **Sub-agent** — `server/agent.py` (~80 lines, no framework): `qwen2.5:1.5b` in a tool loop with one real tool (fetch a URL or local file). The thinking slider = max loop count. Try: *"summarize https://example.com"* with Sub-agents on.
- **Failures are loud** — if Ollama is down or a model is missing, the chat shows a "⚠ couldn't reach the model" notice with the exact fix, and failed runs earn no quest progress or tokens.
- **Quests / tokens / marketplace** — local UI state by design; progression UI, not technical claims.

Config (endpoints, models) lives at the top of the logic in `Local AI OS.dc.html`.
