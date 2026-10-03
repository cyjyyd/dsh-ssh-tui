/**
 * B2.5 — the plan artifact as a projection, and what the readers see.
 *
 * The projection's own rules are pinned in `plan-projection.test.mjs`; these cases are
 * about the *wiring*: the transcript row, the dock and the review Surface all read the
 * fold, a replay produces the same artifact as the live session did, and the dock
 * degrades deterministically instead of disappearing when the terminal is short.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { represent } from '../lib/representation.js'
import { feedbackText } from './wait.mjs'

setLocale('zh')

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
const REFUSED_FEEDBACK = 'The user chose to keep planning; their feedback: 加上回滚步骤'

function fixture({ color = false } = {}) {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session', options: {}, status: 'idle',
    session: { id: 'main-session', events: [] }, cancel() {}, steer() {}, followup() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  return { tui, agent }
}

const send = (tui, agent, event) => tui.handleSessionEvent({ id: agent.id }, {
  seq: event.seq, time: Date.now(), ...event,
})

const plain = line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').trimEnd()
const frame = (tui, columns, rows) => tui.captureFrame(columns, rows).map(plain)

/** The dock's own row, at any of its three levels and either marker. */
const dockRow = lines => lines.findIndex(line => /[▸▾] 计划模式/u.test(line))
const lifecycle = tui => tui.rows.filter(row => row.kind === 'system' && /计划/u.test(String(row.text)))

// ── A. the transcript row is an artifact reference ──────────────────────────

test('a plan row stands for one artifact, and its state comes from the fold', () => {
  const { tui, agent } = fixture()
  for (const event of [MODE_ON(1), WRITE(2, steps('in_progress', 'pending'))]) send(tui, agent, event)
  const row = tui.rows.findLast(candidate => candidate.kind === 'plan')
  assert.equal(row?.artifactId, 'plan@1')
  assert.equal(row?.state, 'draft', 'plan mode, nothing reviewed yet')
  assert.equal(row?.active, true)
  assert.deepEqual(row?.todos.map(step => step.status), ['in_progress', 'pending'])

  send(tui, agent, CALL(3, 'exit-1', '# 计划'))
  send(tui, agent, RESULT(4, 'exit-1', APPROVED))
  const after = tui.rows.findLast(candidate => candidate.kind === 'plan')
  assert.equal(after, row, 'the same row: a revision is not a new plan')
  assert.equal(after?.state, 'approved')

  send(tui, agent, MODE_OFF(5))
  assert.equal(row?.state, 'executing', 'approved, mode left, work still open')
})

test('two plans in one session are two rows, and only the live one docks', () => {
  const { tui, agent } = fixture()
  // Two *plan-mode episodes*: the first is finished, the second is live. (A plain todo
  // list with no plan mode docks too, but then its own line reads 计划 rather than
  // 计划模式 — the same word the finished artifact's transcript card starts with.)
  for (const event of [
    MODE_ON(1), WRITE(2, [{ content: '旧计划的最后一步', status: 'completed' }]), MODE_OFF(3),
    MODE_ON(4), WRITE(5, [{ content: '新计划的第一步', status: 'pending' }]),
  ]) send(tui, agent, event)
  const plans = tui.rows.filter(row => row.kind === 'plan')
  assert.deepEqual(plans.map(row => row.artifactId), ['plan@1', 'plan@4'])
  assert.deepEqual(plans.map(row => row.archived), [true, false])
  const lines = frame(tui, 100, 20)
  const dock = dockRow(lines)
  assert.notEqual(dock, -1, `the newest live plan is docked:\n${lines.join('\n')}`)
  const boundary = lines.findIndex(line => line.startsWith('╭'))
  assert.ok(dock < boundary, 'and the dock sits above the composer')
  assert.equal(
    lines.slice(dock).some(line => line.includes('旧计划的最后一步')),
    false,
    `the dock does not show the finished artifact:\n${lines.slice(dock).join('\n')}`,
  )
})

