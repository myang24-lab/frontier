#!/usr/bin/env python3
"""Offline general assistant: local LLM + real tools + persistent semantic memory.

100% offline once models are pulled. Zero external Python deps (stdlib only).
Talks to Ollama at localhost:11434.

Run:  python3 assistant.py            (interactive chat)
      echo "one question" | python3 assistant.py --once

Models used (all local): a chat model with tool-calling + nomic-embed-text for memory.
"""
import sys, os, json, math, subprocess, urllib.request

OLLAMA = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
MODEL = os.environ.get("ASSISTANT_MODEL", "qwen2.5:7b")   # general brain; qwen2.5-coder:7b also works
EMBED_MODEL = "nomic-embed-text"
MEM_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "memory.json")
WORKDIR = os.environ.get("ASSISTANT_WORKDIR", os.path.expanduser("~"))
MAX_TOOL_LOOPS = 8

C = {"you": "\033[36m", "ai": "\033[32m", "dim": "\033[2m", "warn": "\033[33m", "off": "\033[0m"}
def c(tag, s): return f"{C[tag]}{s}{C['off']}"
def say(s=""): print(s, flush=True)

# ── Ollama calls (stdlib http, no deps) ──────────────────────────────────────
def _post(path, payload, timeout=300):
    req = urllib.request.Request(OLLAMA + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())

def chat(messages, tools=None):
    body = {"model": MODEL, "messages": messages, "stream": False,
            "options": {"temperature": 0.3}}
    if tools:
        body["tools"] = tools
    return _post("/api/chat", body)["message"]

def embed(text):
    return _post("/api/embeddings", {"model": EMBED_MODEL, "prompt": text}, timeout=60)["embedding"]

# ── Persistent semantic memory ───────────────────────────────────────────────
def _load_mem():
    try:
        with open(MEM_PATH) as f:
            return json.load(f)
    except Exception:
        return []

def _save_mem(mem):
    with open(MEM_PATH, "w") as f:
        json.dump(mem, f)

def _cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)); nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0

def remember(text):
    mem = _load_mem()
    mem.append({"text": text, "vec": embed(text)})
    _save_mem(mem)
    return f"Saved to memory: {text}"

def recall(query, k=4, threshold=0.35):
    mem = _load_mem()
    if not mem:
        return []
    qv = embed(query)
    scored = sorted(((_cosine(qv, m["vec"]), m["text"]) for m in mem), reverse=True)
    return [t for s, t in scored[:k] if s >= threshold]

# ── Real tools the model can call ────────────────────────────────────────────
def _confirm(kind, detail):
    """Gate side-effecting actions. Auto-approves in --once mode is disabled: still asks."""
    say(c("warn", f"\n⚠ The assistant wants to {kind}:"))
    say(c("dim", detail))
    return input(c("warn", "  Allow? [y/N] ")).strip().lower() in ("y", "yes")

def tool_run_shell(command):
    if not _confirm("run a shell command", f"  $ {command}"):
        return "[denied by user]"
    try:
        r = subprocess.run(command, shell=True, cwd=WORKDIR, capture_output=True,
                           text=True, timeout=60)
        out = (r.stdout + r.stderr).strip()
        return out[:4000] or f"[exit {r.returncode}, no output]"
    except subprocess.TimeoutExpired:
        return "[command timed out after 60s]"
    except Exception as e:
        return f"[error: {e}]"

def tool_read_file(path):
    try:
        with open(os.path.expanduser(path), encoding="utf-8", errors="ignore") as f:
            return f.read(6000)
    except Exception as e:
        return f"[read failed: {e}]"

def tool_write_file(path, content):
    full = os.path.expanduser(path)
    if not _confirm("write a file", f"  {full}  ({len(content)} chars)"):
        return "[denied by user]"
    try:
        with open(full, "w", encoding="utf-8") as f:
            f.write(content)
        return f"[wrote {len(content)} chars to {full}]"
    except Exception as e:
        return f"[write failed: {e}]"

def tool_list_dir(path="."):
    try:
        p = os.path.expanduser(path)
        return "\n".join(sorted(os.listdir(p))[:200]) or "[empty]"
    except Exception as e:
        return f"[list failed: {e}]"

def tool_remember(text):
    return remember(text)

