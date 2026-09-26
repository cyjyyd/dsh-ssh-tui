import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setLocale } from '../lib/i18n/index.js'
import { waitingMarkerPath } from '../lib/question-wait.js'
import { SshTui } from '../lib/tui.js'
import { allText, waitForDialog, waitForText } from './wait.mjs'

/**
 * What a gap in the link does to the things that wait for a human.
 *
 * Phase 0's third guardrail, in two halves. These cases pin the *detached* half,
 * which needs no display at all: a TUI built with `headlessDisplay` and no host
 * yet has no live display, which is exactly the state a dropped link leaves.
 *
 * The attached half is here too, without starting a TUI: `hasLiveDisplay()`
 * asks `displayHost.attached`, and a headless TUI has no host, so assigning one
 * that reports an attach is exactly what a reconnect produces — the queue's
 * 200ms poll notices and the question appears. Starting a real TUI in-process
 * is not an option (it owns the terminal and takes the runner's process down
 * with it, observed as exit 129); `scripts/tui-drop-probe.mjs` covers the real
 * PTY path end to end.
 */
setLocale('zh')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A TUI with no display attached and nothing started behind it. */
function detachedTui() {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session-away',
    options: {},
    status: 'idle',
    session: { id: 'main-session-away', events: [] },
    // A real cancel ends the turn, and `handleHangup` waits for exactly that
    // (up to ten seconds) before deciding whether to keep the Host. A no-op
    // cancel made every busy-drop test pay that timeout.
    cancel() { agent.status = 'idle' },
  }
  return new SshTui(ctx, agent, { sessionId: 'main-session-away', color: false, headlessDisplay: true })
}

test('a question with nobody attached leaves a marker the jump host can see', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-question-wait-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const tui = detachedTui()
  try {
    const pending = tui.handleUserQuestions({
      questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }] }],
    })
    const marker = waitingMarkerPath('main-session-away', home)
    const text = await waitForMarker(marker, /question=要部署到哪个环境？/u)
    assert.match(text, /question=要部署到哪个环境？/u, 'the marker names the question')
    assert.match(text, /waiting=1/u)

    const aborter = new AbortController()
    const aborted = tui.handleUserQuestions({
      questions: [{ id: 'q2', question: '取消我' }],
      signal: aborter.signal,
    })
    aborter.abort()
    await assert.rejects(() => aborted)
    assert.equal(statSync(marker).isFile(), true, 'one question aborting leaves the other waiting')

    tui.displayHost = { attached: true, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
    await waitForDialog(tui, 'questions', { timeoutMs: 3_000 })
    tui.handleChar('\r')
    await pending
    await waitForMarkerGone(marker)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
    await tui.dispose()
  }
})

/**
 * The marker is written asynchronously; poll until it shows up *and* says what
 * it has to say.
 *
 * Polling for existence alone is what made this flaky on the Windows leg: the
 * file is created before it has content, so a read that lands in between gets
 * `''` — which the writer cannot prevent (see `writeWaitingMarker`: staging and
 * renaming is not an option there) and a consumer therefore has to tolerate. The
 * wait is for the content, and the returned text is the read that matched.
 */
async function waitForMarker(path, expected) {
  const deadline = Date.now() + 2_000
  let last = ''
  while (Date.now() < deadline) {
    try {
      last = readFileSync(path, 'utf8')
      if (expected.test(last)) return last
    } catch { /* not yet */ }
    await delay(20)
  }
  assert.fail(`the waiting marker never said ${expected} at ${path} (last read ${JSON.stringify(last)})`)
}

/** And removed once the question is answered. */
async function waitForMarkerGone(path) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      statSync(path)
    } catch {
      return
    }
    await delay(20)
  }
  assert.fail(`the waiting marker was left behind at ${path}`)
}

