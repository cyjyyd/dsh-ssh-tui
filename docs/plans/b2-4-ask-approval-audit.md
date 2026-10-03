# B2.4 preflight audit — ask-user / approval authoritative sources

Read-only audit taken before any change (HEAD + B2.3c worktree, snapshot
`fc7cf575ed1d87f06ab86113416667be4461ed76`, tag `b2.3c-snapshot`).

## Ask-user

| field | source | durability | replayable |
|---|---|---|---|
| question callId | `tool/call.data.callId` (name `ask_user_question`) | durable (session log) | yes |
| question / header / detail / options / multiSelect | `tool/call.data.arguments` (JSON), read by `askQuestions()` (`plan.ts`) and by the harness's own `questionsOf()` | durable | yes |
| intent (`plan-review`) | `question.intent` in the **live request object**; dropped by both readers' mapping (`askQuestions`, harness `questionsOf`) | durable in raw args, **lost in both projections** | raw yes / projection no |
| active / continued / settled | `ctx.sessionProjections.stateOf(session, 'userQuestions')` — `@deepseek-ai/dsh-user-questions` folds `tool/call` + `tool/result` (+ `tool/ptc-dispatch`, late replies) | derived from durable events | yes |
| answer | `tool/result` content JSON (`{answers:[{id, selected[], custom?}]}`) or a late `user-question-reply` user message | durable | yes |
| continued question | projection `active[].state === 'continued'` (result was `{pending:true}` or `TOOL_OUTCOME_UNKNOWN`) | derived | yes |
| live request (no projection) | `ctx.on('user-questions/request')` waterfall → `handleUserQuestions(request)` | display-only | no |

Live shape today: a live ordinary ask draws **two** primary representations —
the generic `ask_user_question` tool card (`tool/call`, not in `HIDDEN_TOOL_NAMES`)
and the `question` card. `tests/question-fold.test.mjs` records this explicitly.

Plan-review is **not** an `ask_user_question` call: `@deepseek-ai/dsh-plan-mode`
asks from inside the **`exit_plan_mode`** tool's execute (`interaction.ask(...)`
with `intent.kind='plan-review'`, no `wait.callId`). Its question card is keyed
`live:<seq>` (not durable), which is the B2.5 identity problem.

## Approval

| field | source | durability | replayable |
|---|---|---|---|
| "approval required" | `approval/asked` — `{ id, toolName, callId?, reason? }`, appended by `@deepseek-ai/dsh-user-approval` `request()` | **durable** (session log, turn-enclosed audit pair) | yes |
| decision | `approval/decided` — `{ id, outcome }`, `outcome ∈ allowed-once / rejected / cancelled / unavailable` | **durable** | yes |
| manual approve/reject | returned from our `handleApproval` waterfall handler; the harness appends `approval/decided` | durable **as the event above**, nothing plugin-written | yes |
| auto approval (rule / cache / AI review / detached deny) | plugin-side `classifyApprovalDetailed` + `ApprovalVerdictCache` + `reviewUnknownWithModel`; the written trace is the same harness `approval/decided` pair | decision durable; plugin's own `approval-notice` row is **display-only** | decision yes / notice no |
| approval policy | `approval/policy` session event (`hostApprovalPolicy`, read for the mismatch warning); `ctx.get('settings')` for the plugin's own auto mode | durable event / settings | yes |
| tool result as evidence | a rejected approval yields a `tool/result` denial whose reason is `the user rejected tool "X"` / `approval for tool "X" was cancelled` (`dsh-tools`), and the tool never runs | durable | yes, but only as an *inference* |

Host death: `approval/asked` without `approval/decided` is the only surviving
fact — the outcome is **not** in the log, and the plugin keeps no second store.
Auto-approval verdicts (cache) live in memory only; nothing plugin-side is
persisted about a single decision. `/approval status` prints counters + policy
(a command report), not per-decision history.

## What B2.4 changed (summary for the checkpoint)

| semantic event | before | after |
|---|---|---|
| ordinary `ask_user_question` call | question card **+** generic tool card (two primaries) | **one** question card, built from the call's own arguments |
| an answered question | question card whose summary replaced the question | card carries question **→ answer** + state |
| approval required | nothing on the card; the plugin's own `approval-notice` row for auto decisions | `approval` field on the tool card, built from the Harness's `approval/asked` + `approval/decided` |
| auto allow / deny | transcript row (display) | footer chip (allow) / notice row (deny); the card carries the state |
| mid-turn message acknowledgement | footer chip (dropped first on a busy row) | notice row |
| resume | frames composed *during* the load, so the view rolled down | no frame until the log is read; one landing frame at the bottom |
| a working tick | force-repainted the composer row (the IME's pre-edit lives there) | forced repaint starts below the input block |
| Screen hint row | spliced a *styled* separator into a sanitised line → literal `[90m` | plain separator; the row is styled as a whole |
