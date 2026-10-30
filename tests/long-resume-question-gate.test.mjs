/**
 * PERF-085-LONG-R3 — question projection reads during durable history replay.
 *
 * Tests deliberately use synthetic SessionEvent data and a counted projection
 * registry; they must never ingest real local session logs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SshTui } from '../lib/tui.js'

const ACTIVE = {
  questions: {
    active: [{ callId: 'ask-q', questions: [{ id: 'q1', question: 'Which environment?' }], state: 'open' }],
    settled: [],
  },
}
const SETTLED = {
  questions: {
    active: [],
    settled: [{ callId: 'ask-q', answers: [{ id: 'q1', selected: ['staging'] }] }],
  },
}

function fixture(initial = SETTLED) {
  let view = structuredClone(initial)
  let reads = 0
  const projections = { stateOf: () => { reads += 1; return view } }
  const ctx = {
    get(name) { return name === 'sessionProjections' ? projections : undefined },
    on() { return () => {} },
  }
  const agent = {
    id: 'synthetic-r3',
    options: {},
    status: 'idle',
    session: { id: 'synthetic-r3', events: [] },
    cancel() {}, steer() {}, followup() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: agent.id, headlessDisplay: true, color: false })
  tui.replaying = true
  tui.loadingHistory = true
  return {
    tui, agent,
    count: () => reads,
    setView(next) { view = structuredClone(next) },
  }
}

function ordinaryCall(seq, callId) {
  return { type: 'tool/call', seq, data: { name: 'shell', callId, arguments: '{}' } }
}
function ordinaryResult(seq, callId) {
  return { type: 'tool/result', seq, data: {
    message: { role: 'tool', source: { callId }, content: [{ type: 'text', text: 'ok' }] },
  } }
}
function askCall(seq) {
  return { type: 'tool/call', seq, data: {
    name: 'ask_user_question', callId: 'ask-q',
    arguments: JSON.stringify({ questions: [{
      id: 'q1', question: 'Which environment?', options: [{ label: 'staging' }], timeout: 60_000,
    }], timeout: 60_000 }),
  } }
}
function askResult(seq) {
  return { type: 'tool/result', seq, data: {
    message: { role: 'tool', source: { callId: 'ask-q' },
      content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'q1', selected: ['staging'] }] }) }] },
  } }
}
function send(target, event) {
  target.tui.handleSessionEvent({ id: target.agent.id }, { ...event, time: Date.parse('2026-10-01T00:00:00Z') })
}

function transcriptShape(tui) {
  return tui.rows.map(row => ({
    kind: row.kind,
    // Verify content and *relative order*, not just a set of question cards.
    text: row.text,
    title: row.title,
    summary: row.summary,
    callId: row.callId,
    questionId: row.questionId,
    status: row.status,
    durable: row.durable,
  }))
}

test('PERF-R3 RED: 256 ordinary tool events during replay do not materialize question state', () => {
  const target = fixture()
  for (let i = 0; i < 128; i += 1) {
    send(target, ordinaryCall(2 * i, 'ordinary-' + i))
    send(target, ordinaryResult(2 * i + 1, 'ordinary-' + i))
  }
  assert.equal(target.count(), 0, 'no question-relevant change: no expensive stateOf call')
  assert.deepEqual(target.tui.rows.filter(row => row.kind === 'question'), [])
})

test('PERF-R3 RED: only question-linked tool events update durable cards during replay', () => {
  const target = fixture(ACTIVE)
  let seq = 1
  for (let i = 0; i < 40; i += 1) {
    send(target, ordinaryCall(seq++, 'before-' + i))
    send(target, ordinaryResult(seq++, 'before-' + i))
  }
  send(target, askCall(seq++))
  assert.equal(target.tui.rows.filter(row => row.kind === 'question').length, 1)
  assert.equal(target.tui.rows.find(row => row.kind === 'question')?.status, 'waiting')
  target.setView(SETTLED)
  for (let i = 0; i < 40; i += 1) {
    send(target, ordinaryCall(seq++, 'middle-' + i))
    send(target, ordinaryResult(seq++, 'middle-' + i))
  }
  send(target, askResult(seq++))
  for (let i = 0; i < 40; i += 1) {
    send(target, ordinaryCall(seq++, 'after-' + i))
    send(target, ordinaryResult(seq++, 'after-' + i))
  }
  const questions = target.tui.rows.filter(row => row.kind === 'question')
  assert.equal(questions.length, 1)
  assert.equal(questions[0].status, 'answered')
  assert.equal(questions[0].summary, 'staging')
  assert.equal(target.count(), 2, 'only the ask call and its matching result require stateOf')
})

test('PERF-R3 replay transcript equals a conservative per-event refresh baseline', () => {
  const optimized = fixture(ACTIVE)
  const baseline = fixture(ACTIVE)
  const events = [
    ordinaryCall(1, 'before'), ordinaryResult(2, 'before'),
    askCall(3),
    ordinaryCall(4, 'between'), ordinaryResult(5, 'between'),
    askResult(6),
    ordinaryCall(7, 'after'), ordinaryResult(8, 'after'),
  ]
  for (const event of events) {
    if (event.type === 'tool/result' && event.data.message.source.callId === 'ask-q') {
      optimized.setView(SETTLED)
      baseline.setView(SETTLED)
    }
    send(optimized, event)
    send(baseline, event)
    // Simulate the full per-event reader used by the baseline implementation.
    // Repeating an idempotent projection update for question events is safe.
    baseline.tui.syncQuestionRows()
  }
  assert.deepEqual(transcriptShape(optimized.tui), transcriptShape(baseline.tui))
  assert.equal(optimized.tui.rows.filter(row => row.kind === 'question').length, 1)
  assert.ok(baseline.count() > optimized.count(), 'control must actually exercise extra materialization')
})

test('PERF-R3 live mode keeps existing full question projection synchronization', () => {
  const target = fixture()
  target.tui.replaying = false
  target.tui.loadingHistory = false
  for (let i = 0; i < 3; i += 1) {
    send(target, ordinaryCall(2 * i, 'live-' + i))
    send(target, ordinaryResult(2 * i + 1, 'live-' + i))
  }
  assert.equal(target.count(), 6, 'the live path remains unchanged in this targeted replay-only optimization')
})

test('PERF-R3 late user-message reply remains synchronous during replay', () => {
  const target = fixture(ACTIVE)
  send(target, askCall(1))
  assert.equal(target.tui.rows.find(row => row.kind === 'question')?.status, 'waiting')
  const continued = {
    questions: {
      active: [{ callId: 'ask-q', questions: [{ id: 'q1', question: 'Which environment?' }], state: 'continued' }],
      settled: [],
    },
  }
  target.setView(continued)
  send(target, { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'I will follow up' }] } })
  const card = target.tui.rows.find(row => row.kind === 'question')
  assert.equal(card?.continued, true, 'a late message must still update the question state')
  target.setView(SETTLED)
  send(target, { type: 'user/message', seq: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'staging' }] } })
  assert.equal(card?.status, 'answered')
  assert.equal(card?.summary, 'staging')
  assert.equal(target.count(), 3, 'ask call and two late messages remain synchronized')
})
