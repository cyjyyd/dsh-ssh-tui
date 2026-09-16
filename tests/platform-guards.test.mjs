/**
 * Platform guards: the two Windows bugs we shipped (a bare `spawn('dsh')` that
 * cannot resolve a `.cmd` shim, and an unset `TERM` read as "no terminal") were
 * both in code no test ever executed *on Windows*.
 *
 * The Windows CI leg runs this whole suite, so anything asserted here is
 * asserted on a real Windows runner; the static scan below is the part that also
 * reddens on Linux, because it is about the shape of the call, not the platform.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { colorDepth } from '../lib/color-depth.js'
import { resolveDshInvocation } from '../lib/update-check.js'

const SRC = join(import.meta.dirname, '..', 'src')

/**
 * Spawning a bare command name is a Windows hazard: the global install of a CLI
 * is a `.cmd` shim there, and CreateProcess does not apply `PATHEXT`. Every
 * occurrence has to be listed with the reason it is safe, so a new one fails
 * this test until someone writes that reason down (and the list is checked both
 * ways, so it cannot rot).
 */
const BARE_SPAWN_ALLOWED = new Map([
  ['tui.ts:setx', 'Windows-only system .exe; no shim, no shell needed'],
])

// Block comments and whole-line comments are removed; a *trailing* comment that
// happens to mention a bare spawn would be reported, which is the safe direction
// (rename it in the comment) and cheap enough to live with.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
}

function bareSpawns() {
  const found = new Map()
  for (const name of readdirSync(SRC).filter(file => file.endsWith('.ts'))) {
    const source = stripComments(readFileSync(join(SRC, name), 'utf8'))
    for (const match of source.matchAll(/\b(?:spawn|execFile|exec)\s*\(\s*'([^'\\/]+)'/gu)) {
      const command = match[1] ?? ''
      if (command !== '') found.set(`${name}:${command}`, true)
    }
  }
  return [...found.keys()].sort()
}

test('every spawn of a bare command name is a documented Windows decision', () => {
  const found = bareSpawns()
  const allowed = [...BARE_SPAWN_ALLOWED.keys()].sort()
  assert.deepEqual(
    found,
    allowed,
    'a new bare `spawn("name")` is a Windows `ENOENT` waiting to happen: run it through '
    + 'process.execPath + the entry script, or add it to BARE_SPAWN_ALLOWED with the reason',
  )
})

test('the palette decision is asserted on whatever platform this runs on', () => {
  // On the Windows CI leg this is a real environment check: an unset TERM there
  // must still produce colour. On POSIX the same call has the opposite answer,
  // which is why the platform is a parameter rather than an implicit global.
  const depth = colorDepth(process.env, process.platform)
  if (process.platform === 'win32' && (process.env.NO_COLOR ?? '') === '') {
    assert.notEqual(depth, 'none', `a Windows console keeps colour (TERM=${JSON.stringify(process.env.TERM ?? '')})`)
  } else if (process.platform !== 'win32') {
    assert.equal(typeof depth, 'string')
  }
})

test('the dsh invocation is spawnable on this platform', () => {
  const invocation = resolveDshInvocation()
  assert.notEqual(invocation.command, '')
  if (process.platform === 'win32') {
    // Either our own entry is visible (node + script, no shell) or the fallback
    // has to ask a shell to resolve the `dsh.cmd` shim.
    const ownEntry = invocation.prefix.length > 0
    assert.equal(invocation.shell, !ownEntry, `win32 needs a shell exactly when it has no entry: ${JSON.stringify(invocation)}`)
  }
})
