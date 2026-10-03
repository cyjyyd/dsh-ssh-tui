import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import {
  CAPACITY_SEGMENTS_MEDIUM,
  fitFooterStatusLine,
  footerIdentityParts,
  planRouteBadge,
  activityMeter,
  capacityLevel,
  capacityMeter,
  footerActivity,
  formatElapsedShort,
  formatStatusStats,
  formatStatusThroughput,
  healthMeter,
  performanceValue,
  performanceValueState,
  runtimeStrip,
} from '../lib/footer.js'
import { sessionTokenTotal, statsRowOf } from '../lib/stats.js'
import {
  DEFAULT_TOKENS_PER_CHAR_CJK,
  DEFAULT_TOKENS_PER_CHAR_LATIN,
  ThroughputTracker,
  boundTokensPerChar,
  formatRate,
  isCjkCodePoint,
  medianRate,
  scriptTokensPerChar,
} from '../lib/throughput.js'
import { stripAnsi, visibleWidth } from '../lib/term-text.js'

/**
 * The default status row, after the footer architecture pass.
 *
 * Three things are pinned here, and they are the whole design:
 *
 * 1. the row answers its five questions in one order — link, activity, speed,
 *    quota, context — and the session total trails them;
 * 2. a narrow terminal gets a *simpler* row, never a denser one: each level of
 *    the degradation ladder removes cells, in an order that is the information
 *    priority, and the SSH pips are almost the last thing to go;
 * 3. nothing on the row invents a health grade for throughput. The harness
 *    publishes no performance classification, so `tok/s` is neutral telemetry.
 *
 * The width samples are exact strings on purpose. They are the acceptance
 * record for the layout: a later change that shifts a chip has to change the
 * expectation deliberately instead of drifting.
 */
setLocale('zh')

const LINK = { kind: 'ssh', intervalMs: 160, probed: true, rttMs: 31 }
const CONTEXT = { usedTokens: 610_000, contextWindow: 1_000_000, percent: 61, level: 'ok' }
/** A settled step, so the throughput chip has an exact rate to show. */
const SETTLED = { settledRate: 158.4, liveChars: 0, fresh: false }
/** A live stream, so the throughput chip has an estimate to show. */
const LIVE = { settledRate: 158.4, liveChars: 1_200, liveRate: 162.6, fresh: true }

function stripInput(overrides = {}) {
  return {
    link: LINK,
    activity: { kind: 'idle', text: '空闲' },
    running: false,
    quota: { remainingPercent: 82, period: 'hourly' },
    context: CONTEXT,
    totalTokens: 36_800_000,
    throughput: SETTLED,
    ...overrides,
  }
}

const plain = row => stripAnsi(row)

// ── the meter primitives ────────────────────────────────────────────────────

test('a capacity meter reads remaining and used with one implementation', () => {
  const quota = capacityMeter(82, { label: '5Hr', basis: 'remaining', quota: true })
  assert.equal(quota.text, '5Hr ███████░ 82%')
  assert.equal(quota.level, 'ok')

  const context = capacityMeter(61, { label: 'CTX', basis: 'used' })
  assert.equal(context.text, 'CTX █████░░░ 61%')
  assert.equal(context.level, 'ok')
})

test('a capacity meter with no reading is hollow with a question mark, never 0%', () => {
  const meter = capacityMeter(undefined, { label: '5Hr', basis: 'remaining', quota: true })
  assert.equal(meter.text, '5Hr ░░░░░░░░ ?%')
  assert.equal(meter.text.includes('0%'), false, 'an unread quota is not a used-up quota')
  assert.equal(meter.level, 'ok', 'and it is not a warning either')
})

test('the meter gives up its bar before its number, and can drop the bar entirely', () => {
  assert.equal(
    capacityMeter(61, { label: 'CTX', segments: CAPACITY_SEGMENTS_MEDIUM }).text,
    'CTX ███░░ 61%',
  )
  assert.equal(capacityMeter(61, { label: 'CTX', percentOnly: true }).text, 'CTX 61%')
  assert.equal(
    capacityMeter(61, { label: 'ctx', percentOnly: true, detail: '610K/1M' }).text,
    'ctx 61% · 610K/1M',
  )
})

test('capacity bands follow the thresholds the session already enforces', () => {
  // Context: the harness's own pressure levels, so the bar can never say "fine"
  // while the same session is compacting.
  assert.equal(capacityLevel(64, 'used'), 'ok')
  assert.equal(capacityLevel(80, 'used'), 'warn')
  assert.equal(capacityLevel(95, 'used'), 'over')
  // Quota: the first two of `quota.ts`'s `QUOTA_ALERT_THRESHOLDS` (50 / 25
  // remaining), which is where the session starts telling the user about it.
  assert.equal(capacityLevel(82, 'remaining', true), 'ok')
  assert.equal(capacityLevel(50, 'remaining', true), 'warn')
  assert.equal(capacityLevel(25, 'remaining', true), 'over')
  // A quota is not "used", so the context bands do not apply to it.
  assert.equal(capacityLevel(38, 'remaining', true), 'warn')
  assert.equal(capacityLevel(38, 'used'), 'ok')
})

