import test from 'node:test'
import assert from 'node:assert/strict'

import {
  advancePaintedRows,
  composePaintFrame,
  composePaintOutput,
  frameByteBudget,
  paintOrder,
  FRAME_BYTE_BUDGETS,
} from '../lib/paint.js'
import { screen } from './screen.mjs'

const WIDTH = 40
const HEIGHT = 20

/** `count` distinct rows, so a deferred row is always distinguishable. */
function rows(count, prefix = 'row') {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(2, '0')} ${'x'.repeat(10)}`)
}

/** One composed frame; the budget and resume point live in the same options. */
function paint(paintRows, previousRows, extra = {}, frame = {}) {
  return composePaintFrame({ ...frameOptions(paintRows, previousRows, extra), ...frame })
}

function frameOptions(paintRows, previousRows, extra = {}) {
  return {
    width: WIDTH,
    height: HEIGHT,
    paintRows,
    previousRows,
    sizeChanged: false,
    chromeChanged: false,
    chromeStart: paintRows.length - 2,
    cursorRow: 1,
    cursorColumn: 1,
    ...extra,
  }
}

/** Row indices a frame actually addressed, read back out of its bytes. */
function addressedRows(output) {
  return [...output.matchAll(/\u001b\[(\d+);1H\u001b\[0m\u001b\[2K/gu)].map(match => Number(match[1]) - 1)
}

test('the byte budget follows the measured link quality', () => {
  assert.equal(frameByteBudget('local'), Number.POSITIVE_INFINITY)
  assert.equal(frameByteBudget('poor'), 2_048)
  assert.ok(frameByteBudget('slow') < frameByteBudget('ok'))
  assert.ok(frameByteBudget('ok') < frameByteBudget('good'))
  assert.equal(frameByteBudget('unknown'), FRAME_BYTE_BUDGETS.unknown)
  // A budget never falls below one row's worth of escape overhead.
  for (const budget of Object.values(FRAME_BYTE_BUDGETS)) {
    if (Number.isFinite(budget)) assert.ok(budget > 256, `${budget} is too small to paint anything`)
  }
})

test('paint order serves the tail first and never forgets a deferred row', () => {
  assert.deepEqual(paintOrder([1, 5, 9]), [9, 5, 1], 'no resume point: newest rows first')
  assert.deepEqual(paintOrder([1, 5, 9], 5), [5, 1, 9], 'deferred rows first, then the tail')
})

test('an unbudgeted frame is byte for byte what the painter always wrote', () => {
  const paintRows = rows(HEIGHT)
  const previous = rows(HEIGHT - 1)
  const options = frameOptions(paintRows, previous, { sizeChanged: true, chromeChanged: true })
  const frame = composePaintFrame(options)
  assert.equal(frame.output, composePaintOutput(options))
  assert.equal(frame.deferred.length, 0)
  assert.deepEqual(frame.painted, Array.from({ length: HEIGHT }, (_, index) => index))
  // The wire order matters: unbudgeted frames stay ascending, which is what
  // every screen-level assertion was written against. `composePaintOutput`
  // delegates to this function, so comparing the two would prove nothing.
  assert.deepEqual(addressedRows(frame.output), frame.painted, 'unbudgeted frames keep ascending row order')
})

test('a budgeted frame spends the budget on the tail and reports the rest', () => {
  const paintRows = rows(HEIGHT)
  const frame = paint(paintRows, [], { sizeChanged: true }, { maxBytes: 900 })
  assert.ok(frame.bytes <= 900 + 200, `frames stay near the budget (${frame.bytes})`)
  assert.ok(frame.deferred.length > 0, 'the rest waits for the next tick')
  assert.equal(frame.resume, Math.max(...frame.deferred))
  assert.deepEqual(
    addressedRows(frame.output).sort((left, right) => left - right),
    frame.painted,
    'only the reported rows were written (order is the tail-first paint order)',
  )

  // The tail is what got painted, not the head.
  assert.ok(Math.max(...frame.painted) === HEIGHT - 1, 'the last row is always painted')
  assert.ok(Math.min(...frame.painted) > 0, 'the head was deferred')
})

test('consecutive budgeted frames drain every dirty row', () => {
  const paintRows = rows(HEIGHT)
  let previous = []
  let from
  const seen = new Set()
  for (let tick = 0; tick < HEIGHT; tick += 1) {
    const frame = paint(paintRows, previous, { sizeChanged: tick === 0 }, {
      maxBytes: 300,
      ...(from === undefined ? {} : { from }),
    })
    for (const index of frame.painted) seen.add(index)
    // The caller marks only what was painted as up to date.
    const merged = previous.slice()
    for (const index of frame.painted) merged[index] = paintRows[index] ?? ''
    previous = merged
    from = frame.resume
    if (from === undefined) break
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: HEIGHT }, (_, index) => index))
  assert.equal(from, undefined, 'the drain converges instead of oscillating')
})

test('a tail that changes every tick does not starve the deferred head', () => {
  const paintRows = rows(HEIGHT)
  let previous = []
  let from
  let headPaintedAt = undefined
  for (let tick = 0; tick < 12 && headPaintedAt === undefined; tick += 1) {
    // Every tick the last three rows change again, which is the streaming case.
    const current = paintRows.map((row, index) => (index >= HEIGHT - 3 ? `${row} ~${tick}` : row))
    const frame = paint(current, previous, { sizeChanged: tick === 0 }, {
      maxBytes: 600,
      ...(from === undefined ? {} : { from }),
    })
    if (frame.painted.includes(0)) headPaintedAt = tick
    const merged = previous.slice()
    for (const index of frame.painted) merged[index] = current[index] ?? ''
    previous = merged
    from = frame.resume
  }
  assert.notEqual(headPaintedAt, undefined, 'the oldest deferred row still gets painted')
})

test('a split repaint ends with the complete screen and no residue', async () => {
  const s = screen(WIDTH, HEIGHT)
  const paintRows = [...rows(HEIGHT - 2), '', '> ready']
  let previous = []
  let from
  for (let tick = 0; tick < HEIGHT; tick += 1) {
    const frame = paint(paintRows, previous, { sizeChanged: tick === 0 }, {
      maxBytes: 260,
      ...(from === undefined ? {} : { from }),
    })
    await s.write(frame.output)
    const merged = previous.slice()
    for (const index of frame.painted) merged[index] = paintRows[index] ?? ''
    previous = merged
    from = frame.resume
    if (from === undefined ) break
  }
  assert.deepEqual(
    s.lines().slice(0, HEIGHT).map(line => line.trimEnd()),
    paintRows.map(line => line.trimEnd()),
    'every row arrived, in order',
  )
  assert.deepEqual(s.cursor(), { x: 0, y: 0 }, 'the caret sits where the frame parked it')
})

test('only painted rows become clean in the next snapshot', () => {
  const previous = ['a', 'b', 'c', 'd']
  const current = ['a2', 'b2', 'c2', 'd2']
  // A frame that only reached rows 2 and 3 leaves 0 and 1 dirty.
  const after = advancePaintedRows(previous, current, [2, 3])
  assert.deepEqual(after, ['a', 'b', 'c2', 'd2'])
  const stillDirty = current.filter((row, index) => row !== (after[index] ?? ''))
  assert.deepEqual(stillDirty, ['a2', 'b2'], 'the deferred rows are still seen as changed')
  // A frame that painted nothing (row count changed) keeps the old length, so
  // the caller still owes the trailing clear.
  assert.deepEqual(advancePaintedRows(['x'], ['x', 'y'], []), ['x'])
})
