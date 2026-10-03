/**
 * B1.1 — the interaction region.
 *
 * A task interaction used to be composed *into* the transcript's budget:
 * `available = height - reserved - dialogLines.length`. So asking a question
 * re-windowed the transcript — the reader lost the bottom rows of history, the
 * anchor jumped, and the interaction read as part of the workspace rather than as
 * something drawn over it.
 *
 * The interaction now takes the rows immediately above the composer and replaces
 * whatever the base frame put there. The transcript window is computed without
 * knowing the interaction exists, so its anchor, its scroll offset and its source
 * rows are the same with or without it. These cases pin that, and pin the control
 * that must NOT change yet: a real transcript append still moves the tail. (The
 * other control B1.1 recorded — "a picker still squeezes, that is B1.2" — was the
 * B1.2 to-do; it now lives inverted in `picker-layer.test.mjs`.)
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
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

/** The session event a timed question leaves behind, which is what draws the card. */
function askEvent(callId = 'call-q1') {
  return {
    type: 'tool/call',
    seq: 1,
    time: Date.now(),
    data: {
      callId,
      name: 'ask_user_question',
      arguments: JSON.stringify({ questions: [{ id: 'q1', question: '要部署到哪个环境？', timeout: 60_000 }] }),
    },
  }
}

const plain = line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').trimEnd()

/** Paint, then read what that frame decided. */
function frame(tui, columns = COLUMNS, rows = ROWS) {
  const lines = tui.captureFrame(columns, rows).map(plain)
  return { lines, start: tui.lastTranscriptStart, scrollOffset: tui.scrollOffset, region: tui.interactionRegion }
}

/**
 * The rows above the interaction, compared by *index*.
 *
 * The base frame has no region, so slicing it by "its region top" would compare a
 * whole frame against a truncated one — the first version of this file did exactly
 * that and failed for the wrong reason.
 */
function prefix(painted, rows) {
  return painted.lines.slice(0, rows)
}

function sameAbovedRows(before, after) {
  const rows = after.region.top - 1
  assert.deepEqual(
    prefix(after, rows),
    prefix(before, rows),
    `${rows} rows above the layer must be the base frame, row for row`,
  )
}

/**
 * Open a question and wait only for the *dialog*.
 *
 * The pending promise resolves when the human answers, so an `async` helper that
 * returned it would await the answer itself and the case would hang instead of
 * testing anything — which is exactly what the first version of this file did.
 */
function openQuestion(tui, extra = {}) {
  const pending = tui.handleUserQuestions({
    questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }, { label: '生产' }] }],
    wait: { callId: 'call-q1' },
    ...extra,
  }).catch(() => undefined)
  return pending
}

function openApproval(tui) {
  return tui.handleApproval({ toolName: 'bash', reason: 'runs a build', agent: { id: 'main-session' } }).catch(() => undefined)
}

// ── A. open / close ─────────────────────────────────────────────────────────

test('an ask-user interaction does not move the transcript window', async () => {
  const { tui, agent } = fixture()
  tui.handleSessionEvent({ id: 'main-session' }, askEvent())
  const before = frame(tui)
  const pending = openQuestion(tui)
  await waitForDialog(tui, 'questions')
  const after = frame(tui)

  assert.equal(after.start, before.start, 'the window start is the same')
  assert.equal(after.scrollOffset, before.scrollOffset, 'and so is the scroll offset')
  assert.notEqual(after.region, undefined, 'the interaction was drawn as its own layer')
  sameAbovedRows(before, after)
})

test('an approval does not move the transcript window', async () => {
  const { tui, agent } = fixture()
  const before = frame(tui)
  const pending = openApproval(tui)
  await waitForDialog(tui, 'confirm')
  const after = frame(tui)
  assert.equal(after.start, before.start)
  assert.equal(after.scrollOffset, before.scrollOffset)
  sameAbovedRows(before, after)
  tui.handleChar('n')
  await pending
})

