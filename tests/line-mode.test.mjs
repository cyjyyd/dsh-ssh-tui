import test from 'node:test'
import assert from 'node:assert/strict'

import { appendRow, lineModeEnabled, lineModeLines } from '../lib/line-mode.js'

/**
 * C-3: line mode turns events into log lines.
 *
 * The full-screen painter addresses rows absolutely and repaints in place; a
 * screen reader or a `tee` sees the same event twice, out of order, or not at
 * all. These rules say what one event contributes and how it is appended.
 */
test('the environment asks for line mode in the usual spellings', () => {
  for (const value of ['1', 'true', 'ON', 'yes', ' yes ']) {
    assert.equal(lineModeEnabled({ DSH_TUI_LINE_MODE: value }), true, value)
  }
  for (const value of ['', '0', 'false', 'off', 'no']) {
    assert.equal(lineModeEnabled({ DSH_TUI_LINE_MODE: value }), false, value)
  }
  assert.equal(lineModeEnabled({}), false)
})

test('a message contributes its own lines, one per line', () => {
  assert.deepEqual(lineModeLines({ kind: 'assistant', text: 'first\nsecond' }), ['first', 'second'])
  assert.deepEqual(lineModeLines({ kind: 'system', text: 'notice' }), ['notice'])
  assert.deepEqual(lineModeLines({ kind: 'error', text: 'boom' }), ['boom'])
  assert.deepEqual(lineModeLines({ kind: 'diag', text: 'a\nb\nc' }), ['a', 'b', 'c'])
})

test('screen-only rows contribute nothing', () => {
  assert.deepEqual(lineModeLines({ kind: 'brand-logo' }), [])
})

test('a tool contributes its title, and its change or its output', () => {
  const bare = lineModeLines({
    kind: 'tool', callId: 'c', name: 'bash', title: 'bash', summary: '$ ls', args: '{}', status: 'ok', expanded: false,
  })
  assert.deepEqual(bare, ['bash  $ ls'])
  const withOutput = lineModeLines({
    kind: 'tool', callId: 'c', name: 'bash', title: 'bash', summary: '$ ls', args: '{}', output: 'a\nb', status: 'ok', expanded: false,
  })
  assert.deepEqual(withOutput, ['bash  $ ls', 'a', 'b'])
  const withDiff = lineModeLines({
    kind: 'tool', callId: 'c', name: 'edit', title: 'edit', summary: 'a.ts', args: '{}', status: 'ok', expanded: false,
    diff: [{ path: 'a.ts', oldText: 'old', newText: 'new' }],
  })
  assert.deepEqual(withDiff, ['edit  a.ts', 'a.ts', '- old', '+ new'])
})

test('a plan lists its todos, and a goal its objective', () => {
  const plan = lineModeLines({
    kind: 'plan', planMarkdown: '# plan', todos: [{ content: 'step', status: 'pending' }], active: true, pending: true,
  })
  assert.deepEqual(plan, ['# plan', '[pending] step'])
  assert.deepEqual(lineModeLines({ kind: 'goal', objective: 'ship it', phase: 'active' }), ['ship it'])
})

test('appending adds one newline per line and nothing else', () => {
  assert.equal(appendRow(['a', 'b']), 'a\nb\n')
  assert.equal(appendRow([]), '')
  const appended = appendRow(lineModeLines({ kind: 'assistant', text: 'x' }))
  assert.equal(/[\r\u001b]/u.test(appended), false, 'no carriage return and no escape')
})

/**
 * The mode reaches the terminal: no framing, no addressing, every event once.
 */
async function lineModeTui({ attach = true } = {}) {
  const { SshTui } = await import('../lib/tui.js')
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true, lineMode: true })
  const written = []
  const attachDisplay = () => {
    tui.displayHost = {
      attached: true,
      sendStdout: chunk => { written.push(String(chunk)) },
      sendGoodbye() {},
      close: async () => {},
    }
    tui.attachRelayDisplay()
  }
  if (attach) attachDisplay()
  const since = () => {
    const mark = written.length
    return () => written.slice(mark).join('')
  }
  return { tui, written: () => written.join(''), attachDisplay, since }
}

test('events produced before a display attaches are held, not lost', async () => {
  const { tui, written, attachDisplay } = await lineModeTui({ attach: false })
  tui.rows.length = 0
  tui.pushRow({ kind: 'assistant', text: 'before the relay' })
  assert.equal(written(), '', 'nothing is written where nothing can read it')
  attachDisplay()
  assert.ok(written().includes('before the relay'), `the held line is handed over: ${JSON.stringify(written())}`)
})

test('a row is appended once, in order, with no screen control at all', async () => {
  const { tui, written } = await lineModeTui()
  tui.rows.length = 0
  tui.pushRow({ kind: 'assistant', text: 'first thing' })
  tui.pushRow({ kind: 'system', text: 'a notice' })
  tui.pushRow({ kind: 'error', text: 'a failure' })
  const out = written()
  assert.equal(out.includes('first thing'), true)
  assert.equal(out.includes('a notice'), true)
  assert.equal(out.includes('a failure'), true)
  assert.ok(
    out.indexOf('first thing') < out.indexOf('a notice') && out.indexOf('a notice') < out.indexOf('a failure'),
    `the order is the order they happened: ${JSON.stringify(out)}`,
  )
  for (const text of ['first thing', 'a notice', 'a failure']) {
    assert.equal(out.split(text).length - 1, 1, `${text} appears exactly once`)
  }
})

