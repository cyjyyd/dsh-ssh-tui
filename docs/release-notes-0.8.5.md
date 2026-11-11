# 0.8.5 — Stable

This document ships with the `0.8.5` package. The authoritative publication
time, tag object, GitHub Release assets, registry digest and post-publication
read-back live in the GitHub Release and the #65 G3 release receipt; this file
does not try to embed a future Actions run ID or a live dist-tag.

## Compatibility target

- **Added:** `@deepseek-ai/dsh@0.2.1-rc.5` and `0.2.2-rc.1`, each in its own
  exact, single-family strict-install matrix.
- **Retained until retirement review:** `0.2.0-rc.1`, `0.2.0-rc.2`,
  `0.2.1-rc.2`; none of these is removed by this release.
- **Node:** this release requires `>=24.9.0` because the 0.2.2 Host does.
- The exact peer/dsh union is
  `0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.2 || 0.2.1-rc.5 || 0.2.2-rc.1`.
  Cordis/Schemastery/Loader/Include/Timer are pinned as line-specific roots;
  the package declares the tested union, not an unbounded window.

## Fixes in 0.8.5

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
- Linux H11 real SSH isolation: a real sshd/client/Host over a network namespace
  and veth, with bidirectional packet DROP and no FIN/RST, passed **6/6**
  repetitions (3 per new Host line). This is the H11 evidence; a paused proxy
  is not counted as a pass.
- Windows ConPTY: the historical G2 candidate `5ba9eff` passed the dual-line
  workflow (7/7 jobs in run
  [42619561596](https://github.com/cyjyyd/dsh-ssh-tui/actions/runs/42619561596)).
  This is a **historical candidate receipt**, not an ID for this docs-only
  package. Real conhost boot/Composer reached **3/3** in #64. Formal Microsoft
  Pinyin IME, Windows Terminal and Windows-side H11 remain **NOT_MEASURED**
  unless a separate #64 receipt explicitly records them; ConPTY capability rows
  and boot-only checks are not IME PASS.
- The stable artifact was packed twice byte-identically, checked with
  `artifact-smoke`, upgraded from `0.8.4`, and installed into both target RC
  profiles with exact single-family graphs. The final tarball digest and the
  exact new-head 7/7 run are recorded in the GitHub Release and #65 receipt;
  the package itself cannot contain its own post-build digest or future run ID.
- Upstream source-to-npm provenance remains a separate Gate. The
  `@deepseek-ai/dsh@0.2.2-rc.1` CLI tarball is reproducible byte-for-byte from
  tag `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`, but official GitHub
  checks/actions/statuses are absent, npm has no `gitHead`/attestation, and the
  other DSH family packages were not independently rebuilt. #42 therefore
  remains `FORMAL HOLD`; a version-scoped Owner exception, if any, is recorded
  separately and does not turn #42 into PASS or cover a future RC.
