import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { aclUserName, restrictPathArgs, restrictPathToUser, restrictPathToUserSync } from '../lib/platform.js'

/**
 * `0o600` / `0o700` are a POSIX promise. On Windows Node ignores them entirely,
 * and the files they were meant to protect are not cosmetic: `env.cmd` holds
 * API keys, the SuperGrok file holds an OAuth refresh token, the lock and socket
 * directories hold session metadata.
 *
 * So the intent is applied explicitly (`icacls` with inheritance removed and one
 * grant to the current user). The argv is pure and asserted here on any
 * platform; the *effect* is asserted for real on the Windows CI leg, which is
 * the only place that can answer "is the ACL actually restricted".
 */

test('the icacls argv removes inheritance and grants one user', () => {
  // Without `/inheritance:r` the parent's `Users` grant survives and the file
  // stays world-readable on a machine where DSH_HOME is not under the profile.
  assert.deepEqual(
    restrictPathArgs('C:\\Users\\me\\.dsh\\env.cmd', 'me'),
    ['C:\\Users\\me\\.dsh\\env.cmd', '/inheritance:r', '/grant:r', 'me:F'],
  )
  // A directory needs `(OI)(CI)`, or every file created inside it starts over.
  assert.deepEqual(
    restrictPathArgs('C:\\Users\\me\\.dsh\\tui-locks', 'me', { directory: true }),
    ['C:\\Users\\me\\.dsh\\tui-locks', '/inheritance:r', '/grant:r', 'me:(OI)(CI)F'],
  )
})

test('the user to grant comes from the environment, and only on win32', () => {
  assert.equal(aclUserName({ USERNAME: 'alice' }, 'win32'), 'alice')
  assert.equal(aclUserName({ USER: 'fallback' }, 'win32'), 'fallback')
  assert.equal(aclUserName({}, 'win32'), undefined, 'no user means no ACL call at all')
  assert.equal(aclUserName({ USER: 'alice' }, 'linux'), undefined)
})

// Windows cannot express 0o600 at all — `chmod` there only toggles the
// read-only bit and `stat` reports 0o666/0o444 — so the POSIX half of this
// primitive is asserted on the legs that have POSIX filesystems, and the Windows
// leg asserts the ACL instead (below).
test('a POSIX restriction is a chmod, and it really tightens the file', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-acl-'))
  const file = join(dir, 'env.sh')
  writeFileSync(file, 'export API_KEY=secret\n', { mode: 0o644 })
  chmodSync(file, 0o644)
  assert.equal(statSync(file).mode & 0o777, 0o644, 'starts group/world readable')

  const applied = await restrictPathToUser(file, { mode: 0o600, platform: 'linux' })
  assert.equal(applied, true)
  assert.equal(statSync(file).mode & 0o777, 0o600)

  const dirPath = join(dir, 'locks')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dirPath, { mode: 0o755 })
  chmodSync(dirPath, 0o755)
  assert.equal(restrictPathToUserSync(dirPath, { mode: 0o700, platform: 'linux', directory: true }), true)
  assert.equal(statSync(dirPath).mode & 0o777, 0o700)
})

test('a failure to restrict never throws at the caller', async () => {
  // The caller has already written the file; a permission call that cannot run
  // (no icacls, a path another process holds) must not lose the write.
  const missing = join(tmpdir(), 'dsh-acl-does-not-exist', 'env.cmd')
  assert.equal(await restrictPathToUser(missing, { mode: 0o600, platform: 'linux' }), false)

  const calls = []
  const ok = await restrictPathToUser('C:\\dsh\\env.cmd', {
    mode: 0o600,
    platform: 'win32',
    env: { USERNAME: 'me' },
    run: (command, args) => { calls.push([command, args]); return true },
  })
  assert.equal(ok, true)
  assert.deepEqual(calls, [['icacls', ['C:\\dsh\\env.cmd', '/inheritance:r', '/grant:r', 'me:F']]])

  const failed = await restrictPathToUser('C:\\dsh\\env.cmd', {
    mode: 0o600,
    platform: 'win32',
    env: { USERNAME: 'me' },
    run: () => false,
  })
  assert.equal(failed, false)
})

test('on Windows the real ACL ends up restricted to the current user', { skip: process.platform !== 'win32' }, async () => {
  // The acceptance criterion from docs/platform.md, on the machine that can
  // actually answer it: no `Users`/`Everyone`/`Authenticated Users` grant
  // survives, and the current user is there.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-acl-real-'))
  const file = join(dir, 'env.cmd')
  writeFileSync(file, 'set "API_KEY=secret"\r\n')
  assert.equal(await restrictPathToUser(file, { mode: 0o600 }), true, 'the ACL call must succeed')
  assert.equal(restrictPathToUserSync(dir, { mode: 0o700, directory: true }), true)

  const acl = spawnSync('icacls', [file], { encoding: 'utf8', windowsHide: true })
  assert.equal(acl.status, 0)
  const text = String(acl.stdout ?? '')
  const user = aclUserName() ?? ''
  assert.ok(text.includes(user), `the current user must hold the file:\n${text}`)
  for (const group of ['Everyone', 'BUILTIN\\Users', 'Authenticated Users', 'Users:']) {
    assert.equal(text.includes(group), false, `${group} must not appear in:\n${text}`)
  }
})
