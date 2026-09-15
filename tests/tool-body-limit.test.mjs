import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { toolBodyLineLimit } from '../lib/paint.js'
import { toolBodyLines } from '../lib/tool-present.js'
import { SshTui } from '../lib/tui.js'

/**
 * A measured slow link caps what an expanded card draws and points at the
 * overlay; every other link keeps the 0.3.9 behavior (full body, overlay when it
 * cannot fit the workspace). The cap is the last piece of the paint budget: on a
 * 400ms link a 30-line body is bytes the user waits through one frame at a time.
 */
function fixture() {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  // Only the card under test: the boot banner would push body lines out of the
  // viewport and turn a truncation assertion into a scrolling one.
  tui.rows.length = 0
  tui.rows.push({
    kind: 'tool',
    callId: 'call-body',
    name: 'read',
    title: '读取',
    summary: 'src/tui.ts',
    args: '{"path":"src/tui.ts"}',
    output: Array.from({ length: 10 }, (_, index) => `BODY_LINE_${index}`).join('\n'),
    status: 'ok',
    expanded: true,
  })
  return tui
}

const bodyLinesIn = lines => lines.filter(line => /BODY_LINE_\d/u.test(line) && !line.includes('更多')).length

test('only a measured slow link caps a card body', () => {
  assert.equal(toolBodyLineLimit('local'), Number.POSITIVE_INFINITY)
  assert.equal(toolBodyLineLimit('good'), Number.POSITIVE_INFINITY)
  assert.equal(toolBodyLineLimit('ok'), Number.POSITIVE_INFINITY)
  // Unmeasured is not slow: a Windows terminal that never answers CSI 6n keeps
  // the full-body behavior instead of silently losing lines.
  assert.equal(toolBodyLineLimit('unknown'), Number.POSITIVE_INFINITY)
  assert.equal(toolBodyLineLimit('slow'), 6)
  assert.equal(toolBodyLineLimit('poor'), 3)
})

test('a local link still paints the whole expanded body', () => {
  setLocale('zh')
  const tui = fixture()
  const frame = tui.captureFrame(60, 30)
  assert.equal(bodyLinesIn(frame), 10, 'nothing is hidden without a slow measurement')
  assert.equal(frame.some(line => line.includes('Enter 全览')), false)
})

test('a slow link draws the first few body lines and points at the overlay', () => {
  setLocale('zh')
  const tui = fixture()
  tui.applyProbedRtt(200)
  const frame = tui.captureFrame(60, 30)
  // The body is the path line plus ten BODY_LINEs; six of those eleven show.
  assert.ok(frame.some(line => line.includes('BODY_LINE_4')), frame.join('\n'))
  assert.equal(frame.some(line => line.includes('BODY_LINE_5')), false, 'beyond the cap is not drawn')
  assert.ok(frame.some(line => line.includes('还有 5 行')), frame.join('\n'))
  assert.ok(frame.some(line => line.includes('Enter 全览')), 'the marker says where the rest is')
})

test('a poor link draws fewer lines than a slow one', () => {
  setLocale('zh')
  const tui = fixture()
  tui.applyProbedRtt(400)
  const frame = tui.captureFrame(60, 30)
  assert.ok(frame.some(line => line.includes('BODY_LINE_1')), frame.join('\n'))
  assert.equal(frame.some(line => line.includes('BODY_LINE_2')), false, 'a poor link stops earlier')
  assert.ok(frame.some(line => line.includes('还有 8 行')), frame.join('\n'))
  assert.ok(bodyLinesIn(frame) < 6, 'fewer than a slow link draws')
})

test('the cap is a paint concern: the row keeps its whole body', () => {
  setLocale('zh')
  const tui = fixture()
  tui.applyProbedRtt(400)
  tui.captureFrame(60, 30)
  const tool = tui.rows.find(row => row.kind === 'tool')
  // The overlay (Enter) reads the row, not the painted frame, so truncation
  // must never reach the stored body.
  assert.equal(toolBodyLines(tool, Number.MAX_SAFE_INTEGER).length, 11, 'path line plus ten body lines')
})