test('/notify smtp stores the command without the password', async () => {
  const saved = []
  const ctx = {
    get(name) {
      if (name !== 'settings') return undefined
      return { replace: async (_namespace, value) => { saved.push(value) } }
    },
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session-away', options: {}, status: 'idle',
    session: { id: 'main-session-away', events: [] }, cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session-away', color: false, headlessDisplay: true })
  try {
    tui.runCommand('/notify smtp mail.example.com from@a.c to@b.c alice s3cret')
    await delay(50)
    assert.equal(saved.length, 1, 'the command persists through settings')
    assert.match(saved[0].notify, /^python3 -c /u)
    assert.equal(saved[0].notify.includes('s3cret'), false, 'the password is not part of the command')
    assert.equal(saved[0].notifySmtpUser, 'alice')
    assert.equal(saved[0].notifySmtpPassword, 's3cret', 'it is stored beside the command instead')
    assert.ok(
      tui.rows.some(row => row.kind === 'system' && String(row.text).includes('mail.example.com:587')),
      'the confirmation names the server',
    )
    assert.equal(
      tui.rows.some(row => String(row.text ?? '').includes('s3cret')),
      false,
      'and the transcript never shows the password',
    )
  } finally {
    await tui.dispose()
  }
})

test('a question with nobody attached waits instead of resolving or half-drawing', async () => {
  const tui = detachedTui()
  let settled = false
  const pending = tui.handleUserQuestions({
    questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }, { label: '生产' }] }],
  }).then(answer => {
    settled = true
    return answer
  })

  await delay(150)
  assert.equal(settled, false, 'no display: the question waits for the user instead of resolving')
  assert.equal(tui.dialog, undefined, 'and it does not open a dialog nobody can answer')
  assert.equal(
    tui.rows.filter(row => row.kind === 'question').length,
    0,
    'the card is built only once a display can show it, so nothing is half-drawn',
  )

  // The wait is a queue, not a stall: an aborted question still ends, and the
  // one the user never saw keeps waiting.
  const aborter = new AbortController()
  const aborted = tui.handleUserQuestions({
    questions: [{ id: 'q2', question: '取消我', options: [{ label: '甲' }] }],
    signal: aborter.signal,
  })
  aborter.abort()
  await assert.rejects(() => aborted, 'an abort still ends a queued question')
  assert.equal(settled, false, 'the first question is still waiting for its turn')
})

test('an unrecognized approval while detached rejects and records why', async () => {
  const tui = detachedTui()
  tui.runCommand('/approval auto')
  await waitForText(tui, '自动审批')

  tui.rows.push({
    kind: 'tool',
    callId: 'call-deploy',
    name: 'bash',
    title: '终端',
    summary: '$ python deploy.py',
    args: JSON.stringify({ command: 'python deploy.py' }),
    command: 'python deploy.py',
    status: 'running',
    expanded: false,
  })
  // Raced against a clock: a detached approval that waited for a display would
  // hang the turn instead of finishing it, and a hang must fail this test.
  const outcome = await Promise.race([
    tui.handleApproval(
      { toolName: 'bash', callId: 'call-deploy', agent: tui.agent, reason: undefined },
      async () => { throw new Error('the waterfall must not run for a classified auto decision') },
    ),
    delay(1_500).then(() => { throw new Error('a detached approval must decide, not wait for a display') }),
  ])

  assert.equal(outcome, 'rejected', 'a detached turn must finish instead of stalling toward the idle kill')
  assert.equal(tui.dialog, undefined, 'and nobody is prompted where there is no display')
  assert.ok(
    allText(tui).includes('未识别且无显示器'),
    `the rejection carries its reason so the model can adapt: ${allText(tui)}`,
  )
  assert.ok(allText(tui).includes('python deploy.py'), 'and it names the command that was refused')
})

test('a dangerous shape is refused by the rules with or without a display', async () => {
  const tui = detachedTui()
  tui.runCommand('/approval auto')
  await waitForText(tui, '自动审批')

  tui.rows.push({
    kind: 'tool',
    callId: 'call-rm',
    name: 'bash',
    title: '终端',
    summary: '$ rm -rf /tmp/x',
    args: JSON.stringify({ command: 'rm -rf /tmp/x' }),
    command: 'rm -rf /tmp/x',
    status: 'running',
    expanded: false,
  })
  const outcome = await tui.handleApproval(
    { toolName: 'bash', callId: 'call-rm', agent: tui.agent, reason: undefined },
    async () => { throw new Error('the waterfall must not run for a classified auto decision') },
  )
  assert.equal(outcome, 'rejected')
  assert.ok(allText(tui).includes('危险形状'), `the rule table decides, not the display state: ${allText(tui)}`)
})

