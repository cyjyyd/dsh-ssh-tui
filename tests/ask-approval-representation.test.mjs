/**
 * B2.4 — ask / approval representation ownership.
 *
 * Two success criteria, both counted rather than asserted by eye:
 *
 * 1. an ordinary `ask_user_question` call has **one** primary transcript
 *    representation — the question card built from the call itself — and no
 *    generic tool card beside it;
 * 2. an approval is a **field of the tool card** it guarded, with the strength of
 *    its evidence attached, and nothing in the transcript claims to be the
 *    decision itself.
 *
 * The tests drive session events, not the TUI's own methods, wherever the point is
 * that live and replay agree: the events are what a replay reads.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { feedbackText } from './wait.mjs'

setLocale('zh')

async function waitUntil(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
}

const OPEN = {
  questions: {
    active: [{ callId: 'call-q1', questions: [{ id: 'q1', question: '要部署到哪个环境？' }], state: 'open' }],
    settled: [],
  },
}
const ANSWERED = {
  questions: { active: [], settled: [{ callId: 'call-q1', answers: [{ id: 'q1', selected: ['预发'] }] }] },
}

/** A projection registry stub: the state `dsh-user-questions` would have folded. */
function projectionCtx(state) {
  return {
    get: name => (name === 'sessionProjections' ? { stateOf: () => state } : undefined),
    on() { return () => {} },
  }
}

function fixture(state, services = {}, options = {}) {
  const agent = {
    id: 'main-session', options: {}, status: 'idle',
    session: { id: 'main-session', events: [] }, cancel() {}, steer() {}, followup() {},
  }
  const ctx = {
    ...projectionCtx(state),
    get: name => (name === 'sessionProjections' ? { stateOf: () => state } : services[name]),
  }
  // `color: false` is the constructor's *palette* switch: it forces the colour
  // depth to `none`, which also empties every muted accent (`mutedSgr`). A case
  // about a styled fragment therefore asks for a palette up front — setting
  // `tui.color` afterwards is too late for the depth.
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: options.color ?? false, headlessDisplay: true })
  // A relay that is attached: `hasLiveDisplay()` decides whether a question is
  // asked now or queued for a reader who is not there.
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  return { tui, agent }
}

const send = (tui, event) => tui.handleSessionEvent({ id: 'main-session' }, {
  seq: (send.seq = (send.seq ?? 0) + 1), time: Date.now(), ...event,
})

const questionCall = (callId, questions, extra = {}) => ({
  type: 'tool/call',
  data: { callId, name: 'ask_user_question', arguments: JSON.stringify({ questions: [...questions, ...extra.questions ?? []], ...extra.args }) },
})
const toolResult = (callId, text, isError = false) => ({
  type: 'tool/result',
  data: {
    message: { role: 'tool', source: { callId }, content: [{ type: 'text', text }], isError },
  },
})

const questions = tui => tui.rows.filter(row => row.kind === 'question')
const toolRows = tui => tui.rows.filter(row => row.kind === 'tool')
const primariesOf = (tui, callId) => tui.rows.filter(row =>
  (row.kind === 'question' && row.callId === callId) || (row.kind === 'tool' && row.name === 'ask_user_question' && row.callId === callId))

// ── A. one semantic question, one primary representation ────────────────────

test('an ordinary ask has exactly one primary transcript representation', () => {
  const { tui } = fixture(structuredClone(OPEN))
  const call = questionCall('call-q1', [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }, { label: '生产' }] }], { args: { timeout: 60_000 } })
  const event = { ...call, seq: 1, time: Date.now() }
  send(tui, event)
  assert.equal(primariesOf(tui, 'call-q1').length, 1, `one primary, not two:\n${tui.rows.map(row => row.kind).join(',')}`)
  assert.equal(toolRows(tui).length, 0, 'and no generic ask_user_question card was drawn')
  const [card] = questions(tui)
  assert.equal(card.status, 'waiting')
  assert.equal(card.summary, '要部署到哪个环境？')
  assert.deepEqual(tui.questionPrimaryAudit().duplicateCalls, [], 'the count agrees')

  // The live request must land on that same card, not create a second one.
  const pending = tui.handleUserQuestions({
    questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }, { label: '生产' }] }],
    wait: { callId: 'call-q1' },
  })
  pending.catch(() => undefined)
  assert.equal(questions(tui).length, 1, 'the live request reuses the card the call created')
  tui.handleEscape()
  return pending.catch(() => undefined)
})