test('a capacity meter is ASCII-safe and keeps its cell count', () => {
  const unicode = capacityMeter(50, { label: 'CTX', segments: 8, ascii: false })
  const ascii = capacityMeter(50, { label: 'CTX', segments: 8, ascii: true })
  assert.equal(ascii.text, 'CTX ####.... 50%')
  assert.equal(visibleWidth(unicode.text), visibleWidth(ascii.text), 'the fallback costs no cells')
})

test('the health meter is discrete levels, not a bar', () => {
  assert.equal(healthMeter(4), '●●●●')
  assert.equal(healthMeter(3), '●●●○')
  assert.equal(healthMeter(0), '○○○○')
  // The ASCII run matches the project's glyph table, so the fallback the painter
  // applies and the one the meter picks are the same characters.
  assert.equal(healthMeter(2, { ascii: true }), '**oo')
})

test('tok/s is neutral: no threshold colour is ever asked for', () => {
  const live = performanceValue(LIVE, true, { state: 'live', color: true })
  const settled = performanceValue(SETTLED, false, { state: 'settled' })
  // The live form lifts itself out of the row's mute; it never reaches for a
  // green/yellow/red band, because there is no baseline to judge it against.
  assert.equal(live, '\x1b[0m~163 tok/s\x1b[0m')
  assert.equal(settled, '158 tok/s')
  for (const rate of [2, 60, 200, 1_400]) {
    const painted = performanceValue(
      { settledRate: rate, liveChars: 0, fresh: false },
      false,
      { state: 'settled' },
    )
    assert.equal(painted.includes('\x1b'), false, `${rate} tok/s is not graded`)
  }
})

test('the performance value knows when it has no number', () => {
  assert.equal(performanceValueState(undefined, false), 'unavailable')
  assert.equal(performanceValueState(LIVE, true), 'live')
  // A live rate that stopped arriving describes a stream that ended, not one
  // running: the row falls back to the last exact measurement.
  assert.equal(performanceValueState({ ...LIVE, fresh: false }, true), 'unavailable')
  assert.equal(performanceValueState(SETTLED, false), 'settled')
  assert.equal(performanceValue(undefined, false, { state: 'unavailable' }), '— tok/s')
})

test('a rate is a whole number, and a slow step is not a stalled one', () => {
  assert.equal(formatRate(158.4), '158')
  assert.equal(formatRate(0.4), '<1')
  assert.equal(formatRate(0), '<1')
  assert.equal(formatRate(1_200), '1.20K')
})

// ── throughput: what the number actually means ──────────────────────────────

test('the live rate is a windowed estimate, and one burst cannot move it', () => {
  const tracker = new ThroughputTracker()
  // 400 characters over 4 s at the Latin default (0.32 tokens/char) ≈ 32 tok/s.
  for (let i = 1; i <= 40; i++) tracker.note('x'.repeat(10), i * 100)
  const steady = tracker.view(4_000).liveRate ?? 0
  assert.ok(steady > 25 && steady < 40, `steady rate is plausible: ${steady}`)

  // One coalesced burst inside the same window: the median of the last three
  // sample rates ignores it, which is the whole point of keeping three.
  tracker.note('x'.repeat(4_000), 4_100)
  const afterBurst = tracker.view(4_100).liveRate ?? 0
  assert.ok(afterBurst < steady * 4, `the burst does not multiply the rate: ${afterBurst}`)
})

test('a live rate goes stale rather than holding a stale number forever', () => {
  const tracker = new ThroughputTracker()
  for (let i = 1; i <= 20; i++) tracker.note('x'.repeat(20), i * 200)
  assert.equal(tracker.view(4_000).fresh, true)
  assert.equal(tracker.view(4_000 + 60_000).fresh, false, 'a stream that stopped is not current')
  assert.ok(tracker.view(4_000 + 60_000).liveRate !== undefined, 'but the last estimate is kept')
})

test('the median of the recent rates ignores a single outlier', () => {
  assert.equal(medianRate([100, 101, 9_999]), 101)
  assert.equal(medianRate([100]), 100)
  assert.equal(medianRate([]), undefined)
  assert.equal(medianRate([Number.NaN, -1]), undefined)
})

