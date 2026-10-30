/**
 * PERF-085-LONG-R4.A — unrelated subagent-row scans on ordinary `tool/result`.
 *
 * The spawn-card lookup historically ran for *every* tool result, walking up to
 * 5,000 transcript rows each time. These tests count the scans and the rows
 * visited from the TUI's own `rows` gate, and pin the subagent semantics the
 * guard must keep: a replayed courtesy chip, a live child that owns its spawn,
 * a denied wrapper with no child, unknown/late/duplicate results and eviction.
 *
 * Synthetic events only: no real session log, path or credential is read.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SshTui } from '../lib/tui.js'

/**
 * A spawn-card predicate is the only `findLast` predicate that reads `runId` or
 * `spawnCallId` off a subagent-shaped candidate; a tool-card predicate stops at
 * `kind`. Probe with getters instead of guessing the call id the closure holds.
 */
function isSpawnPredicate(predicate, thisArg) {
  let reads = 0
  const probe = { kind: 'subagent' }
  for (const field of ['runId', 'spawnCallId']) {
    Object.defineProperty(probe, field, { get() { reads += 1; return '\u0000probe' } })
  }
  try { predicate.call(thisArg, probe, 0, []) } catch { /* a throwing probe is not ours */ }
  return reads > 0
}

/** Count `rows.findLast` calls and, separately, the spawn-card scans. */
function countRowScans(tui) {
  const stats = { findLastCalls: 0, spawnScans: 0, spawnRowsVisited: 0 }
  const target = tui.rows
  tui.rows = new Proxy(target, {
    get(object, property) {
      if (property === 'findLast') {
        return (predicate, thisArg) => {
          stats.findLastCalls += 1
          if (!isSpawnPredicate(predicate, thisArg)) {
            return Array.prototype.findLast.call(object, predicate, thisArg)
          }
          stats.spawnScans += 1
          return Array.prototype.findLast.call(object, (row, index, array) => {
            stats.spawnRowsVisited += 1
            return predicate.call(thisArg, row, index, array)
          }, thisArg)
        }
      }
      return Reflect.get(object, property, object)
    },
    set(object, property, value) {
      Reflect.set(object, property, value)
      return true
    },
  })
  return stats
}

function makeTui({ replaying = false } = {}) {
  const ctx = { get() { return undefined }, on() { return () => {} } }
  const agent = {
    id: 'synthetic-r4a', options: {}, status: 'idle',
    session: { id: 'synthetic-r4a', events: [] },
    cancel() {}, steer() {}, followup() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: agent.id, headlessDisplay: true, color: false })
  tui.replaying = replaying
  tui.loadingHistory = replaying
  return { tui, agent }
}

let clock = 1_000
function send(tui, event) {
  clock += 1
  tui.handleSessionEvent({ id: 'synthetic-r4a' }, { ...event, time: clock })
}

function toolCall(callId, name = 'shell', args = '{}') {
  return { type: 'tool/call', data: { name, callId, arguments: args } }
}
function toolResult(callId, { text = 'ok', error } = {}) {
  return {
    type: 'tool/result',
    data: {
      ...(error === undefined ? {} : { error }),
      message: { role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'text', text }] },
    },
  }
}
function spawnCall(callId, description = 'scan the tree') {
  return toolCall(callId, 'subagent', JSON.stringify({ description, prompt: 'go' }))
}

/** Seed ordinary transcript rows without going through a spawn path. */
function seedRows(tui, count) {
  for (let i = 0; i < count; i += 1) {
    tui.rows.push({ kind: 'assistant', text: `synthetic row ${i}`, expanded: false })
  }
}

test('an ordinary tool result never pays a subagent-row scan', () => {
  const { tui } = makeTui()
  send(tui, toolCall('call-ordinary'))
  seedRows(tui, 400)
  const before = tui.rows.length
  const stats = countRowScans(tui)
  send(tui, toolResult('call-ordinary', { text: 'hello' }))

  assert.equal(stats.spawnScans, 0, 'no spawn card can be keyed by an ordinary call')
  assert.equal(stats.spawnRowsVisited, 0, 'no row is visited for a spawn match')
  // The ordinary card still settles exactly as before.
  const row = tui.rows.find(candidate => candidate.kind === 'tool' && candidate.callId === 'call-ordinary')
  assert.equal(row?.status, 'ok')
  assert.equal(row?.output, 'hello')
  assert.equal(tui.rows.length, before, 'the result adds no row of its own')
})

test('a replayed spawn result still settles its courtesy chip', () => {
  const { tui } = makeTui({ replaying: true })
  send(tui, spawnCall('spawn-replay', 'scan the tree'))
  assert.equal(tui.rows.filter(row => row.kind === 'subagent').length, 1, 'replay draws the courtesy chip')
  const stats = countRowScans(tui)
  send(tui, toolResult('spawn-replay', { text: 'child started' }))

  assert.equal(stats.spawnScans, 1, 'a spawn result is still relevance-checked against the rows')
  const cards = tui.rows.filter(row => row.kind === 'subagent')
  assert.equal(cards.length, 1, 'no twin chip beside the courtesy card')
  assert.equal(cards[0].status, 'ok')
  assert.equal(cards[0].childSessionId, undefined, 'replay has no child session id')
  assert.equal(cards[0].spawnCallId, 'spawn-replay')
  assert.equal(tui.rows.filter(row => row.kind === 'tool').length, 0, 'no generic subagent tool card')
})

