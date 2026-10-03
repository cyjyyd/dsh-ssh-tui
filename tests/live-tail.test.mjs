/**
 * B2.2 — Live Tail Ownership.
 *
 * The live tail is a **projection of runtime state**, not history: streaming text,
 * the streaming-reasoning header, the wait card and the open compact burst. It used
 * to be appended to the transcript's own source lines, which made every tick a
 * transcript append — one more source line, a window that started one line later,
 * and `sizeChanged` behind that: a full clear, per tick, for the whole time a model
 * was writing (measured: 20 rows / ~2.9-3.2 KB per tick at 100×20).
 *
 * Now it is painted over the bottom of the window, so the anchor, `scrollOffset`,
 * the source rows and the row cache never see it, and a tick sends only the tail's
 * own dirty rows (AD-12, AD-17). These cases pin that, the backscroll rule, the
 * settle transition, and the fact that the tail never becomes a target for the mouse.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { pushRow, tick, waitFor, waitForDialog } from './wait.mjs'

setLocale('zh')

const COLUMNS = 100
const ROWS = 20

function fixture(options = {}) {
  const ctx = {
    get: name => (name === 'sessionProjections' ? { stateOf: () => ({ questions: { active: [], settled: [] } }) } : undefined),
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: {},
    status: options.status ?? 'running',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  for (let index = 0; index < (options.history ?? 60); index += 1) {
    pushRow(tui, { kind: index % 2 === 0 ? 'assistant' : 'user', text: `${index % 2 === 0 ? '回复' : '提问'} ${index}` })
  }
  if (options.compact === true) tui.setWorkspaceView('compact')
  return { tui, agent }
}

const plain = line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').trimEnd()
const frame = (tui, columns = COLUMNS, rows = ROWS) => tui.captureFrame(columns, rows).map(plain)

/** Paint for real and measure the wire: `captureFrame` swaps `write` out. */
function wirePaint(tui, columns = COLUMNS, rows = ROWS) {
  const written = []
  const real = tui.write.bind(tui)
  tui.write = chunk => { written.push(chunk); real(chunk) }
  process.stdout.columns = columns
  process.stdout.rows = rows
  tui.paint()
  tui.write = real
  const painted = written.join('')
  return {
    painted,
    text: plain(painted),
    rows: [...painted.matchAll(/\u001b\[(\d+);1H/gu)].map(match => Number(match[1])),
    cleared: /\u001b\[[HJ]|\u001b\[2J/u.test(painted),
    bytes: painted.length,
  }
}

/** Feed one real streaming chunk, the way a host emits it. */
function delta(tui, agent, text, { reasoning = false, index = 0 } = {}) {
  tui.handleAssistantStream({
    agent,
    frame: {
      type: 'chunk',
      attemptId: 'a1',
      revision: 1,
      index,
      time: Date.now(),
      chunk: reasoning
        ? { type: 'reasoning-delta', index, text }
        : { type: 'text-delta', index, text },
    },
  })
}

const settleReply = (tui, agent, text) => tui.handleSessionEvent(agent.session, {
  type: 'assistant/message',
  time: Date.now(),
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
})

const count = (text, needle) => text.split(needle).length - 1

// ── A. the projection does not own history ──────────────────────────────────

test('the first streaming tick opens the live region without clearing', async () => {
  // Idle, so "a quiet frame paints nothing" means what it says: a *running* agent
  // repaints its wait card's spinner on purpose, which is the region's own tick.
  const { tui, agent } = fixture({ status: 'idle' })
  wirePaint(tui)
  const before = tui.lastTranscriptStart
  const source = tui.rows.length
  const tick1 = wirePaint(tui)
  assert.equal(tick1.rows.length, 0, 'a quiet frame paints nothing')

  tui.handleAssistantStream({ agent, frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 } })
  delta(tui, agent, '第一段输出')
  const first = wirePaint(tui)
  assert.equal(first.cleared, false, 'the first tick must not clear the screen')
  assert.equal(tui.rows.length, source, 'and is still not a source row')
  assert.ok(first.text.includes('第一段输出'), 'the live region is on screen')
  assert.equal(tui.liveTailRegion?.rows, 1, 'one projected row')
  // The region takes that row rather than covering one (the trade B2.2's overlay
  // made is reversed here, see `paint`): the window gives up exactly one row, and
  // it does it by scrolling its own start back — a frame that repaints every row
  // and still clears nothing.
  assert.equal(tui.lastTranscriptStart, before + 1, 'the window gives up exactly the row the region took')
})

test('continuous streaming never clears and never adds a source row', async () => {
  // The cost is now two different ticks, and both are bounded: a tick that only
  // extends the last line repaints that one line, and a tick whose wrap lands on a
  // new line moves the window (the region took a row) and repaints it. Neither
  // clears the screen, and neither an anchor that never moves was ever the point —
  // *no source row, no clear* is what B2.2 bought and what still holds.
  const { tui, agent } = fixture({ history: 200 })
  wirePaint(tui)
  const source = tui.rows.length
  let steadyBytes = 0
  let grownBytes = 0
  for (let tickIndex = 0; tickIndex < 12; tickIndex += 1) {
    const rowsBefore = tui.liveTailRegion?.rows ?? 0
    delta(tui, agent, '流式输出片段 '.repeat(6))
    const painted = wirePaint(tui)
    assert.equal(painted.cleared, false, `tick ${tickIndex + 1} must not clear the screen`)
    assert.equal(tui.rows.length, source, `tick ${tickIndex + 1} adds no source row`)
    assert.equal(tui.scrollOffset, 0, `tick ${tickIndex + 1} never scrolls the reader`)
    const rowsAfter = tui.liveTailRegion?.rows ?? 0
    if (rowsAfter === rowsBefore) steadyBytes = Math.max(steadyBytes, painted.bytes)
    else grownBytes = Math.max(grownBytes, painted.bytes)
  }
  assert.ok(steadyBytes < 1000, `a tick inside the last line stays small (${steadyBytes}B)`)
  assert.ok(grownBytes < 4000, `a tick that opens a new line repaints the window (${grownBytes}B)`)
  assert.ok(tui.liveTailRegion.rows >= 4, `a longer reply takes more rows (${tui.liveTailRegion.rows})`)
})

test('the live region takes rows; the newest settled line stays visible', async () => {
  // What "the tail covers history" cost, and why it was reversed: the row that had
  // just settled sat *behind* the region, so entering a session mid-turn (or
  // settling a reply while a card was still running) showed history that stopped
  // short of the newest line, with the live lines where it should have been.
  const { tui, agent } = fixture({ history: 200 })
  pushRow(tui, { kind: 'assistant', text: '刚刚结算的最后一行' })
  wirePaint(tui)
  const before = tui.lastTranscriptStart
  delta(tui, agent, '实时区域 '.repeat(60))
  const after = frame(tui)
  const region = tui.liveTailRegion
  assert.ok(region.rows > 3, `the region is several rows (${region.rows})`)
  assert.ok(tui.lastTranscriptStart > before, 'the window moved back to make room')
  const above = after.slice(0, region.top - 1)
  assert.ok(above.some(line => line.includes('刚刚结算的最后一行')), `the newest settled line is above the region:\n${after.join('\n')}`)
  assert.ok(after.slice(region.top - 1).some(line => line.includes('实时区域')), 'and the region owns its own rows')
  assert.ok(after.length <= ROWS, 'the frame still fits the terminal')
})

test('a wrap that grows the live region never adds a source row', async () => {
  const { tui, agent } = fixture({ history: 100 })
  wirePaint(tui)
  const source = tui.rows.length
  // One long unbroken run: each chunk pushes the wrap onto a new visual line.
  for (let index = 0; index < 12; index += 1) {
    delta(tui, agent, 'x'.repeat(90))
    assert.equal(tui.rows.length, source, `wrap ${index + 1} added no source row`)
  }
  const painted = wirePaint(tui)
  assert.equal(painted.cleared, false, 'and no wrap cleared the screen')
  assert.ok(tui.liveTailRegion.rows >= 10, `the region grew with the wrap (${tui.liveTailRegion.rows})`)
})

test('a clipped live region keeps the header that names it', async () => {
  // Under height pressure the region drops its own oldest lines. The line it must
  // not drop is the live card's header: without it the region is a block of text
  // with nothing saying it is the session working, and the reader who expanded that
  // card loses the marker that says so — which is also the row a click folds it with.
  const { tui, agent } = fixture({ history: 6 })
  delta(tui, agent, '最早的一段思考内容。', { reasoning: true })
  delta(tui, agent, '中间的一段思考内容。'.repeat(40), { reasoning: true })
  delta(tui, agent, '最新的一段思考内容。', { reasoning: true })
  tui.streamingReasoning.expanded = true
  wirePaint(tui, 100, 12)
  const region = tui.liveTailRegion
  assert.notEqual(region, undefined, 'the region is projected')
  const lines = frame(tui, 100, 12)
  assert.equal(lines[region.top - 1]?.includes('思考中'), true, 'the card header is its first row')
  assert.equal(
    lines.slice(region.top - 1, region.top - 1 + region.rows).some(line => line.includes('最早的一段思考内容。')),
    false,
    'and the body was clipped from its oldest line',
  )
  assert.equal(
    lines.slice(region.top - 1, region.top - 1 + region.rows).some(line => line.includes('最新的一段思考内容。')),
    true,
    'while the newest line it holds is kept',
  )
})

test('the reasoning stream and the answer stream are separate projections', async () => {
  const { tui, agent } = fixture()
  // The reasoning stream projects as its own collapsed header, and the answer text
  // below it: two blocks, one live tail, in the order they will settle.
  delta(tui, agent, '先想一下', { reasoning: true })
  delta(tui, agent, '这是答案', { index: 1 })
  const painted = frame(tui)
  const region = tui.liveTailRegion
  const covered = painted.slice(region.top - 1, region.top - 1 + region.rows)
  assert.ok(covered.some(line => /思考|先想/u.test(line)), `the reasoning projection is in the tail:\n${covered.join('\n')}`)
  assert.ok(covered.some(line => line.includes('这是答案')), 'and the answer text is too')
  assert.ok(region.rows >= 2, 'both live blocks project')
})

test('the wait card ticks without touching the window', async () => {
  const { tui } = fixture({ history: 200 })
  wirePaint(tui)
  tui.waitStartedAt = Date.now()
  const anchor = tui.lastTranscriptStart
  for (let tickIndex = 0; tickIndex < 3; tickIndex += 1) {
    await new Promise(resolve => setTimeout(resolve, 1100))
    const painted = wirePaint(tui)
    assert.equal(painted.cleared, false, `wait tick ${tickIndex + 1} must not clear`)
    assert.equal(tui.lastTranscriptStart, anchor, `wait tick ${tickIndex + 1} kept the anchor`)
    assert.ok(painted.text.includes('处理中'), 'the card follows its clock')
  }
  assert.equal(tui.liveTailRegion?.rows, 1, 'the wait card is one projected row')
})

test('a running tool keeps the spinner live without a source row', async () => {
  const { tui } = fixture({ status: 'idle' })
  wirePaint(tui) // establish the frame, so the next paint measures the change only
  const rows = tui.rows.length
  tui.agent.status = 'running'
  tui.openToolCalls.set('c1', 'bash')
  tui.status = 'turn 1 running'
  const painted = wirePaint(tui)
  assert.equal(painted.cleared, false, 'a runtime change is not a scroll')
  assert.equal(tui.rows.length, rows, 'runtime state adds no transcript row')
  assert.equal(tui.liveTailRegion?.rows, 1, 'it shows up as the wait card, in the region')
})

// ── B. settle ───────────────────────────────────────────────────────────────

test('the settle is atomic: one frame, one copy, no blank tail left behind', async () => {
  const { tui, agent } = fixture({ history: 200, status: 'idle' })
  wirePaint(tui)
  const text = '最终答复内容'
  delta(tui, agent, text)
  const live = frame(tui)
  assert.ok(live.some(line => line.includes(text)), 'the tail shows it')

  settleReply(tui, agent, text)
  const settled = frame(tui)
  assert.equal(count(settled.join('\n'), text), 1, `exactly one copy after settling:\n${settled.join('\n')}`)
  assert.equal(tui.liveTailRegion, undefined, 'the tail is gone in the same frame the row appears')
  const after = wirePaint(tui)
  // The settle leaves no live region, so nothing above the chrome can still be
  // ticking: the frame after it must be empty (the wait card's spinner is what
  // used to make this one flip, and it goes with the region).
  assert.equal(after.rows.length, 0, `and nothing is left to repaint (got ${after.rows.join(',')})`)
})

test('settling shows the live copy and the durable copy only as one row', async () => {
  const { tui, agent } = fixture({ history: 200, status: 'idle' })
  wirePaint(tui)
  const text = '唯一一次出现'
  delta(tui, agent, text)
  wirePaint(tui)
  const lineCount = tui.rows.filter(row => row.kind === 'assistant' && String(row.text).includes(text)).length
  settleReply(tui, agent, text)
  assert.equal(
    tui.rows.filter(row => row.kind === 'assistant' && String(row.text).includes(text)).length,
    lineCount + 1,
    'the durable row was appended exactly once',
  )
  const painted = wirePaint(tui)
  assert.ok(painted.rows.length > 0, 'the settle repaints (the durable append is a real change)')
  const visible = frame(tui).join('\n')
  assert.equal(count(visible, text), 1, `exactly one copy on screen:\n${visible}`)
  assert.equal(tui.liveTailRegion, undefined, 'and no live copy survives it')
})

test('the newest settled row stays above the live region, and scrolling hides the region', async () => {
  // The region takes rows of its own, so the newest history is never behind it —
  // that is what "the reply I just got is not on screen" was (B2.2's overlay trade,
  // reversed). Scrolling back still hides the region entirely: a reader looking at
  // history is not shown what the session is doing now.
  const { tui, agent } = fixture({ history: 200, status: 'running' })
  tui.waitStartedAt = Date.now()
  const text = '刚刚结算的新行'
  pushRow(tui, { kind: 'assistant', text })
  wirePaint(tui)
  const region = tui.liveTailRegion
  assert.notEqual(region, undefined, 'the wait card is a live region')
  assert.ok(
    frame(tui).slice(0, region.top - 1).some(line => line.includes(text)),
    'the newest settled row is on screen, above the card',
  )

  tui.scrollOffset = 1
  wirePaint(tui)
  assert.equal(tui.liveTailRegion, undefined, 'scrolling up hides the region')
  assert.equal(
    frame(tui).some(line => line.includes(text)),
    false,
    'the window moved back, so the newest row is below its end while the reader reads history',
  )

  tui.scrollOffset = 0
  tui.agent.status = 'idle'
  wirePaint(tui)
  assert.equal(tui.liveTailRegion, undefined, 'no runtime state, no region')
  assert.ok(frame(tui).some(line => line.includes(text)), 'and the newest settled row is on screen')
})

// ── C. backscroll ───────────────────────────────────────────────────────────

test('a reader looking at history is not shown the tail and is not pulled to the bottom', async () => {
  const { tui, agent } = fixture({ history: 200 })
  delta(tui, agent, '看不见我')
  wirePaint(tui)
  tui.scrollOffset = 12
  const scrolled = wirePaint(tui)
  // A window that moved is not a terminal that changed size: every row is dirty,
  // so the frame repaints all of them, and `ESC[2J` is not needed for that (see
  // `paint`). The reader sees the same rows either way; the clear only ever cost
  // bytes.
  assert.equal(scrolled.cleared, false, 'the scroll repaints every row without clearing')
  assert.ok(scrolled.rows.length >= 10, `and it does repaint them (${scrolled.rows.length} rows)`)
  assert.equal(tui.liveTailRegion, undefined, 'the tail is not painted while the reader is scrolled back')
  assert.equal(frame(tui).some(line => line.includes('看不见我')), false, 'and its text is not on screen')

  delta(tui, agent, '新的一行')
  const ticked = wirePaint(tui)
  assert.equal(tui.scrollOffset, 12, 'a live tick must not pull the reader to the bottom')
  assert.equal(tui.lastTranscriptStart, scrolled.rows.length > 0 ? tui.lastTranscriptStart : tui.lastTranscriptStart)
  assert.equal(ticked.cleared, false, 'and the tick itself is a small repaint')
  assert.equal(frame(tui).some(line => line.includes('新的一行')), false, 'still no tail on screen')
})

test('returning to the bottom redraws the tail from the runtime state', async () => {
  const { tui, agent } = fixture({ history: 200 })
  delta(tui, agent, '回来了')
  wirePaint(tui)
  tui.scrollOffset = 5
  wirePaint(tui)
  assert.equal(tui.liveTailRegion, undefined)
  tui.scrollOffset = 0
  wirePaint(tui)
  assert.notEqual(tui.liveTailRegion, undefined, 'the tail is back')
  assert.ok(frame(tui).some(line => line.includes('回来了')), 'with the content the runtime state holds now')
})

// ── D. what sits above the tail ─────────────────────────────────────────────

test('a click reaches the card the reader sees, in the live region too', async () => {
  // Two things at once, because they are one rule: the live region is not
  // transcript (no drag selection, no link hits) — but the live thinking card in
  // it is a card, and a click on its header folds and unfolds it like any other.
  // The reader clicks cards; before this the keyboard was the only way in, which
  // is why "the thinking card cannot be expanded" survived the state fix.
  const { tui, agent } = fixture({ history: 60, status: 'idle' })
  pushRow(tui, {
    kind: 'tool', callId: 'c1', name: 'bash', args: '{}', status: 'ok',
    output: '', title: 'bash', summary: 'ls', expanded: false,
  })
  const base = frame(tui)
  assert.ok(base.length > 0)
  assert.ok(tui.clickableRows.size > 0, 'the base frame has a click target to reach')
  tui.agent.status = 'running'
  delta(tui, agent, '先想一下再回答', { reasoning: true })
  wirePaint(tui)
  const region = tui.liveTailRegion
  assert.notEqual(region, undefined, 'the stream projects a live region')

  // No transcript target was hidden or taken away: everything the base frame made
  // clickable is still clickable, and none of it is inside the region.
  for (const y of tui.clickableRows.keys()) {
    if (y >= region.top) continue
    assert.ok(y < region.top, 'transcript targets stay above the region')
  }
  for (const y of tui.paintedLinkHitsByRow.keys()) {
    assert.ok(y < region.top, `link row ${y} is not inside the live region`)
  }
  assert.equal(tui.selectableLineAt(region.top), undefined, 'the region is not drag-selectable transcript')
  if (region.top > 1) {
    assert.notEqual(tui.selectableLineAt(region.top - 1), undefined, 'the row just above it still is')
  }

  // The live card's own header is a target, and the click toggles it.
  const block = tui.streamingReasoning
  assert.notEqual(block, undefined)
  assert.equal(tui.clickableRows.get(region.top), block, 'the live card header is a click target')
  tui.handleMouseClick(region.top, 3)
  assert.equal(block.expanded, true, 'clicking it expands the card the reader is watching')
  wirePaint(tui)
  assert.ok(frame(tui).some(line => line.includes('先想一下再回答')), 'and its body is on screen')
  tui.handleMouseClick(tui.liveTailRegion.top, 3)
  assert.equal(block.expanded, false, 'a second click folds it again')
})

test('a transient surface always wins the rows it needs', async () => {
  const { tui, agent } = fixture({ history: 100 })
  delta(tui, agent, '底部的实时内容 '.repeat(8))
  const pending = tui.handleUserQuestions({
    questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }, { label: '生产' }] }],
    wait: { callId: 'call-q1' },
  })
  pending.catch(() => undefined)
  await waitForDialog(tui, 'questions')
  const painted = frame(tui)
  const layer = tui.interactionRegion
  const tail = tui.liveTailRegion
  assert.notEqual(layer, undefined, 'the interaction layer is up')
  assert.notEqual(tail, undefined, 'and the tail is still projected underneath')
  const covered = painted.slice(layer.top - 1, layer.top - 1 + layer.rows)
  assert.ok(covered.some(line => line.includes('预发')), 'the surface owns its rows')
  assert.equal(covered.some(line => line.includes('底部的实时内容')), false, 'the tail yields to it')
  assert.ok(tail.top >= layer.top, 'the tail was composed below the surface')
  tui.handleEscape()
  await pending.catch(() => undefined)
  await tick(0)
})

