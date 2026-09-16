#!/usr/bin/env node
/**
 * Render the footer chrome to PNG and check the cells a terminal would show.
 *
 * Why this exists: B-1 rebuilt the status strip out of styled chips and fitted
 * them with a plain-text truncator, which stripped each accent's `ESC` and left
 * its `[32m` body on the grid. Every unit test passed — they fed the fitter
 * unstyled chips — and the leak was only visible on a rendered frame. So the
 * footer now has a rendered artifact, and the frame itself is asserted:
 *
 * - no row may contain an escape *body* (`[32m`, `[0m`) without its `ESC`;
 * - the strip keeps the muted footer style around the accents;
 * - the quota bar and the context ring sit on the identity line, after the
 *   model, where a user looks for them (B-1 moved them to the strip, which read
 *   as "额度条没了").
 *
 * Usage: node scripts/capture-footer-frames.mjs [--out DIR] [--check-only]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { SshTui, padAnsiToWidth } from '../lib/tui.js'
import { formatLinkQualityChip } from '../lib/paint.js'
import { stripAnsi, visibleWidth } from '../lib/term-text.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const CHECK_ONLY = argv.includes('--check-only')
const outIndex = argv.indexOf('--out')
const OUT_DIR = outIndex >= 0 && argv[outIndex + 1] !== undefined
  ? argv[outIndex + 1]
  : join(ROOT, 'docs', 'screenshots')

/** SGR-looking text that lost its `ESC`: the signature of this whole bug class. */
const ESCAPE_BODY_RE = /\[(?:\d{1,3}(?:;\d{1,3})*)?m/u
const RING_RE = /[⣀⠉⠋⠛⠞⠟⠿⡿⣿]/u

function mockAgent(provider = 'xai', model = 'grok-4.6') {
  return {
    id: 'main-session',
    options: { provider, model, reasoningEffort: 'xhigh' },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
}

function makeTui({ roster = true, quota = true, windows, provider = 'xai', model = 'grok-4.6' } = {}) {
  process.env.TERM = 'xterm-256color'
  process.env.DSH_TUI_COLOR_DEPTH = 'truecolor'
  delete process.env.NO_COLOR
  const ctx = { get: name => (roster && name === 'agentPresets' ? {} : undefined), on() { return () => {} } }
  const tui = new SshTui(ctx, mockAgent(provider, model), {
    sessionId: 'main-session',
    color: true,
    provider,
    presetId: 'standard',
    presetName: '标准模式',
    selectionRef: { current: { provider, model, reasoningEffort: 'xhigh' } },
    subagentSelection: { current: { model: 'grok-4.5' } },
  })
  tui.rows.splice(0, tui.rows.length)
  seedStats(tui)
  if (quota) {
    // Shapes below are the real ones: SuperGrok reports a weekly window only,
    // OpenCode Go reports 5-hour/weekly/monthly, Command Code reports
    // 5-hour/weekly plus a monthly credit pool (measured 2026-09-16).
    tui.quotaSnapshot = windows ?? {
      provider: 'xai', plan: 'SuperGrok', source: 'supergrok',
      windows: [{ label: '本周', period: 'weekly', remainingPercent: 82 }],
    }
  }
  tui.contextPressure = { usedTokens: 120_000, contextWindow: 200_000, percent: 60, level: 'ok' }
  tui.paintLink = 'ssh'
  tui.paintProbed = true
  tui.paintRttMs = 90
  tui.paintIntervalMs = 1000
  tui.status = 'idle'
  tui.input = '把底栏的乱码修掉，额度条挪回原位。'
  tui.cursor = tui.input.length
  return tui
}

/**
 * Drive the real tracker, not a hand-written snapshot: the strip's groups come
 * from `statsTracker.snapshot()`, and assigning `tui.stats` would have shown a
 * footer no session ever produces.
 */
function seedStats(tui) {
  const tracker = tui.statsTracker
  const start = Date.now() - 60_000
  for (let step = 1; step <= 5; step++) {
    const at = start + step * 9_000
    tracker.noteStepStart(step <= 3 ? 1 : 2, step, at - 4_000)
    tracker.noteFirstToken(step <= 3 ? 1 : 2, step, at - 3_400)
    tracker.recordUsage(step <= 3 ? 1 : 2, step, {
      inputTokens: 46_000, outputTokens: 2_400, cacheReadTokens: 20_000, cacheWriteTokens: 6_000,
    })
    tracker.noteToolStart(`call-${step}`, at - 1_200)
    tracker.noteToolEnd(`call-${step}`, at)
    tracker.settleMessage({
      turn: step <= 3 ? 1 : 2, step, time: at, firstTokenTime: at - 3_400, outputTokens: 2_400,
    })
    tracker.noteStepEnd(step <= 3 ? 1 : 2, step)
  }
}

/**
 * Widths are measured from a wide render, not hand-picked: an i18n change must
 * not turn a layout contract into a stale magic number. The identity line is
 * `activity + preset + cwd + model + quota + sub`, the quota trades its plan
 * name for the bare bar when the row is tight, and below the bar's own width
 * the quota is dropped (the drop order that predates the strip).
 */
const probe = makeTui({})
const probeShot = footerRows(probe, 400, 26)
const probeLine = (probeShot.plain[probeShot.identityIndex] ?? '').trimEnd()
// What the strip shows when nothing can be lost. The tight case below asks for
// exactly that row one cell wider than it needs: a fitter that measures a styled
// chip by its escapes spends those cells on invisible characters and quietly
// drops a counter group instead.
const fullStrip = (probeShot.plain[probeShot.stripIndex] ?? '').trimEnd()
const stripWidth = visibleWidth(fullStrip)
// Cells, not UTF-16 units: a CJK label is one unit and two cells.
const fullWidth = visibleWidth(probeLine)
const quotaAt = probeLine.indexOf(' · SuperGrok ')
const baseWidth = quotaAt < 0 ? fullWidth : visibleWidth(probeLine.slice(0, quotaAt))
const barWidth = fullWidth - visibleWidth('SuperGrok ')

const CASES = [
  { name: 'footer-wide', cols: fullWidth + 2, rows: 26, options: { quota: 'plan' } },
  { name: 'footer-mid', cols: barWidth + 2, rows: 26, options: { quota: 'bar' } },
  { name: 'footer-narrow', cols: baseWidth + 2, rows: 26, options: { quota: 'gone' } },
  { name: 'footer-roster-missing', cols: fullWidth + 4, rows: 26, options: { roster: false, quota: 'plan' } },
  { name: 'footer-strip-tight', cols: stripWidth + 1, rows: 26, options: { identity: false, quota: 'plan', completeStrip: true } },
  {
    name: 'footer-quota-supergrok', cols: 130, rows: 26, options: { badge: 'SuperGrok 1Wk' },
  },
  // Just too narrow for the badge: the window tag must survive it, because the
  // number means nothing without the window it belongs to.
  // A provider that carries the vendor in the model id: the status line shows
  // the model, not the route.
  // The first frames of a session: the provider has a quota surface but no
  // reading has landed, so the widget is an empty bar and a `?` — never `0%`.
  {
    name: 'footer-quota-pending', cols: 130, rows: 26, options: { quota: false, placeholder: true },
  },
  {
    name: 'footer-model-route', cols: 130, rows: 26,
    options: { model: 'xai/grok-4.6', expectModel: 'grok-4.6 xhigh', absent: 'xai/grok-4.6' },
  },
  {
    name: 'footer-quota-narrow', cols: fullWidth - visibleWidth('SuperGrok '), rows: 26,
    options: { quota: 'bar', badgeDrop: true },
  },
  {
    name: 'footer-quota-ocgo', cols: 130, rows: 26,
    options: {
      provider: 'opencode',
      // OpenCode Go's three windows, with the monthly one tightest: the footer
      // must still show the 5-hour window.
      windows: {
        provider: 'opencode', plan: 'OpenCode Go', source: 'opencode-go',
        windows: [
          { label: '本月', period: 'monthly', remainingPercent: 12 },
          { label: '本周', period: 'weekly', remainingPercent: 47 },
          { label: '滚动 5 小时', period: 'hourly', remainingPercent: 91 },
        ],
      },
      badge: 'OC·GO 5Hr',
    },
  },
  {
    name: 'footer-quota-ccgoat', cols: 130, rows: 26,
    options: {
      provider: 'command-code',
      windows: {
        provider: 'command-code', plan: 'GOAT', source: 'command-code',
        // Measured from the live billing reply: 5h 94.2%, weekly 76.3%,
        // monthly credit pool 88.1% ($61.69).
        windows: [
          { label: '额度余额', period: 'monthly', remainingPercent: 88.1, detail: '$61.69' },
          { label: '本周', period: 'weekly', remainingPercent: 76.3 },
          { label: '滚动 5 小时', period: 'hourly', remainingPercent: 94.2 },
        ],
      },
      badge: 'CC·GOAT 5Hr',
    },
  },
]

/**
 * The two chrome rows, found by position: the identity line is always the last
 * painted row and the strip the one above it. Finding them by the link chip's
 * text made the check pass in an SSH session and fail on a machine without one,
 * where the same chip reads `本机`/`Local`.
 */
function footerRows(tui, cols, rows) {
  const frame = tui.captureFrame(cols, rows).map(line => padAnsiToWidth(line ?? '', cols))
  const plain = frame.map(line => stripAnsi(line))
  const identityIndex = plain.length - 1
  const stripIndex = plain.length - 2
  return { frame, plain, stripIndex, identityIndex }
}

function check(tui, name, cols, { frame, plain, stripIndex, identityIndex }, options) {
  const identityExpected = options.identity !== false
  const problems = []
  for (const [index, line] of frame.entries()) {
    if (ESCAPE_BODY_RE.test(stripAnsi(line))) {
      problems.push(`row ${index} shows an escape body: ${JSON.stringify(stripAnsi(line).slice(0, 90))}`)
    }
    if (stripAnsi(line).length > 0 && line.length === 0) problems.push(`row ${index} vanished`)
    if (plain[index].length > cols) problems.push(`row ${index} is ${plain[index].length} cells wide, terminal is ${cols}`)
  }
  const strip = plain[stripIndex] ?? ''
  const identity = plain[identityIndex] ?? ''
  if (stripIndex < 0) problems.push('the status strip row is missing')
  if (identityExpected && identityIndex < 0) problems.push('the identity row is missing')
  if (options.completeStrip === true && strip.trimEnd() !== fullStrip) {
    problems.push(`a group was lost on a row with room for all of them: ${JSON.stringify(strip.trimEnd())}`)
  }
  // The strip keeps the muted style; losing it turned the whole footer white.
  if (stripIndex >= 0 && !frame[stripIndex].includes('\x1b[90m')) problems.push('the strip lost its muted style')
  // The link chip keeps the default foreground and leads, unless the roster
  // warning outranks it. The chip's own text comes from the painter's function,
  // so this holds on a machine with no SSH environment too.
  const chip = stripAnsi(formatLinkQualityChip(tui.paintLink, tui.paintIntervalMs, tui.paintRttMs, tui.paintProbed, false))
  if (stripIndex >= 0 && options.roster !== false && !strip.startsWith(chip)) {
    problems.push(`the link chip no longer leads the strip: ${JSON.stringify(strip)}`)
  }
  // The ring belongs to the identity line, one row down, together with the
  // quota: it is dropped with it when the row cannot even hold the bar.
  if (stripIndex >= 0 && RING_RE.test(strip)) problems.push('the context ring moved back onto the strip')
  const wantedRing = (options.quota ?? 'plan') !== 'gone'
  if (identityExpected && identityIndex >= 0 && wantedRing && !RING_RE.test(identity)) {
    problems.push(`the context ring left the identity line: ${JSON.stringify(identity)}`)
  }
  // Quota stays on the identity line, after the model, before the sub route.
  const barAt = identity.search(/[█░]{8} \d+%/u)
  const quotaAt = barAt < 0 ? -1 : barAt
  const modelAt = identity.indexOf('grok-4.6 xhigh')
  const subAt = identity.indexOf('sub:')
  // `quota: false` means "this case makes no claim about the widget" (the
  // pending case asserts the placeholder instead); `??` would treat it as set.
  const wanted = options.quota === undefined ? 'plan' : options.quota
  if (!identityExpected || wanted === false) {
    // no identity contract for this width
  } else if (wanted === 'gone') {
    if (quotaAt >= 0) problems.push(`the quota bar must be dropped at ${cols} cells, not reshuffled: ${JSON.stringify(identity)}`)
  } else if (quotaAt < 0) {
    problems.push(`the quota bar left the identity line: ${JSON.stringify(identity)}`)
  } else {
    if (quotaAt < modelAt) problems.push('the quota bar moved ahead of the model')
    if (subAt >= 0 && quotaAt > subAt) problems.push('the quota bar moved behind the subagent route')
    // The badge is per billing surface: SuperGrok / OC·GO / CC·GOAT.
    const planName = identity.includes((options.badge ?? 'SuperGrok').split(' ')[0])
    if (wanted === 'plan' && !planName) problems.push('the plan name was dropped although the row has room for it')
    if (wanted === 'bar' && planName && options.badgeDrop !== true) {
      problems.push('the plan name survived a row that only fits the bar')
    }
  }
  if (strip.includes('SuperGrok') || /[█░]{8} \d+%/u.test(strip)) problems.push('the quota bar is on the strip')
  if (options.expectModel !== undefined && !identity.includes(options.expectModel)) {
    problems.push(`the status line lost the model "${options.expectModel}": ${JSON.stringify(identity)}`)
  }
  if (options.absent !== undefined && identity.includes(options.absent)) {
    problems.push(`"${options.absent}" should not be on the status line: ${JSON.stringify(identity)}`)
  }
  if (options.placeholder === true) {
    if (!/[░]{8} \?%/u.test(identity)) problems.push(`the placeholder is missing: ${JSON.stringify(identity)}`)
    // Only a number attached to a bar counts: the context chip's own `60%` is
    // a different reading and is expected to be there.
    if (/[█░]{8} \d+%/u.test(identity)) problems.push(`a number was invented before any reading: ${JSON.stringify(identity)}`)
    if (strip.includes('?%')) problems.push('the placeholder belongs on the identity line')
  }
  if (options.badgeDrop === true) {
    const badgeName = (options.badge ?? 'SuperGrok').split(' ')[0]
    if (identity.includes(badgeName)) problems.push(`the badge survived a row that must trade it: ${JSON.stringify(identity)}`)
    if (!/(?:5Hr|1Wk|1Mo)/u.test(identity)) problems.push(`the window tag went with the badge: ${JSON.stringify(identity)}`)
  }
  // The plan badge and window tag: `SuperGrok 5Hr`, `OC·GO 1Mo`, `CC·GOAT 5Hr`.
  if (options.badge !== undefined && !identity.includes(options.badge)) {
    problems.push(`the quota badge lost "${options.badge}": ${JSON.stringify(identity)}`)
  }
  if (options.roster === false && !strip.includes('⚠')) problems.push('a missing roster lost its ⚠')
  return problems
}

function renderPng(name, caption) {
  const result = spawnSync('python3', [
    join(ROOT, 'scripts', 'ansi-to-png.py'),
    join(OUT_DIR, `${name}.ansi.txt`),
    join(OUT_DIR, `${name}.png`),
    caption,
  ], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`ansi-to-png failed for ${name}`)
}

await mkdir(OUT_DIR, { recursive: true })
let failed = 0
for (const testCase of CASES) {
  const tui = makeTui(testCase.options)
  const shot = footerRows(tui, testCase.cols, testCase.rows)
  const problems = check(tui, testCase.name, testCase.cols, shot, testCase.options)
  if (!CHECK_ONLY) {
    await writeFile(join(OUT_DIR, `${testCase.name}.ansi.txt`), `${shot.frame.join('\n')}\n`)
    renderPng(testCase.name, '')
  }
  const strip = shot.plain[shot.stripIndex] ?? ''
  const identity = shot.plain[shot.identityIndex] ?? ''
  console.log(`${testCase.name} (${testCase.cols} cols)`)
  console.log(`  strip:    ${strip.trimEnd()}`)
  console.log(`  identity: ${identity.trimEnd()}`)
  if (problems.length > 0) {
    failed += 1
    for (const problem of problems) console.error(`  FAIL ${problem}`)
  } else {
    console.log('  ok: no escape bodies, quota on the identity line, muted strip')
  }
}

if (failed > 0) {
  console.error(`RESULT: FAIL (${failed} of ${CASES.length} footer frames)`)
  process.exit(1)
}
console.log(`RESULT: PASS (${CASES.length} footer frames${CHECK_ONLY ? '' : `, PNGs in ${OUT_DIR}`})`)
