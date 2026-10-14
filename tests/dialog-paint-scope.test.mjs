/**
 * The dialog's paint scope, on the composed frames (P-1).
 *
 * `scripts/tui-probe.mjs` asserts this end to end through a real PTY, but a pty
 * decides how bytes are chopped and ConPTY rewrites the painter's row addressing
 * entirely — so the scope half of the gate needs a test that owns the frames. This
 * is that test: the real `SshTui`, the real question Surface, the real composer, and
 * `paint()` called explicitly, so every frame in the window is one the test asked
 * for. It runs on every leg, including Windows.
 *
 * What it pins, in the order the probe's step 6c cares about:
 *
 *   1. the arrow moves the layer's highlight and repaints the layer;
 *   2. no frame repaints a row it did not change, except the chrome block the
 *      painter is documented to redraw whole (`src/paint.ts`, `chromeChanged`);
 *   3. nothing above the layer moves — no re-window, no scroll;
 *   4. no clear;
 *   5. the composer's draft, caret, history and scroll are untouched;
 *   6. an independent tick while the layer is up does not turn any of that red.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { attributePaint, judgeInteractionWindow } from '../scripts/paint-attribution.mjs'
import { pushRow } from './wait.mjs'

setLocale('zh')

const COLUMNS = 100
const ROWS = 30
const LABELS = ['Option A', 'Option B']

function fixture() {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  const writes = []
  tui.write = chunk => { writes.push(String(chunk)) }
  return { tui, writes }
}

/**
 * The rows the terminal holds after `text`, taken from the bytes themselves.
 *
 * Not from `tui.lastPaintRows`: that snapshot holds the rows the painter *intends*,
 * before the padder clips them to the frame's width, so a map built from it differs
 * from the bytes on every row and would call a repaint a change.
 */
const held = text => attributePaint(text, { since: 0 }).after

const snapshot = tui => ({
  input: tui.input,
  cursor: tui.cursor,
  historyIndex: tui.historyIndex,
  scroll: tui.scrollOffset,
  focused: tui.focusedRow?.kind ?? null,
  dialog: tui.dialog?.kind ?? '-',
  dialogCursor: tui.dialog?.cursor ?? null,
  rows: tui.rows.length,
})

/** A screen with a transcript, a draft in the composer and a live question layer. */
function staged() {
  const { tui, writes } = fixture()
  const previousColumns = process.stdout.columns
  const previousRows = process.stdout.rows
  process.stdout.columns = COLUMNS
  process.stdout.rows = ROWS
  for (let index = 0; index < 20; index += 1) pushRow(tui, { kind: 'assistant', text: `第 ${index} 行` })
  tui.input = '我打了一半的消息'
  tui.cursor = 3
  tui.paint()
  const pending = tui.askQuestion({ id: 'q1', question: 'Choose an option to verify the dialog', options: [{ label: LABELS[0] }, { label: LABELS[1] }] }, 0, 1)
  pending.catch(() => undefined)
  assert.equal(tui.dialog?.kind, 'questions', 'the question layer is up')
  tui.paint()
  return {
    tui,
    writes,
    restore() {
      process.stdout.columns = previousColumns
      process.stdout.rows = previousRows
      tui.handleData(Buffer.from('\x1b'))
    },
  }
}

/**
 * Judge one window. The starting rows are captured *before* the key is written —
 * they are what the judgement compares against — so every case takes its seed first.
 */
const judgeWindow = (seed, window) => judgeInteractionWindow(window, {
  since: 0,
  until: window.length,
  height: ROWS,
  labels: LABELS,
  initialContent: seed,
})

test('the arrow repaints the layer, and nothing else', () => {
  const { tui, writes, restore } = staged()
  try {
    const before = snapshot(tui)
    const mark = writes.length
    const seed = held(writes.slice(0, mark).join(''))
    tui.handleData(Buffer.from('\x1b[B'))
    tui.paint()
    const window = writes.slice(mark).join('')
    const verdict = judgeWindow(seed, window)
    assert.equal(verdict.ok, true, `the frames must stay inside the layer:\n  ${verdict.failures.join('\n  ')}`)
    assert.equal(verdict.checks.move.ok, true, verdict.checks.move.detail)
    assert.equal(verdict.checks.repaint.ok, true, verdict.checks.repaint.detail)
    assert.equal(verdict.checks.clear.ok, true, verdict.checks.clear.detail)
    assert.ok(verdict.summary.paintedRows.every(row => row >= verdict.bands.layerTop),
      `every painted row is at or below the layer's top (${verdict.summary.paintedRows.join(',')} vs ${verdict.bands.layerTop})`)
    const after = snapshot(tui)
    assert.equal(after.input, before.input, 'the draft is untouched')
    assert.equal(after.cursor, before.cursor, 'the caret is untouched')
    assert.equal(after.historyIndex, before.historyIndex, 'history is untouched')
    assert.equal(after.scroll, before.scroll, 'the transcript did not scroll')
    assert.equal(after.rows, before.rows, 'and no row was pushed')
    assert.equal(after.dialogCursor, 1, 'the highlight moved to the second option')
  } finally {
    restore()
  }
})

test('an independent tick above the layer does not fail the scope gate', () => {
  // The shape that turned `test (0.1.7-rc.1)` red: something else repaints while the
  // layer is up. Here it is the wait card's clock — a real repaint of a transcript
  // row, on its own schedule, one frame before the key's.
  const { tui, writes, restore } = staged()
  try {
    tui.waitStartedAt = Date.now() - 1_100
    tui.markDirty()
    tui.paint()
    const before = snapshot(tui)
    const mark = writes.length
    const seed = held(writes.slice(0, mark).join(''))
    tui.handleData(Buffer.from('\x1b[B'))
    tui.paint()
    const window = writes.slice(mark).join('')
    const verdict = judgeWindow(seed, window)
    assert.equal(verdict.ok, true, `the tick must not fail the gate:\n  ${verdict.failures.join('\n  ')}`)
    assert.equal(verdict.checks.scope.ok, true, verdict.checks.scope.detail)
    assert.equal(snapshot(tui).dialogCursor, 1, 'and the highlight still moved')
    assert.equal(snapshot(tui).input, before.input, 'with the draft untouched')
  } finally {
    restore()
  }
})

test('a frame that repaints the whole screen is caught, and named', () => {
  // The regression the gate exists for, produced without touching the product: the
  // painter's snapshot is cleared, which is what a re-window does — every row is
  // repainted although only the layer changed.
  const { tui, writes, restore } = staged()
  try {
    const mark = writes.length
    const seed = held(writes.slice(0, mark).join(''))
    tui.handleData(Buffer.from('\x1b[B'))
    tui.lastPaintRows = []
    tui.paint()
    const window = writes.slice(mark).join('')
    const verdict = judgeWindow(seed, window)
    assert.equal(verdict.ok, false, 'a whole-screen repaint must fail')
    assert.equal(verdict.checks.scope.ok, false, `scope is the check that catches it: ${verdict.checks.scope.detail}`)
    assert.ok(verdict.summary.unjustified.length > 5,
      `and it names the unchanged rows it repainted (${verdict.summary.unjustified.join(',')})`)
  } finally {
    restore()
  }
})
