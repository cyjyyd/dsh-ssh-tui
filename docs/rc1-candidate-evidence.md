# 0.9.0-rc.1 Candidate Evidence

This is the repository-only evidence index for the `0.9.0-rc.1` freeze candidate.
It ships in the repository, not in the npm package. The package's own
`docs/release-notes-0.9.0-rc.1.md` carries the user-facing material; this file
carries the audit trail and must be updated whenever a measured value changes.

Status: `CANDIDATE_PREP_IN_PROGRESS` (replace with the final technical state).
No tag, GitHub Release, npm publish, dist-tag change or `main` merge is part of
this preparation.

## Source

- Base: PR #91 OPEN/Draft head `bdb36cd5889a7c1d65f0b6bf7a1bbd75d34208a3`
  (tree `54d030dfae606645305126698034cfb244bedcd4`), itself 11 commits /
  37 changed paths from `main@11fc3731433785bf41717ddeb7bdde379320127c`.
- Branch: `agent/rel090-rc1-prep`, worktree
  `/root/dsh-ssh-tui/.worktrees/rel090-rc1-prep`.
- Candidate commit/tree: `PENDING` (filled after the identity/docs commit).
- Delta intent: package/lock identity `0.9.0-rc.1`, README/CHANGELOG/release
  notes, candidate evidence and the release-identity guard only. No product
  runtime change, no compatibility-window change, no workflow change.

## Local validation

Commands are run on the candidate tree with `npm_config_cache` redirected to a
writable path. Results are filled from the actual run; a skipped or unmeasured
item stays `NOT_MEASURED` rather than being rounded up.

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | PENDING |
| Full suite | `npm test` | PENDING |
| B2 freeze | `npm run freeze` | PENDING |
| Input freeze | `npm run freeze:input` | PENDING |
| Bench | `npm run bench` | PENDING |
| PTY probe | `node scripts/probe-home.mjs --probe` | PENDING |
| Stdio probe | `node scripts/probe-home.mjs --probe --script tui-stdio-probe.mjs` | PENDING |
| SSH detach/reattach | `node scripts/probe-home.mjs --probe --script tui-drop-probe.mjs` | PENDING |
| Context resize F1 / single snapshot read | `node --test tests/context-view.test.mjs tests/context-command.test.mjs` | PENDING |
| Windows ConPTY | `.github/workflows/ci.yml` `test-windows` | PENDING |

No real paid provider call, real credential or production Home is used. Context
history Reader / cold-sync history access is explicitly out of scope.

## CI

- Target: fresh exact candidate SHA, Linux 9 Hosts + Windows ConPTY 6 +
  rc.4/rc.5 synthetic characterization = 16 jobs.
- Run: `PENDING`.
- The historical S1-E run 45175221540 is **not** used as freeze evidence.
- Per-job version pins, built/packed artifact probes and every SKIP /
  `NOT_MEASURED` line are recorded from the job logs once the run completes.

## Packs

- Two separately executed `npm pack` runs of the same RC source tree in clean,
  isolated paths; compare SHA256 and exact bytes, then `shasum`, npm integrity,
  `gitHead`, package manifest and pack list.
- Clean-clone reinstall/pack check: `PENDING`.
- If the packs differ, this section must say `HOLD` and name the smallest
  nondeterminism cause; no fake `PASS`, no arbitrary file stripping.
- Pack A SHA256: `PENDING`. Pack B SHA256: `PENDING`.

## Upgrade and rollback

- Synthetic `0.8.6` Stable → `0.9.0-rc.1` upgrade in an isolated home:
  `PENDING`.
- Covered paths: persistence, rename, Context, TUI and SSH with fake
  credentials; `latest` / `next` are not touched and no registry write is made.
- Rollback/runbook: install the previously pinned `0.8.6` tarball/version back;
  `PENDING` for an executed rollback if the contract requires one.

## Limitations

- Upstream `0.2.2-rc.4` / `rc.5` source-to-artifact provenance is
  `EVIDENCE_LIMITED`, not complete npm `gitHead`/attestation or `FULL_PASS`.
  The existing qualified Owner exceptions stay as written; #42 is not turned
  into PASS.
- rc.5 Windows trailing-newline flake remains `INCONCLUSIVE`.
- Real-machine Windows 11, formal IME, every desktop terminal combination and
  Windows-side H11 are `NOT_MEASURED` unless a separate receipt records them.
  The GitHub Windows runner is ConPTY test infrastructure, not a supported
  Windows Server OS.
- Windows Server family (including Server 2025) is out of support for
  `0.9.0-rc.1`; the historical question-wait double-newline RED
  ([Actions 44881356855 / job 136777141174](https://github.com/cyjyyd/dsh-ssh-tui/actions/runs/44881356855/job/136777141174))
  remains, and the independent bounded D5 audit is
  [PR #89 comment 7090676703](https://github.com/cyjyyd/dsh-ssh-tui/pull/89#issuecomment-7090676703).
- Excluded by scope: PR #49 / #50 / #73 historical Reader, `/search` V09,
  Picker / F2, archive / restore / delete / reset, AgentTeam deep.
