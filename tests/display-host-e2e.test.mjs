import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  probeDisplaySock,
  spawnDetachedHost,
  waitForDisplaySock,
} from '../lib/display-sock.js'

const HOST_FIXTURE = join(import.meta.dirname, 'fixtures', 'display-host.mjs')
const CRASH_FIXTURE = join(import.meta.dirname, 'fixtures', 'display-host-crash.mjs')

/**
 * `spawnDetachedHost` re-runs this invocation (argv + execArgv) with the
 * `--resume` flag; point it at the fixture and drop the test runner's own
 * flags so the child is a plain Host process.
 *
 * `bootstrap: null` forces the direct spawn even where the platform has a
 * hidden-console bootstrap (Windows). These tests are about the direct path's
 * plumbing — a real child handle, its `exit` code and its inherited stderr —
 * which the bootstrap deliberately does not provide: it reports a pid and
 * nothing else (`watchHostPid` resolves `null`). The bootstrap is covered by the
 * builders in `tests/host-bootstrap.test.mjs` and, end to end, by the Windows
 * leg's probes, which boot a real session through this launcher.
 */
function spawnFixtureHost(fixture, sessionId) {
  const argv = process.argv
  const execArgv = process.execArgv
  process.argv = [process.execPath, fixture]
  process.execArgv = []
  try {
    return spawnDetachedHost(sessionId, process.platform, { bootstrap: null })
  } finally {
    process.argv = argv
    process.execArgv = execArgv
  }
}

async function withHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-e2e-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    // A Host that was just killed can still hold its stderr log open on Windows
    // (EBUSY); retrying keeps a cleanup failure from hiding the verdict.
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  return home
}

test('spawnDetachedHost brings up a channel the parent can see', async t => {
  await withHome(t)
  const spawned = spawnFixtureHost(HOST_FIXTURE, 'e2e-live')
  t.after(() => {
    try { process.kill(spawned.pid) } catch { /* already gone */ }
  })
  assert.equal(await probeDisplaySock(spawned.sock, 100), false, 'not up before the host starts')
  try {
    await waitForDisplaySock(spawned.sock, 15_000, spawned.pid, spawned.errFile, spawned.exitWatch)
  } finally {
    spawned.exitWatch.dispose()
  }
  // Readiness is a real connect probe: fs.access() never sees a win32 pipe.
  assert.equal(await probeDisplaySock(spawned.sock), true)
})

test('a host that dies before listening is reported with its stderr', async t => {
  await withHome(t)
  const spawned = spawnFixtureHost(CRASH_FIXTURE, 'e2e-crash')
  const started = Date.now()
  try {
    await assert.rejects(
      () => waitForDisplaySock(spawned.sock, 15_000, spawned.pid, spawned.errFile, spawned.exitWatch),
      error => error instanceof Error
        && error.message.includes(`pid ${spawned.pid} exited before display socket appeared`)
        && error.message.includes('(exit code 3)')
        && error.message.includes('boom from fixture'),
      // The dead pid can be observed before the child's `exit` event lands
      // (Windows does); the launcher waits a bounded moment for it, so the code
      // is part of the report on every platform.
    )
  } finally {
    spawned.exitWatch.dispose()
  }
  assert.ok(Date.now() - started < 10_000, 'a dead host must not burn the full timeout')
})