test("a settled step calibrates the estimate with this session's own ratio", () => {
  const tracker = new ThroughputTracker()
  // CJK output: 200 characters decoding to 190 tokens, so this session's own
  // tokens-per-character is ~0.95 against the 0.32 default.
  // CJK text: 200 characters decoding to 190 tokens, so this session's own
  // tokens-per-character is ~0.95 against the Latin default.
  const step = () => {
    for (let i = 1; i <= 20; i++) tracker.note('汉'.repeat(10), i * 100)
    tracker.settle(190, 2_000)
  }
  step()
  // One step moves the ratio halfway — deliberately not all the way. A single
  // step is one sample, and the estimate should follow the session rather than
  // jump to whatever the last reply happened to look like. The step's own script
  // mix already starts it near the CJK end.
  assert.ok(tracker.tokensPerChar() > 0.6, `halfway to the session ratio: ${tracker.tokensPerChar()}`)
  step()
  assert.ok(tracker.tokensPerChar() > 0.7, `two steps converge: ${tracker.tokensPerChar()}`)
  assert.equal(tracker.calibratedRatio(), true, 'and from here it is the session\'s own measurement')
  assert.equal(tracker.view(2_000).settledRate, 95)
  // A step with no usage cannot invent a rate, and cannot poison the ratio.
  tracker.settle(0, 0)
  assert.equal(tracker.view(3_000).settledRate, 95, 'the last real measurement stands')
})

test('the first turn is estimated from the script it is actually written in', () => {
  // The harness publishes no token count while a step streams (verified against
  // both shipped adapters), so the first reply of a session is estimated from
  // characters. How many tokens a character is worth depends on the script — CJK
  // runs close to one per character, Latin about a third — and that is measured
  // from the *text*, continuously, rather than decided by a threshold: a reply that
  // is 70% English and 30% Chinese must land 30% of the way up the range.
  // Both streams carry the *same* number of characters per fragment, so the
  // comparison isolates the script and nothing else.
  const LATIN = 'abcdefghijklmnopqrst'
  // Twenty characters of Chinese, so the two streams differ only in script.
  const CJK20 = '中文内容模型回复这是一段文字中文内容模型'
  assert.equal([...LATIN].length, 20)
  assert.equal([...CJK20].length, 20)

  const latin = new ThroughputTracker()
  for (let i = 1; i <= 20; i++) latin.note(LATIN, i * 100)
  const latinRate = latin.view(2_000).liveRate ?? 0
  const perSecond = 20 / 0.1
  assert.ok(
    Math.abs(latinRate - perSecond * DEFAULT_TOKENS_PER_CHAR_LATIN) / (perSecond * DEFAULT_TOKENS_PER_CHAR_LATIN) < 0.2,
    `Latin text keeps the Latin ratio: ${latinRate}`,
  )

  const cjk = new ThroughputTracker()
  for (let i = 1; i <= 20; i++) cjk.note(CJK20, i * 100)
  const cjkRate = cjk.view(2_000).liveRate ?? 0
  assert.ok(
    Math.abs(cjkRate - perSecond * DEFAULT_TOKENS_PER_CHAR_CJK) / (perSecond * DEFAULT_TOKENS_PER_CHAR_CJK) < 0.2,
    `Chinese text keeps the CJK ratio: ${cjkRate}`,
  )
  assert.ok(cjkRate > latinRate * 2, `same characters, more tokens: ${cjkRate} vs ${latinRate}`)

  // Half and half sits between the two, not on either side of a cliff.
  const mixed = new ThroughputTracker()
  for (let i = 0; i < 20; i++) mixed.note('中文ab', i * 100)
  const share = mixed.cjkShare()
  assert.equal(share, 0.5, `the script mix is measured, not guessed: ${share}`)
  const mixedRatio = mixed.tokensPerChar()
  assert.ok(
    mixedRatio > DEFAULT_TOKENS_PER_CHAR_LATIN && mixedRatio < DEFAULT_TOKENS_PER_CHAR_CJK,
    `a mixed stream interpolates: ${mixedRatio}`,
  )

  // A settled step takes over from the script estimate, and the row keeps marking
  // the number as an estimate either way.
  cjk.settle(600, 2_000)
  assert.equal(cjk.calibratedRatio(), true)
  assert.equal(performanceValue(LIVE, true, { state: 'live' }).startsWith('~'), true)
})

test('the script estimate is per step, and does not leak across steps', () => {
  const tracker = new ThroughputTracker()
  for (let i = 0; i < 10; i++) tracker.note('中文中文中文', i * 100)
  assert.ok(tracker.cjkShare() > 0.9, 'the step is registered as Chinese')
  // `settle` (and `reset`) start the next step's mix from scratch: a Chinese reply
  // followed by an English one must not be estimated as Chinese.
  tracker.settle(0, 0)
  assert.equal(tracker.cjkShare(), 0)
  for (let i = 0; i < 10; i++) tracker.note('plain latin text', 1_000 + i * 100)
  assert.equal(tracker.cjkShare(), 0)
})