test('no projection at all still gets one representation, built from the call', () => {
  // The projection is what says whether a question is still answerable; it is not
  // what says the question *happened*. A legacy blocking call the projection never
  // folds, and an embedder without the package, both still have their arguments.
  const { tui } = fixture(undefined)
  const call = questionCall('call-legacy', [{ id: 'q9', question: '继续吗？' }])
  send(tui, { ...call, seq: 1, time: Date.now() })
  assert.equal(questions(tui).length, 1, 'the call alone is enough to draw the question')
  assert.equal(questions(tui)[0]?.callId, 'call-legacy')
  assert.equal(toolRows(tui).length, 0, 'and it is still not a tool card')
})

test('an answered question settles on its own card: question, answer and state', () => {
  const { tui } = fixture(structuredClone(ANSWERED))
  const call = questionCall('call-q1', [{ id: 'q1', question: '要部署到哪个环境？' }], { args: { timeout: 60_000 } })
  send(tui, { ...call, seq: 1, time: Date.now() })
  send(tui, { ...toolResult('call-q1', JSON.stringify({ answers: [{ id: 'q1', selected: ['预发'] }] })), seq: 2, time: Date.now() })
  const rows = questions(tui)
  assert.equal(rows.length, 1, 'one card, not a card plus an answer row')
  assert.equal(rows[0]?.status, 'answered')
  assert.equal(rows[0]?.summary, '预发', 'the answer is the card summary')
  assert.equal(rows[0]?.title, '要部署到哪个环境？', 'while the question stays on it')
  const frame = tui.captureFrame(90, 20).join('\n')
  assert.match(frame, /要部署到哪个环境？/u)
  assert.match(frame, /预发/u)
  assert.match(frame, /已回答/u)
})

test('a typed answer and a multi-select answer both summarize', () => {
  for (const [answers, expected] of [
    [[{ id: 'q1', selected: [], custom: '我自己写的一段回答' }], '我自己写的一段回答'],
    [[{ id: 'q1', selected: ['预发', '生产'] }], '预发, 生产'],
  ]) {
    const { tui } = fixture({ questions: { active: [], settled: [{ callId: 'call-q1', answers }] } })
    send(tui, { ...questionCall('call-q1', [{ id: 'q1', question: '选一下' }], { args: { timeout: 60_000 } }), seq: 1, time: Date.now() })
    send(tui, { ...toolResult('call-q1', JSON.stringify({ answers })), seq: 2, time: Date.now() })
    assert.equal(questions(tui)[0]?.summary, expected)
  }
})

test('a replayed question reads exactly like a lived one', () => {
  const liveState = structuredClone(OPEN)
  const { tui: live, agent } = fixture(liveState)
  send(live, { ...questionCall('call-q1', [{ id: 'q1', question: '要部署到哪个环境？' }], { args: { timeout: 60_000 } }), seq: 1, time: Date.now() })
  liveState.questions = structuredClone(ANSWERED.questions)
  send(live, { ...toolResult('call-q1', JSON.stringify({ answers: [{ id: 'q1', selected: ['预发'] }] })), seq: 2, time: Date.now() })
  const lived = live.rows.map(row => `${row.kind}:${row.summary ?? ''}`)

  const { tui: replay } = fixture(structuredClone(ANSWERED))
  replay.replaying = true
  // A resumed process sees the same two events, in the same order, without ever
  // holding the request.
  send(replay, { ...questionCall('call-q1', [{ id: 'q1', question: '要部署到哪个环境？' }], { args: { timeout: 60_000 } }), seq: 1, time: Date.now() })
  send(replay, { ...toolResult('call-q1', JSON.stringify({ answers: [{ id: 'q1', selected: ['预发'] }] })), seq: 2, time: Date.now() })
  assert.deepEqual(replay.rows.map(row => `${row.kind}:${row.summary ?? ''}`), lived)
  assert.equal(
    replay.captureFrame(90, 20).join('\n').includes('已回答'),
    true,
    'and the replayed card says the same thing on screen',
  )
  void agent
})

test('a continued question stays one card, and answering it updates that card', async () => {
  const state = {
    questions: {
      active: [{ callId: 'call-q9', questions: [{ id: 'q9', question: '继续吗？' }], state: 'continued' }],
      settled: [],
    },
  }
  // `ctx.userQuestions.answer` is the Harness's channel for a question whose window
  // closed; without it the card says so instead of opening an interaction.
  const { tui } = fixture(state, { userQuestions: { answer: () => true } })
  send(tui, { ...questionCall('call-q9', [{ id: 'q9', question: '继续吗？' }], { args: { timeout: 1_000 } }), seq: 1, time: Date.now() })
  const [card] = questions(tui)
  assert.equal(card.continued, true)
  assert.equal(card.status, 'waiting')
  assert.equal(questions(tui).length, 1)

  // Enter on the card re-enters the interaction rather than drawing a new card.
  tui.focusedRow = card
  tui.handleChar('\r')
  assert.ok(await waitUntil(() => tui.dialog?.kind === 'questions'), 'Enter opens the interaction')
  assert.equal(questions(tui).length, 1, 'and it appends no row')
  tui.handleEscape()
  await new Promise(resolve => setTimeout(resolve, 10))
})

