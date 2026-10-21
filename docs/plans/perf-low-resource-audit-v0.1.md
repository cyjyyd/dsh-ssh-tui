# PERF-0 — Low-resource performance audit (v0.1)

> **Status: investigation only.** No optimization is implemented in this round and
> none is proposed as a change to `src/`. The numbers below were taken in the
> development sandbox (see §2.3); the maintainer's 1 vCPU / 1 GB server was **not**
> touched, so every server-shaped claim is marked `MEASUREMENT PENDING`.
>
> Baseline: `main` @ `83a8c7e`, version `0.8.4-rc.1`, host line `0.2.1-rc.2`.

---

## 1. The field report this audit is answering

The maintainer runs `0.8.4-rc.1` on:

- **1 vCPU, 1 GB RAM**, sharing the machine with OpenClaw (which must keep running);
- a **cross-border SSH link**, RTT roughly **100–300 ms**, sometimes worse;
- and reports the interaction as **basically satisfactory**.

That is the constraint, not a bug report. The goal is therefore: *find CPU/memory
work with a real payoff without breaking weak-link usability or the low-resource
footprint* — and to say honestly where the current evidence stops.

Two things this document will not do:

- it will not turn "1 GB is enough" into "the TUI uses N MB" (the number depends on
  the dsh runtime, the profile and the node build — §4.1);
- it will not treat a high RTT as evidence of CPU or rendering waste (§3.4).

---

## 2. What can be measured today

### 2.1 `scripts/bench-b2.mjs` — the only committed baseline

It drives a real `SshTui` **in process** (no PTY, no provider, no session file) and
reports, per action, the median of 40 runs:

