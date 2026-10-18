# W-4A — Completion ownership: design contract for W-4B

> **Status: PROPOSAL (0.8.5 candidate line). Not implemented, not frozen.**
> This round is a design and assessment pass. `src/`, `tests/`, `scripts/`,
> `package.json`, the lockfile and CI are unchanged; the only artifacts are this
> document and `perf-low-resource-audit-v0.1.md`.
>
> Baseline: `main` @ `83a8c7e` (0.8.4-rc.1 published to `next`). Branch:
> `agent/w4a-completion-design`. Every claim below was read out of the code at
> that commit; line numbers are that commit's.

---

## 1. What exists today, from the code

### 1.1 Call chain

```
process.stdin → TerminalInputGuard → InputReader.read()
  ├─ non-paste → units()  → frames: key | burst | literal | escape | reply
  └─ paste     → frames() → paste (payload, markers stripped)
        ↓
SshTui.handleInputText()            src/tui.ts:12495
        ↓  per frame
SshTui.consumeFrame()               src/tui.ts:12521
        ├─ 'paste'  → dispatchPaste()      src/tui.ts:12700
        ├─ 'literal'/'escape'/'key' → dispatch(kind, unit)
        └─ dispatch()              src/tui.ts:12677
              ├─ observe(kind, unit)        src/tui.ts:12634   (fills OwnershipSnapshot)
              └─ InputRouter.route()        src/input-router.ts:74
                    → ownerScreen | ownerSurface | ownerComposer | ownerWorkspace
                          └─ composerUnit()    src/tui.ts:12841  (shared executor)
```

### 1.2 Where completion lives

| Fact | Location | Evidence |
|---|---|---|
| The suggestion list is **derived state written during paint** | `src/tui.ts:6482` — `this.commandSuggestions = this.dialog === undefined ? this.buildSuggestions() : []` | inside the frame composer (`paint()`), after `headerLines` is built |
| The index is clamped during paint | `src/tui.ts:6483` | `if (this.suggestionIndex >= this.commandSuggestions.length) …` |
| The window is shared with every other list | `src/paint.ts:564` `pickerWindowStart()`; used at `src/tui.ts:6487` | one sliding-window rule for picker, dialogs, suggestions |
| The builder queries the **host service on every paint** | `src/tui.ts:6981` `buildSuggestions()` | `this.ctx.get('commands')?.list(this.agent)` then maps + localizes every entry |
| The builder is pure below that | `src/commands.ts:76` `commandSuggestions()` | local catalog first, host commands after, local wins duplicates, prefix ranks starts-above-contains |
| "Visible" is a read of the cached array | `src/tui.ts:7001` `suggestionsVisible()` | `commandSuggestions.length > 0 && dialog === undefined` |
| ↑/↓: list first, else history | `src/tui.ts:12802` `arrowHistory()` | reads `suggestionsVisible()` |
| Tab: accept, else two spaces | `src/tui.ts:12906` | `input = '/name '`, clears list; otherwise inserts `'  '` |
| Enter: complete-then-submit | `src/tui.ts:14647` | applies the selected name **iff** `selected.name.startsWith(input.slice(1))`, then runs/submits |
| Esc: clears the list | `src/tui.ts:14237` | after scroll, focus ring, and only then the list |
| Ctrl+N / Ctrl+P: focus ring | `src/tui.ts:12878`/`12881` | gated on `dialog === undefined`, **not** on the list |

### 1.3 Who owns an arrow today

Two decisions, in two places:

1. **Router** (`src/input-router.ts:107`): an ↑/↓ goes to `workspace` iff
   `composerEmpty && workspaceCards`; otherwise to `composer`.
2. **Composer adapter** (`src/tui.ts:12803`): with the composer owning the unit,
   the list takes it if `suggestionsVisible()`, otherwise history.

The second one is the "implicit ownership decision" the brief names. It is not a
second *router* — the adapter is allowed to interpret a unit it owns — but it is
a decision the Router cannot see, it reads state that paint wrote, and it has a
different notion of "empty" than the Router does.

`OwnershipSnapshot` (`src/input-router.ts:47`) has no completion field:

```ts
screenKind, surfaceKind, surfaceHasField, composerEmpty, workspaceCards
```

### 1.4 What the tests cover

| Area | Covered? | Where |
|---|---|---|
| Ranking, aliases, host merge, case-fold, duplicate names | yes | `tests/commands.test.mjs` (pure builder) |
| The 12-row window slides and the list paints | yes | `tests/helpers.test.mjs:646`, `:659` (`captureFrame`) |
| Ownership of ↑/↓/Tab/Enter while the list is up | **no** | `grep suggestionIndex tests/` → only `helpers.test.mjs:662`, a paint fixture |
| History untouched while the list is up | **no** | — |
| Surface/Screen preemption over the list | **no** | the matrix (`tests/input-ownership-matrix.test.mjs`) has no suggestion case |
| Paste vs the list | **no** | — |
| Rebinding, line mode, ConPTY, narrow resize | **no** | — |

So today's completion is verified as a *renderer* and not as an *owner*. That is
the gap W-4A exists to close.

---

## 2. Behaviour inventory (what a reader sees today)

