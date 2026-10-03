#!/usr/bin/env node
/**
 * Render the footer chrome to PNG and check the cells a terminal would show.
 *
 * Why this exists: B-1 rebuilt the status strip out of styled chips and fitted
 * them with a plain-text truncator, which stripped each accent's `ESC` and left
 * its `[32m` body on the grid. Every unit test passed — they fed the fitter
 * unstyled chips — and the leak was only visible on a rendered frame. So the
 * footer has a rendered artifact, and the frame itself is asserted.
 *
 * The E pass reorganised what that frame is: one status row answering link /
 * activity / speed / quota / context, one workspace row of metadata, and the
 * session counters (turns, steps, model time, tool time, cache hit) gone from
 * both. Those are the contracts checked below, at the widths a real terminal
 * takes, because the *rendered* row is the only place they are all visible at
 * once.
 *
 * Usage: node scripts/capture-footer-frames.mjs [--out DIR] [--check-only]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { SshTui, padAnsiToWidth } from '../lib/tui.js'
import { formatLinkQualityChip } from '../lib/paint.js'
import { resetAsciiChrome, stripAnsi, visibleWidth } from '../lib/term-text.js'
import { setLocale } from '../lib/i18n/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const CHECK_ONLY = argv.includes('--check-only')
const outIndex = argv.indexOf('--out')
const OUT_DIR = outIndex >= 0 && argv[outIndex + 1] !== undefined
  ? argv[outIndex + 1]
  : join(ROOT, 'docs', 'screenshots')

setLocale('zh')

/** SGR-looking text that lost its `ESC`: the signature of this whole bug class. */
const ESCAPE_BODY_RE = /\[(?:\d{1,3}(?:;\d{1,3})*)?m/u
/**
 * The Braille context ring. It is not on either footer row any more.
 *
 * Two glyphs, not one: a ring is a *metre* (`⣿⣿⣀⣀`), while the activity spinner
 * is a single Braille frame that shares the block — `⠋` is both a spinner frame
 * and a ring glyph, so a one-glyph pattern failed this check roughly one run in ten
 * depending on which frame the clock landed on.
 */
const RING_RE = /[⣀⠉⠋⠛⠞⠟⠿⡿⣿]{2}/u
/** Eight filled/hollow cells followed by a percentage: a capacity meter. */
const METER_RE = /[█░#.]{5,8} \d+%/u
/** The counters this pass removed from the default row. */
const RETIRED_COUNTERS = ['轮 ·', '步', '缓存命中', 'cache hit', '模型 ', '工具 ']

function mockAgent(provider = 'xai', model = 'grok-4.6') {
  return {
    id: 'main-session',
    options: { provider, model, reasoningEffort: 'xhigh' },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
}

function makeTui({
  roster = true,
  quota = true,
  windows,
  provider = 'xai',
  model = 'grok-4.6',
  activity,
  live = false,
  color = true,
} = {}) {
  process.env.TERM = 'xterm-256color'
  process.env.DSH_TUI_COLOR_DEPTH = 'truecolor'
  delete process.env.NO_COLOR
  deletedKeys.forEach(key => delete process.env[key])
  if (activity === 'ascii') process.env.DSH_TUI_ASCII = '1'
  // The glyph-set decision is cached for the life of a frame sequence (reading it
  // per cell would re-parse the locale on every glyph), so a case that changes it
  // has to say so before the next paint.
  resetAsciiChrome()
  const ctx = { get: name => (roster && name === 'agentPresets' ? {} : undefined), on() { return () => {} } }
  const tui = new SshTui(ctx, mockAgent(provider, model), {
    sessionId: 'main-session',
    color,
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
    // 5-hour/weekly plus a monthly credit pool (measured 2026-09-16). The
    // default fixture is a 5-hour window, the one a working session hits first.
    tui.quotaSnapshot = windows ?? {
      provider: 'xai', plan: 'SuperGrok', source: 'supergrok',
      windows: [{ label: '滚动 5 小时', period: 'hourly', remainingPercent: 82 }],
    }
  }
  tui.paintLink = 'ssh'
  tui.paintProbed = true
  tui.paintRttMs = 90
  tui.paintIntervalMs = 1000
  tui.status = 'idle'
  tui.input = '把底栏的乱码修掉，额度条挪回原位。'
  tui.cursor = tui.input.length
  if (activity === 'tool') {
    tui.agent.status = 'running'
    tui.handleSessionEvent(tui.agent.session, {
      type: 'tool/call',
      time: Date.now(),
      data: {
        turn: 3, step: 3, callId: 'call-live', name: 'bold-edit-tool',
        arguments: JSON.stringify({ command: 'npm run build' }),
      },
    })
    tui.statsTracker.noteToolStart('call-live', Date.now() - 28_000)
    tui.lastActivity = Date.now() - 4_000
  }
  if (live) {
    tui.agent.status = 'running'
    const now = Date.now()
    const span = 4_000
    tui.handleSessionEvent(tui.agent.session, { type: 'turn/start', time: now - span, data: { turn: 4 } })
    tui.handleSessionEvent(tui.agent.session, { type: 'step/start', time: now - span, data: { turn: 4, step: 1 } })
    for (let index = 0; index < 24; index++) {
      tui.handleAssistantStream({
        agent: tui.agent,
        frame: {
          type: 'chunk',
          attemptId: 'a1',
          revision: 1,
          index,
          time: now - span + (span * index) / 23,
          chunk: { type: 'text-delta', index: 0, text: '字'.repeat(20) },
        },
      })
    }
  }
  // Last: a live event recomputes the pressure from usage, and this fixture has
  // no model window for it to find.
  tui.contextPressure = { usedTokens: 120_000, contextWindow: 200_000, percent: 60, level: 'ok' }
  return tui
}

/** Env keys a case may set, cleared before each TUI so cases cannot leak. */
const deletedKeys = ['DSH_TUI_ASCII']

/**
 * Drive the real tracker, not a hand-written snapshot: the row's numbers come
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
      totalTokens: 74_400,
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
 * The two chrome rows, found by position: the workspace row is always the last
 * painted row and the status row the one above it. Finding them by the link
 * chip's text made the check pass in an SSH session and fail on a machine
 * without one, where the same chip reads `本地`/`local`.
 */
function footerRows(tui, cols, rows) {
  const frame = tui.captureFrame(cols, rows).map(line => padAnsiToWidth(line ?? '', cols))
  const plain = frame.map(line => stripAnsi(line))
  return {
    frame,
    plain,
    statusIndex: plain.length - 2,
    identityIndex: plain.length - 1,
  }
}

const CASES = [
  // The width series. The exact row at each width is pinned by
  // `tests/footer-strip.test.mjs`; what this frame check adds is the rendered
  // pixel contract — no escape bodies, nothing wider than the terminal, and the
  // monotone loss of cells as it narrows.
  { name: 'footer-160', cols: 160, rows: 26, options: { expectIdentity: 'sub:' } },
  { name: 'footer-120', cols: 120, rows: 26, options: { expectIdentity: 'sub:' } },
  { name: 'footer-100', cols: 100, rows: 26, options: { total: true } },
  { name: 'footer-88', cols: 88, rows: 26, options: { total: false } },
  { name: 'footer-72', cols: 72, rows: 26, options: { total: false } },
  { name: 'footer-60', cols: 60, rows: 26, options: { total: false, measures: 'percent' } },
  { name: 'footer-48', cols: 48, rows: 26, options: { total: false, measures: 'percent', bars: false } },
  { name: 'footer-40', cols: 40, rows: 26, options: { total: false, measures: 'percent', bars: false, shortLabels: true } },
  // The link at each health band, so the pips are checked where they are read.
  {
    name: 'footer-link-degraded', cols: 120, rows: 26,
    options: { rttMs: 180, expectPips: '●●○○' },
  },
  {
    name: 'footer-link-poor', cols: 120, rows: 26,
    options: { rttMs: 420, expectPips: '●○○○' },
  },
  // A quota surface with no reading yet: a hollow bar and `?`, never `0%`.
  { name: 'footer-quota-pending', cols: 120, rows: 26, options: { quota: false, placeholder: true } },
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
      expectWindow: '5Hr',
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
      expectWindow: '5Hr',
    },
  },
  {
    name: 'footer-quota-critical', cols: 120, rows: 26,
    options: {
      windows: {
        provider: 'xai', plan: 'SuperGrok', source: 'supergrok',
        windows: [{ label: '滚动 5 小时', period: 'hourly', remainingPercent: 9 }],
      },
      expectAccent: '\x1b[31m',
    },
  },
  // What is happening, with its clock: the pass' whole second question.
  {
    name: 'footer-running-tool', cols: 120, rows: 26,
    // A tool that is running has decoded nothing this step: the speed chip has no
    // number and is allowed to leave rather than print a stale one.
    options: { activity: 'tool', expectSpeed: false, expectActivity: 'bold-edit-tool' },
  },
  { name: 'footer-running-live', cols: 120, rows: 26, options: { live: true } },
  // The install warning still outranks everything and still leads the row.
  { name: 'footer-roster-missing', cols: 60, rows: 26, options: { roster: false } },
  // Terminal modes: the same row in the project's ASCII glyph table, and with
  // no colour at all.
  { name: 'footer-ascii', cols: 120, rows: 26, options: { activity: 'ascii', ascii: true } },
  { name: 'footer-nocolor', cols: 120, rows: 26, options: { color: false, noColor: true } },
]

function check(tui, name, cols, { frame, plain, statusIndex, identityIndex }, options) {
  const problems = []
  const want = (condition, message) => { if (!condition) problems.push(message) }
  for (const [index, line] of frame.entries()) {
    if (ESCAPE_BODY_RE.test(stripAnsi(line))) {
      problems.push(`row ${index} shows an escape body: ${JSON.stringify(stripAnsi(line).slice(0, 90))}`)
    }
    if (stripAnsi(line).length > 0 && line.length === 0) problems.push(`row ${index} vanished`)
    if (plain[index].length > cols) problems.push(`row ${index} is ${plain[index].length} cells wide, terminal is ${cols}`)
  }
  const status = plain[statusIndex] ?? ''
  const identity = plain[identityIndex] ?? ''
  want(statusIndex >= 0, 'the status row is missing')
  want(identityIndex >= 0, 'the workspace row is missing')
  want(status.trim() !== '', 'the status row is blank')

  // ── the row leads with its link chip, muted, accents inside ─────────────
  // Whether this install is missing rows is a property of the machine, not of the
  // fixture (on 0.1.7 the check reads the profile patch, not the presets
  // service), so the expectation follows what the TUI decided for itself rather
  // than asserting a state the environment may not have.
  if (tui.rosterMissing !== true) {
    // The chip's own text comes from the painter's function, so this holds on a
    // machine with no SSH environment too. `formatLinkQualityChip` renders the
    // pips and the delay; the status row's own form is the same at level 0.
    const chip = stripAnsi(formatLinkQualityChip(tui.paintLink, tui.paintIntervalMs, tui.paintRttMs, tui.paintProbed, false))
    // On an ASCII row the pips are the fallback glyphs, so the label and the
    // measured delay are what has to match — the chip's own text comes from the
    // painter's function, which is what keeps this honest on a machine with no
    // SSH environment too.
    const delay = chip.slice(chip.lastIndexOf(' ') + 1)
    want(status.startsWith('SSH ') || status.startsWith('本地 ') || status.startsWith('local '),
      `the status row does not lead with the link: ${JSON.stringify(status)}`)
    want(/^\S+ (?:[*o●○]{4}|\S+) /u.test(status) || status.includes(delay),
      `the link chip is malformed: ${JSON.stringify(status)}`)
    want(status.includes(delay), `the link delay (${delay}) left the chip: ${JSON.stringify(status)}`)
  } else {
    want(status.includes('⚠'), 'the broken-install warning left the status row')
    want(status.indexOf('⚠') < status.indexOf('SSH'), 'the warning no longer outranks the link')
  }
  if (options.expectActivity !== undefined) {
    want(status.includes(options.expectActivity), `the activity chip is missing: ${JSON.stringify(status)}`)
  }
  if (options.noColor !== true) {
    want(frame[statusIndex].includes('\x1b[90m'), 'the status row lost its muted style')
  } else {
    // A painted row always ends with the painter's own reset; what a no-colour
    // terminal must not receive is any *style* sequence.
    const styles = (frame[statusIndex] ?? '').replaceAll('\x1b[0m', '')
    want(!styles.includes('\x1b['), `a no-colour row carries style escapes: ${JSON.stringify(frame[statusIndex])}`)
  }
  if (options.expectPips !== undefined) {
    want(status.includes(options.expectPips), `the pips are not ${options.expectPips}: ${JSON.stringify(status)}`)
  }

  // ── the counters that left the default row really left it ───────────────
  for (const gone of RETIRED_COUNTERS) {
    want(!status.includes(gone), `"${gone}" is still on the status row: ${JSON.stringify(status)}`)
    want(!identity.includes(gone), `"${gone}" is still on the workspace row: ${JSON.stringify(identity)}`)
  }
  // The context ring is gone from both rows: a bar answers "how full", a ring
  // only answered "roughly how full".
  want(!RING_RE.test(status), `the context ring is back on the status row: ${JSON.stringify(status)}`)
  want(!RING_RE.test(identity), `the context ring is on the workspace row: ${JSON.stringify(identity)}`)

  // ── capacity meters are on the status row, not the workspace row ────────
  if (options.quota === false) {
    if (options.placeholder === true) {
      want(/[░.]{5,8} \?%/u.test(status), `the quota placeholder is missing: ${JSON.stringify(status)}`)
      // The context meter's own percentage is a different reading and belongs
      // here; what must not appear is a *quota* meter with a number in it.
      want(!/(?:5Hr|1Wk|1Mo|5h|1w|1m) [█░#.]{5,8} \d+%/u.test(status),
        `a quota number was invented before any reading: ${JSON.stringify(status)}`)
    }
  } else {
    // The full form is a meter; a narrow row legitimately keeps only the reading
    // (`5Hr 82%`), and the narrowest keeps the abbreviated tag. What must never
    // happen is the quota number disappearing while the context one stays.
    const quotaReading = METER_RE.test(status)
      || /(?:5Hr|1Wk|1Mo|5h|1w|1m) \d+%/u.test(status)
    want(quotaReading, `no quota reading on the status row: ${JSON.stringify(status)}`)
  }
  want(!METER_RE.test(identity), `a capacity meter is on the workspace row: ${JSON.stringify(identity)}`)
  // The plan badge is not on the default row: the window tag leads the meter.
  want(!/SuperGrok|OC·GO|CC·GOAT/u.test(status), `the plan badge is on the status row: ${JSON.stringify(status)}`)
  if (options.expectWindow !== undefined) {
    want(status.includes(options.expectWindow), `the finest window (${options.expectWindow}) is not the one shown: ${JSON.stringify(status)}`)
  }
  if (options.measures === 'percent') {
    want(/\d+%/u.test(status), `the quota number went with its bar: ${JSON.stringify(status)}`)
  }
  if (options.bars === false) {
    want(!/[█░]/u.test(status), `a 48-column row still spends cells on bar glyphs: ${JSON.stringify(status)}`)
  }
  if (options.shortLabels === true) {
    want(/5h/u.test(status), `the window tag was not abbreviated: ${JSON.stringify(status)}`)
    want(/ctx/u.test(status), `the context label was not abbreviated: ${JSON.stringify(status)}`)
  }

  // ── the session total ───────────────────────────────────────────────────
  if (options.total === true) {
    want(/Tok [\d.]+[KM]?$/u.test(status.trimEnd()), `the session total is missing: ${JSON.stringify(status)}`)
  }
  if (options.total === false) {
    want(!/Tok /u.test(status), `the session total survived a row without room for it: ${JSON.stringify(status)}`)
  }

  // ── throughput: present, and never graded ───────────────────────────────
  // A running turn nothing has measured yet has no number to show, and the chip
  // is allowed to say so by leaving; every other case must carry one.
  if (options.expectSpeed !== false) {
    want(status.includes('tok/s') || status.includes('t/s'), `tokens per second left the row: ${JSON.stringify(status)}`)
  }
  if (status.includes('tok/s')) {
    const before = frame[statusIndex] ?? ''
    const reset = before.lastIndexOf('\x1b[0m', before.indexOf('tok/s'))
    const segment = reset < 0 ? before.slice(0, before.indexOf('tok/s')) : before.slice(reset + 4, before.indexOf('tok/s'))
    want(!/\x1b\[(?:3[1-9]|9[1-7]|38)/u.test(segment),
      `the tokens-per-second number is accented: ${JSON.stringify(segment)}`)
  }

  // ── the workspace row: metadata only ────────────────────────────────────
  // *Which* part a narrow row gives up is a policy the unit tests pin where the
  // unfitted row is visible (`tests/helpers.test.mjs`: state outlives identity,
  // identity outlives configuration, so the preset the header already prints goes
  // before the working directory and long before a queue count). What a rendered
  // frame can prove is that the row fits, in cells rather than in UTF-16 units.
  const identityWidth = visibleWidth(identity)
  want(
    identityWidth <= cols,
    `the workspace row is ${identityWidth} cells at ${cols}: ${JSON.stringify(identity)}`,
  )
  if (options.expectIdentity !== undefined) {
    want(identity.includes(options.expectIdentity), `the workspace row lost ${JSON.stringify(options.expectIdentity)}: ${JSON.stringify(identity)}`)
  }
  // The header paints the live route permanently, so repeating it here spends
  // the row's cells on the one thing the reader already has.
  want(!identity.includes('grok-4.6'), `the workspace row repeats the header's model: ${JSON.stringify(identity)}`)

  if (options.expectAccent !== undefined && options.noColor !== true) {
    want((frame[statusIndex] ?? '').includes(options.expectAccent),
      `the reading is not painted with its band's accent (${JSON.stringify(options.expectAccent)})`)
  }
  if (options.ascii === true) {
    want(!/[●○█░]/u.test(status), `UTF-8 chrome on an ASCII row: ${JSON.stringify(status)}`)
    want(/[*o]{4}/u.test(status), `the ASCII pips are missing: ${JSON.stringify(status)}`)
  }
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
// Monotone loss: the widths this pass is specified against, in order. A row that
// spends more cells as the terminal narrows is the failure mode the whole
// degradation ladder exists to prevent.
const MONOTONE = ['footer-160', 'footer-120', 'footer-100', 'footer-88', 'footer-72', 'footer-60', 'footer-48', 'footer-40']
const measured = new Map()
for (const testCase of CASES) {
  const tui = makeTui(testCase.options)
  if (testCase.options.rttMs !== undefined) {
    tui.paintRttMs = testCase.options.rttMs
  }
  const shot = footerRows(tui, testCase.cols, testCase.rows)
  const problems = check(tui, testCase.name, testCase.cols, shot, testCase.options)
  measured.set(testCase.name, visibleWidth((shot.plain[shot.statusIndex] ?? '').trimEnd()))
  if (!CHECK_ONLY) {
    await writeFile(join(OUT_DIR, `${testCase.name}.ansi.txt`), `${shot.frame.join('\n')}\n`)
    renderPng(testCase.name, '')
  }
  const status = shot.plain[shot.statusIndex] ?? ''
  const identity = shot.plain[shot.identityIndex] ?? ''
  console.log(`${testCase.name} (${testCase.cols} cols)`)
  console.log(`  status:     ${status.trimEnd()}`)
  console.log(`  workspace:  ${identity.trimEnd()}`)
  if (problems.length > 0) {
    failed += 1
    for (const problem of problems) console.error(`  FAIL ${problem}`)
  } else {
    console.log('  ok: no escape bodies, meters on the status row, counters retired')
  }
}

// The ladder, as cells: each narrower case must spend no more than the wider one.
for (let index = 1; index < MONOTONE.length; index++) {
  const wider = MONOTONE[index - 1]
  const narrower = MONOTONE[index]
  const before = measured.get(wider) ?? 0
  const after = measured.get(narrower) ?? 0
  if (after > before) {
    failed += 1
    console.error(`FAIL ${narrower} spends ${after} cells, more than ${wider}'s ${before}`)
  }
}

if (failed > 0) {
  console.error(`RESULT: FAIL (${failed} of ${CASES.length} footer frames)`)
  process.exit(1)
}
console.log(`RESULT: PASS (${CASES.length} footer frames${CHECK_ONLY ? '' : `, PNGs in ${OUT_DIR}`})`)
