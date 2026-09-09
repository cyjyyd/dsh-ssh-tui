import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { setLocale } from '../lib/i18n/index.js'
setLocale('zh')
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SessionLockHeldError,
  acquireSessionLock,
  formatLockHeldMessage,
  inspectLiveHost,
  listAttachableHosts,
  parseSessionLock,
  processIsAlive,
  releaseSessionLock,
  sessionLockPath,
} from '../lib/session-lock.js'

function readBootId() {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    return undefined
  }
}

function procStarttimeOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[22 - 3]
  } catch {
    return undefined
  }
}

const bootId = readBootId()

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

test('inspectLiveHost is attachable only while the host pid is alive', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-lock-'))
  const sessionId = 'main-session-attach'
  const sock = join(home, 'tui-socks', `${sessionId}.sock`)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(home, 'tui-locks'), { recursive: true })
  await mkdir(join(home, 'tui-socks'), { recursive: true })
  await writeFile(join(home, 'tui-locks', `${sessionId}.json`), `${JSON.stringify({
    pid: process.pid,
    sessionId,
    startedAt: new Date().toISOString(),
    bootId,
    pidStart: procStarttimeOf(process.pid),
    sock,
    state: 'paused',
  }, null, 2)}\n`)
  await writeFile(sock, '')
  const live = await inspectLiveHost(sessionId, home)
  assert.equal(live?.kind, 'attachable')
  assert.equal(live?.sock, sock)
})

test('a dead pid with a leftover sock is not attachable and the lock is stolen', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-lock-'))
  const sessionId = 'main-session/dead host'
  const safe = sessionId.replaceAll(/[^A-Za-z0-9._-]/g, '_')
  const sock = join(home, 'tui-socks', `${safe}.sock`)
  const { mkdir, access } = await import('node:fs/promises')
  await mkdir(join(home, 'tui-locks'), { recursive: true })
  await mkdir(join(home, 'tui-socks'), { recursive: true })
  await writeFile(join(home, 'tui-locks', `${safe}.json`), `${JSON.stringify({
    pid: 1_000_000_000,
    sessionId,
    startedAt: new Date().toISOString(),
    sock,
    state: 'paused',
  }, null, 2)}\n`)
  await writeFile(sock, '')
  assert.equal(await inspectLiveHost(sessionId, home), undefined)
  assert.deepEqual(await listAttachableHosts(home), [])
  await assert.rejects(() => access(join(home, 'tui-locks', `${safe}.json`)))
  const stolen = await acquireSessionLock(sessionId, { pid: process.pid, dshHome: home })
  assert.equal(stolen.info.pid, process.pid)
  await releaseSessionLock(stolen.path)
})

// --- regression: a pid recorded in another pid namespace must not block resume ---

const HOST_FIXTURE = join(import.meta.dirname, 'fixtures', 'sleep-host.mjs')
const posixOnly = { skip: bootId === undefined }

function spawnHost(sid) {
  return spawn(process.execPath, [HOST_FIXTURE, '--profile', 'tui', `--resume=${sid}`], { stdio: 'ignore' })
}

function spawnDecoy() {
  return spawn(process.execPath, [HOST_FIXTURE, '--profile', 'tui', '--not-a-host'], { stdio: 'ignore' })
}

function lockJson(sid, pid, sock, extra = {}) {
  return `${JSON.stringify({
    pid, sessionId: sid, startedAt: new Date().toISOString(),
    ...extra, sock, state: 'paused', disconnectPolicy: 'pause', agentStatus: 'idle',
  }, null, 2)}\n`
}

async function makeHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-lock-'))
  const { mkdir, rm } = await import('node:fs/promises')
  await mkdir(join(home, 'tui-locks'), { recursive: true })
  await mkdir(join(home, 'tui-socks'), { recursive: true })
  t.after(async () => { await rm(home, { recursive: true, force: true }) })
  return home
}

