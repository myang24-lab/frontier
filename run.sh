#!/usr/bin/env bash
# Local AI OS — one-command start. Requires: Ollama (https://ollama.com), Node 18+, Python 3.
set -e
cd "$(dirname "$0")/server"
[ -d node_modules ] || npm install
# Some npm setups strip the exec bit from node-pty's prebuilt spawn-helper.
find node_modules/node-pty/prebuilds -name spawn-helper -exec chmod +x {} + 2>/dev/null || true
if ! curl -s --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
  echo "⚠ Ollama isn't running — start it first (open the Ollama app, or run: ollama serve)"
fi
echo "→ starting on http://localhost:3001 — open that in your browser"
npm start
