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
  assert.equal(/\bname:\s*['"]?@deepseek-ai\//i.test(patch), false)
  assert.equal(/@deepseek-ai\//.test(patch) && /disabled:\s*true/i.test(patch), false)

  const ids = [...new Set([...patch.matchAll(/(?:^|\n)\s*- id:\s*['"]?([A-Za-z0-9][A-Za-z0-9._-]{0,95})['"]?\s*(?:\n|$)/g)]
    .map(match => match[1]))]
  assert.deepEqual(ids.sort(), ['ssh-tui', 'ssh-tui-startup'])
  assert.equal(ids.some(id => PROTECTED_ENTRY_IDS.has(id)), false)
})

test('manifest declares exact dshReleases for the store window', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const releases = manifest.dsh?.compatibility?.dshReleases
  assert.equal(typeof releases, 'object')
  for (const version of ['0.1.2-rc.1', '0.1.3-alpha.1', '0.1.3-alpha.2', '0.1.5-alpha.1']) {
    const status = releases[version]
    assert.ok(status === 'compatible' || status === 'incompatible' || status === 'unknown', version)
  }
  assert.equal(releases['0.1.2-rc.1'], 'compatible')
  assert.equal(releases['0.1.3-alpha.1'], 'unknown')
  assert.equal(releases['0.1.3-alpha.2'], 'incompatible')
  assert.equal(releases['0.1.5-alpha.1'], 'incompatible')
  assert.equal(manifest.engines?.node, '>=22.19')
})