test('a live child owns the wrapper result instead of a 0s twin', () => {
  const { tui } = makeTui()
  send(tui, spawnCall('spawn-live', 'edit src/tui.ts'))
  tui.handleSubagentStart({ runId: 'run-live', id: 'child-live', provider: 'spawn', local: true })
  const stats = countRowScans(tui)
  send(tui, toolResult('spawn-live', { text: 'started' }))

  assert.equal(stats.spawnScans, 1)
  assert.equal(tui.rows.filter(row => row.kind === 'subagent').length, 1)
  const card = tui.rows.find(row => row.kind === 'subagent')
  assert.equal(card.childSessionId, 'child-live')
  assert.equal(card.runId, 'run-live')
  assert.equal(card.status, 'running', 'only the child end settles the chip')
  assert.equal(tui.pendingSubagentTasks.length, 0)
})

test('a wrapper denied without a child leaves neither chip nor tool card', () => {
  const { tui } = makeTui()
  send(tui, spawnCall('spawn-denied', 'scan /nowhere'))
  const stats = countRowScans(tui)
  send(tui, toolResult('spawn-denied', { text: 'denied', error: { message: 'approval denied' } }))

  assert.equal(stats.spawnScans, 1, 'the wrapper must still look for a courtesy chip')
  assert.equal(tui.rows.filter(row => row.kind === 'subagent').length, 0)
  assert.equal(tui.rows.filter(row => row.kind === 'tool').length, 0)
  assert.equal(tui.pendingSubagentTasks.length, 0, 'the description is not left for the next child')
})

test('an unknown call id keeps the conservative scan', () => {
  const { tui } = makeTui({ replaying: true })
  seedRows(tui, 50)
  const rowsBefore = tui.rows.length
  const stats = countRowScans(tui)
  send(tui, toolResult('call-never-seen', { text: 'late output' }))

  assert.equal(stats.spawnScans, 1, 'without a recorded name the result may still be a spawn')
  assert.equal(stats.spawnRowsVisited, rowsBefore, 'the uncertain probe walks the whole transcript')
  assert.equal(tui.rows.filter(row => row.kind === 'tool').length, 1, 'the fallback card is unchanged')
})

test('a result after the turn boundary still settles an unfinished replay chip', () => {
  const { tui } = makeTui({ replaying: true })
  send(tui, spawnCall('spawn-late', 'scan after the turn'))
  send(tui, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(tui.toolCallNames.size, 0, 'the turn reset drops the name association')
  const stats = countRowScans(tui)
  send(tui, toolResult('spawn-late', { text: 'child started late' }))

  assert.equal(stats.spawnScans, 1, 'a cleared name is an uncertain result, not a non-spawn one')
  const card = tui.rows.find(row => row.kind === 'subagent')
  assert.equal(card.status, 'ok', 'the courtesy chip is still settled by the late result')
})

test('a duplicate spawn result settles once and adds no row', () => {
  const { tui } = makeTui({ replaying: true })
  send(tui, spawnCall('spawn-twice', 'scan twice'))
  send(tui, toolResult('spawn-twice', { text: 'first' }))
  const before = tui.rows.length
  const stats = countRowScans(tui)
  send(tui, toolResult('spawn-twice', { text: 'second' }))

  assert.equal(stats.spawnScans, 1, 'the second result is still a spawn result')
  assert.equal(tui.rows.length, before)
  assert.equal(tui.rows.filter(row => row.kind === 'subagent').length, 1)
})

test('an evicted courtesy chip is not resurrected by its result', () => {
  const { tui } = makeTui({ replaying: true })
  send(tui, spawnCall('spawn-evicted', 'scan then vanish'))
  // Fill the transcript past its 5,000-row cap: the cap is enforced on push.
  for (let i = 0; i < 5_100; i += 1) {
    send(tui, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: `row ${i}` }] } } })
  }
  assert.equal(tui.rows.length, 5_000)
  assert.equal(tui.rows.some(row => row.kind === 'subagent'), false, 'the chip was evicted')
  const stats = countRowScans(tui)
  send(tui, toolResult('spawn-evicted', { text: 'late' }))

  assert.equal(stats.spawnScans, 1, 'the name still proves this is a spawn result')
  assert.equal(tui.rows.some(row => row.kind === 'subagent'), false, 'no chip is recreated from a result')
})

test('interleaved ordinary and subagent results each take their own path', () => {
  const { tui } = makeTui({ replaying: true })
  send(tui, spawnCall('spawn-a', 'first child'))
  send(tui, toolCall('call-a'))
  send(tui, toolCall('call-b'))
  const stats = countRowScans(tui)
  send(tui, toolResult('call-a', { text: 'ordinary a' }))
  assert.equal(stats.spawnScans, 0)
  send(tui, toolResult('spawn-a', { text: 'child started' }))
  assert.equal(stats.spawnScans, 1)
  send(tui, toolResult('call-b', { text: 'ordinary b' }))
  assert.equal(stats.spawnScans, 1, 'the ordinary result after a spawn adds no scan')

  const kinds = tui.rows.map(row => row.kind)
  assert.deepEqual(kinds.filter(kind => kind === 'subagent').length, 1)
  assert.equal(tui.rows.find(row => row.kind === 'subagent').status, 'ok')
  assert.equal(tui.rows.filter(row => row.kind === 'tool').every(row => row.status === 'ok'), true)
})
