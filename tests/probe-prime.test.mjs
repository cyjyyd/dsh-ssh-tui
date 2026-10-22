import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { parsePrimeVerdict, primeGate, runPrimeProbe } from '../scripts/probe-home.mjs'

/** A prime process that prints one verdict and exits; no TUI, no profile. */
function fakePrime(output, exitCode = 0) {
  return () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    queueMicrotask(() => {
      child.stdout.write(output)
      child.stdout.end()
      child.stderr.end()
      child.emit('exit', exitCode)
    })
    return child
  }
}

test('the outer gate reads the last PRIME verdict, not just the exit code', () => {
  assert.deepEqual(
    parsePrimeVerdict('noise\nPRIME: SKIP node-pty is unavailable\nmore noise\n'),
    { kind: 'SKIP', detail: 'node-pty is unavailable' },
  )
  assert.deepEqual(parsePrimeVerdict('PRIME: OK workspace reached'), { kind: 'OK', detail: 'workspace reached' })
  assert.deepEqual(parsePrimeVerdict('no marker at all\n'), { kind: 'NONE', detail: '' })

  const ok = primeGate({ exitCode: 0, output: 'PRIME: OK workspace reached' })
  assert.equal(ok.continue, true)
  assert.equal(ok.code, 0)

  const failedExit = primeGate({ exitCode: 1, output: 'PRIME: OK workspace reached' })
  assert.equal(failedExit.continue, false, 'a marker cannot override a failed process')
  assert.equal(failedExit.code, 1)
})

test('a skipped prime never lets the actual probe run', () => {
  // The regression this pins: the old outer wrapper checked only the prime's
  // exit code. A developer-machine SKIP exits 0, so the actual probe ran on a
  // home whose product repair had never happened. The gate must stop it.
  const skip = primeGate({
    exitCode: 0,
    output: 'SKIP: node-pty is unavailable\nPRIME: SKIP node-pty is unavailable',
    required: false,
  })
  assert.equal(skip.ok, false)
  assert.equal(skip.continue, false, 'the caller must not start the actual probe')
  assert.equal(skip.code, 2, 'a developer-machine skip is a distinct non-success result')
  assert.equal(skip.kind, 'SKIP')

  const forced = primeGate({
    exitCode: 0,
    output: 'PRIME: SKIP node-pty is unavailable',
    required: true,
  })
  assert.equal(forced.ok, false)
  assert.equal(forced.continue, false, 'a forced CI skip is a failure, not a pass')
  assert.equal(forced.code, 1)
  assert.equal(forced.kind, 'FAIL')
})

test('a prime with no verdict and an exit 0 is not a pass', () => {
  const gate = primeGate({ exitCode: 0, output: 'boot painted something, but no verdict', required: true })
  assert.equal(gate.ok, false)
  assert.equal(gate.continue, false)
  assert.equal(gate.code, 1)
  assert.equal(gate.kind, 'NONE')
})

test('the outer runner does not continue a skipped prime', async () => {
  const gate = await runPrimeProbe({
    home: '/tmp/prime-fixture',
    required: false,
    spawnPrime: fakePrime('PRIME: SKIP node-pty is unavailable\n'),
  })
  assert.equal(gate.ok, false)
  assert.equal(gate.continue, false, 'the actual probe must not start after a prime SKIP')
  assert.equal(gate.code, 2)

  const forced = await runPrimeProbe({
    home: '/tmp/prime-fixture',
    required: true,
    spawnPrime: fakePrime('PRIME: SKIP node-pty is unavailable\n'),
  })
  assert.equal(forced.ok, false)
  assert.equal(forced.continue, false)
  assert.equal(forced.code, 1, 'CI turns a skipped prime into a failure')

  const noVerdict = await runPrimeProbe({
    home: '/tmp/prime-fixture',
    required: false,
    spawnPrime: fakePrime('boot started but no verdict\n'),
  })
  assert.equal(noVerdict.ok, false)
  assert.equal(noVerdict.continue, false, 'exit 0 without a verdict is not success')
})
