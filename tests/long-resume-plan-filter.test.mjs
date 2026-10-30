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

test('a 55k-event synthetic log keeps only matched review events and stays bounded', () => {
  // Approximate the field report's tool-call density: 1 call+result per five
  // events and one exit_plan_mode call per 300 tools. This test asserts work
  // *shape*, not timing on a noisy shared CI runner.
  for (const events of [5000, 20000, 55000]) {
    const tui = fixture()
    let planCalls = 0
    for (let seq = 0; seq < events; seq += 1) {
      const slot = seq % 5
      const call = Math.floor(seq / 5)
      if (slot === 0) {
        const name = call % 300 === 0 ? 'exit_plan_mode' : 'shell'
        if (name === 'exit_plan_mode') planCalls += 1
        tui.recordPlanEvent(CALL(seq, 'call-' + call, name))
      } else if (slot === 1) {
        tui.recordPlanEvent(RESULT(seq, 'call-' + call))
      } else {
        tui.recordPlanEvent({ type: 'assistant/message', seq, data: {} })
      }
    }
    assert.equal(tui.planEvents.length, planCalls * 2,
      `${events} total events should retain only plan call+matching result pairs`)
    assert.equal(tui.planArtifacts.length, 1,
      'the synthetic plan review must still produce a durable artifact')
    assert.equal(tui.planArtifacts[0]?.review?.outcome, 'approved')
    assert.equal(tui.planReviewCallIds.size, planCalls)
  }
})
