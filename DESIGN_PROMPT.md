# Prompt for Claude Design

Copy everything below the line. Attach these two files:

- `FRONTIER_DESIGN_BRIEF.md` — the measured facts, contracts and failure copy
- `Local AI OS.dc.html` — the existing app, for the visual language

---

I'm designing a new screen for **Local AI OS**, a local-first AI learning app for
high-school students. I need you to design and build it as working HTML/CSS.

## Background

Local AI OS teaches students how AI actually works by making them run a small
model (`qwen2.5:0.5b`) entirely on their own laptop — no cloud, no account, no
cost. They pull the model in a real terminal, chat with it, and progress through
quests that unlock a marketplace and then sub-agents. The app's whole credibility
rests on nothing being faked: if the model isn't installed, the UI says so and
tells you the exact command to fix it. There are no mock responses anywhere.

**Coding Spaces is the final unlock.** It lets a student spend the tokens they've
earned on the local track to talk to a genuine frontier model — Claude Opus 5 or
Claude Fable 5 — running in a data centre instead of on their laptop. The backend
is built, tested and measured; I need the screen.

Three things it has to teach, in priority order:

1. **The capability tradeoff.** When is a task genuinely too big for the local
   model, and when are you just reaching for the expensive option out of habit?
2. **Real cost.** Tokens stop being a game score here. They buy inference that
   costs actual money, and students should feel that without becoming afraid to
   experiment.
3. **Effort as a dial.** More thinking means better answers on hard problems, and
   costs more, and takes longer. All three should be felt, not just stated.

The central design tension: **cost has to be visible enough to teach and quiet
enough that pressing send still feels safe.** A student too anxious to experiment
has learned the wrong lesson.

## The hardest problem, and the thing I most want you to solve

**At high effort a student waits 25–37 seconds before a single word of the answer
appears.** These are measured medians, not estimates:

| Model | Effort | First word of the answer | Complete |
|---|---|---:|---:|
| Opus 5 | low | 4.3s | 22.1s |
| Opus 5 | medium | 9.3s | 32.6s |
| Opus 5 | max | **25.2s** | 46.8s |
| Fable 5 | low | 3.9s | 16.6s |
| Fable 5 | medium | 6.1s | 17.3s |
| Fable 5 | max | **37.5s** | 55.9s |

The screen is not blank during that time — the backend streams the model's
**summarised reasoning live, word by word**, so you can show the student the
thinking as it happens. But for those 25–37 seconds, *reasoning is the only
content on the page.*

This means a design that tucks reasoning into a small collapsed strip leaves
students watching near-nothing for half a minute. I think the reasoning probably
has to be the main event while it's happening and then yield gracefully to the
answer — but that's my instinct, not a requirement. **Solve it however you think
is right, and tell me why.** Every other decision on this screen is downstream of
this one.

## What things cost

One token = $0.0083. Students arrive with roughly **60–80 tokens** earned on the
local track.

| Model | Effort | Typical cost |
|---|---|---:|
| Opus 5 | low | 4 tokens |
| Opus 5 | medium | 7 tokens |
| Opus 5 | max | 10 tokens |
| Fable 5 | low | 6 tokens |
| Fable 5 | medium | 6 tokens |
| Fable 5 | max | **25 tokens** |

So: about ten medium Opus 5 messages, or two max-effort Fable 5 messages. The top
tier is meant to feel like a decision.

Three facts worth designing around:

- **Fable 5 barely distinguishes low from medium** (6 tokens either way, 16.6s vs
  17.3s), then max is 4× the cost. On that model the dial is nearly a two-position
  switch rather than a smooth gradient. A five-stop slider implies a gradation
  that doesn't exist.
- **Cost is driven by how much the model writes, not the price on the label.** In
  testing, Opus 5 cost four times what Fable 5 did on the same prompt — despite
  being half the price per token — because it wrote eight times more.
- **Conversations get cheaper after the first message**, because history is
  cached. Measured: turn 1 cost 8 tokens, turns 2 and 3 cost 3 each. This is
  counterintuitive and the single most interesting thing to teach if there's room
  for one piece of "how this works" education.

## What the screen actually is

It's a **conversation interface** — the student types a message, sends it, and a
reply streams back. Structurally it sits inside the app's existing shell: a 250px
left sidebar for navigation and session list, with Coding Spaces filling the main
panel to the right (the same way the app's existing Chat, Quests and Marketplace
panels do).

The main panel needs, at minimum:

- a **transcript** of the conversation so far
- a **composer** at the bottom where the student types
- attached to that composer: a **model picker** (Opus 5 / Fable 5), an **effort
  dial** (five levels), and a **live price** that updates as either changes
- the student's **token balance**, visible without hunting for it

How those pieces are arranged, weighted and grouped is yours to decide — that
list is what must exist, not a layout. The existing app puts a persistent token
pill at the top right and keeps its chat composer in a rounded card at the bottom
of a centred column; you can follow that, extend it, or argue for something else.

## Scope — the full Coding Spaces experience

Design and build all of these states:

1. **Locked** — before the student has unlocked the tier

