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
import { desktopLauncher, hostSpawnOptions, nonTtyErrorMessage } from '../lib/platform.js'
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

test('the Host is started in a way that never flashes console windows', () => {
  // Both halves are Windows bugs that only ever showed up on a real desktop:
  //
  // * `detached: true` is DETACHED_PROCESS there, which leaves the Host with no
  //   console at all — and Windows ignores CREATE_NO_WINDOW (what `windowsHide`
  //   sets) when DETACHED_PROCESS is present. Every console child the Host then
  //   starts has to allocate its own console, so each tool call flashed a
  //   terminal window over the TUI.
  // * `windowsHide` must stay on, or the Host's own window appears.
  const windows = hostSpawnOptions('win32')
  assert.equal(windows.detached, false, 'a detached Host has no console to lend its children')
  assert.equal(windows.windowsHide, true, 'and its own console must stay invisible')

  // POSIX keeps setsid: that is what survives a hung-up terminal there, and
  // there is no console window to flash.
  const posix = hostSpawnOptions('linux')
  assert.equal(posix.detached, true)
  assert.equal(posix.windowsHide, true)
  assert.deepEqual(hostSpawnOptions('darwin'), posix, 'macOS behaves like Linux')
})

test('every spawn in src/ hides a console window on Windows', () => {
  // A child started from a console-less process allocates a visible console, so
  // each spawn site is a window waiting to flash. The scan runs on Linux too:
  // a new spawn without the flag fails here instead of on a user's desktop.
  const missing = []
  for (const name of readdirSync(SRC).filter(file => file.endsWith('.ts'))) {
    const source = stripComments(readFileSync(join(SRC, name), 'utf8'))
    const spawns = [
      ...source.matchAll(/\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(/gu),
    ]
    if (spawns.length === 0) continue
    // display-sock.ts computes the flags in `hostSpawnOptions` (asserted above)
    // rather than spelling them out, so its helper counts as the flag — but any
    // *other* file still has to name `windowsHide` itself.
    const declared = source.includes('windowsHide') || source.includes('hostSpawnOptions')
    if (!declared) missing.push(name)
  }
  assert.deepEqual(missing, [], 'spawn sites without windowsHide')
})

test('platform decisions live in the seam, not in feature code', () => {
  // A comparison buried in a feature is a Windows path nobody runs until a user
  // does: the three Windows bugs this repo shipped were each one such line.
  // Passing `process.platform` as a *default* is fine — that is the injectable
  // shape — so only the comparison is banned, and only outside the seam.
  const SEAM = 'platform.ts'
  const banned = /process\.platform\s*[!=]==?/
  const offenders = []
  for (const name of readdirSync(SRC).filter(file => file.endsWith('.ts'))) {
    if (name === SEAM) continue
    const source = stripComments(readFileSync(join(SRC, name), 'utf8'))
    source.split('\n').forEach((line, index) => {
      if (banned.test(line)) offenders.push(`${name}:${index + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(
    offenders,
    [],
    'move the decision into src/platform.ts and import it (or take `platform` as a parameter)',
  )
})

test('the desktop launcher is recognised, and an ordinary node is not', () => {
  // The desktop Harness runs `DeepSeek Harness.exe` as Node (ELECTRON_RUN_AS_NODE
  // plus an `app.asar` CLI path). That process never has a console, so a terminal
  // profile cannot start under it — and the message has to say so instead of
  // sending the reader after a broken terminal.
  const electron = { electron: '33.0.0', execPath: 'D:/Deepseek-harness/DeepSeek Harness.exe', argv: ['node', 'cli.js'] }
  const asar = { execPath: 'C:/node.exe', argv: ['node', 'D:/Deepseek-harness/resources/app.asar/dsh/lib/bin.js'] }
  const plain = { execPath: '/usr/bin/node', argv: ['node', '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'] }
  const windows = { execPath: 'C:/Program Files/nodejs/node.exe', argv: ['node', 'C:/Users/x/.dsh/profiles/tui/x.js'] }
  assert.equal(desktopLauncher(electron), true)
  assert.equal(desktopLauncher(asar), true)
  assert.equal(desktopLauncher(plain), false, 'the npm CLI must keep the generic message')
  assert.equal(desktopLauncher(windows), false)
  assert.equal(desktopLauncher({}), false)
})

test('the no-TTY message names the fix for each launcher', () => {
  const generic = nonTtyErrorMessage(false)
  assert.match(generic, /TTY/u)
  assert.equal(/desktop/u.test(generic), false, 'a terminal user is not told about the desktop app')
  const desktop = nonTtyErrorMessage(true)
  assert.match(desktop, /desktop Harness/u)
  assert.match(desktop, /npm i -g @deepseek-ai\/dsh/u, 'the workaround is in the message')
  assert.match(desktop, /does not need this plugin/u, 'and it says the desktop app does not need us')
  assert.match(desktop, /docs\/desktop\.md/u, 'pointing at the write-up')
})
