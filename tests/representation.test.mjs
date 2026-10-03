/**
 * B2.3a — representation metadata.
 *
 * AD-10 froze the pipeline (`Event / Command → Representation Policy →
 * Representation → Renderer`) and AD-11 the vocabulary (`durable` / `display` /
 * `live`). This file pins the *boundary*: every line in the transcript carries a
 * policy, a bare row cannot enter one, `live` never appears as a source row, and a
 * resume rebuilds exactly the rows marked `durable`.
 *
 * The `changes` card is the canonical case: it looks like history and is `display`,
 * because a restarted Host cannot reopen the summary it was drawn from.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { setLocale } from '../lib/i18n/index.js'
import { REPRESENTATION_POLICY, auditRepresentations, isRepresentation, represent } from '../lib/representation.js'
import { SshTui } from '../lib/tui.js'
import { pushRow, tick, waitFor } from './wait.mjs'

setLocale('zh')

function fixture(options = {}) {
  const state = options.state ?? { questions: { active: [], settled: [] } }
  const ctx = {
    get: name => {
      if (name === 'sessionProjections') return { stateOf: () => state }
      if (name === 'commands') return { list: () => [] }
      if (name === 'workspaceChanges') return options.changes
      return undefined
    },
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
    followup: async () => {},
    steer: async () => {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  return { tui, agent }
}

const send = (tui, agent, seq, type, data) =>
  tui.handleSessionEvent(agent.session, { type, seq, time: Date.now(), data })

/** A log the way `replayHistory` reads it. */
const replayAgent = (events) => ({
  id: 'main-session',
  options: {},
  status: 'idle',
  session: { id: 'main-session', seq: events.length, eventAt: seq => events[seq] },
  cancel() {},
})

const durableOf = row => row?.representation?.durability

// ── A. every representation is classified ───────────────────────────────────

test('a fresh session has no unclassified rows and no live source rows', () => {
  const { tui } = fixture()
  const audit = tui.representationAudit()
  assert.equal(audit.unclassified, 0, 'every row carries a policy')
  assert.equal(audit.liveRows, 0, 'a live projection is not a source row')
  const boot = tui.rows.filter(row => row.kind === 'system')
  assert.ok(boot.length > 0, 'the boot rows are there')
  for (const row of boot) {
    assert.equal(durableOf(row), 'display', 'the boot banner is this Hosts own voice')
  }
})

test('the durable narrative is marked durable, end to end', async () => {
  const { tui, agent } = fixture()
  send(tui, agent, 1, 'user/message', { content: [{ type: 'text', text: '把构建修好' }], source: { kind: 'user' } })
  send(tui, agent, 2, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '先看失败的一步。' }] } })
  send(tui, agent, 3, 'tool/call', { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'pnpm build' }) })
  send(tui, agent, 4, 'tool/result', {
    message: { role: 'tool', source: { callId: 'c1' }, content: [{ type: 'text', text: 'failed' }] },
    isError: false,
  })
  await tick(10)

  const bySource = new Map(tui.rows.map(row => [row.representation?.source, row]))
  assert.equal(durableOf(bySource.get('user-message')), 'durable')
  assert.equal(durableOf(bySource.get('assistant-message')), 'durable')
  assert.equal(durableOf(bySource.get('tool-call')), 'durable')
  assert.equal(bySource.get('tool-call')?.representation?.representationClass, 'A')
  const audit = tui.representationAudit()
  assert.equal(audit.unclassified, 0)
  assert.ok(audit.counts.durable >= 3)
})

test('a turn failure from the log is durable', () => {
  const { tui, agent } = fixture()
  send(tui, agent, 1, 'user/message', { content: [{ type: 'text', text: '跑一下' }], source: { kind: 'user' } })
  send(tui, agent, 2, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: '模型不可用' } } })
  const failed = tui.rows.findLast(row => row.kind === 'error')
  assert.equal(durableOf(failed), 'durable', 'the turn outcome is in the log, so a replay rebuilds it')
  assert.equal(failed?.representation?.source, 'turn-error')
})

test('control-plane feedback is display, and routed to an echo', async () => {
  const { tui } = fixture()
  const rows = tui.rows.length
  tui.runCommand('/theme mono')
  await tick(20)
  assert.equal(tui.rows.length, rows, 'a confirmation is not a transcript row (B2.3b routes it)')
  assert.match(tui.currentFooterEcho() ?? '', /配色/, 'it reaches the footer echo instead')
  assert.equal(REPRESENTATION_POLICY['command-feedback'].durability, 'display')
  assert.equal(REPRESENTATION_POLICY['command-feedback'].destination, 'echo')
})