test('old-format lock: alive pid that is not the Host is stolen, a genuine Host is kept', posixOnly, async t => {
  const home = await makeHome(t)
  const decoy = spawnDecoy()
  t.after(() => decoy.kill('SIGKILL'))
  await new Promise(resolve => setTimeout(resolve, 300))

  // pid is alive but unrelated (no --resume=<sid> in its cmdline) → stale.
  const sid = 'main-session-recycled-pid'
  const sock = join(home, 'tui-socks', `${sid}.sock`)
  const lockPath = join(home, 'tui-locks', `${sid}.json`)
  await writeFile(lockPath, lockJson(sid, decoy.pid, sock))
  assert.equal(await inspectLiveHost(sid, home), undefined, 'unrelated alive pid must be stolen')
  assert.equal(existsSync(lockPath), false)

  // genuine host: cmdline carries --resume=<sid> → attachable, then zombie.
  const hostSid = 'main-session-genuine-host'
  const host = spawnHost(hostSid)
  t.after(() => host.kill('SIGKILL'))
  await new Promise(resolve => setTimeout(resolve, 300))
  const hostSock = join(home, 'tui-socks', `${hostSid}.sock`)
  await writeFile(hostSock, '')
  await writeFile(join(home, 'tui-locks', `${hostSid}.json`), lockJson(hostSid, host.pid, hostSock))
  assert.equal((await inspectLiveHost(hostSid, home))?.kind, 'attachable')
  const { rm } = await import('node:fs/promises')
  await rm(hostSock)
  assert.equal((await inspectLiveHost(hostSid, home))?.kind, 'zombie')
})

test('new-format lock: bootId+pidStart decide staleness, not kill(pid, 0)', posixOnly, async t => {
  const home = await makeHome(t)
  const sid = 'main-session-identity'
  const host = spawnHost(sid)
  t.after(() => host.kill('SIGKILL'))
  await new Promise(resolve => setTimeout(resolve, 300))
  const sock = join(home, 'tui-socks', `${sid}.sock`)
  const lockPath = join(home, 'tui-locks', `${sid}.json`)

  await writeFile(sock, '')
  await writeFile(lockPath, lockJson(sid, host.pid, sock, {
    bootId, pidStart: procStarttimeOf(host.pid),
  }))
  assert.equal((await inspectLiveHost(sid, home))?.kind, 'attachable', 'matching identity must attach')
  const { rm } = await import('node:fs/promises')
  await rm(sock)
  assert.equal((await inspectLiveHost(sid, home))?.kind, 'zombie', 'alive Host without socket stays zombie')

  // same pid but a foreign boot identity (recycled pid / cross-namespace) → stale.
  await writeFile(sock, '')
  await writeFile(lockPath, lockJson(sid, host.pid, sock, {
    bootId: '00000000-0000-0000-0000-000000000000', pidStart: '1',
  }))
  assert.equal(await inspectLiveHost(sid, home), undefined, 'foreign identity must be stolen')
  assert.equal(existsSync(sock), false, 'stale socket removed too')
})

test('acquire steals a stale old-format lock and records identity on the new lock', posixOnly, async t => {
  const home = await makeHome(t)
  const sid = 'main-session-steal'
  const host = spawnHost(sid)
  const decoy = spawnDecoy()
  t.after(() => { host.kill('SIGKILL'); decoy.kill('SIGKILL') })
  await new Promise(resolve => setTimeout(resolve, 300))
  const sock = join(home, 'tui-socks', `${sid}.sock`)
  await writeFile(join(home, 'tui-locks', `${sid}.json`), lockJson(sid, decoy.pid, sock))

  const { path, info } = await acquireSessionLock(sid, { pid: host.pid, dshHome: home })
  assert.equal(info.pid, host.pid)
  assert.equal(info.bootId, bootId, 'new lock records bootId')
  assert.equal(info.pidStart, procStarttimeOf(host.pid), 'new lock records pidStart')
  assert.equal(parseSessionLock(await readFile(path, 'utf8'))?.bootId, bootId, 'parse keeps bootId')

  await assert.rejects(
    () => acquireSessionLock(sid, { pid: decoy.pid, dshHome: home }),
    error => error instanceof SessionLockHeldError && error.lock.pid === host.pid,
    'a live genuine Host lock must still block acquisition',
  )
  await releaseSessionLock(path, host.pid)
})

test('real-world pid-5 leftovers are classified stale', posixOnly, async t => {
  const home = await makeHome(t)
  for (const sid of [
    'main-session-79b3cc75-1ca3-40e2-87b5-3c5cc6d8dafc',
    'main-session-916ce9a2-3d6e-4e73-97e4-9e23bbddcdb7',
  ]) {
    await writeFile(join(home, 'tui-locks', `${sid}.json`),
      lockJson(sid, 5, join(home, 'tui-socks', `${sid}.sock`)))
    assert.equal(await inspectLiveHost(sid, home), undefined, `${sid} must be stolen`)
  }
})
