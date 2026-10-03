import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { pushRow, seedPlan, waitForDialog } from './wait.mjs'

/**
 * Who owns the workspace when the terminal is short.
 *
 * Three things compete for the rows between the header and the composer, and the
 * order is fixed: the interaction surface wins over both, an active plan dock
 * reserves its pixels above the composer and is never covered by the live region,
 * and history gets what is left. Under height pressure the dock compacts and the
 * region clips its own oldest lines — never the other way round. The cases here
 * pin that order at four heights, because "it looked right at 24 rows" is exactly
 * how a dock came to push the caret off the screen.
 */
setLocale('zh')

const plain = line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').trimEnd()

function fixture({ history = 40, todos = 8, plan = true } = {}) {
  const ctx = {
    get: name => (name === 'sessionProjections' ? { stateOf: () => ({ questions: { active: [], settled: [] } }) } : undefined),
    on() { return () => {} },
  }
  const agent = { id: 'main-session', options: {}, status: 'running', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  // A live display, so a question is asked here instead of being queued for one.
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  for (let index = 0; index < history; index += 1) {
    pushRow(tui, {
      kind: index % 2 === 0 ? 'assistant' : 'user',
      text: `${index % 2 === 0 ? '回复' : '提问'} ${index}`,
    })
  }
  if (plan) {
    // A docked plan is a *projection* of durable events now, so the fixture seeds the
    // events the Harness seeds rather than a bare row (which no longer docks
    // anything — that was the second truth B2.5 removed).
    seedPlan(tui, agent, {
      todos: Array.from({ length: todos }, (_, index) => ({ content: `第 ${index + 1} 步`, status: 'pending' })),
      // A distinctive title: the transcript's lifecycle row says 计划模式 too, so the
      // dock is identified by the plan it is showing.
      body: '# 修复构建\n- 甲\n- 乙',
    })
  }
  return { tui, agent }
}

/** A turn that is thinking: the live region wants far more rows than it can have. */
function thinking(tui, text = '第一段思考 ') {
  tui.streaming = { text: '', reasoning: text.repeat(40) }
  tui.streamingReasoning = { kind: 'streaming-reasoning', expanded: true }
  tui.waitStartedAt = Date.now()
  tui.markDirty()
}

const frame = (tui, columns, rows) => tui.captureFrame(columns, rows).map(plain)
const rowOf = (lines, needle) => lines.findIndex(line => line.includes(needle))
/**
 * The dock's own row.
 *
 * Its marker plus the mode word — the *header shape* only the dock draws. Neither
 * half works alone: the transcript's lifecycle row also says 计划模式, and the wait
 * card's detail line names the plan it is submitting.
 */
const DOCK_MARK = '▾ 计划模式'

test('the live region never covers an active plan dock', () => {
  for (const rows of [24, 20, 16, 12, 10, 8]) {
    const { tui } = fixture()
    thinking(tui)
    const lines = frame(tui, 100, rows)
    const region = tui.liveTailRegion
    assert.notEqual(region, undefined, `${rows} rows: the region is projected`)
    const dockTop = rowOf(lines, DOCK_MARK)
    assert.notEqual(dockTop, -1, `${rows} rows: the dock is on screen:\n${lines.join('\n')}`)
    assert.ok(
      region.top - 1 + region.rows <= dockTop,
      `${rows} rows: the region ends above the dock (region ${region.top}..${region.top - 1 + region.rows}, dock ${dockTop + 1})`,
    )
    // Every dock row that the dock composed is on screen — the header, the note and
    // the plan lines are not painted over by anything.
    const dock = lines.slice(dockTop)
    assert.ok(dock.some(line => line.includes('计划')), `${rows} rows: the dock's own header survives`)
  }
})

test('an interaction surface outranks the dock and the live region', async () => {
  // "Higher priority" is observable two ways: nothing is ever painted over the
  // surface's own rows, and the two lower regions give their rows up while it is
  // up — the dock yields to its header line (its own rule), the live region stays
  // composed underneath, and the surface's rows are its own either way.
  const { tui } = fixture()
  thinking(tui)
  const pending = tui.handleUserQuestions({
    questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }, { label: '生产' }] }],
    wait: { callId: 'call-q1' },
  })
  pending.catch(() => undefined)
  await waitForDialog(tui, 'questions')
  const lines = frame(tui, 100, 20)
  const layer = tui.interactionRegion
  assert.notEqual(layer, undefined, 'the surface is up')
  const surface = lines.slice(layer.top - 1, layer.top - 1 + layer.rows)
  assert.ok(surface.some(line => line.includes('预发')), 'the surface owns its rows')
  assert.equal(surface.some(line => line.includes('第一段思考')), false, 'the live region is not painted over it')
  assert.equal(surface.some(line => line.includes(DOCK_MARK)), false, 'nor is the dock')
  assert.ok(lines.length <= 20, 'and the frame still fits the terminal')
  tui.handleEscape()
  await pending.catch(() => undefined)
  const after = frame(tui, 100, 20)
  assert.ok(after.some(line => line.includes(DOCK_MARK)), 'with the surface gone the dock takes its rows back')
  assert.notEqual(tui.liveTailRegion, undefined, 'and the live region is projected again')
  assert.ok(after.some(line => line.includes('思考中')), 'with the live card naming it')
})

