import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clampSelection,
  copyableRun,
  offsetAtColumn,
  orderPoints,
  selectionSpans,
  selectionText,
} from '../lib/selection.js'

/**
 * Free-form selection over the painted transcript.
 *
 * The mouse is claimed by the TUI, so dragging cannot reach the terminal's own
 * selection; these rules decide what a drag means and what text it copies. Only
 * model replies are selectable, and the unit of a column is a *cell* — the same
 * measure the painter used, so a CJK glyph or an emoji costs two and cannot be
 * half-selected.
 */
const reply = (...text) => text.map(line => ({ text: line, copyable: true }))
const other = (...text) => text.map(line => ({ text: line, copyable: false }))

test('a forward drag selects exactly the dragged cells', () => {
  const lines = reply('run npm test now')
  const selected = { from: { line: 0, column: 4 }, to: { line: 0, column: 12 } }
  assert.deepEqual(selectionSpans(lines, selected), [{ line: 0, start: 4, end: 12 }])
  assert.equal(selectionText(lines, selected), 'npm test')
})

test('a backward drag selects the same text as a forward one', () => {
  const lines = reply('run npm test now')
  const backwards = orderPoints({ line: 0, column: 12 }, { line: 0, column: 4 })
  assert.deepEqual(backwards, { from: { line: 0, column: 4 }, to: { line: 0, column: 12 } })
  assert.equal(selectionText(lines, backwards), 'npm test')
})

test('a multi-line drag joins the lines and pads the middle ones whole', () => {
  const lines = reply('first line', 'middle line', 'last line')
  const selected = orderPoints({ line: 0, column: 6 }, { line: 2, column: 4 })
  assert.deepEqual(selectionSpans(lines, selected), [
    { line: 0, start: 6, end: 10 },
    { line: 1, start: 0, end: 11 },
    { line: 2, start: 0, end: 4 },
  ])
  assert.equal(selectionText(lines, selected), 'line\nmiddle line\nlast')
})

test('cell columns include a whole wide glyph, never half of one', () => {
  // 中文：每字两格。第 1–2 格是「中」，第 3–4 格是「文」。
  const lines = reply('中文abc')
  assert.equal(offsetAtColumn('中文abc', 1), 0, 'the second cell still belongs to 中')
  assert.equal(offsetAtColumn('中文abc', 2), 1, 'the third cell starts 文')
  assert.equal(selectionText(lines, { from: { line: 0, column: 0 }, to: { line: 0, column: 2 } }), '中')
  assert.equal(selectionText(lines, { from: { line: 0, column: 1 }, to: { line: 0, column: 3 } }), '中文')
  assert.equal(selectionText(lines, { from: { line: 0, column: 4 }, to: { line: 0, column: 7 } }), 'abc')
})

test('an emoji is two cells as well', () => {
  const lines = reply('🚀 go')
  assert.equal(selectionText(lines, { from: { line: 0, column: 0 }, to: { line: 0, column: 2 } }), '🚀')
  assert.equal(selectionText(lines, { from: { line: 0, column: 2 }, to: { line: 0, column: 5 } }), ' go')
})

test('only model replies are freely copyable', () => {
  const lines = [...other('a tool card'), ...reply('the answer'), ...other('a notice')]
  assert.deepEqual(copyableRun(lines, 1), { first: 1, last: 1 })
  assert.equal(copyableRun(lines, 0), undefined, 'a drag starting on a tool card selects nothing')
  assert.equal(clampSelection(lines, { line: 0, column: 0 }, { line: 1, column: 3 }), undefined)
})

test('a drag past the reply end stops at the reply', () => {
  const lines = [...reply('the answer', 'second line'), ...other('a notice after it')]
  const clamped = clampSelection(lines, { line: 0, column: 4 }, { line: 2, column: 5 })
  assert.deepEqual(clamped, { from: { line: 0, column: 4 }, to: { line: 1, column: 11 } })
  assert.equal(selectionText(lines, clamped), 'answer\nsecond line')
})

test('two replies in a row are one run, so a drag can cross them', () => {
  const lines = [...reply('first reply'), ...reply('second reply')]
  assert.deepEqual(copyableRun(lines, 0), { first: 0, last: 1 })
  const selected = orderPoints({ line: 0, column: 6 }, { line: 1, column: 6 })
  assert.equal(selectionText(lines, selected), 'reply\nsecond')
})

test('a drag inside one cell, or past the end, still behaves', () => {
  const lines = reply('abc')
  assert.equal(selectionText(lines, { from: { line: 0, column: 2 }, to: { line: 0, column: 2 } }), '')
  assert.deepEqual(selectionSpans(lines, { from: { line: 0, column: 2 }, to: { line: 0, column: 99 } }),
    [{ line: 0, start: 2, end: 3 }])
  assert.equal(selectionText(lines, { from: { line: 0, column: 2 }, to: { line: 0, column: 99 } }), 'c')
})

test('trailing padding is never copied', () => {
  // Painted lines are padded to the frame width; a drag to the right edge must
  // not paste a wall of spaces.
  const lines = reply('echo hi')
  assert.equal(selectionText(lines, { from: { line: 0, column: 0 }, to: { line: 0, column: 80 } }), 'echo hi')
})

test('an empty selection paints nothing and copies nothing', () => {
  const lines = reply('abc')
  assert.deepEqual(selectionSpans(lines, { from: { line: 0, column: 0 }, to: { line: 0, column: 0 } }), [])
  assert.equal(selectionText(lines, { from: { line: 0, column: 0 }, to: { line: 0, column: 0 } }), '')
})
