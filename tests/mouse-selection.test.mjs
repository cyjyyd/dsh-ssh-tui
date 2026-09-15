import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { displayWidth, stripAnsi } from '../lib/term-text.js'
import { SshTui } from '../lib/tui.js'
import { allText } from './wait.mjs'

/**
 * Free-form copy of a model reply: drag across it and the text goes to the
 * clipboard over OSC 52.
 *
 * The TUI claims the mouse (`?1000h` plus SGR reports) so the wheel scrolls and
 * a click opens a link or toggles a card — which is exactly why the terminal's
 * own selection cannot be used. These cases drive the real mouse path: press,
 * motion, release, and the frame that is painted in between.
 *
 * SGR reports: `\x1b[<button;column;rowM` for a press or motion, and `…m` for a
 * release. Button 0 is the left button, 32 is motion with it held.
 */
setLocale('zh')

function fixture({ color = false } = {}) {
  const ui = []
  const ctx = {
    get: () => undefined,
    on() { return () => {} },
  }
  const agent = { id: 's', options: {}, status: 'idle', session: { id: 's', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 's', color, headlessDisplay: true })
  void ui
  return tui
}

const press = (button, column, row) => `\x1b[<${button};${column};${row}M`
const release = (button, column, row) => `\x1b[<${button};${column};${row}m`

/**
 * Where `needle` sits in the painted frame: a 1-based screen row and cell
 * columns, because the frame carries escape sequences and a CJK glyph is two
 * cells wide — the mouse speaks in cells, so the test has to as well.
 * `endColumn` is the exclusive boundary just past the needle.
 */
function locate(tui, needle) {
  const frame = tui.captureFrame(100, 30)
  for (let index = 0; index < frame.length; index += 1) {
    const text = stripAnsi(frame[index])
    const at = text.indexOf(needle)
    if (at === -1) continue
    const startCell = [...text.slice(0, at)].reduce((width, char) => width + displayWidth(char), 0)
    const cellWidth = [...needle].reduce((width, char) => width + displayWidth(char), 0)
    return { row: index + 1, startColumn: startCell + 1, endColumn: startCell + cellWidth + 1 }
  }
  assert.fail(`the frame does not show ${JSON.stringify(needle)}:\n${frame.join('\n')}`)
}

test('dragging across a reply copies exactly what the drag covered', () => {
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: '先跑 npm test 再提交' })
  const start = locate(tui, 'npm test')
  const end = locate(tui, '提交')

  tui.handleData(Buffer.from(press(0, start.startColumn, start.row)))
  tui.handleData(Buffer.from(press(32, end.endColumn, end.row)))
  // While the button is held the selection is painted in reverse video.
  const dragging = tui.captureFrame(100, 30).join('\n')
  assert.ok(dragging.includes('\x1b[7m'), 'the drag is highlighted while it is being made')

  tui.handleData(Buffer.from(release(0, end.endColumn, end.row)))
  assert.equal(tui.copyYank, 'npm test 再提交', 'the dragged text is what reaches the clipboard')
  assert.match(allText(tui), /已复制选中文本/u)
  assert.equal(
    tui.captureFrame(100, 30).join('\n').includes('\x1b[7m'),
    false,
    'the highlight is gone once the drag ends',
  )
})

test('a drag on a reply spans its wrapped lines, and stops at the reply', () => {
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: '第一行\n第二行\n第三行' })
  tui.rows.push({ kind: 'system', text: 'NOT-COPYABLE' })
  const first = locate(tui, '第一行')
  const last = locate(tui, '第三行')

  tui.handleData(Buffer.from(press(0, first.startColumn, first.row)))
  // Drag well past the reply, into the system row below it.
  tui.handleData(Buffer.from(press(32, last.endColumn, last.row + 1)))
  tui.handleData(Buffer.from(release(0, last.endColumn, last.row + 1)))

  assert.ok(tui.copyYank.startsWith('第一行'), `the drag starts at the press: ${JSON.stringify(tui.copyYank)}`)
  assert.ok(tui.copyYank.includes('第三行'), 'and covers the lines it passed over')
  assert.equal(tui.copyYank.includes('NOT-COPYABLE'), false, 'but never reaches a non-reply row')
})

test('a press that never moves is still a click', () => {
  const tui = fixture()
  tui.rows.push({
    kind: 'tool',
    callId: 'c1',
    name: 'bash',
    title: '终端',
    summary: '$ ls',
    args: JSON.stringify({ command: 'ls' }),
    command: 'ls',
    output: 'ok\n',
    status: 'done',
    expanded: false,
  })
  const at = locate(tui, '终端')

  tui.handleData(Buffer.from(press(0, at.startColumn, at.row)))
  tui.handleData(Buffer.from(release(0, at.startColumn, at.row)))
  const card = tui.rows.find(row => row.kind === 'tool')
  assert.equal(card?.expanded, true, 'a click still toggles the card it landed on')
  assert.equal(tui.copyYank, '', 'and copies nothing')
})