test('re-answering a continued question updates that card, and never appends another', async () => {
  const state = {
    questions: {
      active: [{ callId: 'call-q9', questions: [{ id: 'q9', question: '继续吗？' }], state: 'continued' }],
      settled: [],
    },
  }
  const answered = []
  const ctx = {
    get: name => {
      if (name === 'sessionProjections') return { stateOf: () => state }
      if (name === 'userQuestions') return { answer: (_agent, callId, batch) => { answered.push([callId, batch]); return true } }
      return undefined
    },
    on() { return () => {} },
  }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  send(tui, { ...questionCall('call-q9', [{ id: 'q9', question: '继续吗？' }], { args: { timeout: 1_000 } }), seq: 1, time: Date.now() })
  const [card] = questions(tui)
  assert.equal(card.continued, true)

  // Empty-input Enter is the re-entry: for a continued question the key is an
  // action, not a fold (the same gate `/copy` and Alt+4 land in).
  tui.focusedRow = card
  tui.handleChar('\r')
  assert.ok(await waitUntil(() => tui.dialog?.kind === 'questions'), 'Enter re-opened the interaction')
  tui.handleChar('\r')
  assert.ok(await waitUntil(() => answered.length === 1), 'the second answer went through the Harness channel')
  assert.deepEqual(answered[0]?.[1]?.answers?.[0]?.id, 'q9', 'with the call\'s own shape')

  // The late reply closes the question in the projection; the card is the same one.
  state.questions = { active: [], settled: [{ callId: 'call-q9', answers: [{ id: 'q9', selected: ['继续'] }] }] }
  send(tui, { type: 'user/message', data: { id: 'later', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } })
  assert.equal(questions(tui).length, 1, 'one card, before and after')
  assert.equal(questions(tui)[0]?.status, 'answered')
  assert.equal(questions(tui)[0]?.summary, '继续')
})

test('without the answer channel the card says so instead of opening a dead interaction', () => {
  const state = {
    questions: {
      active: [{ callId: 'call-q9', questions: [{ id: 'q9', question: '继续吗？' }], state: 'continued' }],
      settled: [],
    },
  }
  const { tui } = fixture(state)
  send(tui, { ...questionCall('call-q9', [{ id: 'q9', question: '继续吗？' }], { args: { timeout: 1_000 } }), seq: 1, time: Date.now() })
  const [card] = questions(tui)
  tui.focusedRow = card
  tui.handleChar('\r')
  assert.equal(tui.dialog, undefined, 'no interaction is opened that could not be answered')
  assert.equal(questions(tui).length, 1)
})