test('the output carries no cursor addressing, alternate screen, or carriage return', async () => {
  const { tui, written } = await lineModeTui()
  tui.rows.length = 0
  tui.pushRow({ kind: 'assistant', text: 'hello' })
  tui.markDirty()
  const out = written()
  assert.equal(/\x1b\[\d+;\d+H/u.test(out), false, `no absolute addressing: ${JSON.stringify(out)}`)
  assert.equal(out.includes('\x1b[?1049h'), false, 'no alternate screen')
  assert.equal(out.includes('\r'), false, 'a carriage return would overwrite the line')
  assert.equal(/\x1b\[\?25l/u.test(out), false, 'and the cursor is not hidden')
})

test('painting stays off in line mode even when the screen is dirtied', async () => {
  const { tui } = await lineModeTui()
  tui.rows.length = 0
  tui.pushRow({ kind: 'assistant', text: 'x' })
  const frame = tui.captureFrame(80, 24)
  assert.deepEqual(frame, [], 'a frame is never composed in line mode')
})

/**
 * The Host process is what users actually run (`headlessDisplay: true` in
 * `index.ts`). Typing arrives as FRAME_STDIN → `handleData`, not process.stdin.
 * These tests drive that path: a title/bell leak, a confirm prompt, a typed
 * command. They do not call `start()` — that would steal SIGTERM and scan the
 * credential store.
 */

/**
 * Wait for a prompt to reach the log. A fixed sleep is a race on a loaded CI
 * runner; this polls the writer instead and only fails when nothing arrives.
 */
async function waitForText(read, needle, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (read().includes(needle)) return true
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return read().includes(needle)
}

test('a Host-side turn does not leak OSC titles or a bell into the log', async () => {
  const { tui, since } = await lineModeTui()
  const added = since()
  tui.handleStatus({ agent: tui.agent, status: 'running' })
  tui.handleStatus({ agent: tui.agent, status: 'idle' })
  const out = added()
  assert.equal(out.includes('\x1b]0;'), false, `no OSC title: ${JSON.stringify(out)}`)
  assert.equal(out.includes('\x07'), false, `no bell: ${JSON.stringify(out)}`)
})

test('a confirm prompt is written into the log, and y answers it', async () => {
  const { tui, since } = await lineModeTui()
  const added = since()
  const pending = tui.handleApproval({
    toolName: 'bash',
    callId: 'c-line',
    agent: tui.agent,
  }, async () => { throw new Error('waterfall next() must not run') })
  assert.ok(await waitForText(added, 'y = '), `the keys are in the log: ${JSON.stringify(added())}`)
  const shown = added()
  assert.match(shown, /bash/u, `the prompt names the tool: ${JSON.stringify(shown)}`)
  assert.match(shown, /y = /u, `the keys are in the log: ${JSON.stringify(shown)}`)
  assert.equal(/\x1b/u.test(shown), false, `the prompt itself is not an escape: ${JSON.stringify(shown)}`)
  tui.handleData(Buffer.from('y'))
  assert.equal(await pending, 'allowed-once')
})

test('line mode writes an inspect body to the log instead of an invisible dialog', async () => {
  const { tui, since } = await lineModeTui()
  const added = since()
  tui.handleSubagentStart({ runId: 'run-a', id: 'child-a', provider: 'spawn', local: true })
  const card = tui.rows.find(row => row.kind === 'subagent')
  tui.focusedRow = card
  tui.handleData(Buffer.from('\r'))
  assert.equal(tui.dialog, undefined, 'no modal that prints nothing and eats the next Enter')
  const shown = added()
  assert.match(shown, /子代理全文/u, shown)
  assert.match(shown, /已启动/u, 'the body carries the child log')
  // The input still works right after: a second Enter is not swallowed.
  tui.handleData(Buffer.from('/help\r'))
  assert.match(added(), /> \/help/u)
})

test('a typed command is echoed once, then handled', async () => {
  const { tui, since } = await lineModeTui()
  const added = since()
  tui.handleData(Buffer.from('/help\r'))
  const out = added()
  assert.match(out, /> \/help/u, `the typed line is in the log: ${JSON.stringify(out)}`)
  assert.equal(out.split('> /help').length - 1, 1, 'the typed line appears once')
  assert.equal(out.includes('\x1b]0;'), false, `no OSC in the command echo: ${JSON.stringify(out)}`)
})

test('a question dialog lists its options in the log', async () => {
  const { tui, since } = await lineModeTui()
  const added = since()
  const pending = tui.handleUserQuestions({
    questions: [{
      id: 'q1',
      question: 'Which colour?',
      options: [
        { label: 'red', description: 'stop' },
        { label: 'green', description: 'go' },
      ],
    }],
  })
  assert.ok(await waitForText(added, 'green'), `the question is in the log: ${JSON.stringify(added())}`)
  const shown = added()
  assert.match(shown, /Which colour/u, `the question is in the log: ${JSON.stringify(shown)}`)
  assert.match(shown, /red/u)
  assert.match(shown, /green/u)
  tui.handleData(Buffer.from('\r'))
  const answer = await pending
  assert.equal(answer.answers[0]?.selected[0], 'red')
})