test('the changes card is display — the canonical case', async () => {
  const summary = {
    files: [{ path: 'src/tui.ts', display: 'src/tui.ts', added: 30, deleted: 5 }],
    total: 1,
    added: 30,
    deleted: 5,
  }
  const { tui, agent } = fixture({ changes: { summary: () => summary, diff: async () => undefined } })
  send(tui, agent, 7, 'workspace/changes', { turn: 3 })
  await waitFor(() => tui.rows.some(row => row.kind === 'changes'), { describe: 'the changes card' })
  const card = tui.rows.find(row => row.kind === 'changes')
  assert.equal(
    durableOf(card),
    'display',
    'the summary is not in the session log: a restarted Host cannot reopen it',
  )
  assert.equal(card?.representation?.source, 'changes-card')
})

test('every policy source is well formed and the table has no holes', () => {
  for (const [source, policy] of Object.entries(REPRESENTATION_POLICY)) {
    assert.ok(['durable', 'display', 'live'].includes(policy.durability), `${source}: durability`)
    assert.ok(['A', 'B', 'C', 'D'].includes(policy.class), `${source}: class`)
  }
  // Class B never produces a source row (it is the live tail and the Surfaces), and
  // no source may claim to be `live`: that is the invariant the audit checks on real
  // rows, and this states it on the table.
  const live = Object.entries(REPRESENTATION_POLICY).filter(([, policy]) => policy.durability === 'live')
  assert.deepEqual(live, [], 'no source row may be marked live')
  const b = Object.entries(REPRESENTATION_POLICY).filter(([, policy]) => policy.class === 'B')
  assert.deepEqual(b, [], 'class B is never a transcript row')
  // And every source has a route: a table entry without a destination is a hole a
  // call site could fall through (the exhaustiveness guard, B2.3b §13).
  for (const [source, policy] of Object.entries(REPRESENTATION_POLICY)) {
    assert.ok(
      ['transcript', 'echo', 'notice'].includes(policy.destination),
      `${source}: destination`,
    )
  }
})

// ── B. the boundary itself ──────────────────────────────────────────────────

test('a source with no policy cannot be named (the table is the only vocabulary)', () => {
  const { tui } = fixture()
  // `represent` takes `RepresentationSource`, which is the policy's keys: a made-up
  // id cannot reach here from TypeScript. At runtime the guard still refuses it.
  assert.equal(isRepresentation({ meta: { source: 'not-a-source' }, row: { kind: 'system', text: 'x' } }), false)
  const forged = { meta: { source: 'not-a-source' }, row: { kind: 'system', text: '伪造' } }
  tui.pushRow(forged)
  assert.equal(tui.representationAudit().unclassified, 1, 'a row with no policy is counted, never assumed')
})

