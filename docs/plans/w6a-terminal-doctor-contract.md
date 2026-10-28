# W-6A — Terminal Doctor: Evidence-Provenance and Reprobe Contract

> **Status: DESIGN / PROPOSAL / NOT IMPLEMENTED / NOT CANON**
> 2026-10-28 · DSH Relay 0.8.5 feature line.
>
> Source: `main@279d8810154b30e9df1316dfbaebefb429413897`, after W-4
> Completion Ownership and W-5 Dedicated Local Search Screen were integrated.
> This branch only adds planning documentation. No runtime, keymap, protocol,
> test, dependency, compatibility, version, main, stable or publication change.

## 0. Scope and intended deliverables

This is **W-6** from [the existing W-0–W-7 roadmap](0.8.4-input-ownership.md#L88-L102),
**not** a newly invented feature. W-6 answers a support question that `/diag`
cannot presently settle: "What can this particular terminal actually do, what
did DSH Relay measure, what does it merely assume, and what can be checked
again without corrupting an active session?"

Split the implementation into independently gated slices:

| Slice | Contract | What can be released independently? |
|---|---|---|
| **W6A** | This source-level audit, product choices and RED/PASS matrix | Documentation only; no product claims |
| **W6B** | Terminal capability **snapshot** as a read-only Screen with explicit source/evidence labels, existing measurements only | Yes, after Linux/Windows/line-mode Gate; **no interactive reprobe claim** |
| **W6C** | User-triggered **fresh terminal reprobe** across Host↔Relay, with attach-epoch correlation and safe reply ownership | Yes, only after separately reviewed protocol and safety Gate |

**No code agent may implement W6C by adding an unowned `CSI 6n` write
directly to `SshTui` or by calling a Host-local fake measurement.**

### Proposed command and UI (product Gate needed)

**Recommendation:** `/terminal` opens a `kind:'report', report:'terminal'`
Screen through the existing `openReport` and Report Screen plumbing. This is
preferable to another `ScreenKind`: terminal health is a report, not an
editor or a separate focus owner. Existing `/doctor` **continues** to mean
Host/provider/Agent Plane diagnostics; existing `/diag` **continues** to
describe channel and session facts. Neither is silently redirected.

- In framed mode: scrollable, copyable, depth-one report; Esc, Ctrl+C or q/Q
  closes; PgUp/PgDn, Ctrl+L and existing report copy keys keep their meanings.
- In line mode: a textual, copyable **`diag`** report row, never a Screen. **Implementation must update `reportRowKind('terminal')` to return `diag`**, because the current fallback returns `system` for new report kinds. This is an explicit testable compatibility change, not automatic from adding `ReportKind`.
- `r` is reserved **only within Terminal Doctor** for W6C fresh recheck.
  W6B must show "fresh recheck unavailable in this version", never pretend a
  cached snapshot was just remeasured.
- No general UI redesign, no new global keybindings, no default terminal
  capability changes, no attempt to read the system clipboard.

## 1. Read-only source audit (baseline facts)

| Source | What it really owns |
|---|---|
| `src/terminal-caps.ts` | `terminalCapabilities()`: environment/family classification, config overrides, declared mouse/SGR/drag/paste/alternate-screen/OSC52/OSC8/title policy. It is **not** a live terminal test |
| `src/tui.ts` | `terminalCaps` is set **once in the Host constructor** from `config.terminalCaps ?? terminalCapabilities()`; `useAlternateScreen` follows that value. `runDiagCommand()` collects Host-local snapshot and `openReport('diag',...)` |
| `src/diag.ts` | `formatDiag` formats Host/local facts; terminal line uses another Host-side `terminalCapabilities()` snapshot. RTT state distinguishes measured/unknown/unprobed, but capability flags are policy |
| `src/display-sock.ts` | Actual **Display Relay** owns the PTY/ConPTY and `TerminalInputPump`. Current frames include `FRAME_RTT`, `FRAME_PROBE` + `FRAME_PROBE_REPLY` (live/silent/unknown), and `FRAME_METRICS` for observed ambiguous glyph width |
| `src/glyph-measure.ts` / `src/terminal-input.ts` | Relay writes ambiguous glyphs, asks `CSI 6n` through `pump.askPosition()`, and **consumes** replies before forwarding user input |
| `src/screen.ts` | `ScreenKind='report'` and `ReportKind` already provide the correct depth-one screen and line-mode fallback model |
| `docs/terminals.md` | CI/maintainer evidence and community observations are separate levels. A compatibility-table ✓ is **not** an observation from the reader's current display |

### Critical Host/Relay correctness boundary

The Host may survive an SSH disconnect while the Display Relay is replaced by
a terminal with **different** family, palette, font or OSC configuration.

Today `SshTui.terminalCaps` is a Host-construction snapshot, while actual
RTT/ambiguous-width data is measured in whichever relay is attached **now**.
`FRAME_METRICS` updates the Host's width table and repaints; it does **not**
carry a full fresh capability map. Therefore **the Host's terminal family or
clipboard policy must never be displayed as "measured current terminal" after
reattach** unless a new, versioned Relay-sourced fact actually proves it.

The current `FRAME_PROBE` asks a relay for liveness; it is **not** an API to
rerun the glyph measurement and does **not** validate OSC52, mouse or paste.
The glyph probe is currently done during attach behind an output hold, avoiding
paint/probe interleaving. Reusing its logic mid-session requires the same
ownership and output-hold safety. `DSH_TUI_NO_GLYPH_PROBE=1` must remain
effective and visible as an explicit non-measurement.

## 2. Evidence model and report grammar

Use a **fact plus provenance**, not one Boolean per capability.

Suggested pure value model (pseudotype, **not** a shipped schema):

```ts
type Evidence =
  | { source: 'relay'; state: 'measured'; attachEpoch: number; observedAt: number }
  | { source: 'host-environment'; state: 'inferred'; origin: string }
  | { source: 'user-override'; state: 'configured'; origin: string }
  | { source: 'relay'; state: 'unmeasured'; reason: string; attachEpoch: number }
  | { source: 'previous-attach'; state: 'stale'; attachEpoch: number }

type TerminalDoctorFact = {
  capability: string
  value: string | number | boolean | null
  evidence: Evidence
}
```

Exact stable serialisation is W6B/W6C Gate work, not preapproved here. The UI
must distinguish **MEASURED** / **CONFIGURED** / **INFERRED** / **UNMEASURED**
/ **STALE** in both Chinese and English (ASCII-safe fallback where needed).
Do not display "supported" when only a policy Boolean was inferred.

| Item | W6B available source | Allowed claim |
|---|---|---|
| mouse, SGR, drag, bracketed paste, alternate screen | Host `terminalCapabilities()`, override parser | **Inferred or configured**, not measured |
| OSC 52, OSC 8, title | Host policy and known terminal family | **Inferred or configured**; clipboard write success is **not observable** here |
| color depth, ASCII/fallback, terminal family | Host environment and effective renderer policy | Host-origin **inferred/configured**; warn it may differ from current relay |
| RTT and terminal responsiveness | Current attachment's `FRAME_RTT`/`FRAME_PROBE_REPLY` if captured | **Measured**, **silent** or **unmeasured**; no numerical RTT if no reply |
| ambiguous glyph width/reserve | Current attachment's `FRAME_METRICS` if captured | **Measured** only when this frame was received **in this attachment generation**; otherwise locale fallback is **inferred**, and the missing live probe is **unmeasured** with unknown reason unless the Relay explicitly reports why |
| ignored overrides | `parseCapsOverrideReport` | Config validation fact, not a terminal observation |

A report must identify **snapshot scope** ("Host startup" or "Relay attach
epoch"), not expose a raw environment dump, paths, credentials, API keys,
network addresses or session IDs. A report can offer "copy diagnostic summary"
using existing copy behavior. No network telemetry.

## 3. W6B — snapshot-only implementation contract

1. Add a pure `terminal-doctor.ts` formatter that accepts *already collected*
   narrow facts. No globals, filesystem/network access or probe bytes in the
   formatter. Bound line count and sanitize any labels or override tokens.
   Provide a source-labelled minimal report (Host-start policy vs Relay current
   attach) that fits 8/12/20-row Screens, with copyText taken from the same
   canonical formatted facts. Unknown/disabled/stale must be visibly distinct.
2. Add the proposed local command and its zh/en descriptions, `ReportKind`,
   `reportRowKind('terminal') === 'diag'` and title. Preserve Screen depth ≤1;
   no new input owner, Surface or hidden composer mutation. The report may be
   replaced by Search via existing Alt+f semantics. No new `ScreenKind`.
3. Gather Host policy facts from the existing classifier; combine with **only
   the last actually observed current-attach** RTT/metrics facts. Use a monotonic
   **attachment generation** maintained at the Host's current display callbacks:
   invalidate the previous generation on detach/replacement; stamp only an
   `onRtt` numeric reply or `onMetrics` payload actually observed since
   `onAttach`. Do not infer width measurement merely because the module's
   current fallback happens to be wide. If the Host cannot prove the observation's
   attachment epoch, mark it UNMEASURED/STALE, not MEASURED. An empty/currently
   detached display is explicitly UNMEASURED/STALE. The Host cannot know that
   `DSH_TUI_NO_GLYPH_PROBE=1` was set in a different Relay process unless that
   fact is transmitted; missing `FRAME_METRICS` means only `UNMEASURED (reason unknown)`,
   **not** `disabled by environment`.
4. Store no new durable history or user settings. `/terminal` never triggers
   a model call, rewrites profile rows, changes keymaps, or silently enables
   terminal modes.
5. Repaint after an attach/metrics update with existing Screen repaint logic;
   never materialize a second report or overwrite the hidden Composer.
6. In stdio and line-mode paths, report only facts the transport genuinely
   knows. Do not claim "no terminal" as a measured failure.

**W6B cannot claim user-triggered active measurement until W6C has a tested
Relay request/response path.**

## 4. W6C — fresh reprobe contract (separate protocol Gate)

User-triggered `r` asks **the attached Relay** to perform a fresh,
bounded probe. Preferred design: a *new versioned request/reply pair* rather
than mutating `FRAME_PROBE` liveness semantics or feeding new bytes into the
Host's input reader. The pending request must carry a transaction id and
attachment generation; the reply must echo that identity.

- **Single-flight** per attached relay: repeated r cannot stack multiple
  `CSI 6n`/glyph probes, flood the terminal or consume CPU while idle.
- **No display / pipe / disabled probe:** fail locally with UNMEASURED + reason,
  send no unsafe bytes. No live model invocation.
- **Reply ownership:** only `TerminalInputPump` may consume CPR/DSR and
  `askPosition` replies. Reply bytes must never become a key, text, paste or
  hidden Composer content. Preserve WIN-CI1.H3's held-Esc guarantee.
- **Output ownership:** use an explicit bounded terminal output hold around
  the glyph probe; no racing paint bytes between writing glyphs and receiving
  cursor position. Cancel/flush safely on timeout/replacement/disposal.
- **Lifetime:** detach/re-attach increments an epoch. A late reply for a
  replaced relay, a closed report or disposed Host cannot resurrect the Screen
  or overwrite current metrics.
- **Truthfulness:** no response -> UNMEASURED/timeout, not a zero width, zero
  RTT or unsupported flag. `DSH_TUI_NO_GLYPH_PROBE=1` remains a hard skip;
  no widening of the existing probe window solely to make tests pass.
- **Capabilities not safely queryable:** no speculative OSC52 clipboard read,
  OSC8 click check, mouse click injection or title verification. Rechecking
  RTT/glyph cannot upgrade these classifier values to MEASURED.

The final request/reply wire layout, timeout constants and fallback policy
require W6C design review; do **not** assign unused frame numbers by guess.
Potential compatibility with older hosts/relays and same-process reattach
must be part of its negative matrix.

## 5. Positive/negative and mutation acceptance matrix

| ID | Scenario | Must hold |
|---|---|---|
| W6-P1 | `/terminal` in framed mode | Dedicated report, zero transcript writes, one Screen, exact workspace/Composer restore on close |
| W6-P2 | `/terminal` in line mode | Textual `diag` row, no Screen, readable output |
| W6-P3 | Linux PTY + Windows ConPTY startup | Policy fields visibly INFERRED/CONFIGURED; measured RTT/glyph only with real reply |
| W6-P4 | fallback: no CPR / `DSH_TUI_NO_GLYPH_PROBE=1` | UNMEASURED, never false success; exact 'disabled' reason only if the current Relay actually reports that fact, otherwise 'reason unknown' |
| W6-P5 | 8/12/20-row resize, 40/100 columns, truecolor/8/none/ASCII | Correct report layout, clipping, copy text, no field leaks |
| W6-P6 | same-process reattach to changed terminal | New epoch/source identified; old Host classifier not relabeled as current relay measurement |
| W6-P7 | W6C `r` | Exactly one fresh Relay probe; report updates in same Screen with new receipt |
| W6-N1 | Inject split/late `CSI row;col R` | No compositor/Screen/hidden draft corruption, no printable `^[` leak |
| W6-N2 | Hold bare Escape while starting probe | Esc delivered exactly once; WIN-CI1.H3 unchanged |
| W6-N3 | two r presses, detach, late reply | One in-flight per epoch, stale reply ignored, no Screen resurrection |
| W6-N4 | report on stale Host environment after relay replacement | Cannot label old capability flags as MEASURED |
| W6-N5 | disabled/no terminal plus forced r | No probe bytes; report remains truthful |
| W6-N6 | `/doctor`, `/diag`, W-4 completion, W-5 Search | Existing behavior unchanged, owner isolation and input fixture pass |
| W6-N7 | OSC52 write not verifiable | No "clipboard successfully written" claim |
| W6-N8 | remove origin/epoch or change inferred→measured | Deterministic unit/mutation test fails |
| W6-N9 | turn `r` into direct Host stdout DSR | Test fails for terminal ownership and reply leak |
| W6-N10 | shortcut/flag behavior on older host lines | No compatibility-window or peer change, proper fallback |

**Gate commands:** `npm test`, `npm run typecheck`,
`npm run freeze`, `npm run freeze:input`, `npm run bench`,
`npm run bench:report -- --check` on the committed default line,
real Linux PTY and Windows ConPTY terminal/paste/drop probes plus
new Terminal Doctor probe. Require 4/4 standard CI SUCCESS. Never
equate a ConPTY frame-level SKIP or `PRIME: SKIP node-pty` with human PASS.

## 6. Compatibility, release and parallelism

- **U1** experimental rc.3 compatibility remains separate and not declared.
  W6A/B/C are based on the authorized `main`, not directly on PR #17/#19.
- **U2** rc.4 host provenance is now published but its *compatibility* is
  unverified. Do not make W-6 depend on this as a hidden upgrade.
- **W-7** picker Reader/Router consolidation is explicitly optional and last.
- D2 completion selection mismatch and G-5 Screen drag remain independent
  deferred questions. Historical durable-log Search is not this feature.
- No Footer visual syntax redesign (deferred to 0.9), no unapproved low-resource
  shared-server profiling or OpenClaw load generation.
- No package version bump, release branch rewrite, tag, GitHub Release or npm
  publish without a separate explicit release Gate.

## 7. Product and implementation Gate

The recommended W6A defaults needing owner acceptance before product code:

1. Use `/terminal` and `kind:'report', report:'terminal'`; preserve
   existing `/doctor` and `/diag` meaning.
2. Use the five evidence labels above; classify policy/override separately
   from actual Relay measurement and report Host-vs-Relay provenance.
3. Permit independently testable W6B snapshot-only delivery. W6C recheck is
   **not** auto-approved by W6B.
4. Treat `r` as an explicit, opt-in fresh recheck only after a safe
   correlated Relay protocol exists; otherwise it must not pretend success.
5. Never call Provider/network APIs or change terminal modes to "test" them.

**W6A completion criteria:** an independent review resolves the above choices,
confirms the Host/Relay measurement boundary against actual source, supplies a
RED→GREEN test allocation and a scoped W6B handoff. This document is neither
implementation nor acceptance evidence.