test('answering closes the interaction and leaves the history where it was', async () => {
  const { tui, agent } = fixture()
  tui.handleSessionEvent({ id: 'main-session' }, askEvent())
  const before = frame(tui)
  const pending = openQuestion(tui)
  await waitForDialog(tui, 'questions')
  const during = frame(tui)
  assert.equal(during.start, before.start)
  tui.handleChar('\r')
  await pending.catch(() => undefined)
  await tick(0)
  const after = frame(tui)
  assert.equal(after.region, undefined, 'the layer is gone')
  assert.equal(after.start, before.start, 'and the window never moved')
  assert.equal(after.scrollOffset, before.scrollOffset)
})

test('the interaction is drawn immediately above the composer', async () => {
  const { tui, agent } = fixture()
  tui.handleSessionEvent({ id: 'main-session' }, askEvent())
  const pending = openQuestion(tui)
  await waitForDialog(tui, 'questions')
  const painted = frame(tui)
  const region = painted.region
  assert.notEqual(region, undefined)
  const covered = painted.lines.slice(region.top - 1, region.top - 1 + region.rows)
  assert.ok(covered.some(line => line.includes('要部署到哪个环境？')), 'the question is in the region')
  assert.ok(covered.some(line => line.includes('预发')), 'so are its options')
  // The composer keeps its place: the boundary row is the row right after the
  // layer. It is the input's corner (B1.2), not the banner's plain rule.
  assert.ok(
    painted.lines[region.top - 1 + region.rows]?.startsWith('╭'),
    'the composer boundary still follows it',
  )
  tui.handleEscape()
  await pending
})

// ── B. scroll position ──────────────────────────────────────────────────────

test('a reader looking at history is not pulled back to the bottom', async () => {
  const { tui, agent } = fixture()
  tui.handleSessionEvent({ id: 'main-session' }, askEvent())
  tui.scrollOffset = 12
  const before = frame(tui)
  assert.equal(before.scrollOffset, 12, 'the fixture really is scrolled back')
  const pending = openQuestion(tui)
  await waitForDialog(tui, 'questions')
  const after = frame(tui)
  assert.equal(after.scrollOffset, 12, 'the interaction did not scroll the transcript')
  assert.equal(after.start, before.start)
  sameAbovedRows(before, after)
  tui.handleEscape()
  await pending
  assert.equal(frame(tui).scrollOffset, 12, 'and closing it does not either')
})

test('a real transcript append still follows the tail, with or without a layer', async () => {
  // The interaction may cover history; it may not freeze the tail. An append that
  // arrives while the layer is up is still ordinary tail-follow.
  const { tui, agent } = fixture()
  tui.handleSessionEvent({ id: 'main-session' }, askEvent())
  const pending = openQuestion(tui)
  await waitForDialog(tui, 'questions')
  const before = frame(tui)
  pushRow(tui, { kind: 'system', text: '后台任务已完成' })
  const after = frame(tui)
  assert.equal(after.scrollOffset, 0, 'the reader is still following the tail')
  assert.equal(after.start, before.start + 1, 'and the window followed the append by one line')
  assert.notEqual(after.region, undefined, 'the layer is still up')
  tui.handleEscape()
  await pending
})

test("an append keeps a scrolled reader's distance from the tail", async () => {
  // `scrollOffset` is a distance *back from the tail*, so an append moves the rows
  // under it by one: the reader keeps their offset, gains the newest line at the
  // bottom and loses one at the top. That is the pre-existing tail-follow rule and
  // B1.1 does not change it — what B1.1 owns is that the *interaction* neither
  // scrolls nor re-windows, which the cases above pin. Pinned-content anchoring
  // (the viewport holding still while the log grows) would be a separate change to
  // the tail-follow model, and is deliberately not in this round.
  const { tui, agent } = fixture()
  tui.handleSessionEvent({ id: 'main-session' }, askEvent())
  tui.scrollOffset = 8
  const pending = openQuestion(tui)
  await waitForDialog(tui, 'questions')
  const before = frame(tui)
  pushRow(tui, { kind: 'system', text: '后台任务已完成' })
  const after = frame(tui)
  assert.equal(after.scrollOffset, 8, 'the reader keeps their distance from the tail')
  assert.equal(after.start, before.start + 1, 'and the window index follows the longer log')
  const top = tui.transcriptTopScreenY - 1 // header rows: banner, divider, the scrolled notice
  const above0 = after.region.top - 1
  assert.deepEqual(
    after.lines.slice(top, above0 - 1),
    before.lines.slice(top + 1, above0),
    'the transcript rows above the layer are the previous ones, shifted up by one',
  )
  tui.handleEscape()
  await pending
})

