# W-5A — Search Screen ownership & interaction contract

> **Status: design / baseline audit. W-5B now implements the defaults below.**
> **W-5B.1 repair:** grapheme-boundary cursor/delete, display-cell field
> scrolling, wrapped-display-line Preview navigation, and original
> `visibleRows()` ordinals with nearest-ordinal fallback.
> **W-5B implementation:** `src/search-screen.ts`, `ScreenKind 'search'`, the pure
> renderer and the probes. This document remains the contract, not a runtime file.
> Baseline: gated W-4B HEAD `4fa570f662c2ac100088cc4b8d9156153b0c2825`
> (`main` `83a8c7e`; CI run `39270205580`, all four Linux/Windows jobs PASS).
> Branch: `agent/w5a-search-screen-design`.

`/find` becomes a dedicated Search Screen in framed mode. It keeps the existing
local scope: only rows that survive the current `/clear` cutoff are searched. It does
not read the durable session log, cross `/clear`, or survive a process restart. This
requires one explicit product amendment:

> **AD-9-local amendment proposal:** local `/find` moves from a Workspace
> Surface/feedback path to a Dedicated Search Screen over the same visible-workspace
> scope. Historical search over the durable session log remains separate and future.
> The scope boundary in AD-9 is unchanged.

If this amendment is rejected, W-5B must not add a Screen; the contract stops here.
Line mode keeps its current textual search behavior and never composes a Screen.

---

## 1. Current source behavior and risk inventory

### 1.1 Facts read from HEAD `4fa570f`

| Fact | Source |
|---|---|
| `/find` is a composer command | `runCommand()` → `case 'find'` → `runFindCommand()` (`src/tui.ts`) |
| Search state is workspace-global | `searchHits`, `searchIndex`, `searchQuery`, `searchNeedle` (`src/tui.ts`) |
| Parser and matcher are pure | `parseFindQuery()`, `matchTranscriptRows()` (`src/plan.ts`) |
| `/find` is in the local command catalog | `LOCAL_COMMANDS` (`src/commands.ts`); the UI behavior is the `runCommand` case above |
| Scope is the visible transcript | `[...this.visibleRows()]`; `visibleRows()` drops rows before `clearedRows` |
| `/clear` resets search | `clearedRows = rows.length; searchHits = []; searchIndex = -1; searchQuery = ''` |
| A hit is revealed in the workspace | `revealRow()` scrolls/focuses/expands, and may open Inspect/Subagent for a hit |
| Newest hit is selected | `applySearchHits()` sets `searchIndex = hits.length - 1` |
| Stepping wraps | `stepSearch()` uses `(index + delta + count) % count` |
| Alt+n/p step search globally | `route()` Alt branch → `stepSearch(±1)` |
| Ctrl+G steps search | `composerUnit('\x07')` → `stepSearch(1)` |
| Alt+f/F// seed the composer | `route()` writes `this.setDraft('/find ', 6)` |
| A Screen owns its whole read | `InputRouter.route()` returns `screen` first; `handleScreenInput()` |
| Reader owns framing/paste/hold | `InputReader.units()`, `framePaste()`, `hold()` and `onFrame` (`src/input-reader.ts`) |
| Report/Inspect reveal uses global search | `paintScreen()` checks `screen.searchRevealed` and `searchNeedle` |
| Screen body is wrapped at paint | `renderScreenBody()`; `ScreenState.lines` is logical text state |
| Screen copy uses `screen.copyText` | `moved === 'copy'` → `copyFromScreen()` |
| Screen depth is one, replacement only | `openScreen()`, `tests/screen-contract.test.mjs` |
| Transcript is bounded at 5000 rows | `MAX_TRANSCRIPT_ROWS`, `boundTranscriptRows()` (`src/rows.ts`) |
| Delayed input keeps the layer instance | `heldInput`, `consumeReleasedFrame()` (W-4B.0b) |
| The 30 ms reply guard is separate | `INPUT_HOLD_MS = 30` (`src/terminal-input.ts`), still OPEN |