| Scenario | What it exercises |
|---|---|
| `stream-tick` | one streamed delta while an answer arrives |
| `waiting-tick` | one repaint while the agent is busy (the wait card's clock) |
| `screen-scroll` | one PgDn inside a report Screen |
| `picker-move` | one ↓ in an open control-plane menu |
| `setup-typing` | one character into the wizard's field |

It reports **ms** (machine-local), **bytes written**, **addressed rows** and **full
clears** (the machine-independent contract). Last recorded run on this sandbox
(0.8.4-rc.1, 100×20):

```
stream-tick    1.68 ms   501 B    3 rows   0 clears
waiting-tick   1.13 ms   465 B    3 rows   0 clears
screen-scroll  1.40 ms  2457 B   17 rows   0 clears
picker-move    0.91 ms   588 B    4 rows   0 clears
setup-typing   0.19 ms   140 B    1 row    0 clears
```

### 2.2 What it does **not** cover

- cold boot (time, peak RSS);
- **idle** CPU, context switches (and, with a proper instrument, timer wakeups);
- composer typing at scale, and **completion** (the list is painted, never
  measured);
- long session / resume (replay cost, peak RSS);
- detach / reattach (does anything keep running?);
- memory at all — there is no RSS assertion anywhere in the repo;
- the 1 vCPU / 1 GB machine, and the OpenClaw co-tenant.

### 2.3 Measurements taken for this audit (sandbox, low load, non-invasive)

Environment: development sandbox, `node v24.20.0`, `@deepseek-ai/dsh` 0.2.1-rc.2,
locale `zh`, colour depth `truecolor`, throwaway profile (`.pf/rh`). Sampling was
`/proc` reads only — no profiler, no heap snapshot, no synthetic load. Commands are
kept in `.pf/perf-*.mjs` (not committed; they are scratch).

| What | How | Result |
|---|---|---|
| Idle CPU, 20 s window | `utime+stime` delta from `/proc/<pid>/stat` | frontend **0.05 %**, Host **0.10 %** of one core |
| Idle **context switches**, 20 s | `voluntary+nonvoluntary_ctxt_switches` delta | frontend **1.3/s**, Host **6.6/s** (not a timer-wakeup count — see §2.4) |
| Idle memory | `VmRSS`, `VmHWM`, `smaps_rollup` Pss | frontend **RSS 319 MiB / PSS 272 / private 261**; Host **RSS 333 / PSS 285 / private 273** |
| Bare node floor (same sandbox) | `node -e` reading its own status | RSS 59 MiB / PSS 24 MiB |
| dsh composition without the TUI | peak RSS polling of `--dump-config` and `--help` | **73.7 MiB / 176 ms** and **258.4 MiB / 7.5 s** (§4.1) |
| One paint, 100×20, transcript 200→8000 normal rows | in-process `captureFrame()` | **0.52 – 0.68 ms**, flat |
| One focus-ring arrow, 500→5000 rows (realistic mix) | in-process `dispatch('sequence','\x1b[A')` | **0.006 – 0.015 ms** |
| `collapsibleRows()`, same fixture | direct call | **0.001 – 0.002 ms** |
| One paint with a realistic mix, 500→5000 rows | `captureFrame()` | **0.76 – 0.78 ms**, flat |
| Paint with **67** suggestions vs none | `captureFrame()` | **0.61 vs 0.53 ms** → **+0.079 ms/frame** |
| Host command service, per paint | counting stub | **1 call per paint** while the draft starts with `/` |
| One ↓ with the list up | `arrowHistory(1)` | **0.0002 ms** (the *paint* is the cost) |
| Pathological all-`plan` transcript | `captureFrame()` at 5000 plan rows | **12.2 ms/frame**; focus arrow **5.5 ms** (§6, P2-4) |

**These are not the server's numbers.** A 1 vCPU shared box is slower per
millisecond and the node build differs; treat them as ratios and as a searchlight,
not as a benchmark of the field machine.

### 2.4 Two caveats about the instrument itself

**Context switches are not wakeups.** `voluntary_ctxt_switches` counts every
blocking transition (a `write` to the display socket, a `read` that waits, a timer
that fires), and `nonvoluntary_ctxt_switches` counts preemptions. Neither says how
often a timer woke the process, which is what "idle wakeups" usually means and what
a battery/idle-cost argument needs. A real wakeup count would need
`/proc/<pid>/schedstat`, `perf sched`, or a `timerfd`/`epoll` trace — none was used
here, so this document says **context switches** and draws no conclusion about
wakeup frequency. The CPU number (0.05 %/0.10 %) is the one that matters for idle
cost, and it is a direct measurement.

**The sampling scripts are not in the repository.** Every number in §2.3 came from
scratch scripts under `.pf/` (`perf-idle.mjs`, `perf-completion.mjs`,
`perf-scale.mjs`, `perf-focus.mjs`, `perf-mix.mjs`, `perf-mem.mjs`, `perf-peak.cjs`,
`esc-suggest*.mjs`), which are git-ignored and were not committed. They are the
author's sampling receipt — command, environment and process scope are recorded
above — but **a third party cannot re-run them from this repository**. The
reproducible artifacts are `scripts/bench-b2.mjs` (committed) and the measurement
plan in §5; anything that needs to be cited in a later round has to be promoted to
a committed script first.

---

## 3. CPU audit — where the cycles go

### 3.1 Idle

- The cadence timer is `setInterval(paintIntervalMs)` (`src/tui.ts:3071`). On an SSH
  link the interval is derived from the measured RTT: `<50 ms → 80`, `<150 → 160`,
  `<350 → 250`, else `400` (`src/paint.ts:105`). The maintainer's 100–300 ms link
  therefore ticks **4×/s**.
- The tick does work **only if `dirty`**: it early-returns otherwise
  (`src/tui.ts:3071-3104`, first line of the callback is cheap, the `render()` call
  is guarded by `if (this.dirty)`).
- The per-tick predicate is `this.rows.some(...)` (`src/tui.ts:3078`) — O(rows),
  once per tick, no allocation of note. At the 5000-row cap that is 5000 predicate
  calls × 4/s, which the measured 0.05 % already contains.
- Two more timers exist but are not periodic work: `waitForLiveDisplay`'s 200 ms
  poll exists only while a question waits for a display (`src/tui.ts:9214`,
  `unref()`d), and the feedback TTL is a one-shot.
- **Detach** stops the timer and the reader and removes every listener
  (`src/tui.ts:3323-3372`), so a detached session costs no paint CPU; the Host stays
  up by design.

**Conclusion:** idle is already near-zero (0.05 % measured). No P-level candidate
here. The one thing worth keeping an eye on is that `rows.some` runs whether or not
anything is animating; at 5000 rows it is inside the noise.

### 3.2 Streaming

- Each delta mutates state and calls `markDirty()`; the frame is composed on the next
  cadence tick, so a burst costs **one** frame, not one per delta — the coalescing
  the 0.8.x line already had.
- `bench-b2` `stream-tick` measures the frame a busy turn pays: 3 addressed rows,
  501 B, 0 clears, ~1.7 ms in this sandbox. The byte count is what travels on a
  100–300 ms link; the ms is local.
- Frame size is bounded by `frameByteBudget(linkQualityOf(...))`
  (`src/tui.ts:6937`), and rows that do not fit stay dirty (`paintResume`), which is
  the weak-link path.

**Conclusion:** streaming is already incremental and budgeted. No P0.

### 3.3 Completion (the one the brief flagged)

`buildSuggestions()` (`src/tui.ts:6981`) is called from the **frame composer**
(`src/tui.ts:6482`), once per paint, and it:

1. returns immediately unless `input.startsWith('/')` (cheap guard, good);
2. calls `ctx.get('commands')?.list(this.agent)` — **a host service call, per paint**;
3. maps every host command through `t()` (`cmd.${name}` with a fallback) and appends
   an attachments suffix — i.e. it **localizes every description on every paint**;
4. allocates the merged+sorted array (`commands.ts:76`).

Measured cost with a stub host list of 40 commands (67 items after the merge):
**+0.079 ms per frame**, i.e. ~15 % of a 0.53 ms paint. At 4 frames/s that is
0.3 ms/s — invisible. The unknown is step 2 with the **real** host service, which
this sandbox cannot profile from outside; on a 1 vCPU box it is the part that could
grow.

Also note the interaction with W-4A: the same code is the reason the suggestion
list is *derived state written during paint* (see the design doc, D1). Any cache
added here must not recreate that — a cache is only acceptable with a generation
key and a locale key.

**Conclusion:** no measured problem, one unbounded call site (host `list()`), and a
cheap improvement path. P2, with a measurement first.

### 3.4 Weak network — what is *not* a CPU problem

The link's contribution is: **RTT** (a keystroke's echo cannot be faster than one
round trip), the **cadence** it selects (250–400 ms), the **bytes per frame**, and
the terminal's own throughput. A 200 ms RTT costs latency, not CPU: this process
still composes 0.5–0.8 ms frames. Conversely, lowering CPU would not lower the
RTT — the two must not be conflated when reading the maintainer's report.

