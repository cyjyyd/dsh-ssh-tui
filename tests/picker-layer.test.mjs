/**
 * B1.2 — the picker is a layer, and the composer has a boundary.
 *
 * A control-plane menu (`/model`, `/view`, `/theme`, the preset wizard …) is not a
 * question from the agent: nobody is blocked on it and answering it changes the
 * environment rather than the task. It shares the *rendering* infrastructure of a
 * task interaction and none of its semantics — so it must not be allowed to
 * redefine the history viewport either.
 *
 * Before this round a picker was composed into the transcript's budget
 * (`available = height - reserved - pickerLines.length`), so opening one
 * re-windowed the transcript, moved the anchor, and full-cleared the frame. Now it
 * takes the same transient layer a question does: it covers rows, it does not own
 * them, and the composer's boundary row is always below the last of them.
 *
 * These cases pin the four things the migration claims — anchor stability, one
 * layer, no click-through, and a boundary that survives every surface — plus the
 * conflict policy for a question and a menu that want the keyboard at once.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { visibleWidth } from '../lib/term-text.js'
import { SshTui } from '../lib/tui.js'
import { pushRow, seedPlan, tick, waitFor, waitForDialog } from './wait.mjs'

setLocale('zh')

const COLUMNS = 100
const ROWS = 20

const QUESTION_STATE = {
  questions: {
    active: [{ callId: 'call-q1', questions: [{ id: 'q1', question: '要部署到哪个环境？' }], state: 'open' }],
    settled: [],
  },
}

function fixture(options = {}) {
  const state = options.state ?? structuredClone(QUESTION_STATE)
  const ctx = {
    get: name => {
      if (name === 'sessionProjections') return { stateOf: () => state }
      if (name === 'userQuestions') return options.userQuestions
      if (name === 'appExit') return () => {}
      return undefined
    },
    on() { return () => {} },
  }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  for (let index = 0; index < 60; index += 1) {
    pushRow(tui, { kind: index % 2 === 0 ? 'assistant' : 'user', text: `${index % 2 === 0 ? '回复' : '提问'} ${index}` })
  }
  return { tui, state, agent }
}

const plain = line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').trimEnd()

/** Paint, then read what that frame decided. */
function frame(tui, columns = COLUMNS, rows = ROWS) {
  const lines = tui.captureFrame(columns, rows).map(plain)
  return {
    lines,
    start: tui.lastTranscriptStart,
    scrollOffset: tui.scrollOffset,
    region: tui.interactionRegion,
    rows: tui.rows.length,
  }
}

/** The composer's boundary row, 1-based, or -1 when the frame has none. */
const boundaryOf = painted => painted.lines.findIndex(line => line.startsWith('╭')) + 1
const composerOf = painted => painted.lines.findIndex(line => line.trimStart().startsWith('>')) + 1

const covered = (painted) => {
  const region = painted.region
  return region === undefined ? [] : painted.lines.slice(region.top - 1, region.top - 1 + region.rows)
}

/**
 * The shared entry every control-plane menu uses — the same function `/model`,
 * `/view` and the preset wizard call. Options are the caller's; the role is not.
 */
const openMenu = (tui, count = 3) => {
  const pending = tui.askQuestion({
    id: 'pick',
    question: '切换到哪个模型？',
    options: Array.from({ length: count }, (_option, index) => ({ label: `模型 ${index + 1}` })),
  }, 0, 1)
  pending.catch(() => undefined)
  return pending
}

/** A real command, typed the way a reader types it: this is the wiring, not the helper. */
async function openViewMenu(tui) {
  tui.handleChar('/')
  for (const char of 'view') tui.handleChar(char)
  tui.handleChar('\r')
  await waitForDialog(tui, 'questions')
}

/** The session event a question leaves behind; its card is a clickable row. */
const askEvent = () => ({
  type: 'tool/call',
  seq: 1,
  time: Date.now(),
  data: {
    callId: 'call-q1',
    name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [{ id: 'q1', question: '要部署到哪个环境？', timeout: 60_000 }] }),
  },
})