test('a drag that starts outside a reply copies nothing and stays a click', () => {
  const tui = fixture()
  tui.rows.push({
    kind: 'tool',
    callId: 'c2',
    name: 'bash',
    title: '终端',
    summary: '$ ls',
    args: JSON.stringify({ command: 'ls' }),
    command: 'ls',
    output: 'ok\n',
    status: 'done',
    expanded: false,
  })
  tui.rows.push({ kind: 'assistant', text: '下面是可复制的回复' })
  const card = locate(tui, '终端')
  const reply = locate(tui, '可复制的回复')

  tui.handleData(Buffer.from(press(0, card.startColumn, card.row)))
  tui.handleData(Buffer.from(press(32, reply.endColumn, reply.row)))
  tui.handleData(Buffer.from(release(0, reply.endColumn, reply.row)))

  assert.equal(tui.copyYank, '', 'only a reply can be selected, so nothing was copied')
  const row = tui.rows.find(entry => entry.kind === 'tool')
  assert.equal(row?.expanded, true, 'the press still behaved as a click on the card')
})

test('a link click still copies the link, not a selection', t => {
  // OSC 8 hyperlinks are opt-out by environment: a test runner usually has no
  // TERM, which turns them off. Turn them on so the click has a link to hit.
  const previous = process.env.DSH_TUI_OSC8
  process.env.DSH_TUI_OSC8 = '1'
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_TUI_OSC8
    else process.env.DSH_TUI_OSC8 = previous
  })
  const tui = fixture({ color: true })
  tui.rows.push({ kind: 'assistant', text: 'see [docs](https://example.com/click) please' })
  const at = locate(tui, 'docs')

  tui.handleData(Buffer.from(press(0, at.startColumn, at.row)))
  tui.handleData(Buffer.from(release(0, at.startColumn, at.row)))
  assert.equal(tui.copyYank, 'https://example.com/click')
})

test('wheel scrolling is untouched by the selection handling', () => {
  const tui = fixture()
  for (let index = 0; index < 60; index += 1) tui.rows.push({ kind: 'system', text: `line-${index}` })
  const before = tui.captureFrame(100, 30).join('\n')
  tui.handleData(Buffer.from(press(64, 10, 10)))
  const after = tui.captureFrame(100, 30).join('\n')
  assert.notEqual(after, before, 'the wheel still scrolls the transcript')
  assert.equal(tui.copyYank, '', 'and copies nothing')
})

test('the terminal is asked for held-button motion, or a drag never arrives', () => {
  const tui = fixture()
  const sent = []
  tui.displayHost = {
    attached: true,
    sendStdout: chunk => sent.push(String(chunk)),
    sendGoodbye() {},
    close: async () => {},
  }
  tui.attachRelayDisplay()
  const init = sent.join('')
  assert.ok(init.includes('\x1b[?1000h'), 'presses and releases are reported')
  // `?1000h` alone reports only press and release; motion while the button is
  // held needs `?1002h`. Without it the handler above is unreachable on a real
  // terminal — the tests could feed motion by hand and never notice.
  assert.ok(init.includes('\x1b[?1002h'), 'and motion while a button is held')
  assert.ok(init.includes('\x1b[?1006h'), 'in SGR encoding, which is what the parser reads')
})

test('a drag keeps its grip when the transcript scrolls under it', () => {
  // A live session keeps painting: a tool result or a streamed line arrives
  // while the button is still down, and the transcript (pinned to the bottom)
  // shifts up. The anchor was a screen row index, so the selection silently
  // slid onto whatever moved into that row — the user would paste the wrong
  // text and never know why.
  const tui = fixture()
  for (let index = 0; index < 40; index += 1) tui.rows.push({ kind: 'system', text: `filler ${index}` })
  tui.rows.push({ kind: 'assistant', text: 'the reply the press landed on' })
  const at = locate(tui, 'the reply the press landed on')
  assert.ok(at.row > 0, 'the reply is on screen before the drag')

  tui.handleData(Buffer.from(press(0, at.startColumn, at.row)))
  // The transcript moves: the reply is now one screen row higher.
  tui.rows.push({ kind: 'system', text: 'WORK-LANDED-WHILE-DRAGGING' })
  const movedTo = locate(tui, 'the reply the press landed on')
  assert.equal(movedTo.row, at.row - 1, 'the reply shifted up under the drag')

  // The pointer has not moved, so the drag must still start at the reply.
  tui.handleData(Buffer.from(press(32, movedTo.endColumn, movedTo.row)))
  tui.handleData(Buffer.from(release(0, movedTo.endColumn, movedTo.row)))

  assert.equal(
    tui.copyYank,
    'the reply the press landed on',
    'the drag still copies the reply it grabbed, not the row that slid into its place',
  )
})
