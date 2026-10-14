/**
 * The rendered caret of the field the reader is typing into (W-3b.1a).
 *
 * W-3b.1 settled *which* field an editing key edits. This file settles where the
 * terminal says the caret is: the row the painter draws is `fieldText()` (the borrowed
 * answer while a Surface has one, the draft otherwise), and the caret has to be the
 * same field's `fieldCursor()` — not the hidden draft's.
 *
 * Every case goes through the real path: `handleData` for the keys, the real `paint()`
 * for the frame, and a real terminal grid (`@xterm/headless`, `tests/screen.mjs`) for
 * the answer. A string-level assertion cannot see this defect: the *state* was always
 * right (`borrowedText.cursor` did move), and the frame's own idea of the caret
 * (`lastPaintedCursorColumn`) is what was wrong. The terminal is the oracle — it applies
 * every cursor move in the frame in order, so `cursor()` is the position a reader would
 * see an IME pre-edit appear at, however many rows the frame addressed.
 *
 * The expected position is derived from the contracts the painter uses — `displayWidth`
 * for the prompt, `cursorVisualPosition` for the row and column inside the field — plus
 * a few hand-checked ASCII cases where `> a|b` is simply x=3.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { cursorVisualPosition, displayWidth, foldInputView } from '../lib/term-text.js'
import { SshTui } from '../lib/tui.js'
import { screen } from './screen.mjs'
import { pushRow, waitForDialog } from './wait.mjs'

setLocale('zh')

const COLUMNS = 60
const ROWS = 18
/** The painter's prompt without color: two cells, and the field starts right after it. */
const PROMPT = '> '
const PROMPT_WIDTH = displayWidth(PROMPT)

function fixture() {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] },
    cancel() {}, followup() {}, steer() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  const writes = []
  tui.write = chunk => { writes.push(String(chunk)) }
  return { tui, writes }
}

/**
 * A TUI, and the terminal its frames are written into.
 *
 * `paint()` is the real painter; `settle()` feeds the terminal whatever the frame
 * wrote, repeating while the painter says it has deferred rows (the byte budget holds
 * rows back for the next tick, and a caret assertion must not read a half frame).
 */
async function staged({ columns = COLUMNS, rows = ROWS, draft = '我打了一半的消息', cursor = 3, transcript = 12 } = {}) {
  const { tui, writes } = fixture()
  tui.screenColumns = () => columns
  tui.screenRows = () => rows
  for (let index = 0; index < transcript; index += 1) pushRow(tui, { kind: 'assistant', text: `第 ${index} 行` })
  tui.input = draft
  tui.cursor = cursor
  const term = screen(columns, rows)
  const settle = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      writes.length = 0
      tui.paint()
      await term.write(writes.join(''))
      if (tui.paintResume === undefined) return
    }
    assert.fail('the painter kept deferring rows: the frame never settled')
  }
  const send = async text => {
    tui.handleData(Buffer.from(text))
    await settle()
  }
  await settle()
  return { tui, term, settle, send, columns, rows }
}

/** Open the free-text question: the Surface that borrows the composer's field. */
async function openBorrowedQuestion(tui) {
  void tui.askQuestion({ id: 'q1', question: '回滚到哪个版本？' }, 0, 1).catch(() => undefined)
  await waitForDialog(tui, 'questions')
  assert.notEqual(tui.borrowedText, undefined, 'the question borrowed the field')
}

/**
 * Where the caret is, and where the field that owns it says it should be.
 *
 * `field` is read the same way the painter reads it (borrowed text while a Surface has
 * one, the draft otherwise), and the expected position is the painter's own contract:
 * a folded field is one row around the caret (`foldInputView`), an unfolded one maps
 * through `cursorVisualPosition`, and the row is the painted input row found in the
 * grid — so a caret that ended up on a chrome line, the status row or the transcript is
 * a mismatch rather than a coincidence.
 */
