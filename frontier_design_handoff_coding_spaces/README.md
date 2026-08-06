# Handoff: Coding Spaces — frontier-model screen for Local AI OS

## Overview
Coding Spaces is the final unlock in Local AI OS. It lets a student spend tokens earned on the local track to talk to a frontier model (Claude Opus 5 / Claude Fable 5) in a data centre. The design covers the full experience: locked state, one-time unlock introduction, the conversation screen with a priced composer, the long "thinking" wait, streaming answer, receipt, and all failure states (out of tokens, stopped, declined).

## About the Design Files
The files in this bundle are **design references created in HTML** — a working prototype showing intended look and behavior, not production code to ship. The task is to **recreate this design inside the Local AI OS codebase's existing environment and patterns** (the app is a React-based single page with a 250px-sidebar shell; Coding Spaces is a new main-panel view like Chat/Quests/Marketplace). All streaming in the prototype is simulated; production wires to the real relay API documented in `FRONTIER_DESIGN_BRIEF.md` (bundled).

## Fidelity
**High-fidelity.** Colors, type, spacing, radii, motion, and copy are final and match the existing app's visual language. Recreate pixel-perfectly using the app's existing tokens where they already exist.

## Files
- `Coding Spaces.html` — the complete self-contained prototype. Bottom-left demo strip jumps between states; simulated streams play 4× faster than the measured timings (the real timings are in the JS `MODELS` table).
- `FRONTIER_DESIGN_BRIEF.md` — backend contract: API endpoints (`/estimate`, `/message` SSE, `/balance`), event order, all measured numbers, and the exact copy for failure states.

## Screens / Views

### 1. Locked
Main panel (right of sidebar): centered column, max-width 440px. Grey lock glyph, Newsreader 26px/500 heading "Coding Spaces is still locked.", body 14px `#8A8578` explaining the unlock quest. Sidebar "Coding Spaces" nav item shows a small lock glyph.

### 2. Unlock introduction (one-time, full-screen overlay)
Full-viewport overlay on paper `#FAF9F5`, z-index above the shell. Top bar: brand kicker left, "Skip — I've seen this" text button right. Footer: Back link, 5 progress dots (7px circles, active `#C15F3C`), terracotta Next button. Content column max-width 620px, each beat animates in with `modalIn` (.4s cubic-bezier(.22,1,.36,1)).

Five beats:
1. **Arrival** — kicker "CODING SPACES · UNLOCKED", Newsreader 38px "You've reached the frontier." Scale visual: 10px terracotta dot (local model) vs 130px dark `#1E1C18` circle (frontier), monospace captions, italic "not to scale" note. Gold particle burst fires on the big circle ~350ms after render (reuse the app's existing burst).
2. **The tradeoff** — "Capability has three costs." Ruled rows (1px `#E7E2D9` top/bottom borders): Not free / Not private / Not instant; serif 18px/600 keys at 150px fixed width, 14px `#6E6A60` values.
3. **Tokens are money** — "$0.0083 per token", balance ≈ dollar value. Coin-dot visual: ten 13px gold-outlined dots = "~10 messages to Opus 5 at medium effort (~7 each)"; two 26px dots = "or just 2 at Fable 5's max effort (25 each)". Closing reassurance line: unused tokens come back; "spend them on purpose."
4. **Effort dial (interactive)** — a live copy of the composer's model picker + dial + price inside a white card, fully functional, spends nothing. A caption below changes per model: for Fable it points out the flat-flat-flat-jump shape ("really a two-position switch").
5. **Comprehension check (one question)** — "The price says 'up to 13 tokens'. What will you actually be charged?" Three options; correct = "Usually much less. 13 is the ceiling; whatever isn't used comes back." Correct answer gets `#7BA05B` border + tint and enables the final button, which reads "Open Coding Spaces →". Wrong answers get a soft error tint and a corrective line — no lockout, no retry count.

Skip is always available and goes straight to the conversation screen.

### 3. Conversation screen (first arrival / composing)
Shell: existing 250px sidebar `#F4F1EA` + main panel. Persistent token pill fixed top-right (white pill, gold dot, tabular number, existing `pillBounce`/`glowPulse` on change).

**Panel header** (new): slim row, 1px bottom border. "Coding Spaces" in Newsreader 18px + a dark chip — `#1E1C18` pill, `#D8D3C8` 11px/600 text "✦ FRONTIER · RUNS IN A DATA CENTRE" (the diamond is a 6px rotated square, not an emoji). The dark chip is the tier marker; nothing local ever uses dark surfaces in light chrome.

**Sidebar decision:** frontier conversations live in the SAME sidebar as local chats but in their own labeled group — "ON YOUR LAPTOP" section above, "◆ CODING SPACES" section below (10.5px letter-spaced caps heads). Frontier session rows carry a small dark diamond. One navigation, never intermixed.

**Empty state:** centered hero at ~14vh top padding — Newsreader 28px "This is the frontier tier.", two muted lines, and one suggested-prompt button (bordered white card, terracotta on hover).

**Composer** (bottom of 680px centered column, white card, 14px radius, 1px `#E7E2D9` border, `0 2px 10px rgba(38,36,30,.04)` shadow):
- Auto-growing textarea (max 120px), placeholder "Ask something your local model can't do…". Enter sends, Shift+Enter newlines.
- Control row below a 1px `#F2EFE8` divider, flex, align-end, gap 16px:
  - **Model picker**: segmented control on `#F2EFE8`, 9px radius; active segment white with subtle shadow. "Opus 5" / "Fable 5". `flex:none`, no wrapping.
  - **Effort dial**: labelled "EFFORT" (10.5px caps). Five 26px-wide clickable stops rendered as a **mini bar chart** — bar height ∝ that stop's ceiling cost (5–30px, normalized to the model's max). Idle bars `#E7E2D6`, hover `#C4BFB2`, selected `#C79014`. Labels under each: Low / Med / High / X-hi / Max (9.5px, selected in `#8A6A0E`). The bars are the point: Fable's flat-then-cliff cost curve must be visible at a glance.
  - **Price readout** (right-aligned, next to send): line 1 monospace 13px/600 `#8A6A0E` "up to N tokens"; line 2 11px `#A9A492` "usually ~M · unused comes back". On any model/effort change the price re-fetches `/estimate` and line 1 bumps with `pillBounce` .35s. **Never label it "cost"** — "up to" is mandatory (the ceiling overstates ~4×).
  - Conditional warning line (11px `#8A6A0E`, max-width 200px): when ceiling ≥ 50% of balance → "Could use up to N of your B — usually much less."; when balance < typical → "Not enough for this one — your local model is free below."
  - **Send**: 36px square, 10px radius, terracotta `#C15F3C` → `#A24E30` hover, white ↑.
