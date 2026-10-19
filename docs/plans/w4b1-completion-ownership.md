# W-4B.1 — Composer-owned completion (implementation)

> **Status: implemented on `agent/w4b1-completion-ownership`, based on the gated
> W-4B.0 HEAD `6f139aa`.** The ownership design is
> `docs/plans/w4a-completion-ownership.md`; the executable before/after baseline
> is `docs/plans/w4b0-completion-baseline.md`.

## State

`src/completion.ts` is the only owner of the completion state:

```
CompletionState {
  phase: hidden | listed | dismissed
  query, items, index, dismissedFor, visible
}
```

`completionFor()` derives the state from a draft, already-built items, the previous
state, layer presence and line mode. `moveCompletion()` clamps without wrapping;
`acceptCompletion()` implements Tab and Enter's preserved prefix guard;
`dismissCompletion()` records the exact draft; `resetCompletion()` returns a fresh
empty state. There is no second `suggestionIndex`.

## Materialization

`SshTui.refreshCompletion()` is the one writer. It queries
`commands.list(agent)` only when the key

```
draft \0 locale \0 agentId \0 commands/change revision \0 host presence
```

changes, and it recomputes the cheap local derivation on every call so Screen/Surface
close and dismissal are not lost. It is called by:

- `setDraft()` (the only draft writer; `setField()` delegates when the composer owns
  the field);
- the read boundary before every frame and once after the read;
- `consumeReleasedFrame()` for late Esc/paste frames;
- `commands/change` (bump revision, refresh, repaint only for a slash draft);
- `onLocaleChange()` (the live notification reached by `installUiLocale()` →
  `applySavedLocale()` → `refreshLocale()`), which refreshes and repaints without a
  keystroke; the listener is released by the TUI's disposer list;
- Screen/Surface open/close and the `/clear`/submit paths through `setDraft('')`.

Paint reads `this.completionState`. It does not call `commands.list()`, does not
clamp/write the index, and does not initialize the state. The 12-row window, markers,
local-first merge, alias filtering, narrow truncation and incremental frame budget are
unchanged.

`scripts/completion-write-guard.mjs` parses `src/tui.ts` with the TypeScript AST and
rejects any assignment to `this.input` outside `setDraft()` (including element-access
and compound forms). It is exercised by `tests/completion-ownership.test.mjs`.

## Key behaviour

Preserved: arrows move only a listed completion; otherwise history/workspace; Tab
accepts without submitting, otherwise two spaces; Enter keeps the byte-for-byte prefix
guard; Esc dismisses persistently until the draft changes; Shift+Tab stays inert;
Ctrl+L stays KEEP_DUAL; Ctrl+N/P keep the focus ring; line mode and Surface/Screen
preemption are unchanged; bracketed paste is text.

D2 (`/ag` → `diag`, `/HELP` → `help`) remains **DEFERRED** and is pinned by tests.

## Evidence

- `tests/completion-state.test.mjs` — pure transitions and clamping.
- `tests/completion-ownership.test.mjs` — P3–P13 and N1–N10 through `handleData`/`render`,
  the source guard, G1's real settings-path locale refresh, and G2's composer/Screen/
  Surface Ctrl+L repaint contract.
- `tests/completion-baseline.test.mjs` — D1 and D2b rewritten for the new contract;
  D2 remains the pinned negative case; Surface/Screen/lifecycle baselines kept.
- `scripts/tui-stdio-probe.mjs` — real `DSH_TUI_DISPLAY=stdio` pipe: list, arrow,
  Tab, Enter in separate writes and in one continuous write.
- `tests/helpers.test.mjs`, `tests/i18n.test.mjs` — use `handleData`/`setDraft` paths
  instead of assigning the draft directly.

## Open / deferred

- D2 remains deferred (visible highlight vs Enter execution).
- `TerminalInputGuard`'s ~30 ms source attribution remains an independent OPEN; this
  round did not widen the Reader API.
- Windows ConPTY: **PENDING CI**; no local Windows receipt.
- No version, dependency, compatibility, CI-release, Router, keymap, allowlist/danger
  or npm/tag change.