function caret(staged, { width = staged.columns } = {}) {
  const { tui, term } = staged
  const grid = term.grid()
  const inputRow = grid.findIndex(line => line.startsWith(PROMPT))
  assert.ok(inputRow >= 0, 'the input row is on screen')
  const borrowed = tui.borrowedText
  const text = borrowed?.text ?? tui.input
  const cursor = borrowed?.cursor ?? tui.cursor
  const fieldWidth = Math.max(1, width - PROMPT_WIDTH)
  const folded = borrowed === undefined && tui.inputFolded === true
  let expected
  if (folded) {
    expected = { x: PROMPT_WIDTH + foldInputView(text, cursor, fieldWidth).cursorOffset, y: inputRow }
  } else {
    const pos = cursorVisualPosition(text, cursor, fieldWidth)
    expected = { x: (pos.row === 0 ? PROMPT_WIDTH : 0) + pos.col, y: inputRow + pos.row }
  }
  // The painter clamps the caret to the frame (`Math.min(width, column)` on a 1-based
  // column), so the last usable cell is `width - 1`.
  const clamped = { x: Math.min(width - 1, expected.x), y: expected.y }
  return { actual: term.cursor(), expected: clamped, inputRow, grid, text, cursor, folded }
}

/** Assert the terminal caret is the one the field that owns the keyboard asks for. */
function assertCaret(staged, where, options) {
  const seen = caret(staged, options)
  assert.deepEqual(
    seen.actual,
    seen.expected,
    `${where}: the terminal caret must be at the caret of the field being typed into `
    + `(field ${JSON.stringify(seen.text)}@${seen.cursor}, input row ${seen.inputRow}, `
    + `row text ${JSON.stringify(seen.grid[seen.inputRow] ?? '')})`,
  )
  return seen
}

/** The draft and its caret must not move while a Surface is up. */
function assertDraftUntouched(tui, draft, cursor) {
  assert.equal(tui.input, draft, 'the hidden composer draft is untouched')
  assert.equal(tui.cursor, cursor, 'and so is its caret')
}

// ── A · the borrowed field's own caret ───────────────────────────────────────

test('W-3b.1a: the caret follows the borrowed field, not the draft behind it', async () => {
  const DRAFT = '我打了一半的消息'
  const stagedRun = await staged({ draft: DRAFT, cursor: 3 })
  const { tui, term } = stagedRun
  await openBorrowedQuestion(tui)
  await stagedRun.settle()

  // The empty answer: the caret is right after the prompt.
  assert.deepEqual(term.cursor(), { x: PROMPT_WIDTH, y: caret(stagedRun).inputRow },
    'the borrowed field starts empty, with the caret at its start')
  assertDraftUntouched(tui, DRAFT, 3)

  await stagedRun.send('ab')
  assert.deepEqual({ text: tui.borrowedText?.text, cursor: tui.borrowedText?.cursor }, { text: 'ab', cursor: 2 })
  assert.deepEqual(term.cursor(), { x: PROMPT_WIDTH + 2, y: caret(stagedRun).inputRow }, 'two ASCII characters: `> ab|`')
  assertDraftUntouched(tui, DRAFT, 3)

  await stagedRun.send('\x1b[H')
  assert.deepEqual({ text: tui.borrowedText?.text, cursor: tui.borrowedText?.cursor }, { text: 'ab', cursor: 0 },
    'Home edits the borrowed field')
  assert.deepEqual(term.cursor(), { x: PROMPT_WIDTH, y: caret(stagedRun).inputRow }, 'and the caret is before `a`: `> |ab`')
  assertDraftUntouched(tui, DRAFT, 3)

  await stagedRun.send('\x1b[F')
  assert.deepEqual(term.cursor(), { x: PROMPT_WIDTH + 2, y: caret(stagedRun).inputRow }, 'End puts it after `b`')
  assertDraftUntouched(tui, DRAFT, 3)

  await stagedRun.send('\x1b[H')
  await stagedRun.send('\x1b[3~')
  assert.deepEqual({ text: tui.borrowedText?.text, cursor: tui.borrowedText?.cursor }, { text: 'b', cursor: 0 },
    'Home then Delete removes the grapheme after the caret')
  assert.deepEqual(term.cursor(), { x: PROMPT_WIDTH, y: caret(stagedRun).inputRow }, 'and the caret stays before `b`')
  assertDraftUntouched(tui, DRAFT, 3)

  await stagedRun.send('\x1b[F')
  await stagedRun.send('x')
  assert.deepEqual({ text: tui.borrowedText?.text, cursor: tui.borrowedText?.cursor }, { text: 'bx', cursor: 2 })
  assert.deepEqual(term.cursor(), { x: PROMPT_WIDTH + 2, y: caret(stagedRun).inputRow }, 'typing at the end leaves it after `x`')
  assertDraftUntouched(tui, DRAFT, 3)
})

