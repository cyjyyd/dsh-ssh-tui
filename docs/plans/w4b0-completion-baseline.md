# W-4B.0 — Completion safety net: baseline, on the record

> **Status: evidence for W-4B.1, no implementation of it.** This round fixed a
> user-reported setup bug (Part A of the brief, its own commit) and established the
> executable baseline the completion extraction will be measured against. It did
> **not** create `src/completion.ts`, did not move completion state, and did not
> touch the Router, the keymap or the painter's contract.
>
> Branch: `agent/w4b0-safety-net`, from the gated design HEAD `7da9a85`.

---

## 1. The fingerprint every W-4B.1 case asserts

The design (`docs/plans/w4a-completion-ownership.md` §8.1) names the fields. This
is where each one lives today, so a baseline case can be written without guessing:

| Field | Today | Source |
|---|---|---|
| `input`, `cursor` | composer draft and caret | `tui.ts` fields; `fieldText()`/`fieldCursor()` read them unless a Surface borrowed the field |
| `inputFolded` | the one-row fold of a long/multi-line draft | set by paste/typing; painted as `输入已折叠` |
| `historyIndex`, `historyDraft` | history browse position and the draft it is holding | `historyBack()`/`historyForward()` |
| `focusedRow` | the transcript's focus ring | `moveFocus()`; only reachable when the draft is empty and cards exist |
| `scrollOffset` | transcript scroll | `scrollWorkspace()` |
| `commandSuggestions`, `suggestionIndex` | the list | **written by the painter** (`tui.ts:6482` sets it from `buildSuggestions()`) |
| `dialog` / `screen` | the layers | `openDialog`/`openScreen` |
| `borrowedText` | the field a Surface borrowed | the Surface's own object |
| `rowsAdded` | transcript rows a unit produced | `rows.length` around the unit |

`tests/completion-baseline.test.mjs` asserts subsets of this, through `handleData`
(the real input entry) and `render()` (the real paint) — never by calling private
helpers as the evidence.

---

## 2. The baseline, as executable cases

All thirteen pass on this branch. They are grouped by what a failure means.

### 2.1 Baseline — must keep passing (a failure is a regression)

| # | Case | Oracle |
|---|---|---|
| B1 | `/` lists the catalog in a 12-row window, aliases withheld, `dialog-test` hidden | painted list rows, `commandSuggestions` |
| B2 | ↑/↓ move `suggestionIndex` and leave `historyIndex` and the draft alone | the two indices + `input` |
| B3 | with no list, ↑ recalls history | `input`, `cursor` |
| B4 | Tab accepts `/help `, does not submit, opens nothing, writes no history | `input`, `cursor`, `rows.length`, `screen`, `history` |
| B5 | Enter on a prefix highlight completes and runs (`/hel` → `/help` report) | `screen.kind`, `input` |
| B6 | a Surface suppresses the list on the next frame and it returns when the Surface closes | painted rows, `commandSuggestions` |
| B7 | a Screen owns its read: an arrow after `/help⏎` does not move the list and types nothing | `suggestionIndex`, `input` |
| B8 | line mode never builds a list; Tab still inserts two spaces | `commandSuggestions`, `input` |

### 2.2 Pinned defects — pass today, and are *supposed* to change in W-4B.1

These are the "before" of the design's D1/D2/D2b. They pass because they describe
today's behaviour, and each one says in its comment which W-4B.1 change rewrites
it. They are **not** an endorsement of the behaviour.

| # | Today | W-4B.1 changes it to |
|---|---|---|
| P-D2a | `/ag` highlights `diag` (contains-only) and Enter **refuses** it: the literal `/ag` goes to the unknown-command notice | unchanged — D2 is **DEFERRED**; the case stays as the pin |
| P-D2b | `/HELP` highlights `help` and Enter refuses it (case-sensitive guard) | unchanged — same DEFERRED pin |
| P-D2c | Esc clears the array, and the next frame rebuilds it from the unchanged draft — the reader cannot dismiss the list | Esc sets `dismissedFor = draft`; rows go 12 → 0 and stay 0 until the draft changes |
| P-D1 | a paste updates the list only on the next paint; before it, the array still describes the old draft | the read-boundary refresh materializes it before the next unit is routed |

### 2.3 E1 — the Reader's own frames (async input)

`Reader.onFrame` can call `consumeFrame()` directly: a held Escape is released by a
timer, a paste tail by its watchdog, and neither passes through `handleInputText`.
`tests/completion-baseline.test.mjs` pins the current path — a lone Esc typed at an
open list is held 60 ms, then the released frame reaches `handleEscape` and empties
the array — so W-4B.1 cannot put its refresh only in the read loop. The oracle for
the new state is the same after the release as after a read-borne Esc.

---

## 3. W-4B.1 targets that have no executable case yet (RED / OPEN)

Listed so the gate can see what is *not* covered, rather than mistaking a green run
for completion. None of these is a skipped test; they are unwritten because the
behaviour does not exist yet.