test('the calibration is bounded on both sides', () => {
  assert.equal(boundTokensPerChar(0), 0.32)
  assert.equal(boundTokensPerChar(-5), 0.32)
  assert.equal(boundTokensPerChar(Number.NaN), 0.32)
  assert.equal(boundTokensPerChar(0.0001), 0.1)
  assert.equal(boundTokensPerChar(50), 1.5)
})

// ── the session total ──────────────────────────────────────────────────────

test('only the two named subscriptions carry a badge, and it closes the row', () => {
  assert.equal(planRouteBadge('opencode-go', { plan: 'OpenCode Go', source: 'opencode-go' }), 'OpenCode-GO')
  assert.equal(planRouteBadge('command-code', { plan: 'goat', source: 'command-code' }), 'CommandCode-GOAT')
  // The tier comes from the billing reply, so before the first reading the badge
  // names the vendor without claiming a tier it has not seen.
  assert.equal(planRouteBadge('command-code', undefined), 'CommandCode')
  assert.equal(planRouteBadge('command-code', { plan: 'Command Code', source: 'command-code' }), 'CommandCode')
  // SuperGrok's plan is already in its quota chip's window tag, and DeepSeek is
  // metered: neither claims a badge.
  assert.equal(planRouteBadge('xai', { plan: 'SuperGrok', source: 'supergrok' }), undefined)
  assert.equal(planRouteBadge('deepseek-official', undefined), undefined)
  assert.equal(planRouteBadge('opencode', undefined), undefined)
  assert.equal(planRouteBadge(''), undefined)

  // On the row it is the *last* part, behind the child route: context rather than
  // action, and therefore the first thing a narrow row gives up.
  const parts = footerIdentityParts({
    running: false, planReview: false, waitingQuestion: false, compacting: false,
    subagents: 0, tools: 0, planLeftOpen: false, planPending: false, planActive: false,
    idleMs: 0, model: 'grok-4.6', provider: 'opencode-go', parentModel: 'grok-4.6',
    subModel: 'grok-4.5', foldedInput: false, multiLineInput: false, queued: 0,
    cwdLabel: '目录:dsh-ssh-tui', planBadge: 'OpenCode-GO',
  }, { omitModel: true })
  assert.deepEqual(parts, ['目录:dsh-ssh-tui', 'sub:grok-4.5', 'OpenCode-GO'])
  const fitted = fitFooterStatusLine('', parts, 20)
  assert.equal(fitted.includes('OpenCode-GO'), false, 'the badge goes first when the row is tight')
  assert.equal(fitted.includes('目录:dsh-ssh-tui'), true, fitted)
})

test('the session total uses the harness total when the harness published one', () => {
  const usage = {
    inputTokens: 46_000,
    outputTokens: 2_400,
    reportedTokens: 74_400,
    reportedSteps: 1,
    unreportedSteps: 0,
    cacheReadTokens: 20_000,
    cacheWriteTokens: 6_000,
  }
  assert.deepEqual(sessionTokenTotal(usage), { tokens: 74_400, basis: 'harness' })
  // A step that reported no total contributes its billed parts, and the basis
  // says so: the two figures are not the same accounting.
  assert.deepEqual(sessionTokenTotal({ ...usage, unreportedSteps: 1 }), {
    tokens: 74_400 + 74_400,
    basis: 'sum',
  })
  assert.equal(
    sessionTokenTotal({
      inputTokens: 0, outputTokens: 0, reportedTokens: 0, reportedSteps: 0,
      unreportedSteps: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }),
    undefined,
    'an empty session has no total to show',
  )
})

// ── the strip ──────────────────────────────────────────────────────────────

const WIDTHS = [40, 72, 88, 100, 120, 160, 200]

