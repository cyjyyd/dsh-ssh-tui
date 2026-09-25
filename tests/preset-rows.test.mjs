import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FORMS_PATCH_BLOCK,
  ROSTER_PATCH_BLOCK,
  ensureRosterRows,
  rosterPatchPath,
  rosterPatchText,
  rosterRows,
} from '../lib/preset-rows.js'
import { FORMS_BLOCK, ROSTER_BLOCK } from '../scripts/profile-rows.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the roster block mounts the roster and the two preset host services', () => {
  assert.match(ROSTER_PATCH_BLOCK, /- insert:/)
  assert.match(ROSTER_PATCH_BLOCK, /- id: agent-presets\n\s+name: '@deepseek-ai\/dsh-agent-presets'\n\s+config:\n\s+default: standard/)
  assert.match(ROSTER_PATCH_BLOCK, /- id: code-runtime\n\s+name: '@deepseek-ai\/dsh-code-runtime-worker-thread'/)
  assert.match(ROSTER_PATCH_BLOCK, /- id: subagent-model-selection-settings\n\s+name: '@deepseek-ai\/dsh-tool-subagent\/model-selection-settings'/)
  assert.equal(ROSTER_PATCH_BLOCK.endsWith('\n'), true)
})

test('the 0.1.7 block mounts the two agent-plane tools, and no persona row', () => {
  // 0.1.7 has no roster to mount: presets became per-session rows a surface
  // composes, and dsh-base keeps the agent plane for the TUI. `dsh-system-prompt`
  // owns the persona sections at this layer, so `@deepseek-ai/dsh-persona` is
  // deliberately not mounted: the loader rejects the duplicate registration and
  // the entry then never activates.
  assert.match(FORMS_PATCH_BLOCK, /- id: tool-ask-user\n\s+name: '@deepseek-ai\/dsh-tool-ask-user'/)
  assert.match(FORMS_PATCH_BLOCK, /- id: present\n\s+name: '@deepseek-ai\/dsh-tool-present'/)
  assert.equal(/- id: persona\n/u.test(FORMS_PATCH_BLOCK), false, 'no persona row is mounted')
  assert.equal(FORMS_PATCH_BLOCK.includes("name: '@deepseek-ai/dsh-persona'"), false, 'and no such module is named as a row')
  assert.equal(/^- id: system-prompt/mu.test(FORMS_PATCH_BLOCK), false, 'nor an override entry for that row')
  assert.equal(FORMS_PATCH_BLOCK.includes('dsh-agent-presets'), false)
  assert.deepEqual(rosterRows('legacy').map(row => row.id), ['agent-presets', 'code-runtime', 'subagent-model-selection-settings'])
  assert.deepEqual(rosterRows('forms').map(row => row.id), ['tool-ask-user', 'present'])
})

test('the install path and the runtime write the same block, on both lines', async () => {
  // The published package does not ship scripts/, so the runtime owns a copy.
  // A drift here would make the in-app repair write a different roster than the
  // installer does; fail instead. Windows checkouts carry CRLF, and the block
  // itself is a template literal, so normalise before comparing.
  //
  // The block lives in `scripts/profile-rows.mjs` (the shell wrapper and the CI
  // probe bootstrap both call it), not in the `.sh` — that one is a thin
  // wrapper now, so reading it as text would compare nothing. It is imported
  // rather than scraped because the module interpolates the module name.
  assert.equal(ROSTER_BLOCK, ROSTER_PATCH_BLOCK)
  assert.equal(FORMS_BLOCK, FORMS_PATCH_BLOCK)
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
})

test('the 0.1.7 line repairs the agent-plane rows and never the dead ones', () => {
  const fromTemplate = rosterPatchText('[]', 'forms')
  assert.ok(fromTemplate !== undefined)
  assert.ok(fromTemplate.includes("name: '@deepseek-ai/dsh-tool-ask-user'"))
  assert.ok(fromTemplate.includes("name: '@deepseek-ai/dsh-tool-present'"))
  // The persona is not written on this line: the row the base mounts owns those
  // prompt sections already, and a second registration is rejected.
  assert.equal(fromTemplate.includes("name: '@deepseek-ai/dsh-persona'"), false)
  assert.equal(/^- id: system-prompt/mu.test(fromTemplate), false)
  // Neither row resolves on 0.1.7: the plural package has no release there, and
  // `code-runtime-worker-thread` was replaced by the base's `ptc-runtime`.
  assert.equal(fromTemplate.includes('dsh-agent-presets'), false)
  assert.equal(fromTemplate.includes('code-runtime-worker-thread'), false)
  assert.equal(rosterPatchText(fromTemplate, 'forms'), undefined, 'idempotent')
})

test('a partially mounted roster gains only the rows it lacks', () => {
  // 0.7: a profile that already mounts the roster row but not the two services
  // is a broken composition, so the repair tops it up instead of doing nothing.
  const partial = '- insert:\n    - id: agent-presets\n      name: \'@deepseek-ai/dsh-agent-presets\'\n'
  const repaired = rosterPatchText(partial)
  assert.ok(repaired !== undefined)
  assert.equal(repaired.match(/id: agent-presets/gu)?.length, 1, 'the existing row is not mounted twice')
  assert.ok(repaired.includes("name: '@deepseek-ai/dsh-code-runtime-worker-thread'"))
  assert.ok(repaired.includes("name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'"))
  assert.equal(rosterPatchText(repaired), undefined, 'the repair is idempotent')
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