const openQuestion = (tui) => {
  const pending = tui.handleUserQuestions({
    questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }, { label: '生产' }] }],
    wait: { callId: 'call-q1' },
  })
  pending.catch(() => undefined)
  return pending
}

// ── A. the migration itself ─────────────────────────────────────────────────

test('a command menu opens as a layer: the transcript window is what it was', async () => {
  const { tui, agent } = fixture()
  const before = frame(tui)
  await openViewMenu(tui)
  const after = frame(tui)
  const region = after.region
  assert.notEqual(region, undefined, 'the picker composes a region')
  assert.equal(after.start, before.start, 'and the window start is the one the base frame had')
  assert.equal(after.scrollOffset, before.scrollOffset)
  assert.equal(after.rows, before.rows, 'no card was appended: the menu is not a transcript event')
  const rows = covered(after)
  assert.ok(rows.some(line => line.includes('视图')), `the menu is in the region:\n${rows.join('\n')}`)
  assert.ok(rows.some(line => line.includes('Enter')), 'and so is its key hint')
  tui.handleEscape()
  await tick(0)
})

test('closing the menu puts the same frame back', async () => {
  const { tui, agent } = fixture()
  const before = frame(tui)
  const pending = openMenu(tui, 5)
  await waitForDialog(tui, 'questions')
  const during = frame(tui)
  assert.notEqual(during.region, undefined)
  tui.handleEscape()
  await pending.catch(() => undefined)
  await tick(0)
  const after = frame(tui)
  assert.equal(after.region, undefined, 'the layer is gone')
  assert.equal(after.start, before.start, 'and the window never moved')
  assert.equal(after.scrollOffset, before.scrollOffset)
  assert.deepEqual(after.lines, before.lines, 'the base frame is restored row for row')
})

test('every control-plane menu goes through the same layer, whatever it lists', async () => {
  for (const count of [2, 9, 14]) {
    const { tui, agent } = fixture()
    const before = frame(tui)
    const pending = openMenu(tui, count)
    await waitForDialog(tui, 'questions')
    const after = frame(tui)
    assert.notEqual(after.region, undefined, `${count} options: the menu is a layer`)
    assert.equal(after.start, before.start, `${count} options: the anchor is stable`)
    tui.handleEscape()
    await pending.catch(() => undefined)
    await tick(0)
  }
})

// ── B. history mode ─────────────────────────────────────────────────────────

test('a reader looking at history is not pulled to the bottom by a menu', async () => {
  const { tui, agent } = fixture()
  tui.scrollOffset = 12
  const before = frame(tui)
  assert.equal(before.scrollOffset, 12, 'the fixture really is scrolled back')
  const pending = openMenu(tui, 6)
  await waitForDialog(tui, 'questions')
  const after = frame(tui)
  assert.equal(after.scrollOffset, 12, 'the menu did not scroll the transcript')
  assert.equal(after.start, before.start, 'nor re-window it')
  // Every row above the layer is the row that was there before it: the reader is
  // still looking at the same history, with a menu drawn over its bottom.
  const top = tui.transcriptTopScreenY - 1
  const above = after.region.top - 1
  assert.deepEqual(
    after.lines.slice(top, above - 1),
    before.lines.slice(top, above - 1),
    'the rows above the layer are untouched',
  )
  tui.handleEscape()
  await pending.catch(() => undefined)
  await tick(0)
})

test('a menu leaves the search and the selection where they were', async () => {
  const { tui, agent } = fixture()
  // A search and a mouse selection are transcript state; a control-plane menu is
  // not allowed to be a way of losing them.
  tui.handleChar('/')
  await tick(0)
  tui.handleEscape()
  const before = { hits: tui.searchHits.length, index: tui.searchIndex, offset: tui.scrollOffset }
  const pending = openMenu(tui, 4)
  await waitForDialog(tui, 'questions')
  assert.equal(tui.searchHits.length, before.hits, 'the search hits are the same')
  assert.equal(tui.searchIndex, before.index, 'and so is the current hit')
  assert.equal(tui.scrollOffset, before.offset)
  tui.handleEscape()
  await pending.catch(() => undefined)
  await tick(0)
  assert.equal(tui.searchHits.length, before.hits, 'and after it closes, still the same')
})