The one place they interact: a frame that is *too big* delays the next one through
the backlog guard (`outputBacklogged`, `src/tui.ts:7187`), which is a bandwidth
effect and is already budgeted.

---

## 4. Memory audit

### 4.1 Process boundary, and why "the TUI's memory" is the wrong question

`src/index.ts` splits the two processes by `isTuiHostProcess()`
(`display-sock.ts:221`, the `DSH_TUI_HOST` environment variable):

- the **frontend** is the process a reader's terminal is attached to. It runs the
  dsh CLI and this plugin, but it does **not** mount the TUI: `start()` takes the
  `if (!hostProcess)` branch, writes the splash and calls
  `spawnHostAndRelay()` (`src/index.ts:417`). It draws the boot splash and, later,
  the session picker, and it carries the display relay;
- the **Host** is spawned with `DSH_TUI_HOST=1` (`display-sock.ts:1347`); it mounts
  `SshTui` (`src/index.ts:656`, `mountTui` with `headlessDisplay: true`) and owns
  the agent, the session and the painting.

So **the TUI lives in the Host**, and the frontend is the launcher plus the relay.
Measured at idle in the sandbox (PSS is the honest per-process number; RSS sums are
not):

```
frontend (launcher + relay, no Tui)   PSS 271.9 MiB  (private 261.1)   CPU 0.05 %   1.3 ctxt switches/s
Host     (runtime + SshTui + session) PSS 284.6 MiB  (private 272.8)   CPU 0.10 %   6.6 ctxt switches/s
```

Neither number may be attributed to this plugin as a whole, and this audit does not
try: the breakdown below bounds only the *plugin-held* state, and the process
totals belong to their compositions.

