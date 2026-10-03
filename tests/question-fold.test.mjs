/**
 * The durable half of an ask-user question.
 *
 * A question used to exist only as a live request: the dialog that answered it and
 * the card it pushed. A replayed session therefore showed the `ask_user_question`
 * *tool* card and nothing about what was asked or answered — the same session read
 * differently depending on whether it had been lived or resumed. These cases pin
 * the Session's own record as the source: `tool/call` carries the questions,
 * `tool/result` (or a late reply) carries the answers, and every Client reads the
 * fold from `ctx.sessionProjections`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { tick, waitFor } from './wait.mjs'

setLocale('zh')

const ANSWERED = { questions: { active: [], settled: [{ callId: 'call-q1', answers: [{ id: 'q1', selected: ['预发'] }] }] } }
const OPEN = {
  questions: {
    active: [{ callId: 'call-q1', questions: [{ id: 'q1', question: '要部署到哪个环境？' }], state: 'open' }],
    settled: [],
  },
}

/** A projection registry stub: the state `dsh-user-questions` would have folded. */
function projectionCtx(state) {
  return {
    get: name => (name === 'sessionProjections' ? { stateOf: () => state } : undefined),
    on() { return () => {} },
  }
}

function fixture(state) {
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(projectionCtx(state), agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  // A relay that is attached: `hasLiveDisplay()` decides whether a question is
  // asked now or queued for a reader who is not there.
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout: () => {} }
  tui.write = () => {}
  return tui
}

const callEvent = {
  type: 'tool/call',
  seq: 1,
  time: Date.now(),
  data: {
    callId: 'call-q1',
    name: 'ask_user_question',
    arguments: JSON.stringify({
      questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }, { label: '生产' }], timeout: 60_000 }],
      // The harness tracks only the *timed* tool; a call without the wait parameter
      // is the legacy blocking one, which the projection never folds.
      timeout: 60_000,
    }),
  },
}

const resultEvent = {
  type: 'tool/result',
  seq: 2,
  time: Date.now(),
  data: {
    message: {
      role: 'tool',
      source: { callId: 'call-q1' },
      content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'q1', selected: ['预发'] }] }) }],
    },
  },
}

const questionCards = tui => tui.rows.filter(row => row.kind === 'question')

test('a live question opens a card that the Session keeps up to date', () => {
  const state = structuredClone(OPEN)
  const tui = fixture(state)
  tui.handleSessionEvent({ id: 'main-session' }, callEvent)
  const [card] = questionCards(tui)
  assert.ok(card !== undefined, 'the call opened a card')
  assert.equal(card.status, 'waiting')
  assert.equal(card.summary, '要部署到哪个环境？')
  assert.equal(card.durable, true, 'the Session owns it, not the request')
  assert.equal(card.callId, 'call-q1', 'and the call is what ties it to the record')
})

test('an answer settles the card from the Session, not from the dialog', () => {
  const state = structuredClone(OPEN)
  const tui = fixture(state)
  tui.handleSessionEvent({ id: 'main-session' }, callEvent)
  state.questions = structuredClone(ANSWERED.questions)
  tui.handleSessionEvent({ id: 'main-session' }, resultEvent)
  const [card] = questionCards(tui)
  assert.equal(card.status, 'answered')
  assert.equal(card.summary, '预发', 'the answer is what the card says')
})

test('a replayed session reads like a lived one', () => {
  const liveState = structuredClone(OPEN)
  const live = fixture(liveState)
  live.handleSessionEvent({ id: 'main-session' }, callEvent)
  liveState.questions = structuredClone(ANSWERED.questions)
  live.handleSessionEvent({ id: 'main-session' }, resultEvent)
  const lived = questionCards(live).map(card => `${card.status}:${card.summary}`)

  // The same two events, replayed by a process that never held the request: the
  // projection already reports the answer.
  const replay = fixture(structuredClone(ANSWERED))
  replay.handleSessionEvent({ id: 'main-session' }, callEvent)
  replay.handleSessionEvent({ id: 'main-session' }, resultEvent)
  const replayed = questionCards(replay).map(card => `${card.status}:${card.summary}`)

  assert.deepEqual(lived, ['answered:预发'], 'the lived session shows one answered card')
  assert.deepEqual(replayed, lived, 'and the replayed one shows the same')
  // B2.4 removed the duplicate: the generic `ask_user_question` tool card is gone,
  // and the question card is the one primary representation of that call.
  assert.deepEqual(
    replay.rows.filter(row => row.kind === 'tool').map(row => row.name),
    [],
    'no generic tool card stands beside the question card',
  )
  assert.equal(replay.rows.filter(row => row.kind === 'question').length, 1, 'exactly one primary representation')
})

test('a question the Session still accepts is reconstructed as answerable, not as a wait', () => {
  const state = {
    questions: {
      active: [{ callId: 'call-q9', questions: [{ id: 'q9', question: '继续吗？' }], state: 'continued' }],
      settled: [],
    },
  }
  const tui = fixture(state)
  tui.handleSessionEvent({ id: 'main-session' }, {
    ...callEvent,
    data: { ...callEvent.data, callId: 'call-q9', arguments: JSON.stringify({ questions: [{ id: 'q9', question: '继续吗？', timeout: 1_000 }] }) },
  })
  const [card] = questionCards(tui)
  assert.equal(card.status, 'waiting')
  assert.equal(card.continued, true, 'the Session still holds it')
  assert.equal(card.summary, '可稍后回答')
  assert.equal(card.callId, 'call-q9')
})

test('an unrelated tool call is never mistaken for a question', () => {
  const tui = fixture(structuredClone(ANSWERED))
  tui.handleSessionEvent({ id: 'main-session' }, {
    ...callEvent,
    data: { callId: 'call-x', name: 'bash', arguments: '{"command":"ls"}' },
  })
  assert.deepEqual(questionCards(tui), [], 'no card, and no answer attached to nothing')
})

test('without the projection the live request still owns its card', async () => {
  // A bare Context — a test, an embedder without `dsh-session-projection` — has no
  // durable view, and the live path must keep working rather than draw nothing.
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout: () => {} }
  tui.write = () => {}
  const pending = tui.handleUserQuestions({
    questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }] }],
  })
  await waitFor(() => questionCards(tui).length === 1, { describe: 'the live card' })
  const [card] = questionCards(tui)
  assert.equal(card.status, 'waiting')
  assert.equal(card.durable, undefined, 'the live request owns it when nothing folded it')
  tui.handleChar('\r')
  await waitFor(() => questionCards(tui)[0]?.status === 'answered', { describe: 'the answered card' })
  await pending.catch(() => undefined)
  await tick(0)
})