// ── C. the boundary ─────────────────────────────────────────────────────────

test('the composer boundary is the row right below the layer, in every state', async () => {
  const { tui, agent } = fixture()
  const states = []
  states.push(['plain', frame(tui)])
  const question = openQuestion(tui)
  await waitForDialog(tui, 'questions')
  states.push(['interaction', frame(tui)])
  const menu = openMenu(tui, 5)
  await waitForDialog(tui, 'questions')
  // The question is still up: the menu is queued, so this frame is still the
  // interaction's. Answer it to get to the picker.
  tui.handleChar('\r')
  await question.catch(() => undefined)
  await waitFor(() => tui.dialog?.question?.id === 'pick', { describe: 'the queued menu' })
  states.push(['picker', frame(tui)])
  tui.handleEscape()
  await menu.catch(() => undefined)
  await tick(0)
  states.push(['after', frame(tui)])

  for (const [label, painted] of states) {
    const boundary = boundaryOf(painted)
    const composer = composerOf(painted)
    assert.ok(boundary > 0, `${label}: the boundary row is drawn`)
    assert.equal(boundary + 1, composer, `${label}: and it is the row directly above the composer`)
    assert.equal(painted.lines.length, ROWS, `${label}: the frame is still exactly as tall`)
    if (painted.region !== undefined) {
      assert.equal(
        painted.region.top + painted.region.rows,
        boundary,
        `${label}: the layer stops at the boundary`,
      )
    }
  }
  // The boundary is not a second rule: the banner's separator is the only other
  // one, and it is drawn above the transcript.
  const painted = states[2][1]
  assert.equal(painted.lines.filter(line => line.startsWith('╭')).length, 1, 'exactly one boundary row')
})

test('the boundary survives a short terminal and stays out of the layer', async () => {
  const { tui, agent } = fixture()
  const pending = openMenu(tui, 14)
  await waitForDialog(tui, 'questions')
  for (const [columns, rows] of [[120, 20], [80, 20], [72, 20], [72, 12], [72, 8]]) {
    const painted = frame(tui, columns, rows)
    const boundary = boundaryOf(painted)
    const composer = composerOf(painted)
    assert.ok(boundary > 0, `${columns}×${rows}: the boundary is drawn`)
    assert.ok(composer > boundary, `${columns}×${rows}: the composer is below it`)
    assert.equal(painted.lines.length, rows, `${columns}×${rows}: the frame fits the terminal`)
    for (const [index, line] of painted.lines.entries()) {
      assert.ok(
        visibleWidth(line) <= columns,
        `${columns}×${rows}: row ${index + 1} fits the width (${visibleWidth(line)})`,
      )
    }
    if (painted.region !== undefined) {
      assert.equal(painted.region.top + painted.region.rows, boundary, `${columns}×${rows}: layer stops at the boundary`)
      assert.ok(covered(painted).some(line => line.includes('›')), `${columns}×${rows}: the highlight is on screen`)
      assert.ok(
        covered(painted).some(line => line.includes('Enter')),
        `${columns}×${rows}: the key hint is on screen`,
      )
    }
  }
  tui.handleEscape()
  await pending.catch(() => undefined)
  await tick(0)
})

// ── D. dirty repaint (weak link) ────────────────────────────────────────────