### 1.2 Current observable behavior

1. `/find deploy` scans visible rows, pushes a `find-feedback` transcript row,
   selects the newest match and calls `revealRow()`.
2. `revealRow()` may scroll/expand the workspace, set `focusedRow`, or open an
   Inspect/Subagent Screen for a truncated tool or subagent. `/find` can therefore
   create a Screen today.
3. `↑/↓` steps the global hit list when it exists; otherwise it falls to history,
   focus ring or workspace. `Alt+n/p` and `Ctrl+G` call `stepSearch`.
4. `/find` with no argument treats the empty query as all searchable categories
   (`thinking`, `plan`, `subagent`, `reply`). A non-empty query can hit any row with
   a `cardCategoryOf()` value, including `tool`, `question`, `goal`, `prompt`.
5. A category token (`/find tool …`) filters that category; the highlight needle is
   the part after the category.
6. A miss pushes `find.noMatch`/`find.none`; if `/clear` hid content it also shows
   `find.scopeHint`.
7. `Alt+f` seeds `/find ` in the composer; it does not open a Screen. In line mode
   this is the only path.
8. `find-feedback` is a transcript row in framed and line mode. Framed `/find`
   therefore writes narrative rows for an operation (debt under AD-7/AD-13).
9. `paintScreen()` uses the global needle/hits to reveal a match inside a report or
   inspect body once (`searchRevealed`). It is a separate behavior and must not be
   conflated with the Search Screen's hit list.
10. `ScreenState` has `{kind,title,lines,offset,...}`: no text field, no result
    list, and one body scroll offset. Setup has a private field; reports do not.

### 1.3 Risk inventory

| Risk | Why it matters | W-5A response |
|---|---|---|
| R1 two search truths | A Screen-local hit list plus global `searchHits` can disagree | Search state is authoritative while the Screen is open; global fields remain only for line mode/legacy report reveal |
| R2 reveal opens a second Screen | `revealRow()` can open Inspect/Subagent from a hit | Search preview is read-only inside the same Screen; no `revealRow()` |
| R3 stale row refs | Rows are object references; trim removes them; tool output mutates them | Hits store refs + ordinals; reconcile against a transcript revision before use |
| R4 no revision boundary | No counter says the transcript changed | W-5B adds one explicit `transcriptRevision`; one-shot coalesced reconciliation, never per paint |
| R5 no Screen field | `ScreenState` has no editable line | Search state owns its field and caret; no `borrowedText`, no hidden composer |
| R6 Screen hides cursor | `paintScreen()` always sets `hideCursor:true` | Search branch places the caret; report/setup/inspect unchanged |
| R7 q/Enter close reports | `inspectClosesOn()` closes report/inspect on q, Enter, Ctrl+C, Esc | Search branch runs earlier; q/Enter are field/list keys, Esc/Ctrl+C close |
| R8 copy mutates workspace | Copy paths previously cleared the composer (G-10) | Copy only `screen.copyText`; never `copyFocusedCard` or workspace selection |
| R9 delayed frames | A held Esc/paste can arrive after Search closed | Keep `held.screen` object identity; Search close increments `screenDismissals`; no Reader API change |
| R10 full repaint per query | Weak links and 1 vCPU cannot afford a clear per key | Derived body rows through `composePaintFrame`; only Ctrl+L explicitly clears |
| R11 unbounded memory | 5000 hits × full text is unnecessary | Hits are refs + ordinals; only visible page and selected preview are formatted |
| R12 `/clear` ambiguity | Current search can outlive a cutoff | Always search `visibleRows()`; reconcile on cutoff/revision; no `/clear` from a Screen's keyboard |

---

## 2. Search Screen state model

### 2.1 Authoritative state

