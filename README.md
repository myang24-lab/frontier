# Local AI OS

An AI operating system for students, built to teach how these models actually
work by making you run one yourself.

Pick a model → pull it in a real terminal → chat with it → unlock sub-agents
through quests and a marketplace. Then, at the very end, spend what you've
earned on a frontier model and find out what that costs.

## Two tiers, and the difference is the point

**The local tier** runs entirely on your own machine. No cloud, no account, no
API key, no cost — and that stays true no matter what else is in this repo. If
the network is down, everything below still works:

- **A real terminal.** xterm.js in the browser talking to a genuine pty. Scoped
  on purpose: only `ollama pull/list/ps/show/rm` execute.
- **Real chat**, streaming from Ollama with `qwen2.5:0.5b`.
- **A real sub-agent** — `server/agent.py`, a local model in a tool loop with
  one real tool.
- **Real model detection.** The green "installed ✓" comes from polling Ollama,
  not from a variable.

**The frontier tier** (`frontier/`) is the deliberate exception, and it breaks
every one of those promises on purpose. It sends your message to Claude Opus 5
or Claude Fable 5 running in a data centre. It costs real money, it leaves your
machine, and it takes 25–37 seconds to answer at high effort.

That contrast **is** the lesson. A student who has spent an hour running a 0.5B
model on their laptop is in a position to understand what the expensive option
buys and what it costs — which is not something you can teach by telling
someone.

Access is brokered through a relay so the API key never touches a student
machine, and it's paid for in tokens earned on the local track. Details in
[`frontier/README.md`](frontier/README.md).

## Run it

Needs [Ollama](https://ollama.com) running, Node 18+, and Python 3.

```
./run.sh
```

Then open **http://localhost:3001** — not the `.html` file directly, or CORS to
Ollama breaks.

For the frontier tier, also start the relay (see `frontier/README.md`). It's
optional: without it the local tier is unaffected and Coding Spaces simply
reports that it's offline.

## The rule this project is built on

**Nothing in the inference path is ever faked.** If Ollama isn't running, the UI
says so and gives you the command to fix it. If a model is missing, it tells you
which one. If a frontier message can't be afforded, it says what it needs and
offers the local model instead. There are no mock responses, no placeholder
answers, and no invented numbers anywhere — every cost and timing figure in the
frontier docs was measured, not estimated.

Quests, the token economy and the marketplace catalogue are UI state, and are
labelled as such. That's progression, not a technical claim.

## Layout

| | |
|---|---|
| `Local AI OS.dc.html` | The whole app — screens, styles, logic. Config at the top of the script block. |
| `support.js` | Rendering runtime the HTML depends on. Don't edit. |
| `server/` | Local bridge on `:3001` — serves the app, runs the scoped pty, exposes the sub-agent, forwards `/frontier/*` to the relay. |
| `frontier/` | Everything for the frontier tier: the relay, the design work, the measured data. |

## Status

The local tier is complete. The frontier backend is complete and tested; its
screen is partly built — the panel, sidebar, effort dial and live pricing work
against the real relay, but sending isn't wired up yet.