test('W-3b.1a: the xterm spellings move the rendered caret too', async () => {
  const stagedRun = await staged()
  await openBorrowedQuestion(stagedRun.tui)
  await stagedRun.settle()
  await stagedRun.send('ab')
  const row = caret(stagedRun).inputRow
  await stagedRun.send('\x1b[1~')
  assert.deepEqual(stagedRun.term.cursor(), { x: PROMPT_WIDTH, y: row }, 'ESC[1~ is Home, on screen as well as in the field')
  await stagedRun.send('\x1b[4~')
  assert.deepEqual(stagedRun.term.cursor(), { x: PROMPT_WIDTH + 2, y: row }, 'ESC[4~ is End')
})

// ── B · Unicode, width and wrapping ──────────────────────────────────────────

test('W-3b.1a: the caret is right for CJK, wide glyphs, combining marks and wrapping', async () => {
  // The keys a borrowed field answers today are Home, End and editing — arrows are
  // dropped at a Surface (W-3b.1's own scope note), so a mid-field caret is built the
  // way a reader builds one: Home, then type at the caret.
  //
  // Emoji arrive by paste rather than by typing on purpose: *typing* an astral-plane
  // character crashes the process with a stack overflow, at the bare composer as well as
  // at a Surface (`composerUnit` reads `unit.length`, which is two for one emoji, and
  // routes it back into `handlePlainText` forever). That defect is pre-existing — it
  // reproduces on the build before W-3b.1 — and it belongs to the input path, not to the
  // caret, so this round records it (see the checkpoint) instead of widening its scope.
  const cases = [
    { name: 'ASCII, mid-field', columns: 40, first: 'hello', keys: ['\x1b[H', 'x'] },
    { name: 'CJK, mid-field', columns: 40, first: '我打了一半', keys: ['\x1b[H', '我'] },
    { name: 'CJK at the end', columns: 40, first: '我打了一半', keys: [] },
    { name: 'emoji, pasted, caret at the end', columns: 40, paste: '修复 🚀 完成', keys: [] },
    { name: 'emoji, pasted, caret at the start', columns: 40, paste: '修复 🚀 完成', keys: ['\x1b[H'] },
    { name: 'emoji behind a typed prefix', columns: 40, first: 'ab', paste: '🚀🚀', keys: ['\x1b[H', '\x1b[F'] },
    { name: 'combining mark, mid-field', columns: 40, first: 'e\u0301cole', keys: ['\x1b[H', 'x'] },
    { name: 'CJK and a combining mark, mid-field', columns: 40, first: '我打了一半e\u0301', keys: ['\x1b[H', '好'] },
    { name: 'wrapping in a narrow terminal', columns: 24, first: 'abcdefghijklmnopqrstuvwxyz0123456789', keys: ['\x1b[H', 'x'] },
    { name: 'wrapping CJK in a narrow terminal', columns: 24, first: '我打了一半的消息我打了一半的消息', keys: ['\x1b[H', '我'] },
    { name: 'exactly one full row, caret at the end', columns: 24, first: 'a'.repeat(22), keys: [] },
    { name: 'exactly one full row, caret at the start', columns: 24, first: 'a'.repeat(22), keys: ['\x1b[H'] },
    { name: 'one past a full row', columns: 24, first: 'a'.repeat(23), keys: [] },
    { name: 'a multi-line paste, caret at the end', columns: 40, paste: '第一行\nsecond', keys: [] },
    { name: 'a multi-line paste, caret on the first row', columns: 40, paste: '第一行\nsecond', keys: ['\x1b[H'] },
  ]
  for (const entry of cases) {
    const stagedRun = await staged({ columns: entry.columns, transcript: 20 })
    await openBorrowedQuestion(stagedRun.tui)
    await stagedRun.settle()
    if (entry.paste !== undefined) await stagedRun.send(`\x1b[200~${entry.paste}\x1b[201~`)
    else await stagedRun.send(entry.first)
    for (const key of entry.keys) await stagedRun.send(key)
    const where = `${entry.name}: field ${JSON.stringify(stagedRun.tui.borrowedText?.text)}@${stagedRun.tui.borrowedText?.cursor}`
    const seen = assertCaret(stagedRun, where, { width: entry.columns })
    // The caret is in the input box — never on the status row, a chrome line or the
    // transcript behind it, and never below the rows the field actually occupies.
    assert.ok(seen.actual.y >= seen.inputRow, `${where}: the caret is not above the field`)
    assert.ok(seen.grid[seen.actual.y]?.startsWith('SSH ') !== true, `${where}: not on the status row`)
    assert.equal(stagedRun.tui.input, '我打了一半的消息', `${where}: the draft is untouched`)
  }
})