test('a replay rebuilds the same artifact, row and dock', () => {
  const events = [
    MODE_ON(1), WRITE(2, steps('in_progress', 'pending')), CALL(3, 'exit-1', '# 计划'),
    RESULT(4, 'exit-1', REFUSED_FEEDBACK, true), WRITE(5, steps('pending', 'pending')),
    CALL(6, 'exit-2', '# 计划 v2'), RESULT(7, 'exit-2', APPROVED), MODE_OFF(8),
  ]
  const live = fixture()
  for (const event of events) send(live.tui, live.agent, event)
  const replay = fixture()
  replay.tui.replaying = true
  for (const event of events) send(replay.tui, replay.agent, event)
  replay.tui.replaying = false

  const shape = tui => tui.rows
    .filter(row => row.kind === 'plan')
    .map(row => `${row.artifactId}/${row.state}/${row.provenance}/${row.todos.map(step => step.status).join('')}`)
  assert.deepEqual(shape(replay.tui), shape(live.tui))
  assert.equal(shape(live.tui)[0], 'plan@1/executing/durable/pendingpending', 'the latest revision is what the artifact shows')
  assert.deepEqual(
    live.tui.rows.filter(row => row.kind === 'system').map(row => String(row.text)),
    replay.tui.rows.filter(row => row.kind === 'system').map(row => String(row.text)),
    'and the lifecycle lines a reader scrolls through are the same',
  )
})

// ── B. lifecycle in the transcript ──────────────────────────────────────────

test('entering plan mode is one line, and the plan body is not a second copy', () => {
  const { tui, agent } = fixture()
  send(tui, agent, MODE_ON(1))
  send(tui, agent, WRITE(2, steps('pending')))
  send(tui, agent, CALL(3, 'exit-1', '# 修复构建\n- 甲\n- 乙'))
  const lines = lifecycle(tui).map(row => String(row.text))
  assert.equal(lines.filter(text => text.includes('计划模式')).length, 1, `one line for entering:\n${lines.join('\n')}`)
  assert.equal(
    tui.rows.filter(row => String(row.text ?? '').includes('甲')).length,
    0,
    'the body is not a transcript row of its own',
  )
  // The dock *is* the artifact's live view, so the body appears there — once, not twice.
  const painted = frame(tui, 100, 20)
  assert.ok(painted.filter(line => line.includes('甲')).length <= 1, `the body is painted at most once:\n${painted.join('\n')}`)
})

test('a refusal, a dismissal and an approval each say themselves once', () => {
  for (const [result, expected] of [
    [{ text: REFUSED, error: true }, /计划被退回：继续规划/u],
    [{ text: REFUSED_FEEDBACK, error: true }, /加上回滚步骤/u],
    [{ text: 'The user dismissed the plan review to speak instead; stay in plan mode', error: true }, /计划审阅被搁置/u],
    [{ text: APPROVED, error: false }, /计划已批准/u],
  ]) {
    const { tui, agent } = fixture()
    send(tui, agent, MODE_ON(1))
    send(tui, agent, WRITE(2, steps('pending')))
    send(tui, agent, CALL(3, 'exit-1', '# 修复构建'))
    send(tui, agent, RESULT(4, 'exit-1', result.text, result.error))
    const said = feedbackText(tui)
    assert.match(said, expected, `${result.text.slice(0, 30)}… is said`)
    const count = tui.rows.filter(row => expected.test(String(row.text))).length
    assert.equal(count, 1, 'exactly once')
  }
})

test('a plan review never becomes an ordinary question summary', async () => {
  const { tui, agent } = fixture()
  send(tui, agent, MODE_ON(1))
  send(tui, agent, WRITE(2, steps('pending')))
  const pending = tui.handleUserQuestions({
    questions: [{
      id: 'plan-review',
      header: 'Plan review',
      question: 'Approve this plan and leave plan mode?',
      detail: '# 修复构建',
      options: [{ label: '批准' }, { label: '继续规划' }],
      intent: { kind: 'plan-review', approve: '批准' },
    }],
    agent,
  })
  pending.catch(() => undefined)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(tui.rows.some(row => row.kind === 'question'), false, 'no question card')
  assert.equal(tui.dialog?.kind, 'questions', 'the Surface still asks')
  assert.equal(tui.questionPrimaryAudit().questionRows, 0)
  tui.handleEscape()
  await pending.catch(() => undefined)
})

// ── C. the dock ─────────────────────────────────────────────────────────────

