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

/**
 * A stubbed `run` cannot dump a profile, so `mountProfileRows` falls back to the
 * launcher's own version to pick the block. These tests are about the block
 * itself, so they name the generation instead of inheriting whichever host line
 * the tree happens to be installed against.
 */
test('the roster rows replace an empty patch array', () => {
  const { home, file } = tempProfile('# header\n[]\n')
  const result = mountProfileRows({ profile: 'tui', home, log: silent, ...notComposed, generation: 'legacy' })
  assert.equal(result, 'mounted')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /agent-presets/u)
  assert.match(text, /dsh-code-runtime-worker-thread/u)
  assert.match(text, /model-selection-settings/u)
  assert.doesNotMatch(text, /^\s*\[\s*\]\s*$/mu, 'the empty array is gone, not kept alongside')
})

test('the agent-plane rows replace an empty patch array on the forms line', () => {
  const { home, file } = tempProfile('# header\n[]\n')
  const result = mountProfileRows({ profile: 'tui', home, log: silent, ...notComposed, generation: 'forms' })
  assert.equal(result, 'mounted')
  const text = readFileSync(file, 'utf8')
  for (const [id, name] of [
    ['tool-ask-user', '@deepseek-ai/dsh-tool-ask-user'],
    ['present', '@deepseek-ai/dsh-tool-present'],
  ]) {
    assert.match(text, new RegExp(`id: ${id}\\b`, 'u'), text)
    assert.match(text, new RegExp(`name: '${name}'`, 'u'), text)
  }
  // The persona is deliberately absent: `dsh-system-prompt` owns those sections
  // at this layer, so mounting the plugin would never activate.
  assert.doesNotMatch(text, /^\s*- id: persona$/mu)
  // Nothing 0.1.7 cannot resolve is written on that line: the plural presets
  // package and the worker-thread runtime have no release past 0.1.6-alpha.2.
  assert.doesNotMatch(text, /dsh-agent-presets/u)
  assert.doesNotMatch(text, /dsh-code-runtime-worker-thread/u)
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
  const result = mountProfileRows({ profile: 'tui', home, log: silent, ...notComposed, generation: 'legacy' })
  assert.equal(result, 'already-named')
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('the forms marker is the agent-plane tool row, not the dead plural one', () => {
  const { home, file } = tempProfile(`# header\n- insert:\n    - id: present\n      name: '@deepseek-ai/dsh-tool-present'\n`)
  const before = readFileSync(file, 'utf8')
  const result = mountProfileRows({ profile: 'tui', home, log: silent, ...notComposed, generation: 'forms' })
  assert.equal(result, 'already-named')
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('a missing patch file is created from the documented header', () => {
  const { home, file } = tempProfile(undefined)
  const result = mountProfileRows({ profile: 'tui', home, log: silent, ...notComposed, generation: 'legacy' })
  assert.equal(result, 'mounted')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /Your patch layer for this dsh profile/u)
  assert.match(text, /agent-presets/u)
})

test('a missing patch file gets the forms block on the forms line', () => {
  const { home, file } = tempProfile(undefined)
  const result = mountProfileRows({ profile: 'tui', home, log: silent, ...notComposed, generation: 'forms' })
  assert.equal(result, 'mounted')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /Your patch layer for this dsh profile/u)
  assert.match(text, /@deepseek-ai\/dsh-persona/u)
  assert.doesNotMatch(text, /dsh-agent-presets/u)
})

test('DSH_HOME wins over the platform default only when it is set', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/tmp/x' }), '/tmp/x')
  assert.equal(resolveDshHome({ DSH_HOME: '  ' }), resolveDshHome({}))
  assert.match(resolveDshHome({}), /\.dsh$/u)
})
