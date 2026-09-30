import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'

/**
 * The live tail (the wait card, the streaming buffer, a burst with no reply
 * yet) belongs to no row, so it may not be stored in any row's cache entry.
 *
 * The row loop records the line index it starts at and writes its cache entry
 * when the *next* row begins, with one final flush for the last row. That final
 * flush used to run after the live tail had already been pushed into the same
 * display list, so the last row's entry ended up owning a copy of the wait card.
 * Every later frame then replayed that copy — a "processing" line frozen at the
 * elapsed time of the frame that stored it, sitting in the transcript while the
 * live card ticked on below. A real session showed four of them (0s, 12s, 19s,
 * 30s) interleaved with tool cards, and none of them ever went away.
 *
 * Reported from a session: "一份处理中是停滞状态,显示已处理(0秒),第二个是正常的,
 * 然后紧接着会冒出来第三个".
 */
setLocale('zh')

function fixture(rows, { compact = false } = {}) {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'running',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  if (compact) tui.workspaceView = 'compact'
  for (const row of rows) tui.pushRow(row)
  return tui
}

const frame = tui => tui.captureFrame(90, 24)
/** How many times a fragment appears. */
const count = (text, needle) => text.split(needle).length - 1

const tool = (index, overrides = {}) => ({
  kind: 'tool',
  callId: `call-${index}`,
  name: 'bash',
  args: `npm run step-${index}`,
  // Settled: a live row's key carries the clock, and this test is about the
  // cache entry of a row that is *not* re-rendering for its own reasons.
  status: 'ok',
  endedAt: 2_000 + index,
  output: '',
  title: `bash: step-${index}`,
  summary: `npm run step-${index}`,
  expanded: false,
  startedAt: 1_000 + index,
  ...overrides,
})

test('a row never keeps a copy of the live wait card it was painted before', () => {
  const tui = fixture([
    { kind: 'user', text: '跑一下。' },
    { kind: 'system', text: '已经落定的一行。' },
  ])
  tui.waitStartedAt = Date.now()
  const first = frame(tui).join('\n')
  assert.equal(count(first, 'Esc 中断'), 1, `one wait card:\n${first}`)
  assert.ok(first.includes('(0s'), `it starts at zero:\n${first}`)

  // The turn goes on: the same rows, one clock tick later.
  tui.waitStartedAt = Date.now() - 12_000
  const second = frame(tui).join('\n')
  assert.equal(count(second, 'Esc 中断'), 1, `still exactly one wait card:\n${second}`)
  assert.ok(second.includes('(12s'), `the card followed the clock:\n${second}`)
  assert.equal(count(second, '(0s'), 0, `the stale copy is gone:\n${second}`)
})

test('a burst with no reply above it is painted once, not once per row it cached', () => {
  const tui = fixture([tool(1), tool(2)], { compact: true })
  const first = frame(tui).join('\n')
  assert.equal(count(first, '已调用'), 1, `one burst line:\n${first}`)

  const second = frame(tui).join('\n')
  assert.equal(count(second, '已调用'), 1, `still one burst line:\n${second}`)
})

test('the streaming reasoning buffer is not stored in the row above it', () => {
  const tui = fixture([{ kind: 'user', text: '想想。' }])
  tui.streaming = { text: '', reasoning: '**边框对齐** 先看这里' }
  tui.thinkingStartedAt = Date.now()
  const first = frame(tui).join('\n')
  assert.equal(count(first, '思考中'), 1, `one live reasoning line:\n${first}`)

  tui.streaming.reasoning = '**边框对齐** 先看这里，再看那里'
  const second = frame(tui).join('\n')
  assert.equal(count(second, '思考中'), 1, `still one live reasoning line:\n${second}`)
  assert.equal(count(second, '先看这里\n'), 0, 'the old buffer is not replayed')
})
