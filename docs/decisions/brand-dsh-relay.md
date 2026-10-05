# ADR: DSH Relay brand migration (soft brand first)

**Status**: accepted, P0/P1 in progress
**Date**: 2026-10-04
**Scope**: naming and presentation only — no runtime change, no protocol change, no
install-coordinate change.

## Context

The plugin's name describes one property of it: `dsh-ssh-tui` says "a TUI over SSH".
That was accurate when the plugin was a thin viewer for a harness session on a jump
host. It is no longer the whole product:

- the hard part is not "rendering a TUI" but keeping a **session alive across a
  display that can disappear** — the Host outlives the window, the turn keeps
  running, and the same command attaches back to it;
- the display is not necessarily SSH at all (a desktop harness, a pipe parent, a
  local terminal all work), and Windows / ConPTY is a first-class target;
- the reading experience over a slow link — plain ANSI, incremental redraws,
  bounded per-frame byte budgets — is what the project actually competes on.

A product called "the SSH TUI" invites the wrong questions ("is this just a skin
for `ssh`?") and hides the property users care about, which is continuity. Hence a
product/display brand that names the continuity itself: **DSH Relay** — the thing
that keeps the session reachable while the display changes underneath it.

## Decision

The frozen principles of this migration. They are invariants for P0–P2, and none of
them may be violated by a later phase without a new ADR:

1. **Product/display brand = `DSH Relay`.** It is what the README, the Release
   title, the repository description and the docs call the project.
2. **The npm install coordinate stays `dsh-ssh-tui`** for the whole 0.8.x/0.9.x
   line. Nothing a user types changes.
3. **The GitHub slug stays `cyjyyd/dsh-ssh-tui` in P1.** A rename is a P3 decision
   with an external cost (every existing link, badge and issue URL).
4. **0.8.x is the soft-brand phase**: display name only; package name, slug,
   install command, profile/entry identifiers and the `/diag` plugin line all keep
   their current values.
5. **A repo rename is only evaluated at 0.9.0**, after the P2 observation window,
   and only if the metrics (see [`brand-metrics.md`](../brand-metrics.md)) show the
   slug is actually the limiting factor for discovery.
6. **An npm rename is an independent decision.** It must never be coupled to a repo
   rename: the install coordinate has the higher switching cost, and coupling them
   turns one risky move into two at once.
7. **SSH is demoted from "product definition" to a signature capability.** It stays
   prominent — it is the environment most of this project's hardest bugs came from —
   but the definition is no longer "the SSH TUI".
8. **The positioning is: remote-first / reconnectable / terminal workspace.**
   Everything user-facing should be readable as one of those three.
9. **No migration step may break an old install coordinate.** `dsh plugin add
   dsh-ssh-tui@…`, `/diag`'s `plugin: dsh-ssh-tui <version>`, stored sessions,
   `DSH_TUI_*` environment variables and the profile entry ids keep working. If a
   later phase wants to change one of them, that is a deprecation with a stated
   window, not a rename.
10. **Every phase is reversible.** A brand change that cannot be rolled back by
    reverting a commit is out of bounds for this ADR.

Phase table (the plan this ADR authorizes):

| Phase | Name | What ships | Reversible by |
|---|---|---|---|
| **P0** | baseline | record the current state: coordinates, README first screen, naming audit A/B/C/D, metric template. No file changes beyond the record itself | reverting the commit |
| **P1** | soft brand | README/hero/product wording says `DSH Relay`; package `description`/`keywords` updated; GitHub About/Topics + a compatibility issue template proposed; compatibility matrix gets a community-reported area; asset: a regenerable reconnect demo | reverting the commit; npm metadata via `npm publish` of the next version |
| **P2** | observation | no code or naming change: collect the metrics in [`brand-metrics.md`](../brand-metrics.md) and decide from data whether P3 is worth it | nothing to revert |
| **P3** | GitHub relaunch | *only if P2 says so*: rename the repo (GitHub redirects the old slug), update badges/links/About | rename back; GitHub keeps a redirect |
| **P4** | optional npm migration | *separate decision*: publish under a new package name, keep `dsh-ssh-tui` as a deprecated pointer for at least one minor | keep publishing the old name; deprecation is a dist-tag/`deprecated` field, reversible |

## Naming boundary (what may and may not be renamed)

The audit in the P1 checkpoint classifies every `dsh-ssh-tui` occurrence in the tree.
Summary of the rule:

| Class | Examples | Rule |
|---|---|---|
| **A. install/package coordinate** | `package.json` `name`, `files`, README install line, update-check `PLUGIN_PACKAGE` | **never change in this migration** |
| **B. GitHub URL** | `repository.url`, `homepage`, `bugs.url`, badges, doc links | **frozen in P1**; a P3 rename rewrites them in one commit |
| **C. human-facing product name** | README prose/hero, release-note headers, About text | **becomes `DSH Relay` in P1** |
| **D. protocol/config identifiers** | `cordis.patch.yml` entry ids (`dsh-ssh-tui/startup`, …), `TUI_SOURCE_KIND`, `DSH_TUI_*`, settings row names, log wrapper `kind`, error prefixes (`dsh-ssh-tui: …`), `@module dsh-ssh-tui/…` doc tags | **do not change**: they are stored in sessions, written into profile files and parsed back (see principle 9) |

The distinction that makes this safe: **C is what a human reads; A, B and D are what
a machine resolves.** P1 edits only C.

## Consequences

- Discovery improves without touching anyone's install: the repo and the package keep
  their coordinates, so no user action is created by the branding.
- The name in the CLI (`/diag`, `/doctor`, error prefixes) stays `dsh-ssh-tui`, which
  will look inconsistent with the README for the length of P2. Accepted: an error
  prefix is a searchable identifier that appears in bug reports, and renaming it
  would break the searchability of every existing report for a cosmetic gain.
- A GitHub rename (P3) can still happen later without an npm rename, because
  principle 6 keeps them independent.
- If P2 shows no discovery problem, P1 alone is a complete, self-consistent state —
  the migration costs nothing further.

## P1 deliverables (what "soft brand" ships, and where)

| Item | Where |
|---|---|
| README hero (both languages), demo, verification block, one CTA | `README.md`, `README.en.md` |
| Regenerable reconnect demo + npm script | `scripts/capture-reconnect.mjs`, `npm run screenshots:reconnect` |
| Verification numbers generated from a real run | `scripts/bench-report.mjs`, `npm run bench:report` |
| Package metadata: description + keywords | `package.json` |
| GitHub About / Topics suggestion (maintainer applies) | [`github-metadata.md`](../github-metadata.md) |
| Contribution path: terminal compatibility form | `.github/ISSUE_TEMPLATE/terminal-compatibility.yml` |
| Community-reported evidence, kept separate from CI evidence | [`terminals.md`](../terminals.md) |
| Release-notes sentence for 0.8.x | [`release.md`](../release.md) §三 |
| Observation template (no data invented) | [`brand-metrics.md`](../brand-metrics.md) |

## Not in this ADR

- Publishing a new npm package, deprecating `dsh-ssh-tui`, or changing the install
  command (all forbidden in P0/P1; P4 territory).
- Any product behaviour change. P1 touches documentation, npm metadata and assets
  only; `npm test`, `npm run freeze` and `npm run bench` must be unchanged by it.
