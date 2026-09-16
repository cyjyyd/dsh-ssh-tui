import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { fitFooterChips, footerHealthChip } from '../lib/footer.js'
import { displayWidth, stripAnsi, visibleWidth } from '../lib/term-text.js'

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
async function footerTui({ presets, color = false, provider = '', model = '' } = {}) {
  const { SshTui } = await import('../lib/tui.js')
  const ctx = {
    get: name => (name === 'agentPresets' ? presets : undefined),
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: { ...(provider === '' ? {} : { provider }), ...(model === '' ? {} : { model }) },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  return new SshTui(ctx, agent, { sessionId: 'main-session', color, headlessDisplay: true })
}

/**
 * The strip row carrying the health warning.
 *
 * Located by the glyph, not by the link chip's text: the chip says `SSH` on a
 * remote shell and `本地`/`local` everywhere else, and the CI runner is the
 * latter — a matcher that looked for `SSH` found no row at all there.
 */
const warningRowOf = (tui, width = 40) => tui.captureFrame(width, 24).map(stripAnsi).find(line => line.includes('⚠'))

test('a missing roster puts the health chip on the strip, and clicking it opens /doctor', async () => {
  const tui = await footerTui()
  const frame = tui.captureFrame(40, 24)
  const rowIndex = frame.findIndex(line => stripAnsi(line).includes('⚠')) + 1
  assert.ok(rowIndex > 0, `the strip carries the warning:\n${frame.map(stripAnsi).join('\n')}`)

  tui.handleMouseClick(rowIndex, 1)
  // `/doctor` is asynchronous, so poll instead of assuming a fixed delay.
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline && !tui.rows.some(entry => entry.kind === 'diag')) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(
    tui.rows.some(entry => entry.kind === 'diag'),
    'clicking the warning runs the report that explains it',
  )
})

test('a mounted roster leaves the strip clean', async () => {
  const tui = await footerTui({ presets: { list: async () => [] } })
  const frame = tui.captureFrame(40, 24).map(stripAnsi)
  assert.equal(
    frame.some(line => line.includes('⚠')),
    false,
    `no warning when the roster is mounted:\n${frame.join('\n')}`,
  )
})

/**
 * Give the strip a counter group to paint. The tracker is the real source of the
 * footer's groups, so the test drives it instead of hand-writing a snapshot.
 */
function seedCounters(tui) {
  const tracker = tui.statsTracker
  const start = Date.now() - 30_000
  tracker.noteStepStart(1, 1, start)
  tracker.noteFirstToken(1, 1, start + 600)
  tracker.recordUsage(1, 1, { inputTokens: 46_000, outputTokens: 2_400, cacheReadTokens: 20_000, cacheWriteTokens: 6_000 })
  tracker.settleMessage({ turn: 1, step: 1, time: start + 4_000, firstTokenTime: start + 600, outputTokens: 2_400 })
  tracker.noteStepEnd(1, 1)
}

/**
 * The strip's chips carry their own SGR accents (the link pips, the ⚠). Fitting
 * them with a plain-text truncator stripped the accent's ESC and printed its
 * `[32m` body as four literal cells; measuring them with `displayWidth` counted
 * those same characters into the budget and shortened a row that already fit.
 */
