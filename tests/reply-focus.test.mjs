import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'

setLocale('zh')

/**
 * Replies are cards too.
 *
 * `/copy` takes the focused row, and the focus used to walk only the collapsible
 * cards — so a reply could not be selected at all: the moment any card had the
 * focus, the reply stopped being a copy target, and the newest one survived only
 * as the no-focus fallback. These cases pin the ring, the marker, what Enter
 * does on a reply, and that the marker never reaches the clipboard.
 */
function makeTui() {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.write = () => {}
  tui.rows.push({ kind: 'user', text: '请统计一下' })
  tui.rows.push({ kind: 'reasoning', text: '先想一下', expanded: false })
  tui.rows.push({
    kind: 'tool', callId: 'c1', name: 'bash', title: '终端', summary: '$ ls', args: '{}',
    output: 'ok', status: 'ok', expanded: false,
  })
  tui.rows.push({ kind: 'assistant', text: '第一版回复' })
  tui.rows.push({
    kind: 'tool', callId: 'c2', name: 'bash', title: '终端', summary: '$ wc -l', args: '{}',
    output: '42', status: 'ok', expanded: false,
  })
  tui.rows.push({ kind: 'assistant', text: '最新回复 **粗体**' })
  return tui
}

const assistantRows = tui => tui.rows.filter(row => row.kind === 'assistant')
const frameLine = (tui, needle, width = 100, height = 30) =>
  tui.captureFrame(width, height).find(line => line.includes(needle)) ?? ''

test('↑ with an empty input lands on the newest reply and marks it', () => {
  const tui = makeTui()
  tui.moveFocus(-1)
  const [older, newest] = assistantRows(tui)
  const [, tool2] = tui.rows.filter(row => row.kind === 'tool')
  assert.equal(tui.focusedRow, newest, 'the newest reply is one ↑ away')
  assert.match(frameLine(tui, '最新回复'), /^▶ /u, 'the selected reply carries the marker')
  assert.equal(frameLine(tui, '第一版回复').startsWith('▶'), false, 'and no other reply does')

  // One flat walk in screen order: the cards are stops too, and the marker is
  // always on exactly one row.
  tui.moveFocus(-1)
  assert.equal(tui.focusedRow, tool2)
  assert.equal(frameLine(tui, '最新回复').startsWith('▶'), false, 'the marker moved with the focus')
  tui.moveFocus(-1)
  assert.equal(tui.focusedRow, older, 'and the reply before it is two stops up')
  assert.match(frameLine(tui, '第一版回复'), /^▶ /u)

  tui.moveFocus(1)
  assert.equal(tui.focusedRow, tool2, '↓ walks back the same way')
})

test('/copy copies the selected reply, not the newest one', () => {
  // The clipboard caveat is a row of its own on every terminal the capability
  // table does not promise OSC 52 for, and CI runs outside SSH — which is the
  // one case that silences it. Declare the clipboard working so the notice
  // under test is the newest row (the local suite is an SSH session and would
  // otherwise pass for the wrong reason).
  const previous = process.env.DSH_TUI_TERM_CAPS
  process.env.DSH_TUI_TERM_CAPS = 'osc52'
  try {
    const tui = makeTui()
    const [older] = assistantRows(tui)
    tui.moveFocus(-1)
    tui.moveFocus(-1)
    tui.moveFocus(-1)
    assert.equal(tui.focusedRow, older)
    assert.equal(tui.copyFocusedCard(), true)
    assert.equal(tui.lastCopiedText, '第一版回复', 'the row\'s own text, not the newest reply')
    const notice = tui.rows.findLast(row => row.kind === 'system')?.text ?? ''
    assert.match(String(notice), /焦点回复/)
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_TERM_CAPS
    else process.env.DSH_TUI_TERM_CAPS = previous
  }
})

