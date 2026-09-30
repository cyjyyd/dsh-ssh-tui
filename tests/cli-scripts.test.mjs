/**
 * The install / verify / uninstall scripts are Node now, with the `.sh` files
 * kept as wrappers. What is pinned here needs no dsh installation: argument
 * defaults, the way the CLI is found, and that every documented bash entry
 * really does hand off to its Node twin.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dshHome, profileFromArgs, resolveDsh } from '../scripts/cli.mjs'
import { mountProfileRows } from '../scripts/profile-rows.mjs'

const REPO = join(import.meta.dirname, '..')

test('a script takes its profile from the argument, then the environment', () => {
  const previous = process.env.DSH_TUI_PROFILE
  try {
    delete process.env.DSH_TUI_PROFILE
    assert.equal(profileFromArgs([]), 'tui')
    assert.equal(profileFromArgs(['work']), 'work')
    assert.equal(profileFromArgs(['--help', 'work']), 'work')
    process.env.DSH_TUI_PROFILE = 'lab'
    assert.equal(profileFromArgs([]), 'lab')
    // A positional argument still beats the environment, as the bash scripts did.
    assert.equal(profileFromArgs(['work']), 'work')
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_PROFILE
    else process.env.DSH_TUI_PROFILE = previous
  }
})

test('the dsh home follows DSH_HOME and otherwise lives under the user home', () => {
  assert.equal(dshHome({ DSH_HOME: '/var/dsh' }), '/var/dsh')
  assert.equal(dshHome({ DSH_HOME: '   ' }).endsWith('.dsh'), true)
  assert.equal(dshHome({}).endsWith('.dsh'), true)
})

test('the dsh CLI resolves to an entry script, not a bare name, in this checkout', () => {
  // This repo depends on @deepseek-ai/dsh, so the resolver must find its entry
  // and skip the shell — the bare `dsh` is a `.cmd` shim on Windows.
  const found = resolveDsh()
  assert.equal(found.shell, false)
  assert.equal(found.prefix.length, 1)
  assert.equal(found.prefix[0].endsWith(join('@deepseek-ai', 'dsh', 'lib', 'bin.js')), true)
})

test('the row mounter takes the dsh home from the environment when not told', async t => {
  // `install.mjs` never passed `home`, so the last step of the documented install
  // died on `join(undefined, …)` — *after* the profile had already been linked,
  // which leaves a half-installed profile. The default has to be the home the
  // caller's environment names; a throwaway one here, so the test writes nothing
  // outside its own temp tree.
  const home = await mkdtemp(join(tmpdir(), 'dsh-rows-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const profileFile = join(home, 'profiles', 'tui', 'cordis.patch.yml')
  await mkdir(join(home, 'profiles', 'tui'), { recursive: true })
  await writeFile(profileFile, '[]\n')

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const result = mountProfileRows({
      profile: 'tui',
      // A profile that composes nothing yet is what makes it mount; no dsh runs.
      cli: join(home, 'nonexistent', 'dsh', 'lib', 'bin.js'),
      log: () => {},
      run: () => ({ stdout: '[]', stderr: '', status: 0 }),
    })
    assert.equal(result, 'mounted')
    const text = await readFile(profileFile, 'utf8')
    assert.match(text, /dsh-ssh-tui/, 'the rows land in the home DSH_HOME names')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('every bash install script delegates to its Node twin', () => {
  // The `.sh` files stay so the documented `bash scripts/…` keeps working, but
  // they must not grow their own logic again: Windows runs the `.mjs`.
  const pairs = [
    ['install.sh', 'install.mjs'],
    ['install-npm.sh', 'install-npm.mjs'],
    ['uninstall.sh', 'uninstall.mjs'],
    ['verify.sh', 'verify.mjs'],
    ['smoke-headless.sh', 'smoke-headless.mjs'],
    ['install-routing-suite.sh', 'install-routing-suite.mjs'],
    ['ensure-profile-rows.sh', 'profile-rows.mjs'],
  ]
  for (const [shell, node] of pairs) {
    const text = readFileSync(join(REPO, 'scripts', shell), 'utf8')
    assert.equal(text.includes(`scripts/${node}`), true, `${shell} must exec ${node}`)
    assert.equal(text.includes('"$@"') || text.includes('"$PROFILE"'), true, `${shell} must forward its arguments`)
  }
})
