#!/usr/bin/env python3
"""Minimal real sub-agent: local LLM in a loop with one real tool (fetch URL/file).
Usage: echo "task" | python3 agent.py <max_loops>   — streams progress to stdout."""
import sys, json, re, urllib.request

OLLAMA = "http://localhost:11434"
MODEL = "qwen2.5:1.5b"

def say(s):
    print(s, flush=True)

def llm(messages):
    req = urllib.request.Request(OLLAMA + "/api/chat",
        data=json.dumps({"model": MODEL, "messages": messages, "stream": False,
                         "options": {"temperature": 0.2}}).encode(),
        headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=180).read())["message"]["content"]

def fetch(target):
    try:
        if re.match(r"https?://", target):
            r = urllib.request.urlopen(urllib.request.Request(target, headers={"User-Agent": "sub-agent"}), timeout=15)
            text = r.read(150_000).decode("utf-8", "ignore")
            return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text))[:6000]
        with open(target, encoding="utf-8", errors="ignore") as f:
            return f.read(6000)
    except Exception as e:
        return f"[fetch failed: {e}]"

SYSTEM = ("You are a sub-agent with one tool. To read a URL or local file, reply with exactly: "
          "TOOL fetch <url-or-path>\n"
          "Example: TOOL fetch https://example.com\n"
          "When you have enough information, reply: FINAL <your answer>. Be concise.")

# Small models mangle the tool syntax ("TOO fetch", "tool FETCH: url") — parse leniently.
TOOL_RE = re.compile(r"TOOL?\s+fetch[:\s]+[<\"']?(\S+?)[>\"']?(?:\s|$)", re.I)

def preflight():
    """Fail with actionable messages instead of tracebacks."""
    try:
        tags = json.loads(urllib.request.urlopen(OLLAMA + "/api/tags", timeout=3).read())
    except Exception:
        say("⚠ Ollama isn't running. Start the Ollama app (or `ollama serve`) and try again.")
        sys.exit(1)
    if MODEL not in [m["name"] for m in tags.get("models", [])]:
        say(f"⚠ The sub-agent model isn't installed. Run `ollama pull {MODEL}` and try again.")
        sys.exit(1)

def main():
    iters = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    task = sys.stdin.read().strip()
    preflight()
    msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": task}]
    say(f"sub-agent started · {MODEL} · up to {iters} tool loop(s)\n")
    fetched = set()
    def final(text):
        say(re.sub(r"^\s*(FINAL|TOOL\s+fetch\s+\S+)\s*:?\s*", "", text.strip(), flags=re.I))
    for i in range(iters):
        out = llm(msgs).strip()
        m = TOOL_RE.search(out)
        if not m:
            if re.match(r"FINAL", out, re.I) or not re.search(r"\b(tool|fetch)\b", out, re.I):
                final(out); return
            # Mangled tool attempt with no usable target — correct and retry.
            say(f"→ loop {i+1}: malformed tool call, retrying")
            msgs += [{"role": "assistant", "content": out},
                     {"role": "user", "content": "That was not a valid tool call. Reply exactly: TOOL fetch <url-or-path>"}]
            continue
        target = m.group(1).strip("<>\"'")
        if target in fetched:
            msgs += [{"role": "assistant", "content": out},
                     {"role": "user", "content": "You already fetched that. Using the TOOL RESULT above, reply: FINAL <your answer>"}]
            continue
        fetched.add(target)
        say(f"→ loop {i+1}: fetching {target}")
        result = fetch(target)
        msgs += [{"role": "assistant", "content": out},
                 {"role": "user", "content": f"TOOL RESULT:\n{result}\n\nContinue. Reply FINAL <answer> when done."}]
    final(llm(msgs + [{"role": "user", "content": "Give your FINAL answer now. Do not call the tool again."}]))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        say(f"⚠ sub-agent error: {e}")
        sys.exit(1)