test('the install warning is a chip on the same ladder, not a strip fitted around it', () => {
  // One convergence path for the whole row: the warning used to be composed by a
  // separate fitter and the rest of the row fitted into what was left, with the
  // width hand-computed at the call site. Here `runtimeStrip` alone owns the line.
  const warning = { long: '⚠ 代理平面行缺失（/doctor）', short: '⚠' }
  const withWarning = overrides => stripInput({ warning, ...overrides })
  for (const width of [200, 120, 88, 72, 60, 40, 30, 24, 12]) {
    const row = plain(runtimeStrip(withWarning(), width, ' │ ', '⠹'))
    assert.ok(visibleWidth(row) <= width, `${width}: fits (${visibleWidth(row)})`)
    assert.ok(row.includes('⚠'), `${width}: the broken-install glyph survives: ${JSON.stringify(row)}`)
  }
  // Its sentence holds while the counters and the meters shorten around it, and the
  // glyph is what survives after that — it is the actionable part (it is what opens
  // `/doctor`), so it outranks every chip on the row.
  const wide = plain(runtimeStrip(withWarning(), 100, ' │ ', '⠹'))
  assert.ok(wide.includes('代理平面行缺失'), `the sentence is readable while there is room: ${JSON.stringify(wide)}`)
  assert.equal(wide.includes('Tok '), false, 'while the session total is already gone')
  const narrow = plain(runtimeStrip(withWarning(), 88, ' │ ', '⠹'))
  assert.equal(narrow.includes('代理平面行缺失'), false, 'the sentence is what a narrower row buys back')
  assert.ok(narrow.includes('⚠'), 'but the glyph stays')
  // …and at the very end it is the one thing left, because a broken install cannot
  // be read off the screen it broke.
  assert.equal(plain(runtimeStrip(withWarning(), 3, ' │ ', '⠹')), '⚠')
  // Nothing about the warning changes the rest of the ladder when it is absent.
  assert.equal(
    runtimeStrip(stripInput(), 120, ' │ ', '⠹'),
    runtimeStrip(stripInput({ warning: undefined }), 120, ' │ ', '⠹'),
  )
})

test('the row never exceeds its width, at any width or state', () => {
  const states = {
    idle: stripInput(),
    reply: stripInput({
      running: true,
      activity: { kind: 'reply', text: '回复中', startedAt: Date.now() - 12_000 },
      throughput: LIVE,
    }),
    thinking: stripInput({
      running: true,
      activity: { kind: 'thinking', text: '思考中', startedAt: Date.now() - 18_000 },
      throughput: LIVE,
    }),
    agent: stripInput({
      running: true,
      activity: { kind: 'agent', text: '代理', startedAt: Date.now() - 192_000 },
    }),
    waiting: stripInput({ running: true, activity: { kind: 'waiting', text: '等待回答' } }),
    'no-signals': stripInput({ quota: undefined, context: undefined, totalTokens: undefined, throughput: undefined }),
    'quota-unknown': stripInput({ quota: {} }),
    'over-limit': stripInput({
      quota: { remainingPercent: 3, period: 'weekly' },
      context: { ...CONTEXT, percent: 97 },
    }),
    'long-activity': stripInput({
      running: true,
      activity: {
        kind: 'tools', text: 'terminal',
        detail: 'pytest -x tests/ --maxfail=1 -k footer', startedAt: Date.now() - 3_600_000,
      },
    }),
  }
  for (const [name, input] of Object.entries(states)) {
    for (const width of WIDTHS) {
      const row = runtimeStrip(input, width, ' │ ', '⠹')
      assert.ok(
        visibleWidth(row) <= width,
        `${name} @ ${width}: ${JSON.stringify(plain(row))} is ${visibleWidth(row)} cells`,
      )
    }
  }
})

test('a wide row carries the five signals in priority order, total last', () => {
  const row = plain(runtimeStrip(stripInput(), 200, ' │ ', '⠹'))
  assert.equal(
    row,
    'SSH ●●●● 31ms │ 空闲 │ 158 tok/s │ 5Hr ███████░ 82% │ CTX █████░░░ 61% · 610K/1M │ Tok 36.8M',
  )
  // The order is the design: link, activity, speed, quota, context, total.
  let at = -1
  for (const token of ['SSH', '空闲', '158 tok/s', '5Hr', 'CTX', 'Tok']) {
    const found = row.indexOf(token)
    assert.ok(found > at, `${token} follows the previous signal`)
    at = found
  }
})

test('a narrowing row loses signals in the designed order, and never regains one', () => {
  // The loss order is the information priority: the session total, then the
  // context's ratio, then bar cells, then the bars, then the idle activity, then
  // the labels — and the SSH pips almost last.
  const expected = {
    200: 'SSH ●●●● 31ms │ 空闲 │ 158 tok/s │ 5Hr ███████░ 82% │ CTX █████░░░ 61% · 610K/1M │ Tok 36.8M',
    120: 'SSH ●●●● 31ms │ 空闲 │ 158 tok/s │ 5Hr ███████░ 82% │ CTX █████░░░ 61% · 610K/1M │ Tok 36.8M',
    100: 'SSH ●●●● 31ms │ 空闲 │ 158 tok/s │ 5Hr ███████░ 82% │ CTX █████░░░ 61% · 610K/1M │ Tok 36.8M',
    88: 'SSH ●●●● 31ms │ 空闲 │ 158 tok/s │ 5Hr ███████░ 82% │ CTX █████░░░ 61% · 610K/1M',
    72: 'SSH ●●●● 31ms │ 空闲 │ 158 tok/s │ 5Hr ███████░ 82% │ CTX ███░░ 61%',
    60: 'SSH ●●●● 31ms │ 空闲 │ 158 tok/s │ 5Hr ████░ 82% │ CTX 61%',
    48: 'SSH ●●●● 31ms │ 158 tok/s │ 5Hr 82% │ CTX 61%',
    40: 'SSH 31ms │ 158 t/s │ 5h 82% │ ctx 61%',
  }
  const measured = {}
  for (const [width, row] of Object.entries(expected)) {
    const actual = plain(runtimeStrip(stripInput(), Number(width), ' │ ', '⠹'))
    measured[width] = actual
    assert.equal(actual, row, `${width} columns`)
    assert.ok(visibleWidth(actual) <= Number(width), `${width}: fits`)
  }
  // Monotone by construction: the cells a row spends never grow as the terminal
  // narrows. A narrower terminal must get less, not a denser copy.
  const order = ['200', '120', '100', '88', '72', '60', '48', '40']
  const cells = order.map(width => visibleWidth(measured[width]))
  for (let i = 1; i < cells.length; i++) {
    assert.ok(cells[i] <= cells[i - 1], `${order[i]} is not wider than ${order[i - 1]}`)
  }
})