test('a queued question appears and is answerable once a display comes back', async () => {
  const tui = detachedTui()
  let settled = false
  const pending = tui.handleUserQuestions({
    questions: [{ id: 'q3', question: '回滚到哪个版本？', options: [{ label: '上一版' }, { label: '上上一版' }] }],
  }).then(answer => {
    settled = true
    return answer
  })

  await delay(250)
  assert.equal(settled, false, 'nobody is attached yet')
  assert.equal(tui.rows.filter(row => row.kind === 'question').length, 0)

  // The user reconnects: the same state a real relay produces, without a PTY.
  tui.displayHost = { attached: true, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  await waitForDialog(tui, 'questions', { timeoutMs: 3_000 })
  assert.ok(
    tui.rows.some(row => row.kind === 'question' && String(row.title).includes('回滚到哪个版本')),
    'the card is built once a display can show it',
  )

  tui.handleChar('\r')
  const answer = await pending
  assert.deepEqual(
    answer.answers,
    [{ id: 'q3', selected: ['上一版'], custom: undefined }],
    'the question the drop interrupted is answered, with its default',
  )
})

test('a rejection from the gap is visible in the transcript after reconnecting', async () => {
  const tui = detachedTui()
  tui.runCommand('/approval auto')
  await waitForText(tui, '自动审批')

  tui.rows.push({
    kind: 'tool',
    callId: 'call-gap',
    name: 'bash',
    title: '终端',
    summary: '$ python deploy.py',
    args: JSON.stringify({ command: 'python deploy.py' }),
    command: 'python deploy.py',
    status: 'running',
    expanded: false,
  })
  await tui.handleApproval(
    { toolName: 'bash', callId: 'call-gap', agent: tui.agent, reason: undefined },
    async () => { throw new Error('the waterfall must not run for a classified auto decision') },
  )

  // The user reconnects and the screen is repainted from the rows.
  tui.displayHost = { attached: true, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  const frame = tui.captureFrame(100, 30).join('\n')
  assert.ok(
    frame.includes('未识别且无显示器'),
    `the repainted screen must show what happened while nobody was watching:\n${frame}`,
  )
  assert.ok(frame.includes('python deploy.py'), 'and which command it was')
})

/**
 * The reconnect notice: the user comes back and is told that they were away,
 * for how long, and how often this Host has been reconnected.
 */
const fakeDisplay = () => ({ attached: true, sendStdout() {}, sendGoodbye() {}, close: async () => {} })

/**
 * The relay is gone: the Host object stays, but it no longer reports an attach.
 * A static fake kept saying `attached: true` after a hangup, so `hasLiveDisplay()`
 * stayed true and a detached approval went looking for a human to ask.
 */
function dropDisplay(tui) {
  if (tui.displayHost !== undefined) tui.displayHost.attached = false
}
const reconnectRows = tui => tui.rows
  .filter(row => row.kind === 'system' && String(row.text).includes('已重连'))
  .map(row => String(row.text))

test('a reconnect is announced once, with the count and the time away', async () => {
  const tui = detachedTui()
  // The boot attach is not a reconnect: nothing was dropped yet.
  tui.displayHost = fakeDisplay()
  tui.attachRelayDisplay()
  assert.deepEqual(reconnectRows(tui), [], 'the first attach is not a reconnect')

  // The link drops with the Host busy, which is the case that keeps it alive.
  tui.agent.status = 'running'
  await tui.handleHangup()
  dropDisplay(tui)
  await delay(1_100)
  tui.agent.status = 'idle'
  tui.displayHost = fakeDisplay()
  tui.attachRelayDisplay()

  assert.equal(reconnectRows(tui).length, 1, 'one drop, one notice')
  assert.match(reconnectRows(tui)[0], /^已重连 1 次 · 断开 \d+s$/u)

  // A second gap counts up, and the notice says so separately.
  tui.agent.status = 'running'
  await tui.handleHangup()
  dropDisplay(tui)
  await delay(150)
  tui.agent.status = 'idle'
  tui.displayHost = fakeDisplay()
  tui.attachRelayDisplay()
  assert.equal(reconnectRows(tui).length, 2, 'the second gap is its own notice')
  assert.match(reconnectRows(tui)[1], /^已重连 2 次 · 断开 \d+s$/u)
})

test('a resize while detached is still a reconnect, and does not double-count', async () => {
  const tui = detachedTui()
  tui.displayHost = fakeDisplay()
  tui.attachRelayDisplay()
  tui.agent.status = 'running'
  await tui.handleHangup()
  dropDisplay(tui)
  tui.agent.status = 'idle'

  // The Host learns the new size before the relay says HELLO: that path also
  // attaches, and must be the one that reports the reconnect.
  tui.displayHost = fakeDisplay()
  tui.attachRelayDisplay()
  // A later resize with the display already attached must not add another row.
  tui.attachRelayDisplay()
  assert.equal(reconnectRows(tui).length, 1, 'a re-attach of a live display is not a new reconnect')
})

/**
 * The away summary: what happened while nobody was watching. Deltas against the
 * counters at the drop, so a plain link blip stays one line.
 */
const awayRows = tui => tui.rows
  .filter(row => row.kind === 'system' && String(row.text).startsWith('离开'))
  .map(row => String(row.text))

/** Drop the display with the Host busy, then bring it back. */
async function dropAndReturn(tui, awayMs = 150) {
  tui.agent.status = 'running'
  await tui.handleHangup()
  dropDisplay(tui)
  await delay(awayMs)
  tui.agent.status = 'idle'
  tui.displayHost = fakeDisplay()
  tui.attachRelayDisplay()
}

test('a quiet gap gets no summary, only the reconnect line', async () => {
  const tui = detachedTui()
  tui.displayHost = fakeDisplay()
  tui.attachRelayDisplay()
  await dropAndReturn(tui)
  assert.deepEqual(reconnectRows(tui).length, 1, 'the reconnect is still announced')
  assert.deepEqual(awayRows(tui), [], 'nothing happened, so there is nothing to summarise')
})

test('approvals decided in the gap are summarised, including the detached refusals', async () => {
  const tui = detachedTui()
  tui.runCommand('/approval auto')
  await waitForText(tui, '自动审批')
  tui.displayHost = fakeDisplay()
  tui.attachRelayDisplay()

  // One approval BEFORE the drop: the summary must count the gap, not the
  // session's totals, so this one must not show up in it.
  const tool = (callId, command) => tui.rows.push({
    kind: 'tool',
    callId,
    name: 'bash',
    title: '终端',
    summary: `$ ${command}`,
    args: JSON.stringify({ command }),
    command,
    status: 'running',
    expanded: false,
  })
  tool('before-drop', 'git status')
  assert.equal(await tui.handleApproval(
    { toolName: 'bash', callId: 'before-drop', agent: tui.agent, reason: undefined },
    async () => { throw new Error('classified decisions must not reach the waterfall') },
  ), 'allowed-once')

  tui.agent.status = 'running'
  await tui.handleHangup()
  dropDisplay(tui)
  tui.agent.status = 'idle'

  // One low-risk shape the rules allow, and one unknown shape nobody can confirm.
  tool('gap-allow', 'git status')
  assert.equal(await tui.handleApproval(
    { toolName: 'bash', callId: 'gap-allow', agent: tui.agent, reason: undefined },
    async () => { throw new Error('classified decisions must not reach the waterfall') },
  ), 'allowed-once')
  tool('gap-deny', 'python deploy.py')
  assert.equal(await tui.handleApproval(
    { toolName: 'bash', callId: 'gap-deny', agent: tui.agent, reason: undefined },
    async () => { throw new Error('classified decisions must not reach the waterfall') },
  ), 'rejected')

  tui.displayHost = fakeDisplay()
  tui.attachRelayDisplay()
  assert.equal(awayRows(tui).length, 1, 'one summary for the gap')
  assert.match(awayRows(tui)[0], /^离开 \d+s：自动审批 1 次放行 \/ 1 次拒绝/u)
  assert.match(awayRows(tui)[0], /其中 1 次因无人确认被拒/u)
})

test('a question still queued at reattach is counted before its card exists', async () => {
  const tui = detachedTui()
  tui.displayHost = fakeDisplay()
  tui.attachRelayDisplay()

  tui.agent.status = 'running'
  await tui.handleHangup()
  dropDisplay(tui)
  tui.agent.status = 'idle'
  const pending = tui.handleUserQuestions({
    questions: [{ id: 'q-away', question: '继续部署吗？', options: [{ label: '继续' }] }],
  })
  await delay(50)

  tui.displayHost = fakeDisplay()
  tui.attachRelayDisplay()
  assert.equal(awayRows(tui).length, 1, 'the queued question is part of the summary')
  assert.match(awayRows(tui)[0], /1 条提问待回答/u)

  // It is also answerable, which is the promise the summary is reporting on.
  await waitForDialog(tui, 'questions', { timeoutMs: 3_000 })
  tui.handleChar('\r')
  assert.deepEqual((await pending).answers[0].selected, ['继续'])
})