test('a settled question card is drawn from the Session, not from a request', async () => {
  const { tui, state } = fixture()
  tui.handleSessionEvent({ id: 'main-session' }, askEvent())
  state.questions = {
    active: [],
    settled: [{ callId: 'call-q1', answers: [{ id: 'q1', selected: ['预发'] }] }],
  }
  tui.handleSessionEvent({ id: 'main-session' }, {
    type: 'tool/result',
    seq: 3,
    time: Date.now(),
    data: {
      message: {
        role: 'tool',
        source: { callId: 'call-q1' },
        content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'q1', selected: ['预发'] }] }) }],
      },
    },
  })
  const card = tui.rows.find(row => row.kind === 'question')
  assert.equal(card?.status, 'answered')
  assert.equal(card?.summary, '预发')
  assert.equal(frame(tui).region, undefined, 'no interaction is open')
})

// ── D. resize ───────────────────────────────────────────────────────────────

test('a resize re-renders the layer without moving the anchor', async () => {
  const { tui, agent } = fixture()
  tui.handleSessionEvent({ id: 'main-session' }, askEvent())
  const pending = openQuestion(tui)
  await waitForDialog(tui, 'questions')
  const first = frame(tui, 120, 20)
  assert.equal(first.scrollOffset, 0)
  const narrow = frame(tui, 72, 20)
  assert.equal(narrow.scrollOffset, 0, 'a resize does not scroll the transcript')
  const wide = frame(tui, 160, 20)
  assert.equal(wide.scrollOffset, 0)
  for (const painted of [narrow, wide]) {
    const region = painted.region
    assert.notEqual(region, undefined, 'the layer survives')
    const covered = painted.lines.slice(region.top - 1, region.top - 1 + region.rows)
    assert.ok(covered.some(line => line.includes('预发')), 'and still shows its options')
    assert.equal(
      painted.lines.filter(line => line.includes('要部署到哪个环境？')).length,
      1,
      'exactly one copy of the interaction: no stale rows left behind',
    )
  }
  tui.handleEscape()
  await pending
})

test('a shorter terminal keeps the interaction answerable', async () => {
  const { tui, agent } = fixture()
  tui.handleSessionEvent({ id: 'main-session' }, askEvent())
  const pending = tui.handleUserQuestions({
    questions: [{
      id: 'q1',
      question: '要部署到哪个环境？',
      options: Array.from({ length: 10 }, (_option, index) => ({ label: `选项 ${index + 1}` })),
    }],
    wait: { callId: 'call-q1' },
  })
  pending.catch(() => undefined)
  await waitForDialog(tui, 'questions')
  const painted = frame(tui, 72, 10)
  const region = painted.region
  assert.notEqual(region, undefined)
  const covered = painted.lines.slice(region.top - 1, region.top - 1 + region.rows)
  assert.ok(covered.some(line => line.includes('选项 1')), `the highlighted option stays visible:\n${painted.lines.join('\n')}`)
  assert.ok(covered.some(line => line.includes('Enter')), 'and so does the key hint')
  assert.ok(painted.lines.some(line => line.startsWith('>')), 'the composer is still there')
  assert.equal(painted.lines.at(-1)?.includes('sub:') ?? false, true, 'and so is the footer')
  // Moving the selection inside a windowed list keeps the highlight on screen.
  tui.handleData(Buffer.from('\x1b[B'))
  tui.handleData(Buffer.from('\x1b[B'))
  tui.handleData(Buffer.from('\x1b[B'))
  const moved = frame(tui, 72, 10)
  const windowed = moved.lines.slice(moved.region.top - 1, moved.region.top - 1 + moved.region.rows)
  assert.ok(windowed.some(line => line.includes('›')), `the caret is still on screen:\n${windowed.join('\n')}`)
  tui.handleEscape()
  await pending.catch(() => undefined)
  await tick(0)
})

// ── incremental paint ───────────────────────────────────────────────────────