```ts
export interface SearchHit {
  readonly row: Row          // identity, not a copy
  readonly ordinal: number   // position in visibleRows() at materialization
}

export interface SearchScreenState {
  query: string              // field text, including spaces
  cursor: number             // caret in UTF-16 units
  category?: CardCategory    // fixed by /find [category]; undefined = all
  hits: readonly SearchHit[]
  selected: number           // -1 = no selection
  listOffset: number         // first visible result row
  mode: 'list' | 'preview'
  previewOffset: number      // read-only preview scroll
  revision: number           // transcriptRevision used for hits
  sourceCutoff: number       // clearedRows used for hits
  notice?: string            // Screen-local message; never a transcript row
}
```

`ScreenState` gains only in W-5B:

```ts
interface ScreenState {
  kind: 'inspect' | 'report' | 'setup' | 'search'
  // …
  search?: SearchScreenState   // present exactly when kind === 'search'
  copyText?: string            // selected hit/preview text, derived on transitions
}
```

`ScreenState.lines`/`offset` remain the report/inspect/setup source. A Search Screen
does not use them; its renderer derives rows from `search`. There is one Screen and
no stack.

### 2.2 Pure transitions

W-5B adds `src/search-screen.ts`, with no I/O and no paint:

```ts
searchScreenFor(input: {
  query: string
  cursor?: number
  category?: CardCategory
  rows: readonly Row[]
  revision: number
  cutoff: number
  previous?: SearchScreenState
}): SearchScreenState

setSearchQuery(state, query, cursor): SearchScreenState
moveSearchSelection(state, delta): SearchScreenState
pageSearchSelection(state, page): SearchScreenState
openSearchPreview(state): SearchScreenState
closeSearchPreview(state): SearchScreenState
reconcileSearchHits(state, rows, revision, cutoff): SearchScreenState
```

Rules:

- Empty query lists all `SEARCHABLE_CATEGORIES`, preserving today's `/find` no-arg.
- A non-empty query calls `matchTranscriptRows(rows, query)`; category filters the
  same way as today.