test('under height pressure the dock compacts and the region clips its oldest lines', () => {
  const { tui } = fixture({ todos: 12 })
  // Distinct head and tail, so "the oldest lines were dropped" is a fact about the
  // text and not about which way the region happens to be clipped.
  thinking(tui, '最早的一段思考内容。')
  tui.streaming.reasoning = `最早的一段思考内容。${'中间的一段思考内容。'.repeat(30)}最新的一段思考内容。`
  const lines = frame(tui, 100, 20)
  const region = tui.liveTailRegion
  const dockTop = rowOf(lines, DOCK_MARK)
  const boundary = rowOf(lines, '╭')
  // The dock yields first, and to half of the workspace: the history it is about
  // has to stay readable above it.
  const dock = lines.slice(dockTop, boundary)
  assert.ok(dock.length <= 7, `the dock is compacted (${dock.length} rows of a 20-row terminal)`)
  assert.ok(dock.some(line => /还有 \d+ 行/u.test(line)), 'and says how many of its rows are not shown')
  assert.ok(dock.some(line => line.includes(DOCK_MARK)), 'while keeping its own header')
  // The region clips its own oldest content, and keeps the header that names it.
  assert.ok(region.rows >= 1, 'the region keeps rows of its own')
  // ...and the history keeps its floor: the region clips *itself* rather than
  // taking the last rows the reader was reading (two header rows above it here).
  assert.ok(
    region.top - 1 - 2 >= 3,
    `the transcript keeps its floor above the region (${region.top - 1 - 2} rows)`,
  )
  const regionLines = lines.slice(region.top - 1, region.top - 1 + region.rows).join('\n')
  assert.equal(lines[region.top - 1]?.includes('思考中'), true, 'the live card names the region')
  assert.equal(regionLines.includes('最早的一段思考内容。'), false, 'the oldest body lines are the ones dropped')
  assert.equal(regionLines.includes('最新的一段思考内容。'), true, 'while the newest are kept')
  assert.ok(lines.length <= 20, 'and the frame still fits the terminal')
})

test('entering the workspace mid-turn opens on the newest content, not on covered history', () => {
  // "Entering the TUI workspace is not at the bottom by default" was this: a
  // session that is working paints its live region over the newest rows, so the
  // line that had just settled was behind it and the view looked like history that
  // stopped short. Entering is `attachRelayDisplay` on the relayed path — an empty
  // screen, a full repaint over the same rows — so that is what the case drives.
  const { tui } = fixture({ history: 60, todos: 0, plan: false })
  pushRow(tui, { kind: 'assistant', text: '刚刚结算的最后一行' })
  tui.agent.status = 'running'
  thinking(tui)
  tui.attachRelayDisplay()
  const lines = frame(tui, 100, 24)
  const region = tui.liveTailRegion
  assert.notEqual(region, undefined, 'the session is working, so the region is up')
  assert.ok(
    lines.slice(0, region.top - 1).some(line => line.includes('刚刚结算的最后一行')),
    `the newest settled line is on screen:\n${lines.join('\n')}`,
  )
  const inputRow = rowOf(lines, '>')
  assert.equal(tui.lastPaintedCursorRow(), inputRow + 1, 'the composer is where the caret is')
  assert.equal(lines.length, 24, 'and the frame fills the terminal')
})

test('the composer and the caret stay on screen at every height', () => {
  // The caret is where a terminal draws an IME's pre-edit. With an uncapped dock
  // the frame was taller than the terminal, the input box was clipped off the
  // bottom, and the caret — clamped to the last row — sat on a plan line, so the
  // composing text appeared inside the plan card.
  for (const rows of [30, 24, 18, 14, 10, 8]) {
    const { tui } = fixture({ todos: 20 })
    thinking(tui)
    const lines = frame(tui, 100, rows)
    assert.equal(lines.length, rows, `${rows} rows: the frame is exactly as tall as the terminal`)
    const inputRow = rowOf(lines, '>')
    assert.notEqual(inputRow, -1, `${rows} rows: the input line is on screen`)
    const strip = lines.slice(-2).join('\n')
    assert.ok(/SSH|本地/u.test(strip), `${rows} rows: the runtime strip is on screen`)
    const cursor = tui.lastPaintedCursorRow()
    assert.equal(cursor, inputRow + 1, `${rows} rows: the caret is parked on the input line`)
    const dockTop = rowOf(lines, DOCK_MARK)
    assert.ok(cursor - 1 > dockTop, `${rows} rows: the caret is below the dock, never on it`)
  }
})
