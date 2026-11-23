# 0.9.0-rc.1 Candidate Evidence

This is the repository-only evidence index for the `0.9.0-rc.1` freeze candidate.
It ships in the repository, not in the npm package. The package's own
`docs/release-notes-0.9.0-rc.1.md` carries the user-facing material; this file
carries the audit trail. Exact volatile values (final commit/tree, CI run and
job IDs, tarball SHA256/integrity, clean-clone result, upgrade transcript) are
recorded in the canonical #81 completion receipt, because a committed file
cannot contain the hash of the commit that contains it or a future run ID.

Status: `CANDIDATE_PREP_COMPLETE` (technical state of this preparation; not
`RC_CUT_READY` and not `RC_RELEASE_GO`). No tag, GitHub Release, npm publish,
dist-tag change or `main` merge is part of this preparation.

## Source

- Base: PR #91 OPEN/Draft head `bdb36cd5889a7c1d65f0b6bf7a1bbd75d34208a3`
  (tree `54d030dfae606645305126698034cfb244bedcd4`), itself 11 commits /
  37 changed paths from `main@11fc3731433785bf41717ddeb7bdde379320127c`.
- Branch: `agent/rel090-rc1-prep`, worktree
  `/root/dsh-ssh-tui/.worktrees/rel090-rc1-prep`.
- Candidate commit/tree: recorded in the #81 completion receipt (the review
  target is the PR head, not this file's own commit).
- Delta intent: package/lock identity `0.9.0-rc.1`, README/CHANGELOG/release
  notes, candidate evidence and the release-identity guard only. No product
  runtime change, no compatibility-window change, no workflow change.

## Local validation

Run on the candidate tree with `npm_config_cache` redirected to a writable path.
A skipped or unmeasured item stays `NOT_MEASURED` and is not rounded up.

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | **PASS** (`tsc --noEmit`, exit 0) |
| Full suite | `npm test` | **PASS** 1876 tests / 1860 pass / 0 fail / 16 skipped |
| B2 freeze | `npm run freeze` | **PASS** `OK: every frozen invariant holds` |
| Input freeze | `npm run freeze:input` | **PASS** `OK: no input-ownership baseline was exceeded` |
| Bench | `npm run bench` | **PASS** five actions, **0** full clears; medians 1.54 / 1.20 / 1.14 / 0.85 / 0.19 ms |
| PTY workspace | `node scripts/probe-home.mjs --probe` | **PASS** boot, resize, `/diag`, `/doctor`, `/copy`, `/preset`, mouse/layer/picker, Screen reports, `/exit` |
| Stdio (desktop shape) | `node scripts/probe-home.mjs --probe --script tui-stdio-probe.mjs` | **PASS** all assertions |
| SSH detach/reattach | `node scripts/probe-home.mjs --probe --script tui-drop-probe.mjs` | **PASS** resumed transcript, working prompt, crashed Host recovered |
| Context regressions | `node --test tests/context-view.test.mjs tests/context-command.test.mjs` | **PASS** 36/36, including 20→80 End/PageDown, 80/40/20 no-second-read and disconnect/reattach rebuild |
| Windows ConPTY | `ci.yml` `test-windows` on the fresh candidate SHA | **recorded in #81 receipt** (not a local Linux result) |

The 16 local skips are the expected environment skips: one incomplete installed
Host tree (`@deepseek-ai/dsh-hmr` absent), two win32 ACL/pipe cases on Linux,
ten rc.4/rc.5 strict-artifact cases that need their separate trees, and two
node-pty/prime cases. The rc.4/rc.5 cases are executed by the dedicated
`rc5-characterization` CI job.

No real paid provider call, real credential or production Home is used. Context
history Reader / cold-sync history access is explicitly out of scope.

## CI

- Target: fresh exact candidate SHA, Linux 9 Hosts + Windows ConPTY 6 +
  rc.4/rc.5 synthetic characterization = 16 jobs.
- Run, per-job IDs, version pins, built/packed artifact probes and every SKIP /
  `NOT_MEASURED` line: recorded in the #81 completion receipt.
- The historical S1-E run 45175221540 is **not** used as freeze evidence.

## Packs

- Two separately executed `npm pack` runs of the same RC source tree in clean,
  isolated paths; compared by SHA256 and exact bytes, then by `shasum`, npm
  integrity, `gitHead`, package manifest and pack list.
- Clean-clone reinstall/pack: a fresh clone of the reviewed commit, `npm ci`,
  `npm pack`, compared to the in-worktree packs.
- Exact tarball SHA256 / integrity / file counts and the clean-clone outcome are
  recorded in the #81 completion receipt. If the packs differ, this section
  must say `HOLD` and name the smallest nondeterminism cause; no fake `PASS`,
  no arbitrary file stripping.

## Upgrade and rollback

- Synthetic `0.8.6` Stable → `0.9.0-rc.1` upgrade in an isolated home using the
  candidate tarball: manifest, bundle entry, credential file and session store
  must survive, and the upgraded profile must compose (`--dump-config`).
- TUI boot after the swap: real PTY probe against the upgraded home.
- Rollback: reinstall the published `0.8.6` artifact over the candidate and
  check it still composes; no registry write and no `latest` / `next` change.
- Exact commands and results are recorded in the #81 completion receipt.

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