- `selected` clamps to `[-1, hits.length - 1]`; a new non-empty result starts at the
  newest hit (today's behavior) unless a previous selected row survives.
- Selection is preserved by row object identity. If the row disappeared or no
  longer matches, select the nearest surviving hit by its old ordinal; if none,
  `selected = -1`, `mode = 'list'`, zero-hit state.
- `listOffset` keeps `selected` visible and is clamped to the last page.
- `revision`/`sourceCutoff` mismatch means hits are stale; reconcile before the next
  render or input decision. Stale hits are never painted as current.
- `mode='preview'` is a detail mode inside the same Screen; it never opens
  Inspect/Subagent and never pushes a second Screen.
- `copyText` is selected hit text (list) or preview body (preview). It is never the
  hidden composer draft or a workspace selection.

### 2.3 Matching

Reuse exactly `parseFindQuery()`, `matchTranscriptRows()`, `searchContains()` and
`highlightAnsiNeedle()`. No fuzzy matching, no ranking change, no second matcher.
The category token is parsed on entry; the field edits only the query.

### 2.4 Hit snippets and memory

`SearchHit` stores a row reference only. The renderer formats the visible page on
demand: reply/thinking text, tool title+summary, subagent label+activity, plan/goal/
question/prompt/changes labels. Only the selected preview is materialized as text
for `copyText`. Memory is `O(hits)` references, not `O(transcript bytes)`.

---

## 3. Input Owner matrix

`Owner` stays `screen | surface | composer | workspace`. Search is a Screen; no
fifth owner, no `completionVisible`, no snapshot field, no second router. `Ctrl+L`
keeps the existing Surface/Composer exception and the Screen full-repaint path.

### 3.1 `handleScreenInput` order (W-5B)

| Order | Rule | Behavior |
|---|---|---|
| 1 | `\x0c` Ctrl+L | Screen full repaint; no state change |
| 2 | `looksLikePasteBurst` | paste into Search field; no submit |
| 3 | bracketed paste frame | paste into Search field; CR/LF normalized to spaces |
| 4 | `screen.kind === 'search'` | `handleSearchScreenKey`; it handles its own copy key, then returns |
| 5 | `screenSurface` | unchanged; Search has no Screen Surface |
| 6 | `moved === 'copy'` | report/inspect only; Search handled it |
| 7 | mouse | wheel scrolls list/preview; press/drag/release ignored |
| 8 | generic arrows/pages | report/inspect only |
| 9 | `inspectClosesOn` | report/inspect only |
| 10 | printable hint | Search field handles printables; reports unchanged |

### 3.2 Search keys

| Input | List mode | Preview mode |
|---|---|---|
| printable text / Unicode | insert at caret, rerun query | ignored |
| ← / → | move field caret by grapheme | ignored |
| Home / End | field start/end | preview top/end |
| Backspace / Delete | edit field, rerun | ignored |
| Ctrl+A / Ctrl+E | field start/end | ignored |
| Ctrl+U | clear field, rerun empty query | ignored |
| Ctrl+K | delete to end, rerun | ignored |
| ↑ / ↓ | previous/next result; no history/workspace | preview scroll one line |
| PgUp / PgDn | previous/next result page | preview page |
| Alt+n / Alt+p | next/previous result, wrapping | next/previous result, update preview |
| Ctrl+G | next result | next result, update preview |
| Enter | preview selected hit | return to list |
| Esc | close Search, return workspace | return to list |
| Ctrl+C | close Search | close Search |
| q / Q | text in field | ignored |
| Tab / Shift+Tab | no-op (no completion in a Screen) | no-op |
| Ctrl+N / Ctrl+P | no-op (workspace focus ring inaccessible) | no-op |
| Ctrl+L | full Screen repaint | full Screen repaint |
| copy key | copy selected hit | copy preview body |
| mouse wheel | scroll list, selection unchanged | scroll preview |
| mouse click/drag | ignored | ignored |
| unknown CSI | consumed | consumed |
| paste | insert, no submit | ignored |
| line mode | no Search Screen; legacy text path | — |

`q`/`Q` are field text, not close keys. Esc (list) and Ctrl+C close; Preview Esc
returns to the list. Search has no composer, borrowed field or completion.

### 3.3 Composer / Surface isolation

- Search field state is only in `ScreenState.search`; `this.input`, `borrowedText`,
  `historyIndex`, `historyDraft`, `focusedRow` and `scrollOffset` are never written.
- A Search Screen is a Screen: Router sends all keys to it; a Surface waits in the
  workspace queue and opens after Search closes.
- Completion is a Composer subsurface; it is hidden/unreachable behind a Screen.
- Wheel scrolls Search only; click/drag is ignored (G-5 remains OPEN; Search does
  not invent a second selection model).
- Copy is `screen.copyText` through the existing Screen copy path; it never touches
  workspace selection, focus or history.

---

## 4. Entry and key flows

### 4.1 `/find`

```
runCommand('find'):
  lineMode → legacyTextFind(arg)       // existing textual rows
  else     → openSearchScreen(parseFindQuery(arg))
```

- `/find` → empty field, all searchable rows, newest selected.
- `/find deploy` → field `deploy`, matching hits, newest selected.
- `/find tool deploy` / `/find 回复 deploy` → fixed category chip + field query.
- Framed `/find` pushes no `find-feedback` row; the list/count is feedback.
- Line mode keeps the textual `find-feedback` path and does not open a Screen.
- The composer draft is consumed by `runCommand`; the Search field is separate and
  never seeded from the cleared draft.

### 4.2 Alt+f / Alt+F / Alt+/

- Framed workspace: open Search with an empty field, no category; do not write
  `/find ` into the composer.
- Framed Report/Inspect: `handleScreenInput` sees the Alt chord before generic
  branches and replaces the Screen with Search. No stack; Esc returns to workspace.
- Search Screen itself: no-op; do not replace/recurse.
- Line mode: keep the `/find ` composer seed.
- Surface: preserve W-3b.3a; no hidden composer seed behind a Surface.

### 4.3 Alt+n / Alt+p / Ctrl+G

- Search open: next/previous hit, wrapping. Ctrl+G is next.
- Framed, no Search, last search exists: reopen at last query/category and move by
  the delta. Recompute hits; never reuse stale refs. TUI keeps only
  `lastSearch = {query, category, ordinal}` — an ephemeral pointer, not a hit list;
  it does not survive process restart.
- Framed, no last search: open Search empty and select newest/first by direction.
- Line mode: keep legacy `stepSearch`.
- Alt+n/p never move the workspace focus ring while Search is open.

### 4.4 From Report/Inspect

There is no composer at a Screen, so `/find` cannot be typed there. Alt+f/F// is the
explicit entry; it replaces the current Screen (depth one, no stack). The previous
report/inspect is not restored on Esc; workspace state behind is untouched. OPEN-2
records this as the default versus "ignore at a Screen" or "remember/restore one
return screen".

---

## 5. Rendering contract

### 5.1 Body layout

Inside `screenLayout`:

```
title/divider     existing Screen chrome
field row         › <query with caret>
status row        category · hits N · i/N · mode hint
result page       one row per hit, clipped
preview page      mode=preview: read-only wrapped body
hint row          Esc/Enter/Alt+n/p/copy hints
strip row         existing compact runtime strip
```

- Field visible when `bodyRows > 0`; at tiny heights it is the last body row kept.
- List mode: one row per hit, prefix/index/snippet, no wrapping.
- Preview: wraps at inner width, own `previewOffset`.
- Zero hits: `find.noMatch`/`find.none`; `find.scopeHint` when `clearedRows > 0`;
  field remains editable and Enter reruns.
- Count uses hits only; no transcript row.

### 5.2 Cursor

Search sets `hideCursor:false` and cursor at the field row/column:
`prompt width + displayWidth(text before cursor)`. Report/inspect/setup keep their
existing hide-cursor behavior. Long queries clip/scroll horizontally; the caret
stays visible. Width changes recompute the cursor and clamp, no state loss.

### 5.3 Incremental paint

State transitions call `markDirty()`; the normal cadence paints. `paintScreen` uses
`composePaintFrame`; field/list changes only touch changed body rows. Ctrl+L uses
`screenNeedsFullPaint`, exactly the existing Screen path. Opening/resize/reattach may
clear once; no clear per query. The runtime strip remains the last row.

### 5.4 Unicode

Use `displayWidth`/wrap helpers; never slice UTF-16 for display. Caret movement and
deletion use code points/graphemes like the composer. Matching uses the existing
case-insensitive `searchContains`. Tests include CJK and astral characters.

---

## 6. Lifecycle contract

### 6.1 Open

- `openSearchScreen()` calls the existing `openScreen()` exclusive path; it never
  enters `dialogQueue`.
- Workspace state that must survive is not copied/reset: `input/cursor`,
  `historyIndex/historyDraft`, `focusedRow`, `scrollOffset`, `clearedRows` remain
  untouched.
- `screenDismissals` is not incremented on open; replacement is not a dismissal.
- Opening clears once (existing Screen policy), then incremental.

### 6.2 Close

- Esc/Ctrl+C → `closeScreen()`: increments `screenDismissals`, clears the Screen,
  shows the next queued Surface, repaints workspace once.
- Workspace was never changed, so no restore copy is needed. This is stronger than
  restore and keeps AD-2/AD-17.
- No Inspect/Subagent opens from a hit; preview was read-only. OPEN-3 decides whether
  an explicit "reveal in workspace" action should exist.
- `/clear` cannot run while Search owns input; a programmatic cutoff change is
  reconciled against `visibleRows()`. Hidden rows disappear from hits; zero state
  and scope hint apply.

### 6.3 Depth / replacement

| From | Open Search | Esc |
|---|---|---|
| Workspace | replaces workspace view | workspace, original state |
| Report | replaces report | workspace; report not restored |
| Inspect | replaces inspect | workspace; inspect not restored |
| Search | no-op | — |
| Surface | cannot open while Screen active | — |

Exactly one `ScreenState`; no stack. This is the same replacement rule as `/help`
replacing `/status`. A "return to previous screen" feature would require one saved
return screen, not a stack, and is not in W-5B.

### 6.4 Reattach

- `detachDisplay()`/`attachRelayDisplay()` preserve `screen` and reset paint caches.
  Search query/cursor/hits/selected/offsets/mode live in that state, so reattach
  redraws the same view; first frame may clear, next incremental.
- Hits reconcile against current rows after reattach; removed rows follow the normal
  revision path.
- Process exit/resume does **not** restore Search; it is ephemeral like report and
  inspect (AD-7). Only same-process relay reattach is in scope (OPEN-4).

### 6.5 Async input

- Keep `heldInput {owner, screen, dialog}`. A released Esc/paste after Search closes
  is dropped by `held.screen !== layerScreen` identity; it cannot type into the field
  or composer.
- Search close increments `screenDismissals`; the rest of the raw read is discarded
  by the existing rule. A new read routes from scratch.
- `TerminalInputGuard` 30 ms source attribution remains independent OPEN; no Reader
  API/hold-window change.
- Pastes spanning reads stay with the Screen instance from the first read; closing
  mid-paste triggers the stale-layer rule.

---

## 7. Compatibility table

| Current | W-5B | Classification |
|---|---|---|
| `/find deploy` writes `find-feedback`, moves workspace | Search Screen; no transcript row; workspace unchanged | intentional (OPEN-1) |
| `/find` empty lists all searchable, newest selected | same hit set in Screen | preserve |
| `/find category query` filters and highlights | fixed category chip + field query, same matcher | preserve semantics |
| Hit may open Inspect/Subagent via `revealRow` | read-only preview in Search | intentional depth fix |
| ↑/↓ steps global hits | ↑/↓ moves Search selection | preserve meaning, new owner |
| Alt+n/p/Ctrl+G wrap hits | same in Search; outside framed reopens last query (default) | behavior change outside; OPEN-6 |
| Alt+f seeds `/find ` | framed opens Search; line mode seeds | intentional framed change |
| Esc no search meaning | preview→list→workspace | new Screen |
| Enter submits `/find` from composer | Search: preview selected hit | new Screen |
| q/Q close report | q/Q field text in Search; Esc/Ctrl+C close | Search-only change |
| Copy Screen body | copy selected hit/preview | copy isolation preserved |
| `/clear` clears global hits | Search unavailable while Screen; programmatic cutoff reconciles visible rows | AD-4 scope preserved |
| Reattach preserves report/inspect | Search state preserved too | extension |
| Resume restores report? no | Search also ephemeral | preserve |
| line mode textual `/find` | unchanged | preserve |
| `find-highlight` workspace assertions | migrated to result/preview highlight; pure matcher/highlight unchanged | test migration |

Only OPEN-1 changes a frozen classification. The rest are interaction changes
required by the Screen.

---

## 8. Positive test matrix (W-5B)

| ID | Case | Oracle |
|---|---|---|
| S-P1 | `/find deploy` | Screen `search`; field; hits; newest selected; no `find-feedback`; workspace snapshot identical |
| S-P2 | `/find` empty | all searchable, newest; no transcript row |
| S-P3 | `/find tool deploy` / `/find 回复 deploy` | category filter + query; same matcher result |
| S-P4 | typing/backspace/Delete/Ctrl+U/Unicode | field/caret/query update; composer/history/borrowed unchanged |
| S-P5 | multiple field units in one raw read | final state correct; one matcher run per burst, not per char |
| S-P6 | ↑/↓, PgUp/PgDn, Alt+n/p, Ctrl+G | selection/clamp/wrap; history/workspace focus unchanged |
| S-P7 | zero hits | noMatch/none; selected -1; Enter reruns; no crash |
| S-P8 | Enter hit / Esc preview | preview in same Screen; no Inspect; copyText is preview |
| S-P9 | copy in list/preview | yank = selected hit/preview; draft/history/focus/scroll unchanged |
| S-P10 | long/narrow/CJK/emoji | caret visible; clip/wrap by display width; no overflow |
| S-P11 | reattach | field/query/selection/offset/mode survive; first full, next incremental |
| S-P12 | new matching row while open | revision refresh adds it without a key; selection preserved/clamped |
| S-P13 | row updated/trimmed/removed | hit refreshed/removed; nearest selected; zero state if none |
| S-P14 | line mode `/find` | textual rows, no Screen, no completion |
| S-P15 | stdio pipe | `/find`, query, arrows, preview; one-write and split |
| S-P16 | Linux PTY / Windows ConPTY | same keys; Windows pending until CI |
| S-P17 | Report/Inspect → Alt+f | Search replaces; one Screen; Esc workspace |
| S-P18 | paste newlines/unknown CSI/split CSI | normalized/no submit; consumed; composer untouched |
| S-P19 | resize | selection/offset/caret clamp; strip survives; no per-key clear |
| S-P20 | copy then close | workspace exact pre-open |

## 9. Negative / mutation matrix

| ID | Invariant | Mutation that must be RED |
|---|---|---|
| S-N1 | Search writes no transcript row | `openSearchScreen` pushes `find-feedback`; S-P1/P2 fail |
| S-N2 | Search writes no composer/history | field keys use `setField`/`setDraft`; S-P4/P20 fail |
| S-N3 | Search writes no borrowed Surface field | route field keys to `setField` at Surface; isolation fails |
| S-N4 | Search moves no workspace focus/scroll | call `revealRow`/`scrollWorkspace`; S-P1/P6 fail |
| S-N5 | Search opens no second Screen | Enter calls `openToolInspect`; S-P8/P17 fail |
| S-N6 | depth one | allow a Search behind/above report; depth test fails |
| S-N7 | Esc close ends the read | remove `screenDismissals` tail drop; delayed input types |
| S-N8 | Alt+n/p do not use workspace history/focus | move focus from Search; S-P6 fails |
| S-N9 | copy is read-only | use `copyFocusedCard`; draft/history changes, S-P9 fails |
| S-N10 | paint never matches/recomputes | call `matchTranscriptRows` from paint; S-P5/no-paint fails |
| S-N11 | no stale hits after trim/update | skip reconciliation; S-P13 fails |
| S-N12 | field never borrows Composer | point fieldText at `this.input`; S-P4/P20 fail |
| S-N13 | no full clear per query | force `screenNeedsFullPaint` per key; byte test fails |
| S-N14 | line mode stays text | open a Screen in line mode; line test fails |

Keep W-4B completion tests, W-4B.0b held-input tests, `screen-contract`,
`ctrl-l-repaint`, `input-ownership-regression`, and `find-highlight` in the suite;
migrate framed `/find` assertions, never delete them.

---

## 10. W-5B implementation split

1. `src/search-screen.ts` — pure state/reducer, matcher adapter, unit tests.
2. Screen type/renderer — add `ScreenKind 'search'` only after OPEN-1; `ScreenState.search`,
   pure renderer, field/list/preview/caret/Unicode; Screen contract tests.
3. Entry — framed `/find`, Alt+f/F//, report/inspect replacement, last-search reopen;
   line mode legacy.
4. Input — field editor, paste, CSI, preview/list keys, copy; no borrowed field.
5. Revision/lifecycle — `transcriptRevision` on append/update/trim/clear, one-shot
   reconciliation, selected-row migration, reattach.
6. Copy/preview — read-only `screen.copyText`; no workspace selection.
7. Evidence — `tests/search-screen.test.mjs` P/N, migrated `find-highlight`, stdio/PTY
   probes, Windows CI, docs.

First commit is RED (Screen and search state absent); second makes it green. No W-5B
change may alter Router/Owner union, Reader API, keymap defaults, completion, setup,
or APPR.

---

## 11. OPEN product decisions / defaults

| ID | Question | Default | Alternative |
|---|---|---|---|
| OPEN-1 | AD-9 local: Surface or Search Screen? | amend to Search Screen, scope unchanged | stay Surface; contract invalid |
| OPEN-2 | Alt+f at Report/Inspect | replace (depth one) | ignore; Esc first |
| OPEN-3 | Reveal selected hit on close? | no mutation; exact workspace restore | scroll/focus hit on close |
| OPEN-4 | Restore Search after process resume? | no; reattach only | durable historical screen (future) |
| OPEN-5 | Empty/whitespace query | empty lists all searchable; trim for matching | no search |
| OPEN-6 | Alt+n/p with no open Search | reopen last query and step | no-op / legacy workspace |
| OPEN-7 | Live vs Enter-to-apply | live per input burst | Enter-only |
| OPEN-8 | Tab in Search | no-op | insert spaces/focus results |
| OPEN-9 | Home/End | field caret | result first/last |
| OPEN-10 | Drag selection in Search | no; G-5 remains OPEN | read-only Workspace selection |
| OPEN-11 | q/Q in Search | field text; Esc/Ctrl+C close | pager-style close |
| OPEN-12 | Last query across `/clear` | query text persists; hits recompute | clear last query |

Defaults preserve existing matching/scope and AD-2/AD-17. A gate may change a default,
but W-5B must implement the recorded choice; paint does not decide it.

---

## 12. Performance and platform acceptance

### 12.1 Boundaries

- Hits: at most `MAX_TRANSCRIPT_ROWS` references; no full transcript copy; only the
  visible page/selected preview is formatted.
- Matcher: `O(visible rows)` per query burst or revision, never per paint/idle tick.
- Transcript updates may be coalesced by one one-shot invalidation while Search is
  open; cancel on close/dispose. No interval, no polling, no per-frame scan.
- Frame: changed body rows only; Ctrl+L is the explicit full repaint, preserving
  `ctrl-l-repaint`/KEEP_DUAL.
- No new dependency; no `commands.list()` in search paint.

### 12.2 Measurement plan (1 vCPU / 1 GB, 100–300 ms RTT)

Record, do not invent improvement percentages:

- 5,000-row workspace, query lengths 1/4/16, CJK+emoji, 100×30 and 40×20: matcher
  wall time median/p95, heap after open/query/close;
- per-query frame bytes/rows/clears (0 clears after opening), `paintResume` budget;
- reattach: first may clear, second incremental;
- PTY RTT 100/300 ms: input-to-field latency, scroll bytes, no unbounded queue;
- stdio one-write/split-write; Windows ConPTY same key contract, frame-shape
  assertions per existing `PTY_IS_CONPTY` convention;
- line mode textual path unchanged.

### 12.3 Platform

| Platform | Acceptance |
|---|---|
| Linux PTY | `/find`, type, arrows, Alt+n/p, Page, Enter preview, Esc, copy, reattach |
| Windows ConPTY | same contract; CI receipt required, else PENDING |
| stdio pipe | full TUI field/list/preview, one-write and split |
| line mode | textual `/find` only; no Screen/completion |
| no terminal | plugin inert; existing launch guard |

`TerminalInputGuard` 30 ms source attribution remains OPEN; D2 remains DEFERRED;
APPR is out of scope. No runtime, Reader, Router, keymap, paint, completion, setup or
APPR change occurred in W-5A.

---

## 13. Gate questions

1. Accept OPEN-1 (AD-9 local becomes a Search Screen with unchanged visible scope)?
2. Accept OPEN-2 (replace Report/Inspect; Esc returns workspace)?
3. Accept OPEN-3 (no workspace reveal on close) or require reveal/return?
4. Accept OPEN-4 (reattach yes, process-resume no)?
5. Confirm field semantics: q/Q text, Tab no-op, Esc/Ctrl+C close (OPEN-7/8/11)?
6. Confirm copy is read-only selected hit and G-5 drag remains OPEN?
7. Confirm the P/N matrix and W-5B split; no runtime code in W-5A.
