import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { lastFeedback } from './wait.mjs'

setLocale('zh')

/**
 * Replies are cards too.
 *
 * `/copy` takes the focused row, and the focus used to walk only the collapsible
 * cards — so a reply could not be selected at all: the moment any card had the
 * focus, the reply stopped being a copy target, and the newest one survived only
 * as the no-focus fallback. These cases pin the ring, the marker, what Enter
 * does on a reply, and that the marker never reaches the clipboard.
 *
 * Every key here goes in as bytes (`handleData`), not by calling the method the
 * key is supposed to reach: the first version of this file called `moveFocus`
 * directly and therefore passed while ↑ was still wired to history recall.
 */
const KEY = {
  up: '\x1b[A',
  down: '\x1b[B',
  enter: '\r',
  esc: '\x1b',
  ctrlN: '\x0e',
  ctrlP: '\x10',
  ctrlR: '\x12',
  copy: '\x1b[99;6u',
  alt4: '\x1b4',
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function makeTui({ withCards = true, keys } = {}) {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, {
    sessionId: 'main-session',
    color: false,
    headlessDisplay: true,
    ...(keys === undefined ? {} : { keys }),
  })
  tui.write = () => {}
  tui.rows.push({ kind: 'user', text: '请统计一下' })
  if (withCards) {
    tui.rows.push({ kind: 'reasoning', text: '先想一下', expanded: false })
    tui.rows.push({
      kind: 'tool', callId: 'c1', name: 'bash', title: '终端', summary: '$ ls', args: '{}',
      output: 'ok', status: 'ok', expanded: false,
    })
  }
  tui.rows.push({ kind: 'assistant', text: '第一版回复' })
  if (withCards) {
    tui.rows.push({
      kind: 'tool', callId: 'c2', name: 'bash', title: '终端', summary: '$ wc -l', args: '{}',
      output: '42', status: 'ok', expanded: false,
    })
  }
  tui.rows.push({ kind: 'assistant', text: '最新回复 **粗体**' })
  return tui
}

const press = (tui, bytes) => tui.handleData(Buffer.from(bytes, 'utf8'))
const assistantRows = tui => tui.rows.filter(row => row.kind === 'assistant')
const toolRows = tui => tui.rows.filter(row => row.kind === 'tool')
const frameLine = (tui, needle, width = 100, height = 30) =>
  tui.captureFrame(width, height).find(line => line.includes(needle)) ?? ''
const lastSystemRow = tui => lastFeedback(tui)

test('↑ lands on the newest card or reply, and the marker follows the focus', () => {
  const tui = makeTui()
  const [, newest] = assistantRows(tui)
  press(tui, KEY.up)
  assert.equal(tui.focusedRow, newest, 'the newest ring member is one ↑ away')
  assert.match(frameLine(tui, '最新回复'), /^▶ /u, 'the selected row carries the marker')
  assert.equal(frameLine(tui, '第一版回复').startsWith('▶'), false, 'and no other row does')

  // One flat walk in screen order: the cards are stops too, and the marker is
  // always on exactly one row.
  const [, tool2] = toolRows(tui)
  press(tui, KEY.up)
  assert.equal(tui.focusedRow, tool2)
  assert.equal(frameLine(tui, '最新回复').startsWith('▶'), false, 'the marker moved with the focus')
  press(tui, KEY.up)
  const [older] = assistantRows(tui)
  assert.equal(tui.focusedRow, older, 'and the reply before it is two stops up')
  assert.match(frameLine(tui, '第一版回复'), /^▶ /u)

  press(tui, KEY.down)
  assert.equal(tui.focusedRow, tool2, '↓ walks back the same way')
})

test('the live thinking card is not dropped out of the ring', () => {
  // It is the one ring member that is not a member of `rows`: it exists only
  // while a turn streams. Filtering the rows (the first version of the ring)
  // silently lost it, so ↑ did nothing and Enter could not reach the card being
  // written.
  const tui = makeTui({ withCards: false })
  tui.rows.length = 1
  tui.streaming = { reasoning: 'thinking hard', text: '' }
  const live = tui.collapsibleRows().find(row => row.kind === 'streaming-reasoning')
  assert.ok(live !== undefined)
  assert.equal(tui.focusRing().includes(live), true, 'the live card must be reachable')
  press(tui, KEY.ctrlN)
  assert.equal(tui.focusedRow, live)
  press(tui, KEY.enter)
  assert.equal(live.expanded, true, 'and Enter expands it')
})