/** Paint for real and read the bytes: `captureFrame` swaps `write` out. */
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
    rows: [...painted.matchAll(/\u001b\[(\d+);1H/gu)].map(match => Number(match[1])),
    cleared: /\u001b\[[HJ]|\u001b\[2J/u.test(painted),
    bytes: painted.length,
  }
}

test('moving the highlight repaints the layer, not the history above it', async () => {
  const { tui, agent } = fixture()
  const pending = openMenu(tui, 4)
  await waitForDialog(tui, 'questions')
  const painted = frame(tui)
  const region = painted.region
  assert.notEqual(region, undefined)
  assert.ok(region.top > 6, `the layer leaves history above it (top ${region.top})`)

  tui.handleData(Buffer.from('\x1b[B'))
  const move = wirePaint(tui, COLUMNS, ROWS)
  assert.equal(move.cleared, false, 'a selection move does not clear the screen')
  assert.ok(move.rows.length > 0, 'it painted something')
  assert.ok(
    move.rows.every(row => row >= region.top),
    `every addressed row is inside the layer or below it (${move.rows.join(',')} vs top ${region.top})`,
  )
  // The layer and the composer rows below it — never the transcript rows above.
  const reachable = ROWS - region.top + 1
  assert.ok(
    move.rows.length <= reachable,
    `a selection move addresses the layer and the chrome below it (${move.rows.length} of ${reachable})`,
  )
  tui.handleEscape()
  await pending.catch(() => undefined)
  await tick(0)
})

test('opening and closing a menu never clears the screen', async () => {
  const { tui, agent } = fixture()
  wirePaint(tui, COLUMNS, ROWS)
  const pending = openMenu(tui, 14)
  await waitForDialog(tui, 'questions')
  const open = wirePaint(tui, COLUMNS, ROWS)
  assert.equal(open.cleared, false, `open: no clear (${open.bytes}B)`)
  tui.handleEscape()
  await pending.catch(() => undefined)
  await tick(0)
  const close = wirePaint(tui, COLUMNS, ROWS)
  assert.equal(close.cleared, false, `close: no clear (${close.bytes}B), the covered rows are repainted`)
  assert.ok(close.rows.length >= 5, 'the rows the layer hid are painted back')
})

// ── E. input ownership ──────────────────────────────────────────────────────

test('the menu keeps its keys and the transcript keeps out of the way', async () => {
  const { tui, agent } = fixture()
  tui.input = '请检查 reconnect'
  tui.cursor = tui.input.length
  tui.history.push('上一条消息')
  tui.historyIndex = tui.history.length
  const before = frame(tui)
  const pending = openMenu(tui, 5)
  await waitForDialog(tui, 'questions')
  tui.handleData(Buffer.from('\x1b[B'))
  tui.handleData(Buffer.from('\x1b[B'))
  assert.equal(tui.dialog?.cursor, 2, 'the list still moves')
  assert.equal(tui.input, '请检查 reconnect', 'the composer draft is untouched')
  assert.equal(tui.historyIndex, tui.history.length, 'and history was not browsed')
  const moved = frame(tui)
  assert.equal(moved.scrollOffset, before.scrollOffset, 'the transcript did not scroll')
  assert.equal(moved.start, before.start, 'nor re-window')
  const highlight = covered(moved).filter(line => line.includes('›'))
  assert.deepEqual(highlight, [' ›3 ● 模型 3'], 'the highlight moved inside the layer, and only there')
  tui.handleEscape()
  await pending.catch(() => undefined)
  await tick(0)
  assert.equal(tui.input, '请检查 reconnect', 'and the draft survived the menu')
})

test('a wheel or a click cannot reach the transcript through the layer', async () => {
  const { tui, agent } = fixture()
  tui.handleSessionEvent({ id: 'main-session' }, askEvent())
  const base = frame(tui)
  assert.ok(tui.clickableRows.size > 0, 'the base frame has a clickable row')
  assert.equal(base.region, undefined)
  const pending = openMenu(tui, 8)
  await waitForDialog(tui, 'questions')
  const painted = frame(tui)
  const region = painted.region
  assert.notEqual(region, undefined)
  for (const y of tui.clickableRows.keys()) {
    assert.ok(y < region.top, `clickable row ${y} sits under the layer (top ${region.top})`)
  }
  for (const y of tui.paintedLinkHitsByRow.keys()) {
    assert.ok(y < region.top, `link row ${y} sits under the layer`)
  }
  assert.equal(tui.selectableLineAt(region.top), undefined, 'the first covered row is not selectable')
  assert.equal(tui.selectableLineAt(region.top + region.rows - 1), undefined, 'nor the last')
  if (region.top > 1) {
    assert.notEqual(tui.selectableLineAt(region.top - 1), undefined, 'the row above it still is')
  }
  // The wheel is dropped rather than scrolling the history behind the menu.
  const before = tui.scrollOffset
  tui.handleData(Buffer.from('\x1b[<64;10;10M'))
  assert.equal(tui.scrollOffset, before, 'the wheel did not move the transcript')
  tui.handleEscape()
  await pending.catch(() => undefined)
  await tick(0)
})

// ── F. conflict policy ──────────────────────────────────────────────────────

test('a menu cannot cover a question that owns the keyboard', async () => {
  const { tui, agent } = fixture()
  const question = openQuestion(tui)
  await waitForDialog(tui, 'questions')
  const asked = frame(tui)
  const menu = openMenu(tui, 4)
  await tick(0)
  const still = frame(tui)
  assert.equal(still.region?.top, asked.region?.top, 'the layer is the interaction, unchanged')
  assert.ok(covered(still).some(line => line.includes('预发')), 'the question is still the one being asked')
  assert.equal(covered(still).some(line => line.includes('模型 1')), false, 'the menu did not draw over it')
  assert.equal(tui.dialogRole.kind, 'interaction', 'and the keyboard still belongs to the question')
  // Answering it hands the keyboard to the menu, which was waiting, not lost.
  tui.handleChar('\r')
  await question.catch(() => undefined)
  await waitFor(() => tui.dialog?.question?.id === 'pick', { describe: 'the queued menu to open' })
  const next = frame(tui)
  assert.ok(covered(next).some(line => line.includes('模型 1')), 'the menu opens once the question is answered')
  assert.equal(next.start, asked.start, 'and the window is still the same one')
  tui.handleEscape()
  await menu.catch(() => undefined)
  await tick(0)
})

test('a question arriving behind a menu waits for it, and the footer says so', async () => {
  const { tui, agent } = fixture()
  const menu = openMenu(tui, 4)
  await waitForDialog(tui, 'questions')
  const before = frame(tui)
  const question = openQuestion(tui)
  await tick(0)
  const during = frame(tui)
  assert.ok(covered(during).some(line => line.includes('模型 1')), 'the menu keeps the screen: nothing is replaced under the reader')
  assert.equal(during.region?.rows, before.region?.rows)
  assert.equal(during.scrollOffset, before.scrollOffset, 'the reader is still following the tail')
  // The question's own card is a durable transcript event, and *that* is what adds
  // a row: the layer changing hands is not allowed to move the window at all.
  assert.equal(during.rows, before.rows + 1, 'the question appended its card')
  assert.equal(during.start, before.start + 1, 'and the append, not the surface, moved the window')
  tui.handleEscape()
  await menu.catch(() => undefined)
  await waitFor(() => tui.dialogRole.kind === 'interaction', { describe: 'the question to take over' })
  const after = frame(tui)
  assert.ok(covered(after).some(line => line.includes('预发')), 'the question is up now')
  assert.equal(after.rows, during.rows, 'over the same log')
  assert.equal(after.start, during.start, 'and the same window')
  tui.handleChar('\r')
  await question.catch(() => undefined)
  await tick(0)
})

test('a question takes the keyboard ahead of a menu that is already waiting', async () => {
  const { tui, agent } = fixture()
  const first = openMenu(tui, 3)
  await waitForDialog(tui, 'questions')
  const queued = openMenu(tui, 4)
  const question = openQuestion(tui)
  await tick(0)
  // Answer the active one; the *question* must be next, not the menu that arrived
  // first — someone is blocked on it.
  tui.handleChar('\r')
  await first.catch(() => undefined)
  await waitFor(() => tui.dialogRole.kind === 'interaction', { describe: 'the question to take the queue' })
  const painted = frame(tui)
  assert.ok(covered(painted).some(line => line.includes('预发')), 'the interaction is what opened')
  tui.handleChar('\r')
  await question.catch(() => undefined)
  await waitFor(() => tui.dialog?.question?.id === 'pick', { describe: 'the queued menu' })
  tui.handleEscape()
  await queued.catch(() => undefined)
  await tick(0)
})

// ── G. what must not change ─────────────────────────────────────────────────

test('both workspace views keep the picker contract', async () => {
  for (const view of ['detailed', 'compact']) {
    const { tui, agent } = fixture()
    tui.setWorkspaceView(view)
    const before = frame(tui)
    const pending = openMenu(tui, 6)
    await waitForDialog(tui, 'questions')
    const after = frame(tui)
    assert.equal(after.start, before.start, `${view}: the window start is stable`)
    assert.equal(after.scrollOffset, before.scrollOffset, `${view}: and the offset is stable`)
    assert.notEqual(after.region, undefined, `${view}: the layer exists`)
    assert.equal(after.region.top + after.region.rows, boundaryOf(after), `${view}: and stops at the boundary`)
    tui.handleEscape()
    await pending.catch(() => undefined)
    await tick(0)
  }
})

test('a menu and the plan dock never compete for the same rows', async () => {
  // The dock already yields to any dialog (B1.1 left that alone), so "picker >
  // plan dock" needs no third layer: the dock is simply not drawn while a menu is
  // up. This pins the decision rather than the drawing.
  const { tui, agent } = fixture()
  seedPlan(tui, agent, {
    todos: [{ content: '找到失败的步骤', status: 'in_progress' }],
    body: '# 修复构建',
  })
  // The dock row carries the plan's own title; the footer carries the *mode* as
  // its activity text and must keep saying it, so the title is what identifies the
  // dock rather than the word 计划模式 (which is legitimately on both).
  const dock = line => line.includes('修复构建')
  const base = frame(tui)
  assert.ok(base.lines.some(dock), 'the dock is in the base frame')
  const pending = openMenu(tui, 6)
  await waitForDialog(tui, 'questions')
  const after = frame(tui)
  const region = after.region
  assert.notEqual(region, undefined)
  assert.equal(
    after.lines.some(dock),
    false,
    `the dock must not share the frame with a menu:\n${after.lines.join('\n')}`,
  )
  assert.equal(covered(after).some(dock), false, 'and not inside the layer either')
  assert.ok(after.lines.some(line => line.includes('计划模式')), 'while the footer still reports the plan mode')
  tui.handleEscape()
  await pending.catch(() => undefined)
  await tick(0)
})

test('a menu survives a detach and comes back over the same window', async () => {
  const { tui, agent } = fixture()
  const before = frame(tui)
  const pending = openMenu(tui, 6)
  await waitForDialog(tui, 'questions')
  assert.notEqual(frame(tui).region, undefined)
  tui.detachDisplay()
  await tick(10)
  tui.displayHost = { attached: true, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.attachRelayDisplay()
  await tick(10)
  const after = frame(tui)
  assert.notEqual(after.region, undefined, 'the layer came back with the display')
  assert.equal(after.start, before.start, 'over the window the reader had before the drop')
  assert.equal(after.scrollOffset, before.scrollOffset)
  assert.ok(covered(after).some(line => line.includes('模型 1')), 'and it is still the menu that owns the keyboard')
  tui.handleEscape()
  await pending.catch(() => undefined)
  await tick(0)
})

test('a dedicated screen still takes its rows out of the transcript', async () => {
  // Onboarding is a whole screen with its own state machine, not a layer over this
  // one. B1.2 moved the picker and left it alone: if a later change routes every
  // dialog through the layer, this is the case that says so.
  const { tui, agent } = fixture()
  const before = frame(tui)
  void tui.runOnboarding()
  await tick(0)
  const after = frame(tui)
  assert.equal(after.region, undefined, 'a dedicated screen is not a layer')
  assert.notEqual(after.start, before.start, 'it re-windows the transcript, as it always did')
})

test('line mode composes no layer for a menu', async () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, lineMode: true })
  tui.write = () => {}
  const pending = tui.askQuestion({ id: 'pick', question: '切换到哪个模型？', options: [{ label: 'a' }, { label: 'b' }] }, 0, 1)
  pending.catch(() => undefined)
  await waitFor(() => tui.rows.some(row => String(row.text).includes('切换到哪个模型')), { describe: 'the echoed menu' })
  assert.equal(tui.interactionRegion, undefined, 'line mode has no framed layer')
  tui.handleChar('\r')
  await pending.catch(() => undefined)
  await tick(0)
})