test('the dock degrades in density, never in existence', () => {
  const { tui, agent } = fixture()
  send(tui, agent, MODE_ON(1))
  send(tui, agent, WRITE(2, steps('in_progress', 'pending', 'pending')))
  send(tui, agent, CALL(3, 'exit-1', '# 修复构建\n- 甲\n- 乙'))
  send(tui, agent, RESULT(4, 'exit-1', REFUSED, true))
  // The refusal keeps plan mode on (that is what "keep planning" means), so every level
  // of the dock leads with 计划模式 and the completed steps are still in front of it.

  const full = frame(tui, 120, 30)
  assert.ok(full[dockRow(full)]?.includes('修复构建'), `FULL names the plan:\n${full.join('\n')}`)
  assert.ok(full.some(line => line.includes('第 1 步')), 'and shows the steps')

  const compact = frame(tui, 120, 12)
  const compactDock = compact[dockRow(compact)] ?? ''
  assert.ok(/[▸▾] 计划模式/u.test(compactDock), `COMPACT keeps the mode: ${compactDock}`)
  assert.ok(/第 1 步/u.test(compactDock), `and the current step: ${compactDock}`)
  assert.ok(compact.length === 12, 'the frame still fits the terminal')

  const minimal = frame(tui, 120, 8)
  const minimalDock = minimal[dockRow(minimal)] ?? ''
  assert.ok(/[▸▾] 计划模式/u.test(minimalDock), `MINIMAL keeps the mode: ${minimalDock}`)
  assert.ok(/进行中|待处理|\d+\/\d+/u.test(minimalDock), `and the progress: ${minimalDock}`)

  const tiny = frame(tui, 72, 8)
  assert.notEqual(dockRow(tiny), -1, `at 72×8 the dock is still there:\n${tiny.join('\n')}`)
})

test('a live region never takes the dock’s rows, however tall it gets', () => {
  const { tui, agent } = fixture()
  send(tui, agent, MODE_ON(1))
  send(tui, agent, WRITE(2, steps('in_progress', 'pending')))
  for (let index = 0; index < 40; index += 1) {
    tui.pushRow(represent('fixture', { kind: 'assistant', text: `流式输出 ${index}` }))
  }
  tui.streaming = { text: '正在输出的内容 '.repeat(40), reasoning: '' }
  for (const rows of [30, 20, 14, 10, 8]) {
    const lines = frame(tui, 100, rows)
    const dock = dockRow(lines)
    const region = tui.liveTailRegion
    assert.notEqual(dock, -1, `${rows} rows: the dock is on screen:\n${lines.join('\n')}`)
    assert.notEqual(region, undefined, `${rows} rows: the region is projected`)
    assert.ok(
      region.top - 1 + region.rows <= dock,
      `${rows} rows: the region ends above the dock (region ${region.top}..${region.top - 1 + region.rows}, dock ${dock + 1})`,
    )
    assert.ok(lines.length === rows, `${rows} rows: the frame fits`)
  }
})

test('an interaction outranks the dock, and the dock comes back after it', async () => {
  const { tui, agent } = fixture()
  send(tui, agent, MODE_ON(1))
  send(tui, agent, WRITE(2, steps('in_progress', 'pending')))
  assert.notEqual(dockRow(frame(tui, 100, 20)), -1)

  const pending = tui.handleUserQuestions({
    questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }, { label: '生产' }] }],
  })
  pending.catch(() => undefined)
  await new Promise(resolve => setTimeout(resolve, 20))
  const during = frame(tui, 100, 20)
  assert.equal(dockRow(during), -1, `the dock yields to the interaction:\n${during.join('\n')}`)
  assert.ok(during.some(line => line.includes('预发')), 'which owns its rows')
  tui.handleEscape()
  await pending.catch(() => undefined)
  assert.notEqual(dockRow(frame(tui, 100, 20)), -1, 'and the dock is back afterwards')
})

// ── D. detach / line mode / the reported feedback regression ────────────────

test('a docked plan survives a detach and reattach with the same identity', async () => {
  const { tui, agent } = fixture()
  send(tui, agent, MODE_ON(1))
  send(tui, agent, WRITE(2, steps('in_progress', 'pending')))
  const before = tui.rows.findLast(row => row.kind === 'plan')?.artifactId
  tui.detachDisplay()
  await new Promise(resolve => setTimeout(resolve, 10))
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.attachRelayDisplay()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(tui.rows.findLast(row => row.kind === 'plan')?.artifactId, before)
  assert.equal(tui.rows.findLast(row => row.kind === 'plan')?.state, 'draft')
  assert.notEqual(dockRow(frame(tui, 100, 20)), -1, 'and it is still docked')
})

