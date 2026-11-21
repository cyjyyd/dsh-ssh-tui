/**
 * The TUI may mount only the one ordinary Session it was launched for.
 *
 * rc.2 removed `AgentRegistry.roots()`; Relay now has to make the same
 * distinction from the Session header. These cases pin the policy directly:
 * an ordinary root (including an ordinary fork with `parentSession`) mounts
 * once, while an exact-id Session whose `origin` is `subagent` never mounts.
 * The already-live lookup and the later `agent/created` event are both covered
 * because production uses both paths.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { SshTui, mountTui } from '../lib/tui.js'

const originalStart = SshTui.prototype.start
const originalReplay = SshTui.prototype.replayHistory
let started = []

SshTui.prototype.start = function () {
  started.push(this.agent?.id ?? this.agent)
}
SshTui.prototype.replayHistory = async function () {}

after(() => {
  SshTui.prototype.start = originalStart
  SshTui.prototype.replayHistory = originalReplay
})

function makeAgent(id, header = {}) {
  return {
    id,
    options: {},
    status: 'idle',
    session: {
      id,
      header: { id, createdAt: 1, ...header },
      events: [],
    },
    cancel() {},
  }
}

function makeContext(agent) {
  const handlers = new Map()
  let current = agent
  const ctx = {
    agents: {
      get(id) {
        return current !== undefined && current.id === id ? current : undefined
      },
    },
    get() {
      return undefined
    },
    on(name, handler) {
      handlers.set(name, handler)
      return () => {
        if (handlers.get(name) === handler) handlers.delete(name)
      }
    },
  }
  return {
    ctx,
    setAgent(next) {
      current = next
    },
    emit(name, payload) {
      handlers.get(name)?.(payload)
    },
  }
}

function mount(ctx, sessionId) {
  return mountTui(ctx, { sessionId, headlessDisplay: true, color: false })
}

test('an ordinary root mounts once through the already-live path and a later event', () => {
  const id = 'synthetic-root'
  const agent = makeAgent(id)
  const fake = makeContext(agent)
  started = []
  mount(fake.ctx, id)
  assert.deepEqual(started, [id], 'the already-live ordinary root mounts once')
  fake.emit('agent/created', { agent })
  assert.deepEqual(started, [id], 'the later agent/created event does not mount it twice')
})

test('a late ordinary root mounts once and ignores duplicate created events', () => {
  const id = 'synthetic-late-root'
  const agent = makeAgent(id)
  const fake = makeContext(undefined)
  started = []
  mount(fake.ctx, id)
  assert.deepEqual(started, [], 'nothing is mounted before the agent exists')
  fake.emit('agent/created', { agent })
  assert.deepEqual(started, [id], 'the created agent mounts once')
  fake.emit('agent/created', { agent })
  assert.deepEqual(started, [id], 'a duplicate event cannot mount it again')
})

test('an exact-id subagent never mounts, through either path', () => {
  const id = 'synthetic-child'
  const agent = makeAgent(id, { origin: 'subagent', parentSession: 'synthetic-root' })
  const fake = makeContext(agent)
  started = []
  mount(fake.ctx, id)
  assert.deepEqual(started, [], 'the already-live subagent is rejected by origin')
  fake.emit('agent/created', { agent })
  assert.deepEqual(started, [], 'the late subagent event is rejected by origin')
})

test('an ordinary fork with parentSession but no subagent origin still mounts', () => {
  const id = 'synthetic-fork'
  const agent = makeAgent(id, { parentSession: 'synthetic-parent' })
  const fake = makeContext(agent)
  started = []
  mount(fake.ctx, id)
  assert.deepEqual(started, [id], 'durable parentSession alone is not a subagent marker')
})

test('a late exact-id subagent cannot mount through agent/created', () => {
  const id = 'synthetic-late-child'
  const agent = makeAgent(id, { origin: 'subagent', parentSession: 'synthetic-root' })
  const fake = makeContext(undefined)
  started = []
  mount(fake.ctx, id)
  fake.emit('agent/created', { agent })
  assert.deepEqual(started, [], 'the late event must apply the same root policy')
})
