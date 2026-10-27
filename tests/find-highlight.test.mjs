/**
 * `/find` highlights the match in its Search results/preview, not on the whole
 * workspace card. The matcher and highlighter are the old ones; only the paint
 * surface moved (W-5B).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { displayWidth, stripAnsi } from '../lib/term-text.js'
import { SshTui } from '../lib/tui.js'

setLocale('zh')

function terminal(t, { color }) {
  const previousNoColor = process.env.NO_COLOR
  const previousTerm = process.env.TERM
  const previousDepth = process.env.DSH_TUI_COLOR_DEPTH
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

const frameOf = (tui, width = 100, height = 30) => tui.captureFrame(width, height)
const plain = line => stripAnsi(line)
function highlightedSpans(line) {
  const spans = []
  const pattern = /\x1b\[7m([\s\S]*?)\x1b\[27m/gu
  for (const match of line.matchAll(pattern)) spans.push(stripAnsi(match[1] ?? ''))
  return spans
}
function find(tui, query) {
  tui.runCommand(`/find ${query}`)
}
function preview(tui) {
  tui.handleData(Buffer.from('\r'))
}

test('every occurrence on a line is highlighted, and nothing else is', t => {
  terminal(t, { color: true })
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: 'run npm test, then npm test again' })
  find(tui, 'npm test')
  preview(tui)
  const spans = frameOf(tui).flatMap(highlightedSpans)
  assert.deepEqual(spans, ['npm test', 'npm test'], 'both occurrences, exactly the needle')
  assert.ok(plain(frameOf(tui).join('\n')).includes('run npm test'), 'the text is still readable')
})

test('a wrapped long line is highlighted per preview line, without drifting', t => {
  terminal(t, { color: true })
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: `${'x'.repeat(200)} deploy deploy` })
  find(tui, 'deploy')
  preview(tui)
  const width = 40
  const frame = frameOf(tui, width, 30)
  const spans = frame.flatMap(highlightedSpans)
  assert.deepEqual(spans, ['deploy', 'deploy'], 'both wrapped matches, exactly the word')
  for (const line of frame) assert.ok(displayWidth(plain(line)) <= width, `no line overflows: ${JSON.stringify(plain(line))}`)
})

test('a category search highlights the query, not the label', t => {
  terminal(t, { color: true })
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: 'the deploy step is next' })
  find(tui, '回复 deploy')
  preview(tui)
  assert.deepEqual(frameOf(tui).flatMap(highlightedSpans), ['deploy'], 'the label 回复 is not part of the needle')
})

test('without color the match is marked with a prefix, and only there', t => {
  terminal(t, { color: false })
  const tui = fixture({ color: false })
  tui.rows.push({ kind: 'assistant', text: 'alpha deploy here\nsecond line of the same reply' })
  tui.rows.push({ kind: 'system', text: 'unrelated notice' })
  find(tui, 'deploy')
  preview(tui)
  const marked = frameOf(tui).map(plain).filter(line => line.startsWith('» '))
  assert.equal(marked.length, 1, 'only the preview line with the match carries the marker')
  assert.ok(marked[0]?.includes('alpha deploy here'))
})

test('a search with no hits highlights nothing and says so', t => {
  terminal(t, { color: true })
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: 'nothing to see' })
  find(tui, 'zzzz')
  assert.deepEqual(frameOf(tui).flatMap(highlightedSpans), [])
  assert.match(plain(frameOf(tui).join('\n')), /没有匹配|未找到|no match/iu)
})

test('stepping still reports the position and moves the highlight', t => {
  terminal(t, { color: true })
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: 'first deploy' })
  tui.rows.push({ kind: 'assistant', text: 'second deploy' })
  find(tui, 'deploy')
  assert.equal(tui.screen?.search?.hits.length, 2)
  assert.equal(tui.screen?.search?.selected, 1)
  tui.handleData(Buffer.from('\x1b[A'))
  assert.equal(tui.screen?.search?.selected, 0)
  assert.match(plain(frameOf(tui).join('\n')), /1\/2/u)
})

test('the highlight follows the search, which is case-insensitive', t => {
  terminal(t, { color: true })
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: 'Deploy the thing after lunch' })
  find(tui, 'deploy')
  preview(tui)
  assert.deepEqual(frameOf(tui).flatMap(highlightedSpans), ['Deploy'], 'the matched word is highlighted in its own casing')
})

test('a needle the wrap split marks only its two real fragments', t => {
  terminal(t, { color: true })
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: `${'x'.repeat(30)} deploy --dry-run here` })
  find(tui, 'deploy --dry')
  preview(tui)
  const frame = frameOf(tui, 40, 30)
  assert.deepEqual(
    frame.flatMap(highlightedSpans),
    ['deploy ', '--dry'],
    'the split match is two fragments, never the whole first row',
  )
  assert.match(plain(frame.join('\n')).replace(/\s+/gu, ' '), /deploy --dry-run here/u)
})

test('an emoji before the match does not shift the highlight', t => {
  terminal(t, { color: true })
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: '🚀 deploy 🚀 deploy done' })
  find(tui, 'deploy')
  preview(tui)
  assert.deepEqual(frameOf(tui).flatMap(highlightedSpans), ['deploy', 'deploy'], 'both matches, exactly the word')
})

test('CJK and emoji keep multiple match positions exact', t => {
  terminal(t, { color: true })
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: '前 中文🚀 Deploy 中 deploy 后' })
  find(tui, 'deploy')
  preview(tui)
  const frame = frameOf(tui)
  assert.deepEqual(frame.flatMap(highlightedSpans), ['Deploy', 'deploy'], 'both real occurrences, in their own casing')
  assert.match(plain(frame.join('\n')), /中文🚀 Deploy 中 deploy 后/u)
})

function pagedPreview({ color }) {
  const tui = fixture({ color })
  tui.relayColumns = 24
  tui.relayRows = 20
  const text = ['deploy first page', ...Array.from({ length: 60 }, (_, i) => `filler line ${i}`)].join('\n')
  tui.rows.push({ kind: 'assistant', text })
  find(tui, 'deploy')
  preview(tui)
  return tui
}

test('a Preview page without the needle has no forged highlight', t => {
  terminal(t, { color: true })
  const tui = pagedPreview({ color: true })
  const page = tui.searchPage()
  assert.deepEqual(frameOf(tui, 24, 20).flatMap(highlightedSpans), ['deploy'], 'the first page has the real match')

  tui.handleData(Buffer.from('\x1b[6~'))
  assert.equal(tui.screen?.search?.previewOffset, page, 'PgDn moved one Preview page')
  const later = frameOf(tui, 24, 20)
  assert.deepEqual(later.flatMap(highlightedSpans), [], 'a page with no needle must not reverse the first row')
  assert.equal(tui.screen?.search?.previewOffset, page, 'painting did not move the Preview offset')
  for (const line of later) assert.ok(displayWidth(plain(line)) <= 24, `no overflow: ${JSON.stringify(plain(line))}`)
})

test('without color a Preview page without the needle has no forged marker', t => {
  terminal(t, { color: false })
  const tui = pagedPreview({ color: false })
  const page = tui.searchPage()
  const first = frameOf(tui, 24, 20).map(plain).filter(line => line.startsWith('» '))
  assert.equal(first.length, 1, 'only the first page’s real match is marked')

  tui.handleData(Buffer.from('\x1b[6~'))
  assert.equal(tui.screen?.search?.previewOffset, page)
  const later = frameOf(tui, 24, 20).map(plain).filter(line => line.startsWith('» '))
  assert.deepEqual(later, [], 'a page with no needle must not invent a » marker')
  assert.equal(tui.screen?.search?.previewOffset, page, 'painting did not move the Preview offset')
})