- Below the card, centered 11.5px `#B5AF9F`: "Priced before you send, free — only what the model actually writes is charged."

### 4. Thinking (the 25–37s wait) — the core of the design
An assistant turn begins in the transcript with a meta row: dark badge "✦ Opus 5", "max effort", and a live monospace elapsed timer (m:ss).

Phase A, **holding** (~first 4–6s, before any stream): a quiet note card (`#FAF8F3` fill, 9px radius, gentle 2.2s `breathe` opacity pulse — the only motion): "**13 tokens** held — you'll only pay for what gets written. Reasoning streams in a moment." Real information in place of a spinner.

Phase B, **reasoning as the main event**: a block with a 2px `#E7E2D6` left rule, 16px left padding. Label row: pulsing 7px terracotta dot + "THINKING — STREAMED LIVE" (11px letter-spaced caps `#A9A492`) + a plain-language expectation: "answers usually start ~25s in at this effort" (from the measured medians per model×effort). Body: the summarized reasoning streaming word-by-word at **full reading size** — 14px/1.75 in `#6E6A60` (muted ink, clearly not the answer) with a blinking terracotta caret. Transcript auto-scrolls. This is deliberately the dominant content on the page for the whole thinking window.

Phase C, **yield**: the moment the first answer word arrives, the reasoning body collapses (max-height transition, .6s cubic-bezier(.22,1,.36,1)) to a single toggle line: "Show thinking · 0:20" (12px/600 muted, terracotta on hover; toggles Show/Hide). The answer streams below in full ink 14.5px/1.68.

### 5. Answering
Answer renders markdown: paragraphs, inline code (`#F2EFE8` chips, mono 13px), and code fences as dark blocks — `#1E1C18` bg, `#D8D3C8` mono 13px/1.6, 10px radius. Streaming caret at the tail. During any generation the composer's control row is replaced by a status line ("Opus 5 · max effort · working…") and the stop button (see Stopped).

### 6. Complete — the receipt
Appended under the answer (`fadeUp`): card on `#FAF8F3`, 1px `#E7E2D9` border, 12px radius, 12.5px text.
- Row 1 (mono): "charged **3 tokens** ($0.025)" (bold numbers in `#8A6A0E`; USD in `#B5AF9F`, 3 decimals) · "10 of 13 held came back" · "balance **49**".
- Row 2: a 6px two-segment split bar (max 260px) — thinking share in `#C4BFB2`, answer share in `#E3B23C` — captioned "about 38% went on thinking, 62% on the answer you see". Always "about", never exact (the split is estimated; `reasoning.estimated` is true).
- Turn ≥ 2 only, below a hairline: the caching lesson — "**Cheaper than your first message?** The whole conversation gets re-sent every turn — but history the model has already seen is read from cache at about a tenth of the price. Follow-ups here cost less, not more."
Token pill animates to the new balance with count-up + bounce.