| # | Situation | Current behaviour | Source |
|---|---|---|---|
| B1 | `/` typed | list of 67 entries (27 local + 40 host in the fixture), 12-row window, `↑ 还有`/`↓ 还有` markers | `tui.ts:6487`, measured |
| B2 | prefix typed | local + host filtered; names starting with the prefix rank first | `commands.ts:91` |
| B3 | ↑/↓ with list | moves the highlight; history untouched | `tui.ts:12803` |
| B4 | ↑/↓ without list, empty draft, cards present | transcript focus ring (Router sends it to `workspace`) | `input-router.ts:118` |
| B5 | ↑/↓ without list, otherwise | history browse | `tui.ts:12807` |
| B6 | Tab with list | writes `/name `, clears the list, **does not submit** | `tui.ts:12906` |
| B7 | Tab without list | inserts two spaces | `tui.ts:12916` |
| B8 | Enter with list | completes to `/name` **then submits** the command | `tui.ts:14647` |
| B9 | Enter without list | normal submit / card toggle | `tui.ts:14654` |
| B10 | Esc with list | clears the list only | `tui.ts:14237` |
| B11 | Esc with list **and** a scrolled transcript or a focused card | scroll/focus wins; the list survives | order at `tui.ts:14220` |
| B12 | Ctrl+N/P with list | moves the transcript focus ring; the list is unaffected | `tui.ts:12878` |
| B13 | Paste containing `/…` | inserts into the draft; the list appears on the **next paint** | `tui.ts:12969` |
| B14 | Multi-line paste | folded into one row + `输入已折叠`; the list is computed from the raw `input` (newlines included) → no matches | `tui.ts:12976` |
| B15 | `/clear`, session switch, `/model` | `input` changes → the list is rebuilt on the next paint; index clamped then | `tui.ts:6482` |
| B16 | Surface or Screen opens | list is not painted (`dialog === undefined` gate) but `commandSuggestions` keeps its old value until the next paint | `tui.ts:6482` |
| B17 | Shift+Tab | **no handler anywhere**: not in `KeyAction` (`keymap.ts:14`), not in `isSequenceShape` (`tui.ts:12655`), not in `composerUnit`. `ESC[Z` frames as a complete CSI key and is then ignored | `input-reader.read('\x1b[Z')` measured; `tui.ts:12841` has no case |
| B18 | line mode | `paint()` does not run, so the list never exists; Tab inserts spaces | inferred (`lineMode` path) |

### 2.1 What this design has to account for

W-4B **removes D1** (the list stops being written during paint) and **contains
D3** rather than removing it: the Router keeps deciding *which layer*, and the
composer — the one owner it named — stays the only place that interprets the unit
inside that layer. **D2 is not removed**: it is recorded, bounded and deferred (D2
below), and no part of this document may call it fixed.

**D1 — paint writes state that input reads.** `commandSuggestions` is assigned in
the frame composer. Between two paints, `suggestionsVisible()` answers from the
*previous* frame, so any read that arrives in that window sees the list the last
frame drew.

The cheapest real path that shows it, measured in-process, with no Screen and no
Surface involved:

1. send a plain message (`hello\r`) — the composer is empty again and `history`
   holds one entry (`['hello']`), which is the precondition for ↑ to browse history;
2. type `/clear` and let the frame land, as it does while a reader types: the list
   is open and `commandSuggestions` holds the `/clear` entry (measured: 1 item);
3. press Enter — `submit()` runs the command and empties the draft, and **nothing
   clears the list**: it is only cleared by Tab, Esc, or the next paint (measured:
   `input` is `''`, `commandSuggestions` still has 1 item);
4. press ↑ before the next frame — `suggestionsVisible()` still answers `true`, so
   `arrowHistory` takes the list branch: `input` stays `''` (measured) where the
   reader asked for `hello` from history. The frame that follows empties the list —
   after the arrow has already been spent.

That is a one-frame window, and it is exactly the kind of same-read hazard W-3a
spent a release eliminating. The same window is what makes §5.4's keyed
derivation necessary: a state that is only correct *after* a paint cannot be read
by the code that runs *before* one.

**D2 — the highlight and Enter's action can disagree (visibility vs execution).**
`submit()` completes first (`tui.ts:14648`) and then runs the command, but only
when `selected.name.startsWith(this.input.slice(1))`. The list, however, also
matches by *contains* (`commands.ts:89`), and that guard compares **case-sensitive
bytes** while the filter lowercases the prefix (`commands.ts:81`). Measured
consequences today:

- `/ag` → `diag` is highlighted (contains-only) → the guard refuses → the literal
  `/ag` is submitted as a command line and fails as unknown;
- `/HELP` → `help` is highlighted (the filter is case-insensitive) → the guard
  compares `HELP` with `help` → refuses → `/HELP` is submitted and fails.

Tab has no such asymmetry: it accepts whatever is highlighted.

**W-4B does not fix this**, and this document must not claim it does. It keeps the
prefix guard — a contains-only or case-mismatched highlight must never execute a
command the reader did not type — moves the decision into `acceptCompletion` so it
is testable without `submit()`, and records the inconsistency as **DEFERRED**.
Fixing it means choosing between "highlight only what Enter will run" (a ranking
change: `/ag` would have to show nothing, or rank by prefix only) and "Enter runs
whatever is highlighted" (a new execution path for a near-miss name); both are
product decisions with their own matrix rows, and neither belongs to an ownership
round.

