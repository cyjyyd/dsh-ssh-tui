import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import { GLYPH_PROBE_TEXT, measureAmbiguousGlyphWidth } from '../lib/glyph-measure.js'
import { hostChildEnv } from '../lib/display-sock.js'
import {
  ambiguousWidthMeasured,
  ambiguousWidthReserved,
  displayWidth,
  pinEmojiCells,
  setAmbiguousWidthMeasured,
  setAmbiguousWidthReserve,
} from '../lib/term-text.js'

/**
 * A terminal that draws a glyph wider than the cell it advances.
 *
 * This is the case behind "`①` collides with the character after it": the glyph
 * spills into the neighbouring cell while the cursor only moves one, so the next
 * character is painted against it. Emoji have the same failure and are pinned
 * with VS15 plus a reserving space; `①` has no variation sequence, so the
 * reserving space is the whole trick — and it can only be applied once we know
 * which of the two the terminal does, which is what the boot measurement is for.
 *
 * The width contract that keeps this honest: **measuring the pinned string and
 * the raw string must give the same number.** Otherwise every padded row is a
 * cell short and the caret lands past the text.
 */

function fakeTerminal(widthFor, { answer = true } = {}) {
  const stdin = new PassThrough()
  stdin.isTTY = true
  const stdout = new PassThrough()
  stdout.isTTY = true
  const written = []
  stdout.on('data', chunk => {
    const text = chunk.toString('utf8')
    written.push(text)
    if (!answer || !text.includes('\u001b[6n')) return
    const columns = widthFor([...GLYPH_PROBE_TEXT].length) + 1
    setImmediate(() => stdin.write(`\u001b[1;${columns}R`))
  })
  return { stdin, stdout, written }
}

test('the boot probe reads the advance the terminal actually spends', async () => {
  const wide = fakeTerminal(cells => cells * 2)
  assert.deepEqual(await measureAmbiguousGlyphWidth({ stdin: wide.stdin, stdout: wide.stdout, timeoutMs: 200 }),
    { wide: true, cells: [...GLYPH_PROBE_TEXT].length * 2 })
  assert.match(wide.written.join(''), /①/, 'the probe actually printed the glyphs')

  const narrow = fakeTerminal(cells => cells)
  assert.deepEqual(await measureAmbiguousGlyphWidth({ stdin: narrow.stdin, stdout: narrow.stdout, timeoutMs: 200 }),
    { wide: false, cells: [...GLYPH_PROBE_TEXT].length })
})

test('a terminal that does not answer, or answers oddly, decides nothing', async () => {
  const silent = fakeTerminal(cells => cells, { answer: false })
  assert.equal(await measureAmbiguousGlyphWidth({ stdin: silent.stdin, stdout: silent.stdout, timeoutMs: 80 }), undefined)

  // A font whose metrics fit neither expectation must not be guessed at.
  const mixed = fakeTerminal(cells => cells + 3)
  assert.equal(await measureAmbiguousGlyphWidth({ stdin: mixed.stdin, stdout: mixed.stdout, timeoutMs: 200 }), undefined)

  // No terminal at all: never even write the probe.
  const pipeIn = new PassThrough()
  const pipeOut = new PassThrough()
  assert.equal(await measureAmbiguousGlyphWidth({ stdin: pipeIn, stdout: pipeOut }), undefined)
  assert.equal(pipeOut.read(), null, 'nothing is written when there is no terminal to answer')
})

test('a one-cell advance reserves the second cell, and the width contract holds', () => {
  setAmbiguousWidthMeasured(false)
  assert.equal(ambiguousWidthReserved(), true, 'the measurement is what turns the reservation on')
  for (const line of ['①abc', '中①中', '①①', 'a①b']) {
    const pinned = pinEmojiCells(line)
    assert.equal(displayWidth(pinned), displayWidth(line),
      `${line}: pinning must not change the measured width`)
    assert.match(pinned, /①[ ]|•[ ]|—[ ]|…[ ]|Ⅰ[ ]/u, `${line}: a reserved glyph carries its space`)
  }
  // Idempotent: pinning an already-pinned row must not add a second space, or a
  // repaint would drift one cell per frame.
  const once = pinEmojiCells('①abc')
  assert.equal(pinEmojiCells(once), once)

  // A terminal that spends both cells itself needs no help.
  setAmbiguousWidthMeasured(true)
  assert.equal(ambiguousWidthReserved(), false)
  assert.equal(pinEmojiCells('①abc'), '①abc')
  assert.equal(displayWidth('①abc'), 5)

  // Back to the neutral state for the rest of the suite.
  setAmbiguousWidthMeasured(undefined)
  setAmbiguousWidthReserve(false)
  assert.equal(ambiguousWidthMeasured(), undefined)
})

test('the launcher hands both facts to the painting process', () => {
  // The Host paints with a socket for stdout, so it cannot measure anything: the
  // verdict travels in its environment. Both halves go — how many cells the
  // terminal *advances*, and whether we must *reserve* the second one. Sending
  // only the first would leave the Host painting the collision that the
  // measurement was taken to fix.
  const narrow = hostChildEnv({ LANG: 'zh_CN.UTF-8' }, true, false)
  assert.equal(narrow.DSH_TUI_AMBIGUOUS_WIDTH, '1', 'the terminal advances one cell')
  assert.equal(narrow.DSH_TUI_AMBIGUOUS_RESERVE, '1', 'and the second cell is ours to spend')

  const wide = hostChildEnv({ LANG: 'zh_CN.UTF-8' }, true, true)
  assert.equal(wide.DSH_TUI_AMBIGUOUS_WIDTH, '2', 'the terminal spends both cells itself')
  assert.equal(wide.DSH_TUI_AMBIGUOUS_RESERVE, '0')

  // No measurement: the locale decides the advance, and nothing is reserved.
  const guessed = hostChildEnv({ LANG: 'zh_CN.UTF-8' }, true, undefined)
  assert.deepEqual([guessed.DSH_TUI_AMBIGUOUS_WIDTH, guessed.DSH_TUI_AMBIGUOUS_RESERVE], ['2', '0'])
  const western = hostChildEnv({ LANG: 'en_US.UTF-8' }, true, undefined)
  assert.deepEqual([western.DSH_TUI_AMBIGUOUS_WIDTH, western.DSH_TUI_AMBIGUOUS_RESERVE], ['1', '0'],
    'and the locale cache must not hand back the previous answer')

  // An explicit setting is the reader's, and is left alone in both directions.
  const forced = hostChildEnv({ DSH_TUI_AMBIGUOUS_WIDTH: '1' }, true, false)
  assert.equal(forced.DSH_TUI_AMBIGUOUS_WIDTH, '1')
  assert.equal(forced.DSH_TUI_AMBIGUOUS_RESERVE, undefined, 'nothing is imposed on top of it')
})