TOOLS = {
    "run_shell": tool_run_shell,
    "read_file": tool_read_file,
    "write_file": tool_write_file,
    "list_dir": tool_list_dir,
    "remember": tool_remember,
}

TOOL_SPECS = [
    {"type": "function", "function": {
        "name": "run_shell", "description": "Run a shell command on the user's Mac and get its output. Use for anything the OS can do.",
        "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}},
    {"type": "function", "function": {
        "name": "read_file", "description": "Read a text file's contents.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "write_file", "description": "Write text to a file (overwrites).",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
    {"type": "function", "function": {
        "name": "list_dir", "description": "List files in a directory.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "remember", "description": "Save an important fact about the user or task to long-term memory for future sessions.",
        "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}},
]

SYSTEM = (
    "You are a helpful offline assistant running locally on the user's MacBook. "
    "You have tools: run_shell, read_file, write_file, list_dir, remember. "
    "Use them to actually do things rather than guessing. Prefer reading real files over assuming. "
    "When the user shares a durable fact about themselves or their preferences, call remember. "
    "Be concise and direct."
)

# ── Agentic loop: model may call tools repeatedly before answering ────────────
def respond(history):
    # Inject relevant long-term memories for the latest user turn.
    last_user = next((m["content"] for m in reversed(history) if m["role"] == "user"), "")
    mems = recall(last_user)
    sys_msg = SYSTEM
    if mems:
        sys_msg += "\n\nRelevant memory about the user:\n- " + "\n- ".join(mems)
    messages = [{"role": "system", "content": sys_msg}] + history

    for _ in range(MAX_TOOL_LOOPS):
        msg = chat(messages, tools=TOOL_SPECS)
        calls = msg.get("tool_calls") or []
        if not calls:
            content = (msg.get("content") or "").strip()
            history.append({"role": "assistant", "content": content})
            return content
        messages.append(msg)
        for call in calls:
            fn = call["function"]["name"]
            args = call["function"].get("arguments") or {}
            if isinstance(args, str):
                try: args = json.loads(args)
                except Exception: args = {}
            say(c("dim", f"  · {fn}({', '.join(f'{k}={v!r}'[:60] for k, v in args.items())})"))
            result = TOOLS.get(fn, lambda **_: f"[unknown tool {fn}]")(**args)
            messages.append({"role": "tool", "content": str(result)})
    # Ran out of loops — force a plain answer.
    final = chat(messages + [{"role": "user", "content": "Give your final answer now without tools."}])
    content = (final.get("content") or "").strip()
    history.append({"role": "assistant", "content": content})
    return content

# ── Startup checks with actionable messages (not tracebacks) ─────────────────
def preflight():
    try:
        tags = _post_get("/api/tags")
    except Exception:
        say(c("warn", "⚠ Ollama isn't running. Start the Ollama app (or run `ollama serve`) and retry."))
        sys.exit(1)
    have = {m["name"] for m in tags.get("models", [])}
    have_bases = {n.split(":")[0] for n in have}
    for needed in (MODEL, EMBED_MODEL):
        if needed not in have and needed.split(":")[0] not in have_bases:
            say(c("warn", f"⚠ Missing model '{needed}'. Run `ollama pull {needed}` and retry."))
            sys.exit(1)

def _post_get(path):
    return json.loads(urllib.request.urlopen(OLLAMA + path, timeout=5).read())

# ── Entry points ─────────────────────────────────────────────────────────────
def once():
    task = sys.stdin.read().strip()
    preflight()
    say(respond([{"role": "user", "content": task}]))

def repl():
    preflight()
    n = len(_load_mem())
    say(c("ai", f"offline assistant · {MODEL} · {n} memories · workdir {WORKDIR}"))
    say(c("dim", "type your message, or /quit to exit, /forget to wipe memory\n"))
    history = []
    while True:
        try:
            user = input(c("you", "you › ")).strip()
        except (EOFError, KeyboardInterrupt):
            say(); break
        if not user:
            continue
        if user in ("/quit", "/exit", "/q"):
            break
        if user == "/forget":
            _save_mem([]); say(c("dim", "memory wiped.")); continue
        try:
            answer = respond(history)
        except Exception as e:
            say(c("warn", f"⚠ error: {e}")); continue
        say(c("ai", "ai  › ") + answer + "\n")
        history[:] = history[-20:]  # keep context bounded

if __name__ == "__main__":
    (once if "--once" in sys.argv else repl)()