test('plan-review is not swept up by the ordinary-ask cleanup', () => {
  // `@deepseek-ai/dsh-plan-mode` asks from inside the **exit_plan_mode** tool, with
  // `intent.kind = 'plan-review'` and no timed wait. B2.4 must leave it exactly as
  // it was: its tool card *and* its review card, and never the ordinary-ask path
  // (the replay-time intent gap is B2.5's, and this guard is why it is still
  // B2.5's: nothing here may quietly rewrite plan review while fixing questions).
  const { tui } = fixture(undefined)
  send(tui, {
    type: 'tool/call',
    seq: 1,
    time: Date.now(),
    data: { callId: 'call-plan', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# 计划\n- 第一步' }) },
  })
  const pending = tui.handleUserQuestions({
    questions: [{
      id: 'plan-review',
      header: 'Plan review',
      question: 'Approve this plan and leave plan mode?',
      detail: '# 计划\n- 第一步',
      options: [{ label: '批准' }, { label: '继续规划' }],
      intent: { kind: 'plan-review', approve: '批准', callId: 'call-plan' },
    }],
  })
  pending.catch(() => undefined)

  // B2.5 gave the plan review its own representation (the plan artifact), so the generic
  // tool card is gone — and the review's own Surface, not a question card, is how the
  // reader answers.
  assert.equal(toolRows(tui).filter(row => row.name === 'exit_plan_mode').length, 0, 'no generic tool card beside the artifact')
  // B2.5 moved the review onto the plan artifact: no question card (that was the
  // duplicate), and the Surface is still the way the reader answers.
  assert.equal(questions(tui).length, 0, 'the review is not an ordinary question summary')
  assert.equal(tui.dialog?.kind, 'questions', 'the review Surface is up')
  const frame = tui.captureFrame(90, 24).join('\n')
  assert.match(frame, /计划待审|Approve this plan/u, `the review is on screen:\n${frame}`)
  assert.equal(tui.questionPrimaryAudit().genericToolRows, 0, 'the ordinary-ask suppression never touches this one')
  tui.handleEscape()
  return pending.catch(() => undefined)
})

// ── B. approval is a field of the card it guarded ───────────────────────────

const approvalAsked = (callId, id = 'a1', reason = 'dangerous command') => ({
  type: 'approval/asked',
  data: { id, toolName: 'bash', callId, ...(reason === '' ? {} : { reason }) },
})
const approvalDecided = (outcome, id = 'a1') => ({ type: 'approval/decided', data: { id, outcome } })

const guardedCard = tui => tui.rows.findLast(row => row.kind === 'tool')

test('an approval waiting, approved and rejected all land on the tool card', () => {
  for (const [outcome, expected] of [[undefined, 'waiting'], ['allowed-once', 'approved'], ['rejected', 'rejected']]) {
    const { tui } = fixture(undefined)
    send(tui, { type: 'tool/call', seq: 1, time: Date.now(), data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'rm -rf /tmp/x' }) } })
    send(tui, { ...approvalAsked('c1'), seq: 2, time: Date.now() })
    if (outcome !== undefined) send(tui, { ...approvalDecided(outcome), seq: 3, time: Date.now() })
    const card = guardedCard(tui)
    assert.equal(card.approval?.state, expected, `${outcome ?? 'no decision'}`)
    assert.equal(card.approval?.provenance, 'durable', 'read from the Harness pair, not remembered by us')
    assert.equal(tui.rows.filter(row => row.kind === 'system' && /审批/u.test(String(row.text))).length, 0,
      'and no transcript row claims to be the decision')
  }
})

test('a live Host that is asking says waiting; a replay never does', () => {
  // The same event, two situations: `approval/asked` while this process is holding
  // the request open is a wait, and the same event read from a log is only the
  // record that an approval was once required.
  const live = fixture(undefined)
  send(live.tui, { type: 'tool/call', seq: 1, time: Date.now(), data: { callId: 'c1', name: 'bash', arguments: '{}' } })
  send(live.tui, { ...approvalAsked('c1'), seq: 2, time: Date.now() })
  assert.equal(guardedCard(live.tui).approval?.state, 'waiting')

  const replay = fixture(undefined)
  replay.tui.replaying = true
  send(replay.tui, { type: 'tool/call', seq: 1, time: Date.now(), data: { callId: 'c1', name: 'bash', arguments: '{}' } })
  send(replay.tui, { ...approvalAsked('c1'), seq: 2, time: Date.now() })
  const card = guardedCard(replay.tui)
  assert.equal(card.approval?.state, 'unknown', 'a Host death mid-wait is not a grant')
  assert.notEqual(card.approval?.state, 'approved')
})

test('a cancelled or unavailable outcome is unknown — never a refusal the reader did not make', () => {
  for (const outcome of ['cancelled', 'unavailable', 'something-new']) {
    const { tui } = fixture(undefined)
    send(tui, { type: 'tool/call', seq: 1, time: Date.now(), data: { callId: 'c1', name: 'bash', arguments: '{}' } })
    send(tui, { ...approvalAsked('c1'), seq: 2, time: Date.now() })
    send(tui, { ...approvalDecided(outcome), seq: 3, time: Date.now() })
    assert.equal(guardedCard(tui).approval?.state, 'unknown', outcome)
  }
})

test('an old log with no audit pair is read, marked inferred, and never approved', () => {
  const { tui } = fixture(undefined)
  send(tui, { type: 'tool/call', seq: 1, time: Date.now(), data: { callId: 'c1', name: 'bash', arguments: '{}' } })
  send(tui, { ...toolResult('c1', 'the user rejected tool "bash"', true), seq: 2, time: Date.now() })
  const card = guardedCard(tui)
  assert.equal(card.approval?.state, 'rejected')
  assert.equal(card.approval?.provenance, 'inferred', 'the card admits it is a reading')

  // A tool that *ran* is not evidence of anything: plenty of tools never needed an
  // approval, so a successful result must leave no badge at all.
  const ok = fixture(undefined)
  send(ok.tui, { type: 'tool/call', seq: 1, time: Date.now(), data: { callId: 'c2', name: 'bash', arguments: '{}' } })
  send(ok.tui, { ...toolResult('c2', 'all good'), seq: 2, time: Date.now() })
  assert.equal(guardedCard(ok.tui).approval, undefined, 'nothing is claimed where nothing is known')

  // And a plain permission denial is not an approval refusal either.
  const denied = fixture(undefined)
  send(denied.tui, { type: 'tool/call', seq: 1, time: Date.now(), data: { callId: 'c3', name: 'bash', arguments: '{}' } })
  send(denied.tui, { ...toolResult('c3', 'denied by policy', true), seq: 2, time: Date.now() })
  assert.equal(guardedCard(denied.tui).approval, undefined)
})

