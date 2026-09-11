/**
 * Screen-level guardrail: paint frames are asserted on a real terminal grid.
 *
 * `composePaintOutput` is where the user-visible display bugs live — residue
 * from an incremental repaint, a row addressed past the viewport (which scrolls
 * the SSH screen and leaves glyphs on the next card), a caret parked outside a
 * real cell. Buffer-string tests cannot see any of that, so these feed the
 * frames into `@xterm/headless` and assert the *screen*.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { composePaintOutput, formatLinkQualityChip } from '../lib/paint.js'
import { fitFooterStatsLine } from '../lib/footer.js'
import { clipAnsiToWidth } from '../lib/term-text.js'
import { screen } from './screen.mjs'

/** One frame the way the TUI paints: transcript rows plus a chrome tail. */
function frame(previous, paintRows, extra = {}) {
  return composePaintOutput({
    width: 24,
    height: 6,
    paintRows,
    previousRows: previous,
    sizeChanged: false,
    chromeChanged: false,
    chromeStart: paintRows.length - 2,
    cursorRow: paintRows.length,
    cursorColumn: 3,
    ...extra,
  })
}

test('a full repaint paints exactly the rows it was given', async () => {
  const s = screen(24, 6)
  const rows = ['alpha', 'bravo', 'charlie', 'delta', '', '> hi']
  await s.write(frame([], rows, { sizeChanged: true }))
  assert.deepEqual(s.lines().slice(0, 6), ['alpha', 'bravo', 'charlie', 'delta', '', '> hi'])
})

test('an incremental repaint never leaves stale glyphs on an unchanged row', async () => {
  const s = screen(24, 6)
  const first = ['one', 'two', 'three', 'four', '', '> a']
  await s.write(frame([], first, { sizeChanged: true }))
  // Row 2 changes; every other row must keep its glyphs untouched.
  const second = ['one', 'TWO!!', 'three', 'four', '', '> a']
  await s.write(frame(first, second))
  assert.deepEqual(s.lines().slice(0, 6), ['one', 'TWO!!', 'three', 'four', '', '> a'])
  // A shorter row must be cleared, not left half-overwritten.
  const third = ['one', 'TWO', 'three', 'four', '', '> a']
  await s.write(frame(second, third))
  assert.equal(s.lines()[1], 'TWO', 'the tail of the longer row is gone')
})

test('a shrinking transcript clears the rows it vacated', async () => {
  const s = screen(24, 6)
  const first = ['a', 'b', 'c', 'd', 'e', '> x']
  await s.write(frame([], first, { sizeChanged: true }))
  const second = ['a', 'b', '', '', '', '> x']
  await s.write(frame(first, second))
  assert.deepEqual(s.lines().slice(0, 6), ['a', 'b', '', '', '', '> x'])
})

test('a row moving from transcript to chrome is repainted', async () => {
  const s = screen(24, 6)
  const first = ['tool body line', 'more body', 'reply', '', '> cmd', 'status']
  await s.write(composePaintOutput({
    width: 24, height: 6, paintRows: first, previousRows: [],
    sizeChanged: true, chromeChanged: false, chromeStart: 4,
    cursorRow: 5, cursorColumn: 3,
  }))
  assert.equal(s.lines()[0], 'tool body line')
  // The card expands: the prompt moves up, so row 1 is chrome now. Leftover
  // body glyphs must not survive under the new prompt.
  const second = ['reply', '', '> cmd', 'status', '', '']
  await s.write(composePaintOutput({
    width: 24, height: 6, paintRows: second, previousRows: first,
    sizeChanged: false, chromeChanged: true, chromeStart: 2, previousChromeStart: 4,
    cursorRow: 3, cursorColumn: 3,
  }))
  assert.deepEqual(s.lines().slice(0, 4), ['reply', '', '> cmd', 'status'])
})

test('a viewport shorter than the transcript never scrolls the screen', async () => {
  const s = screen(24, 3)
  // Ten rows for a three-row viewport: addressing row 4+ would scroll here.
  const rows = Array.from({ length: 10 }, (_, i) => `row ${i}`)
  await s.write(composePaintOutput({
    width: 24, height: 3, paintRows: rows, previousRows: [],
    sizeChanged: true, chromeChanged: false, chromeStart: 8,
    cursorRow: 3, cursorColumn: 3,
  }))
  assert.equal(s.term.buffer.active.baseY, 0, 'the base buffer must not scroll')
  assert.deepEqual(s.lines().slice(0, 3), ['row 0', 'row 1', 'row 2'])
})

