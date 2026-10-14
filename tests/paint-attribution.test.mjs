/**
 * Paint attribution (P-1): frames the painter delimits, and the judgement probe
 * step 6c makes from them.
 *
 * The probe's dialog step used to judge the *window* — every `ESC[<row>;1H` the
 * terminal received in 500 ms — and that conflated three different things: the
 * layer repaint the key caused, the chrome block the painter deliberately redraws
 * whole (`src/paint.ts`: a frame with `chromeChanged` repaints every chrome row at
 * or below `chromeStart`, changed or not), and an independent background update to
 * the identity row that happens to land in the same window. On `test (0.1.7-rc.1)`
 * that conflation produced a red leg whose own suite was green.
 *
 * These cases pin the replacement. Frames are composed by the real
 * `composePaintFrame`, so the byte shapes here are the shipped ones — if the
 * painter changes its markers, this file fails rather than silently judging
 * nothing.
 *
 * The synthetic screen, rows 1..13:
 *
 *   1  identity row (banner + mode + route)   ← top chrome, may change on its own
 *   2  rule
 *   3..7  transcript                          ← must not be repainted or re-windowed
 *   8  `  ● Option A`                         ← the layer's option rows
 *   9  `  ○ Option B`                         ← the highlight moves between these
 *   10 the layer's key hint                   ← a layer row that must stay put
 *   11 `╭───…`                                ← the chrome block starts here
 *   12 the composer line
 *   13 the status row
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { composePaintFrame } from '../lib/paint.js'
import { padAnsiToWidth } from '../lib/term-text.js'
import { attributePaint, composerTopRow, judgeInteractionWindow, parsePaintFrames, rowText } from '../scripts/paint-attribution.mjs'

const WIDTH = 60
const HEIGHT = 13
const LABELS = ['Option A', 'Option B']
const TOP_CHROME_ROWS = 2
/** 0-based index of the composer box top; the chrome block is this row and below. */
const CHROME_START = 10
const OPTION_A_ROW = 7
const OPTION_B_ROW = 8
const HINT_ROW = 9
const DEFAULT_TITLE = 'DeepSeek Harness — SSH TUI  [标准模式]  deepseek-official/deepseek-flash'

/** The painter pads to the frame's *width in cells*, so a fixture has to as well. */
const pad = text => padAnsiToWidth(text, WIDTH)

/** A full screen: every row a string, the way the painter's snapshot always holds it. */
function screen({ chosen = 0, title = DEFAULT_TITLE, transcript = ['第一行', '第二行', '第三行', '第四行', '第五行'] } = {}) {
  const rows = new Array(HEIGHT).fill('')
  rows[0] = title
  rows[1] = '─'.repeat(WIDTH)
  for (const [at, line] of transcript.entries()) rows[2 + at] = line
  rows[OPTION_A_ROW] = `  ${chosen === 0 ? '●' : '○'} ${LABELS[0]}`
  rows[OPTION_B_ROW] = `  ${chosen === 1 ? '●' : '○'} ${LABELS[1]}`
  rows[HINT_ROW] = '  ↑/↓ 选择，Enter 提交'
  rows[CHROME_START] = '╭' + '─'.repeat(WIDTH - 1)
  rows[CHROME_START + 1] = '>'
  rows[CHROME_START + 2] = 'SSH ○○○○ 未测 │ 等待回答'
  return rows.map(pad)
}

/** One composed frame: what the painter writes for `rows` given what it painted before. */
function frame(rows, options = {}) {
  const composed = composePaintFrame({
    width: WIDTH,
    height: HEIGHT,
    paintRows: rows,
    previousRows: options.previous ?? [],
    sizeChanged: options.sizeChanged ?? false,
    chromeChanged: options.chromeChanged ?? false,
    chromeStart: options.chromeStart ?? CHROME_START,
    cursorRow: options.cursorRow ?? HEIGHT,
    cursorColumn: 1,
  })
  return { output: composed.output, painted: composed.painted }
}

const windowText = frames => frames.map(entry => entry.output).join('')

/**
 * Judge a window. A window on its own does not carry the rows as they stood before
 * it, so the case passes the screen it was composed against — exactly what the probe
 * does not need to do, because there the window is a slice of the whole stream.
 */