test('an approval never lands on the wrong card', () => {
  const { tui } = fixture(undefined)
  send(tui, { type: 'tool/call', seq: 1, time: Date.now(), data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'ls' }) } })
  send(tui, { type: 'tool/call', seq: 2, time: Date.now(), data: { callId: 'c2', name: 'bash', arguments: JSON.stringify({ command: 'pwd' }) } })
  // The approval belongs to the *first* card, and the newer one is the trap: a
  // lookup that grabs "the last tool row" would file it there.
  send(tui, { ...approvalAsked('c1', 'a9', 'the dangerous one'), seq: 3, time: Date.now() })
  send(tui, { ...approvalDecided('rejected', 'a9'), seq: 4, time: Date.now() })
  const [first, second] = toolRows(tui)
  assert.equal(first.approval?.state, 'rejected', 'the call the approval names gets it')
  assert.equal(first.approval?.reason, 'the dangerous one')
  assert.equal(second.approval, undefined, 'and the card that was never asked about stays clean')
})

test('an approval resolved before its card exists still reaches it', () => {
  // A resumed log read out of order, or a `tool/result`-only fragment: the fact is
  // kept until the card it belongs to appears.
  const { tui } = fixture(undefined)
  send(tui, { ...approvalAsked('c-late', 'a2'), seq: 1, time: Date.now() })
  send(tui, { ...approvalDecided('allowed-once', 'a2'), seq: 2, time: Date.now() })
  send(tui, { type: 'tool/call', seq: 3, time: Date.now(), data: { callId: 'c-late', name: 'bash', arguments: '{}' } })
  assert.equal(guardedCard(tui).approval?.state, 'approved')
  assert.equal(guardedCard(tui).approval?.provenance, 'durable')
})

test('the live decision is the strongest source, and the event behind it does not downgrade it', async () => {
  const { tui } = fixture(undefined)
  send(tui, { type: 'tool/call', seq: 1, time: Date.now(), data: { callId: 'c1', name: 'bash', arguments: '{}' } })
  const pending = tui.handleApproval({ toolName: 'bash', callId: 'c1', agent: { id: 'main-session' }, reason: 'rm' }, async () => 'rejected')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(guardedCard(tui).approval?.state, 'waiting')
  assert.equal(guardedCard(tui).approval?.provenance, 'live')
  tui.handleChar('y')
  assert.equal(await pending, 'allowed-once')
  assert.equal(guardedCard(tui).approval?.state, 'approved')
  assert.equal(guardedCard(tui).approval?.provenance, 'live', 'the reader decided it; the log only records it')

  // The Harness's own record of the same decision arrives right behind it.
  send(tui, { ...approvalAsked('c1', 'a3'), seq: 2, time: Date.now() })
  send(tui, { ...approvalDecided('allowed-once', 'a3'), seq: 3, time: Date.now() })
  assert.equal(guardedCard(tui).approval?.provenance, 'live', 'a weaker source never overwrites a stronger one')
  assert.equal(guardedCard(tui).approval?.state, 'approved')
})

test('an auto decision is marked automatic, and writes no transcript row', async () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {}, steer() {}, followup() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  tui.runCommand('/approval auto')
  const before = tui.rows.length
  send(tui, { type: 'tool/call', seq: 1, time: Date.now(), data: { callId: 'c-allow', name: 'bash', arguments: JSON.stringify({ command: 'git status' }) } })
  const rowsAfterCall = tui.rows.length
  assert.equal(await tui.handleApproval({ toolName: 'bash', callId: 'c-allow', agent }, async () => 'rejected'), 'allowed-once')
  assert.equal(tui.rows.length, rowsAfterCall, 'the decision adds no row')
  assert.ok(tui.rows.length > before)
  const card = guardedCard(tui)
  assert.deepEqual(card.approval, { state: 'approved', provenance: 'policy', auto: true })
  assert.match(feedbackText(tui), /自动审批 通过/u, 'the reader is still told, on a transient sink')
  assert.equal(tui.rows.filter(row => row.kind === 'system' && /自动审批 (通过|拒绝)/u.test(String(row.text))).length, 0)
})

