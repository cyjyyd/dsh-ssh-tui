/**
 * The window-death seam's exit-event grace.
 *
 * `tui-drop-probe` used to return as soon as `kill(pid, 0)` failed. On POSIX
 * node-pty can publish the pid as dead a few milliseconds before its `onExit`
 * callback, so the same run then asserted `a.exited === 0` and reported the
 * historical `got no exit event` flake. This test reproduces the skew with a
 * fake clock and pins the grace: the probe waits for the event, but still
 * reports a genuinely never-delivered event as gone after the bound.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForWindowGone } from '../scripts/pty-window.mjs'

function fakeWindow() {
  return { exited: undefined, term: { pid: 4242 } }
}

test('a dead pid waits for a delayed node-pty exit event', async () => {
  const window = fakeWindow()
  let now = 0
  const waits = []
  setTimeout(() => { window.exited = 0 }, 30)
  const gone = await waitForWindowGone(window, 1_000, {
    now: () => now,
    isAlive: () => false,
    exitGraceMs: 500,
    delay: async ms => {
      waits.push(ms)
      now += ms
      if (now >= 30) window.exited ??= 0
    },
  })
  assert.equal(gone, true)
  assert.equal(window.exited, 0, 'the exit code is present when the caller asserts it')
  assert.ok(waits.length > 0, 'the wait yielded instead of reading the dead pid once')
})

test('the old zero-grace behavior is the race this fixes', async () => {
  const window = fakeWindow()
  let now = 0
  const gone = await waitForWindowGone(window, 1_000, {
    now: () => now,
    isAlive: () => false,
    exitGraceMs: 0,
    delay: async ms => { now += ms },
  })
  assert.equal(gone, true)
  assert.equal(window.exited, undefined, 'a caller that asserts now would still say "no exit event"')
})

test('a live window is not reported gone before the timeout', async () => {
  const window = fakeWindow()
  let now = 0
  const gone = await waitForWindowGone(window, 100, {
    now: () => now,
    isAlive: () => true,
    exitGraceMs: 500,
    delay: async ms => { now += ms },
  })
  assert.equal(gone, false)
  assert.equal(window.exited, undefined)
})

test('an already-exited window returns at once', async () => {
  const window = { exited: 0, term: { pid: 4242 } }
  assert.equal(await waitForWindowGone(window, 1_000, { isAlive: () => true }), true)
})