**D2b — Esc does not dismiss the list today (measured).** `handleEscape` clears
`commandSuggestions` and `suggestionIndex` and calls `markDirty()`
(`tui.ts:14237-14241`); the next frame then rebuilds the list from the unchanged
draft (`tui.ts:6482`). Measured in-process with `captureFrame`: 12 painted rows
before Esc → array cleared to 0 → **12 painted rows again on the next frame, array
back to 27**. So for the reader Esc is a no-op on the list. W-4B's persistent
`dismissed` flag is therefore an **intentional observable behaviour change** (the
key starts doing what it looks like it does), not a refactor with identical
behaviour; it gets before/after tests (§8.2 P6, §8.3 N6) and a line in the W-4B
round's notes.

**D3 — one key, two owners, no single place to read.** The arrow's meaning is
split between `InputRouter.route` and `arrowHistory`. Neither is wrong today, but
W-4B cannot add a completion *state* without deciding which of the two learns
about it. That is the whole design question below.

---

## 3. Options

### Option A — Composer-owned completion subsurface (recommended)

Keep the four Router owners. Completion becomes a small **state module** the
Composer adapter owns and the painter reads:

```ts
// src/completion.ts (new, pure, no I/O)
export interface CompletionState {
  readonly query: string        // the draft the items were built for
  readonly items: readonly CommandSuggestion[]
  readonly index: number
  readonly dismissed: boolean   // Esc, until the draft changes again
}
export function completionFor(query, hostCommands, locale, dialogOpen): CompletionState
export function moveCompletion(state, delta): CompletionState
export function acceptCompletion(state, draft): { text: string; cursor: number } | undefined
```

- The Router keeps its current rule: non-empty draft ⇒ `composer`; empty draft +
  cards ⇒ `workspace`. Completion is only possible with a `/`-prefixed draft, so
  it can never be visible while the Router is sending arrows to the workspace.
  That invariant is testable (see §6, M4).
- The Composer adapter (`ownerComposer` / `composerUnit`) asks the completion
  state for ↑/↓/Tab/Enter/Esc, exactly where it asks `suggestionsVisible()`
  today.
- Paint renders `state` and writes nothing.

This is not "no new state": it is state in one place, derived by a key, instead
of a cache written as a side effect of drawing.

### Option B — Router-aware completion

Put `completionVisible` (or a fifth owner `'completion'`) into
`OwnershipSnapshot` and let the Router route ↑/↓/Tab/Enter/Esc to it.

Costs:

- **A fifth priority class** in a module whose whole value is that it has four
  and a total order (Screen > Surface > Composer/Workspace). A completion owner
  sits *inside* the composer's text field, not beside it: the composer still
  owns the field, the caret, the draft, Ctrl+U, paste. Two owners over one field
  is the shape W-3b removed, not the shape it left.
- **The Router would have to be fed derived state.** `route()` is a pure function
  of the snapshot; `completionVisible` is only correct if the list was rebuilt
  after the last mutation of `input`, which means either recomputing it inside
  `observe()` for every unit (paying the host query per keystroke, including for
  keys that cannot change the draft) or trusting a cache again — D1 with extra
  steps.
- **Priority conflicts become expressible.** Screen/Surface already preempt by
  returning early. A completion class invites the question "does Tab at a Surface
  with a borrowed field belong to the Surface's field or to completion?", which
  today has one answer (`handleDialogChar`, i.e. the Surface) because completion
  is simply not reachable there.
- **`composerUnit` keeps its hidden writes.** With a fifth owner, the Surface
  adapter and the completion owner would both fall through to `composerUnit`,
  which is where `dialog` branches already live; the completion branch would be a
  third interpretation of the same executor.

Option B buys a router-level vocabulary for something only the composer can
answer. It is the larger refactor without the larger guarantee.

### Comparison

| | A | B |
|---|---|---|
| Files touched | new `src/completion.ts`, `tui.ts` (adapter + paint), tests | `input-router.ts` (type + rules), `tui.ts` (snapshot fill, adapter, paint), tests |
| State consistency | one derived object, keyed by `(draft, dialog, locale, host generation)` | same object **plus** a snapshot field that must be refreshed before routing |
| Ownership decisions | one (Router) + one interpretation inside the owner it handed to | two Router decisions (workspace/composer, then completion) + adapter |
| New owner class | no | yes (or a fifth field every rule must consider) |
| Test difficulty | state-level unit tests + PTY traces | the same, plus router-table tests for a class that is not a layer |
| Performance | one small derivation per draft change (measured: +0.079 ms/frame for 67 items) | the same derivation, but reachable from `observe()` — i.e. per unit, not per draft change |
| Regression risk | low: the Router is untouched | medium: the freeze audit counts routers/dispatchers, and every added rule is a place a later round can fork |
| Frozen-contract fit | fits (KEEP_SHARED_WITH_INVARIANTS untouched; `composerUnit` keeps its role) | strains AD-20 §4.3 (priority ladder) and invites a second dispatcher |

**Recommendation: A.** Not because it is smaller, but because the thing being
owned (a list attached to a text field) belongs to the field's owner. The Router
should keep answering *which layer*, not *which widget inside the layer*.

---

## 4. Completion state machine

States: `hidden`, `listed`, `dismissed`.

