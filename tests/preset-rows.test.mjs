import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ROSTER_PATCH_BLOCK, ensureRosterRows, rosterPatchPath, rosterPatchText } from '../lib/preset-rows.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the roster block mounts the roster and the two preset host services', () => {
  assert.match(ROSTER_PATCH_BLOCK, /- insert:/)
  assert.match(ROSTER_PATCH_BLOCK, /- id: agent-presets\n\s+name: '@deepseek-ai\/dsh-agent-presets'\n\s+config:\n\s+default: standard/)
  assert.match(ROSTER_PATCH_BLOCK, /- id: code-runtime\n\s+name: '@deepseek-ai\/dsh-code-runtime-worker-thread'/)
  assert.match(ROSTER_PATCH_BLOCK, /- id: subagent-model-selection-settings\n\s+name: '@deepseek-ai\/dsh-tool-subagent\/model-selection-settings'/)
  assert.equal(ROSTER_PATCH_BLOCK.endsWith('\n'), true)
})

test('the install script and the runtime write the same block', async () => {
  // The published package does not ship scripts/, so the runtime owns a copy.
  // A drift here would make the in-app repair write a different roster than the
  // installer does; fail instead.
  const script = await readFile(join(root, 'scripts', 'ensure-profile-rows.sh'), 'utf8')
  const match = /const block = `([\s\S]*?)`\n/u.exec(script)
  assert.ok(match, 'the script must define its block as a template literal')
  assert.equal(match[1], ROSTER_PATCH_BLOCK)
})

test('rosterPatchText replaces the empty template and appends to a used patch', () => {
  const template = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n'
  const fromTemplate = rosterPatchText(template)
  assert.ok(fromTemplate !== undefined)
  assert.ok(fromTemplate.includes("name: '@deepseek-ai/dsh-agent-presets'"))
  assert.equal(fromTemplate.includes('[]'), false)

  const used = '- insert:\n    - id: webserver\n      name: \'@deepseek-ai/dsh-host-webserver\'\n'
  const appended = rosterPatchText(used)
  assert.ok(appended !== undefined)
  assert.ok(appended.startsWith(used), 'existing entries stay untouched')
  assert.ok(appended.includes('\n\n# dsh-ssh-tui /mode:'))
  assert.ok(appended.includes("name: '@deepseek-ai/dsh-agent-presets'"))

  const noTrailingNewline = rosterPatchText('- insert: []')
  assert.ok(noTrailingNewline !== undefined)
  assert.ok(noTrailingNewline.includes('\n\n# dsh-ssh-tui /mode:'))
})

test('rosterPatchText is idempotent', () => {
  const once = rosterPatchText('[]')
  assert.ok(once !== undefined)
  assert.equal(rosterPatchText(once), undefined)
  assert.equal(rosterPatchText(ROSTER_PATCH_BLOCK), undefined)
  assert.equal(
    rosterPatchText('- insert:\n    - id: agent-presets\n      name: \'@deepseek-ai/dsh-agent-presets\'\n'),
    undefined,
  )
})

test('ensureRosterRows creates, then leaves the profile patch alone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-preset-rows-'))
  try {
    const path = rosterPatchPath(home, 'tui')
    assert.equal(await ensureRosterRows(home, 'tui'), 'written')
    const written = await readFile(path, 'utf8')
    assert.ok(written.includes("name: '@deepseek-ai/dsh-agent-presets'"))
    assert.equal(await ensureRosterRows(home, 'tui'), 'present')
    assert.equal(await readFile(path, 'utf8'), written)

    // An existing profile patch keeps its own rows and gains the roster.
    const other = join(home, 'profiles', 'work')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, 'cordis.patch.yml'), '- insert:\n    - id: webserver\n      name: \'@deepseek-ai/dsh-host-webserver\'\n')
    assert.equal(await ensureRosterRows(home, 'work'), 'written')
    const work = await readFile(join(other, 'cordis.patch.yml'), 'utf8')
    assert.ok(work.includes('id: webserver'))
    assert.ok(work.includes('id: agent-presets'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
