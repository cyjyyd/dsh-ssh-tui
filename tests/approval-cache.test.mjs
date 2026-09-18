import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ApprovalVerdictCache,
  cacheableShape,
  canonicalCommand,
  verdictKey,
  DEFAULT_VERDICT_CAPACITY,
  DEFAULT_VERDICT_TTL_MS,
} from '../lib/approval-cache.js'

/** One reviewed request; each test changes exactly what it is about. */
function identity(overrides = {}) {
  return {
    toolName: 'bash',
    command: 'python deploy.py',
    args: '{"command":"python deploy.py"}',
    reason: undefined,
    sandboxMode: 'workspace-write',
    agentId: 'main-session',
    workspaceCwd: '/srv/app',
    locale: 'zh',
    reviewer: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    authorization: '部署到预发环境',
    ...overrides,
  }
}

const verdict = { risk: 'low', authorization: 'yes', approved: true, reason: '预发部署已授权' }

test('a canonical command ignores spacing but nothing else', () => {
  assert.equal(canonicalCommand('  python   deploy.py \n'), 'python deploy.py')
  assert.equal(canonicalCommand('python deploy.py --env prod'), 'python deploy.py --env prod')
})

test('only shapes with a visible command are cacheable', () => {
  assert.equal(cacheableShape(identity()), true)
  assert.equal(cacheableShape(identity({ command: '   ' })), false, 'nothing to key on')
  // `bash -c` hides its payload: the review says nothing about the next call.
  assert.equal(cacheableShape(identity({ command: "bash -c 'echo hi'" })), false)
  assert.equal(cacheableShape(identity({ command: 'python -e "print(1)"' })), false)
  // A quoted payload must not be mistaken for an opaque wrapper.
  assert.equal(cacheableShape(identity({ command: 'python deploy.py' })), true)
})

test('the key covers every input the verdict depends on', () => {
  const base = verdictKey(identity())
  assert.equal(verdictKey(identity()), base, 'stable')
  assert.equal(verdictKey(identity({ command: 'python  deploy.py' })), base, 'spacing alone is the same request')
  assert.match(base, /^[0-9a-f]{16}$/u, 'a cryptographic digest, not a 32-bit FNV')

  const changes = {
    toolName: 'pwsh',
    command: 'python deploy.py --env prod',
    args: '{"command":"python deploy.py","env":"prod"}',
    reason: 'escalating to workspace-write',
    sandboxMode: 'danger-full-access',
    agentId: 'sub-1',
    workspaceCwd: '/srv/other',
    locale: 'en',
    reviewer: { provider: 'xai', model: 'grok-4.5' },
    authorization: 'just look around',
  }
  for (const [field, value] of Object.entries(changes)) {
    assert.notEqual(verdictKey(identity({ [field]: value })), base, `${field} must change the key`)
  }
})

test('near-miss commands never share a key', () => {
  // The failure mode a 32-bit FNV invited: a later, different publish
  // answering as the one the user authorized. Capacity is 32; the digest
  // still has to separate these without hoping the birthday bound holds.
  const authorized = verdictKey(identity({ command: 'npm publish' }))
  const tagged = verdictKey(identity({ command: 'npm publish --tag next' }))
  const otherDir = verdictKey(identity({ workspaceCwd: '/srv/other' }))
  assert.notEqual(authorized, tagged)
  assert.notEqual(authorized, otherDir)
  assert.notEqual(tagged, otherDir)
})

test('a remembered verdict is served inside its TTL and dropped after it', () => {
  let now = 1_000
  const cache = new ApprovalVerdictCache({ ttlMs: 10_000, now: () => now })
  const key = verdictKey(identity())
  cache.store(key, verdict)
  assert.equal(cache.size, 1)

  now += 9_000
  const hit = cache.lookup(key)
  assert.equal(hit?.verdict.approved, true)
  assert.equal(hit?.ageMs, 9_000)
  assert.equal(cache.hits, 1)

  now += 1_001
  assert.equal(cache.lookup(key), undefined, 'past the TTL the verdict is gone')
  assert.equal(cache.size, 0, 'an expired entry is dropped, not just ignored')
  assert.equal(cache.hits, 1, 'an expired lookup is not a hit')
})

test('the capacity bound evicts the least recently used entry', () => {
  const cache = new ApprovalVerdictCache({ capacity: 2, now: () => 0 })
  const keys = ['a', 'b', 'c'].map(suffix => verdictKey(identity({ command: `cmd ${suffix}` })))
  cache.store(keys[0], verdict)
  cache.store(keys[1], verdict)
  // Touch the first so the second becomes the least recently used one.
  assert.ok(cache.lookup(keys[0]) !== undefined)
  cache.store(keys[2], verdict)

  assert.equal(cache.size, 2)
  assert.ok(cache.lookup(keys[0]) !== undefined, 'the refreshed entry survives')
  assert.equal(cache.lookup(keys[1]), undefined, 'the untouched entry was evicted')
  assert.ok(cache.lookup(keys[2]) !== undefined)
})

test('clear reports what it dropped and the defaults stay bounded', () => {
  const cache = new ApprovalVerdictCache({ now: () => 0 })
  cache.store(verdictKey(identity({ command: 'a' })), verdict)
  cache.store(verdictKey(identity({ command: 'b' })), verdict)
  assert.equal(cache.clear(), 2)
  assert.equal(cache.size, 0)

  assert.equal(DEFAULT_VERDICT_TTL_MS, 600_000)
  assert.equal(DEFAULT_VERDICT_CAPACITY, 32)
  assert.equal(new ApprovalVerdictCache().ttlMinutes, 10)
})
