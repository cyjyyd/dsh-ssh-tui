import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'

/**
 * Updating a row in place must render exactly like building it in that state.
 *
 * This is the property the per-row render cache can break, and it is stated as
 * equivalence rather than as "field X is in the fingerprint": a hand-written list
 * of fields has already missed three inputs (`modelProvider`, the burst a reply
 * draws, the live tick), each one leaving stale lines on screen — the residue
 * readers reported as a "processing" card that would not go away.
 *
 * Every case below mutates the same row object (which is what a live session
 * does: the streaming row is appended to, a tool's status flips, a plan's todos
 * change) and compares the frame against one rendered from a fresh session whose
 * row was constructed in the final state.
 */
setLocale('zh')

function fixture(rows, { compact = false } = {}) {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  if (compact) tui.workspaceView = 'compact'
  for (const row of rows) tui.pushRow(row)
  return tui
}

/**
 * The transcript part of the frame.
 *
 * Comparing whole frames compares the chrome too, and the chrome carries a
 * measured round-trip time and a clock — a Windows runner and a Linux one
 * disagree on it for reasons that have nothing to do with this cache.
 */
const CHROME = /(DeepSeek Harness — SSH TUI|^\s*[─]+\s*$|SSH |空闲 |输入 \/help|^>\s*$|目录:)/u
const frame = tui => tui.captureFrame(90, 30)
  .filter(line => line.trim() !== '' && !CHROME.test(line))
  .join('\n')

const tool = (overrides = {}) => ({
  kind: 'tool',
  callId: 'call-1',
  name: 'bash',
  args: 'npm run step-1',
  status: 'running',
  output: '',
  title: 'bash: step-1',
  summary: 'npm run step-1',
  expanded: true,
  startedAt: 1_000,
  ...overrides,
})

/** Compare a session whose row was mutated in place with one built that way. */
function sameAfterMutation({ before, mutate, after }, { compact = false } = {}) {
  const mutated = fixture(before.map(row => ({ ...row })), { compact })
  // Paint once, so the cached entry exists in the pre-mutation state.
  frame(mutated)
  const row = mutated.rows.find(candidate => candidate.kind === before[before.length - 1].kind)
  mutate(row)
  const live = frame(mutated)

  const fresh = fixture(before.slice(0, -1).map(row => ({ ...row })).concat([{ ...before[before.length - 1], ...after }]), { compact })
  const scratch = frame(fresh)
  assert.equal(live, scratch, 'a mutated row renders like one built in that state')
}

test('a tool whose arguments stream in does not keep its old card', () => {
  sameAfterMutation({
    before: [{ kind: 'assistant', text: '跑一步。' }, tool()],
    mutate: row => { row.args = 'npm run step-1 -- --long --flag=value'; row.title = 'bash: step-1 --long' },
    after: { args: 'npm run step-1 -- --long --flag=value', title: 'bash: step-1 --long' },
  })
})

test('a tool that produces output shows it, not the empty card it started as', () => {
  sameAfterMutation({
    before: [{ kind: 'assistant', text: '跑一步。' }, tool()],
    mutate: row => { row.output = 'step one\ndone'; row.status = 'ok'; row.endedAt = 2_000 },
    after: { output: 'step one\ndone', status: 'ok', endedAt: 2_000 },
  })
})

test('the same holds in the compact view, where the burst is drawn by the reply', () => {
  sameAfterMutation({
    before: [{ kind: 'assistant', text: '跑一步。' }, tool()],
    mutate: row => { row.status = 'error'; row.output = 'boom'; row.endedAt = 2_000 },
    after: { status: 'error', output: 'boom', endedAt: 2_000 },
  }, { compact: true })
})

test('an assistant reply that keeps streaming matches one written in full', () => {
  sameAfterMutation({
    before: [{ kind: 'assistant', text: '第一段。' }],
    mutate: row => { row.text = '第一段。\n\n第二段，多了一行。' },
    after: { text: '第一段。\n\n第二段，多了一行。' },
  })
})