test('a detached Host keeps the pending approval, and a dead one keeps only what the log says', async () => {
  // Host alive: the confirm dialog is retained across the drop, and the card keeps
  // saying waiting, because something really is still asking.
  const { tui, agent } = fixture(undefined)
  send(tui, { type: 'tool/call', seq: 1, time: Date.now(), data: { callId: 'c1', name: 'bash', arguments: '{}' } })
  const pending = tui.handleApproval({ toolName: 'bash', callId: 'c1', agent, reason: 'rm' }, async () => 'rejected')
  await new Promise(resolve => setTimeout(resolve, 10))
  tui.detachDisplay()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(tui.dialog?.kind, 'confirm', 'the surface survives the drop: the Host is still asking')
  assert.equal(guardedCard(tui).approval?.state, 'waiting')
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.attachRelayDisplay()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(tui.dialog?.kind, 'confirm')
  assert.equal(guardedCard(tui).approval?.state, 'waiting')
  tui.handleChar('n')
  assert.equal(await pending, 'rejected')
  assert.equal(guardedCard(tui).approval?.state, 'rejected')

  // Host death: a resumed process rebuilds from the log alone, and an ask with no
  // decision is *not* presented as an actionable wait or a grant.
  const resumed = fixture(undefined)
  resumed.tui.replaying = true
  send(resumed.tui, { type: 'tool/call', seq: 1, time: Date.now(), data: { callId: 'c1', name: 'bash', arguments: '{}' } })
  send(resumed.tui, { ...approvalAsked('c1'), seq: 2, time: Date.now() })
  assert.equal(resumed.tui.dialog, undefined, 'nothing is asking in a process that only read a log')
  assert.equal(guardedCard(resumed.tui).approval?.state, 'unknown')
})

// ── C. regression: everything B1/B2.2/B2.3 taught stays true ────────────────

test('a question dialog survives a detach, and the settled card survives it too', async () => {
  const { tui } = fixture(structuredClone(OPEN))
  const pending = tui.handleUserQuestions({
    questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }, { label: '生产' }] }],
    wait: { callId: 'call-q1' },
  })
  pending.catch(() => undefined)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(tui.dialog?.kind, 'questions', 'the surface is up')
  tui.detachDisplay()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(tui.dialog?.kind, 'questions', 'the Host is still asking, so the surface stays')
  assert.equal(questions(tui).length, 1, 'and the card is still one row')
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.attachRelayDisplay()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(tui.dialog?.kind, 'questions', 'the reattached reader gets the same question back')
  assert.equal(questions(tui).length, 1)
  tui.handleEscape()
  await pending.catch(() => undefined)
})

test('the highlight still follows the reader between two cards that both carry an approval', () => {
  const { tui } = fixture(undefined)
  tui.color = true
  for (const callId of ['c1', 'c2']) {
    send(tui, { type: 'tool/call', seq: 1, time: Date.now(), data: { callId, name: 'bash', arguments: JSON.stringify({ command: `echo ${callId}` }) } })
    send(tui, { ...approvalAsked(callId, `a-${callId}`), seq: 2, time: Date.now() })
    send(tui, { ...approvalDecided('allowed-once', `a-${callId}`), seq: 3, time: Date.now() })
  }
  const [first, second] = toolRows(tui)
  const highlighted = () => tui.captureFrame(100, 24)
    .map((line, index) => [index, line])
    .filter(([, line]) => line.includes('\u001b[7m'))
    .map(([index]) => index)
  tui.focusedRow = first
  const onFirst = highlighted()
  assert.equal(onFirst.length, 1, 'exactly one card is highlighted')
  tui.focusedRow = second
  const onSecond = highlighted()
  assert.equal(onSecond.length, 1, 'still exactly one')
  assert.notDeepEqual(onSecond, onFirst, 'and it is the card the reader moved to')
})

test('the interaction surface still wins its rows, and the live region still yields', async () => {
  const { tui } = fixture(structuredClone(OPEN))
  tui.streaming = { text: '', reasoning: '思考中的内容' }
  tui.streamingReasoning = { kind: 'streaming-reasoning', expanded: false }
  const pending = tui.handleUserQuestions({
    questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }, { label: '生产' }] }],
    wait: { callId: 'call-q1' },
  })
  pending.catch(() => undefined)
  await new Promise(resolve => setTimeout(resolve, 20))
  const frame = tui.captureFrame(100, 22)
  const layer = tui.interactionRegion
  const tail = tui.liveTailRegion
  assert.notEqual(layer, undefined, 'the question surface is up')
  assert.notEqual(tail, undefined, 'and the live region is still projected')
  const surface = frame.slice(layer.top - 1, layer.top - 1 + layer.rows).join('\n')
  assert.match(surface, /预发/u)
  assert.equal(surface.includes('思考中的内容'), false, 'the region does not paint over the question')
  assert.ok(tail.top > layer.top, 'the region is composed below it')
  tui.handleEscape()
  await pending.catch(() => undefined)
})