### 7. Out of tokens (HTTP 402, before any stream)
Inline card in the transcript (white, 12px radius, max-width 560px), copy verbatim from the brief: heading "You're out of tokens for this one.", body "This message needs about **9** and you have **4**…". Actions: terracotta "Send to local model instead" + ghost "See how to earn tokens". Never a dead end.
Local fallback reply streams fast and is unmistakably labelled with the existing terracotta badge: "◈ Qwen 2.5 · 0.5B — your laptop · free". The visible quality gap between it and a frontier answer is intentional teaching.

### 8. Stopped
The stop button carries the price of pressing it: "■ Stop — you'll be charged for what's written so far" (bordered ghost button; border/text turn `#C0442A` on hover only). After stopping, partial reasoning/answer stay in place, followed by a card: "Stopped. You were charged **1 token** for what had already been generated. The other **12** went back." Balance refunds immediately.

### 9. Declined
Turn shows the model badge then a card: "This one came back declined. The model's safety checks stopped this request. **You weren't charged.** Rephrasing usually helps — or try the local model, which has different limits."

## Interactions & Behavior
- Effort dial + model picker → call `POST /estimate` on every change (free); update "up to N" with a bump animation. This live interaction is the lesson — never debounce it away.
- Send: hold ceiling immediately (pill drops to balance-after-hold), then render phases from SSE events: `start` → holding note; `thinking` deltas → reasoning stream; first `text` delta → collapse reasoning, stream answer; `done` → receipt + refund animation.
- Stop: close the SSE connection; render the cancelled card from the `cancelled` event.
- Timings to design against (medians, seconds — model: firstWord/complete per effort low→max):
  - Opus 5: 4.3/22.1 · 9.3/32.6 · ~15/38 · ~20/42 · 25.2/46.8
  - Fable 5: 3.9/16.6 · 6.1/17.3 · ~15/30 · ~25/44 · 37.5/55.9
  - (high/x-high values are interpolated in the prototype — replace with calibrated numbers.)
- Ceilings ("up to") and typical charges used in the prototype — opus up:[8,13,15,17,20] typ:[4,7,8,9,10]; fable up:[10,10,15,24,38] typ:[6,6,9,14,25]. Production uses `/estimate`'s `maxTokenCost` for "up to"; "usually ~M" should come from calibration data.
- Motion: reuse the app's existing keyframes (`fadeUp`, `modalIn`, `pillBounce`, `glowPulse`, particle burst). New here: `breathe` (2.2s opacity pulse) on the holding note and thinking dot only.
- No responsive work: fixed 250px sidebar, content column max 680px, target 1280–1600px.

## State Management
Per conversation (browser-side only — the relay stores nothing):
- `messages[]` (full history, re-sent every turn), `title`
- `model` ('claude-opus-5' | 'claude-fable-5'), `effort` (low|medium|high|xhigh|max; API default high)
- `phase`: idle | holding | thinking | answering
- per assistant turn: `reason`, `answer` (accumulated deltas), `elapsed`, `reasonOpen`, `receipt {charged, refunded, held, balance, thinkingShare, cached}`, `status` (done|stopped|declined)
- Global: `balance` (from `GET /balance`), `unlocked`, `introSeen` (persist locally so the intro shows once)
- Persist conversation history locally (localStorage/IndexedDB) — a closed tab otherwise loses it.

## Design Tokens
Colors (all from the existing app):
- Paper `#FAF9F5` · Surface `#FFFFFF` · Sidebar `#F4F1EA`
- Fills `#FAF8F3 #F2EFE8 #EFEBE2 #ECE8DE #E7E2D6` · Border `#E7E2D9`
- Ink `#26241E` · Muted `#6E6A60 #8A8578 #A9A492 #B5AF9F #C4BFB2`
- Accent terracotta `#C15F3C` (hover `#A24E30`) — actions only
- Gold `#C79014` / deep `#8A6A0E` / light `#E3B23C` — token currency only (incl. the dial bars: they represent token cost)
- Error `#C0442A` · Success `#7BA05B`
- Dark `#1E1C18` / `#2A2722` / on-dark `#D8D3C8` — code blocks + the frontier tier marker

Type: Newsreader (Google Fonts, 400/500/600, Georgia fallback) for headings only; system sans for body; ui-monospace for numbers, prices, timers, code. Radii 8–16px, pills 999px. Text sizes: headings 18–38px serif, body 14–14.5px, meta 11–12.5px, micro-caps 10.5–11px letter-spaced.

## Assets
None. All glyphs are CSS shapes (rotated-square diamond, lock, dots). No icon fonts, no images, no emoji.
