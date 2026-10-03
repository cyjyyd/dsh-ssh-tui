/**
 * What a resume shows while it loads (0.8.2).
 *
 * The launcher prints "正在载入历史会话…" and then enters the alternate screen, which
 * clears it; the Host that takes over withholds its frames until the log has been
 * rebuilt (one rebuild, not one frame per event). The window between the two used to be
 * an *empty workspace* — header, input box and footer with no transcript — which the
 * reader reported as a black screen for one to three seconds. The first frame now
 * carries the same line the launcher was showing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { ctxWithCredentials } from './wait.mjs'

setLocale('zh')

const plain = text => text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').replace(/\u001b\][^\u0007]*\u0007/gu, '')

/** A resumed Host with `count` events to replay, plus everything it writes. */
function resumedTui(count = 400) {
  const events = []
  for (let index = 0; index < count; index += 1) {
    events.push({ type: 'assistant/message', seq: index, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `第 ${index} 行回复` }] } } })
  }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events, seq: events.length, eventAt: index => events[index] },
    cancel() {},
  }
  const tui = new SshTui(ctxWithCredentials({ agentPresets: {}, settings: { get: () => undefined } }), agent, {
    sessionId: 'main-session', color: false, headlessDisplay: true, resume: true,
  })
  const written = []
  const real = tui.write.bind(tui)
  tui.write = chunk => { written.push(String(chunk)); real(chunk) }
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  process.stdout.columns = 100
  process.stdout.rows = 30
  return { tui, written }
}

test('a resume says it is loading instead of showing an empty workspace', async () => {
  const { tui, written } = resumedTui()
  tui.start()
  tui.paint()                       // the first frame, while the log is still to come
  const first = plain(written.join(''))
  assert.match(first, /正在载入历史会话/u, `the first frame carries the launcher's line: ${JSON.stringify(first.slice(0, 120))}`)
  assert.equal(/╭/u.test(first), false, 'and it draws no composer, because the workspace is not loaded yet')
  assert.equal(tui.rows.some(row => String(row.text ?? '').includes('第 0 行回复')), false, 'nothing from the log is there yet')

  await tui.replayHistory()
  written.length = 0
  tui.paint()                       // the landing frame
  const landed = plain(written.join(''))
  assert.equal(/正在载入历史会话/u.test(landed), false, 'the notice is gone once the log is in')
  assert.match(landed, /第 399 行回复/u, 'and the transcript is what the reader sees')
  assert.match(landed, /╭/u, 'with the composer back')
})

test('a session that is not a resume paints its workspace straight away', () => {
  const { tui, written } = resumedTui()
  tui.resume = false
  tui.start()
  tui.paint()
  const first = plain(written.join(''))
  assert.equal(/正在载入历史会话/u.test(first), false, 'no loading line for a fresh session')
  assert.match(first, /╭/u, 'the workspace is drawn immediately')
})
