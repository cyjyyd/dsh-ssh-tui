import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'

/**
 * A stale "processing" card that would not go away.
 *
 * Reported twice from a real session: the compact view folds tool calls into the
 * reply above them, so the *reply's* rendered lines contain cards belonging to
 * rows the reply's own fingerprint never looks at. The per-row render cache keyed
 * on the reply therefore kept replaying its cached burst — a tool that had long
 * finished went on saying "processing" beside the live card.
 *
 * These cases drive the two ways the burst changes: a member's state, and a new
 * member arriving.
 */
setLocale('zh')

function fixture() {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  // `/view compact` is what a reader runs; the field is the same switch.
  tui.workspaceView = 'compact'
  return tui
}

const tool = (index, overrides = {}) => ({
  kind: 'tool',
  callId: `call-${index}`,
  name: 'bash',
  args: `npm run step-${index}`,
  status: 'running',
  output: '',
  title: `bash: step-${index}`,
  summary: `npm run step-${index}`,
  expanded: false,
  startedAt: 1_000 + index,
  ...overrides,
})

const frame = tui => tui.captureFrame(90, 24).join('\n')

/** How many times a fragment appears. */
const count = (text, needle) => text.split(needle).length - 1

test('the burst line follows its tools instead of freezing on a cached copy', () => {
  const tui = fixture()
  tui.pushRow({ kind: 'assistant', text: '先跑一步。' })
  tui.pushRow(tool(1))
  const running = frame(tui)
  assert.equal(count(running, '已调用'), 1, `one burst line:\n${running}`)
  assert.ok(/running…|运行中/u.test(running), `it says the tool is running:\n${running}`)

  // The tool finishes — the same row object is updated in place, which is what a
  // live session does. A cached burst kept saying "running" forever.
  const row = tui.rows.find(candidate => candidate.kind === 'tool')
  row.status = 'ok'
  row.endedAt = 2_000
  const settled = frame(tui)
  assert.equal(/running…/u.test(settled), false, `no stale running marker:\n${settled}`)
  assert.equal(count(settled, '已调用'), 1, `still exactly one burst line:\n${settled}`)
})

test('a second tool joins the same burst without leaving a stale count behind', () => {
  const tui = fixture()
  tui.pushRow({ kind: 'assistant', text: '连着跑两步。' })
  tui.pushRow(tool(1))
  frame(tui)
  tui.pushRow(tool(2))
  const both = frame(tui)
  assert.equal(count(both, '已调用'), 1, `one burst line, not one per tool:\n${both}`)
  assert.ok(both.includes('2'), `the count followed the burst:\n${both}`)
})

test('a tool finishing while another runs leaves one line with the live state', () => {
  const tui = fixture()
  tui.pushRow({ kind: 'assistant', text: '两步。' })
  tui.pushRow(tool(1))
  tui.pushRow(tool(2))
  frame(tui)
  const first = tui.rows.find(candidate => candidate.kind === 'tool' && candidate.callId === 'call-1')
  first.status = 'ok'
  first.endedAt = 2_000
  const after = frame(tui)
  assert.equal(count(after, '已调用'), 1, `still one burst line:\n${after}`)
  assert.ok(/running…|运行中/u.test(after), `the second tool is still running:\n${after}`)
})
