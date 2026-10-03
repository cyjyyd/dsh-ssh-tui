import test from 'node:test'
import assert from 'node:assert/strict'

import {
  advancePaintedRows,
  linkRedrawBudgetMs,
  RESIZE_UNKNOWN_LINK_BUDGET_MS,
  composePaintFrame,
  composePaintOutput,
  frameByteBudget,
  linkQualityOf,
  medianRtt,
  paintIntervalForRtt,
  RTT_HISTORY,
  paintOrder,
  FRAME_BYTE_BUDGETS,
} from '../lib/paint.js'
import { screen } from './screen.mjs'
import { ctxWithCredentials, waitFor, withSshSession } from './wait.mjs'

const WIDTH = 40
const HEIGHT = 20

/** `count` distinct rows, so a deferred row is always distinguishable. */
function rows(count, prefix = 'row') {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(2, '0')} ${'x'.repeat(10)}`)
}

/** One composed frame; the budget and resume point live in the same options. */
function paint(paintRows, previousRows, extra = {}, frame = {}) {
  return composePaintFrame({ ...frameOptions(paintRows, previousRows, extra), ...frame })
}

function frameOptions(paintRows, previousRows, extra = {}) {
  return {
    width: WIDTH,
    height: HEIGHT,
    paintRows,
    previousRows,
    sizeChanged: false,
    chromeChanged: false,
    chromeStart: paintRows.length - 2,
    cursorRow: 1,
    cursorColumn: 1,
    ...extra,
  }
}

/** Row indices a frame actually addressed, read back out of its bytes. */
function addressedRows(output) {
  return [...output.matchAll(/\u001b\[(\d+);1H\u001b\[0m\u001b\[2K/gu)].map(match => Number(match[1]) - 1)
}

test('the byte budget follows the measured link quality', () => {
  assert.equal(frameByteBudget('local'), Number.POSITIVE_INFINITY)
  assert.equal(frameByteBudget('poor'), 2_048)
  assert.ok(frameByteBudget('slow') < frameByteBudget('ok'))
  assert.ok(frameByteBudget('ok') < frameByteBudget('good'))
  assert.equal(frameByteBudget('unknown'), FRAME_BYTE_BUDGETS.unknown)
  // A budget never falls below one row's worth of escape overhead.
  for (const budget of Object.values(FRAME_BYTE_BUDGETS)) {
    if (Number.isFinite(budget)) assert.ok(budget > 256, `${budget} is too small to paint anything`)
  }
})

test('paint order serves the tail first and never forgets a deferred row', () => {
  assert.deepEqual(paintOrder([1, 5, 9]), [9, 5, 1], 'no resume point: newest rows first')
  assert.deepEqual(paintOrder([1, 5, 9], 5), [5, 1, 9], 'deferred rows first, then the tail')
})

test('an unbudgeted frame is byte for byte what the painter always wrote', () => {
  const paintRows = rows(HEIGHT)
  const previous = rows(HEIGHT - 1)
  const options = frameOptions(paintRows, previous, { sizeChanged: true, chromeChanged: true })
  const frame = composePaintFrame(options)
  assert.equal(frame.output, composePaintOutput(options))
  assert.equal(frame.deferred.length, 0)
  assert.deepEqual(frame.painted, Array.from({ length: HEIGHT }, (_, index) => index))
  // The wire order matters: unbudgeted frames stay ascending, which is what
  // every screen-level assertion was written against. `composePaintOutput`
  // delegates to this function, so comparing the two would prove nothing.
  assert.deepEqual(addressedRows(frame.output), frame.painted, 'unbudgeted frames keep ascending row order')
})

test('a budgeted frame spends the budget on the tail and reports the rest', () => {
  const paintRows = rows(HEIGHT)
  const frame = paint(paintRows, [], { sizeChanged: true }, { maxBytes: 900 })
  assert.ok(frame.bytes <= 900 + 200, `frames stay near the budget (${frame.bytes})`)
  assert.ok(frame.deferred.length > 0, 'the rest waits for the next tick')
  assert.equal(frame.resume, Math.max(...frame.deferred))
  assert.deepEqual(
    addressedRows(frame.output).sort((left, right) => left - right),
    frame.painted,
    'only the reported rows were written (order is the tail-first paint order)',
  )

  // The tail is what got painted, not the head.
  assert.ok(Math.max(...frame.painted) === HEIGHT - 1, 'the last row is always painted')
  assert.ok(Math.min(...frame.painted) > 0, 'the head was deferred')
})

test('consecutive budgeted frames drain every dirty row', () => {
  const paintRows = rows(HEIGHT)
  let previous = []
  let from
  const seen = new Set()
  for (let tick = 0; tick < HEIGHT; tick += 1) {
    const frame = paint(paintRows, previous, { sizeChanged: tick === 0 }, {
      maxBytes: 300,
      ...(from === undefined ? {} : { from }),
    })
    for (const index of frame.painted) seen.add(index)
    // The caller marks only what was painted as up to date.
    const merged = previous.slice()
    for (const index of frame.painted) merged[index] = paintRows[index] ?? ''
    previous = merged
    from = frame.resume
    if (from === undefined) break
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: HEIGHT }, (_, index) => index))
  assert.equal(from, undefined, 'the drain converges instead of oscillating')
})

test('a tail that changes every tick does not starve the deferred head', () => {
  const paintRows = rows(HEIGHT)
  let previous = []
  let from
  let headPaintedAt = undefined
  for (let tick = 0; tick < 12 && headPaintedAt === undefined; tick += 1) {
    // Every tick the last three rows change again, which is the streaming case.
    const current = paintRows.map((row, index) => (index >= HEIGHT - 3 ? `${row} ~${tick}` : row))
    const frame = paint(current, previous, { sizeChanged: tick === 0 }, {
      maxBytes: 600,
      ...(from === undefined ? {} : { from }),
    })
    if (frame.painted.includes(0)) headPaintedAt = tick
    const merged = previous.slice()
    for (const index of frame.painted) merged[index] = current[index] ?? ''
    previous = merged
    from = frame.resume
  }
  assert.notEqual(headPaintedAt, undefined, 'the oldest deferred row still gets painted')
})

test('a split repaint ends with the complete screen and no residue', async () => {
  const s = screen(WIDTH, HEIGHT)
  const paintRows = [...rows(HEIGHT - 2), '', '> ready']
  let previous = []
  let from
  for (let tick = 0; tick < HEIGHT; tick += 1) {
    const frame = paint(paintRows, previous, { sizeChanged: tick === 0 }, {
      maxBytes: 260,
      ...(from === undefined ? {} : { from }),
    })
    await s.write(frame.output)
    const merged = previous.slice()
    for (const index of frame.painted) merged[index] = paintRows[index] ?? ''
    previous = merged
    from = frame.resume
    if (from === undefined ) break
  }
  assert.deepEqual(
    s.lines().slice(0, HEIGHT).map(line => line.trimEnd()),
    paintRows.map(line => line.trimEnd()),
    'every row arrived, in order',
  )
  assert.deepEqual(s.cursor(), { x: 0, y: 0 }, 'the caret sits where the frame parked it')
})

test('only painted rows become clean in the next snapshot', () => {
  const previous = ['a', 'b', 'c', 'd']
  const current = ['a2', 'b2', 'c2', 'd2']
  // A frame that only reached rows 2 and 3 leaves 0 and 1 dirty.
  const after = advancePaintedRows(previous, current, [2, 3])
  assert.deepEqual(after, ['a', 'b', 'c2', 'd2'])
  const stillDirty = current.filter((row, index) => row !== (after[index] ?? ''))
  assert.deepEqual(stillDirty, ['a2', 'b2'], 'the deferred rows are still seen as changed')
  // A frame that painted nothing (row count changed) keeps the old length, so
  // the caller still owes the trailing clear.
  assert.deepEqual(advancePaintedRows(['x'], ['x', 'y'], []), ['x'])
})

// The reported round-trip decides three things at once — the footer chip, the
// paint cadence and the per-frame byte budget — so how it is derived from the
// measurements matters more than it looks.
test('the reported link is the median of the recent measurements', () => {
  assert.equal(medianRtt([]), undefined, 'nothing measured says so')
  assert.equal(medianRtt([Number.NaN, -5]), undefined, 'and a nonsense sample is not a measurement')
  assert.equal(medianRtt([90]), 90)
  assert.equal(medianRtt([90, 40]), 65, 'the pair in between averages, so the chip does not jump')
  assert.equal(medianRtt([90, 40, 40]), 40, 'two agreeing measurements decide')
  // One spike — a burst that beats the probe to the wire — cannot pin the paint
  // budget at the slowest tier for the rest of the session.
  assert.equal(medianRtt([40, 40, 900]), 40)
  assert.equal(paintIntervalForRtt(medianRtt([40, 40, 900])), paintIntervalForRtt(40))
  assert.equal(frameByteBudget(linkQualityOf('ssh', medianRtt([40, 40, 900]))), FRAME_BYTE_BUDGETS.good)
  // A real degradation is followed as soon as it repeats...
  assert.equal(medianRtt([40, 900, 900]), 900)
  assert.equal(frameByteBudget(linkQualityOf('ssh', 900)), FRAME_BYTE_BUDGETS.poor)
  // ...and recovery is just as quick.
  assert.equal(medianRtt([900, 900, 45]), 900, 'one fast sample is not recovery')
  assert.equal(medianRtt([900, 45, 45]), 45, 'two are')
  assert.equal(RTT_HISTORY, 3, 'the window this test is about')
})

// --- resize: the frame follows the window, not the event stream ---------------
//
// Dragging a window edge emits a resize every few milliseconds, and each one used
// to get a synchronous full repaint. On a long transcript that is ~100 ms of
// rendering per event, so a two-second drag queued seconds of work and the screen
// trailed the pointer. The policy is *state, not history*: a burst gets at most
// one frame per budget, always composed from the size the terminal is at when the
// frame runs, plus an immediate frame for a resize that arrives after a quiet
// spell (a window snap must not wait out a debounce nothing will join).

/** A TUI with `count` transcript rows behind it, and a count of its frames. */
async function resizableTui(count = 60) {
  const { SshTui } = await import('../lib/tui.js')
  process.stdout.columns = 100
  process.stdout.rows = 24
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [], header: { cwd: '/tmp' } },
    cancel() {},
  }
  // The wire this file is about is an SSH one (the 160 ms tier is what makes a frame
  // skippable at all), and the machine it runs on has been set up. Both are read from
  // the environment at construction, so they are pinned here rather than inherited: a
  // bare runner has no `SSH_*` and no home, and its roster check pushes a "rows are
  // missing" row into the transcript — one extra line, which is enough to move
  // `lastTranscriptStart` by one and fail every absolute assertion below.
  const tui = withSshSession(() => new SshTui(
    ctxWithCredentials({ agentPresets: {}, settings: { get: () => undefined } }),
    agent,
    { sessionId: 'main-session', color: false },
  ))
  let frames = 0
  tui.write = () => { frames += 1 }
  for (let index = 0; index < count; index += 1) {
    tui.rows.push({ kind: 'tool-result', text: `row ${index} ${'x'.repeat(60)}` })
  }
  tui.paint()
  frames = 0
  return { tui, frames: () => frames }
}

test('a burst of resize events paints once, at the size it lands on', async () => {
  const { tui, frames } = await resizableTui()
  // Sixty events in one synchronous burst: a dragged edge, collapsed to its final
  // geometry. Nothing is painted while the size is still moving — the first
  // event's geometry would be stale by the time its frame was composed.
  for (let index = 0; index < 60; index += 1) {
    process.stdout.columns = 100 + index
    tui.onDirectResize()
  }
  assert.equal(frames(), 0, 'the burst paints nothing while it is still moving')
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(frames(), 1, 'the burst produced exactly one frame')
  assert.equal(tui.lastPaintWidth, 159, 'and it was composed from the newest size')
  assert.ok(tui.lastPaintRows.length > 0, 'the frame really was painted, not just scheduled')
})

test('a lone resize lands in about one settle window, not one paint cadence', async () => {
  const { tui, frames } = await resizableTui()
  process.stdout.columns = 132
  const started = Date.now()
  tui.onDirectResize()
  assert.equal(frames(), 0, 'a resize never paints synchronously')
  while (frames() === 0 && Date.now() - started < 1_000) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const latency = Date.now() - started
  assert.equal(frames(), 1, 'exactly one frame')
  assert.equal(tui.lastPaintWidth, 132, 'at the new width')
  // A window snap must not wait out the paint cadence (which is 400 ms on a slow
  // link); it has nothing to be collapsed with.
  assert.ok(latency < 200, `a lone resize took ${latency} ms`)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(frames(), 1, 'and nothing follows it')
})

test('a slow drag paints each time the size comes to rest', async () => {
  const { tui, frames } = await resizableTui()
  // Pausing between moves — a user adjusting a pane one step at a time — is not
  // one burst: each size is the size for long enough to be worth a frame, and
  // collapsing them would make the screen ignore deliberate adjustments.
  for (const columns of [104, 112, 96]) {
    process.stdout.columns = columns
    tui.onDirectResize()
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(tui.lastPaintWidth, columns, `the frame follows the move to ${columns}`)
  }
  assert.equal(frames(), 3, `three deliberate moves, three frames: ${frames()}`)
})

// --- the redraw budget a drag assumes on a link nobody measured ---------------
//
// Two of the four cadence sources are an answer (a measured round trip, or an
// explicit `DSH_TUI_PAINT_MS`); a local TTY's constant is about a link that is not
// a link. Only an *unprobed* SSH link has an interval nobody measured, and pacing
// frames by a guess queues stale geometries behind live ones — the drag freezes and
// jumps. That case gets a deliberately slow budget instead, and nothing claims the
// round trip it does not have.

test('an unmeasured link gets a conservative redraw budget, a measured one its cadence', () => {
  assert.equal(linkRedrawBudgetMs('ssh', 'unprobed', 160), RESIZE_UNKNOWN_LINK_BUDGET_MS)
  assert.equal(linkRedrawBudgetMs('ssh', 'unprobed', 400), RESIZE_UNKNOWN_LINK_BUDGET_MS, 'the guess is replaced, not trusted')
  assert.equal(linkRedrawBudgetMs('ssh', 'measured', 250), 250)
  assert.equal(linkRedrawBudgetMs('ssh', 'configured', 40), 40, 'the user pinned it: that is an answer too')
  assert.equal(linkRedrawBudgetMs('local', 'local', 80), 80)
  assert.ok(RESIZE_UNKNOWN_LINK_BUDGET_MS > 160, 'conservative means slower than the SSH default, not faster')
})

test('a drag follows the pointer one frame per event while the wire keeps up', async () => {
  const { tui, frames } = await resizableTui()
  // A healthy wire says nothing: the row must answer every geometry it is told
  // about, because the terminal reflows its own grid the instant the edge moves and
  // anything later reads as lag.
  let width = 100
  for (let index = 0; index < 12; index += 1) {
    width = 100 + index
    process.stdout.columns = width
    tui.onDirectResize()
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(frames(), 12, 'every event was painted')
  assert.equal(tui.lastPaintWidth, width, 'and the last one is the size the drag ended on')
})

test('a wire that is behind is not asked for another frame', async () => {
  const { tui, frames } = await resizableTui()
  // 64 KB queued for the terminal: composing another frame now would only put a
  // stale geometry behind a live one, which is the queue this whole path exists to
  // avoid. The Host asks the socket rather than guessing from the round trip.
  tui.displayHost = { attached: true, pendingBytes: () => 64 * 1024 }
  let width = 100
  for (let index = 0; index < 20; index += 1) {
    width = 100 + index
    process.stdout.columns = width
    tui.onDirectResize()
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const behind = frames()
  assert.ok(behind < 20, `a backed-up wire must skip frames: ${behind} of 20`)
  // …and when it drains, the size it had been holding lands.
  //
  // Waited for rather than slept on: this is the one assertion in the file that asks
  // for something to *happen*, and a fixed 300 ms read the old state on a slow leg —
  // exactly the race `tests/wait.mjs` exists to stop (it failed on the Windows runner
  // while passing here). The pacing it waits on is bounded by the paint interval.
  tui.displayHost = { attached: true, pendingBytes: () => 0 }
  await waitFor(() => frames() > behind, {
    describe: 'the held frame to be painted once the wire drained',
    timeoutMs: 5_000,
  })
  assert.equal(tui.lastPaintWidth, width, 'at the size the drag ended on')
})

// --- what a resize frame is allowed to re-render ------------------------------
//
// A resize changes the width, and the width is part of every row's render
// fingerprint, so *every* row of the transcript is re-wrapped and re-clipped on
// every frame of a drag. Measured on this machine that was 43 ms of synchronous
// work per event at 2400 rows and 75 ms at 5000 — event-loop time, so it is also
// the delay on the reader's next keystroke and on the next resize event, and ten
// events took 947 ms while painting only twenty frames. The window shows about
// one screen of transcript, so during a drag only its tail is rendered (the
// mechanism `--resume` already uses for the same reason).

test('a drag renders the tail of the transcript, not all of it', async () => {
  const { tui } = await resizableTui(400)
  // Time-spaced, like a real drag: a same-millisecond burst is collapsed to one
  // frame by the minimum interval, so a synchronous loop would measure the
  // collapse rather than the per-event work this case is about.
  for (let index = 0; index < 6; index += 1) {
    process.stdout.columns = 120 + index
    tui.onDirectResize()
    await new Promise(resolve => setTimeout(resolve, 18))
  }
  assert.equal(tui.paintTailBudget > 0, true, 'the drag opened a tail budget')
  // The claim is about the *window*: the frame starts far below the transcript's
  // first lines, because the fold put them out of reach. `lastTranscriptStart`
  // indexes display lines — which is where the windowing actually happens — so a
  // start in the hundreds is the observable form of "the transcript was folded".
  assert.ok(
    tui.lastTranscriptStart > 60,
    `a drag painted from line ${tui.lastTranscriptStart}, not from the top`,
  )
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(tui.paintTailBudget, 0, 'and the budget does not outlive the drag')
})

test('the frame after a drag is the whole transcript again', async () => {
  const { tui } = await resizableTui(400)
  const unfoldedStart = tui.lastTranscriptStart
  for (let index = 0; index < 6; index += 1) {
    process.stdout.columns = 120 + index
    tui.onDirectResize()
    await new Promise(resolve => setTimeout(resolve, 18))
  }
  const narrowedStart = tui.lastTranscriptStart
  assert.ok(tui.paintTailBudget > 0, 'mid-drag, the transcript is folded')
  // The pointer stops; nothing more is coming, so the compromise must end and the
  // transcript must be whole at the width the window settled on. Leaving the fold
  // in place is what would let a drag's intermediate geometry become the screen.
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(tui.paintTailBudget, 0, 'the budget is lifted once the drag settles')
  assert.ok(
    tui.lastTranscriptStart > narrowedStart,
    `the settled frame reaches higher than the drag's: ${tui.lastTranscriptStart} > ${narrowedStart}`,
  )
  assert.equal(
    tui.lastTranscriptStart, unfoldedStart,
    'and it is the window it would have painted without the drag at all',
  )
})