| Component | Evidence | Approximate cost |
|---|---|---|
| Bare node | `node -e` self-report | PSS 24 MiB |
| dsh composing the profile, no TUI loop | peak RSS of `--dump-config` | **73.7 MiB / 176 ms** |
| dsh CLI loading a heavier entry point | peak RSS of `--help` | **258.4 MiB / 7.5 s** |
| **This plugin's transcript state** | in-process fixture: 500 → 5000 rows | **+7 MiB**, heapUsed ~22 MiB |
| Frames | `lastPaintRows` ≤ terminal height | a few KiB |
| Suggestions | 67 items × name+description | a few KiB |

What that supports: the plugin's own row/frame/suggestion state is small and
bounded, so it is not where a memory hunt should start. What it does **not**
support: a claim about how the Host's or the frontend's ~270 MiB splits between the
dsh runtime, the CLI surface, node itself and this plugin's code — that needs a
heap-level measurement inside each process (§5, and `MEASUREMENT PENDING`).

`MEASUREMENT PENDING`: the same numbers on the 1 vCPU / 1 GB machine, with OpenClaw
running, are the ones that would matter. They must be taken as `Pss` (not RSS
sums), with the two roles labelled as above, and with the Host's heap broken down
before any conclusion about attribution.

### 4.2 Growth paths inside the plugin

| Structure | Bound | Evidence |
|---|---|---|
| `rows` (transcript) | **5000 rows**, oldest dropped (`rows.ts:17`, `tui.ts:4201`) | cap enforced on append, `MAX_TRANSCRIPT_ROWS` |
| `history` (submitted messages) | **unbounded** — one string per submitted message (`tui.ts:1732`) | not capped; ~200 B per message → 2 MB per 10k messages |
| `lastPaintRows` / `paintResume` | terminal height | `tui.ts:2418` |
| `commandSuggestions` | catalog size | rebuilt per paint (`tui.ts:6482`) |
| `lineModePending` | until a display attaches | `writeLineMode` |
| `session` events | **not** in the frontend; the Host owns the session and its log | — |
| decoders / buffers | one `StringDecoder` per input path | `input-reader.ts`, `terminal-input.ts` |

`/clear` sets `clearedRows` and does not free the array; after it, every paint calls
`this.rows.slice(clearedRows)` (`tui.ts:4913`) — an O(rows) copy per frame until the
rows are re-bounded. That is a small, real, easily measured cost (P2-3).

### 4.3 Detach / reattach

`detachDisplay()` stops the render timer, the reader, and every listener, and
restores the terminal (`tui.ts:3323`). It does **not** drop `rows` or the frame
caches — deliberate, because a reattach repaints from them. The measured idle CPU
above is for an attached session; a detached one should be lower (no timer), which
is `MEASUREMENT PENDING` (cheap to add to the plan, §5).

---

## 5. Measurement plan (for a later round, not this one)

Every row is designed to run in a **throwaway profile**, on the dev box and — with
the maintainer's explicit permission and while OpenClaw keeps running — for a short,
low-load window on the server.

| Scenario | Method | Observe |
|---|---|---|
| Cold boot | `probe-home` throwaway home, wall clock from spawn to first idle frame; peak RSS by 20 ms polling | time-to-first-frame, peak RSS of both processes |
| Idle | 60 s window, `/proc` deltas as in §2.3 | CPU %, **context switches/s** (a wakeup count needs `schedstat` or `perf sched`, §2.4), PSS, **detached vs attached** |
| Composer typing | in-process fixture (bench-b2 shape): 1 char, 10 chars, paste 1 kB | per-keystroke ms, painted rows, bytes |
| Completion visible | input `/` and `/se` with a **real** host command service, 200 paints | paint ms, `list()` calls per paint, `list()` duration (instrumented once, then reverted) |
| Streaming | `bench-b2` + a real mock turn | ms, bytes, rows, clears per tick |
| Long session / resume | replay a 5000-row session, then paint | replay time, peak RSS, paint ms before/after the cap |
| Detach / reattach | `tui-drop-probe` shape | residual timers, CPU while detached, reattach cost |
| Server (optional) | 5-minute sample, no load generation | PSS of both processes, idle CPU, `--dump-config` peak |