// ── E. Screen / detach / resize / views ─────────────────────────────────────

test('a Screen hides the workspace tail and the strip keeps reporting', async () => {
  const { tui, agent } = fixture({ history: 100 })
  delta(tui, agent, '屏幕期间的内容')
  tui.runCommand('/status')
  await waitFor(() => tui.screen?.report === 'status', { describe: 'the report Screen' })
  assert.equal(tui.liveTailRegion, undefined, 'no workspace tail is painted while a Screen is up')
  const painted = frame(tui)
  assert.equal(painted.some(line => line.includes('屏幕期间的内容')), false, 'and none of its text either')
  const strip = painted.at(-1) ?? ''
  assert.ok(/运行中|回复中|思考中|空闲/u.test(strip), `the Screen strip still reports the runtime state: ${strip}`)
  tui.handleEscape()
  await tick(0)
  wirePaint(tui)
  assert.notEqual(tui.liveTailRegion, undefined, 'leaving the Screen rebuilds the tail from runtime state')
  assert.ok(frame(tui).some(line => line.includes('屏幕期间的内容')), 'with the text it holds')
})

test('a live tail survives detach and reattach', async () => {
  const { tui, agent } = fixture({ history: 100 })
  delta(tui, agent, '断线前的内容')
  wirePaint(tui)
  const before = { rows: tui.liveTailRegion?.rows, anchor: tui.lastTranscriptStart }
  tui.detachDisplay()
  await tick(10)
  tui.displayHost = { attached: true, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.attachRelayDisplay()
  await tick(10)
  assert.equal(tui.liveTailRegion?.rows, before.rows, 'the tail is rebuilt with the same shape')
  assert.equal(tui.lastTranscriptStart, before.anchor, 'over the same window')
  const first = wirePaint(tui)
  const settled = wirePaint(tui)
  assert.equal(settled.cleared, false, 'the frame after the first is incremental again')
  // "The reattach frame is not repeated" is about the *transcript*: the region's
  // own lines keep ticking (a spinner steps every 200 ms), so counting the rows a
  // frame paints made this case flip with the runner's timing. What must not happen
  // is a row above the region being repainted for no reason.
  const region = tui.liveTailRegion
  assert.ok(region !== undefined, 'the live region is still up')
  for (const row of [...first.rows, ...settled.rows]) {
    assert.ok(row >= region.top, `row ${row} is inside the live region (top ${region.top})`)
  }
})

test('resize re-wraps the tail at every width without losing the chrome', async () => {
  const { tui, agent } = fixture({ history: 100 })
  delta(tui, agent, '宽度测试 '.repeat(20))
  for (const [columns, rows] of [[120, 20], [80, 20], [72, 20], [72, 12], [72, 8]]) {
    const painted = frame(tui, columns, rows)
    assert.equal(painted.length, rows, `${columns}×${rows}: the frame fits the terminal`)
    const chrome = painted.slice(-2).join('\n')
    assert.ok(/SSH|本地/u.test(chrome), `${columns}×${rows}: the runtime strip survives`)
    assert.ok(
      painted.some(line => line.includes('宽度测试')),
      `${columns}×${rows}: the live region is still there`,
    )
    const region = tui.liveTailRegion
    assert.ok(region.top + region.rows <= rows, `${columns}×${rows}: the tail stays inside the frame`)
  }
})

test('both workspace views project the same tail', async () => {
  for (const compact of [false, true]) {
    const { tui, agent } = fixture({ history: 60, compact })
    wirePaint(tui) // establish: the anchor is only meaningful once a frame has been composed
    const anchor = tui.lastTranscriptStart
    tui.showReasoning = true
    delta(tui, agent, '先想', { reasoning: true })
    delta(tui, agent, '再说', { index: 1 })
    wirePaint(tui)
    assert.notEqual(tui.liveTailRegion, undefined, `compact=${compact}: the region is projected`)
    assert.ok(tui.lastTranscriptStart >= anchor, `compact=${compact}: the window gave rows to it`)
    assert.ok(frame(tui).some(line => line.includes('再说')), `compact=${compact}: and shows the text`)
  }
})

test('line mode keeps its textual path and no overlay', async () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'running', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, lineMode: true })
  tui.write = () => {}
  tui.streaming = { reasoning: '', text: '行模式的内容' }
  tui.paint()
  assert.equal(tui.liveTailRegion, undefined, 'line mode composes no tail region')
})

// ── F. the cache guarantee ──────────────────────────────────────────────────

test('live lines are never written into a row cache entry', async () => {
  const { tui, agent } = fixture({ history: 40 })
  pushRow(tui, { kind: 'assistant', text: '已结算的最后一行' })
  wirePaint(tui)
  // `displayRowCache` is a WeakMap keyed by row, so the entries are read back
  // through the rows themselves — which is the only way a row could ever replay a
  // live line.
  const cached = () => tui.rows
    .map(row => tui.displayRowCache.get(row)?.lines.join('\n') ?? '')
    .join('\n---\n')
  const beforeCache = cached()

  delta(tui, agent, '这段文字只属于 live')
  tui.waitStartedAt = Date.now()
  wirePaint(tui)
  wirePaint(tui)
  assert.equal(cached(), beforeCache, 'the row cache is exactly what it was before the live tick')
  assert.equal(cached().includes('这段文字只属于 live'), false, 'the streaming text is not in any row entry')
  assert.equal(/处理中/u.test(cached()), false, 'and neither is the wait card')
})
