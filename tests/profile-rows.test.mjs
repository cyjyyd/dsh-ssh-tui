import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mountProfileRows, profilePatchPath, resolveDshHome } from '../scripts/profile-rows.mjs'

/**
 * The roster mount is what makes `/mode` work in a profile this repo built for
 * itself — the CI probe and a fresh machine both depend on it — and it is now
 * shared by a shell wrapper and the Node bootstrap, so its contract is pinned
 * here instead of only by the interactive TUI.
 */
function tempProfile(patch) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-rows-'))
  const file = profilePatchPath('tui', home)
  mkdirSync(join(home, 'profiles', 'tui'), { recursive: true })
  if (patch !== undefined) writeFileSync(file, patch)
  return { home, file }
}

const silent = () => {}
const notComposed = { run: () => ({ stdout: '' }) }
const alreadyComposed = { run: () => ({ stdout: "name: '@deepseek-ai/dsh-agent-presets'" }) }

test('the roster rows replace an empty patch array', () => {
  const { home, file } = tempProfile('# header\n[]\n')
  const result = mountProfileRows({ profile: 'tui', home, log: silent, ...notComposed })
  assert.equal(result, 'mounted')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /agent-presets/u)
  assert.match(text, /dsh-code-runtime-worker-thread/u)
  assert.match(text, /model-selection-settings/u)
  assert.doesNotMatch(text, /^\s*\[\s*\]\s*$/mu, 'the empty array is gone, not kept alongside')
})

test('a profile that already composes the roster is left alone', () => {
  const { home, file } = tempProfile('# header\n[]\n')
  const before = readFileSync(file, 'utf8')
  const result = mountProfileRows({ profile: 'tui', home, log: silent, ...alreadyComposed })
  assert.equal(result, 'already-mounted')
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('a patch that already names the row is not written twice', () => {
  const { home, file } = tempProfile(`# header\n- insert:\n    - id: agent-presets\n      name: '@deepseek-ai/dsh-agent-presets'\n`)
  const before = readFileSync(file, 'utf8')
  const result = mountProfileRows({ profile: 'tui', home, log: silent, ...notComposed })
  assert.equal(result, 'already-named')
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('a missing patch file is created from the documented header', () => {
  const { home, file } = tempProfile(undefined)
  const result = mountProfileRows({ profile: 'tui', home, log: silent, ...notComposed })
  assert.equal(result, 'mounted')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /Your patch layer for this dsh profile/u)
  assert.match(text, /agent-presets/u)
})

test('DSH_HOME wins over the platform default only when it is set', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/tmp/x' }), '/tmp/x')
  assert.equal(resolveDshHome({ DSH_HOME: '  ' }), resolveDshHome({}))
  assert.match(resolveDshHome({}), /\.dsh$/u)
})