test('every pushRow call site goes through the policy (static guard)', () => {
  // The type system already refuses a bare row; this reads the source so the guard
  // is visible in the suite too, and so an `as any` escape hatch would be caught.
  const source = readFileSync(new URL('../src/tui.ts', import.meta.url), 'utf8')
  const calls = [...source.matchAll(/this\.pushRow\(([\s\S]{0,40})/gu)]
  assert.ok(calls.length > 200, `the transcript is built from many sites (${calls.length})`)
  const bare = calls.filter(match => !match[1].startsWith('represent('))
  assert.deepEqual(
    bare.map(match => match[1].split('\n')[0]),
    [],
    'every creation site names its source',
  )
  // And the helper the tests use is not a hole in production: it names `fixture`.
  assert.equal(REPRESENTATION_POLICY.fixture.durability, 'display')
})

test('the audit reports what the rows carry, not what the table says', () => {
  const audit = auditRepresentations([
    { kind: 'assistant', representation: { source: 'assistant-message', durability: 'durable', representationClass: 'A', destination: 'transcript' } },
    { kind: 'system', representation: { source: 'command-feedback', durability: 'display', representationClass: 'A', destination: 'echo' } },
    { kind: 'system' },
    { kind: 'tool', representation: { source: 'live-tail', durability: 'live', representationClass: 'B', destination: 'transcript' } },
  ])
  assert.equal(audit.counts.durable, 1)
  assert.equal(audit.counts.display, 1)
  assert.equal(audit.destinations.echo, 1, 'the routing is auditable too')
  assert.equal(audit.unknownDestination, 0)
  assert.equal(
    audit.unclassified,
    2,
    'the bare row and the row whose source is unknown are both unclassified — never assumed',
  )
  assert.equal(
    audit.liveRows,
    1,
    'and a row claiming `live` is reported as the bug it is, even though its source is unknown too',
  )
})

// ── C. resume ───────────────────────────────────────────────────────────────

test('a replay rebuilds the durable rows and not the display ones', async () => {
  const { tui, agent } = fixture()
  send(tui, agent, 1, 'user/message', { content: [{ type: 'text', text: '把构建修好' }], source: { kind: 'user' } })
  send(tui, agent, 2, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好。' }] } })
  pushRow(tui, { kind: 'system', text: '（display）主题已切换' })
  const before = { durable: tui.rows.filter(row => durableOf(row) === 'durable').length }

  // A fresh Host replaying the same log: this is what a resume does.
  const events = [
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '把构建修好' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好。' }] } } },
  ]
  const ctx = { get: () => undefined, on() { return () => {} } }
  const resumed = new SshTui(ctx, replayAgent(events), { sessionId: 'main-session', color: false, headlessDisplay: true })
  resumed.write = () => {}
  await resumed.replayHistory()

  const text = resumed.rows.map(row => String(row.text)).join('\n')
  assert.ok(text.includes('把构建修好'), 'the durable user turn came back')
  assert.ok(text.includes('好。'), 'and the reply')
  assert.equal(text.includes('（display）主题已切换'), false, 'the display row did not')
  assert.ok(
    resumed.rows.filter(row => durableOf(row) === 'durable').length >= before.durable,
    'the replay rebuilt at least the durable rows the live session had',
  )
  assert.equal(resumed.representationAudit().unclassified, 0)
})

// ── D. sawUserInput ─────────────────────────────────────────────────────────

test('a fresh session has not seen user input', () => {
  const { tui } = fixture()
  assert.equal(tui.sessionHadUserInput(), false)
})

test('the composer still marks the session as used', async () => {
  const { tui } = fixture()
  tui.input = '跑一下测试'
  tui.cursor = tui.input.length
  tui.handleChar('\r')
  await tick(20)
  assert.equal(tui.sessionHadUserInput(), true)
})

test('replaying a log with a user turn derives the flag from the log', async () => {
  // The regression this fix exists for: the flag used to be set only by the
  // composer's submit path, so a resumed session — where the turn arrives by replay
  // — reported that nobody had ever typed anything, and `/cleanup` would delete it.
  const events = [
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '跑一下测试' }], source: { kind: 'user' } } },
  ]
  const ctx = { get: () => undefined, on() { return () => {} } }
  const resumed = new SshTui(ctx, replayAgent(events), { sessionId: 'main-session', color: false, headlessDisplay: true })
  resumed.write = () => {}
  await resumed.replayHistory()
  assert.equal(resumed.sessionHadUserInput(), true, 'the durable log says a human typed here')
})

test('a log with no user turn leaves the flag alone', async () => {
  const events = [
    { type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '无人输入' }] } } },
  ]
  const ctx = { get: () => undefined, on() { return () => {} } }
  const resumed = new SshTui(ctx, replayAgent(events), { sessionId: 'main-session', color: false, headlessDisplay: true })
  resumed.write = () => {}
  await resumed.replayHistory()
  assert.equal(resumed.sessionHadUserInput(), false)
})

test('the reducer has exactly one reachable user/message case', () => {
  // A duplicate `case 'user/message'` in one switch is dead code — the second label
  // is never reached — and that is how the flag came to be un-derivable.
  const source = readFileSync(new URL('../src/tui.ts', import.meta.url), 'utf8')
  const start = source.indexOf('private applySessionEvent')
  // The reducer's switch ends at the next method boundary after it.
  const after = source.slice(start)
  const end = after.search(/\n  (?:private|readonly|public)[^\n]*\([^)]*\)[^\n]*\{\n/u)
  const reducer = end === -1 ? after : after.slice(0, end)
  const labels = [...reducer.matchAll(/\n\s*case 'user\/message'/gu)]
  assert.equal(labels.length, 1, 'one case, and it is the one that folds the event')
  assert.ok(
    /case 'user\/message': \{[\s\S]{0,900}this\.sawUserInput = true/u.test(reducer),
    'the fold sets the flag',
  )
})

// ── E. the live invariant still holds ───────────────────────────────────────

test('streaming and waiting add no source rows at all', async () => {
  const { tui } = fixture()
  const rows = tui.rows.length
  tui.streaming = { reasoning: '想一下', text: '正在写的回复' }
  tui.waitStartedAt = Date.now()
  tui.agent.status = 'running'
  tui.paint()
  assert.equal(tui.rows.length, rows, 'runtime state is a projection, not content')
  const audit = tui.representationAudit()
  assert.equal(audit.liveRows, 0)
  assert.equal(audit.unclassified, 0)
})
