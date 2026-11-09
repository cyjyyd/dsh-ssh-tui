# 0.8.5 — Stable candidate (not published)

> **CANDIDATE / RELEASE HOLD.** This source tree is a stable candidate, not a
> published release. `latest` remains `0.8.4`; tag, GitHub Release and npm
> publication require a separate Owner GO after the source/provenance Gate.

## Compatibility target

- **Added:** `@deepseek-ai/dsh@0.2.1-rc.5` and `0.2.2-rc.1`, each in its own
  exact, single-family strict-install matrix.
- **Retained until retirement review:** `0.2.0-rc.1`, `0.2.0-rc.2`,
  `0.2.1-rc.2`.
- **Node:** the candidate requires `>=24.9.0` because the 0.2.2 Host does.
- Cordis/Schemastery/Loader/Include/Timer are pinned as line-specific roots;
  the published package declares a tested two-line union, never an unbounded
  window.

## Fixes in the stable candidate

- Setup and Screen-confirmation ownership now precedes the global Alt chords;
  replacing a Screen settles its pending confirmation instead of orphaning it.
- `InputReader.stop()` is a true detach reset: active paste, held prefix and
  partial UTF-8 state do not leak into the next attach.
- New-paste ownership and Search C0-control handling are repaired.
- The model-selection bridge uses the 0.2.1 two-argument listener or the 0.2.2
  `Agent.model` API according to the Host, and commits a route only after the
  Host accepts it. An unknown `installModelSelection` arity fails closed rather
  than guessing an argument list.
- `/setup` now persists the default selection before changing the live Host
  route. A settings write failure leaves the wizard open and the previous route
  active, instead of reporting failure after the Host had already switched.

## Evidence

- Linux real PTY: workspace/Screen/paste/stdio/fresh-home setup on both new
  Host lines; `/model`, `/effort`, `/setup` and resume were driven against a
  disposable Session and a local mock provider. UI route, `model/selection`
  (0.2.2), `agent/pre-step.modelSelection` (0.2.2; the 0.2.1 payload has no such
  field), the next `request/header`, the HTTP body and the session route record
  agreed in all 10 scenarios.
- POSIX reconnect: the historical `got no exit event` was a probe race between
  `kill(pid, 0)` and node-pty's `onExit`, not a product exit failure. A
  deterministic regression test pins the grace; 200 SIGHUP trials (100 per new
  Host line) all exited 0, and the full drop/reattach probe passed 5/5 on each
  line after the fix.
- Windows ConPTY dual-line CI is the release Gate. Exact jobs:
  [rc.5](https://github.com/cyjyyd/dsh-ssh-tui/actions/runs/42597707644/job/129094322236)
  and [0.2.2](https://github.com/cyjyyd/dsh-ssh-tui/actions/runs/42597707644/job/129094321845).
  True conhost, real IME composition and the H11 silent SSH cut remain
  `NOT_MEASURED`; ConPTY capability rows are simulations, not manual evidence.
  The Owner checklist and exact console/SSH steps are in
  [`docs/release.md`](release.md#发布前人工门槛082-rc-起). Do not mark a
  capability row, a ConPTY `SKIP`, or this candidate as manual PASS.
- The stable artifact must be built from the exact candidate SHA, packed and
  upgraded from 0.8.4; old RC checksums are not reusable.
- Upstream source-to-npm provenance is still `RELEASE_HOLD_PROVENANCE`: npm
  `0.2.2-rc.1` carries `gitHead: null`, no attestation, and the exact tag has
  zero GitHub check-runs/workflow runs. A green Relay matrix is not a
  substitute for #42 acceptance.