test('W-3b.1a: a draft cursor deep in a wrapped draft cannot move the borrowed caret', async () => {
  // The row the caret lands on comes from the field being drawn. With the *draft's*
  // cursor (24, deep inside a wrapped draft) the borrowed field's short answer would be
  // read at a row it does not have — the caret drifts to a row of the input box that
  // the reader is not typing on, and the box itself grows an empty line.
  const stagedRun = await staged({ columns: 24, draft: '我打了一半的消息我打了一半的消息我打了一半的消息', cursor: 24 })
  await openBorrowedQuestion(stagedRun.tui)
  await stagedRun.settle()
  await stagedRun.send('ab')
  const atEnd = caret(stagedRun)
  assert.equal(atEnd.actual.y, atEnd.inputRow, 'the caret is on the field’s first row')
  await stagedRun.send('\x1b[H')
  assertCaret(stagedRun, 'Home with a long draft behind the field', { width: 24 })
  assert.equal(stagedRun.tui.cursor, 24, 'the draft caret is untouched')
})

// ── C · the composer keeps its own caret ─────────────────────────────────────

test('W-3b.1a: with no Surface the draft owns the caret, as it always did', async () => {
  const DRAFT = '我打了一半的消息'
  const cases = [
    { name: 'Home', keys: ['\x1b[H'], text: DRAFT, cursor: 0 },
    { name: 'End', keys: ['\x1b[F'], text: DRAFT, cursor: DRAFT.length },
    { name: 'Ctrl+A', keys: ['\x01'], text: DRAFT, cursor: 0 },
    { name: 'Ctrl+E', keys: ['\x05'], text: DRAFT, cursor: DRAFT.length },
    { name: 'Home then Delete', keys: ['\x1b[H', '\x1b[3~'], text: '打了一半的消息', cursor: 0 },
    { name: 'End then Backspace', keys: ['\x1b[F', '\x7f'], text: '我打了一半的消', cursor: DRAFT.length - 1 },
    { name: 'typing at the caret', keys: ['x'], text: '我打了x一半的消息', cursor: 4 },
  ]
  for (const entry of cases) {
    const stagedRun = await staged({ draft: DRAFT, cursor: 3 })
    for (const key of entry.keys) await stagedRun.send(key)
    assert.equal(stagedRun.tui.input, entry.text, `${entry.name}: the draft is the field`)
    assert.equal(stagedRun.tui.cursor, entry.cursor, `${entry.name}: and the caret is the draft's`)
    assertCaret(stagedRun, `composer + ${entry.name}`, { width: COLUMNS })
  }
})

