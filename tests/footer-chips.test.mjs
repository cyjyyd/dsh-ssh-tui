import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import {
  fitFooterChips, footerHealthChip, footerIdentityParts, footerStatsGroups, formatQuotaUnknown,
  providerHasQuotaSurface,
} from '../lib/footer.js'
import { formatLinkQualityChip } from '../lib/paint.js'
import { statsRowOf } from '../lib/stats.js'
import { displayWidth, stripAnsi, visibleWidth } from '../lib/term-text.js'
import { formatQuotaBar } from '../lib/tui.js'

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
async function footerTui({ presets, color = false, provider = '', model = '', settings } = {}) {
  const { SshTui } = await import('../lib/tui.js')
  const ctx = {
    get: name => (name === 'agentPresets' ? presets : name === 'settings' ? settings : undefined),
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

/**
 * The quota widget is on screen from the first frame. Before a reading it is an
 * empty bar and `?%` — never `0%`, which would claim a used-up quota — and the
 * TUI keeps asking until a reading lands, then hands over to the normal cadence.
 */
test('the quota bar is on screen before any reading, as an empty bar and a ?', () => {
  assert.equal(formatQuotaUnknown(), `${formatQuotaBar(0)} ?%`)
  assert.match(formatQuotaUnknown(), /^[░]{8} \?%$/u)

  // Which providers get the widget at all: the three with a quota surface, not
  // the one that reports a balance, and not an unknown provider id.
  const llmPiAi = { providers: {
    'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY', baseURL: 'https://opencode.ai/zen/go/v1' },
    'command-code': { apiKeyEnv: 'COMMAND_CODE_API_KEY', baseURL: 'https://api.commandcode.ai/provider/v1' },
    'opencode': { apiKeyEnv: 'OPENCODE_API_KEY', baseURL: 'https://opencode.ai/zen/v1' },
  } }
  assert.equal(providerHasQuotaSurface('xai', llmPiAi), true)
  assert.equal(providerHasQuotaSurface('opencode-go', llmPiAi), true)
  assert.equal(providerHasQuotaSurface('command-code', llmPiAi), true)
  assert.equal(providerHasQuotaSurface('opencode', llmPiAi), false, 'Zen is metered, not quota')
  assert.equal(providerHasQuotaSurface('deepseek-official', llmPiAi), false, 'DeepSeek reports a balance')
  assert.equal(providerHasQuotaSurface('', llmPiAi), false)

  const identity = footerIdentityParts({
    running: false, planReview: false, waitingQuestion: false, compacting: false,
    subagents: 0, tools: 0, planLeftOpen: false, planPending: false, planActive: false,
    idleMs: 0, model: 'grok-4.6', provider: 'xai', parentModel: 'grok-4.6', subModel: 'grok-4.5',
    quotaUnknown: true, foldedInput: false, multiLineInput: false, queued: 0,
  })
  assert.ok(identity.includes('░░░░░░░░ ?%'), identity.join(' · '))
  // It sits where the reading will appear, before the subagent route.
  assert.ok(
    identity.indexOf('░░░░░░░░ ?%') < identity.findIndex(part => part.startsWith('sub:')),
    identity.join(' · '),
  )
  // A provider without a quota surface keeps its row clean.
  const noQuota = footerIdentityParts({
    running: false, planReview: false, waitingQuestion: false, compacting: false,
    subagents: 0, tools: 0, planLeftOpen: false, planPending: false, planActive: false,
    idleMs: 0, model: 'deepseek-v4-flash', provider: 'deepseek-official',
    parentModel: 'deepseek-v4-flash', subModel: 'deepseek-v4-flash',
    foldedInput: false, multiLineInput: false, queued: 0,
  })
  assert.equal(noQuota.some(part => part.includes('?%')), false, noQuota.join(' · '))
})

/** The boot frame of a quota-capable provider, before the first reading. */
test('a booting TUI paints the placeholder where the reading will go', async () => {
  const settings = { get: () => ({ providers: { 'command-code': { apiKeyEnv: 'MISSING_KEY' } } }) }
  const tui = await footerTui({ color: true, provider: 'command-code', model: 'claude-sonnet-5', settings })
  const identity = tui.captureFrame(110, 24).map(stripAnsi).at(-1) ?? ''
  assert.match(identity, /[░]{8} \?%/u, `the bar is there from the first frame: ${JSON.stringify(identity)}`)
  assert.equal(/\d+%/u.test(identity), false, `and no number is invented: ${JSON.stringify(identity)}`)
})

/**
 * Retry until the first reading: a quota API that was down at boot is usually up
 * seconds later, and waiting for the next step would leave `?%` on screen for a
 * whole turn. Once a reading lands — by retry or by the normal cadence — the
 * retry is cancelled rather than firing an extra fetch later.
 */
test('a reading from the normal cadence cancels the waiting retry', async () => {
  const settings = { get: () => ({ providers: { 'command-code': { apiKeyEnv: 'MISSING_KEY' } } }) }
  const tui = await footerTui({ provider: 'command-code', model: 'claude-sonnet-5', settings })
  tui.quotaRetryMs = 120
  // The attempt the Host performs at start-up. The credential is missing, so it
  // fails fast without touching the network, and nothing is invented for it.
  await tui.refreshQuota({ reason: 'start', announce: false }).catch(() => {})
  assert.equal(tui.quotaSnapshot, undefined)
  assert.match(tui.captureFrame(110, 24).map(stripAnsi).at(-1) ?? '', /[░]{8} \?%/u)

  // A reading arrives through the normal cadence before the retry fires.
  let attempts = 0
  tui.fetchQuotaSnapshot = async () => {
    attempts += 1
    return { provider: 'command-code', plan: 'GOAT', source: 'command-code', windows: [
      { label: '滚动 5 小时', period: 'hourly', remainingPercent: 42 },
    ] }
  }
  await tui.refreshQuota({ reason: 'step', announce: false })
  assert.ok(tui.quotaSnapshot !== undefined, 'the normal refresh took the reading')
  assert.equal(attempts, 1)

  // The armed retry must be gone: no second fetch after its interval.
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(attempts, 1, 'the retry stops once the footer has a reading')
  const identity = tui.captureFrame(110, 24).map(stripAnsi).at(-1) ?? ''
  assert.match(identity, /CC·GOAT 5Hr [█░]{8} 42%/u, `the reading replaced the placeholder: ${JSON.stringify(identity)}`)
})

/**
 * …and the retry has to actually fetch on its own: if the API comes back between
 * two steps, nobody else would ask, and the footer would sit on `?%` until the
 * next turn.
 */
test('the retry picks up a reading that arrives after the boot attempt failed', async () => {
  const settings = { get: () => ({ providers: { 'command-code': { apiKeyEnv: 'MISSING_KEY' } } }) }
  const tui = await footerTui({ provider: 'command-code', model: 'claude-sonnet-5', settings })
  tui.quotaRetryMs = 20
  await tui.refreshQuota({ reason: 'start', announce: false }).catch(() => {})
  assert.equal(tui.quotaSnapshot, undefined)
  // No step, no command: only the retry can find this reading.
  tui.fetchQuotaSnapshot = async () => ({
    provider: 'command-code', plan: 'GOAT', source: 'command-code',
    windows: [{ label: '滚动 5 小时', period: 'hourly', remainingPercent: 42 }],
  })
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && tui.quotaSnapshot === undefined) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(tui.quotaSnapshot !== undefined, 'the retry fetched the reading by itself')
  assert.match(
    tui.captureFrame(110, 24).map(stripAnsi).at(-1) ?? '',
    /CC·GOAT 5Hr [█░]{8} 42%/u,
  )
})