| # | Target | Why there is no case yet | Oracle when it lands |
|---|---|---|---|
| R1 | completion state materialized at the read boundary (no paint-time write) | `src/completion.ts` does not exist; the list is still `commandSuggestions` written in `paint()` | a mutation that removes the read-boundary refresh must make a same-read case red (`/`, ↓, Tab, Enter as one `handleData`) |
| R2 | persistent `dismissedFor` (P-D2c flipped) | requires the state object | painted rows 12 → 0 and stay 0 across two frames; a later edit re-lists |
| R3 | `commands/change` refresh with no keystroke | the TUI does not subscribe today (grep: no `commands/change` in `src/`) | registering a command while a list is open repaints it without any input |
| R4 | stdio acceptance (P14 of the design) | needs the materialized state to assert "no paint-before-key dependency" | `/`, ↓, Tab, Enter through the display pipe, as one write and as four |
| R5 | Screen dismissal across one read vs the next read (E2) | partially covered by the W-3a traces; completion-specific assertion needs the state | same-read tail is discarded; a new read is routed again |
| R6 | draft-write guard (E4) | the funnel does not exist yet | a source-level guard: no `this.input =` outside `setField` |

### 3.1 E2 — Screen read termination (what exists today)

`handleInputText` records `screenDismissals` and stops delivering the rest of a read
when a Screen closed inside it (`tui.ts:12515`), so no unit after the dismissal can
reach the composer — and, once it exists, the completion state. A **new** read is
routed from scratch. B7 is the current, completion-adjacent version of that
contract; the W-4B.1 case adds `completion.index`/`visible` to the same shape.

### 3.2 E3 — `commands/change`

The event is declared by `@deepseek-ai/dsh-commands` in both supported host lines
(`lib/types/types.d.ts:86`, checked in 0.2.0-rc.2 and 0.2.1-rc.2), and the review
README describes it as the refresh signal for live adapters. **This plugin does not
listen to it today** (no occurrence in `src/`). R3 is therefore a genuine RED for
W-4B.1, with the design's fallback (revision bumped per draft change) if a host
does not dispatch it.

### 3.3 E4 — the draft-write inventory

Ten writes to the composer's draft, measured on this branch:

| Line | Site | Inside a read? |
|---|---|---|
| 9737 | `setField()` — the funnel | yes (all callers) |
| 12620 | Alt+F/Alt+/ seed (`/find `) | yes — a key |
| 12906 | Alt+F/Alt+/ seed (second site) | yes — a key |
| 12915 | Tab accept (`/name `) | yes |
| 12923 | Tab's two spaces | yes |
| 14660 | Enter's completion (`/name`) | yes |
| 14681 | submit clears the draft | yes |
| 15140 | `runCommand` clears the draft | yes — inside the submitting unit |
| 15236 | history back | yes — an arrow |
| 15244 | history forward | yes — an arrow |

So the read boundary is enough **today**, which is why W-4B.1's refresh at
`handleInputText` covers every path. The guard in R6 exists for tomorrow's
programmatic writer, not for today's nine sites.

### 3.4 E5 — stdio and line mode

`DSH_TUI_DISPLAY=stdio` is the full TUI over pipes (`docs/display-mode.md`), so
completion must work there; `DSH_TUI_LINE_MODE=1` never paints, so it must not
exist there (B8 pins the current "no list, Tab inserts spaces"). A host with no
terminal and no stdio declaration mounts nothing at all (`src/index.ts:258-268`).

### 3.5 E6 — performance

No cache, no timer, no lifecycle change was added. The frozen frame contract
(bytes / addressed rows / clears) is checked by `npm run bench` and
`npm run bench:report -- --check`; this round's diff is one regex change, one hold
at the Screen boundary, tests and this document.

---

## 4. Part A — the setup mouse regression (separate commit)

**Root cause, confirmed by RED then GREEN:** the setup Screen matched a mouse report
with `/^\x1b\[(\d+);(\d+);(\d+)([Mm])$/` — **no `<`** — while every terminal sends
the SGR form `ESC[<b;x;yM`. A right click therefore missed the branch and fell
through to `handleOnboardingChar`, which typed the payload into the field:
`[<2;20;10M`, twenty characters, on the API-key step as twenty bullets.

Two changes:

- the setup branch consumes reports with the existing `SGR_MOUSE_RE` (and the
  generic Screen branch now uses that constant instead of its own copy — one
  pattern, no third parser);
- the Screen branch of `route()` holds a `sequence` that is not a known shape and
  could still grow, so a report (or arrow) **split across two reads** is completed
  instead of typed. A lone Esc is an `escape` unit and is never delayed.

Evidence: eight unit cases in `tests/setup-screen.test.mjs` (six red before the
fix), a real-PTY step in `scripts/tui-setup-probe.mjs`, and a mutation proof —
restoring the old regex in `lib/` turns the probe red with the field going from one
bullet to twenty-one.

**What this does not prove:** the PTY step writes the bytes a terminal sends; it is
not a human clicking a physical mouse. Windows ConPTY is covered only by the CI
leg's run of the same probe (see the receipt), not by a local Windows machine.

---

## 5. Not done in this round

- no `src/completion.ts`, no state migration, no fifth owner, no keymap change;
- no version, dependency, compatibility, tag, npm or CI-policy change;
- no `main` merge, no release;
- no Windows run: the ConPTY side of the setup probe is `PENDING CI`.
