# B2.5 preflight audit — Plan authoritative sources

Read-only audit, taken before any change. Verified against the installed Harness
line (`@deepseek-ai/dsh` 0.1.7 forms line) and this checkout at the B2.3c snapshot
(`fc7cf575ed1d87f06ab86113416667be4461ed76`, tag `b2.3c-snapshot`).

## 1. Producers (who writes what)

| event | producer | payload | durable | replayable | identity | revision |
|---|---|---|---|---|---|---|
| `plan/mode` | `@deepseek-ai/dsh-plan-mode` (`set()` between turns, `onBoundary()` at a step boundary) | `{ active: boolean }` | yes | yes | event `seq` | — |
| `todo/write` | `@deepseek-ai/dsh-tool-todo` (`todo_write` execute) | `{ todos: [{content,status}] }` — whole-list replacement | yes | yes | **event `seq` only** (the tool call's `callId` is *not* on the event) | event `seq` |
| `exit_plan_mode` `tool/call` | tool registry | `arguments = { plan: "# …" }` | yes | yes | `callId` | — |
| `exit_plan_mode` `tool/result` | tool registry | success = approved; error = refused | yes | yes | matches `callId` | — |
| plan-review question | `dsh-plan-mode` → `ctx.get('userQuestions').ask(...)` **inside** that tool call | question + `intent.kind='plan-review'` + `detail` (the plan) | **NO** | no | — | — |
| `command/run` / `command/done` (`name: 'plan'`) | commands service | `{ commandId, name, args }` / `{ commandId, kind }` | yes | yes | `commandId` | — |
| `approval/asked` / `approval/decided` | `@deepseek-ai/dsh-user-approval` | see B2.4 | yes | yes | `id`, `callId` | — |
| subagent plan | the child's own session; the parent folds it into the subagent card | — | child log only | yes | child session id | — |

Harness-side projections that already exist: `plan` (`{active, wanted, running, activeAtLastHeader}`),
`todos` (`TodoItem[] | null`, **cleared by the next `turn/start`**), `turnBoundary`.

## 2. Field coverage

| field | authoritative source | durable | replayable | identity | revision |
|---|---|---|---|---|---|
| active / inactive | `plan/mode.active` | yes | yes | seq | — |
| pending (a mode switch queued for the next step) | `command/run{name:'plan'}` + `command/done`, or an in-turn `plan/mode` at the boundary | yes | yes (derivable) | `commandId` | — |
| plan body | `exit_plan_mode` `tool/call.arguments.plan` | yes | yes | `callId` | — |
| steps | `todo/write.todos` (latest snapshot wins) | yes | yes | seq | seq |
| step status | same snapshot | yes | yes | seq | seq |
| review requested | **only** the live `interaction.ask` — the tool call is the durable trace | the *call* is; the ask is not | yes (as "the tool was called") | `callId` | — |
| approved | `exit_plan_mode` `tool/result` with no error | yes | yes | `callId` | — |
| rejected | `exit_plan_mode` `tool/result` **error**, text `The user chose to keep planning…` / `…dismissed the plan review…` | yes | yes | `callId` | — |
| abandoned | `plan/mode{active:false}` with the review unresolved/incomplete steps → **inferred** | the mode event is | yes | seq | — |
| completed | latest `todo/write` with every step `completed` → **inferred** from the durable snapshot | yes | yes | seq | — |
| revision | every `todo/write` `seq` | yes | yes | — | yes |
| identity | **not carried anywhere** — derived below | — | — | — | — |

## 3. The two gaps (measured, not assumed)

**Gap A — `intent.kind='plan-review'` is not durable at all.**

`dsh-plan-mode` asks with `interaction.ask({ questions: [{ …, intent: { kind: 'plan-review', … } }], agent, signal })`
(plan-mode `lib/index.js` ~line 262). `UserQuestionService.ask()` appends **nothing**
to the session — only the `ask_user_question` *tool* has a durable `tool/call`/`tool/result`
pair. So the brief's premise ("durable raw args carry the intent") does not hold for
this host line: there is no durable question at all for a plan review.

The intent is therefore **not recoverable from the log** — but it does not need to be:
the review *is* the `exit_plan_mode` tool call, whose `callId` and `{plan}` arguments
are durable. Replay can identify a plan review from that anchor, which is exactly what
B2.4 could not do from the question alone. **No protocol extension is needed for identity.**

**Gap B — no plan identity and no link between a todo list and a review.**

Nothing in the log names a plan. The current UI derives "the plan" from display order:
`planIsLive(row)` + `archiveStalePlans(keep)` (see `src/plan.ts`), i.e. the newest live
row wins and every other row is archived. That is a renderer-held truth (forbidden by
AD-15) and it is what makes "two plans in one session" and "a plan across several
turns" ambiguous.

Derivable, deterministically, from durable events alone:

- an **episode** opens at `plan/mode{active:true}` (plan-mode episode) or at the first
  `todo/write` of a turn (a standing todo list — the harness clears its own `todos`
  projection at `turn/start`, so a turn's first write is a new list by the Harness's
  own definition);
- it closes at `plan/mode{active:false}`, or when a later `todo/write` starts a new list;
- **identity** = `plan@<seq of the opening event>` — session-local, deterministic, no
  UUID, no clock, no row index;
- **revision** = `plan@<seq>#<seq of that todo/write>`; the review's revision is the
  `exit_plan_mode` call that reviewed the then-current list.

Two plans in one session, and one plan across several turns, both come out distinct and
stable under replay. What cannot be recovered: a plan's *own* name/title beyond its body
heading, and any state the events do not state (see Gap C).

**Gap C — `completed` and `abandoned` are inferences, not facts.**

No event says "this plan was completed" or "abandoned". The only durable facts are the
last `todo/write` snapshot (all steps completed?) and the mode transitions. Following
B2.4's rule, those two states are marked `inferred` in the projection and never
presented as if the session had said so.

## 4. Conclusion: projection is possible, no extension proposed

- identity/revision: derivable deterministically (Gap B).
- plan-review recognition on replay: via the `exit_plan_mode` call anchor (Gap A).
- terminal states: `approved` / `rejected` are durable; `completed` / `abandoned` are
  inferred and labelled; everything else unknown.
- No new durable event, no plugin-side persistence, no plan file.

A durable protocol extension would only be needed to (a) name plans and (b) record
"plan completed/abandoned" as facts. Both are Model-facing protocol decisions, not
representation ones, and neither is required for the representation model below — so
per §21 this audit stops at the design conclusion and proposes nothing.

## 5. The dock/live-tail conflict (measured before the change)

`paintFrame` composes: header → transcript → **live region** → plan dock → composer.
The dock already reserves its rows and the live region is capped to
`contentBudget - MIN_TRANSCRIPT_ROWS` (B2.4), so the tail cannot cover the dock today.
What is missing is the *degradation contract*: the dock has one shape (FULL) and one
cap (half the workspace), and there is no MINIMAL state for a very short terminal.

## 6. What B2.5 built

- `src/plan-projection.ts` — a pure fold: durable events → `PlanArtifact[]`, with
  `id = plan@<seq that opened it>`, `revision = plan@<openSeq>#<todo/write seq>`,
  `state ∈ draft|reviewing|approved|rejected|executing|completed|abandoned|unknown`,
  and a `provenance` per state so an inference is never read as a fact.
- The TUI keeps only the event log and refolds; **one row per artifact** (reference),
  one dock (the live artifact's view), one Surface (the review), and one lifecycle line
  per settled transition. `upsertPlanRow`, `archiveStalePlans`-by-display-order and the
  generic `exit_plan_mode` tool card are gone from the plan path.
- The dock degrades FULL → COMPACT → MINIMAL, and the live region is clipped above it.
- A plan review no longer draws a question card: the artifact's row and state are its
  transcript representation (the Surface still asks).
- Reported regression fixed: an acknowledgement the footer's stats row could not fit is
  now shown on the identity row instead of vanishing.

## 7. Remaining durable gaps (reported, no extension implemented)

1. **No plan id/name in the log.** Derived from event order (deterministic, replay-stable),
   but a *renamed* plan or two plans opened by the same event (impossible today) would be
   ambiguous. A `planId` on `plan/mode` and `todo/write` would remove the derivation.
2. **No durable "completed"/"abandoned".** Both are inferred (all steps completed; mode left
   with an unresolved plan) and labelled `inferred`. A lifecycle event would make them facts.
3. **The review question is not durable.** Its identity is the `exit_plan_mode` call, which is
   enough for replay, but the *question text/options* exist only live: a replay shows the plan
   and the outcome, not the exact wording the Host asked with. `intent` never reaches the log
   (`UserQuestionService.ask` appends nothing); nothing needs it now, since the tool call is
   the anchor.