test('W-3b.1a: the folded and multi-line composer keep their caret on screen', async () => {
  const stagedRun = await staged({ columns: 24 })
  const pasted = '第一行\n第二行\n第三行'
  await stagedRun.send(`\x1b[200~${pasted}\x1b[201~`)
  assert.equal(stagedRun.tui.inputFolded, true, 'a multi-line paste folds the composer')
  assertCaret(stagedRun, 'folded composer', { width: 24 })
  // The paste landed at the caret (3), so the caret is there plus what arrived — the
  // folded row draws a window around it rather than the whole draft.
  assert.equal(stagedRun.tui.cursor, 3 + pasted.length, 'the caret is where the paste left it')

  const multi = await staged({ columns: 40, draft: '第一行\n第二行', cursor: 4 })
  assertCaret(multi, 'unfolded multi-line draft', { width: 40 })
  await multi.send('\x1b[H')
  assertCaret(multi, 'unfolded multi-line draft after Home', { width: 40 })
})

// ── D · the field goes back to the draft ─────────────────────────────────────

test('W-3b.1a: the caret goes back to the draft when the Surface releases the field', async () => {
  const DRAFT = '我打了一半的消息'
  const stagedRun = await staged({ draft: DRAFT, cursor: 3 })
  await openBorrowedQuestion(stagedRun.tui)
  await stagedRun.settle()
  await stagedRun.send('ab')
  await stagedRun.send('\x1b[H')
  assertCaret(stagedRun, 'borrowed field, caret at its start')

  // Answering releases the field: the caret is the draft's again — position 3, which the
  // borrowed answer never touched.
  await stagedRun.send('\r')
  for (let attempt = 0; attempt < 20 && stagedRun.tui.dialog !== undefined; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(stagedRun.tui.dialog, undefined, 'the question was answered')
  assert.equal(stagedRun.tui.borrowedText, undefined, 'and the field went back')
  await stagedRun.settle()
  assert.equal(stagedRun.tui.cursor, 3, 'the draft caret is where the reader left it')
  const seen = assertCaret(stagedRun, 'the caret is the draft’s again', { width: COLUMNS })
  assert.deepEqual(seen.actual, { x: PROMPT_WIDTH + displayWidth(DRAFT.slice(0, 3)), y: seen.inputRow },
    'three CJK characters before the caret: the draft’s own position')

  // The next Surface borrows a fresh field: no caret is inherited.
  await openBorrowedQuestion(stagedRun.tui)
  await stagedRun.settle()
  assert.deepEqual({ text: stagedRun.tui.borrowedText?.text, cursor: stagedRun.tui.borrowedText?.cursor }, { text: '', cursor: 0 })
  assertCaret(stagedRun, 'the next Surface starts with its own empty field')
})

test('W-3b.1a: cancelling hands the caret back the same way', async () => {
  const stagedRun = await staged()
  await openBorrowedQuestion(stagedRun.tui)
  await stagedRun.settle()
  await stagedRun.send('ab')
  assertCaret(stagedRun, 'borrowed field before the cancel')
  stagedRun.tui.handleData(Buffer.from('\x1b')) // held for the 60 ms escape window
  for (let attempt = 0; attempt < 40 && stagedRun.tui.dialog !== undefined; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(stagedRun.tui.dialog, undefined, 'the Escape cancelled the question')
  await stagedRun.settle()
  assert.equal(stagedRun.tui.cursor, 3, 'the draft caret came back')
  assertCaret(stagedRun, 'the caret after a cancelled Surface')
})