test('the caret stays inside a real cell', async () => {
  const s = screen(24, 6)
  const rows = ['a', 'b', 'c', 'd', '', '> here']
  // Column width + 1 and row height + 1 are the values that used to wrap the
  // hardware cursor onto the next row and punch through the last glyph.
  await s.write(composePaintOutput({
    width: 24, height: 6, paintRows: rows, previousRows: [],
    sizeChanged: true, chromeChanged: false, chromeStart: 4,
    cursorRow: 99, cursorColumn: 99,
  }))
  const { x, y } = s.cursor()
  assert.equal(x, 23, 'caret clamped to the last column')
  assert.equal(y, 5, 'caret clamped to the last row')
})

test('a resize repaint converges on exactly the last frame', async () => {
  // The reference terminal is narrow from the start, so it never reflows.
  const reference = screen(20, 6)
  const narrow = ['n'.repeat(18), 'narrow two', 'narrow three', '', '> b', 'status']
  await reference.write(composePaintOutput({
    width: 20, height: 6, paintRows: narrow, previousRows: [],
    sizeChanged: true, chromeChanged: false, chromeStart: 4,
    cursorRow: 5, cursorColumn: 3,
  }))

  // The live one starts wide with DIFFERENT content on every row, then the
  // window is narrowed and the same frame is painted. Any cell the repaint
  // misses keeps its old glyph (a "w") and shows up in the diff below.
  const live = screen(40, 6)
  const wide = ['w'.repeat(38), 'wide row two', 'wide row three', '', '> a', 'wide status']
  await live.write(composePaintOutput({
    width: 40, height: 6, paintRows: wide, previousRows: [],
    sizeChanged: true, chromeChanged: false, chromeStart: 4,
    cursorRow: 5, cursorColumn: 3,
  }))
  await live.resize(20, 6)
  await live.write(composePaintOutput({
    width: 20, height: 6, paintRows: narrow, previousRows: wide,
    sizeChanged: true, chromeChanged: false, chromeStart: 4,
    cursorRow: 5, cursorColumn: 3,
  }))
  for (const [index, expected] of reference.grid().entries()) {
    assert.equal(live.grid()[index], expected, `row ${index} must match the reference exactly`)
  }
})

test('a resize repaint clears the rows the old wrap left behind', async () => {
  // Shrinking the window reflows what is already on screen into more lines
  // than the frame will paint. Without the frame's own full clear (`H` + `J`)
  // those extra wrapped lines survive under the new layout as residue.
  // Start wide so the shrink genuinely reflows what is already on screen;
  // writing at the narrow width would wrap at write time and change nothing.
  const s = screen(40, 8)
  await s.write('the quick brown fox jumps over the lazy dog and keeps going\r\nfooter')
  await s.resize(24, 8)
  await s.write(composePaintOutput({
    width: 24, height: 8,
    paintRows: ['the quick brown fox', 'footer', '', '', '', '', '', ''],
    previousRows: [],
    sizeChanged: true, chromeChanged: false, chromeStart: 6,
    cursorRow: 6, cursorColumn: 3,
  }))
  assert.deepEqual(s.grid(), [
    'the quick brown fox     ',
    'footer                  ',
    '                        ',
    '                        ',
    '                        ',
    '                        ',
    '                        ',
    '                        ',
  ], 'nothing from the pre-resize wrap may survive')
})

test('chrome growth repaints every row from the higher boundary', async () => {
  // The prompt moved down (the card above it shrank), so rows 1..2 are chrome
  // now. Their text is unchanged, but the frame must still paint them: only a
  // forced repaint from `min(chromeStart, previousChromeStart)` guarantees the
  // region the input box occupies is actually owned by this frame.
  const s = screen(24, 8)
  const rows = ['tool body', 'same body', 'reply', '> cmd', 'status', 'x', '', '']
  await s.write(composePaintOutput({
    width: 24, height: 8, paintRows: rows, previousRows: [],
    sizeChanged: true, chromeChanged: false, chromeStart: 3,
    cursorRow: 4, cursorColumn: 3,
  }))
  const frame = composePaintOutput({
    width: 24, height: 8, paintRows: rows, previousRows: rows,
    sizeChanged: false, chromeChanged: true, chromeStart: 1, previousChromeStart: 3,
    cursorRow: 4, cursorColumn: 3,
  })
  for (const row of [2, 3, 4]) {
    assert.equal(frame.includes(`\x1b[${row};1H`), true, `row ${row} must be repainted`)
  }
})

test('an unchanged hidden-caret frame writes nothing at all', async () => {
  // The picker repaints on resize; an unchanged frame must be a no-op, or a
  // finished picker would redraw itself over the live screen.
  const rows = ['a', 'b', 'c', 'd', '', '> x']
  const composed = composePaintOutput({
    width: 24, height: 6, paintRows: rows, previousRows: rows,
    sizeChanged: false, chromeChanged: false, chromeStart: 4,
    cursorRow: 6, cursorColumn: 3, hideCursor: true,
  })
  assert.equal(composed, '', 'nothing changed: no bytes, no caret')
})