test('/copy highlight copies the selected reply, not the newest one', () => {
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
    press(tui, KEY.up)
    press(tui, KEY.up)
    press(tui, KEY.up)
    assert.equal(tui.focusedRow, older)
    assert.equal(tui.copyFocusedCard('highlight'), true)
    assert.equal(tui.lastCopiedText, '第一版回复', 'the row\'s own text, not the newest reply')
    assert.match(lastSystemRow(tui), /焦点回复/)
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
  press(tui, KEY.up)
  press(tui, KEY.up)
  press(tui, KEY.up)
  tui.copyFocusedCard('highlight')
  assert.equal(tui.focusedRow, older)
  tui.copyFocusedCard('highlight')
  assert.equal(tui.lastCopiedText, '第一版回复')
})

test('Enter on a selected reply opens the full view and toggles no card', () => {
  const tui = makeTui()
  press(tui, KEY.up)
  press(tui, KEY.enter)
  assert.equal(tui.screen?.kind, 'inspect')
  assert.match(String(tui.screen?.title), /回复全文/)
  assert.match(tui.captureFrame(100, 30).join('\n'), /最新回复/, 'the overlay shows the reply itself')
  assert.deepEqual(toolRows(tui).map(row => row.expanded), [false, false],
    'the newest card was not expanded behind the reader\'s back')
})

test('Enter reaches a selected reply in a session with no card at all', () => {
  // A plain Q&A session, or right after `/clear`: the gate that decides whether
  // empty-input Enter expands a card only asks about collapsible rows, so this
  // used to do nothing even though `Alt+4` / Ctrl+P had just selected the reply.
  const tui = makeTui({ withCards: false })
  press(tui, KEY.ctrlP)
  const [, newest] = assistantRows(tui)
  assert.equal(tui.focusedRow, newest, 'Ctrl+P is not gated on cards')
  press(tui, KEY.enter)
  assert.equal(tui.screen?.kind, 'inspect', 'and Enter opens it')
  assert.match(String(tui.screen?.title), /回复全文/)
})

test('↑ still recalls the previous prompt when there is no card to select', () => {
  // Deliberate, and documented: the ↑/↓ gate asks for a collapsible card, so a
  // pure Q&A session keeps the history meaning it always had. `Alt+4` and
  // Ctrl+N/P are how the reply is selected there.
  const tui = makeTui({ withCards: false })
  tui.rows.length = 1
  tui.rows.push({ kind: 'assistant', text: '4' })
  tui.history.push('上一个问题')
  // `historyIndex` is set when a prompt is submitted; history recall reads from
  // it, so standing in for a submitted prompt means pointing it at the end.
  tui.historyIndex = tui.history.length
  press(tui, KEY.up)
  assert.equal(tui.focusedRow, null, '↑ did not select anything')
  assert.equal(tui.input, '上一个问题', 'it recalled the previous prompt instead')
  // The same key selects once a card exists, which is the difference the docs
  // have to be honest about.
  tui.input = ''
  const withCard = makeTui()
  press(withCard, KEY.up)
  assert.equal(withCard.focusedRow?.kind, 'assistant')
})

test('the copy key works inside the reply overlay, and says so there', () => {
  // A dialog covers the input line, so `/copy` cannot be typed; the key is the
  // only way, and the notice row lands behind the overlay — the overlay has to
  // repeat it or the copy looks like it did nothing.
  const tui = makeTui()
  press(tui, KEY.up)
  press(tui, KEY.enter)
  press(tui, KEY.copy)
  assert.equal(tui.lastCopiedText, '最新回复 **粗体**', 'the raw markdown, not the painted wrap')
  assert.match(String(tui.screen?.notice ?? ''), /已复制/)
  assert.match(String(tui.screen?.notice ?? ''), /全文/, 'the label names the body the overlay showed')
  assert.match(tui.captureFrame(100, 30).join('\n'), /已复制/, 'and the overlay itself shows it')
})

test('a rebound copy key also works inside the overlay', () => {
  // The keymap used to be consulted only when no dialog was open, which put the
  // reader's own binding out of reach exactly where the overlay advertises it.
  const tui = makeTui({ keys: { copy: 'ctrl+y' } })
  press(tui, KEY.up)
  press(tui, KEY.enter)
  press(tui, '\x19')
  assert.equal(tui.lastCopiedText, '最新回复 **粗体**')
})