test('a second copy takes the same row again', () => {
  // The selection used to be dropped by the copy itself, so a second press fell
  // back to "the latest reply" — a different row, with nothing on screen saying
  // so. The marker staying put is the reader's only evidence of what was copied.
  const tui = makeTui()
  const [older] = assistantRows(tui)
  tui.moveFocus(-1)
  tui.moveFocus(-1)
  tui.moveFocus(-1)
  tui.copyFocusedCard()
  assert.equal(tui.focusedRow, older)
  tui.copyFocusedCard()
  assert.equal(tui.lastCopiedText, '第一版回复')
})

test('Enter on a selected reply opens the full view and toggles no card', () => {
  const tui = makeTui()
  tui.moveFocus(-1)
  const width = 100
  const height = 30
  tui.toggleCollapsible()
  assert.equal(tui.dialog?.kind, 'inspect')
  assert.match(String(tui.dialog?.title), /回复全文/)
  const painted = tui.captureFrame(width, height).join('\n')
  assert.match(painted, /最新回复/, 'the overlay shows the reply itself')
  const tools = tui.rows.filter(row => row.kind === 'tool')
  assert.deepEqual(tools.map(row => row.expanded), [false, false],
    'the newest card was not expanded behind the reader\'s back')
})

test('the copy key works inside the reply overlay, and says so there', () => {
  // A dialog covers the input line, so `/copy` cannot be typed; the key is the
  // only way, and the notice row lands behind the overlay — the overlay has to
  // repeat it or the copy looks like it did nothing.
  const tui = makeTui()
  tui.moveFocus(-1)
  tui.toggleCollapsible()
  assert.equal(tui.copyFocusedCard(), true)
  assert.equal(tui.lastCopiedText, '最新回复 **粗体**', 'the raw markdown, not the painted wrap')
  assert.match(String(tui.dialog?.notice ?? ''), /已复制/)
  assert.match(tui.captureFrame(100, 30).join('\n'), /已复制/)
})

test('Ctrl+R expands the cards and keeps the selected reply selected', () => {
  const tui = makeTui()
  tui.moveFocus(-1)
  const selected = tui.focusedRow
  tui.toggleAllCollapsible()
  assert.equal(tui.focusedRow, selected)
  assert.deepEqual(tui.rows.filter(row => row.kind === 'tool').map(row => row.expanded), [true, true])
  tui.toggleAllCollapsible()
  assert.equal(tui.focusedRow, selected, 'collapsing everything does not deselect it either')
})

test('Alt+4 selects the newest reply instead of only scrolling to it', () => {
  const tui = makeTui()
  tui.jumpToCategory('reply')
  const [, newest] = assistantRows(tui)
  assert.equal(tui.focusedRow, newest)
  assert.match(frameLine(tui, '最新回复'), /^▶ /u)
})

test('Esc drops the selection', () => {
  const tui = makeTui()
  tui.moveFocus(-1)
  assert.notEqual(tui.focusedRow, null)
  tui.handleEscape()
  assert.equal(tui.focusedRow, null)
})

test('a drag off a selected reply never copies its marker', () => {
  const tui = makeTui()
  tui.moveFocus(-1)
  tui.captureFrame(100, 30)
  const index = tui.selectableLines.findIndex(line => String(line.raw).includes('最新回复'))
  assert.ok(index >= 0, 'the reply is painted and selectable')
  const y = tui.transcriptTopScreenY + index
  tui.beginMouseSelection(y, 1)
  tui.extendMouseSelection(y, 200)
  tui.endMouseSelection(y, 200)
  const painted = String(tui.selectableLines[index].raw)
  assert.match(painted, /^▶ /u, 'the line really carries the marker')
  assert.equal(tui.selectableLines[index].gutter, 3, 'and the selection is told it is chrome')
  assert.equal(tui.lastCopiedText, painted.replace(/^▶ /u, ''))
})

test('the compact view keeps replies in the ring', () => {
  const tui = makeTui()
  tui.setWorkspaceView('compact')
  tui.moveFocus(-1)
  const [, newest] = assistantRows(tui)
  assert.equal(tui.focusedRow, newest)
  assert.match(frameLine(tui, '最新回复'), /^▶ /u)
})