const judge = (text, options = {}) => judgeInteractionWindow(text, {
  since: 0,
  until: text.length,
  height: HEIGHT,
  labels: LABELS,
  topChromeRows: TOP_CHROME_ROWS,
  ...(options.before === undefined ? {} : { initialContent: rowsToMap(options.before) }),
  ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'before')),
})

const rowsToMap = rows => new Map(rows.map((line, at) => [at + 1, line]))

test('a frame is parsed from the painter markers, not from a chunk boundary', () => {
  const before = screen({ chosen: 0 })
  const after = screen({ chosen: 1 })
  const text = frame(after, { previous: before, chromeChanged: true }).output
  const frames = parsePaintFrames(text)
  assert.equal(frames.length, 1, 'one composed frame is one frame')
  const rows = frames[0].paint.map(entry => entry.row)
  assert.deepEqual(rows, [
    OPTION_A_ROW + 1, OPTION_B_ROW + 1,
    CHROME_START + 1, CHROME_START + 2, CHROME_START + 3,
  ], `the frame painted both option rows and the chrome block (got ${rows.join(',')})`)
  assert.equal(frames[0].synchronized, true, 'a batch longer than two rows is wrapped in a synchronized update')
  assert.ok(rowText(frames[0].paint[1].content).includes('● Option B'), 'and its content is the new highlight')
  assert.equal(frames[0].paint.some(entry => rowText(entry.content).includes('↑/↓')), false, 'the unchanged hint row is not repainted')
  assert.equal(rowText(frames[0].paint[0].content).trim(), '○ Option A', 'row content is the text, not the padding')
})

test('the same stream is judged the same however the pty chopped it', () => {
  const before = screen({ chosen: 0 })
  const after = screen({ chosen: 1 })
  const text = windowText([frame(after, { previous: before, chromeChanged: true })])
  const whole = judge(text, { before })
  assert.ok(whole.ok, `the plain move must pass (${whole.failures.join('; ')})`)
  // Every split point stands for a chunk boundary the pty could have chosen.
  for (let at = 1; at < text.length; at += 7) {
    const chopped = judge(text.slice(0, at) + text.slice(at), { before })
    assert.equal(chopped.ok, whole.ok, `a split at ${at} changed the verdict`)
    assert.deepEqual(chopped.summary.paintedRows, whole.summary.paintedRows, `a split at ${at} changed the painted rows`)
    assert.deepEqual(chopped.summary.changedRows, whole.summary.changedRows, `a split at ${at} changed the changed rows`)
  }
})

test('an independent identity-row update in the same window does not fail the step', () => {
  // What the failing `0.1.7-rc.1` leg looked like: the arrow's layer frame, and a
  // frame that repaints the identity row because its route label changed on its own
  // schedule. Both arrived inside the 500 ms window; only the first is the key's.
  const before = screen({ chosen: 0 })
  const after = screen({ chosen: 1 })
  const newTitle = 'DeepSeek Harness — SSH TUI  [计划模式]  deepseek-official/deepseek-flash'
  const titleChanged = screen({ chosen: 0, title: newTitle })
  const movedWithNewTitle = screen({ chosen: 1, title: newTitle })
  const text = windowText([
    frame(titleChanged, { previous: before, chromeChanged: true }),
    frame(movedWithNewTitle, { previous: titleChanged, chromeChanged: true }),
  ])
  const painted = attributePaint(text, { since: 0, initialContent: rowsToMap(before) }).window.rowWrites.map(entry => entry.row)
  assert.ok(painted.includes(1), `the identity row really was repainted (${painted.join(',')})`)
  const verdict = judge(text, { before })
  assert.ok(verdict.ok, `the chrome update must not fail the step (${verdict.failures.join('; ')})`)
  assert.equal(verdict.checks.transcript.ok, true, 'nothing above the layer is reported as changed')
  assert.equal(verdict.checks.scope.ok, true, 'and the identity row is allowed to change')
})