test('a tool overlay copies the body it shows, not the card row', () => {
  const tui = makeTui()
  const [tool] = toolRows(tui)
  tool.output = 'line one\nline two'
  tui.focusedRow = tool
  tui.openToolInspect(tool)
  assert.equal(tui.screen?.kind, 'inspect')
  press(tui, KEY.copy)
  assert.match(tui.lastCopiedText, /line two/, 'the body is on the clipboard')
  assert.equal(tui.lastCopiedText.includes('$ ls'), false, 'and the card summary is not')
})

test('a body that replaces another body takes its copy text with it', () => {
  // The changes overlay is asynchronous and reuses any open inspect dialog, so a
  // reply overlay opened while the diff was being read used to keep its
  // `copyText`: the key then handed back the reply under a diff on screen.
  const tui = makeTui()
  press(tui, KEY.up)
  press(tui, KEY.enter)
  assert.equal(tui.screen?.copyText, '最新回复 **粗体**')
  tui.openChangesInspectLines('本轮改动 · a.ts  +1 -0', [{ kind: 'diff-add', text: '+added line' }])
  assert.equal(tui.screen?.copyText, '+added line')
  assert.equal(tui.dialog?.notice, undefined, 'and the previous body\'s confirmation goes too')
  press(tui, KEY.copy)
  assert.equal(tui.lastCopiedText, '+added line')
})

test('Ctrl+R expands the cards and keeps the selected reply selected', () => {
  const tui = makeTui()
  press(tui, KEY.up)
  const selected = tui.focusedRow
  press(tui, KEY.ctrlR)
  assert.equal(tui.focusedRow, selected)
  assert.deepEqual(toolRows(tui).map(row => row.expanded), [true, true])
  press(tui, KEY.ctrlR)
  assert.equal(tui.focusedRow, selected, 'collapsing everything does not deselect it either')
})

test('Alt+4 selects the newest reply instead of only scrolling to it', () => {
  const tui = makeTui()
  press(tui, KEY.alt4)
  const [, newest] = assistantRows(tui)
  assert.equal(tui.focusedRow, newest)
  assert.match(frameLine(tui, '最新回复'), /^▶ /u)
})

test('Esc drops the selection', async () => {
  const tui = makeTui()
  press(tui, KEY.up)
  assert.notEqual(tui.focusedRow, null)
  press(tui, KEY.esc)
  // A lone ESC waits for the escape window before it is believed; the timer is
  // the real path, so the test waits it out rather than calling `handleChar`.
  await delay(120)
  assert.equal(tui.focusedRow, null)
})

test('the transcript cursor does not move behind an open overlay', () => {
  const tui = makeTui()
  press(tui, KEY.up)
  const selected = tui.focusedRow
  press(tui, KEY.enter)
  assert.equal(tui.screen?.kind, 'inspect')
  press(tui, KEY.ctrlP)
  assert.equal(tui.focusedRow, selected, 'the cursor stayed where the overlay left it')
  press(tui, KEY.ctrlR)
  assert.deepEqual(toolRows(tui).map(row => row.expanded), [false, false],
    'and Ctrl+R did not sweep the cards under it')
})

test('focusing a reply does not clip its first line', () => {
  // The marker is three cells, and it used to be prepended to a line already
  // rendered at the full width and then clipped: the tail of the first line
  // disappeared from the screen (the overlay and the copy still had it).
  const tui = makeTui({ withCards: false })
  const text = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij'
  tui.rows.length = 1
  tui.rows.push({ kind: 'assistant', text })
  const painted = tui.captureFrame(40, 20).map(line => line.replace(/\s+$/u, '')).join('')
  assert.ok(painted.replace(/[^A-Za-z0-9]/gu, '').includes(text), 'the whole reply is on screen before focusing')
  press(tui, KEY.ctrlN)
  const focused = tui.captureFrame(40, 20).map(line => line.replace(/\s+$/u, '')).join('')
  assert.ok(focused.replace(/[^A-Za-z0-9]/gu, '').includes(text),
    `the whole reply must survive focusing, got ${JSON.stringify(focused)}`)
})

test('a drag off a selected reply never copies its marker', () => {
  const tui = makeTui()
  press(tui, KEY.up)
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
  press(tui, KEY.up)
  const [, newest] = assistantRows(tui)
  assert.equal(tui.focusedRow, newest)
  assert.match(frameLine(tui, '最新回复'), /^▶ /u)
})