test('the session total is the first chip a narrowing row gives up', () => {
  assert.match(plain(runtimeStrip(stripInput(), 100, ' │ ', '⠹')), /Tok 36\.8M$/)
  const narrower = plain(runtimeStrip(stripInput(), 88, ' │ ', '⠹'))
  assert.equal(narrower.includes('Tok '), false, 'the total goes before a live signal does')
  assert.ok(narrower.includes('CTX'), 'and the context meter is still there')
  assert.match(narrower, /610K\/1M/, 'and the context detail outlives the total')
})

test('the quota and context meters keep their number after their bar is gone', () => {
  const wide = plain(runtimeStrip(stripInput(), 160, ' │ ', '⠹'))
  assert.match(wide, /5Hr ███████░ 82%/, 'the window tag leads the eight-segment bar')
  assert.match(wide, /CTX █████░░░ 61%/)

  const noContextBar = plain(runtimeStrip(stripInput(), 60, ' │ ', '⠹'))
  assert.match(noContextBar, /CTX 61%/, 'the context meter gives up its bar first')
  assert.match(noContextBar, /5Hr ████░ 82%/, 'while the quota keeps a shorter bar')

  const noBars = plain(runtimeStrip(stripInput(), 48, ' │ ', '⠹'))
  assert.equal(/[█░]/.test(noBars), false, 'a 48-column row spends no cells on bar glyphs')
  assert.match(noBars, /82%/, 'but the quota number survives')
  assert.match(noBars, /61%/, 'and so does the context number')

  const abbreviated = plain(runtimeStrip(stripInput(), 40, ' │ ', '⠹'))
  assert.match(abbreviated, /5h 82%/, 'out of room, the window tag is abbreviated')
  assert.match(abbreviated, /ctx 61%/, 'and so is the context label')
})

test('the SSH dots are close to the last thing to go', () => {
  assert.match(plain(runtimeStrip(stripInput(), 72, ' │ ', '⠹')), /SSH ●●●● 31ms/)
  assert.match(plain(runtimeStrip(stripInput(), 48, ' │ ', '⠹')), /SSH ●●●●/, 'even at 48 columns')
  // At the very end the pips go, and the latency with them — but the label,
  // which is what the row is about, stays.
  const minimal = plain(runtimeStrip(stripInput(), 40, ' │ ', '⠹'))
  assert.equal(minimal.startsWith('SSH '), true, minimal)
})

test("link health reuses the project's existing pips and thresholds", () => {
  assert.match(plain(runtimeStrip(stripInput({ link: { ...LINK, rttMs: 31 } }), 200)), /SSH ●●●● 31ms/)
  // The bands are `linkQualityOf`'s own: <50 good, <150 ok, <350 slow, else poor.
  assert.match(plain(runtimeStrip(stripInput({ link: { ...LINK, rttMs: 90 } }), 200)), /SSH ●●●○ 90ms/)
  assert.match(plain(runtimeStrip(stripInput({ link: { ...LINK, rttMs: 180 } }), 200)), /SSH ●●○○ 180ms/)
  assert.match(plain(runtimeStrip(stripInput({ link: { ...LINK, rttMs: 420 } }), 200)), /SSH ●○○○ 420ms/)
  // An unprobed SSH link keeps the empty pips — `unknown` is the honest level —
  // and says it was never measured instead of printing the paint cadence where a
  // round-trip goes. Reported from the field: xterm over SSH, a terminal that
  // mostly does not answer DSR, sat on `SSH ○○○○ 160ms` for whole sessions and
  // read it as "my link is 160ms" rather than "nothing was measured".
  assert.match(
    plain(runtimeStrip(stripInput({ link: { kind: 'ssh', intervalMs: 160, probed: false } }), 200)),
    /SSH ○○○○ 未测/,
  )
  // A measured link still reports the measurement, unchanged.
  assert.match(
    plain(runtimeStrip(stripInput({ link: { kind: 'ssh', intervalMs: 160, probed: true, rttMs: 4 } }), 200)),
    /SSH ●●●● 4ms/,
    'a measured link reports the measurement',
  )
})

