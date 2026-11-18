# 0.8.6-rc.1 — Compatibility Candidate (historical)

> **历史候选状态：已发布为 `0.8.6-rc.1` 预发布。** annotated tag `v0.8.6-rc.1`、GitHub prerelease 与 npm `next` 的记录见 Release / #70 RC24；本文件保留候选记录，不代表 Stable 发布。
>
> 基线：已发布 `v0.8.5` 的精确 commit `78b456a02bb38ac95b8fd8b284740d65ddf5cbe0`。本候选只做上游兼容，不包含 W6B Terminal Doctor、Context、TITLE、V09 或其他新功能。Stable 候选以本文件对应的 exact SHA `8b3c8b892a70f713010f6d83bcf248cf851f8e39` 为源码基线，另加版本号与发版材料；Stable 的新 SHA、CI 与 artifact 证据单独记录。

## Compatibility target

精确支持并集：

```text
0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.2 || 0.2.1-rc.5 ||
0.2.2-rc.1 || 0.2.2-rc.2 || 0.2.2-rc.3
```

- 新增 `0.2.2-rc.2` 与 `0.2.2-rc.3`，两条各自单独验收；
- 原 `0.2.1-rc.5`、`0.2.2-rc.1` 与三条旧 RC 继续保留，不因本候选自动退役；
- Node.js `>=24.9.0`；
- Cordis `4.1.0`，Include `1.1.0`，Loader `1.1.0`，Timer `1.2.0`，Group `1.1.0`，Schemastery `3.19.0`。

## Changed

- Agent root selection follows the rc.2 Session-header semantics: a top-level Session mounts, while an exact-id Session with `origin: 'subagent'` is rejected. The old `AgentRegistry.roots()` API is no longer used.
- The two new upstream RCs are added to the exact peer/`dshReleases` declarations, CI matrix and line-specific root pins. These are not an unbounded semver window.

## Evidence and boundaries

- `rc.2` is an affected-core release: Agent/Session/AgentLoop/SubAgent/LLM/UserQuestions changed. Its Agent/Session/SubAgent, lifecycle, routing and PTY paths require focused regression; the previous rc.1 route result is not reused as an rc.2 PASS.
- `rc.3` keeps the Relay-facing core `src` unchanged from rc.2; its exact npm runtime, strict install, profile boot, route, drop/reattach and ConPTY smoke are still new gates.
- Both rc.2 and rc.3 currently classify as **`EVIDENCE_LIMITED / SOURCE_PAYLOAD_MATCH`**: no official upstream check-runs/Actions, no npm `gitHead`, no attestation, and no byte-identical rebuild proof. The #42-R2 Owner `ACCEPT_LIMITED_EXCEPTION` covers only this Relay `0.8.6` line with these two exact Hosts; it is not an official CI/attestation PASS and does not extend to rc.4 or later versions. The older `v0.8.5 + rc.1` signature remains separate.
- Windows: the historical 2026-10-24 H-3/H-4 manual PASS remains accepted for the Windows Terminal → SSH → Linux Host remote path. Native Windows Host real IME is `NATIVE_WINDOWS_HOST_REAL_IME_NOT_MEASURED`; ConPTY/Unicode input is not `REAL_IME_PASS`. Windows-side H11 is not measured.
- This candidate is not a compatibility admission or release authorization. Exact SHA, CI, artifact and install/upgrade receipts are recorded in #68 `COMPAT-FAST.R1`; release requires a separate Owner decision.

## Known limitations

- Named/multi-layer SubAgent and AgentTeam are new in rc.2; Relay observes their lifecycle events but does not claim full AgentTeam feature coverage.
- The rc.2/rc.3 CLI npm tarball ships `src/` and `docs/` (532 files, ~2.2 MB), unlike rc.1's 20-file CLI. This is upstream packaging, not the Relay plugin artifact.
- The first `paint-budget` CI flake from the 0.8.5 candidate remains a historical risk record; it is not a v0.8.6 compatibility regression.
