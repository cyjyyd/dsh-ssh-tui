/**
 * PERF-085-LONG: irrelevant tool results must not enter the plan fold.
 *
 * The long-lived private developer session is deliberately NOT used here.
 * These are synthetic durable event shapes consumed by the actual SshTui plan
 * recorder (the same path used for live events and resumed history).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SshTui } from '../lib/tui.js'

function fixture() {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'synthetic-perf-session',
    options: {},
    status: 'idle',
    session: { id: 'synthetic-perf-session', events: [] },
    cancel() {}, steer() {}, followup() {},
  }
  return new SshTui(ctx, agent, {
    sessionId: agent.id, color: false, headlessDisplay: true,
  })
}

const CALL = (seq, callId, name = 'shell') => ({
  type: 'tool/call', seq,
  data: { name, callId, arguments: name === 'exit_plan_mode' ? JSON.stringify({ plan: '# test plan' }) : '{}' },
})
const RESULT = (seq, callId, text = 'ok', isError = false) => ({
  type: 'tool/result', seq,
  data: { message: { source: { callId }, content: [{ type: 'text', text }], isError } },
})

test('PERF-LONG RED: 64 ordinary tool results never grow the plan projection input', () => {
  const tui = fixture()
  for (let index = 0; index < 64; index += 1) {
    tui.recordPlanEvent(CALL(index * 2, 'ordinary-' + index))
    tui.recordPlanEvent(RESULT(index * 2 + 1, 'ordinary-' + index))
  }
  assert.equal(tui.planEvents.length, 0, 'non-plan tool/result must be rejected before the cumulative fold')
  assert.deepEqual(tui.planArtifacts, [], 'no plan artifact may be invented')
})

test('PERF-LONG RED: an exit_plan_mode result survives unrelated interleaved results', () => {
  const tui = fixture()
  tui.recordPlanEvent({ type: 'plan/mode', seq: 1, data: { active: true } })
  tui.recordPlanEvent(CALL(2, 'exit-review', 'exit_plan_mode'))
  for (let index = 0; index < 35; index += 1) {
    tui.recordPlanEvent(CALL(index * 2 + 3, 'other-' + index))
    tui.recordPlanEvent(RESULT(index * 2 + 4, 'other-' + index))
  }
  tui.recordPlanEvent(RESULT(74, 'exit-review', 'The user chose to keep planning; their feedback: revise the rollback steps', true))
  const plan = tui.planArtifacts.at(-1)
  assert.deepEqual(
    tui.planEvents.map(event => event.type),
    ['plan/mode', 'tool/call', 'tool/result'],
    'a review fold is sparse but still contains the matched result',
  )
  assert.equal(plan?.review?.id, 'exit-review')
  assert.equal(plan?.review?.outcome, 'rejected')
  assert.equal(plan?.review?.feedback, 'revise the rollback steps')
  assert.equal(plan?.state, 'rejected')
})

test('PERF-LONG RED: reviewed plan approval/dismissal must not depend on unrelated results', () => {
  for (const [text, isError, outcome] of [
    ['Plan approved — plan mode exited; carry out the plan starting with your next step.', false, 'approved'],
    ['The user dismissed the plan review to speak instead; stay in plan mode', true, 'dismissed'],
  ]) {
    const tui = fixture()
    tui.recordPlanEvent(CALL(10, 'exit-only', 'exit_plan_mode'))
    tui.recordPlanEvent(RESULT(11, 'irrelevant-one'))
    tui.recordPlanEvent(RESULT(12, 'exit-only', text, isError))
    const artifact = tui.planArtifacts[0]
    assert.equal(artifact?.review?.outcome, outcome)
    assert.deepEqual(tui.planEvents.map(event => event.seq), [10, 12], 'only matched exit review call/result can be stored')
  }
})
