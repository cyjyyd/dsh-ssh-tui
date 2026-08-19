import test from 'node:test'
import assert from 'node:assert/strict'

import { listResumableSessions } from '../lib/session-list.js'

function header(id, createdAt, overrides = {}) {
  return {
    version: 0,
    id,
    createdAt,
    cwd: '/root',
    delegationDepth: 0,
    ...overrides,
  }
}

function userMessage(text) {
  return {
    type: 'user/message',
    seq: 4,
    time: 1000,
    data: {
      id: 'm',
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  }
}

function readableSession(id, createdAt, text = `task ${id}`) {
  return {
    meta: header(id, createdAt),
    events: [
      { type: 'permission/preset', seq: 0, time: 100 },
      { type: 'sandbox/mode', seq: 1, time: 101 },
      { type: 'approval/policy', seq: 2, time: 102 },
      { type: 'turn/start', seq: 3, time: 103, data: { turn: 1 } },
      userMessage(text),
      { type: 'turn/end', seq: 5, time: createdAt, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  }
}

test('sessions that fail inspect stay visible and are marked unreadable', async () => {
  const sessions = new Map([
    ['old-readable', readableSession('old-readable', 300)],
    ['new-readable', readableSession('new-readable', 200)],
  ])
  const persistence = {
    list: async () => [
      header('new-readable', 200),
      header('broken-recent', 100),
      header('old-readable', 300),
      header('subagent', 50, { origin: 'subagent', delegationDepth: 1 }),
    ],
    inspect: async (id) => {
      const session = sessions.get(id)
      if (session === undefined) throw new Error('corrupt session log: seq gap')
      return session
    },
  }

  const listed = await listResumableSessions(persistence, '')
  assert.equal(listed.length, 3)
  assert.deepEqual(listed.map(item => item.id), ['old-readable', 'new-readable', 'broken-recent'])
  assert.equal(listed[2].unreadable, true)
  assert.equal(listed[0].unreadable, undefined)
  assert.equal(listed[2].label, 'broken-recent')
})

test('recent empty boot sessions do not hide older readable sessions beyond the first batch', async () => {
  const emptyIds = Array.from({ length: 35 }, (_, index) => `empty-${index}`)
  const realIds = Array.from({ length: 9 }, (_, index) => `real-${index}`)
  const persistence = {
    list: async () => [
      ...emptyIds.map((id, index) => header(id, 5000 - index)),
      ...realIds.map((id, index) => header(id, 1000 - index)),
    ],
    inspect: async (id) => {
      if (id.startsWith('empty-')) {
        return {
          meta: header(id, 5000 - emptyIds.indexOf(id)),
          events: [{ type: 'permission/preset', seq: 0, time: 100, data: {} }],
        }
      }
      return readableSession(id, 1000 - realIds.indexOf(id), `task ${id}`)
    },
  }

  const listed = await listResumableSessions(persistence, '')
  assert.deepEqual(listed.map(item => item.id), realIds)
  assert.equal(listed.every(item => item.unreadable !== true), true)
})

test('the current session is excluded and the result is capped at nine', async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `session-${index}`)
  const persistence = {
    list: async () => ids.map((id, index) => header(id, 1000 - index)),
    inspect: async (id) => readableSession(id, 1000 - ids.indexOf(id), `task ${id}`),
  }

  const listed = await listResumableSessions(persistence, 'session-0')
  assert.equal(listed.length, 9)
  assert.equal(listed.some(item => item.id === 'session-0'), false)
  assert.deepEqual(listed.map(item => item.id), ids.slice(1, 10))
})