```
                 draft starts with '/' and items > 0
   hidden ─────────────────────────────────────────────► listed
      ▲   ◄─────────────────────────────────────────────  │
      │        draft no longer '/' , or items == 0        │
      │                                                   │ Esc
      │        draft changes (any edit, paste, history)   ▼
      ├─────────────────────────────────────────────── dismissed
      │                                                   │
      └──────────── draft changes again ──────────────────┘
```

Rules:

- **R1 (enter)** `listed` requires `draft.startsWith('/') && items.length > 0 &&
  dialog === undefined && screen === undefined && lineMode === false`. A Screen
  already swallows the whole read, so the Screen clause is an assertion of the
  existing invariant, not a new rule. `lineMode` is an explicit clause because
  line mode never paints (`writeLineMode` appends to the log) — a completion state
  there would have no renderer and no dismissal path, so it must not exist at all
  (§6, the line-mode row, and P13).
- **R2 (leave)** any draft mutation recomputes `query`; if it differs, `dismissed`
  resets to `false` and the list is `listed` again (a new `/` line is a new
  question).
- **R3 (index)** `index` is clamped into `[0, items.length - 1]` **at derivation**,
  not at paint. A move that would leave the range is a no-op (no wrap: the
  existing list does not wrap, and changing that is not this round's business).
- **R4 (Esc)** `dismissed = true` for the current `query`; Esc does not reach the
  agent-cancel branch while the list is listed (same precedence as today, but the
  scroll/focus branches stay *above* it — B11 is preserved).
- **R5 (accept, Tab)** replace the draft with `/name ` (trailing space), put the
  caret at the end, `dismissed = true`. No submit.
- **R6 (accept, Enter)** Enter **submits** the draft. When the list is `listed`
  and the highlighted name is a byte-for-byte extension of the typed prefix (after
  the `/`), Enter replaces the draft with `/name` first — the existing guard,
  `selected.name.startsWith(this.input.slice(1))`, kept exactly as it is and moved
  into `acceptCompletion`. In every other case Enter submits the literal draft:
  contains-only highlights (`/ag` → `diag`) and case-mismatched ones (`/HELP` →
  `help`) do **not** execute. That visible inconsistency is **DEFERRED** (§2.1 D2),
  not repaired here; the tests in §8.2 P9/P10 pin today's behaviour so a later
  round has to change it deliberately.
  *(Open question O1: should Enter ever complete-but-not-run? See §9.)*
- **R7 (paste)** a paste is a draft mutation like typing (R2). A paste that makes
  the draft folded (`inputFolded`) still lists from the raw draft, and a draft
  containing `\n` never matches a command name, so the list is hidden — asserted,
  not assumed (B14).
- **R8 (reset)** `/clear`, session switch, `clearRows`, and a completed command
  clear the state to `hidden` with `index = 0` and `query = ''`.
- **R9 (locale / host commands)** the derivation key includes the locale and a
  host-command generation. Today there is no generation: `list()` is called per
  paint. W-4B must not add a cache without one (see the perf audit, P2).

---

## 5. Interfaces

### 5.1 With the Router (unchanged)

```ts
// input-router.ts — unchanged
route(kind, unit, view): 'screen' | 'surface' | 'composer' | 'workspace'
```

Invariants W-4B must keep and test:

- **I1** `completion.listed === true ⇒ view.composerEmpty === false`. (A `/…`
  draft is not empty.) Therefore the Router can never send an arrow to
  `workspace` while the list is up.
- **I2** `completion.listed === true ⇒ view.surfaceKind === undefined &&
  view.screenKind === undefined`, and that is enforced by R1, not by the Router.
- **I3** No unit is routed *because of* completion. The Router's inputs do not
  change in W-4B.

### 5.2 With the Surface

- A Surface that is up preempts the list (I2). The list is not painted, its state
  is not consulted, and its `query` is stale until the Surface closes — at which
  point R2 recomputes on the next draft mutation and R1 hides it if the draft no
  longer starts with `/`.
- A Surface with a borrowed field never receives a completion unit: `\t`, `\r`,
  `\x1b` at a Surface go to `handleDialogChar` (`tui.ts:12892`), which is the
  Surface's own contract. **W-4B must not special-case completion there.**

### 5.3 With paint

- Paint reads `completion` and `pickerWindowStart`; it writes **nothing**.
- The 12-row window and the `↑ 还有`/`↓ 还有` markers stay exactly as painted
  today (`tui.ts:6487-6505`); the only change is where the array comes from.
- `captureFrame()` stays the test seam for the window shape.

### 5.4 Derivation and invalidation contract (what W-4B implements)

The state is not a cache with a timeout; it is a **keyed derivation**. One small
holder in the TUI:

```ts
interface CompletionCache {
  key: { draft: string; locale: Locale; agentId: string; revision: number; host: boolean }
  state: CompletionState
}
```

`completion()` reads `getLocale()` (O(1), `i18n/index.ts:74`), the current draft,
the session id, `revision`, and whether `ctx.get('commands')` exists; it compares
those five and recomputes only when one differs. Paint calls `completion()` and
renders it; it never assigns.

A host call that throws must not take the frame down: the derivation catches it,
falls back to the local catalog for that key, and leaves `revision` unchanged (the
next `commands/change` retries). That is one `try`/`catch` and one test (`list()`
throws → the list still paints the local commands, no exception reaches `paint`).

**Triggers and what they invalidate**

| Trigger | Key part | What is recomputed | What must not change |
|---|---|---|---|
| typing / backspace / Ctrl+U / Ctrl+K | `draft` | items + index clamp | history, focus ring, transcript |
| paste | `draft` | items + index clamp | borrowed field (pastes go to the owner the Router named) |
| history browse (↑/↓ with no list) | `draft` | items (a recalled `/…` line lists) | `historyIndex` (it is the browse's own state) |
| Tab accept | `draft`, then `dismissed` | items stay; `dismissed` set | history |
| Esc | `dismissed` only | nothing (the list is not destroyed) | draft |
| `commands/change` (host) | `revision` | localized items | draft, index (clamped), history |
| locale change (`/language`) | `locale` | descriptions | everything else |
| agent / session switch | `agentId` | items (`list(agent)` is per agent) | the new session's own state |
| Screen / Surface opens | none — `listed` is gated | nothing is destroyed | the layer's state |
| Screen / Surface closes | none | the next `completion()` re-reads the same key | draft |
| `/clear`, submit of a command | `draft` | items | rows are the command's business |

**Invalidation source (a real event, not a "generation")**

`@deepseek-ai/dsh-commands` declares the observer event and documents its purpose
(`lib/types/types.d.ts:86` — `'commands/change'(): void`, "A command was
registered or unregistered … so live adapters can refresh discovery"; README:92).
W-4B registers one listener for the TUI's lifetime and bumps `revision`:

```ts
// registered once, disposed with the TUI (same shape as listenHostEvent in dsh-compat)
ctx.on('commands/change', () => {
  this.completionRevision += 1
  if (this.input.startsWith('/')) this.markDirty()   // repaint only if a list could be on screen
})
```

Both supported host lines declare it — checked in the published typings, not
assumed: `@deepseek-ai/dsh-commands@0.2.0-rc.2` and `@0.2.1-rc.2` carry the same
`'commands/change'(): void` in `lib/types/types.d.ts:86`, and both READMEs describe
it as the refresh signal for "live adapters".

`list(agent)` returns *"the effective immutable command descriptors"* (same
typings), so the holder may keep that array until the revision changes; it is
replaced, never mutated, and never copied per paint.

**Conservative fallback when the event is unavailable.** A host that does not
dispatch it, or a test double without `on`, must not leave the list stale forever
and must not fall back to a per-paint query. The
fallback is: bump `revision` on **every draft change**. Bound: a command
registered while a draft is open appears at the next keystroke, never later and
never earlier. That bound is the test boundary (§8.2 P12): with the event, a
registration while the draft is open repaints the list; without it, it appears on
the next draft change and not before.

**Explicitly rejected in W-4B**

- a timer that refreshes the list "just in case" (battery/idle cost for nothing);
- querying `commands.list()` during paint (the current shape);
- a `host generation` field that nothing increments — the revision is only ever
  derived from the event above or from the documented fallback;
- caching the *rendered* rows (the window depends on width and index; `paint.ts`
  already handles that).

### 5.5 With the picker

`pickerWindowStart` is already shared (`paint.ts:564`). The *interaction* model is
not: the session picker has its own guard and its own stepper
(`picker.ts:254 stepPicker`, `:359 actionsForInput`) — the freeze audit records
it as "second router outside the Reader (picker)" debt. Completion must **not**
import that model (it would be a third one); it stays a derived list with
index moves. Reuse is limited to the window math and the paint helpers, on
purpose.

---

## 6. Key ownership matrix

Legend: **CURRENT** = read out of this commit; **PROPOSED** = W-4B target;
**UNVERIFIED** = no test exists today and the claim is an inference from code.

| Input | Completion visible | Completion not visible | Question / Confirm (Surface) | Screen |
|---|---|---|---|---|
| ↑ / ↓ | **CURRENT** moves the highlight (`tui.ts:12803`); history untouched. **PROPOSED** same, via `moveCompletion`. **UNVERIFIED** as a contract (no test) | **CURRENT** empty draft + cards ⇒ workspace focus ring (`input-router.ts:107`); else history (`tui.ts:12807`). **PROPOSED** unchanged | **CURRENT** cursor move / no-op (`ownerSurface`, `dialogs.ts:274`). **PROPOSED** unchanged; completion unreachable (I2) | **CURRENT** Screen's own (`handleScreenInput`). **PROPOSED** unchanged |
| Tab | **CURRENT** accepts: `/name `, list cleared, no submit (`tui.ts:12906`). **PROPOSED** `acceptCompletion`, same text, `dismissed = true` | **CURRENT** inserts two spaces (`tui.ts:12916`). **PROPOSED** unchanged | **CURRENT** `handleDialogChar('\t')` — ignored. **PROPOSED** unchanged | **CURRENT** Screen's own. **PROPOSED** unchanged |
| Shift+Tab | **CURRENT** `ESC[Z` frames as a complete CSI (`read()` → `{kind:'key'}`, `isEscapePrefix('\x1b[Z')` is false), routes as `kind: 'sequence'`: no Screen/Surface ⇒ `composerOrWorkspace` — **composer** for a non-empty draft, **workspace** for an empty draft with cards. Either adapter ignores it (`ownerComposer` has no case → `composerUnit` has no case; `ownerWorkspace` handles only mouse/page/arrows), so nothing happens and the list keeps its highlight. It is **consumed by the owner it was routed to, not dropped by the Reader**. **PROPOSED** no change of default; W-4B adds trace tests for both routes so a later round cannot claim it | **CURRENT** same (ignored by the composer; empty draft + cards ⇒ ignored by the workspace). **PROPOSED** unchanged | **CURRENT** consumed by the Surface: `ownerSurface`'s `unit.startsWith('\x1b[')` branch returns before `composerUnit`, so it never reaches a dialog char. **PROPOSED** unchanged | **CURRENT** consumed by the Screen's own handler (`ownerScreen`). **PROPOSED** unchanged |
| Enter | **CURRENT** completes **and submits** (`tui.ts:14647`); the completion is skipped when the highlighted name is not a prefix extension. **PROPOSED** one call (`acceptCompletion` then `submit`), same observable text, and the non-extension case is asserted. **UNVERIFIED** which the product wants (O1) | **CURRENT** submit; empty draft + answerable question ⇒ answer (`tui.ts:14632`); empty draft + focused card ⇒ toggle (`tui.ts:14639`). **PROPOSED** unchanged | **CURRENT** answers/cancels the Surface (`handleDialogChar('\r')`). **PROPOSED** unchanged | **CURRENT** Screen's own (confirm, dismiss). **PROPOSED** unchanged |
| Esc | **CURRENT** clears the array, but the next frame rebuilds it from the unchanged draft — measured: 12 painted rows before, 12 after, 27 items again — so the list stays visible; and it only runs after scroll (B11) and the focus ring. **PROPOSED** `dismissed = true` persists until the draft changes: **an intentional observable fix** (§2.1 D2b), precedence unchanged | **CURRENT** scroll → focus ring → agent cancel (`tui.ts:14220-14245`). **PROPOSED** unchanged | **CURRENT** filter-clear first, then reject (`tui.ts:14214`). **PROPOSED** unchanged | **CURRENT** closes the Screen. **PROPOSED** unchanged |
| Ctrl+L | **CURRENT** repaint reaches `repaintNow()` (`composerUnit` `\x0c`); KEEP_DUAL stands. **PROPOSED** unchanged, and asserted while the list is up | **CURRENT** same | **CURRENT** routed to `composer` even with a Surface up — the recorded exception (`input-router.ts:90`). **PROPOSED** unchanged (KEEP_DUAL) | **CURRENT** `screenNeedsFullPaint`. **PROPOSED** unchanged |
| Ctrl+N / Ctrl+P | **CURRENT** moves the transcript focus ring; the list is untouched (`tui.ts:12878`). **PROPOSED** unchanged (documented, not "fixed") | **CURRENT** focus ring | **CURRENT** no-op (`dialog === undefined` gate). **PROPOSED** unchanged | **CURRENT** Screen's own |
| Paste | **CURRENT** inserts into the draft; the list updates on the **next paint** (B13). **PROPOSED** the same visible result, but the state is recomputed at the paste (`R2`), so the next key sees the post-paste list — no one-frame window | **CURRENT** composer takes it (Router: paste → composer). **PROPOSED** unchanged | **CURRENT** only a borrowed field (`dispatchPaste` → `surface` → `handlePasteText` → `textIsEditable`). **PROPOSED** unchanged | **CURRENT** `pasteIntoScreen` (setup field only). **PROPOSED** unchanged |
| **line mode** (any of the above) | **CURRENT** no paint runs, so the list never exists; Tab inserts two spaces; ↑/↓ browse history. **PROPOSED** unchanged, and stated as a rule: `listed` requires `lineMode === false` (R1). A completion state in line mode would have no renderer and no dismissal path | **CURRENT** same (no state to show) | **CURRENT** the Surface's own; line mode has no Surface | **CURRENT** the Screen's own |

### 6.1 Edge cases the matrix must be completed with

| Case | Current | Status |
|---|---|---|
| `/` alone | 67 items, 12-row window, aliases withheld (`commands.ts:83`) | CURRENT, painted test |
| Incomplete command (`/se`) | filtered, starts-first ranking | CURRENT |
| Local vs host duplicate (`model`) | local wins, host entry dropped (`commands.ts:85`) | CURRENT, unit test |
| More results than the window | window slides, `↑ 还有` / `↓ 还有` | CURRENT, painted test |
| No matches (`/zzz`) | list empty ⇒ `suggestionsVisible()` false ⇒ Tab inserts spaces | CURRENT (inferred from `length > 0`) |
| Chinese / non-BMP in the draft | `commandSuggestions` compares lowercased names; CJK never matches, so the list hides. Non-BMP input is safe (W-3b.1b) | UNVERIFIED for the completion path |
| Multi-line paste (B14) | draft has `\n` ⇒ no match ⇒ hidden, but `inputFolded` is set | UNVERIFIED |
| Split CSI / released Esc | Reader reassembles; a lone Esc becomes `escape` (`input-reader.ts:releaseHold`) and reaches Esc handling | CURRENT for keys, UNVERIFIED for the list |
| Custom keymap (`pageUp: ctrl+p`) | `KeyAction` has no completion action; a rebound key cannot collide with Tab/arrows | CURRENT by absence |
| line mode (B18) | no paint ⇒ no list; Tab = spaces; ↑ = history. R1 makes it a rule, P13 tests it without ever painting | UNVERIFIED → R1 + P13 |
| Narrow terminal (e.g. 40 cols) | list rows truncated by `fitLine`, window still 12 | UNVERIFIED |
| Resize while listed | paint recomputes the window; index clamped at paint today | UNVERIFIED |
| History browse entering/leaving | `leaveHistoryBrowse()` on typing/paste; the list is rebuilt from the recalled draft | UNVERIFIED |
| After submit / after cancel / after session switch | state resets on the next paint; **no explicit reset** | UNVERIFIED → R8 makes it explicit |

None of these may change a **default key meaning**. The matrix is a description
of what exists plus the smallest set of assertions W-4B has to add.

---

## 7. What W-4B is expected to build (scope)

1. `src/completion.ts`: the state and the pure transitions above (no i18n, no
   paint, no host access — the caller passes items).
2. `tui.ts`:
   - a single `completion()` accessor with the derivation key (§5.4), including the
     `commands/change` listener and the fallback revision;
   - `arrowHistory`, the Tab branch, `submit`, `handleEscape` call it,
   - paint renders it and no longer assigns `commandSuggestions`,
   - removes `commandSuggestions` / `suggestionIndex` as free-floating fields (or
     keeps them as the state's storage with no writer outside the module).
3. Tests: the contract in §8. No keymap change, no Router change, no new owner.
4. No host-list cache beyond the derivation key in §5.4. The list is still queried
   on every draft change (today it is every paint); a cache that survives draft
   changes needs the perf round's invalidation design, and the perf audit (P2-1)
   says to measure the host call first.

### 7.1 Explicitly **not** in W-4B

- No fifth Router owner, no `completionVisible` in `OwnershipSnapshot`.
- No change to Tab's two-space fallback or to Enter's submit semantics.
- No fuzzy matching, no ranking change, no new commands.
- No completion in line mode (R1 excludes it), at a Surface, or in the picker.
- No repair of D2's visibility/execution mismatch: the prefix guard stays, `/ag`
  and `/HELP` keep failing loudly, and the decision is DEFERRED to a product round.
- No rebindable completion keys.
- No `composerUnit` split (KEEP_SHARED_WITH_INVARIANTS stands).
- No new dependency, no version bump in this round.

---

## 8. W-4B test contract

### 8.1 The state fingerprint

Every ownership test asserts this object, not "the final text":

```ts
{
  input, cursor, inputFolded,
  historyIndex, historyDraft,          // history browse must not move
  focusedRow,                          // focus ring must not move unless routed
  scrollOffset,
  completion: { query, visible, index, items: names[] },
  dialog: kind | undefined, screen: kind | undefined,
  rowsAdded,                           // did anything reach the transcript
  borrowedText: text | undefined,      // the Surface's field, if any
}
```

`tests/input-trace.mjs` already records a subset (`snapshot()`), and
`tests/fixtures/input-reader-traces.json` is the reference format. W-4B extends
the snapshot with the `completion` object and adds traces; it must not rewrite
existing traces.

### 8.2 Positive cases

| # | Case | Oracle |
|---|---|---|
| P1 | `/` lists the catalog, 12-row window, aliases withheld | painted frame contains `/disconnect`, not `/exit` |
| P2 | `/se` ranks starts-with first | item order |
| P3 | ↓ × 3 moves the highlight and paints the row | `completion.index`, painted `›` row |
| P4 | Tab accepts: draft `/help `, caret at end, list dismissed | state fingerprint |
| P5 | Enter on `/hel` with `help` highlighted (a prefix extension) | `/help` runs, the draft is cleared, `completion` dismissed |
| P6 | Esc dismisses **and it stays dismissed**: painted rows go 12 → 0 and stay 0 on the next frame (today they come back — §2.1 D2b) | painted rows + `completion.visible` before/after **two** frames |
| P7 | More than 12 results: window slides, markers appear | painted rows (existing test stays green) |
| P8 | Paste of `/mod` lists after the paste, without a paint in between | state fingerprint right after `handleData` |
| P9 | `/ag` highlights `diag` (contains-only) and Enter **refuses** it: the literal `/ag` reaches the unknown-command path (`Unknown command: /ag (try /help)`), `diag` never runs, the draft is cleared. Pins the DEFERRED inconsistency (§2.1 D2) so a later round changes it deliberately | the unknown-command row, no `diag` output, `completion` unchanged |
| P10 | `/HELP` highlights `help` (case-insensitive filter) and Enter **refuses** it: `/HELP` takes the same unknown-command path. Same DEFERRED pin | same |
| P11 | Tab accepts `/hel` → draft `/help `, caret at the end, list dismissed; the next Enter runs `/help` — the accepted text and the executed command agree | draft, caret, command output row |
| P12 | A command registered while the draft is open: with `commands/change` the list repaints on the event; without it, it appears on the next draft change and not before | item list before/after the event, and after one keystroke |
| P13 | line mode: `/` then Tab inserts two spaces, no completion state is created, nothing is painted. Asserted through `handleData` only — the test must not call `captureFrame`, so it cannot accidentally depend on paint | `completion` absent/hidden, draft, `rowsAdded` |

### 8.3 Negative (owner isolation) cases — the ones that matter

| # | Mutation that must be RED | What the oracle observes |
|---|---|---|
| **N1** | Make `arrowHistory` browse history while the list is up | `historyIndex` changes / `completion.index` does not |
| **N2** | Let completion write `borrowedText` (Surface field) | `borrowedText` changes while a dialog is up — must stay byte-identical |
| **N3** | Route an arrow to completion while a Surface is up | `dialog.cursor` does not move, `completion.index` does |
| **N4a** | Keep completion alive across a Screen dismissal **inside one raw read** | the units after the dismissal are discarded by the Screen-owns-its-read contract (`tui.ts:12514` returns when `screenDismissals` changed), so neither the composer nor the list may receive them; `rowsAdded` and `completion.index` unchanged |
| **N4b** | Keep completion alive into **a new read** after the Screen closed | that read is routed again from scratch: the Router sees `screenKind === undefined`, so a `/` draft may legitimately list and an arrow may legitimately move it — assert the *new* state, not a discarded one |
| **N5** | Make Tab also submit | `rowsAdded` increases / `sent` gets a message |
| **N6** | Skip the state reset on submit, and drop `dismissed` so Esc only clears the array (today's behaviour) | after `/help\r` the list is still `listed`; and after Esc the next frame paints the list again (P6 fails) |
| **N7** | Make Ctrl+L take the completion branch | the frame is not a full repaint (`sizeChanged`/clears), i.e. the KEEP_DUAL contract test fails |
| **N8** | Let paint assign the list again (reintroduce D1) | a submit-then-arrow read browses history: `historyIndex` moves, `completion.index` does not |
| **N9** | Let completion write `inputFolded` | the folded flag changes without a draft change |
| **N10** | Accept the highlighted name on Enter even when it is not a prefix extension | the submitted text is not the draft the user typed (today's guard fails) |

Each mutation is a deliberate one-line break in `lib/` (the pattern the 0.8.4
round used for the paste probe), run against the suite; the round is only done
when every one of them turns a named test red.

### 8.4 Baselines

- **State baseline**: the fingerprint for ~12 scripted sequences, recorded from
  the **pre-W-4B** build and stored beside the traces, so a difference is a
  decision on the record (the `GAP_FIXTURES` pattern from W-3a).
- **Paint baseline**: `tests/helpers.test.mjs:646` (window) stays byte-identical;
  `bench:report --check` must not move its counts.
- **Freeze baseline**: `scripts/input-freeze-audit.mjs` must stay at
  `pasteFraming 0`, `routers 1`, `dispatchers 1`, `deadScreenGate 0`; W-4B adds
  no router and no dispatcher.

### 8.5 Platform boundary

- **Linux PTY**: arrow/Tab/Enter/Esc with the list up, plus a real paste that
  opens it. `scripts/tui-probe.mjs` already drives `/` + typing; W-4B adds one
  step, not a new probe.
- **Windows ConPTY**: the same keys, with the frame-shape assertions standing
  down (the existing `PTY_IS_CONPTY` convention). Completion is host-line
  independent; the risk there is input framing, which the paste probe covers.
- **No PTY at all** (stdio/desktop): completion must not exist, and must not
  crash — `tui-stdio-probe.mjs` stays green.

---

## 9. Open questions for the independent gate

| # | Question | Default if unanswered |
|---|---|---|
| **O1** | Should Enter on a listed suggestion *complete* the command into the draft (second Enter runs it), or keep today's complete-and-run? | Keep today's behaviour; W-4B only makes the conditional explicit |
| **O2** | Should Shift+Tab ever mean "previous suggestion"? Today it is ignored entirely. | No: adding a key meaning is a separate decision with its own matrix row |
| **O3** | Should the list survive a transcript scroll (B11)? Today scroll wins and the list survives underneath. | Keep; a scroll is not a dismissal |
| **O4** | Should `/` + paste of a whole command line auto-accept? | No; paste is text (W-3 rule), and auto-accept would be a new submit path |
| **O5** | Is the `suggestionIndex` clamp at derivation enough, or does a shrinking list need to reset the index to 0? | Clamp (R3); reset only on query change |

---

## 10. Gate entry requirements (what "ready" means)

1. This document reviewed; O1–O5 answered or explicitly deferred.
2. The matrix in §6 has no `UNVERIFIED` cell that W-4B claims to *change* — a
   changed cell needs a test in the same commit.
3. The mutation list in §8.3 is accepted as the definition of "the ownership is
   real", not "the text looks right".
4. No new Router owner, no `completionVisible` in the snapshot, no keymap change
   (§7.1) unless the gate says otherwise.
5. The perf audit's P2 (host `commands.list()` per paint) stays out of W-4B; if
   the gate wants it, it is a separate round with its own invalidation design.
   (The §5.4 keyed derivation is not that cache: it recomputes on a draft change,
   which is what the current code already does per paint, and it removes the
   paint-time write.)
6. D2 stays DEFERRED: no W-4B commit may claim Enter's highlight/execution
   mismatch is fixed, and P9/P10 stay in the suite as the pinned behaviour.

---

## 11. What this round did not do

- No source, test, script, manifest, lockfile or workflow change.
- No behaviour change **in this round**: the matrix's CURRENT column is descriptive.
  W-4B itself will change two observable things on purpose — Esc starts dismissing
  the list (§2.1 D2b) and the list stops being rebuilt during paint (D1) — and
  will **not** change Enter's refusal of a contains-only or case-mismatched
  highlight (D2, DEFERRED).
- No implementation of W-4B, W-5, W-6 or W-7.
- No merge to `main`, no tag, no release, no publish.
