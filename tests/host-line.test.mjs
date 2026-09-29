import test from 'node:test'
import assert from 'node:assert/strict'

import { FORMS_SINCE, isFormsVersion, versionTriple } from '../scripts/host-line.mjs'

/**
 * Which host generation a version is.
 *
 * Three callers branch on this — the test helper, the end-to-end probe and the
 * profile-row writer — and they decide which rows a terminal profile mounts, so
 * one of them answering "legacy" for a forms host is a wrong profile row, not a
 * cosmetic difference. The 0.2.0-rc line is why this file exists: it shares no
 * prefix with 0.1.7, which is what a `startsWith('0.1.7')` test assumed.
 */
test('the seam is 0.1.7 and later, whatever the line is called', () => {
  for (const version of ['0.1.7-alpha.1', '0.1.7-rc.1', '0.1.7-rc.2', '0.1.7', '0.1.8']) {
    assert.equal(isFormsVersion(version), true, version)
  }
  for (const version of ['0.1.5-rc.1', '0.1.5-rc.3', '0.1.5', '0.1.6-alpha.1', '0.1.6-alpha.2', '0.1.6']) {
    assert.equal(isFormsVersion(version), false, version)
  }
})

test('a later major line is a forms host, not a stranger', () => {
  // The whole point of comparing tuples: 0.2.0-rc.1 is not "0.1.x plus one", and
  // a prefix test answers legacy for it.
  for (const version of ['0.2.0-rc.1', '0.2.0', '0.2.1-rc.2', '0.10.0', '1.0.0']) {
    assert.equal(isFormsVersion(version), true, version)
  }
})

test('the tuple reader is loose on purpose, and never throws', () => {
  assert.deepEqual(versionTriple('0.2.0-rc.1'), [0, 2, 0])
  assert.deepEqual(versionTriple('1.2.3+build.7'), [1, 2, 3])
  assert.deepEqual(versionTriple('0.1'), [0, 1, 0])
  // A host that reports something unparseable must degrade to the conservative
  // answer instead of crashing a probe mid-run.
  for (const broken of ['', 'garbage', undefined, null, 'v0.1.7']) {
    assert.doesNotThrow(() => isFormsVersion(broken), String(broken))
  }
  assert.equal(isFormsVersion(''), false)
  assert.equal(isFormsVersion('garbage'), false)
})

test('the comparison is the documented constant, not an inline number', () => {
  assert.deepEqual(FORMS_SINCE, [0, 1, 7])
  const [major, minor, patch] = FORMS_SINCE
  assert.equal(isFormsVersion(`${major}.${minor}.${patch}`), true)
  assert.equal(isFormsVersion(`${major}.${minor}.${patch - 1}`), false)
})
