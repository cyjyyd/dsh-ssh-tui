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
  return { tui, written: () => written.join(''), attachDisplay }
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
