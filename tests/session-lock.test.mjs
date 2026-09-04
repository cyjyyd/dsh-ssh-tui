import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from '../lib/i18n/index.js'
setLocale('zh')
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SessionLockHeldError,
  acquireSessionLock,
  formatLockHeldMessage,
  parseSessionLock,
  processIsAlive,
  releaseSessionLock,
  sessionLockPath,
} from '../lib/session-lock.js'

test('parseSessionLock rejects junk and keeps pid/session', () => {
  assert.equal(parseSessionLock('not-json'), undefined)
  assert.equal(parseSessionLock('{"pid":0,"sessionId":"x"}'), undefined)
  const parsed = parseSessionLock(JSON.stringify({ pid: 12, sessionId: 'main-session-1', tty: '/dev/pts/3' }))
  assert.equal(parsed?.pid, 12)
  assert.equal(parsed?.sessionId, 'main-session-1')
  assert.equal(parsed?.tty, '/dev/pts/3')
})

test('sessionLockPath sanitizes session ids', () => {
  const path = sessionLockPath('main-session/../evil id', '/tmp/dsh-home')
  assert.equal(path, join('/tmp/dsh-home', 'tui-locks', 'main-session_.._evil_id.json'))
})

test('formatLockHeldMessage tells the user to attach the live pid', () => {
  const text = formatLockHeldMessage({ pid: 9, sessionId: 's1', startedAt: '', tty: '/dev/pts/2' })
  assert.match(text, /pid 9/)
  assert.match(text, /--resume=s1/)
  assert.equal(text.includes('tmux attach'), false)
})

test('acquireSessionLock steals a stale lock and blocks a live one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-lock-'))
  const sessionId = 'main-session-lock-test'
  const first = await acquireSessionLock(sessionId, { pid: process.pid, dshHome: home, tty: '/dev/pts/1' })
  const raw = await readFile(first.path, 'utf8')
  assert.equal(parseSessionLock(raw)?.pid, process.pid)

  await assert.rejects(
    () => acquireSessionLock(sessionId, { pid: process.pid + 1_000_000, dshHome: home }),
    error => error instanceof SessionLockHeldError && error.lock.pid === process.pid,
  )

  await releaseSessionLock(first.path, process.pid)
  const stalePath = sessionLockPath(sessionId, home)
  await writeFile(stalePath, `${JSON.stringify({ pid: 1_000_000 + process.pid, sessionId, startedAt: new Date().toISOString() }, null, 2)}\n`)
  const stolen = await acquireSessionLock(sessionId, { pid: process.pid, dshHome: home })
  assert.equal(stolen.info.pid, process.pid)
  await releaseSessionLock(stolen.path)
})