Rules for that round: no profiler or heap snapshot on the shared server without a
second authorization; no synthetic load while OpenClaw runs; every number recorded
with command, environment, process scope and sample count.

---

## 6. Optimization candidates (max five)

Ranking is evidence-first: **P0** measured significant problem · **P1** clear
hotspot, worth an experiment · **P2** real but not worth doing now.

**P0: none.** No measured CPU or memory problem crossed a threshold that would
justify touching runtime code in this line.

| # | Candidate | Evidence today | Hypothesis | How to verify | Payoff | Risk | W-4A? | Verdict |
|---|---|---|---|---|---|---|---|---|
| P2-1 | **Host `commands.list()` + localization per paint** (`tui.ts:6981`) | 1 call/paint, +0.079 ms/frame with a stub | a real `list()` is more expensive than the stub; 4 frames/s × N commands | instrument one boot to time `list()`; then a keyed cache (`draft`, locale, `commands/change` revision — see W-4A §5.4) | CPU (small), latency (none) | stale suggestions if a generation is missed — the exact D1 shape | yes: W-4A moves the *derivation*, not a cache | measure first; **do not** add a cache in W-4B |
| P2-2 | **`collapsibleRows()` per arrow** (`tui.ts:4225`) | 0.002 ms (mix) → 0.13 ms (all-plan) at 5000 rows | O(n) per arrow, only when cards exist | memoize by `(rows.length, revision)` | CPU (negligible) | invalidation bugs for zero gain | no | not worth it |
| P2-3 | **`visibleRows()` slice per paint after `/clear`** (`tui.ts:4913`) | O(rows) copy per frame while `clearedRows > 0` | a long session that used `/clear` pays a copy per frame | return an iterator/subarray, or compact on clear | CPU/RAM (small) | touching a hot path for a rare state | no | leave; note it |
| P2-4 | **Plan dock scaling with plan rows** | pathological fixture: 12.2 ms paint / 5.5 ms focus at 5000 plan rows; 0.78 ms with a realistic 1-in-50 mix | the dock scans plan rows | cap the dock to the newest N plans | CPU (only in a pathological session) | hides history if N is too small | no | guard with a test, not an optimization |
| P2-5 | **Two-process memory** (frontend 272 MiB + Host 285 MiB PSS in the sandbox; the Host is the one running `SshTui`, §4.1) | `--dump-config` alone is 73.7 MiB, `--help` 258 MiB; the plugin's own rows measured at ~7 MiB | the split between dsh runtime, CLI surface and this plugin is unmeasured on either process | the §5 server sample, with a heap breakdown per role | RAM (potentially the only big lever) | outside this repo, and not attributable yet | no | report to the host, do not "optimize" here |

Deliberately **not** listed: a transcript page cache, compression of rows, lazy i18n,
or a smaller frame budget on weak links. None has evidence, and the last one would
trade the maintainer's satisfactory interaction for bytes.

---

## 7. What cannot be concluded from this evidence

1. **The server's CPU/RSS.** Everything here is a sandbox with a different node
   build and no OpenClaw co-tenant. The 1 vCPU / 1 GB numbers are
   `MEASUREMENT PENDING`.
2. **That the TUI "uses" ~270 MiB.** The Host's 285 MiB PSS is the runtime, the
   session and the TUI together; the frontend's 272 MiB does not run the TUI at
   all. The plugin's own row state measured at the 5000-row cap is ~7 MiB, which
   bounds that state and nothing else.
3. **That the real host `commands.list()` is cheap.** The stub says the plugin-side
   work is 0.08 ms/frame; the host call is unmeasured.
4. **That a cache would help.** Not measured, and the invalidation risk is the same
   class of bug W-4A is removing.
5. **That high RTT means inefficiency.** RTT is latency; the frames here are
   sub-millisecond and incremental.
6. **That memory is stable over days.** The 20 s idle window says it is stable over
   20 s; the caps say it should be bounded; neither is a soak test.

---

## 8. What this round did not change

No source, test, script, manifest, lockfile, CI or workflow change. No optimization
implemented, no load generated on the maintainer's server, no profiler attached to a
shared machine.
