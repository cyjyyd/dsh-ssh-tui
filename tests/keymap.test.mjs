import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_KEYMAP, KEY_ACTIONS, keySequence, keymapReport, resolveKeymap } from '../lib/keymap.js'

/**
 * C-4: keys are rebindable, but only onto actions, and never onto each other.
 *
 * A TUI dispatches on raw byte sequences, so a config that says `pageUp: pgdn`
 * or a name nobody knows has to be refused out loud — silently accepting it is
 * how a user ends up pressing a key that does nothing.
 */
const actionOf = (resolved, key) => resolved.sequences.get(keySequence(key) ?? '')

test('the defaults are the keys the TUI already answers to', () => {
  assert.deepEqual([...KEY_ACTIONS].sort(), ['cancel', 'copy', 'pageDown', 'pageUp', 'toggleCard'])
  const resolved = resolveKeymap()
  assert.deepEqual(resolved.conflicts, [])
  assert.deepEqual(resolved.unknownActions, [])
  assert.deepEqual(resolved.unknownKeys, [])
  for (const action of KEY_ACTIONS) {
    assert.equal(actionOf(resolved, DEFAULT_KEYMAP[action]), action, `${action} keeps ${DEFAULT_KEYMAP[action]}`)
  }
})

test('key names cover the shapes a terminal sends', () => {
  assert.equal(keySequence('pgup'), '\x1b[5~')
  assert.equal(keySequence('PageDown'), '\x1b[6~')
  assert.equal(keySequence('ctrl+a'), '\x01')
  assert.equal(keySequence('ctrl+c'), '\x03', 'Ctrl+C is 0x03')
  assert.equal(keySequence('ctrl+shift+c'), '\x1b[99;6u', 'and Ctrl+Shift+C is a different sequence')
  assert.equal(keySequence('esc'), '\x1b')
  assert.equal(keySequence('j'), 'j')
  assert.equal(keySequence('nonsense'), undefined)
  assert.equal(keySequence(''), undefined)
})

test('an override moves the action and leaves the default free', () => {
  const resolved = resolveKeymap({ pageDown: 'ctrl+f' })
  assert.equal(actionOf(resolved, 'ctrl+f'), 'pageDown')
  assert.equal(actionOf(resolved, 'pgdn'), undefined, 'the old key is no longer claimed')
  assert.equal(actionOf(resolved, 'pgup'), 'pageUp', 'other actions are untouched')
})

test('two actions claiming one key is refused and reported', () => {
  const resolved = resolveKeymap({ pageDown: 'pgup' })
  assert.equal(actionOf(resolved, 'pgup'), undefined, 'the key is removed rather than won by order')
  assert.equal(resolved.conflicts.length, 1)
  const report = keymapReport(resolved)
  assert.match(report ?? '', /pgup/u)
  assert.match(report ?? '', /pageUp/u)
  assert.match(report ?? '', /pageDown/u)
  assert.match(report ?? '', /ignored/u)
})

test('a default that an override displaced is still reachable by its own default', () => {
  // pageUp moves to ctrl+u, so pgup is free; pageDown may take it back.
  const resolved = resolveKeymap({ pageUp: 'ctrl+u', pageDown: 'pgup' })
  assert.equal(actionOf(resolved, 'ctrl+u'), 'pageUp')
  assert.equal(actionOf(resolved, 'pgup'), 'pageDown')
  assert.deepEqual(resolved.conflicts, [])
})

test('an unknown action or key is reported instead of silently ignored', () => {
  const resolved = resolveKeymap({ pageDown: 'ctrl+f', nonsense: 'x', pageUp: 'f13' })
  assert.equal(actionOf(resolved, 'ctrl+f'), 'pageDown', 'the usable override still applies')
  assert.deepEqual(resolved.unknownActions, ['nonsense'])
  assert.deepEqual(resolved.unknownKeys, ['f13'])
  assert.equal(actionOf(resolved, 'pgup'), 'pageUp', 'and the unusable one keeps its default')
  const report = keymapReport(resolved)
  assert.match(report ?? '', /unknown actions: nonsense/u)
  assert.match(report ?? '', /unknown keys: f13/u)
})

test('a key claimed twice by overrides alone is refused too', () => {
  const resolved = resolveKeymap({ pageUp: 'ctrl+u', pageDown: 'ctrl+u' })
  assert.equal(actionOf(resolved, 'ctrl+u'), undefined)
  assert.equal(resolved.conflicts.length, 1)
})

test('nothing to report when the config is clean', () => {
  assert.equal(keymapReport(resolveKeymap({ pageDown: 'ctrl+f' })), undefined)
})

test('only the moved actions are dispatched through the keymap', () => {
  const untouched = resolveKeymap()
  assert.deepEqual([...untouched.overridden], [], 'nothing is overridden by default')
  assert.deepEqual([...untouched.suppressed], [], 'and nothing is suppressed')

  const moved = resolveKeymap({ pageDown: 'ctrl+f' })
  assert.deepEqual([...moved.overridden], ['pageDown'])
  assert.equal(moved.suppressed.has(keySequence('pgdn') ?? ''), true, 'the old key is suppressed')
  assert.equal(moved.suppressed.has(keySequence('pgup') ?? ''), false, 'the untouched one is not')
})

/**
 * The wiring: a moved key does its new job, the key it displaced does nothing,
 * and the untouched defaults keep the handling they always had.
 */
async function keyTui(keys) {
  const { SshTui } = await import('../lib/tui.js')
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true, keys })
  for (let index = 0; index < 80; index += 1) tui.rows.push({ kind: 'system', text: `line ${index}` })
  return tui
}

test('a moved key performs its action and its old key does nothing', async () => {
  // PageUp scrolls away from the bottom; PageDown is a no-op there, so it could
  // not tell a working binding from a broken one.
  const tui = await keyTui({ pageUp: 'ctrl+f' })
  const before = tui.scrollOffset
  tui.handleData(Buffer.from('\x06'))
  assert.notEqual(tui.scrollOffset, before, 'ctrl+f scrolls the transcript')
  const afterMove = tui.scrollOffset
  tui.handleData(Buffer.from('\x1b[5~'))
  assert.equal(tui.scrollOffset, afterMove, 'the displaced PageUp key no longer scrolls')
})

test('an untouched default key still works the way it always did', async () => {
  const tui = await keyTui({})
  for (let index = 0; index < 40; index += 1) tui.rows.push({ kind: 'system', text: `more ${index}` })
  const before = tui.scrollOffset
  tui.handleData(Buffer.from('\x1b[5~'))
  assert.notEqual(tui.scrollOffset, before, 'PageUp scrolls without any override')
})

test('a conflicting override is reported at boot and leaves the key inert', async () => {
  const tui = await keyTui({ pageDown: 'pgup' })
  const report = tui.rows.map(row => String(row.text ?? '')).join('\n')
  assert.match(report, /键位配置有问题/u, `the problem is said out loud: ${report}`)
  assert.match(report, /pgup/u)
  const before = tui.scrollOffset
  tui.handleData(Buffer.from('\x1b[5~'))
  assert.equal(tui.scrollOffset, before, 'the contested key does nothing rather than the wrong thing')
})
