# Brand metrics: the observation window (template)

**This file is a template plus a definition. It contains no data yet, and no number
here may be invented.** The maintainer fills it from GitHub Insights and npm's
download endpoint, on the cadence below.

Why the numbers live in a file and not in a dashboard: the decision this serves is
whether the P3 relaunch (see [`decisions/brand-dsh-relay.md`](decisions/brand-dsh-relay.md))
is worth its cost, and that decision has to be reconstructable later from the repository
alone.

## Definitions (fix these before collecting anything)

| Metric | Definition | Source |
|---|---|---|
| `visitors14d` | Unique visitors, last 14 days | GitHub → Insights → Traffic |
| `views14d` | Total views, last 14 days | same page |
| `stars` | Total stars | repository page |
| `forks` | Total forks | repository page |
| `referrers` | Top 5 referrers with counts | Insights → Traffic → Referring sites |
| `popular` | Top 5 popular content paths | Insights → Traffic → Popular content |
| `npm7d` | Rolling 7-day downloads | `npm view dsh-ssh-tui` / registry downloads API |
| `reports` | Terminal compatibility reports received | issues labelled `terminal-compatibility` |
| `discussions` | Interactions on issues/PRs from non-maintainers | issues + PRs, counted by hand |

**Star conversion** = `new stars in the window / unique visitors in the window`.
It is the one derived number worth tracking: it separates "more people see it"
(discovery) from "the people who see it care" (fit). Report it as a percentage with
the raw pair beside it, e.g. `12 / 340 = 3.5%`.

## Reading the table

- **Discovery problem** (P3 candidate): visitors grow, star conversion stays flat, and
  referrers are dominated by searches for the *old* name (`dsh-ssh-tui`, "ssh tui").
- **Fit problem** (P3 does *not* help): visitors are flat, conversion is fine, and the
  issues are about the product rather than about finding it.
- **No signal yet**: fewer than ~50 unique visitors per window. Do not decide anything
  from a sample that small — extend the window instead.

## The log

One row per collection. Copy the row and fill it; do not rewrite history when a number
turns out to be wrong — add a note to the row instead.

| date | window | visitors14d | views14d | stars | forks | npm7d | reports | discussions | star conversion | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| _yyyy-mm-dd_ | _14d_ | | | | | | | | | _what changed this window (release, post, README change)_ |

### Referrers (per collection)

| date | #1 | #2 | #3 | #4 | #5 |
|---|---|---|---|---|---|
| | | | | | |

### Popular content (per collection)

| date | #1 | #2 | #3 | #4 | #5 |
|---|---|---|---|---|---|
| | | | | | |

## Collection cadence

- **Weekly** while a release is in flight or a post is circulating: the traffic curves
  decay within 24–48 h, and GitHub only keeps 14 days of history — a missed week is a
  hole that cannot be filled in later.
- **Otherwise every two weeks**, which is also the window GitHub reports over.
- **Always at release time**, in the same commit that writes the release notes: that is
  the one moment where the before/after is worth having.

## What this file must never contain

- No telemetry and no analytics added to the product for any of these numbers. They all
  come from GitHub's and npm's own traffic pages, which the maintainer reads by hand.
- No personal data about reporters: issue counts only, never identities.
