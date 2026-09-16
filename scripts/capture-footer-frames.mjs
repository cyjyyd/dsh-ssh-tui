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

function mockAgent() {
  return {
    id: 'main-session',
    options: { provider: 'xai', model: 'grok-4.6', reasoningEffort: 'xhigh' },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
}

function makeTui({ roster = true, quota = true } = {}) {
  process.env.TERM = 'xterm-256color'
  process.env.DSH_TUI_COLOR_DEPTH = 'truecolor'
  delete process.env.NO_COLOR
  const ctx = { get: name => (roster && name === 'agentPresets' ? {} : undefined), on() { return () => {} } }
  const tui = new SshTui(ctx, mockAgent(), {
    sessionId: 'main-session',
    color: true,
    provider: 'xai',
    presetId: 'standard',
    presetName: '标准模式',
    selectionRef: { current: { provider: 'xai', model: 'grok-4.6', reasoningEffort: 'xhigh' } },
    subagentSelection: { current: { model: 'grok-4.5' } },
  })
  tui.rows.splice(0, tui.rows.length)
  seedStats(tui)
  if (quota) tui.quotaSnapshot = { provider: 'xai', plan: 'SuperGrok', windows: [{ label: '每周', period: 'week', remainingPercent: 82 }] }
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
]

function footerRows(tui, cols, rows) {
  const frame = tui.captureFrame(cols, rows).map(line => padAnsiToWidth(line ?? '', cols))
  const plain = frame.map(line => stripAnsi(line))
  const stripIndex = plain.findIndex(line => line.includes('SSH ●') || line.includes('本地 ●'))
  const identityIndex = plain.findIndex(line => line.includes('grok-4.6 xhigh'))
  return { frame, plain, stripIndex, identityIndex }
}

function check(name, cols, { frame, plain, stripIndex, identityIndex }, options) {
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
  if (identityIndex < 0) problems.push('the identity row is missing')
  // The strip keeps the muted style; losing it turned the whole footer white.
  if (stripIndex >= 0 && !frame[stripIndex].includes('\x1b[90m')) problems.push('the strip lost its muted style')
  // The link chip keeps the default foreground and leads, unless the roster
  // warning outranks it.
  if (stripIndex >= 0 && options.roster !== false && !/^(?:SSH|本地|local)\b/u.test(strip)) {
    problems.push(`the link chip no longer leads the strip: ${JSON.stringify(strip)}`)
  }
  // The ring belongs to the identity line, one row down, together with the
  // quota: it is dropped with it when the row cannot even hold the bar.
  if (stripIndex >= 0 && RING_RE.test(strip)) problems.push('the context ring moved back onto the strip')
  const wantedRing = (options.quota ?? 'plan') !== 'gone'
  if (identityIndex >= 0 && wantedRing && !RING_RE.test(identity)) {
    problems.push(`the context ring left the identity line: ${JSON.stringify(identity)}`)
  }
  // Quota stays on the identity line, after the model, before the sub route.
  const barAt = identity.search(/[█░]{8} \d+%/u)
  const quotaAt = barAt < 0 ? -1 : barAt
  const modelAt = identity.indexOf('grok-4.6 xhigh')
  const subAt = identity.indexOf('sub:')
  const wanted = options.quota ?? 'plan'
  if (wanted === 'gone') {
    if (quotaAt >= 0) problems.push(`the quota bar must be dropped at ${cols} cells, not reshuffled: ${JSON.stringify(identity)}`)
  } else if (quotaAt < 0) {
    problems.push(`the quota bar left the identity line: ${JSON.stringify(identity)}`)
  } else {
    if (quotaAt < modelAt) problems.push('the quota bar moved ahead of the model')
    if (subAt >= 0 && quotaAt > subAt) problems.push('the quota bar moved behind the subagent route')
    const planName = identity.includes('SuperGrok')
    if (wanted === 'plan' && !planName) problems.push('the plan name was dropped although the row has room for it')
    if (wanted === 'bar' && planName) problems.push('the plan name survived a row that only fits the bar')
  }
  if (strip.includes('SuperGrok') || /[█░]{8} \d+%/u.test(strip)) problems.push('the quota bar is on the strip')
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
  const problems = check(testCase.name, testCase.cols, shot, testCase.options)
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
