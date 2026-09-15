import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { fitFooterChips, footerHealthChip } from '../lib/footer.js'
import { displayWidth, stripAnsi } from '../lib/term-text.js'

/**
 * B-1: the status strip loses text before graphics, lowest priority first.
 *
 * The old fitter dropped whole groups from the end, so a narrow terminal kept a
 * long token count and lost the ⚠ that says the install is broken.
 */
setLocale('zh')

const chip = (id, long, short, priority) => ({ id, long, short, priority })
const strip = [
  chip('health', '⚠ 名单缺席（/doctor）', '⚠', 0),
  chip('link', 'SSH ○○○○ 160ms', '○○○○', 1),
  chip('context', '⣿⣿⣀⣀⣀⣀⣀⣀ 12K/1M 3%', '⣿⣿', 2),
  chip('tokens', '输入 35.6K · 输出 3.8K', '', 3),
  chip('quota', 'pro ███████░ 84%', '███████░', 4),
]

test('a wide terminal shows every group in full, in order', () => {
  const line = fitFooterChips(strip, 200)
  for (const entry of strip) assert.ok(line.includes(entry.long), `${entry.id} keeps its text`)
  assert.ok(line.indexOf('⚠') < line.indexOf('SSH'), 'the health glyph leads')
  assert.ok(line.indexOf('SSH') < line.indexOf('pro'), 'the order is the priority order')
})

test('text is lost before graphics, lowest priority first', () => {
  const line = fitFooterChips(strip, 40)
  assert.ok(displayWidth(stripAnsi(line)) <= 40, 'the line fits')
  assert.ok(line.includes('⚠'), 'the health glyph survives')
  assert.ok(line.includes('○○○○'), 'so does the link')
  assert.ok(/[⣿⣀]/u.test(line), 'and the context ring')
  assert.ok(!line.includes('输入 35.6K'), 'the token group loses its text first')
  assert.ok(!line.includes('pro '), 'the quota plan name goes before its bar')
})

test('an extremely narrow terminal keeps the two signals that matter', () => {
  const line = fitFooterChips(strip, 12)
  assert.ok(displayWidth(stripAnsi(line)) <= 12, `the line fits: ${JSON.stringify(line)}`)
  assert.ok(line.includes('⚠'), 'the broken-install glyph is the last thing to go')
  assert.ok(line.includes('○○○○') || line.includes('⣿'), 'and one operational glyph stays')
})

test('a healthy install has no health chip at all', () => {
  assert.equal(footerHealthChip(false), undefined)
  const health = footerHealthChip(true, false)
  assert.equal(health?.priority, 0, 'health outranks everything')
  assert.ok(health?.long.includes('⚠') && health?.short === '⚠', 'both forms carry the glyph')
  // Colour only decorates the glyph; the glyph itself is the signal.
  assert.match(footerHealthChip(true, true)?.short ?? '', /\x1b\[33m⚠\x1b\[0m/u)
})

test('a glyph wider than the terminal is clipped, not allowed to overflow', () => {
  // One chip whose *short* form is already wider than the row: the drop passes
  // cannot help, so the final clip has to.
  const wide = [chip('ring', '⣿⣿⣿⣿⣀⣀', '⣿⣿⣿⣿⣀⣀', 0)]
  const line = fitFooterChips(wide, 3)
  assert.ok(displayWidth(stripAnsi(line)) <= 3, `the line fits: ${JSON.stringify(line)}`)
  assert.ok(line.startsWith('⣿'), 'the most important group is kept and clipped, not dropped')
  // A blank row would hide the one signal a broken install has.
  assert.notEqual(fitFooterChips([chip('h', '⚠ 名单缺席（/doctor）', '⚠', 0)], 1), '')
})

/** A TUI whose roster service is missing (the default) or present. */
async function footerTui({ presets } = {}) {
  const { SshTui } = await import('../lib/tui.js')
  const ctx = {
    get: name => (name === 'agentPresets' ? presets : undefined),
    on() { return () => {} },
  }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  return new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
}

const statsRowOf = tui => tui.captureFrame(40, 24).map(stripAnsi).find(line => /⚠|SSH/u.test(line) && !line.includes('DeepSeek Harness'))

test('a missing roster puts the health chip on the strip, and clicking it opens /doctor', async () => {
  const tui = await footerTui()
  const row = statsRowOf(tui)
  assert.ok(row !== undefined && row.includes('⚠'), `the strip carries the warning: ${JSON.stringify(row)}`)

  const rowIndex = tui.captureFrame(40, 24).findIndex(line => stripAnsi(line) === row) + 1
  tui.handleMouseClick(rowIndex, 1)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(
    tui.rows.some(entry => entry.kind === 'diag'),
    'clicking the warning runs the report that explains it',
  )
})

test('a mounted roster leaves the strip clean', async () => {
  const tui = await footerTui({ presets: { list: async () => [] } })
  const row = statsRowOf(tui)
  assert.equal(row?.includes('⚠'), false, `no warning when the roster is mounted: ${JSON.stringify(row)}`)
})

test('the strip holds the operational signals exactly once', async () => {
  const tui = await footerTui()
  tui.contextPressure = { percent: 25, usedTokens: 250_000, contextWindow: 1_000_000, level: 'ok' }
  const frame = tui.captureFrame(80, 24).map(stripAnsi)
  const rings = frame.filter(line => /[⣀⠉⠋⠛⠞⠟⠿⡿⣿]/u.test(line)).length
  assert.ok(rings >= 1, 'the context ring is on screen')
  const statusLine = frame.at(-1) ?? ''
  assert.equal(
    /[⣀⠉⠋⠛⠞⠟⠿⡿⣿]/u.test(statusLine),
    false,
    `the ring lives on the strip, not the status line: ${JSON.stringify(statusLine)}`,
  )
})

test('narrowing keeps the warning and drops the counter text', async () => {
  const tui = await footerTui()
  // Give the strip a counter group to lose.
  tui.rows.push({ kind: 'assistant', text: 'x' })
  const wide = tui.captureFrame(80, 24).map(stripAnsi).find(line => line.includes('⚠')) ?? ''
  const narrow = tui.captureFrame(24, 24).map(stripAnsi).find(line => line.includes('⚠')) ?? ''
  assert.ok(narrow.includes('⚠'), `the warning survives 24 columns: ${JSON.stringify(narrow)}`)
  assert.ok(displayWidth(narrow) <= 24, 'and the row still fits')
  assert.ok(displayWidth(narrow) <= displayWidth(wide), 'narrowing never widens the strip')
})