test('a reader who scrolled back keeps their view during a drag', async () => {
  const { tui } = await resizableTui(400)
  tui.scrollOffset = 40
  for (let index = 0; index < 6; index += 1) {
    process.stdout.columns = 120 + index
    tui.onDirectResize()
    await new Promise(resolve => setTimeout(resolve, 18))
  }
  // Folding the transcript away would move the rows under a reader who is
  // deliberately looking at older ones — a worse lie than a slower frame.
  assert.equal(tui.paintTailBudget, 0, 'a scrolled position opts out of the tail')
  assert.equal(tui.scrollOffset, 40, 'and their position is untouched by the drag')
})

test('the work one resize event costs does not grow with the transcript', async () => {
  // This is the whole complaint: an event's synchronous work is time the reader's
  // keystroke cannot be delivered in, and it grows with the session unless the
  // frame is capped. Measured before the cap: 2400 rows cost 437 ms per event and
  // 5000 rows 767 ms; with the tail rendered, both are a few milliseconds. The
  // assertion is on the same session's own work, not a wall-clock budget, so a slow
  // CI machine moves both numbers together.
  const costs = []
  for (const rows of [40, 4000]) {
    const { tui } = await resizableTui(rows)
    for (let index = 0; index < 3; index += 1) {
      process.stdout.columns = 120 + index
      tui.onDirectResize()
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    process.stdout.columns = 124
    const started = process.hrtime.bigint()
    tui.onDirectResize()
    costs.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  assert.ok(costs[1] < 40, `one event cost ${costs[1].toFixed(1)} ms on a 4000-row session`)
  assert.ok(
    costs[1] < costs[0] * 4 + 10,
    `a 100x longer transcript made one event ${(costs[1] / Math.max(costs[0], 0.1)).toFixed(1)}x more expensive`,
  )
})

// --- what a drag frame puts on the wire ---------------------------------------
//
// The two directions of a drag are not equally expensive, because a frame's size
// is proportional to the width: growing the window means every frame is bigger
// than the last while the terminal drains at a fixed rate, so the backlog
// compounds and the screen keeps moving after the pointer has stopped (measured
// against a byte-rate-limited consumer: 30–44 ms of leftover drain growing,
// against 0–10 ms shrinking). Two things answer that: the drag skips a frame while
// the previous one is still queued, and a mid-drag frame paints only the chrome.

/** Rows a frame addressed, read back out of its cursor-position sequences. */
function addressedRowsOf(frame) {
  return [...frame.matchAll(/\u001b\[(\d+);1H/gu)].map(match => Number(match[1]) - 1)
}

test('a mid-drag frame paints the chrome, not the transcript', async () => {
  const { tui } = await resizableTui(400)
  const written = []
  tui.write = chunk => written.push(chunk)
  for (let index = 0; index < 6; index += 1) {
    process.stdout.columns = 120 + index
    tui.onDirectResize()
    await new Promise(resolve => setTimeout(resolve, 18))
  }
  assert.ok(written.length > 0, 'the drag painted something')
  assert.equal(tui.resizeTailNarrowed, true, 'and it is the folding kind of drag')
  const height = process.stdout.rows ?? 24
  for (const frame of written) {
    const rows = addressedRowsOf(frame)
    if (rows.length === 0) continue
    assert.ok(
      Math.min(...rows) >= height - 6,
      `a drag frame addressed row ${Math.min(...rows)}: it repainted the transcript the terminal reflows itself`,
    )
    // Nor may it clear: `\x1b[J` from home would take the transcript with it.
    assert.equal(frame.includes('\u001b[J'), false, 'a chrome-only frame must not erase the screen')
  }
})

test('a chrome-only drag frame is a fraction of the full one', async () => {
  const { tui } = await resizableTui(400)
  const drag = []
  tui.write = chunk => drag.push(chunk)
  for (let index = 0; index < 4; index += 1) {
    process.stdout.columns = 120 + index
    tui.onDirectResize()
    await new Promise(resolve => setTimeout(resolve, 18))
  }
  const dragBytes = Math.max(...drag.map(frame => Buffer.byteLength(frame, 'utf8')))
  // The same width, painted whole, is what the drag would have sent every event.
  const full = []
  tui.write = chunk => full.push(chunk)
  tui.resizeTailNarrowed = false
  tui.forceFullPaint = true
  tui.paintTailBudget = 0
  tui.paint()
  const fullBytes = Math.max(...full.map(frame => Buffer.byteLength(frame, 'utf8')))
  assert.ok(
    dragBytes * 3 < fullBytes,
    `a drag frame is ${dragBytes}B against a full one of ${fullBytes}B`,
  )
})

test('the frame that closes a drag repaints the transcript it left alone', async () => {
  const { tui } = await resizableTui(400)
  const written = []
  tui.write = chunk => written.push(chunk)
  for (let index = 0; index < 4; index += 1) {
    process.stdout.columns = 120 + index
    tui.onDirectResize()
    await new Promise(resolve => setTimeout(resolve, 18))
  }
  written.length = 0
  // The pointer stops. The next frame is the one the reader keeps, so it has to be
  // the whole screen — and it can only be that if the drag frames did not claim the
  // transcript rows as already painted.
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(tui.paintTailBudget, 0, 'the drag ended')
  const settling = written.at(-1) ?? ''
  const rows = addressedRowsOf(settling)
  assert.ok(rows.length > 0, 'the settling frame painted something')
  assert.equal(Math.min(...rows), 0, 'and it started at the top of the screen')
  assert.equal(settling.includes('\u001b[J'), true, 'as a full size-change frame')
})

test('a drag skips a frame while the previous one is still queued', async () => {
  const { tui, frames } = await resizableTui(400)
  // One frame's worth queued — 4 KB is far below the 32 KB the cadence path waits
  // for, and that is the point: the question here is "would this be a stale
  // geometry queued behind a live one", not "is this link slow".
  tui.displayHost = { attached: true, pendingBytes: () => 4 * 1024 }
  for (let index = 0; index < 12; index += 1) {
    process.stdout.columns = 120 + index
    tui.onDirectResize()
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const queued = frames()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.ok(queued < 4, `a queued wire must skip frames: ${queued} of 12`)
  // …and the geometry it was holding lands once there is room.
  tui.displayHost = { attached: true, pendingBytes: () => 0 }
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.ok(frames() > queued, 'the held frame is painted once the wire drains')
})

test('a queue shorter than one frame does not hold a drag frame back', async () => {
  const { tui, frames } = await resizableTui(400)
  // Under the floor the frame is not "queued behind" anything: pausing here would
  // cost the reader feedback for a wire that is keeping up, which is the whole
  // behaviour the per-event pacing exists to provide.
  tui.displayHost = { attached: true, pendingBytes: () => 1_500 }
  for (let index = 0; index < 4; index += 1) {
    process.stdout.columns = 120 + index
    tui.onDirectResize()
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(frames() >= 4, `a keeping-up wire must still paint: ${frames()} of 4`)
})

test('a chrome-only frame does not claim the transcript rows it left alone', async () => {
  const { tui } = await resizableTui(400)
  const written = []
  tui.write = chunk => written.push(chunk)
  for (let index = 0; index < 4; index += 1) {
    process.stdout.columns = 120 + index
    tui.onDirectResize()
    await new Promise(resolve => setTimeout(resolve, 18))
  }
  // The ledger, not the screen. If a partial frame records the rows it skipped as
  // painted, the next frame compares them equal to themselves and never paints them,
  // so the only thing standing between a drag and a stale transcript would be the
  // settle frame forcing a full repaint — and nothing should have to depend on that.
  //
  // Same fold, same width, no forced paint: the rows must still be owed because the
  // ledger's copies of them are from the widths the drag passed through.
  tui.resizeTailNarrowed = false
  tui.forceFullPaint = false
  written.length = 0
  tui.dirty = true
  tui.paint()
  const rows = addressedRowsOf(written[0] ?? '')
  const height = process.stdout.rows ?? 24
  assert.ok(rows.length > 0, 'the frame painted something')
  assert.ok(
    Math.min(...rows) < height - 6,
    `the transcript rows were never owed: the frame started at row ${Math.min(...rows)}`,
  )
})