test('the layer repaints from its own top, not from the top of the frame', async () => {
  const { tui, agent } = fixture()
  tui.handleSessionEvent({ id: 'main-session' }, askEvent())
  const pending = openQuestion(tui)
  await waitForDialog(tui, 'questions')
  const settled = frame(tui)
  const region = settled.region
  assert.notEqual(region, undefined)

  // One key press, and the frame it composes: on a weak link this is the whole
  // cost of moving a selection, so it must not be the frame.
  const written = []
  const real = tui.write.bind(tui)
  tui.write = chunk => { written.push(chunk); real(chunk) }
  tui.handleData(Buffer.from('\x1b[B'))
  // Paint directly: `captureFrame` swaps `write` out to collect rows, so the frame
  // it composes can never be measured on the wire.
  process.stdout.columns = COLUMNS
  process.stdout.rows = ROWS
  tui.paint()
  tui.write = real
  const painted = written.join('')
  const rows = [...painted.matchAll(/\u001b\[(\d+);1H/gu)].map(match => Number(match[1]))
  assert.ok(rows.length > 0, 'the move painted something')
  assert.equal(/\u001b\[[HJ]|\u001b\[2J/u.test(painted), false, 'and did not clear the screen')
  assert.ok(
    rows.every(row => row >= region.top),
    `every addressed row is inside the layer or below it (${rows.join(',')} vs top ${region.top})`,
  )
  assert.ok(rows.length <= 8, `a selection move repaints a handful of rows, not the frame (${rows.length})`)
  tui.handleEscape()
  await pending
})

// ── plan dock ───────────────────────────────────────────────────────────────

test('the interaction covers the plan dock rather than the other way round', async () => {
  const { tui, agent } = fixture()
  seedPlan(tui, agent, {
    todos: [{ content: '找到失败的步骤', status: 'in_progress' }],
    body: '# 修复构建',
  })
  tui.handleSessionEvent({ id: 'main-session' }, askEvent())
  const withDock = frame(tui)
  // The dock is identified by the plan it is showing (its title), not by the word
  // 计划模式: the transcript's own lifecycle row legitimately says that too, and a
  // case about the *dock* must not match a row it does not own.
  const dockOf = lines => lines.findIndex(line => line.includes('修复构建'))
  const dockRow = dockOf(withDock.lines)
  assert.ok(dockRow >= 0, `the dock is drawn in the base frame:\n${withDock.lines.join('\n')}`)

  const pending = openQuestion(tui)
  await waitForDialog(tui, 'questions')
  const painted = frame(tui)
  const region = painted.region
  assert.notEqual(region, undefined)
  // Either the layer starts above the dock (so it covers it) or the dock has been
  // pushed out of the frame entirely: what must not happen is a dock row drawn on
  // top of the interaction's options.
  const covered = painted.lines.slice(region.top - 1, region.top - 1 + region.rows)
  assert.ok(covered.some(line => line.includes('预发')), 'the options are in the layer')
  assert.equal(
    covered.some(line => line.includes('修复构建')),
    false,
    `the interaction must cover the dock, not sit under it:\n${covered.join('\n')}`,
  )
  assert.equal(
    dockOf(painted.lines) === -1,
    true,
    `the dock is covered while the interaction is up:\n${painted.lines.join('\n')}`,
  )
  tui.handleEscape()
  await pending
})

// ── E. mouse ────────────────────────────────────────────────────────────────

test('the covered rows stop being targets', async () => {
  const { tui, agent } = fixture()
  pushRow(tui, { kind: 'tool', callId: 'c1', name: 'bash', args: '{}', status: 'ok', output: '', title: 'bash', summary: 'ls' })
  tui.handleSessionEvent({ id: 'main-session' }, askEvent())
  const base = frame(tui)
  assert.ok(tui.clickableRows.size > 0, 'the base frame has a clickable row')
  const pending = openQuestion(tui)
  await waitForDialog(tui, 'questions')
  const painted = frame(tui)
  const region = painted.region
  assert.notEqual(region, undefined)
  for (const y of tui.clickableRows.keys()) {
    assert.ok(y < region.top, `clickable row ${y} is under the interaction (top ${region.top})`)
  }
  for (const y of tui.paintedLinkHitsByRow.keys()) {
    assert.ok(y < region.top, `link row ${y} is under the interaction`)
  }
  assert.ok(base.region === undefined)
  tui.handleEscape()
  await pending
})

test('a drag cannot select a row the interaction covers', async () => {
  const { tui, agent } = fixture()
  tui.handleSessionEvent({ id: 'main-session' }, askEvent())
  const pending = openQuestion(tui)
  await waitForDialog(tui, 'questions')
  const painted = frame(tui)
  const region = painted.region
  assert.notEqual(region, undefined)
  assert.equal(tui.selectableLineAt(region.top), undefined, 'the first covered row is not selectable')
  assert.equal(tui.selectableLineAt(region.top + region.rows - 1), undefined, 'nor the last')
  if (region.top > 1) {
    assert.notEqual(tui.selectableLineAt(region.top - 1), undefined, 'the row just above it still is')
  }
  tui.handleEscape()
  await pending
})

// ── F. detach / reattach ────────────────────────────────────────────────────

test('a question and an approval survive detach and reattach', async () => {
  for (const open of [openQuestion, openApproval]) {
    const { tui, agent } = fixture()
    tui.handleSessionEvent({ id: 'main-session' }, askEvent())
    const before = frame(tui)
    const pending = open(tui)
    await waitForDialog(tui, tui.dialog === undefined ? 'questions' : tui.dialog.kind)
    const during = frame(tui)
    assert.notEqual(during.region, undefined)
    tui.detachDisplay()
    await tick(10)
    tui.displayHost = { attached: true, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
    tui.attachRelayDisplay()
    await tick(10)
    const after = frame(tui)
    assert.notEqual(after.region, undefined, 'the layer came back with the display')
    assert.equal(after.start, before.start, 'and the transcript anchor is what it was before the drop')
    assert.equal(after.scrollOffset, before.scrollOffset)
    tui.handleEscape()
    await pending
  }
})

// ── G. Standard / Compact ───────────────────────────────────────────────────

test('both workspace views keep the same region contract', async () => {
  for (const view of ['detailed', 'compact']) {
    const { tui, agent } = fixture()
    tui.setWorkspaceView(view)
    tui.handleSessionEvent({ id: 'main-session' }, askEvent())
    const before = frame(tui)
    const pending = openQuestion(tui)
    await waitForDialog(tui, 'questions')
    const after = frame(tui)
    assert.equal(after.start, before.start, `${view}: the window start is stable`)
    assert.equal(after.scrollOffset, before.scrollOffset, `${view}: and the offset is stable`)
    assert.notEqual(after.region, undefined, `${view}: the layer exists`)
    sameAbovedRows(before, after)
    tui.handleEscape()
    await pending
  }
})

// ── H. line mode ────────────────────────────────────────────────────────────

test('line mode has no framed region and keeps its textual echo', async () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, lineMode: true })
  tui.write = () => {}
  const pending = tui.handleUserQuestions({ questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '好' }] }] })
  pending.catch(() => undefined)
  await waitFor(() => tui.rows.some(row => String(row.text).includes('继续吗')), { describe: 'the echoed question' })
  assert.equal(tui.interactionRegion, undefined, 'line mode composes no region')
  tui.handleChar('\r')
  await pending.catch(() => undefined)
  await tick(0)
})

// ── the composition primitives ──────────────────────────────────────────────

test('the interaction window keeps the focused row and marks what it hid', () => {
  const lines = Array.from({ length: 20 }, (_line, index) => `line ${index}`)
  const all = windowInteractionFor(lines, 25, 3)
  assert.deepEqual(all.lines, lines, 'room for everything: nothing is windowed')
  const windowed = windowInteractionFor(lines, 6, 12)
  assert.equal(windowed.lines.length, 6)
  assert.ok(windowed.lines[0]?.startsWith('…'), 'the first row says something was dropped')
  assert.ok(windowed.lines.some(line => line === 'line 12'), 'and the focused row is visible')
  const atTop = windowInteractionFor(lines, 6, 0)
  assert.ok(atTop.lines.includes('line 0'), 'a focus at the top is kept')
  const atEnd = windowInteractionFor(lines, 6, 19)
  assert.ok(atEnd.lines.includes('line 19'), 'a focus at the end is kept')
})

/** Re-export the helper through the module under test, so the case above is local. */
function windowInteractionFor(lines, cap, focusLine) {
  return dialogs.windowInteractionLines(lines, cap, focusLine)
}

import * as dialogs from '../lib/dialogs.js'
