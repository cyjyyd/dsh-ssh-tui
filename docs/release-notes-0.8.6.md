# 0.8.6 — Seven-Host Compatibility Stable

This document ships with the `0.8.6` package. The authoritative publication
time, annotated tag object, GitHub Release assets, registry digest and
post-publication read-back live in the GitHub Release and the Stable release
receipt; this file does not try to embed a future Actions run ID or a live
dist-tag. `0.8.6` is a compatibility-only Stable candidate until the Owner
separately signs `OWNER RELEASE GO` for the exact new commit and artifact.

## Source baseline

- `v0.8.5` exact commit: `78b456a02bb38ac95b8fd8b284740d65ddf5cbe0`.
- Frozen prerelease source: PR #69, exact commit
  `8b3c8b892a70f713010f6d83bcf248cf851f8e39` (`0.8.6-rc.1`).
- The Stable conversion changes only `package.json` / `package-lock.json`
  version and release documentation. `src/`, runtime behavior, peer ranges,
  `dshReleases`, and the CI matrix are unchanged from that source.
- The historical RC tarball SHA-256
  `e6605b6891f36147f1c3262118026205ce6441264822b1c4de2d83586f87a5d2`
  is **not** reused as the Stable artifact digest.

## Compatibility target

Exact supported union, not an unbounded semver window:

```text
0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.2 || 0.2.1-rc.5 ||
0.2.2-rc.1 || 0.2.2-rc.2 || 0.2.2-rc.3
```

- Seven exact Host versions, each installed as one strict DSH family graph;
  no duplicate DSH family and no dynamic `latest` / `next` peer.
- Node.js `>=24.9.0`.
- `0.2.2-rc.4` is **not** in this release. It is deferred to the 0.9.0
  compatibility workstream (#74 / #76) and must not be inferred from this
  package's presence in the registry.
- The older `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-rc.2` and `0.2.1-rc.5` lines
  remain declared and tested; this release does not retire them.

## What changed from 0.8.5

- Added exact compatibility for `@deepseek-ai/dsh@0.2.2-rc.2` and
  `0.2.2-rc.3`, each with its own validation line.
- Agent root selection follows the rc.2 Session-header semantics: a top-level
  Session mounts, while an exact-id Session with `origin: 'subagent'` is
  rejected. The old `AgentRegistry.roots()` API is no longer used.
- The model-selection bridge uses the Host's actual API shape and keeps the
  prior route when the Host rejects a switch; an unknown
  `installModelSelection` arity fails closed.
- Setup keeps its pending confirmation and transactional persistence
  behavior; `InputReader.stop()` remains a true detach reset.
- No new product feature is claimed in this release.

## Scope boundaries

`0.8.6` is compatibility-only. It does **not** include or promise:

- W6B Terminal Doctor / `/terminal` behavior;
- TITLE / rename work;
- C1 `/context` snapshot UI;
- V09 `/search` historical durable search;
- AgentTeam deep behavior or nested `delegationDepth >= 2`;
- native Windows Host real IME input.

These are separate workstreams or `NOT_MEASURED` items, not hidden PASSes.

## Evidence and provenance

- The frozen RC at `8b3c8b892a70f713010f6d83bcf248cf851f8e39` has historical
  exact-head CI run
  [43794059415](https://github.com/cyjyyd/dsh-ssh-tui/actions/runs/43794059415)
  with 11/11 success (7 Linux, 4 Windows ConPTY). That is **RC evidence**,
  not proof for the new Stable commit; the Stable candidate must produce its
  own new-head 11/11 run.
- `0.2.2-rc.2` and `0.2.2-rc.3` remain classified as
  **`EVIDENCE_LIMITED / SOURCE_PAYLOAD_MATCH`**: no official upstream
  check-runs / Actions / statuses, no npm `gitHead`, no attestation, and no
  byte-identical rebuild of the CLI `lib/` or all sibling packages.
- The #42-R2 Owner `ACCEPT_LIMITED_EXCEPTION` applies only to this Relay
  `0.8.6` line and those two exact Hosts. It is **not** an official upstream
  CI or supply-chain PASS, does not apply to rc.4 or later versions, and does
  not close #42.
- The Stable artifact is required to be packed twice byte-identically, checked
  with the packed-artifact smoke, upgraded from `0.8.5`, installed into the
  seven exact Host profiles with strict single-family graphs, and verified
  from a clean standalone clone for its `gitHead`. The new exact-head 11/11
  CI, tarball SHA-256 / shasum / integrity and post-pack readback are recorded
  in the PR and release receipt.

## Windows

- The historical 2026-10-24 H-3/H-4 manual PASS remains accepted for the
  Windows Terminal → SSH → Linux Host remote path.
- Native Windows Host real IME is
  `NATIVE_WINDOWS_HOST_REAL_IME_NOT_MEASURED`; ConPTY / Unicode input is not
  `REAL_IME_PASS`.
- Windows-side H11 and nested `delegationDepth >= 2` remain `NOT_MEASURED`.
- The Windows CI leg is a real ConPTY lifecycle smoke, not a substitute for a
  human IME or hardware pass.

## Install and upgrade

```sh
dsh plugin --profile tui add dsh-ssh-tui@latest
dsh --profile tui
```

For an existing `0.8.5` profile, the supported upgrade path is the same
`@latest` install after the Stable release is published; the candidate
receipt records a synthetic `0.8.5 → 0.8.6` upgrade smoke. RC users on
`@next` should switch to `@latest` only after the Stable release and final
Owner sign-off.

## Known limitations

- Named / multi-layer SubAgent and AgentTeam are new in rc.2; Relay observes
  lifecycle events but does not claim full AgentTeam feature coverage.
- The rc.2/rc.3 CLI npm tarball ships `src/` and `docs/` (532 files, ~2.2 MB),
  unlike rc.1's 20-file CLI. That is upstream packaging, not the Relay plugin
  artifact.
- The first `paint-budget` CI flake from the 0.8.5 candidate remains a
  historical risk record; it is not a 0.8.6 compatibility regression.
- Official npm registry identity must be rechecked at release preflight. If it
  cannot be verified, the release transaction stops rather than guessing.