// ── D. two defects reported against the previous round's work ───────────────

test('a resume composes no frame until the log is fully read, then lands at the bottom', async () => {
  // Reported as "coming in from a resume, the workspace does not sit at the bottom:
  // it scrolls from somewhere down to the end". Replay is chunked and yields, so
  // the cadence timer used to compose frames *between* chunks — each anchored to a
  // session that was still growing, which is the roll the reader saw (measured: 51
  // frames over 1.2 s on a 20k-event log, the window creeping 回答 3775 → 19976).
  const events = [{ type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } }]
  // Long enough that a 16 ms cadence *would* get frames in between: the assertion
  // is about frames that must not exist, so a short load would pass vacuously.
  for (let index = 0; index < 4000; index += 1) {
    events.push({
      type: index % 2 === 0 ? 'user/message' : 'assistant/message',
      seq: index + 1,
      time: Date.now(),
      data: index % 2 === 0
        ? { id: `u${index}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `问题 ${index}` }] }
        : { turn: 1, step: 1, stream: [], message: { id: `a${index}`, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: `回答 ${index}` }] } },
    })
  }
  const session = { id: 'main-session', events, seq: events.length, eventAt: index => events[index], snapshotEvents: () => events }
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  process.stdout.columns = 100
  process.stdout.rows = 30
  const composed = []
  const realPaint = tui.paint.bind(tui)
  tui.paint = () => {
    realPaint()
    composed.push({ loading: tui.loadingHistory, start: tui.lastTranscriptStart })
  }
  // A frame asked for *during* the walk is the deterministic half: the cadence
  // timer's own timing is the machine's business, but "a paint while the log is
  // being read composes nothing" is the contract (and what a slow log turns into
  // the rolling resume a reader reported).
  let paintedDuringWalk = 0
  const walk = session.eventAt
  session.eventAt = (index) => {
    if (index === 100) {
      tui.markDirty()
      tui.paint()
      paintedDuringWalk += 1
    }
    return walk(index)
  }
  tui.paintIntervalMs = 16
  tui.startRenderTimer()
  await tui.replayHistory()
  await new Promise(resolve => setTimeout(resolve, 120))
  session.eventAt = walk
  assert.equal(paintedDuringWalk, 1, 'the walk did ask for a frame')
  assert.equal(
    composed.some(frame => frame.loading && frame.start !== -1),
    false,
    'no frame was composed while the log was still being read',
  )
  assert.equal(composed.at(-1)?.start === -1, false, 'and one landed once it was read')
  const landing = tui.captureFrame(100, 30).map(line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, ''))
  const newest = String(tui.rows.filter(row => row.kind === 'assistant').at(-1)?.text ?? '')
  assert.ok(landing.some(line => line.includes(newest)), `the landing frame shows the newest reply (${newest}):\n${landing.join('\n')}`)
  const inputRow = landing.findIndex(line => line.trimStart().startsWith('>')) + 1
  assert.equal(tui.lastPaintedCursorRow(), inputRow, 'and the caret is on the composer')
})

test('a working turn never rewrites the composer row', () => {
  // The caret lives on the composer row, and a terminal draws an IME's composition
  // *at the caret* rather than into the buffer — so rewriting that row erases the
  // pre-edit, which Windows Terminal then redraws: the composing characters
  // flickering over the rows above the composer while a turn runs. The forced
  // chrome repaint starts below the input block now; a composer row is written only
  // when its own text changed.
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'running', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  const writes = []
  tui.write = chunk => { writes.push(String(chunk)) }
  // The size is the frame's, so it is set for the whole case rather than restored
  // by `captureFrame`: a size change between two frames is a full repaint, which
  // would mask what this case is about.
  const previousColumns = process.stdout.columns
  const previousRows = process.stdout.rows
  process.stdout.columns = 100
  process.stdout.rows = 24
  try {
    tui.waitStartedAt = Date.now()
    tui.paint()
    const rows = tui.lastPaintRows.map(line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, ''))
    const composerRow = rows.findIndex(line => line.trimStart().startsWith('>')) + 1
    assert.ok(composerRow > 1, 'the composer is on screen')
    assert.equal(tui.lastPaintedCursorRow(), composerRow, 'and that is where the caret is')

    for (const tick of ['the wait card\'s clock', 'a streamed character']) {
      writes.length = 0
      if (tick === 'a streamed character') tui.streaming = { text: 'x', reasoning: '' }
      tui.waitStartedAt = Date.now() - 1100
      tui.markDirty()
      tui.paint()
      const painted = [...writes.join('').matchAll(/\u001b\[(\d+);1H/gu)].map(match => Number(match[1]))
      assert.equal(painted.includes(composerRow), false, `${tick}: the composer row is left alone [${painted.join(',')}]`)
      assert.ok(painted.length > 0, `${tick}: something was still painted`)
    }
  } finally {
    process.stdout.columns = previousColumns
    process.stdout.rows = previousRows
  }
})

test('a styled fragment never reaches the sanitiser, so no escape body is printed', () => {
  // Reported from a quota report: the row under the Screen read `… Esc 返回[90m │ …`.
  // The separator is a *styled* fragment (its `\x1b[90m` is the mute), and that row is
  // styled as a whole by `styleLine`, whose sanitiser removes the ESC byte and keeps
  // the rest — so the escape's body landed on screen as text.
  // A palette is the point: the separator is only *styled* on a colour terminal
  // (`mutedSgr` returns nothing otherwise), which is exactly where the artifact
  // appears — so the depth is pinned rather than inherited from the runner.
  const previousDepth = process.env.DSH_TUI_COLOR_DEPTH
  process.env.DSH_TUI_COLOR_DEPTH = 'truecolor'
  try {
    // The palette is asked for at construction: `color: false` (the fixture's
    // default) forces the colour *depth* to `none`, which empties every muted
    // accent — the styled separator this case is about.
    const { tui } = fixture(undefined, {}, { color: true })
    tui.openScreen({ kind: 'inspect', title: '额度 usage', lines: [{ kind: 'system', text: '本周剩余 82%' }], offset: 0 })
    for (const width of [40, 60, 80, 120, 160]) {
      const frame = tui.captureFrame(width, 20)
      for (const [index, line] of frame.entries()) {
        const plain = line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '')
        assert.equal(
          /\[(?:\d+)(?:;\d+)*m/u.test(plain),
          false,
          `row ${index + 1} at width ${width} prints an escape body: ${JSON.stringify(plain)}`,
        )
      }
    }
    tui.handleEscape()
  } finally {
    if (previousDepth === undefined) delete process.env.DSH_TUI_COLOR_DEPTH
    else process.env.DSH_TUI_COLOR_DEPTH = previousDepth
  }
})

test('a message sent mid-turn is acknowledged where the reader can see it', async () => {
  // Reported: the "（将在下一步生效）" card disappeared. B2.3b had routed the
  // acknowledgement to the footer chip, which is the *first* group dropped on a
  // busy stats row — and a running turn is exactly that, so a reader who typed
  // mid-turn saw no confirmation at all. The record of the message is the
  // `user/message` the Harness writes when the next step claims it; this is the
  // acknowledgement, and it belongs on the notice row.
  const ctx = { get: () => undefined, on() { return () => {} } }
  const steered = []
  const agent = {
    id: 'main-session', options: {}, status: 'running',
    session: { id: 'main-session', events: [] }, cancel() {},
    steer: message => { steered.push(message) },
    followup: () => {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  tui.input = '顺便把日志也看一下'
  tui.cursor = tui.input.length
  tui.handleChar('\r')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(steered.length, 1, 'the message went to the agent')
  tui.captureFrame(90, 20)
  const notice = tui.currentNotice() ?? ''
  assert.match(notice, /将在下个步骤生效/u, `the acknowledgement is on the notice row: ${JSON.stringify(notice)}`)
  assert.match(notice, /顺便把日志也看一下/u, 'with what the reader typed')
  assert.equal(
    tui.rows.filter(row => row.kind === 'system' && String(row.text).includes('将在下个步骤生效')).length,
    0,
    'and it is not history: the durable row is the user message the step writes',
  )
})

test('line mode keeps question text and still answers', async () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {}, steer() {}, followup() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, lineMode: true })
  // Line mode writes through the attached relay; without one the lines are held
  // for whoever attaches next (which is the point of the handover, not a bug).
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  const written = []
  tui.write = chunk => { written.push(String(chunk)) }
  send(tui, { type: 'tool/call', seq: 1, time: Date.now(), data: { callId: 'call-q1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q1', question: '要部署到哪个环境？' }] }) } })
  assert.match(written.join(''), /要部署到哪个环境？/u, 'the question reaches the log as text')
  const pending = tui.handleUserQuestions({
    questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }, { label: '生产' }] }],
  })
  assert.ok(await waitUntil(() => written.join('').includes('预发')), `the options reach the log: ${written.join('')}`)
  tui.handleChar('\r')
  assert.equal((await pending).answers[0]?.selected[0], '预发', 'and the answer still works')
})

