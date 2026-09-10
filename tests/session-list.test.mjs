import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from '../lib/i18n/index.js'
setLocale('zh')

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  enterSessionCwd,
  formatFooterCwd,
  listResumableSessions,
  listResumableSessionsProgressive,
  sessionCwdLabel,
} from '../lib/session-list.js'

const testIndexDir = mkdtempSync(join(tmpdir(), 'dsh-tui-index-'))
process.env.DSH_TUI_SESSION_INDEX = join(testIndexDir, 'index.json')

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

test('0.1.5 snapshot list() and open()/read() persistence still lists sessions', async () => {
  const sessions = new Map([
    ['snap-readable', readableSession('snap-readable', 200)],
  ])
  const persistence = {
    list: async () => [
      { header: header('snap-readable', 200), revision: 'r1', sizeBytes: 32 },
    ],
    open: async (id, access) => {
      assert.equal(access, 'read')
      const session = sessions.get(id)
      if (session === undefined) throw new Error('missing')
      return {
        header: session.meta,
        read: async () => ({ events: session.events }),
        close: async () => {},
      }
    },
  }
  const listed = await listResumableSessions(persistence, '', async () => [])
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, 'snap-readable')
})

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

  const listed = await listResumableSessions(persistence, '', async () => [])
  assert.equal(listed.length, 3)
  assert.deepEqual(listed.map(item => item.id), ['old-readable', 'new-readable', 'broken-recent'])
  assert.equal(listed[2].unreadable, true)
  assert.equal(listed[0].unreadable, undefined)
  assert.equal(listed[2].label, 'broken-recent')
})

test('blank sessions are deleted and never listed as resumable', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-blank-'))
  for (const id of ['blank-boot', 'error-kept']) {
    mkdirSync(join(dir, id), { recursive: true })
    writeFileSync(join(dir, id, 'session.jsonl.zstd'), 'x')
  }

  const blank = readableSession('blank-boot', 500)
  blank.events = blank.events.slice(0, 3) // 仅启动事件：无输入、无回复
  const errorReply = readableSession('error-kept', 400)
  errorReply.events = [
    ...errorReply.events,
    { type: 'turn/end', seq: 9, time: 400, data: { turn: 1, reason: { kind: 'error', error: { message: 'xAI 403' } } } },
  ]
  const sessions = new Map([
    ['blank-boot', blank],
    ['error-kept', errorReply],
  ])
  const persistence = {
    list: async () => [header('blank-boot', 500), header('error-kept', 400)],
    inspect: async (id) => sessions.get(id),
    locate: (meta) => ({ kind: 'jsonl', path: join(dir, meta.id, 'session.jsonl.zstd') }),
  }

  const listed = await listResumableSessions(persistence, '', async () => [])
  await new Promise(resolve => setTimeout(resolve, 60)) // 删除是 best-effort 异步
  // 空白会话：删除且不列出；仅剩错误回复会话（错误算回复，保留）
  assert.deepEqual(listed.map(item => item.id), ['error-kept'])
  assert.equal(existsSync(join(dir, 'blank-boot')), false, 'blank artifacts deleted')
  assert.equal(existsSync(join(dir, 'error-kept')), true, 'error-reply session kept')
})

test('blank attachable hosts are stopped and kept out of the picker', async () => {
  const blank = readableSession('blank-live', 500)
  blank.events = blank.events.slice(0, 3)
  const sessions = new Map([['blank-live', blank]])
  const persistence = {
    list: async () => [header('blank-live', 500)],
    inspect: async (id) => sessions.get(id),
    locate: () => undefined,
  }
  const killed = []
  const listHosts = async () => [
    { sessionId: 'blank-live', lock: { pid: 999999, startedAt: new Date().toISOString(), state: 'idle' }, sock: '/tmp/nope.sock' },
  ]
  const originalKill = process.kill
  process.kill = (pid, signal) => { killed.push(pid); return true }
  try {
    const listed = await listResumableSessions(persistence, '', listHosts)
    assert.equal(listed.length, 0)
    assert.deepEqual(killed, [999999])
  } finally {
    process.kill = originalKill
  }
})

test('picker label prefers the persisted title so web and TUI agree', async () => {
  const withTitle = readableSession('titled', 400)
  withTitle.events.splice(5, 0, { type: 'session/title', seq: 6, time: 400, data: { title: '生成标题：修复绘制残留' } })
  const sessions = new Map([['titled', withTitle]])
  const persistence = {
    list: async () => [header('titled', 400)],
    inspect: async (id) => sessions.get(id),
  }
  const listed = await listResumableSessions(persistence, '', async () => [])
  assert.equal(listed.length, 1)
  // web 列表显示同一份 session/title 持久化标题——两端标签一致，切换模式可寻
  assert.equal(listed[0].label, '生成标题：修复绘制残留')
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

  const listed = await listResumableSessions(persistence, '', async () => [])
  assert.deepEqual(listed.map(item => item.id), realIds)
  assert.equal(listed.every(item => item.unreadable !== true), true)
})

