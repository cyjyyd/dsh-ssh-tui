import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from '../lib/i18n/index.js'
import { copyTextFromRow, copyTextFromTranscript } from '../lib/copy-text.js'
import { SshTui } from '../lib/tui.js'

setLocale('zh')

test('copyTextFromTranscript prefers the focused card then the latest reply', () => {
  const assistant = { kind: 'assistant', text: '最终回复正文' }
  const tool = {
    kind: 'tool', callId: 'c1', name: 'bash', args: '{}', output: 'ok\n',
    title: 'bash', summary: 'git status', command: 'git status', expanded: false,
  }
  assert.equal(copyTextFromRow(assistant), '最终回复正文')
  assert.equal(copyTextFromRow(tool), 'git status\ngit status\nok')
  assert.deepEqual(copyTextFromTranscript([assistant], tool), { text: 'git status\ngit status\nok', source: 'focused' })
  assert.deepEqual(copyTextFromTranscript([assistant], null), { text: '最终回复正文', source: 'assistant' })
  assert.equal(copyTextFromTranscript([], null).source, 'empty')
})

test('/copy writes OSC 52 and a workspace notice', () => {
  const writes = []
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.write = (chunk) => { writes.push(String(chunk)) }
  tui.rows.push({ kind: 'assistant', text: '可复制的回复' })
  tui.focusedRow = tui.rows[0]
  tui.runCommand('/copy')
  assert.ok(tui.lastCopiedText.includes('可复制的回复'))
  assert.ok(writes.some(chunk => chunk.includes('\x1b]52;c;') && chunk.endsWith('\x1b\\')))
  assert.equal(tui.focusedRow, null)
  const notice = tui.rows.findLast(row => row.kind === 'system')?.text ?? ''
  assert.match(String(notice), /已复制/)
  assert.match(String(notice), /最近回复/)
  tui.handleChar('a')
  assert.equal(tui.input, 'a')
})

test('clicking an OSC 8 column copies the URL instead of toggling a card', () => {
  const previous = process.env.DSH_TUI_OSC8
  process.env.DSH_TUI_OSC8 = '1'
  const writes = []
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.write = (chunk) => { writes.push(String(chunk)) }
  tui.rows.push({ kind: 'assistant', text: 'see [docs](https://example.com/click) please' })
  try {
    tui.captureFrame(80, 24)
    const entry = [...tui.linkHitsByRow.entries()][0]
    assert.ok(entry, 'painted assistant line should carry an OSC 8 hit')
    const [y, hits] = entry
    tui.handleMouseClick(y, hits[0].startCol + 1)
    assert.equal(tui.lastCopiedText, 'https://example.com/click')
    const notice = tui.rows.findLast(row => row.kind === 'system')?.text ?? ''
    assert.match(String(notice), /example.com\/click/)
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_OSC8
    else process.env.DSH_TUI_OSC8 = previous
  }
})