test('the chrome block may be repainted unchanged, and the check says so', () => {
  const before = screen({ chosen: 0 })
  const after = screen({ chosen: 1 })
  const text = frame(after, { previous: before, chromeChanged: true }).output
  const analysis = attributePaint(text, { since: 0, initialContent: rowsToMap(before) })
  const paintedRows = analysis.window.rowWrites.map(entry => entry.row)
  const unchanged = analysis.window.rowWrites.filter(entry => !entry.changed).map(entry => entry.row)
  assert.ok(unchanged.length > 0, `the frame repaints chrome rows the snapshot did not change (${paintedRows.join(',')})`)
  assert.ok(unchanged.every(row => row > CHROME_START), 'and the unchanged ones are all inside the chrome block')
  const verdict = judge(text, { before })
  assert.equal(verdict.checks.scope.ok, true, `that is the painter being entitled to redraw the input box: ${verdict.checks.scope.detail}`)
  assert.equal(verdict.bands.chromeTop, CHROME_START + 1, 'the chrome block is located at the composer box top')
})

test('M2a: a transcript repaint with unchanged bytes fails, even when it starts below row 5', () => {
  // The shape the old rule could not see: every row addressed is at or below row 5,
  // so "every row >= 5" passed — and this is the regression the step exists for.
  const before = screen({ chosen: 0 })
  const after = screen({ chosen: 1 })
  const text = frame(after, { previous: before, chromeChanged: true, chromeStart: 2 }).output
  const verdict = judge(text, { before })
  assert.equal(verdict.checks.scope.ok, false, 'repainting rows it did not change must fail')
  assert.match(verdict.checks.scope.detail, /row 3/u, `scope names the first transcript row: ${verdict.checks.scope.detail}`)
  assert.equal(verdict.ok, false)
})

test('M2b: a transcript that moved (the pre-B1.1 re-window) fails the transcript check', () => {
  const before = screen({ chosen: 0, transcript: ['第一行', '第二行', '第三行', '第四行', '第五行'] })
  const rewound = screen({ chosen: 1, transcript: ['第二行', '第三行', '第四行', '第五行', '新来的'] })
  const text = frame(rewound, { previous: before, chromeChanged: true }).output
  const verdict = judge(text, { before })
  assert.equal(verdict.checks.scope.ok, true, 'every painted row had changed, so scope alone would accept it')
  assert.equal(verdict.checks.transcript.ok, false, 'the transcript check is what catches a re-window')
  assert.match(verdict.checks.transcript.detail, /re-windowed/u)
  assert.equal(verdict.ok, false)
})

test('M4: an independent tick above the layer stays inside the budget', () => {
  // One card's clock moves while the layer is up: a change, but not the layer's and
  // not a re-window. The step must not fail on it.
  const before = screen({ chosen: 0 })
  const ticked = screen({ chosen: 1 })
  ticked[2] = '第一行 · 3s'
  const text = frame(ticked, { previous: before, chromeChanged: true }).output
  const verdict = judge(text, { before })
  assert.equal(verdict.checks.transcript.ok, true, `one ticking row is inside the budget: ${verdict.checks.transcript.detail}`)
  assert.equal(verdict.checks.scope.ok, true, 'and the row it repainted had changed')
  assert.equal(verdict.ok, true, verdict.failures.join('; '))
})

