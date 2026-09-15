import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { displayWidth, stripAnsi } from '../lib/term-text.js'
import { SshTui } from '../lib/tui.js'
import { allText } from './wait.mjs'

/**
 * `/find` highlights the match, not the card.
 *
 * The old highlight wrapped every line of the hit's card in reverse video, which
 * on a narrow screen looked like the card had been selected and never showed
 * *which* word matched. It also used the label-prefixed query ("回复 deploy") as
 * the needle, so a category search highlighted nothing at all.
 */
setLocale('zh')

/**
 * Color decides which highlight path runs, and this suite must test both. The
 * environment is not neutral — a test runner here has `NO_COLOR=1` and
 * `TERM=dumb`, which turns color off no matter what the config says — so each
 * case states the terminal it means to be.
 */
function terminal(t, { color }) {
  const previousNoColor = process.env.NO_COLOR
  const previousTerm = process.env.TERM
  const previousDepth = process.env.DSH_TUI_COLOR_DEPTH
  // The palette override wins over TERM/NO_COLOR, so a test that means "colour
  // terminal" has to state the palette too or a forced `none` in the
  // environment silently turns the assertion into a no-op.
  process.env.DSH_TUI_COLOR_DEPTH = color ? 'truecolor' : 'none'
  if (color) {
    delete process.env.NO_COLOR
    process.env.TERM = 'xterm-256color'
  } else {
    process.env.NO_COLOR = '1'
    process.env.TERM = 'dumb'
  }
  t.after(() => {
    if (previousNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = previousNoColor
    if (previousTerm === undefined) delete process.env.TERM
    else process.env.TERM = previousTerm
    if (previousDepth === undefined) delete process.env.DSH_TUI_COLOR_DEPTH
    else process.env.DSH_TUI_COLOR_DEPTH = previousDepth
  })
}

function fixture({ color = true } = {}) {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 's', options: {}, status: 'idle', session: { id: 's', events: [] }, cancel() {} }
  return new SshTui(ctx, agent, { sessionId: 's', color, headlessDisplay: true })
}

/** Every reverse-video span in a painted line, as plain text. */
function highlightedSpans(line) {
  const spans = []
  const pattern = /\x1b\[7m([\s\S]*?)\x1b\[27m/gu
  for (const match of line.matchAll(pattern)) spans.push(stripAnsi(match[1] ?? ''))
  return spans
}

test('every occurrence on a line is highlighted, and nothing else is', t => {
  terminal(t, { color: true })
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: 'run npm test, then npm test again' })
  tui.runCommand('/find npm test')
  const frame = tui.captureFrame(120, 30)
  const spans = frame.flatMap(highlightedSpans)
  assert.deepEqual(spans, ['npm test', 'npm test'], 'both occurrences, exactly the needle')
  assert.ok(frame.some(line => stripAnsi(line).includes('run npm test')), 'the text is still readable')
})

test('a wrapped long line is highlighted per screen line, without drifting', t => {
  terminal(t, { color: true })
  const tui = fixture()
  // 200 cells of filler, then the needle — on a 40-column screen this only fits
  // after two wraps, which is where an offset-based highlight would slip.
  const filler = `${'x'.repeat(200)} deploy deploy`
  tui.rows.push({ kind: 'assistant', text: filler })
  tui.runCommand('/find deploy')

  const width = 40
  const frame = tui.captureFrame(width, 30)
  const spans = frame.flatMap(highlightedSpans)
  assert.ok(spans.length >= 1, `the needle is highlighted after the wrap: ${JSON.stringify(frame)}`)
  for (const span of spans) assert.equal(span, 'deploy')
  // Every highlighted line must still fit the screen: a span cannot be painted
  // past the right edge.
  for (const line of frame) {
    assert.ok(displayWidth(stripAnsi(line)) <= width, `no line overflows: ${JSON.stringify(stripAnsi(line))}`)
  }
})

test('a category search highlights the query, not the label', t => {
  terminal(t, { color: true })
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: 'the deploy step is next' })
  tui.runCommand('/find 回复 deploy')
  const spans = tui.captureFrame(100, 30).flatMap(highlightedSpans)
  assert.deepEqual(spans, ['deploy'], 'the label 回复 is not part of the needle')
})

test('without color the match is marked with a prefix, and only there', t => {
  terminal(t, { color: false })
  const tui = fixture({ color: false })
  // Two lines in the hit's own card: marking the card and marking the match look
  // identical on a one-line row, so the row has to wrap or break.
  tui.rows.push({ kind: 'assistant', text: 'alpha deploy here\nsecond line of the same reply' })
  tui.rows.push({ kind: 'system', text: 'unrelated notice' })
  tui.runCommand('/find deploy')
  const frame = tui.captureFrame(100, 30).map(stripAnsi)
  const marked = frame.filter(line => line.startsWith('» '))
  assert.deepEqual(marked, ['» alpha deploy here'], 'only the line with the match carries the marker')
})

test('a search with no hits highlights nothing and says so', t => {
  terminal(t, { color: true })
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: 'nothing to see' })
  tui.runCommand('/find zzzz')
  const spans = tui.captureFrame(100, 30).flatMap(highlightedSpans)
  assert.deepEqual(spans, [])
  assert.match(allText(tui), /没有匹配|未找到|no match/iu)
})

test('stepping still reports the position and moves the highlight', t => {
  terminal(t, { color: true })
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: 'first deploy' })
  tui.rows.push({ kind: 'assistant', text: 'second deploy' })
  tui.runCommand('/find deploy')
  const spans = tui.captureFrame(100, 30).flatMap(highlightedSpans)
  assert.equal(spans.length, 1, 'only the current hit is highlighted')

  tui.runCommand('/find deploy')
  assert.match(allText(tui), /1\s*\/\s*2|2\s*\/\s*2/u, 'the step line reports index and total')
})

test('the highlight follows the search, which is case-insensitive', t => {
  terminal(t, { color: true })
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: 'Deploy the thing after lunch' })
  tui.runCommand('/find deploy')
  const spans = tui.captureFrame(100, 30).flatMap(highlightedSpans)
  // The search lowercases both sides, so it hits; the highlight must find the
  // needle in the text as painted, not only in the case that was typed.
  assert.deepEqual(spans, ['Deploy'], 'the matched word is highlighted in its own casing')
})

test('a needle the wrap split is still pointed at', t => {
  terminal(t, { color: true })
  const tui = fixture()
  const width = 40
  // The wrap lands between the two words, so no single painted line contains
  // the whole phrase the user searched for. The row still matched, so the user
  // has to be shown where the hit is.
  tui.rows.push({ kind: 'assistant', text: `${'x'.repeat(30)} deploy --dry-run here` })
  tui.runCommand('/find deploy --dry')
  const frame = tui.captureFrame(width, 30)
  const marked = frame.filter(line => line.includes('\x1b[7m'))
  assert.ok(marked.length >= 1, `the hit row is pointed at even when the wrap splits it:\n${frame.join('\n')}`)
  assert.match(allText(tui), /1\/1/u, 'and the search did report the hit')
})

test('an emoji before the match does not shift the highlight', t => {
  terminal(t, { color: true })
  const tui = fixture()
  // The emoji is one code point but two UTF-16 units, and the search counts
  // units: an offset mapping that forgets this marks the wrong cells.
  tui.rows.push({ kind: 'assistant', text: '🚀 deploy 🚀 deploy done' })
  tui.runCommand('/find deploy')
  const spans = tui.captureFrame(100, 30).flatMap(highlightedSpans)
  assert.deepEqual(spans, ['deploy', 'deploy'], 'both matches, exactly the word')
})