test('the current session is excluded and older sessions stay listed past nine', async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `session-${index}`)
  const persistence = {
    list: async () => ids.map((id, index) => header(id, 1000 - index)),
    inspect: async (id) => readableSession(id, 1000 - ids.indexOf(id), `task ${id}`),
  }

  const listed = await listResumableSessions(persistence, 'session-0', async () => [])
  assert.equal(listed.length, 11)
  assert.equal(listed.some(item => item.id === 'session-0'), false)
  assert.deepEqual(listed.map(item => item.id), ids.slice(1))
})

test('session index cache skips inspect when the artifact fingerprint matches', async () => {
  const { writeFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-index-log-'))
  const artifact = join(dir, 'session.jsonl.zstd')
  writeFileSync(artifact, 'x')
  const sessions = new Map([['cached', readableSession('cached', 400, 'cached task')]])
  let inspects = 0
  const persistence = {
    list: async () => [header('cached', 400)],
    inspect: async (id) => {
      inspects += 1
      return sessions.get(id)
    },
    locate: () => ({ kind: 'jsonl', path: artifact }),
  }
  const indexPath = join(dir, 'index.json')
  const first = await listResumableSessionsProgressive(persistence, '', {
    listHosts: async () => [],
    indexPath,
  })
  assert.equal(first.complete[0].label, 'cached task')
  assert.equal(inspects, 1)
  const second = await listResumableSessionsProgressive(persistence, '', {
    listHosts: async () => [],
    indexPath,
  })
  assert.equal(second.complete[0].label, 'cached task')
  assert.equal(inspects, 1)
})

test('progressive listing paints the newest page before inspecting the rest', async () => {
  const ids = Array.from({ length: 20 }, (_, index) => `session-${index}`)
  const seen = []
  const updates = []
  const persistence = {
    list: async () => ids.map((id, index) => header(id, 2000 - index)),
    inspect: async (id) => {
      seen.push(id)
      return readableSession(id, 2000 - ids.indexOf(id), `task ${id}`)
    },
  }
  const listed = await listResumableSessionsProgressive(persistence, '', {
    listHosts: async () => [],
    indexPath: join(testIndexDir, 'progressive.json'),
    priorityCount: 4,
    onUpdate: (listing) => { updates.push({ pending: listing.pending, count: listing.sessions.length }) },
  })
  assert.deepEqual(seen.slice(0, 4), ids.slice(0, 4))
  assert.equal(listed.complete.length, 20)
  assert.equal(updates[0].pending, true)
  assert.equal(updates[0].count, 20)
  assert.equal(updates.at(-1).pending, false)
  assert.equal(updates.at(-1).count, 20)
})

test('attachable hosts are injected at the front of the picker list', async () => {
  const persistence = {
    list: async () => [header('logged', 100)],
    inspect: async (id) => readableSession(id, 100, 'logged task'),
  }
  const listed = await listResumableSessions(persistence, '', async () => [{
    sessionId: 'live-host',
    lock: { pid: 42, sessionId: 'live-host', startedAt: '2026-09-04T00:00:00.000Z', state: 'paused' },
    sock: '/tmp/live-host.sock',
  }])
  assert.equal(listed[0].id, 'live-host')
  assert.equal(listed[0].attach?.pid, 42)
  assert.equal(listed[1].id, 'logged')
  assert.equal(listed[1].attach, undefined)
})

test('sessionCwdLabel keeps the last folder name', () => {
  assert.equal(sessionCwdLabel('/root/genshin/srv'), 'srv')
  assert.equal(sessionCwdLabel('\\root\\genshin\\srv\\'), 'srv')
  assert.equal(sessionCwdLabel('/'), '/')
  assert.equal(formatFooterCwd('/root/genshin/srv'), '目录:srv')
  assert.equal(formatFooterCwd(''), '')
})

test('enterSessionCwd switches into an absolute existing directory', () => {
  const calls = []
  const ok = enterSessionCwd('/root/genshin/srv', {
    current: '/tmp',
    exists: () => true,
    chdir: (path) => { calls.push(path) },
  })
  assert.deepEqual(ok, { cwd: '/root/genshin/srv', changed: true })
  assert.deepEqual(calls, ['/root/genshin/srv'])
  const missing = enterSessionCwd('/gone', {
    current: '/tmp',
    exists: () => false,
    chdir: () => { throw new Error('should not chdir') },
  })
  assert.equal(missing.changed, false)
  assert.equal(missing.cwd, '/tmp')
  assert.match(missing.error ?? '', /不存在/)
  const relative = enterSessionCwd('relative/path', {
    current: '/tmp',
    exists: () => true,
    chdir: () => { throw new Error('should not chdir') },
  })
  assert.equal(relative.changed, false)
  assert.match(relative.error ?? '', /不是绝对路径/)
})