test('line mode still prints the plan, the review and its outcome', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const written = []
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, lineMode: true })
  // Line mode writes through the attached relay (the launcher owns the TTY), so the
  // bytes are collected there rather than from `tui.write`.
  tui.displayHost = {
    attached: true, pendingBytes: () => 0,
    sendStdout: chunk => { written.push(String(chunk)) },
    sendGoodbye() {}, close: async () => {},
  }
  tui.write = chunk => { written.push(String(chunk)) }
  for (const event of [MODE_ON(1), WRITE(2, steps('in_progress', 'pending')), CALL(3, 'exit-1', '# 修复构建\n- 甲')]) {
    send(tui, agent, event)
  }
  send(tui, agent, RESULT(4, 'exit-1', REFUSED_FEEDBACK, true))
  const text = written.join('')
  assert.match(text, /已进入计划模式/u, 'the mode switch is in the log')
  assert.match(text, /第 1 步/u, 'so is the step list')
  assert.match(text, /加上回滚步骤/u, 'and the review outcome')
  assert.equal(/\x1b\[\d+;\d+H/u.test(text), false, 'with no cursor addressing')
})

test('an acknowledgement the footer could not fit is still shown', () => {
  // The echo chip is the lowest-priority group on the stats row, which is exactly the
  // state a working session is in — so a command's confirmation used to vanish.
  const { tui, agent } = fixture()
  agent.status = 'running'
  tui.waitStartedAt = Date.now()
  tui.quotaSnapshot = { provider: 'deepseek', plan: 'Pro', windows: [{ label: '本周', period: 'weekly', remainingPercent: 82 }] }
  tui.contextPressure = { usedTokens: 12_000, limitTokens: 64_000, remainingPercent: 81 }
  for (let index = 0; index < 40; index += 1) {
    tui.pushRow(represent('fixture', { kind: index % 2 === 0 ? 'assistant' : 'user', text: `行 ${index}` }))
  }
  tui.pushRow(represent('command-feedback', { kind: 'system', text: '主题已切换：mono' }))
  for (const width of [160, 120, 100, 80, 72]) {
    const lines = frame(tui, width, 24)
    assert.ok(
      lines.some(line => line.includes('主题已切换：mono')),
      `${width} columns: the acknowledgement is on screen:\n${lines.join('\n')}`,
    )
  }
})

test('the plan audit counts one primary representation per artifact', () => {
  const { tui, agent } = fixture()
  for (const event of [MODE_ON(1), WRITE(2, steps('in_progress', 'pending')), CALL(3, 'exit-1', '# 修复构建')]) {
    send(tui, agent, event)
  }
  const audit = tui.questionPrimaryAudit()
  assert.equal(audit.questionRows, 0, 'the review is not a question summary')
  const plans = tui.rows.filter(row => row.kind === 'plan')
  assert.equal(plans.length, 1, 'one artifact, one row')
  assert.equal(plans[0]?.artifactId, 'plan@1')
})

test('the leftover-todo notice is not a plan row', () => {
  // The B2 final audit found this line misclassified: the turn-end notice went
  // through `plan-row` while carrying a plain system row. `plan-row` is the
  // artifact's *reference in the transcript* — it has steps and an artifact id —
  // so a sentence about the turn wearing that representation made the audit's
  // `plan-row` count disagree with the artifacts it names, and put a row with no
  // `todos` onto the plan card's own paint path.
  const { tui, agent } = fixture()
  // No `seq`: this is the live path, and a live `todo/write` carries no sequence.
  tui.handleSessionEvent({ id: agent.id }, WRITE(undefined, steps('in_progress', 'pending')))
  tui.turnSawOutput = true
  tui.handleSessionEvent({ id: agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const plans = tui.rows.filter(row => row.kind === 'plan')
  assert.equal(plans.length, 1, 'the notice did not add a second plan row')
  assert.equal(plans[0]?.todos.length, 2, 'and did not leave a step-less one on the card path')
  // The representation is the tell: the notice is a `plan-notice`, and it went to
  // the footer echo the way every notice does — not into the transcript as a
  // second artifact reference.
  assert.equal(tui.rows.some(row => String(row.text ?? '').includes('本轮未收尾')), false, 'no transcript row')
  assert.ok(String(tui.footerEcho?.text ?? '').includes('本轮未收尾'), `the echo carries it: ${tui.footerEcho?.text}`)
  // The rule behind the finding, as one assertion: a plan row is an artifact
  // reference or it is not a plan row.
  for (const row of tui.rows) {
    if (row.representation?.source !== 'plan-row') continue
    assert.equal(row.kind, 'plan', `a ${row.kind} row claims to be an artifact reference`)
    assert.equal(typeof row.artifactId, 'string', 'and it names the artifact it stands for')
  }
  // The dock's own note still carries the sentence on screen, so moving the row
  // off the transcript cost the reader nothing.
  assert.ok(frame(tui, 100, 20).some(line => line.includes('本轮未收尾')), 'the notice is still on screen')
})