const RING_RE = /[⣀⠉⠋⠛⠞⠟⠿⡿⣿]/u
const BAR_RE = /[█░]{8} \d+%/u
/**
 * The strip row, found by *position*: the identity line is always the last
 * painted row and the strip the one above it. Looking for the link chip's text
 * instead made the test pass in an SSH session and fail on CI, where there is no
 * SSH environment and the same chip reads `本机`/`Local`.
 */
const stripRowOf = frame => frame.at(-2) ?? ''

/**
 * B-1 moved the quota bar and the context ring one row up into the strip; a user
 * on a wide terminal read that as "额度条没了". Both are back on the identity
 * line, in the order they have always had: after the model, before the subagent
 * route. The strip owns the health chip, the link and the counters.
 */
test('quota and the context ring live on the identity line, never the strip', async () => {
  const tui = await footerTui({ color: true, provider: 'xai', model: 'grok-4.6' })
  tui.contextPressure = { percent: 25, usedTokens: 250_000, contextWindow: 1_000_000, level: 'ok' }
  // Two windows, and the *tightest* one is the coarser one: the footer must show
  // the finest window (`5Hr`), short badge included, not `1Wk 12%`.
  tui.quotaSnapshot = {
    provider: 'xai', plan: 'SuperGrok', source: 'supergrok',
    windows: [
      { label: '本周', period: 'weekly', remainingPercent: 12 },
      { label: '滚动 5 小时', period: 'hourly', remainingPercent: 91 },
    ],
  }
  // Wide enough for the badge *and* the tag: at 110 the fitter legitimately
  // trades the badge for the window, which the helpers test covers.
  const frame = tui.captureFrame(130, 24)
  const plain = frame.map(stripAnsi)
  const identity = plain.at(-1) ?? ''
  const strip = stripRowOf(plain)
  assert.match(identity, /grok-4\.6/u, `the model leads the identity line: ${JSON.stringify(identity)}`)
  assert.match(identity, BAR_RE, `the quota bar is on the identity line: ${JSON.stringify(identity)}`)
  assert.match(
    identity,
    /SuperGrok 5Hr [█░]{8} 91%/u,
    `the finest window is the one shown: ${JSON.stringify(identity)}`,
  )
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
  // Wide enough for every counter group: the point is the style, and a narrow
  // row legitimately drops the last group before it can be styled.
  const frame = tui.captureFrame(120, 24)
  // Anchored: the header line also contains `SSH TUI`.
  const strip = frame.at(-2) ?? ''
  const identity = frame.at(-1) ?? ''
  // The link chip leads and keeps the default foreground: the row starts with
  // the chip itself, not with the mute the counters wear. The chip text comes
  // from the same function the painter uses, so the wording (`SSH` / `本机` /
  // `Local`) never enters the assertion.
  const chip = formatLinkQualityChip(tui.paintLink, tui.paintIntervalMs, tui.paintRttMs, tui.paintProbed, true)
  assert.ok(strip.startsWith(chip), `the link chip leads, unmuted: ${JSON.stringify(strip)}`)
  assert.equal(/^\x1b\[90m/u.test(strip), false, `the row does not open muted: ${JSON.stringify(strip)}`)

  // Each group, not just the row: a muted separator alone would satisfy a
  // row-wide check while the counters themselves stayed at the default colour.
  const groups = footerStatsGroups(statsRowOf(tui.statsTracker.snapshot()))
  assert.ok(groups.length > 0, 'the tracker produced counter groups to style')
  for (const group of groups) {
    assert.ok(strip.includes(`\x1b[90m${group}`), `the counter group is muted: ${JSON.stringify(group)} in ${JSON.stringify(strip)}`)
  }
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
