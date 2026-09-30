import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'

import { TerminalInputPump } from '../lib/terminal-input.js'
import { GLYPH_PROBE_TEXT, measureAmbiguousGlyphWidth } from '../lib/glyph-measure.js'
import { screen } from './screen.mjs'

/**
 * What the cursor probe leaves behind on a terminal.
 *
 * Two artifacts were reported from real sessions over SSH, both from the same
 * probe at attach:
 *
 *  - the probe's line (`①—…“”·•Ⅰ`) sitting in front of the shell prompt, because
 *    the probe erases its own line only if something else paints there and the
 *    erase was the caller's job — a caller that never painted (a failed attach,
 *    or a relay torn down mid-probe) left the glyphs on the screen for the rest
 *    of the session;
 *  - `^[[25;1R` echoed at the prompt, because the answer to a probe arrives one
 *    round trip after the request: on a slow link the relay had already restored
 *    cooked mode, so the tty echoed the answer and left it in the queue for the
 *    shell to read as typing.
 *
 * These pin both at the byte level and on a real terminal grid.
 */
const delay = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

/** A TTY-shaped pair of streams: what the pump writes, and what it reads. */
function terminal() {
  const stdin = new PassThrough()
  stdin.isTTY = true
  const chunks = []
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  })
  stdout.isTTY = true
  return { stdin, stdout, written: () => chunks.join('') }
}

function pumpOn(streams, input = []) {
  const pump = new TerminalInputPump({
    stdin: streams.stdin,
    stdout: streams.stdout,
    onInput: text => input.push(text),
    ssh: false,
  })
  pump.start()
  return pump
}

const ERASE = '\r\u001b[2K'

test('the probe puts its line back when the terminal answers', async () => {
  const streams = terminal()
  const input = []
  const pump = pumpOn(streams, input)
  const pending = pump.askPosition(GLYPH_PROBE_TEXT, 500)
  streams.stdin.write('\u001b[25;13R')
  const position = await pending
  pump.stop()

  assert.deepEqual(position, { row: 25, column: 13 })
  assert.equal(streams.written(), `${ERASE}${GLYPH_PROBE_TEXT}\u001b[6n${ERASE}`)
  assert.deepEqual(input, [], 'the answer is not typing')
})

test('a probe nobody answers still clears its line', async () => {
  const streams = terminal()
  const pump = pumpOn(streams)
  const position = await pump.askPosition(GLYPH_PROBE_TEXT, 20)
  pump.stop()

  assert.equal(position, undefined)
  assert.equal(streams.written().endsWith(ERASE), true, streams.written())
})

test('giving up on an outstanding probe clears its line too', async () => {
  // What a teardown does: `stop()` cancels the waiter, and the line it printed
  // must not be left for the shell. Before this, only the timeout path cleared.
  const streams = terminal()
  const pump = pumpOn(streams)
  const pending = pump.askPosition(GLYPH_PROBE_TEXT, 5_000)
  pump.stop()
  const position = await pending

  assert.equal(position, undefined)
  assert.equal(streams.written().endsWith(ERASE), true, streams.written())
})

test('the terminal is left blank after a measurement', async () => {
  const streams = terminal()
  const grid = screen(60, 6)
  const pump = pumpOn(streams)
  const glyphs = [...GLYPH_PROBE_TEXT].length
  const measuring = measureAmbiguousGlyphWidth({ pump, timeoutMs: 500 })
  // A terminal that spends two cells on every probe glyph answers with the
  // column one past the last of them.
  streams.stdin.write(`\u001b[1;${1 + glyphs * 2}R`)
  const measured = await measuring
  pump.stop()

  assert.deepEqual(measured, { wide: true, cells: glyphs * 2 })
  await grid.write(streams.written())
  assert.equal(grid.lines().join('').trim(), '', `residue:\n${grid.lines().join('\n')}`)
})

test('an answer that arrives while the terminal is handed back never reaches the shell', async () => {
  const streams = terminal()
  const input = []
  const pump = pumpOn(streams, input)
  streams.stdin.write('a')
  await delay(5)

  const handingBack = pump.handBack(60)
  streams.stdin.write('\u001b[25;1R')
  await handingBack

  assert.equal(input.join(''), 'a', 'typing survives; the answer does not')
  assert.equal(/\d;\d+R/u.test(input.join('')), false)
  assert.equal(/\u001b/u.test(input.join('')), false)
})

test('a held partial reply is dropped rather than handed to the shell', async () => {
  // The filter holds a half-arrived reply so its digits cannot leak as typing.
  // At hand-back time that tail is either half a reply or half an escape key,
  // and neither should become the shell's next keystrokes.
  const streams = terminal()
  const input = []
  const pump = pumpOn(streams, input)
  streams.stdin.write('\u001b[12')
  // A one-millisecond hand-back still runs before the filter's 30 ms hold
  // window can release the partial as typing, with slack for a loaded runner.
  await pump.handBack(1)

  assert.deepEqual(input, [])
})