// Dragging an SSH window edge fires SIGWINCH faster than the frames can be
// painted. Every repaint is absolute (row 1 is the visible top), so whatever
// the intermediate widths did to the screen — reflow, scrollback — the last
// frame alone decides what is on it.
test('a resize storm converges on the last frame, not on its own history', async () => {
  const width = 30
  const height = 8
  const finalRows = ['final one', 'final two', '', '', '> go', 'status', '', '']
  const paint = (target, rows, w, h, previous) => target.write(composePaintOutput({
    width: w, height: h, paintRows: rows, previousRows: previous,
    sizeChanged: true, chromeChanged: false, chromeStart: h - 2,
    cursorRow: h - 1, cursorColumn: 3,
  }))
  const reference = screen(width, height)
  await paint(reference, finalRows, width, height, [])

  const live = screen(60, 12)
  const storm = [
    [60, 12, 'a'.repeat(55)],
    [44, 10, 'b'.repeat(40)],
    [24, 6, 'c'.repeat(20)],
    [70, 14, 'd'.repeat(64)],
    [34, 9, 'e'.repeat(30)],
    [58, 11, 'f'.repeat(50)],
  ]
  let previous = []
  for (const [w, h, wide] of storm) {
    await live.resize(w, h)
    const rows = Array.from({ length: h }, (_, i) => (i === 0 ? wide : i === h - 1 ? '> live' : `row ${i}`))
    await paint(live, rows, w, h, previous)
    previous = rows
  }
  await live.resize(width, height)
  await paint(live, finalRows, width, height, [])
  for (const [index, expected] of reference.grid().entries()) {
    assert.equal(live.grid()[index], expected, `row ${index} must match the reference exactly`)
  }
  // Rows the storm pushed into scrollback are fine (that is what scrollback is
  // for); a storm glyph still *visible* is not.
  assert.equal(/[a-f]{20,}/u.test(live.grid().join('\n')), false, 'no storm frame may survive on screen')
})

// The footer's link chip (`SSH ●●●○ 90ms`) is the one line that tells an SSH
// user whether the link is measured. Its pips are SGR-wrapped, and the footer
// is assembled in two passes (plain width fitting, then the styled chip glued
// back on), so the width table and a stray escape both land on the grid: four
// hollow circles or a shifted chip were what a mis-measured footer looked like.
test('the link chip keeps its pips on the grid and the footer never wraps', async () => {
  const groups = ['2 turns 5 steps', '12.3k in 4.5k out', '18.2 tok/s']
  const styleFooter = (plainChip, coloredChip, width) => {
    const plain = fitFooterStatsLine(plainChip, groups, width)
    return { plain, styled: clipAnsiToWidth(`${coloredChip}${plain.slice(plainChip.length)}`, width) }
  }
  const wide = styleFooter(
    formatLinkQualityChip('ssh', 160, 90, true, false),
    formatLinkQualityChip('ssh', 160, 90, true, true),
    40,
  )
  const s = screen(40, 4)
  await s.write(composePaintOutput({
    width: 40, height: 4,
    paintRows: ['transcript', '', wide.styled, ''],
    previousRows: [], sizeChanged: true, chromeChanged: false,
    chromeStart: 2, cursorRow: 4, cursorColumn: 3,
  }))
  assert.equal(s.lines()[2], wide.plain, 'color must not move a single cell')
  assert.equal(s.lines()[2].startsWith('SSH ●●●○ 90ms'), true, 'a probed link keeps its filled pips')
  assert.equal(s.lines()[3], '', 'a footer that fits its width must not wrap onto the next row')

  // Narrower than the chip: the line is clipped in place, still no wrapping.
  const narrow = styleFooter(
    formatLinkQualityChip('ssh', 160, 90, true, false),
    formatLinkQualityChip('ssh', 160, 90, true, true),
    12,
  )
  const clipped = screen(12, 4)
  await clipped.write(composePaintOutput({
    width: 12, height: 4,
    paintRows: ['hi', '', narrow.styled, ''],
    previousRows: [], sizeChanged: true, chromeChanged: false,
    chromeStart: 2, cursorRow: 4, cursorColumn: 3,
  }))
  assert.equal(clipped.lines()[2], narrow.styled.replace(/\x1b\[[0-9;]*m/gu, ''), 'the clipped chip occupies its cells')
  assert.equal(clipped.lines()[2].includes('●●●○'), true, 'a narrow window truncates the delay, not the pips')
  assert.equal(clipped.lines()[3], '', 'a clipped footer must not wrap either')
})