test('M3: a clear in the window fails', () => {
  const after = screen({ chosen: 1 })
  const repaint = frame(after, { previous: [], sizeChanged: true, chromeChanged: true })
  assert.match(repaint.output, /\x1b\[[HJ]|\x1b\[2J/u, 'a size change clears, which is what this case needs')
  const verdict = judge(windowText([repaint]), { before: screen({ chosen: 0 }) })
  assert.equal(verdict.checks.clear.ok, false, `the clear must be caught: ${verdict.checks.clear.detail}`)
  assert.equal(verdict.ok, false)
})

test('M1: a key that does not move the highlight fails, and says which half', () => {
  const before = screen({ chosen: 0 })
  const text = windowText([frame(before, { previous: before, chromeChanged: true })])
  const verdict = judge(text, { before })
  assert.equal(verdict.checks.move.ok, false, 'the highlight must be seen to move')
  assert.equal(verdict.checks.repaint.ok, false, 'and the layer must be seen to repaint')
  assert.equal(verdict.ok, false)
})

test('the chrome block is located by the composer box, and only by it', () => {
  const rows = screen({ chosen: 0 })
  const content = new Map(rows.map((line, at) => [at + 1, line]))
  assert.equal(composerTopRow(content), CHROME_START + 1, 'the box top row is the chrome block start')
  assert.equal(composerTopRow(new Map([[1, 'no box here']])), undefined, 'and no box means no claim')
})

test('a row that only changes style still counts as changed', () => {
  // The snapshot holds composed bytes, so a colour-only change is a change: the row
  // has to be repainted, and calling it unchanged would fail a real frame.
  const before = screen({ chosen: 0 })
  const styled = screen({ chosen: 0 })
  styled[2] = '\x1b[31m第一行\x1b[0m'
  const text = frame(styled, { previous: before }).output
  const entry = attributePaint(text, { since: 0, initialContent: rowsToMap(before) }).window.rowWrites.find(row => row.row === 3)
  assert.ok(entry !== undefined, 'the styled row was painted')
  assert.equal(entry.changed, true, 'and it is recorded as changed')
})

test('frames are attributed against the content that preceded them', () => {
  const before = screen({ chosen: 0 })
  const after = screen({ chosen: 1 })
  const text = windowText([
    frame(before, { previous: [] }),
    frame(after, { previous: before, chromeChanged: true }),
  ])
  const analysis = attributePaint(text, { since: 0 })
  assert.equal(analysis.window.frames.length, 2, 'both frames are inside the window')
  const last = analysis.frames.at(-1)
  const option = last.paint.find(entry => entry.row === OPTION_A_ROW + 1)
  assert.equal(option.changed, true, 'the option row changed in the second frame')
  assert.equal(option.before, before[OPTION_A_ROW], 'and the model knows what it held before')
})

/**
 * The rule this replaced, kept as an executable comparison.
 *
 * Step 6c used to assert "every row addressed in the window is at least row 5". Both
 * halves of that are wrong, and the two cases below are the two directions: it
 * rejected the independent identity-row tick, and it accepted a transcript repaint
 * that happened to start below row 5. They are written against the same composed
 * frames the new checks are judged on, so the difference is the rule, not the bytes.
 */
const oldRule = text => {
  const rows = [...text.matchAll(/\x1b\[(\d+);1H/gu)].map(match => Number(match[1]))
  return rows.length > 0 && rows.every(row => row >= 5)
}

test('the old rule rejected an identity tick that the new model allows', () => {
  const before = screen({ chosen: 0 })
  const newTitle = 'DeepSeek Harness — SSH TUI  [计划模式]  deepseek-official/deepseek-flash'
  const titleChanged = screen({ chosen: 0, title: newTitle })
  const movedWithNewTitle = screen({ chosen: 1, title: newTitle })
  const text = windowText([
    frame(titleChanged, { previous: before, chromeChanged: true }),
    frame(movedWithNewTitle, { previous: titleChanged, chromeChanged: true }),
  ])
  assert.ok([...text.matchAll(/\x1b\[(\d+);1H/gu)].map(match => Number(match[1])).includes(1),
    'the identity row was repainted in this window')
  assert.equal(oldRule(text), false, 'the old rule saw row 1 and called it a regression — the c654153 red leg')
  assert.equal(judge(text, { before }).ok, true, 'the new model attributes it to the row that changed')
})

test('the old rule accepted a transcript repaint that the new model rejects', () => {
  const before = screen({ chosen: 0 })
  const after = screen({ chosen: 1 })
  // A repaint that starts at the first transcript row *below* the old threshold.
  const text = frame(after, { previous: before, chromeChanged: true, chromeStart: 5 }).output
  const addressed = [...text.matchAll(/\x1b\[(\d+);1H/gu)].map(match => Number(match[1]))
  assert.ok(addressed.every(row => row >= 5), `the old rule had nothing to say (${addressed.join(',')})`)
  assert.equal(oldRule(text), true, 'it passed')
  const verdict = judge(text, { before })
  assert.equal(verdict.checks.scope.ok, false, `the new model names the repaint: ${verdict.checks.scope.detail}`)
})
