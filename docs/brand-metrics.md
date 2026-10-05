# Brand metrics: the observation window (template)

**This file is a template, a definition, and — since P1.1 — the frozen observation
contract for phase P2. It contains no data yet, and no number here may be invented.**
The maintainer fills it from GitHub Insights and the official npm Downloads API, at the
collection points defined below.

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
| `npm7d` | Rolling 7-day download **point total** for the package | the official npm Downloads API, and nothing else — see below |
| `reports` | Terminal compatibility reports received | issues labelled `terminal-compatibility` |
| `discussions` | Interactions on issues/PRs from non-maintainers | issues + PRs, counted by hand |

**Star conversion** = `new stars in the window / unique visitors in the same window`.
Report it as the raw pair plus the percentage, e.g. `12 / 340 = 3.5%` — the pair first,
because a percentage over a small denominator is noise (`1 / 30 = 3.3%` is not evidence of
anything).

### `npm7d`: exactly one source

```
https://api.npmjs.org/downloads/point/last-week/dsh-ssh-tui
```

That is the **official npm Downloads API**, `point` endpoint, `last-week` range — one
number for the whole package, over a rolling seven days. Reproducible as:

```sh
curl -s 'https://api.npmjs.org/downloads/point/last-week/dsh-ssh-tui'
# {"downloads":1234,"start":"2026-09-27","end":"2026-10-03","package":"dsh-ssh-tui"}
```

Two rules, so that every window is comparable with every other one:

1. **`npm view` is not a source for this number.** The CLI prints a *per-version breakdown*
   (and different versions of npm have printed it in different shapes); it is useful for
   "did anything download at all", it is not a rolling total, and mixing the two口径（measurement convention）
   silently breaks the series. Use the endpoint, and record the ISO range it returned
   (`start` / `end`) alongside the number — the window moves, so the row must say which
   seven days it covers.
2. **Never estimate, never interpolate.** If the API is unavailable at collection time,
   write `n/a` in the cell and say so in the notes; a missing point is recoverable, an
   invented one is not.

## Reading the table: discovery and conversion are two axes

Discovery and conversion answer different questions and must not be collapsed into one
verdict. Discovery is: *how many people found the repository*. Conversion is: *of those,
how many did something that says it fit them* — a star, a compatibility report, a
non-maintainer comment or PR.

| Axis | Read from |
|---|---|
| **Discovery** | `visitors14d`, `views14d`, referrer composition, popular content |
| **Conversion** | new stars / `visitors14d`, compatibility reports, non-maintainer interactions |

Everything below is read off those two axes. The cases are written with the traffic a
brand change can plausibly move; they are not a scoring rubric.

### Case A — visitors ↑ and conversion ↑

The showcase and the brand change are working: more people arrive *and* a larger share of
them engage. **P3 (repo rename) may enter the candidate discussion** — and note that even
here the rename is a candidate, not a conclusion: it still has to beat "write more of what
worked".

### Case B — visitors ↑ but conversion flat or down

Discovery improved; the *landing* did not. This is explicitly **not** a rename signal:
rename changes the name on the door, and the door is already being walked through. Work on
what the visitor finds — the README's first screen, the demo, install friction — and keep
measuring.

### Case C — visitors flat or down, conversion healthy

The people who arrive like it; too few arrive. This is mostly a **discovery** problem:
technical posts, external references, being findable on GitHub search are all worth testing
before touching the repository identity.

### Case D — visitors flat, conversion flat, npm downloads strong

The most likely reading is that **npm usage and GitHub engagement are not wired together**:
installations happen through package managers, badges and other people's configs, and those
users never see the repository page. Do not reach for a repo or npm identity change to
chase stars — the number that matters (downloads) is already healthy.

### Rename-specific evidence (the only thing that makes P3 worth it)

A repo rename has a real cost — every existing link, badge, issue URL and search result —
so it is judged on signals *about the name*, not on traffic shape:

- referrers / search terms are visibly limited by the old name (`dsh-ssh-tui`,
  "ssh tui" queries landing on the repo);
