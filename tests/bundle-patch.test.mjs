import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROTECTED_ENTRY_IDS = new Set(['ui-settings-plugin-inventory', 'dsh-safe-plugin-manager'])

test('bundle patch is additive and does not impersonate @deepseek-ai', async () => {
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.files.includes('cordis.patch.yml'), true)
  assert.equal(typeof manifest.exports['./cordis.patch.yml'], 'string')
  // Issue 667: DSH STORE prunes candidates whose Bundle Patch impersonates
  // @deepseek-ai, disables official rows, or omits exact dshReleases.
  // Comments may mention the forbidden namespace; only `name:` rows count.
  assert.equal(/\bname:\s*['"]?@deepseek-ai\//i.test(patch), false)
  assert.equal(/\bdisabled:\s*true\b/i.test(patch), false)
  assert.equal(/^\s*- id:\s*(?!ssh-tui)/m.test(patch.replace(/- insert:[\s\S]*/u, '')), false)

  const ids = [...new Set([...patch.matchAll(/(?:^|\n)\s*- id:\s*['"]?([A-Za-z0-9][A-Za-z0-9._-]{0,95})['"]?\s*(?:\n|$)/g)]
    .map(match => match[1]))]
  assert.deepEqual(ids.sort(), ['ssh-tui', 'ssh-tui-startup'])
  assert.equal(ids.some(id => PROTECTED_ENTRY_IDS.has(id)), false)
  assert.equal(ids.some(id => id.startsWith('llm-') || id.startsWith('tool-') || id === 'hmr' || id === 'system-prompt' || id === 'agent-presets'), false)
})

test('manifest declares exact dshReleases for the store window', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const releases = manifest.dsh?.compatibility?.dshReleases
  assert.equal(typeof releases, 'object')
  for (const version of [
    '0.1.2-rc.1',
    '0.1.3-alpha.1',
    '0.1.3-alpha.2',
    '0.1.5-alpha.1',
    '0.1.5-alpha.2',
    '0.1.5-rc.1',
  ]) {
    const status = releases[version]
    assert.ok(status === 'compatible' || status === 'incompatible' || status === 'unknown', version)
  }
  assert.equal(releases['0.1.2-rc.1'], 'compatible')
  assert.equal(releases['0.1.3-alpha.1'], 'unknown')
  assert.equal(releases['0.1.3-alpha.2'], 'compatible')
  assert.equal(releases['0.1.5-alpha.1'], 'compatible')
  assert.equal(releases['0.1.5-alpha.2'], 'compatible')
  assert.equal(releases['0.1.5-rc.1'], 'compatible')
  assert.equal(manifest.engines?.node, '>=22.19')
})

test('declared dsh range admits every release marked compatible', async () => {
  const semver = (await import('semver')).default
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const range = manifest.dsh?.compatibility?.dsh
  assert.equal(typeof range, 'string')
  // Node-semver only admits a prerelease when a comparator carries the same
  // [major, minor, patch] tuple, so a bare `>=0.1.2-rc.1` would silently
  // reject 0.1.5-rc.1. Pin the exact semantics pnpm and the store see.
  const inRange = version => semver.satisfies(version, range)
  assert.equal(inRange('0.1.2-rc.1'), true)
  assert.equal(inRange('0.1.3-alpha.2'), true)
  assert.equal(inRange('0.1.5-alpha.1'), true)
  assert.equal(inRange('0.1.5-alpha.2'), true)
  assert.equal(inRange('0.1.5-rc.1'), true)
  assert.equal(inRange('0.1.5-rc.2'), true)
  assert.equal(inRange('0.1.5'), true)
  assert.equal(inRange('0.1.1-rc.2'), false)
  assert.equal(inRange('0.1.3-alpha.1'), false)
  assert.equal(inRange('0.1.6-alpha.1'), false)
  assert.equal(inRange('0.1.6'), false)
  assert.equal(semver.maxSatisfying(['0.1.2-rc.1', '0.1.5-rc.1'], range), '0.1.5-rc.1')
  // Every release the manifest calls compatible must actually satisfy the range.
  for (const [version, status] of Object.entries(manifest.dsh.compatibility.dshReleases)) {
    if (status !== 'compatible') continue
    assert.equal(inRange(version), true, `${version} is marked compatible but outside ${range}`)
  }
  // Every dsh peer shares that range, so a 0.1.5-rc.1 host satisfies the
  // declaration while a 0.1.2-rc.1 install keeps resolving.
  for (const [name, peerRange] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    assert.equal(peerRange, range, `${name} must accept both verified hosts`)
  }
})
