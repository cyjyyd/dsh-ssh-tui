import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { allText, waitForText } from './wait.mjs'

/**
 * What a gap in the link does to the things that wait for a human.
 *
 * Phase 0's third guardrail, in two halves. These cases pin the *detached* half,
 * which needs no display at all: a TUI built with `headlessDisplay` and no host
 * yet has no live display, which is exactly the state a dropped link leaves.
 *
 * The attached half — a queued question still there and answerable after the
 * user reconnects, and the rejection visible in the repainted transcript — needs
 * a real display, and in-process that is a fight: the TUI owns the terminal
 * (alternate screen, hangup signals, `process.exit` on its exit paths), so a
 * started TUI writes escape sequences onto the test runner's stdout and takes
 * the runner's process down with it (observed: exit 129, the file reported as a
 * single failed test with no result). Those assertions belong in
 * `scripts/tui-drop-probe.mjs`, which drives a real PTY child instead.
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
    cancel() {},
  }
  return new SshTui(ctx, agent, { sessionId: 'main-session-away', color: false, headlessDisplay: true })
}

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