test('a local terminal has no link health to report', () => {
  const row = plain(runtimeStrip(stripInput({ link: { kind: 'local', intervalMs: 80, probed: false } }), 200))
  assert.match(row, /^本地 80ms/, 'the local label, not `SSH`: no round-trip is claimed')
  assert.equal(row.includes('○'), false, 'and no hollow pips either')
})

test('the activity chip names what is happening, with its clock', () => {
  const now = Date.now()
  assert.equal(
    activityMeter({ kind: 'tools', text: 'edit', startedAt: now - 28_000, now }, '⠹'),
    '⠹ edit · 28s',
  )
  assert.equal(
    activityMeter({ kind: 'agent', text: '代理', startedAt: now - 192_000, now }, '⠹'),
    '⠹ 代理 · 3m12s',
  )
  assert.equal(activityMeter({ kind: 'waiting', text: '等待回答' }, '⠹'), '等待回答')
  // A state with no honest clock gets none: the chip does not borrow a number
  // that measures something else.
  assert.equal(activityMeter({ kind: 'plan-pending', text: '计划切换中' }, '⠹'), '计划切换中')
  // The elapsed form is the whole reason the clock exists: it is the only place
  // the user learns how long the current action has been running.
  assert.equal(activityMeter({ kind: 'reply', text: '回复中' }, '⠹'), '⠹ 回复中', 'no clock, no suffix')
})

test('the elapsed form is compact, and never says "now" forever', () => {
  assert.equal(formatElapsedShort(0), '0s')
  assert.equal(formatElapsedShort(28_400), '28s')
  assert.equal(formatElapsedShort(60_000), '1m00s')
  assert.equal(formatElapsedShort(192_000), '3m12s')
  assert.equal(formatElapsedShort(3_900_000), '1h05m')
})

test('the activity chip drops its glyph before its clock, and never names the command', () => {
  const now = Date.now()
  const activity = { kind: 'tools', text: 'terminal', startedAt: now - 28_000, now }
  // The verb and its clock, and nothing else: *which* command (and on which
  // path) is the transcript card's job one line up. A command here spent the
  // row's cells on its least load-bearing part — `pytest -x tests/ --maxfail=1`
  // pushed the quota and context meters towards the drop edge.
  assert.equal(activityMeter(activity, '⠹', 0), '⠹ terminal · 28s')
  // The clock outlives the glyph: motion is already implied by the verb, while
  // "how long" is a fact the reader came for.
  assert.equal(activityMeter(activity, '⠹', 7), 'terminal · 28s')
  assert.equal(activityMeter(activity, '⠹', 9), 'terminal')
  assert.equal(activityMeter(activity, '⠹', 14), '')
})

test('an idle row stops saying "idle" before it stops saying anything else', () => {
  assert.equal(activityMeter({ kind: 'idle', text: '空闲' }, '⠹', 0), '空闲')
  assert.equal(activityMeter({ kind: 'idle', text: '空闲' }, '⠹', 10), '')
  // A working state keeps its verb well past that.
  assert.equal(activityMeter({ kind: 'tools', text: 'edit' }, '⠹', 10), 'edit')
})

// ── terminal modes ────────────────────────────────────────────────────────

test("the ASCII row is the same row, in the project's fallback glyphs", () => {
  const unicode = runtimeStrip(stripInput(), 200, ' · ', '⠹')
  const ascii = runtimeStrip(stripInput({ ascii: true }), 200, ' · ', '⠹')
  assert.equal(
    plain(ascii),
    'SSH **** 31ms · 空闲 · 158 tok/s · 5Hr #######. 82% · CTX #####... 61% · 610K/1M · Tok 36.8M',
  )
  assert.equal(
    visibleWidth(unicode),
    visibleWidth(ascii),
    'the fallback is a glyph swap, not a width change',
  )
})

test('a no-colour row has no escapes at all, and keeps the same text', () => {
  const row = runtimeStrip(stripInput({ color: false, depth: 'none' }), 200, ' │ ', '⠹')
  assert.equal(row.includes('\x1b'), false)
  assert.equal(row, plain(runtimeStrip(stripInput({ color: true, depth: 'truecolor' }), 200, ' │ ', '⠹')))
})