test('a styled chip is measured and cut by its cells, not by its escapes', () => {
  const styled = [chip('link', 'SSH \x1b[32m●●●○\x1b[0m 90ms', '●●●○', 0)]
  // 13 visible cells in 20 characters: it fits 13 columns and must survive as-is.
  assert.equal(fitFooterChips(styled, 13), 'SSH \x1b[32m●●●○\x1b[0m 90ms')
  const wide = fitFooterChips([...styled, chip('tokens', '输入 35.6K · 输出 3.8K', '', 1)], 40)
  assert.ok(wide.includes('\x1b[32m●●●○\x1b[0m'), `the accent survives: ${JSON.stringify(wide)}`)
  assert.equal(/\[(?:\d{1,3}(?:;\d{1,3})*)?m/u.test(stripAnsi(wide)), false, 'no sequence body is visible text')
  assert.ok(visibleWidth(wide) <= 40, 'escapes cost no cells')

  const narrow = fitFooterChips([...styled, chip('tokens', '输入 35.6K · 输出 3.8K', '', 1)], 12)
  assert.ok(visibleWidth(narrow) <= 12, `the cut row fits: ${JSON.stringify(narrow)}`)
  assert.equal(/\[(?:\d{1,3}(?:;\d{1,3})*)?m/u.test(stripAnsi(narrow)), false, 'no escape body in the cut row')
  // A styled run cut mid-cell is closed, so the accent cannot bleed into the
  // rest of the row (and the painter's own reset is not relied upon).
  const clipped = fitFooterChips([chip('ring', '\x1b[33m⠿⠿⠿⠿\x1b[0m', '\x1b[33m⠿⠿⠿⠿\x1b[0m', 0)], 3)
  assert.ok(clipped.endsWith('\x1b[0m'), `a cut style is closed: ${JSON.stringify(clipped)}`)
  assert.ok(visibleWidth(clipped) <= 3, `the clipped row fits: ${JSON.stringify(clipped)}`)
})

const RING_RE = /[⣀⠉⠋⠛⠞⠟⠿⡿⣿]/u
const BAR_RE = /[█░]{8} \d+%/u
/** The strip row: the one that opens with the link chip. */
const stripRowOf = frame => frame.find(line => /(?:SSH|本地|local) [●○]/u.test(line)) ?? ''

/**
 * B-1 moved the quota bar and the context ring one row up into the strip; a user
 * on a wide terminal read that as "额度条没了". Both are back on the identity
 * line, in the order they have always had: after the model, before the subagent
 * route. The strip owns the health chip, the link and the counters.
 */
test('quota and the context ring live on the identity line, never the strip', async () => {
  const tui = await footerTui({ color: true, provider: 'xai', model: 'grok-4.6' })
  tui.contextPressure = { percent: 25, usedTokens: 250_000, contextWindow: 1_000_000, level: 'ok' }
  tui.quotaSnapshot = {
    provider: 'xai', plan: 'SuperGrok',
    windows: [{ label: '每周', period: 'week', remainingPercent: 82 }],
  }
  const frame = tui.captureFrame(100, 24)
  const plain = frame.map(stripAnsi)
  const identity = plain.at(-1) ?? ''
  const strip = stripRowOf(plain)
  assert.match(identity, /grok-4\.6/u, `the model leads the identity line: ${JSON.stringify(identity)}`)
  assert.match(identity, BAR_RE, `the quota bar is on the identity line: ${JSON.stringify(identity)}`)
  assert.ok(identity.indexOf('grok-4.6') < identity.search(BAR_RE), 'quota sits after the model')
  assert.match(identity, RING_RE, `the context ring is on the identity line: ${JSON.stringify(identity)}`)
  assert.notEqual(strip, '', `the strip row exists: ${JSON.stringify(plain)}`)
  assert.equal(BAR_RE.test(strip), false, `no quota bar on the strip: ${JSON.stringify(strip)}`)
  assert.equal(RING_RE.test(strip), false, `no context ring on the strip: ${JSON.stringify(strip)}`)
})

/**
 * The class guard for the B-1 miss: `fitFooterChips` measured styled chips with
 * a plain-text truncator, which stripped each accent's ESC and printed its
 * `[32m` body as four literal cells. Every unit test passed because they fed the
 * fitter unstyled chips, so this one asserts on a rendered frame.
 */
test('a colour frame never shows an escape body where a style was meant', async () => {
  const tui = await footerTui({ color: true, provider: 'xai', model: 'grok-4.6' })
  tui.paintLink = 'ssh'
  tui.paintProbed = true
  tui.paintRttMs = 90
  tui.contextPressure = { percent: 25, usedTokens: 250_000, contextWindow: 1_000_000, level: 'ok' }
  const frame = tui.captureFrame(60, 24)
  // No ESC means it is visible text, not a sequence: `[33m⚠[0m` on the grid.
  const ESCAPE_BODY_RE = /\[(?:\d{1,3}(?:;\d{1,3})*)?m/u
  for (const line of frame) {
    assert.equal(
      ESCAPE_BODY_RE.test(stripAnsi(line)),
      false,
      `row shows an escape body: ${JSON.stringify(stripAnsi(line))}`,
    )
  }
})

/**
 * The strip reads as one row with the identity line below it: counters dim, only
 * the accents (link pips, ⚠) painted, and the link chip's own text keeping the
 * default foreground exactly as it did before the strip existed.
 */
test('the strip is muted like the identity line, accents excepted', async () => {
  // The palette is stated: this sandbox runs with NO_COLOR/TERM=dumb, where a
  // muted SGR downgrades to nothing and there is no style to assert.
  const previousDepth = process.env.DSH_TUI_COLOR_DEPTH
  process.env.DSH_TUI_COLOR_DEPTH = 'truecolor'
  // A mounted roster, so the link chip really is the first group on the row.
  const tui = await footerTui({ color: true, provider: 'xai', model: 'grok-4.6', presets: { list: async () => [] } })
  process.env.DSH_TUI_COLOR_DEPTH = previousDepth ?? ''
  if (previousDepth === undefined) delete process.env.DSH_TUI_COLOR_DEPTH
  tui.paintLink = 'ssh'
  tui.paintProbed = true
  tui.paintRttMs = 90
  seedCounters(tui)
  const frame = tui.captureFrame(80, 24)
  // Anchored: the header line also contains `SSH TUI`.
  const strip = frame.find(line => /^(?:SSH|本地|local)\b/u.test(stripAnsi(line))) ?? ''
  const identity = frame.at(-1) ?? ''
  assert.ok(strip.includes('\x1b[90m'), `the counters are muted: ${JSON.stringify(strip)}`)
  assert.match(strip, /^(?:SSH|本地|local)\b/u, `the link text leads, unmuted: ${JSON.stringify(strip)}`)
  assert.ok(identity.includes('\x1b[90m'), 'the identity line is muted too')
})

test('narrowing keeps the warning and drops the counter text', async () => {
  const tui = await footerTui()
  // Give the strip a counter group to lose.
  tui.rows.push({ kind: 'assistant', text: 'x' })
  const wide = warningRowOf(tui, 80) ?? ''
  const narrow = warningRowOf(tui, 24) ?? ''
  assert.ok(narrow.includes('⚠'), `the warning survives 24 columns: ${JSON.stringify(narrow)}`)
  assert.ok(displayWidth(narrow) <= 24, 'and the row still fits')
  assert.ok(displayWidth(narrow) <= displayWidth(wide), 'narrowing never widens the strip')
})