- readers keep arriving with the same misunderstanding — "this is only for SSH" — and it
  traces back to the name rather than to the README's wording;
- `DSH Relay` shows up in the wild on its own: other people's posts, configs, links;
- external articles and links start using `DSH Relay` and then have to explain that the
  repo is called something else.

**Not** sufficient: "visitors grew and conversion was flat". That is Case B, and Case B is
a landing problem.

### No signal yet

Fewer than ~50 unique visitors in a window: do not conclude anything from it, and do not
start a case. Extend the window and keep collecting.

## The log

One row per collection. Copy the row and fill it; do not rewrite history when a number
turns out to be wrong — add a note to the row instead.

| point | date | window | visitors14d | views14d | stars | forks | npm7d (range) | reports | interactions | star conversion | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `T0` | _yyyy-mm-dd_ | _14d_ | | | | | | | | | _what was live on this day; see the T0 note rule_ |
| `T1` | _T0+7d_ | _14d_ | | | | | | | | | |
| `T2` | _T0+14d_ | _14d_ | | | | | | | | | |

### Referrers (per collection)

| date | #1 | #2 | #3 | #4 | #5 |
|---|---|---|---|---|---|
| | | | | | |

### Popular content (per collection)

| date | #1 | #2 | #3 | #4 | #5 |
|---|---|---|---|---|---|
| | | | | | |

## P2 observation contract (frozen)

**The window.** Minimum **14 days**; preferred **2–4 weeks**. Shorter than 14 days is not a
window — GitHub's own traffic view is 14 days wide, and a week of a release spike tells you
nothing about whether the brand change mattered.

**Collection points.** A point is a full row in the log, taken on the day it is stamped:

| Point | When | Why |
|---|---|---|
| `T0` | the day this contract lands (baseline) | everything after is compared with it |
| `T1` | `T0 + 7d` | early movement only; **not** a decision point |
| `T2` | `T0 + 14d` | the first point a case may be read from |
| `T3` / `T4` | optional, `+21d` / `+28d` | only if T2 is ambiguous or a release lands mid-window |

**Every point records**: `date` · `visitors14d` · `views14d` · `stars` (total) · `forks`
(total) · `npm7d` (+ the ISO range the API returned) · top 5 referrers · top 5 popular
content · compatibility reports received · non-maintainer interactions · notable events in
the window (see below).

**Stars are recorded as totals, and the delta is computed between rows** — GitHub does not
expose a per-window star series, so the difference between two collections is the only
honest source, and it is why a missing point cannot be reconstructed later.

**Releases are allowed and must be marked.** Shipping 0.8.x maintenance during P2 is
expected; when one lands, the row's notes field records:

- release date and version (e.g. `2026-10-12 · 0.8.2-rc.2`);
- any external announcement (post, comment, list, chat) with where it went;
- anything else that could move traffic (a link from a popular repo, a directory listing
  change).

Without that, a later reader sees a spike and cannot tell a release from a rename
experiment from noise.

## T0 timing: record what is true, not what is tidy

T0 is collected by the maintainer, and its meaning depends on which changes were already
live on that day. The log's `notes` field is where that is written down — one line is
enough, and this is the shape to use:

> `T0 was collected after the DSH Relay README soft-brand landed, but before GitHub
> About/Topics were updated.`

**Adjust that sentence to the real sequence before recording it** — as of 2026-10-05 the
repository API reports the About description, the topic list and the website field as
**already applied** (see [`github-metadata.md`](github-metadata.md)), so "before
About/Topics were updated" is probably no longer true for a T0 taken today. The point of the
note is that a later reader must be able to tell T0 apart from a pure pre-brand baseline.

**Never invent any of these numbers.** Not views, not visitors, not referrers, not a star
delta, not `npm7d`. A fabricated baseline is worse than no baseline: every later comparison
would inherit it. `n/a` plus a note is always the correct answer for a number nobody read.

## What this file must never contain

- No telemetry and no analytics added to the product for any of these numbers. They all
  come from GitHub's and npm's own traffic pages, which the maintainer reads by hand.
- No personal data about reporters: issue counts only, never identities.
