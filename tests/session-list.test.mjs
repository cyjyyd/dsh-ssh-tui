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
  openResumableSessionPager,
  PICKER_PAGE_SIZE,
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

test('a live host whose log cannot be read is kept, never killed or pruned', async () => {
  const { existsSync, mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-live-unreadable-'))
  const id = 'live-unreadable'
  mkdirSync(join(dir, id), { recursive: true })
  writeFileSync(join(dir, id, 'session.jsonl.zstd'), 'x')
  const persistence = {
    list: async () => [],
    inspect: async () => { throw new Error('corrupt session log: seq gap') },
    locate: meta => ({ kind: 'jsonl', path: join(dir, meta.id, 'session.jsonl.zstd') }),
  }
  const killed = []
  const originalKill = process.kill
  process.kill = (pid, signal) => { killed.push(pid); return true }
  try {
    const listed = await listResumableSessions(persistence, '', async () => [
      { sessionId: id, lock: { pid: 424242, startedAt: new Date().toISOString(), state: 'running-detached' }, sock: '/tmp/nope.sock' },
    ])
    assert.deepEqual(listed.map(item => item.id), [id])
    assert.equal(listed[0].unreadable, true)
    assert.equal(listed[0].attach?.pid, 424242)
    assert.deepEqual(killed, [], 'a read failure is not evidence of a blank boot')
    assert.equal(existsSync(join(dir, id)), true, 'nothing may be pruned on a failed read')
  } finally {
    process.kill = originalKill
  }
})

test('a detached read is unreadable, not blank: the log is not pruned', async () => {
  const { existsSync, mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-detached-'))
  const id = 'detached-live'
  mkdirSync(join(dir, id), { recursive: true })
  writeFileSync(join(dir, id, 'session.jsonl.zstd'), 'x')
  const persistence = {
    list: async () => [header(id, 500)],
    inspect: async () => ({ events: [], eventState: 'detached', meta: header(id, 500) }),
    locate: meta => ({ kind: 'jsonl', path: join(dir, meta.id, 'session.jsonl.zstd') }),
  }
  const listed = await listResumableSessions(persistence, '', async () => [])
  await new Promise(resolve => setTimeout(resolve, 60)) // 删除是 best-effort 异步
  assert.deepEqual(listed.map(item => item.id), [id])
  assert.equal(listed[0].unreadable, true)
  assert.equal(existsSync(join(dir, id)), true, 'an unmaterialized read must not delete artifacts')
})

test('a read handle without read() is unreadable, not blank', async () => {
  const id = 'no-read-api'
  const persistence = {
    list: async () => [header(id, 500)],
    open: async () => ({ header: header(id, 500) }),
  }
  const listed = await listResumableSessions(persistence, '', async () => [])
  assert.deepEqual(listed.map(item => item.id), [id])
  assert.equal(listed[0].unreadable, true)
})

test('an inspect() result without an events array is unreadable, not blank', async () => {
  const id = 'no-events-field'
  const persistence = {
    list: async () => [header(id, 500)],
    inspect: async () => ({ meta: header(id, 500) }),
  }
  const listed = await listResumableSessions(persistence, '', async () => [])
  assert.deepEqual(listed.map(item => item.id), [id])
  assert.equal(listed[0].unreadable, true)
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

// The picker's first frame is a header sketch; entries it cannot name yet are
// marked instead of being labelled with their raw id. The consumer side is
// tested in picker.test.mjs, but if the lister stops marking them the picker
// happily paints uuids again — so assert the producer here.
test('the first listing marks entries whose label is still an id', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-pending-'))
  const indexPath = join(dir, 'index.json')
  for (const id of ['cold-one', 'cold-two']) {
    mkdirSync(join(dir, id), { recursive: true })
    writeFileSync(join(dir, id, 'session.jsonl.zstd'), 'x')
  }
  const sessions = new Map([
    ['cold-one', readableSession('cold-one', 900, '冷启动第一条')],
    ['cold-two', readableSession('cold-two', 800, '冷启动第二条')],
  ])
  const persistence = {
    list: async () => [header('cold-one', 900), header('cold-two', 800)],
    inspect: async id => sessions.get(id),
    locate: meta => ({ kind: 'jsonl', path: join(dir, meta.id, 'session.jsonl.zstd') }),
  }
  const frames = []
  await listResumableSessionsProgressive(persistence, '', {
    onUpdate: listing => frames.push(listing),
    listHosts: async () => [],
    indexPath,
    priorityCount: 1,
  })
  assert.ok(frames.length >= 2, 'the sketch is painted before the later batches')
  const sketch = frames[0]
  assert.equal(sketch.pending, true)
  assert.equal(sketch.sessions.every(session => session.labelPending === true), true,
    'nothing has been inspected yet, so every label is a placeholder')
  assert.equal(sketch.sessions.some(session => session.label === session.id), true,
    'the placeholder really is the id (that is why it must not be painted)')
  const last = frames.at(-1)
  assert.equal(last.pending, false)
  assert.equal(last.sessions.every(session => session.labelPending !== true), true,
    'the final listing carries real titles')
  assert.deepEqual(last.sessions.map(session => session.label).sort(), ['冷启动第一条', '冷启动第二条'])
})

// The index used to be written only after every log had been inspected, so a
// picker the user closed early left the next run without titles (raw ids
// again). It is flushed as soon as a title exists, and that title is painted
// without waiting for the rest of the newest page.
test('a title is cached and painted as soon as it resolves', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-flush-'))
  const indexPath = join(dir, 'index.json')
  const ids = ['page-fast', 'page-slow-a', 'page-slow-b', 'page-rest']
  for (const id of ids) {
    mkdirSync(join(dir, id), { recursive: true })
    writeFileSync(join(dir, id, 'session.jsonl.zstd'), 'x')
  }
  const sessions = new Map(ids.map((id, index) => [id, readableSession(id, 900 - index, `标题 ${id}`)]))
  const slowResolved = []
  const persistence = {
    list: async () => ids.map((id, index) => header(id, 900 - index)),
    inspect: async (id) => {
      if (id === 'page-slow-a' || id === 'page-slow-b') {
        await new Promise(resolve => setTimeout(resolve, 150))
        slowResolved.push(id)
      }
      return sessions.get(id)
    },
    locate: meta => ({ kind: 'jsonl', path: join(dir, meta.id, 'session.jsonl.zstd') }),
  }
  const frames = []
  await listResumableSessionsProgressive(persistence, '', {
    onUpdate: listing => frames.push({
      ...listing,
      slowResolved: slowResolved.length,
      // Read the index *while the frame is painted*: it also gets written at
      // the very end, which would make a "was it cached early?" check useless.
      indexAtPaint: existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : undefined,
    }),
    listHosts: async () => [],
    indexPath,
    priorityCount: 3,
  })
  const titled = frames.find(frame => frame.sessions.some(session => session.labelPending !== true))
  assert.notEqual(titled, undefined, 'a titled frame was painted')
  assert.equal(titled.slowResolved, 0, 'the fast title is painted before the slow logs finish')
  assert.equal(titled.sessions.length, 1, 'only the resolved entry is in that frame')
  assert.notEqual(titled.indexAtPaint, undefined, 'the index is already written by that frame')
  assert.equal(titled.indexAtPaint.includes('标题 page-fast'), true)
})

// ── lazy paging ─────────────────────────────────────────────────────────────
//
// The picker reads one page up front and paints it only when every row has a
// real title; older sessions are read on demand. A full scan before the first
// frame is what made a large history feel like a hang.

function pagerFor(ids, { indexPath, labels = {}, hosts = async () => [] } = {}) {
  const persistence = {
    list: async () => ids.map((id, index) => header(id, 2000 - index)),
    inspect: async (id) => {
      if (labels[id] === null) {
        return { meta: header(id, 2000 - ids.indexOf(id)), events: [{ type: 'permission/preset', seq: 0, time: 100, data: {} }] }
      }
      return readableSession(id, 2000 - ids.indexOf(id), labels[id] ?? `标题 ${id}`)
    },
  }
  return openResumableSessionPager(persistence, '', { listHosts: hosts, indexPath })
}

test('the first page is steady and counts what it left unread', async () => {
  const ids = Array.from({ length: 25 }, (_, index) => `page-${index}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-pager-'))
  const pager = await pagerFor(ids, { indexPath: join(dir, 'index.json') })

  const first = await pager.page()
  assert.equal(first.sessions.length, PICKER_PAGE_SIZE)
  assert.equal(first.done, false)
  assert.equal(first.remaining, ids.length - PICKER_PAGE_SIZE)
  assert.equal(first.sessions.every(item => item.labelPending !== true), true,
    'a page never carries a placeholder label')
  assert.equal(first.sessions.every(item => item.label.startsWith('标题 ')), true)
  assert.deepEqual(first.sessions.map(item => item.id), ids.slice(0, PICKER_PAGE_SIZE))
})

test('a later page appends older sessions to the same list', async () => {
  const ids = Array.from({ length: 25 }, (_, index) => `page-${index}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-pager-'))
  const pager = await pagerFor(ids, { indexPath: join(dir, 'index.json') })

  await pager.page()
  const second = await pager.page()
  assert.equal(second.sessions.length, PICKER_PAGE_SIZE * 2)
  assert.deepEqual(second.sessions.map(item => item.id), ids.slice(0, PICKER_PAGE_SIZE * 2))
  assert.equal(second.remaining, ids.length - PICKER_PAGE_SIZE * 2)

  const last = await pager.page()
  assert.equal(last.sessions.length, 25)
  assert.equal(last.done, true)
  assert.equal(last.remaining, 0)
})

test('blank sessions do not consume a page', async () => {
  const blanks = Array.from({ length: 6 }, (_, index) => `blank-${index}`)
  const real = Array.from({ length: 9 }, (_, index) => `real-${index}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-pager-'))
  const pager = await pagerFor([...blanks, ...real], {
    indexPath: join(dir, 'index.json'),
    labels: Object.fromEntries(blanks.map(id => [id, null])),
  })
  const page = await pager.page()
  assert.equal(page.sessions.length, PICKER_PAGE_SIZE, 'a page of real rows, blanks skipped')
  assert.deepEqual(page.sessions.map(item => item.id), real)
})

test('the index is flushed as soon as the first page is read', async () => {
  const { readFileSync, existsSync, writeFileSync, mkdirSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-pager-index-'))
  const indexPath = join(dir, 'index.json')
  // The cache is keyed by the log's fingerprint, so the fake persistence has to
  // point at a real file for the page to have something to cache.
  mkdirSync(join(dir, 'flushed-a'), { recursive: true })
  writeFileSync(join(dir, 'flushed-a', 'session.jsonl.zstd'), 'x')
  const persistence = {
    list: async () => [header('flushed-a', 500)],
    inspect: async () => readableSession('flushed-a', 500, '缓存标题'),
    locate: () => ({ kind: 'jsonl', path: join(dir, 'flushed-a', 'session.jsonl.zstd') }),
  }
  const pager = await openResumableSessionPager(persistence, '', {
    listHosts: async () => [],
    indexPath,
  })
  assert.equal(existsSync(indexPath), false, 'nothing is written before the first page')
  const page = await pager.page()
  assert.equal(page.sessions[0].label, '缓存标题')
  assert.equal(existsSync(indexPath), true)
  assert.equal(readFileSync(indexPath, 'utf8').includes('缓存标题'), true)
})

test('complete() reads everything the eager listing would', async () => {
  const ids = Array.from({ length: 21 }, (_, index) => `all-${index}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-pager-'))
  const pager = await pagerFor(ids, { indexPath: join(dir, 'index.json') })
  const complete = await pager.complete()
  assert.equal(complete.length, ids.length)

  const eager = await listResumableSessions({
    list: async () => ids.map((id, index) => header(id, 2000 - index)),
    inspect: async id => readableSession(id, 2000 - ids.indexOf(id), `标题 ${id}`),
  }, '', async () => [])
  assert.deepEqual(complete.map(item => item.id), eager.map(item => item.id))
})

test('a live host joins the first page even when its header is far down the history', async () => {
  const ids = Array.from({ length: 30 }, (_, index) => `page-${index}`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-pager-host-'))
  const hosts = async () => [{
    sessionId: 'page-29',
    lock: { pid: 77, sessionId: 'page-29', startedAt: '2026-09-04T00:00:00.000Z', state: 'running-detached' },
    sock: '/tmp/page-29.sock',
  }]
  const pager = await pagerFor(ids, { indexPath: join(dir, 'index.json'), hosts })
  const first = await pager.page()
  assert.equal(first.sessions[0].id, 'page-29', 'an attachable host leads the list')
  assert.equal(first.sessions[0].attach?.pid, 77)
})