2. **The unlock moment** — an introduction the student sees *once*, immediately
   after unlocking, before they ever reach the conversation screen. This is the
   only guaranteed moment where they're paying full attention, so it carries the
   teaching. It should open with a genuine sense of arrival — the app already
   celebrates unlocks with particle bursts, glow pulses and a rising toast, and
   this is the biggest unlock in the product — then explain four things:

   - **What a frontier model is**, against what they've been using. They've spent
     the whole app running a 0.5B model on their own laptop. These are vastly
     larger models in a data centre. Concretely: their local model can't reliably
     write a working program or reason through a multi-step problem; these can.
   - **The tradeoff.** It isn't free, it isn't private to their machine, and it
     isn't instant. Those are the costs of the capability.
   - **What tokens actually buy.** The currency they've been earning stops being
     a score and becomes money. ~7 tokens for a typical Opus 5 message; 25 for a
     max-effort Fable 5 one; they have about 70.
   - **The effort dial**, which is the one genuinely new control.

   Whether that's one screen, a short sequence of beats, or something animated
   and progressive is yours to decide. It must not be a wall of text, and it must
   be skippable for a student who's seen it — but it should be worth *not*
   skipping. There's precedent in the app: the marketplace makes students scroll
   a README and pass a three-question quiz before unlocking sub-agents, so a
   short comprehension check at the end would sit naturally here. Include one if
   you think it earns its place; say so if you think it doesn't.

   End it with a clear way into the conversation screen.

3. **First arrival** — the conversation screen, unlocked, empty, with a balance
   and nothing sent yet
4. **Composing** — the model picker, the effort dial, and a live price that moves
   as the dial moves (the price is fetched free before sending, so the number can
   update in real time — this interaction *is* the lesson)
5. **Thinking** — the 25–37 second problem above
6. **Answering** — reasoning done, answer streaming in
7. **Complete** — the receipt: what was charged, what was refunded, new balance,
   and how much of what they paid for was invisible reasoning
8. **Out of tokens** — must never be a dead end; the student falls back to their
   local model, clearly labelled, and keeps working
9. **Stopped** — the student pressed stop mid-generation
10. **Declined** — the model's safety checks refused; the student is not charged

Exact copy for states 8–10 is in the attached brief. Use it, or improve on it and
tell me what you changed.

Two things the copy must not get wrong, because both destroy trust:

- **The pre-send price is a ceiling, not a prediction.** It typically overstates
  by about 4× — a message showing 13 was charged 3. Never label it "cost". Use
  "up to", or a range. A student told 13 who is charged 3 stops believing every
  number on the screen.
- **Stopping is not free.** Tokens already generated were really billed, so the
  student is really charged. The button has to say so *before* it's pressed.

## Visual language

Match the existing app — same product, one floor up. It should be immediately
obvious which tier a student is in, without the frontier screen looking like a
different application. The attached HTML file is the source of truth; the values
are:

```
Paper / page          #FAF9F5
Surface / cards       #FFFFFF
Sidebar               #F4F1EA
Subtle fill           #FAF8F3   #F2EFE8   #EFEBE2   #ECE8DE   #E7E2D6
Borders               #E7E2D9
Ink / primary text    #26241E
Muted text            #6E6A60   #8A8578   #A9A492   #B5AF9F   #C4BFB2
Accent (terracotta)   #C15F3C   hover #A24E30
Tokens / currency     #C79014   deep #8A6A0E   light #E3B23C
Error                 #C0442A
Success               #7BA05B
Dark surface          #1E1C18   header #2A2722   on-dark text #D8D3C8
```

- Display type: **Newsreader** (Google Fonts), weights 400/500/600, with
  `Georgia, serif` fallback. Used for headings only.
- Body: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`
- Code and numbers: `ui-monospace, Menlo, monospace`
- Corner radii run 8–16px; pills use 999px
- Existing layout: 250px sidebar, content column maxing at ~680px
- The app already has a motion vocabulary — `fadeUp`, `modalIn`, `pillBounce`,
  `glowPulse`, a particle burst on rewards. Reuse or extend it rather than
  introducing a different feel.

Gold (`#C79014`) is reserved for the token currency throughout the app. Terracotta
is the action colour. Keep both roles.

## Deliverable

**A brand new, self-contained HTML file.** Not an edit of the attached app file —
write it from scratch, standing alone, opening cleanly in a browser on its own.

Inline CSS, and whatever vanilla JavaScript you need to demonstrate the states.
No build step, no external dependencies except the Google Fonts link. It should
be explorable: buttons that move between states, a working effort dial, and a
simulated stream so the thinking and answering states can be seen in motion
rather than described.

**About the attached `Local AI OS.dc.html`** — it is *reference only*, for the
visual language: real colours in context, type scale, spacing, motion, and how
the existing panels are structured. Read it to match the feel.

Do **not** copy its markup conventions. That file uses a custom templating syntax
(`<sc-if>`, `<sc-for>`, `{{ handlebars }}`) belonging to a runtime that won't
exist in what you write. Give me plain, ordinary HTML. I'll translate it into the
app's structure myself, so favour clear markup and real values over cleverness,
and don't wire anything to an API — fake the data locally.

Alongside the file, give me a short rationale covering:

1. How you solved the 25–37 second wait, and what you rejected
2. How the price behaves on the effort dial
3. How the two tiers stay distinguishable
4. Anything in my framing you think is wrong

## Please avoid

Generic AI-app aesthetics: Inter/Roboto/system-font-everything, purple gradients,
glassmorphism, dark-mode-by-default, cards with drop shadows and nothing else,
emoji as iconography. This app has a specific warm editorial character already —
serif headings, cream paper, a restrained terracotta accent. Stay in that world
and make it feel considered rather than generic.

Also avoid: cost information rendered as anxiety (red warnings, aggressive
counters, anything that reads like a paywall), and progress indicators that
convey nothing — a spinner for 37 seconds is the failure case this whole brief
exists to prevent.
