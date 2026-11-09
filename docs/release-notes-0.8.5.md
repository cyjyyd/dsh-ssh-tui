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
  Host accepts it.

## Evidence

- Linux real PTY: workspace/Screen/paste/stdio/fresh-home setup on both new
  Host lines; drop/reattach on rc.5 and on 0.2.2 after the known historical
  POSIX hang-up retry.
- Windows ConPTY dual-line CI is the release Gate; true conhost/IME remain
  `NOT_MEASURED` where not manually exercised.
- The stable artifact must be built from the exact candidate SHA, packed and
  upgraded from 0.8.4; old RC checksums are not reusable.
- Upstream source-to-npm provenance is still `RELEASE_HOLD_PROVENANCE`; a green
  test matrix is not a substitute for #42 acceptance.
