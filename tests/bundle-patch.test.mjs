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
