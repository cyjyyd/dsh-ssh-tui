/**
 * The launcher's exit path. Esc from the picker, `/exit`, a replaced window and
 * the error paths all funnel through it, so the two things it guarantees are
 * worth pinning: the terminal is handed back *before* anything asks the process
 * to leave, and a graceful shutdown that never drains cannot keep the user's
 * shell hostage.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { EXIT_FALLBACK_MS, createLauncherExit } from '../lib/launcher-exit.js'

function fakeStdin(log) {
  return {
    setRawMode(value) { log.push(`raw:${value}`) },
    pause() { log.push('pause') },
  }
}

test('the terminal is handed back before the launcher is asked to exit', () => {
  const log = []
  const exit = createLauncherExit({
    stdin: fakeStdin(log),
    appExit: () => (code) => { log.push(`appExit:${code}`) },
    force: (code) => { log.push(`force:${code}`) },
    schedule: () => { log.push('scheduled'); return { unref() {} } },
  })
  exit(0)
  assert.deepEqual(log, ['raw:false', 'pause', 'appExit:0', 'scheduled'])
})

test('a graceful shutdown that never drains is bounded', () => {
  const log = []
  let fire
  const exit = createLauncherExit({
    stdin: fakeStdin(log),
    appExit: () => (code) => { log.push(`appExit:${code}`) },
    force: (code) => { log.push(`force:${code}`) },
    fallbackMs: 2_000,
    schedule: (handler, ms) => { log.push(`wait:${ms}`); fire = handler; return { unref() {} } },
  })
  exit(0)
  assert.deepEqual(log, ['raw:false', 'pause', 'appExit:0', 'wait:2000'])
  assert.equal(typeof fire, 'function')
  fire()
  assert.deepEqual(log.at(-1), 'force:0', 'the stalled drain is forced out')
})

test('the fallback timer never keeps the process alive on its own', () => {
  let unrefCalled = false
  const exit = createLauncherExit({
    stdin: fakeStdin([]),
    appExit: () => () => {},
    force: () => {},
    schedule: () => ({ unref() { unrefCalled = true } }),
  })
  exit(1)
  assert.equal(unrefCalled, true)
})

test('without a graceful shutdown the process leaves at once', () => {
  const log = []
  const exit = createLauncherExit({
    stdin: fakeStdin(log),
    appExit: () => undefined,
    force: (code) => { log.push(`force:${code}`) },
    schedule: () => { log.push('scheduled'); return { unref() {} } },
  })
  exit(3)
  assert.deepEqual(log, ['raw:false', 'pause', 'force:3'])
})

test('the fallback window is the documented one', () => {
  assert.equal(EXIT_FALLBACK_MS, 2_000)
})