test('colour lands on the pips, the filled bar and the percentage — not the row', () => {
  const row = runtimeStrip(stripInput({ quota: { remainingPercent: 9, period: 'hourly' } }), 200, ' │ ', '⠹')
  // The link is healthy, so its pips carry the `ok` accent as one run...
  assert.match(row, /SSH \x1b\[2;32m●●●●\x1b\[0m/, 'the pips are painted as one run')
  // ...while the nine-percent window is the `over` band, and only the cells that
  // carry the reading are painted: the filled run and the number.
  assert.match(row, /5Hr \x1b\[31m█\x1b\[0m░░░░░░░ \x1b\[31m9%\x1b\[0m/)
  assert.equal(stripAnsi(row), plain(row))
  // Tokens per second is neutral telemetry: nothing opens a colour between the
  // previous reset and the number itself.
  const at = row.indexOf('158 tok/s')
  const sinceReset = row.slice(row.lastIndexOf('\x1b[0m', at) + 4, at)
  assert.equal(sinceReset.includes('\x1b'), false, `no colour before the speed: ${JSON.stringify(sinceReset)}`)
})

test('a downgraded terminal gets the nearest hue, not a truecolor sequence', () => {
  const row = runtimeStrip(stripInput({ quota: { remainingPercent: 9, period: 'hourly' }, depth: '8' }), 200)
  assert.equal(/\x1b\[38;2;/u.test(row), false, 'no 24-bit colour on an 8-colour terminal')
  assert.match(row, /\x1b\[31m/, 'the red survives as the basic red')
})

// ── /status keeps what the row gave up ────────────────────────────────────

test('/status prints the telemetry the default row no longer carries', () => {
  const stats = statsRowOf({
    turns: 3,
    steps: 12,
    llmMs: 80_000,
    toolMs: 8_400,
    ttftMs: 1_200,
    ttftSteps: 1,
    decodeMs: 12_000,
    decodeTokens: 1_900,
    lastDecodeMs: 2_000,
    lastDecodeTokens: 316,
    settledDecodeMs: 12_000,
    settledDecodeTokens: 1_900,
    usage: {
      inputTokens: 6_100,
      outputTokens: 640,
      reportedTokens: 30_000,
      reportedSteps: 3,
      unreportedSteps: 0,
      cacheReadTokens: 12_100,
      cacheWriteTokens: 0,
    },
  })
  const text = formatStatusStats(stats).join('\n')
  for (const needle of ['turns: 3', 'steps: 12', 'cache: hit', 'model time:', 'tool time:', 'ttft:', 'total 30K']) {
    assert.ok(text.includes(needle), `${needle} is still reported:\n${text}`)
  }
  assert.match(formatStatusThroughput({ settledRate: 158.4, liveChars: 0, fresh: false }), /tokens\/sec: 158/)
  assert.match(
    formatStatusThroughput({ settledRate: 158.4, liveChars: 1_200, liveRate: 162.6, fresh: true }),
    /~163 live/,
  )
  assert.match(formatStatusThroughput({ liveChars: 0, fresh: false }), /no settled step yet/)
})

test('the activity state vocabulary covers the states the row has to answer', () => {
  const base = {
    running: true, planReview: false, waitingQuestion: false, compacting: false,
    subagents: 0, tools: 0, planLeftOpen: false, planPending: false, planActive: false, idleMs: 0,
    foldedInput: false, multiLineInput: false, queued: 0,
  }
  assert.equal(footerActivity(base).kind, 'idle', 'running with no output yet is 运行中')
  assert.equal(footerActivity(base).text, '运行中')
  assert.equal(footerActivity({ ...base, streamingReasoning: true }).kind, 'thinking')
  assert.equal(footerActivity({ ...base, streamingText: true }).kind, 'reply')
  assert.equal(footerActivity({ ...base, streamingText: true, streamingReasoning: true }).kind, 'reply')
  assert.equal(footerActivity({ ...base, tools: 1, toolLabel: 'edit' }).text, 'edit')
  assert.equal(footerActivity({ ...base, tools: 2 }).text, '工具 2')
  assert.equal(footerActivity({ ...base, subagents: 1 }).text, '代理')
  assert.equal(footerActivity({ ...base, subagents: 1 }).kind, 'agent')
  assert.equal(
    footerActivity({ ...base, tools: 1, toolLabel: 'edit', subagents: 2 }).kind,
    'agent',
    'a child outranks a tool',
  )
  assert.equal(footerActivity({ ...base, waitingQuestion: true }).kind, 'waiting')
  assert.equal(footerActivity({ ...base, compacting: true }).kind, 'compacting')
  assert.equal(footerActivity({ ...base, retry: { retry: 2, maxRetries: 5 } }).kind, 'retry')
  assert.equal(footerActivity({ ...base, idleMs: 9_000 }).kind, 'waiting-llm')
})
