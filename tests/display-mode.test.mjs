import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createParentResizeFilter,
  displayModeFromArgv,
  parseDisplayMode,
  requestedDisplayMode,
  WINDOW_SIZE_REPORT,
} from '../lib/display-mode.js'

/**
 * How a parent that is not a terminal declares the panel size.
 *
 * `DSH_TUI_DISPLAY=stdio` exists for embedders — a PTY panel, a GUI with its own
 * terminal widget, a test harness. They can put bytes on a pipe, but a pipe has
 * no `resize` event and no SIGWINCH, so the size has to travel as input:
 * `CSI 8 ; rows ; cols t`, the same sequence a terminal sends when asked for its
 * size. Getting this wrong in either direction is visible: dropping the report
 * leaves the panel at its boot size, and forwarding it sends escape bytes to the
 * model's prompt as if the user had typed them.
 */
test('a mode word is one of two, and anything else is reported', () => {
  assert.equal(parseDisplayMode('stdio'), 'stdio')
  assert.equal(parseDisplayMode(' TTY '), 'tty')
  assert.equal(parseDisplayMode('StdIO'), 'stdio')
  assert.equal(parseDisplayMode('pipe'), undefined)
  assert.equal(parseDisplayMode(''), undefined)
  assert.equal(parseDisplayMode(undefined), undefined)
})

test('the flag accepts both spellings and leaves the rest of the vector alone', () => {
  assert.equal(displayModeFromArgv(['dsh', '--display', 'stdio', '--new']), 'stdio')
  assert.equal(displayModeFromArgv(['dsh', '--display=stdio']), 'stdio')
  // A missing value belongs to the grammar (a usage error), not to a default.
  assert.equal(displayModeFromArgv(['dsh', '--display', '--new']), '')
  assert.equal(displayModeFromArgv(['dsh', '--new']), undefined)
})

test('the environment is the mechanism, the flag is the sugar', () => {
  assert.deepEqual(requestedDisplayMode({ DSH_TUI_DISPLAY: 'stdio' }, []), { mode: 'stdio' })
  // Both present: the parent describing its own channel wins over a stale flag.
  assert.deepEqual(requestedDisplayMode({ DSH_TUI_DISPLAY: 'tty' }, ['--display', 'stdio']), { mode: 'tty' })
  assert.deepEqual(requestedDisplayMode({}, ['--display', 'stdio']), { mode: 'stdio' })
  assert.deepEqual(requestedDisplayMode({}, []), {})
  // A typo must not read as "the plugin is inert for no reason".
  assert.deepEqual(requestedDisplayMode({ DSH_TUI_DISPLAY: 'pipe' }, []), { invalid: 'pipe' })
  assert.deepEqual(requestedDisplayMode({}, ['--display', 'pipe']), { invalid: 'pipe' })
})

test('a size report becomes a size, and never typing', () => {
  const filter = createParentResizeFilter()
  const { forward, sizes } = filter.push('hi\u001b[8;40;120t there')
  assert.deepEqual(sizes, [{ columns: 120, rows: 40 }])
  assert.equal(forward, 'hi there', 'the report is removed from the input')
})

test('several reports in one read all count', () => {
  const filter = createParentResizeFilter()
  const { sizes } = filter.push('\u001b[8;24;80t\u001b[8;30;100t')
  assert.deepEqual(sizes, [{ columns: 80, rows: 24 }, { columns: 100, rows: 30 }])
})

test('a report split across two reads is held, not typed', () => {
  const filter = createParentResizeFilter()
  const first = filter.push('a\u001b[8;2')
  assert.equal(first.forward, 'a', 'the half-arrived report is not typed')
  assert.deepEqual(first.sizes, [])
  const second = filter.push('4;80t b')
  assert.deepEqual(second.sizes, [{ columns: 80, rows: 24 }])
  assert.equal(second.forward, ' b')
})

test('a lone escape is held for the next read, and releasable without one', () => {
  // The user's own Esc key: it must not be swallowed because it *could* be the
  // start of a size report. A read that follows settles it…
  const filter = createParentResizeFilter()
  assert.equal(filter.push('\u001b').forward, '')
  assert.equal(filter.pending, true, 'the caller can see the run is being held')
  assert.equal(filter.push('[A').forward, '\u001b[A')
  assert.equal(filter.pending, false)
  // …but a bare `ESC` matches the report prefix on its own, so waiting for the
  // next read is waiting forever when the user pressed Escape and nothing else.
  // The deadline is the caller's (`flush()`), which is what the relay arms.
  const held = createParentResizeFilter()
  assert.equal(held.push('\u001b').forward, '')
  assert.equal(held.pending, true)
  assert.equal(held.flush(), '\u001b', 'the deadline hands the Escape over as typing')
  assert.equal(held.pending, false)
  // The same window covers a half-arrived report that never completed.
  const prefix = createParentResizeFilter()
  prefix.push('\u001b[')
  assert.equal(prefix.flush(), '\u001b[')
})

test('a malformed report is ignored rather than hiding the panel', () => {
  const filter = createParentResizeFilter()
  const { forward, sizes } = filter.push('\u001b[8;0;0t')
  assert.deepEqual(sizes, [])
  assert.equal(forward, '')
})

test('the report pattern is the terminal size report', () => {
  assert.equal(WINDOW_SIZE_REPORT.test('\u001b[8;24;80t'), true)
  assert.equal(WINDOW_SIZE_REPORT.test('\u001b[8;24;80;90t'), false)
})
