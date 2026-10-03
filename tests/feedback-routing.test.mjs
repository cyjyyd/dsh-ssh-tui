/**
 * B2.3b — feedback routing and the `/clear` cutoff.
 *
 * B2.3a classified every representation; this round decides where each one is
 * *shown*. The policy owns both (`src/representation.ts`), so a control-plane
 * confirmation cannot be a transcript row at one call site and a footer echo at the
 * next — and a reader can predict, from the durability alone, what a resume brings
 * back (`docs/decisions/b2-architecture-decisions.md` AD-4, AD-13).
 *
 * The `/clear` half is the other side of the same idea: the view can be cut, but the
 * *source* cannot. Nothing here deletes anything.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { REPRESENTATION_POLICY } from '../lib/representation.js'
import { SshTui } from '../lib/tui.js'
import { feedbackText, pushRow, tick, waitFor, waitForFeedback } from './wait.mjs'

setLocale('zh')

function fixture(options = {}) {
  const ctx = {
    get: name => (name === 'sessionProjections' ? { stateOf: () => ({ questions: { active: [], settled: [] } }) } : undefined),
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
    followup: async () => {},
    steer: async () => {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  for (let index = 0; index < (options.history ?? 30); index += 1) {
    pushRow(tui, { kind: index % 2 === 0 ? 'assistant' : 'user', text: `行 ${index}` })
  }
  return { tui, agent }
}

const plain = line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').trimEnd()
const frame = (tui, columns = 100, rows = 24) => tui.captureFrame(columns, rows).map(plain)

// ── A. acknowledgements become echoes ───────────────────────────────────────

test('a control-plane confirmation leaves the transcript and appears as an echo', async () => {
  const { tui } = fixture()
  const before = { rows: tui.rows.length, start: tui.lastTranscriptStart }
  tui.captureFrame(100, 24)
  const start = tui.lastTranscriptStart

  tui.runCommand('/theme mono')
  await tick(20)
  assert.equal(tui.rows.length, before.rows, 'a confirmation is not a transcript row')
  assert.equal(tui.lastTranscriptStart, start, 'and it does not move the window')
  assert.match(String(tui.currentFooterEcho()), /配色/, 'it is the footer echo instead')

  const painted = frame(tui)
  assert.ok(
    painted.some(line => line.includes('配色')),
    `the echo reaches the row the reader looks at:\n${painted.join('\n')}`,
  )
  assert.equal(
    painted.some(line => line.includes('配色') && line.includes('目录:')),
    false,
    'on the telemetry row, not mixed into the identity row',
  )
})

test('the newest echo replaces the previous one, and a submit clears it', async () => {
  const { tui } = fixture()
  tui.runCommand('/theme mono')
  await tick(20)
  const first = tui.currentFooterEcho()
  tui.runCommand('/view compact')
  await tick(20)
  const second = tui.currentFooterEcho()
  assert.notEqual(second, first, 'the newer acknowledgement is the one shown')
  assert.equal(feedbackText(tui).includes(String(first)), false, 'and the older one is gone')

  tui.input = '继续'
  tui.cursor = 2
  tui.handleChar('\r')
  await tick(20)
  assert.equal(tui.currentFooterEcho(), undefined, 'the reader moved on: the echo is spent')
})

test('an acknowledgement expires on its own, and the row goes back to the session', async () => {
  // B2.3b kept these until the next submit, on purpose and with no timer. Against
  // real use that is the wrong trade: a "copied 412 characters" chip is read in a
  // second, and until the reader types the row is a sentence about the past instead
  // of the telemetry it replaced. 0.8.2 gives them a clock.
  const { tui } = fixture()
  tui.feedbackTtlMs = 150
  tui.runCommand('/theme mono')
  await tick(30)          // the command itself settles on a microtask chain
  assert.match(String(tui.currentFooterEcho()), /配色已切换|mono/u, 'the acknowledgement is there to read')

  await tick(250)
  assert.equal(tui.currentFooterEcho(), undefined, 'and it leaves on its own')
  // The row is the session's again: one frame later it carries the ordinary stats.
  const lines = frame(tui)
  assert.equal(lines.some(line => /配色已切换/u.test(line)), false, 'the chip is gone from the frame')
  assert.ok(
    lines.some(line => /空闲|运行中/u.test(line)),
    `and the row is back to telemetry: ${JSON.stringify(lines.at(-2))}`,
  )
})

test('the queued-message notice waits for the message, not for a clock', async () => {
  // It is the only sign the reader has that a message is waiting, and it is true
  // until the step claims it — so its lifetime is the queue's, not the timer's.
  const { tui, agent } = fixture()
  agent.status = 'running'
  tui.feedbackTtlMs = 40
  tui.input = '加一句说明'
  tui.cursor = tui.input.length
  tui.handleChar('\r')
  await tick(10)
  assert.match(String(tui.currentNotice()), /下个步骤|next step/u, 'the notice says it is queued')

  await tick(90)
  assert.match(String(tui.currentNotice()), /下个步骤|next step/u, 'a clock does not take it away')

  const queued = [...tui.pendingMessages.keys()][0]
  assert.equal(typeof queued, 'string', 'the message is in the queue')
  // The event the Host delivers on `agent/inbox/claimed` (the fixture's `ctx.on` is a
  // no-op, so the handler is called the way the wiring calls it).
  tui.handleInboxClaimed({ agent, message: { id: queued } })
  assert.equal(tui.currentNotice(), undefined, 'it goes when the message is really submitted')
})

test('an echo survives a detach and does not survive a resume', async () => {
  const { tui } = fixture()
  tui.runCommand('/theme mono')
  await tick(20)
  const echo = tui.currentFooterEcho()
  tui.detachDisplay()
  await tick(10)
  tui.displayHost = { attached: true, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.attachRelayDisplay()
  await tick(10)
  assert.equal(tui.currentFooterEcho(), echo, 'the Host never died, so the acknowledgement is still there')

  // A resume is a new Host: nothing in a log would bring an echo back, and the
  // policy says so (`display`).
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', seq: 0, eventAt: () => undefined }, cancel() {} }
  const resumed = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  resumed.write = () => {}
  await resumed.replayHistory()
  assert.equal(resumed.currentFooterEcho(), undefined, 'a resumed session has no echo to restore')
  assert.equal(REPRESENTATION_POLICY['command-feedback'].durability, 'display')
})

test('a notice carries what is too big for a chip, and is not history either', async () => {
  const { tui } = fixture()
  const rows = tui.rows.length
  tui.runCommand('/no-such-command')
  await tick(20)
  assert.equal(tui.rows.length, rows, 'a mistyped command is not a transcript row')
  assert.match(String(tui.currentNotice()), /Unknown command|未知/u, 'it is the notice')
  const painted = frame(tui)
  assert.ok(painted.some(line => /Unknown command|未知/u.test(line)), 'drawn on the identity row')
  assert.equal(painted.at(-1)?.includes('目录:'), false, 'which the notice replaced for now')

  tui.input = 'x'
  tui.cursor = 1
  tui.handleChar('\r')
  await tick(20)
  assert.equal(tui.currentNotice(), undefined, 'and the next submit clears it')
})

test('a real failure keeps its place in the transcript', async () => {
  const { tui } = fixture()
  const rows = tui.rows.length
  // A refused preset *plan* is information the reader acts on; a mistyped value is
  // not. The policy draws that line, and these two cases pin both sides of it.
  tui.runCommand('/preset copy 不存在的来源 fresh')
  await tick(20)
  assert.ok(tui.rows.length > rows, 'a refused plan says so where it can be read again')
  const added = tui.rows.at(-1)
  assert.equal(added?.representation?.durability, 'display')
  assert.equal(added?.representation?.destination, 'transcript', 'routing is part of the policy')
})

// ── B. /clear is a view cutoff ──────────────────────────────────────────────

test('/clear hides the view and deletes nothing', async () => {
  const { tui } = fixture()
  const before = { rows: tui.rows.length, scroll: 4 }
  tui.scrollOffset = before.scroll
  tui.runCommand('/clear')
  await tick(20)

  assert.equal(tui.rows.length, before.rows, 'the source rows are untouched')
  assert.equal(tui.clearedRows, before.rows, 'the cutoff is a view boundary')
  assert.equal(tui.scrollOffset, 0, 'the viewport returns to the (new) tail')
  // The draft is the composer's, and a draft is only ever cleared by typing the
  // command *into* it (which is how this one was invoked) — not by the view cut.
  tui.input = '清空之后写的草稿'
  tui.cursor = tui.input.length
  tui.markDirty()
  assert.equal(tui.input, '清空之后写的草稿', 'a draft written after the cut is a draft')
  assert.match(String(tui.currentNotice()), /只清理显示/, 'the reader is told what it did')

  const painted = frame(tui)
  assert.equal(painted.some(line => /行 \d/u.test(line)), false, 'and the hidden history is not painted')
})

test('a durable event after the cutoff appears, and a hidden one is not resurrected', async () => {
  const { tui, agent } = fixture()
  tui.runCommand('/clear')
  await tick(20)
  assert.equal(frame(tui).some(line => /行 \d/u.test(line)), false)

  tui.handleSessionEvent(agent.session, {
    type: 'assistant/message',
    seq: 99,
    time: Date.now(),
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '清空之后的新回复' }] } },
  })
  const painted = frame(tui)
  assert.ok(painted.some(line => line.includes('清空之后的新回复')), 'new content is visible')
  assert.equal(painted.some(line => /行 \d/u.test(line)), false, 'the hidden rows are still hidden')

  // An update to a hidden row does not pull it back through the boundary: the
  // cutoff is a count from the front, and an update does not move a row.
  const hidden = tui.rows.find(row => row.kind === 'assistant')
  hidden.text = '被投影更新过的旧行'
  tui.markDirty()
  assert.equal(frame(tui).some(line => line.includes('被投影更新过的旧行')), false)
})

test('a resume shows the history /clear hid', async () => {
  // AD-4: the cutoff is Host-local. What a resume shows is the log — which was never
  // touched — and that is the documented behaviour, not a leak.
  const events = [
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '清空前的历史' }], source: { kind: 'user' } } },
  ]
  const { tui, agent } = fixture()
  tui.handleSessionEvent(agent.session, events[0])
  tui.runCommand('/clear')
  await tick(20)
  assert.equal(frame(tui).some(line => line.includes('清空前的历史')), false, 'hidden in this view')

  const ctx = { get: () => undefined, on() { return () => {} } }
  const resumedAgent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', seq: events.length, eventAt: seq => events[seq] }, cancel() {} }
  const resumed = new SshTui(ctx, resumedAgent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  resumed.write = () => {}
  await resumed.replayHistory()
  assert.ok(
    resumed.rows.some(row => String(row.text).includes('清空前的历史')),
    'a new Host reads the log, and the log still has it',
  )
})

test('the Surface queue and a Screen are not disturbed by /clear', async () => {
  const { tui } = fixture()
  const pending = tui.handleUserQuestions({ questions: [{ id: 'q1', question: '要部署到哪？', options: [{ label: '预发' }] }] })
  pending.catch(() => undefined)
  await waitFor(() => tui.dialog?.kind === 'questions', { describe: 'the question' })
  const queued = tui.handleUserQuestions({ questions: [{ id: 'q2', question: '第二个问题？', options: [{ label: '好' }] }] })
  queued.catch(() => undefined)
  await tick(10)
  assert.equal(tui.dialogQueue.length, 1, 'one Surface is waiting behind the open one')
  tui.runCommand('/clear')
  await tick(10)
  assert.equal(tui.dialogQueue.length, 1, 'a view command does not consume the queue')
  assert.equal(tui.dialog?.kind, 'questions', 'nor close the Surface that owns the keyboard')
  // The first Esc cancels the open question, which hands the keyboard to the queued
  // one; the second cancels that. Both promises are settled by their own Esc.
  tui.handleEscape()
  await pending.catch(() => undefined)
  await tick(10)
  tui.handleEscape()
  await queued.catch(() => undefined)
  await tick(0)
  assert.equal(tui.dialog, undefined, 'both Surfaces are settled')
})

// ── C. /find and the cutoff ─────────────────────────────────────────────────

test('local /find searches the visible view, not the log behind the cutoff', async () => {
  const { tui } = fixture()
  tui.runCommand('/find 行 20')
  await waitForFeedback(tui, '行 20')
  assert.equal(tui.searchHits.length, 1, 'the visible hit is found')

  tui.handleEscape()
  tui.runCommand('/clear')
  await tick(20)
  tui.runCommand('/find 行 20')
  await tick(20)
  assert.equal(tui.searchHits.length, 0, 'the same needle finds nothing once the view is cut')
  assert.match(String(tui.currentNotice()), /只搜索当前可见|on screen/u, 'and the boundary is explained')

  tui.handleSessionEvent({ id: 'main-session' }, {
    type: 'assistant/message',
    seq: 42,
    time: Date.now(),
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '行 20 之后的答案' }] } },
  })
  tui.runCommand('/find 行 20')
  await tick(20)
  assert.equal(tui.searchHits.length, 1, 'new content is searchable')
})

// ── D. the Screen keeps its keyboard, and says so ───────────────────────────

test('typing at a Screen is explained instead of swallowed', async () => {
  const { tui } = fixture()
  const rows = tui.rows.length
  tui.runCommand('/status')
  await waitFor(() => tui.screen?.report === 'status', { describe: 'the report Screen' })
  // Written while the Screen owns the screen: a Screen has no composer (AD-8), so it
  // must neither receive the characters nor damage the draft behind it.
  tui.input = '草稿'
  tui.cursor = 2
  tui.handleChar('/')
  tui.handleChar('m')
  tui.handleChar('o')
  assert.equal(tui.input, '草稿', 'the workspace draft is not the Screen\'s field')
  assert.equal(tui.rows.length, rows, 'and nothing was written to the transcript')
  assert.equal(tui.dialog, undefined, 'no Surface was opened behind the Screen')
  assert.equal(tui.dialogQueue.length, 0, 'and none was queued')
  assert.match(String(tui.screen?.notice ?? ''), /报告视图|report view/u, 'the Screen says why nothing happened')

  // Repeated keys do not pile up: it is one hint row, replaced by itself.
  const hint = tui.screen.notice
  tui.handleChar('x')
  tui.handleChar('y')
  assert.equal(tui.screen.notice, hint, 'still the same single hint')

  tui.handleEscape()
  await tick(0)
  assert.equal(tui.screen, undefined, 'Esc still leaves the Screen')
})

test('line mode keeps its textual feedback', async () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {}, followup: async () => {}, steer: async () => {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, lineMode: true })
  tui.write = () => {}
  const rows = tui.rows.length
  tui.runCommand('/theme mono')
  await tick(20)
  assert.ok(tui.rows.length > rows, 'line mode has no footer to echo into, so the feedback stays a row')
  assert.match(String(tui.rows.at(-1)?.text ?? ''), /配色/)
})

// ── E. the routing table itself ─────────────────────────────────────────────

test('every source has a destination, and none of them is a guess', () => {
  const destinations = new Set(['transcript', 'echo', 'notice'])
  for (const [source, policy] of Object.entries(REPRESENTATION_POLICY)) {
    assert.ok(destinations.has(policy.destination), `${source}: destination ${policy.destination}`)
  }
  // The families the brief called out, stated as the table states them.
  assert.equal(REPRESENTATION_POLICY['command-feedback'].destination, 'echo')
  assert.equal(REPRESENTATION_POLICY['command-misuse'].destination, 'notice')
  assert.equal(REPRESENTATION_POLICY['command-error'].destination, 'transcript')
  assert.equal(REPRESENTATION_POLICY['command-status'].destination, 'transcript')
  assert.equal(REPRESENTATION_POLICY['changes-card'].destination, 'transcript')
  // B2.4 settled the approval family: a refusal is the transient notice, a grant is
  // the footer chip, and the durable home of either is the tool card it guarded —
  // never a transcript row of its own.
  assert.equal(REPRESENTATION_POLICY['approval-notice'].destination, 'notice')
  assert.equal(REPRESENTATION_POLICY['approval-allowance'].destination, 'echo')
  assert.equal(REPRESENTATION_POLICY['tool-call'].destination, 'transcript')
  assert.equal(REPRESENTATION_POLICY['onboarding'].destination, 'transcript', 'left for B2.6')
  assert.equal(REPRESENTATION_POLICY['away-summary'].destination, 'transcript', 'AD-13\'s causal exception')
})

test('the audit reports the routing of a real transcript', () => {
  const { tui } = fixture({ history: 5 })
  tui.runCommand('/theme mono')
  const audit = tui.representationAudit()
  assert.equal(audit.unknownDestination, 0, 'every row carries a route')
  assert.ok(audit.destinations.transcript > 0, 'the transcript has rows')
  assert.equal(audit.destinations.echo, 0, 'an echo is not a row, so it is not counted here')
  assert.equal(audit.liveRows, 0, 'and B2.2 still holds: no live source row')
  assert.equal(audit.unclassified, 0)
})

// ── F. card focus (the two defects reported alongside this round) ───────────

test('the selection highlight follows the focused card, in every state', () => {
  const { tui } = fixture({ history: 0 })
  // Two cards of the *same kind*: the cache key used to record only the focused
  // row's kind, so moving between them replayed the old card's highlighted lines.
  pushRow(tui, { kind: 'tool', callId: 'c1', name: 'bash', args: '{}', status: 'ok', output: '一\n二', title: 'bash: A', summary: 'ls', expanded: false })
  pushRow(tui, { kind: 'tool', callId: 'c2', name: 'bash', args: '{}', status: 'ok', output: 'x', title: 'bash: B', summary: 'pwd', expanded: false })
  tui.color = true
  const [a, b] = tui.rows.filter(row => row.kind === 'tool')
  // Raw rows: `frame()` strips the escapes the highlight is made of.
  const highlighted = () => tui.captureFrame(90, 24)
    .map((line, index) => [index, line])
    .filter(([, line]) => line.includes('\u001b[7m'))
    .map(([index]) => index + 1)

  tui.focusedRow = a
  const onA = highlighted()
  assert.equal(onA.length, 1, `exactly one card is highlighted:\n${frame(tui, 90, 24).join('\n')}`)
  tui.focusedRow = b
  const onB = highlighted()
  assert.equal(onB.length, 1, 'still exactly one')
  assert.notDeepEqual(onB, onA, 'and it is the card the reader moved to')

  // Expanding keeps the highlight: the marker used to stay while the row stopped
  // reading as selected.
  tui.focusedRow = a
  tui.toggleCard(a)
  const expanded = highlighted()
  assert.equal(expanded.length, 1, `an expanded card keeps its highlight:\n${frame(tui, 90, 24).join('\n')}`)
})

test('the live thinking card keeps the reader’s expansion for the whole turn', async () => {
  const { tui, agent } = fixture({ history: 3 })
  tui.agent.status = 'running'
  const stream = chunk => tui.handleAssistantStream({
    agent,
    frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: Date.now(), chunk },
  })
  const settle = (reasoning, text) => tui.handleSessionEvent(agent.session, {
    type: 'assistant/message',
    time: Date.now(),
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [
          ...(reasoning === '' ? [] : [{ type: 'reasoning', text: reasoning }]),
          ...(text === '' ? [] : [{ type: 'text', text }]),
        ],
      },
    },
  })
  tui.handleAssistantStream({ agent, frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 } })
  stream({ type: 'reasoning-delta', index: 0, text: '第一段思考' })
  tui.focusedRow = tui.streamingReasoning
  tui.toggleCollapsible()
  assert.equal(tui.streamingReasoning.expanded, true, 'it expands while the model is thinking')

  // The next phase of the same turn must not fold it back under the reader.
  tui.streaming.reasoning = ''
  stream({ type: 'reasoning-delta', index: 1, text: '第二段思考' })
  assert.equal(tui.streamingReasoning.expanded, true, 'a new reasoning phase keeps the choice')

  // Neither must the next *step*. A turn thinks, calls a tool, and thinks again:
  // the phase settles into a row, a fresh live card is created for what follows,
  // and that card used to start collapsed — the choice lasted exactly one phase and
  // then the card the reader was reading folded itself shut. That is "the thinking
  // card cannot be expanded, you only see it once thinking is done", as reported.
  settle('第一段思考', '先做这一步')
  const settled = tui.rows.findLast(row => row.kind === 'reasoning')
  assert.equal(settled?.expanded, true, 'the settled card inherits the choice')
  stream({ type: 'reasoning-delta', index: 2, text: '第三段思考' })
  assert.equal(tui.streamingReasoning?.expanded, true, 'and the next step’s live card opens expanded too')

  // A new turn is new thinking. The turn closes first — `turn/end` is what drops a
  // half-streamed latch — and the next one opens with a collapsed card whatever the
  // reader chose in the last one.
  tui.handleSessionEvent(agent.session, { type: 'turn/end', time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
  tui.handleSessionEvent(agent.session, { type: 'turn/start', seq: 5, time: Date.now(), data: { turn: 2 } })
  assert.equal(tui.streamingReasoning, undefined, 'a new turn clears the card')
  tui.handleAssistantStream({ agent, frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 2, step: 1 } })
  stream({ type: 'reasoning-delta', index: 0, text: '新回合的思考' })
  assert.equal(tui.streamingReasoning?.expanded, false, 'and the reader’s choice does not survive it')
})
