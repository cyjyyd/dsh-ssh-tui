/**
 * The plan artifact fold (B2.5).
 *
 * The projection is the only place plan state is decided, so these cases drive it
 * with durable event sequences and check two things at once: what it says, and that
 * it says the same thing on a replay. Ids and revisions are derived from event order,
 * which is what makes that equality possible at all — nothing random, nothing timed,
 * nothing read off a rendered row.
 *
 * The event shapes are the ones the installed Harness writes (see
 * `docs/plans/b2-5-plan-artifact-audit.md`): `plan/mode` from the plan-mode service,
 * `todo/write` from the `todo_write` tool, and the `exit_plan_mode` call/result pair
 * whose arguments carry the plan body and whose result carries the review's outcome.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { artifactIsLive, artifactProgress, foldPlanArtifacts, livePlanArtifact, reviewRefusal } from '../lib/plan-projection.js'

const MODE_ON = seq => ({ type: 'plan/mode', seq, data: { active: true } })
const MODE_OFF = seq => ({ type: 'plan/mode', seq, data: { active: false } })
const WRITE = (seq, todos) => ({ type: 'todo/write', seq, data: { todos } })
const CALL = (seq, callId, plan) => ({
  type: 'tool/call', seq, data: { name: 'exit_plan_mode', callId, arguments: JSON.stringify({ plan }) },
})
const RESULT = (seq, callId, text, isError = false) => ({
  type: 'tool/result', seq, data: { message: { source: { callId }, content: [{ type: 'text', text }], isError } },
})
const steps = (...statuses) => statuses.map((status, index) => ({ content: `第 ${index + 1} 步`, status }))

const APPROVED = 'Plan approved — plan mode exited; carry out the plan starting with your next step.'
const REFUSED = 'The user chose to keep planning; revise the plan and present it again.'
const REFUSED_WITH_FEEDBACK = 'The user chose to keep planning; their feedback: 加上回滚步骤'
const DISMISSED = 'The user dismissed the plan review to speak instead; stay in plan mode, stop here, and wait for their message.'

// ── A. identity and revision ────────────────────────────────────────────────

test('a plan is identified by the durable event that opened it, not by display order', () => {
  const artifacts = foldPlanArtifacts([MODE_ON(7), WRITE(9, steps('pending'))], { live: true })
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0]?.id, 'plan@7', 'the mode event is the anchor')
  assert.equal(artifacts[0]?.openSeq, 7)
  assert.equal(artifacts[0]?.openedBy, 'plan-mode')
})

test('the same log folds to the same ids and revisions, live or replayed', () => {
  const events = [
    MODE_ON(1), WRITE(2, steps('in_progress', 'pending')), CALL(3, 'exit-1', '# 计划'),
    RESULT(4, 'exit-1', REFUSED_WITH_FEEDBACK, true), WRITE(5, steps('pending', 'pending')), CALL(6, 'exit-2', '# 计划 v2'),
    RESULT(7, 'exit-2', APPROVED), MODE_OFF(8),
  ]
  const live = foldPlanArtifacts(events, { live: true })
  const replay = foldPlanArtifacts(structuredClone(events), { live: false })
  assert.deepEqual(replay, live, 'a resume reads the same artifact')
  assert.equal(live[0]?.id, 'plan@1')
  assert.deepEqual(live[0]?.revisions.map(revision => revision.id), ['plan@1#2', 'plan@1#5'])
})

test('every todo snapshot is a revision, and the latest one is what the artifact shows', () => {
  const artifacts = foldPlanArtifacts([
    MODE_ON(1), WRITE(2, steps('pending')), WRITE(3, steps('in_progress', 'pending')), WRITE(4, steps('completed', 'in_progress')),
  ], { live: true })
  const [plan] = artifacts
  assert.deepEqual(plan?.revisions.map(revision => revision.seq), [2, 3, 4])
  assert.deepEqual(plan?.steps.map(step => step.status), ['completed', 'in_progress'])
})

test('two plans in one session stay two artifacts', () => {
  const artifacts = foldPlanArtifacts([
    WRITE(1, steps('completed')),
    WRITE(2, steps('in_progress', 'pending')), WRITE(3, steps('completed', 'completed')),
    WRITE(4, steps('pending')),
  ], { live: true })
  assert.deepEqual(artifacts.map(artifact => artifact.id), ['plan@1', 'plan@2', 'plan@4'])
  assert.deepEqual(artifacts.map(artifact => artifact.revisions.length), [1, 2, 1])
  assert.equal(livePlanArtifact(artifacts)?.id, 'plan@4', 'the dock is the newest live one')
})

test('a revision never becomes a second artifact, and a new plan never inherits the old steps', () => {
  const artifacts = foldPlanArtifacts([
    MODE_ON(1), WRITE(2, steps('pending')), WRITE(3, steps('in_progress', 'pending')),
  ], { live: true })
  assert.equal(artifacts.length, 1, 'plan mode holds the artifact open across revisions')
  assert.equal(artifacts[0]?.id, 'plan@1')
  const [first, second] = foldPlanArtifacts([WRITE(1, steps('completed')), WRITE(2, steps('pending'))], { live: true })
  assert.equal(second?.steps.length, 1, 'the new plan starts from its own snapshot')
  assert.equal(first?.steps[0]?.status, 'completed')
})

// ── B. review ──────────────────────────────────────────────────────────────

test('the review is the exit_plan_mode call, and its body is the durable plan', () => {
  const artifacts = foldPlanArtifacts([MODE_ON(1), WRITE(2, steps('pending')), CALL(3, 'call-7', '# 计划\n- 甲')], { live: true })
  const [plan] = artifacts
  assert.equal(plan?.review?.id, 'call-7', 'the call id is the review identity')
  assert.equal(plan?.body, '# 计划\n- 甲')
  assert.equal(plan?.review?.outcome, 'pending', 'a live Host is waiting for an answer')
  assert.equal(plan?.state, 'reviewing')
})

test('a replay of an unanswered review is unknown, never a wait', () => {
  // Same event, no Host: nothing is reviewing any more (B2.4's rule for approvals).
  const [plan] = foldPlanArtifacts([MODE_ON(1), WRITE(2, steps('pending')), CALL(3, 'call-7', '# 计划')], { live: false })
  assert.equal(plan?.review?.outcome, 'unknown')
  assert.equal(plan?.state, 'unknown')
  assert.equal(plan?.body, '# 计划', 'the plan itself survives: it is durable')
})

test('an approval, a refusal and a dismissal are told apart, with the reader’s words kept', () => {
  const approved = foldPlanArtifacts([MODE_ON(1), WRITE(2, steps('pending')), CALL(3, 'c', '# 计划'), RESULT(4, 'c', APPROVED)], { live: true })
  assert.equal(approved[0]?.review?.outcome, 'approved')
  assert.equal(approved[0]?.state, 'approved')
  assert.equal(approved[0]?.provenance, 'durable')

  const refused = foldPlanArtifacts([MODE_ON(1), WRITE(2, steps('pending')), CALL(3, 'c', '# 计划'), RESULT(4, 'c', REFUSED_WITH_FEEDBACK, true)], { live: true })
  assert.equal(refused[0]?.review?.outcome, 'rejected')
  assert.equal(refused[0]?.review?.feedback, '加上回滚步骤')
  assert.equal(refused[0]?.state, 'rejected')

  const dismissed = foldPlanArtifacts([MODE_ON(1), WRITE(2, steps('pending')), CALL(3, 'c', '# 计划'), RESULT(4, 'c', DISMISSED, true)], { live: true })
  assert.equal(dismissed[0]?.review?.outcome, 'dismissed')
  assert.equal(dismissed[0]?.state, 'rejected')
})

test('liveness is per event, so one log can hold a lived review and a replayed one', () => {
  const events = [
    { ...MODE_ON(1), live: false }, { ...WRITE(2, steps('pending')), live: false },
    { ...CALL(3, 'old', '# 旧计划'), live: false },
    { ...RESULT(4, 'old', REFUSED, true), live: false },
    { ...MODE_OFF(5), live: false },
    { ...MODE_ON(6), live: true }, { ...WRITE(7, steps('pending')), live: true },
    { ...CALL(8, 'new', '# 新计划'), live: true },
  ]
  const artifacts = foldPlanArtifacts(events, { live: false })
  assert.equal(artifacts.length, 2, 'two episodes, one replated and one lived')
  assert.equal(artifacts[0]?.review?.outcome, 'rejected', 'the replayed review keeps its recorded outcome')
  assert.equal(artifacts[1]?.review?.outcome, 'pending', 'and the live one is genuinely waiting')
  assert.equal(artifacts[1]?.state, 'reviewing')
})

test('an unrecognised result failure is unknown, not a refusal the reader did not make', () => {
  const [plan] = foldPlanArtifacts([MODE_ON(1), WRITE(2, steps('pending')), CALL(3, 'c', '# 计划'), RESULT(4, 'c', 'something else went wrong', true)], { live: true })
  assert.equal(plan?.review?.outcome, 'unknown')
  assert.equal(plan?.state, 'unknown')
})

test('refusal sentences are matched exactly', () => {
  assert.deepEqual(reviewRefusal(REFUSED), { outcome: 'rejected' })
  assert.deepEqual(reviewRefusal(DISMISSED), { outcome: 'dismissed' })
  assert.deepEqual(reviewRefusal(REFUSED_WITH_FEEDBACK), { outcome: 'rejected', feedback: '加上回滚步骤' })
  assert.equal(reviewRefusal('the tool failed'), undefined)
})

// ── C. lifecycle ───────────────────────────────────────────────────────────

test('created → approved → executing → completed', () => {
  const artifacts = foldPlanArtifacts([
    MODE_ON(1), WRITE(2, steps('in_progress', 'pending')), CALL(3, 'c', '# 计划'), RESULT(4, 'c', APPROVED), MODE_OFF(5),
  ], { live: true })
  assert.equal(artifacts[0]?.state, 'executing', 'approved, mode left, steps still open')
  assert.equal(artifacts[0]?.provenance, 'durable')

  const done = foldPlanArtifacts([
    MODE_ON(1), WRITE(2, steps('in_progress', 'pending')), CALL(3, 'c', '# 计划'), RESULT(4, 'c', APPROVED), MODE_OFF(5),
    WRITE(6, steps('completed', 'completed')),
  ], { live: true })
  assert.equal(done[0]?.state, 'completed')
  assert.equal(done[0]?.provenance, 'inferred', 'no event says "completed"; the snapshot does')
})

test('rejected → revised → approved is one artifact with two reviews', () => {
  const artifacts = foldPlanArtifacts([
    MODE_ON(1), WRITE(2, steps('pending', 'pending')), CALL(3, 'exit-1', '# 计划 v1'), RESULT(4, 'exit-1', REFUSED, true),
    WRITE(5, steps('in_progress', 'pending', 'pending')), CALL(6, 'exit-2', '# 计划 v2'), RESULT(7, 'exit-2', APPROVED), MODE_OFF(8),
  ], { live: true })
  const [plan] = artifacts
  assert.equal(artifacts.length, 1, 'a revision is not a new plan')
  assert.equal(plan?.review?.id, 'exit-2', 'the newest review wins')
  assert.equal(plan?.review?.outcome, 'approved')
  assert.equal(plan?.state, 'executing')
  assert.equal(plan?.revisions.length, 2)
})

test('leaving plan mode without an approval is abandoned — and says it is an inference', () => {
  const [plan] = foldPlanArtifacts([MODE_ON(1), WRITE(2, steps('pending')), MODE_OFF(3)], { live: true })
  assert.equal(plan?.state, 'abandoned')
  assert.equal(plan?.provenance, 'inferred')
  assert.equal(plan?.closedSeq, 3)
  assert.equal(artifactIsLive(plan), false, 'and it leaves the dock')
})

test('leaving plan mode is never read as completed on its own', () => {
  const [plan] = foldPlanArtifacts([MODE_ON(1), WRITE(2, steps('pending')), MODE_OFF(3)], { live: true })
  assert.notEqual(plan?.state, 'completed')
  assert.notEqual(plan?.state, 'approved')
})

test('a queued /plan switch marks pending, and only once it succeeded', () => {
  const run = { type: 'command/run', seq: 1, data: { commandId: 'c1', name: 'plan', args: 'off' } }
  const openArtifact = [MODE_ON(0), WRITE(0.5, steps('pending'))]
  const queued = foldPlanArtifacts([...openArtifact, run], { live: true })
  assert.equal(queued[0]?.pending, true, 'the switch is queued for the next step')
  const failed = foldPlanArtifacts([...openArtifact, run, { type: 'command/done', seq: 2, data: { commandId: 'c1', kind: 'error' } }], { live: true })
  assert.equal(failed[0]?.pending, false, 'a failed switch never took effect')
  const committed = foldPlanArtifacts([...openArtifact, run, { type: 'command/done', seq: 2, data: { commandId: 'c1', kind: 'success' } }], { live: true })
  assert.equal(committed[0]?.pending, true, 'still pending until the boundary appends plan/mode')
  assert.equal(foldPlanArtifacts([...openArtifact, run, { type: 'command/done', seq: 2, data: { commandId: 'c1', kind: 'success' } }, MODE_OFF(3)], { live: true })[0]?.pending, false)
})

// ── D. liveness and progress ───────────────────────────────────────────────

test('liveness is the artifact’s, not a row’s', () => {
  const [done] = foldPlanArtifacts([WRITE(1, steps('completed'))], { live: true })
  assert.equal(artifactIsLive(done), false)
  const [working] = foldPlanArtifacts([WRITE(1, steps('completed', 'pending'))], { live: true })
  assert.equal(artifactIsLive(working), true)
  const [reviewing] = foldPlanArtifacts([MODE_ON(1), CALL(2, 'c', '# 计划')], { live: true })
  assert.equal(artifactIsLive(reviewing), true, 'a review nobody answered keeps it live')
  assert.equal(artifactIsLive(foldPlanArtifacts([MODE_ON(1), CALL(2, 'c', '# 计划')], { live: false })[0]), true,
    'and a replay still shows it (it is the newest thing that happened)')
})

test('progress comes from the latest revision', () => {
  const [plan] = foldPlanArtifacts([MODE_ON(1), WRITE(2, steps('completed', 'in_progress', 'pending'))], { live: true })
  const progress = artifactProgress(plan)
  assert.equal(progress.done, 1)
  assert.equal(progress.total, 3)
  assert.equal(progress.current?.status, 'in_progress')
})

test('an empty or malformed todo snapshot is ignored rather than invented', () => {
  assert.deepEqual(foldPlanArtifacts([WRITE(1, [])], { live: true }), [])
  assert.deepEqual(foldPlanArtifacts([WRITE(1, 'not a list')], { live: true }), [])
  assert.deepEqual(foldPlanArtifacts([{ type: 'todo/write', seq: 1, data: {} }], { live: true }), [])
})
