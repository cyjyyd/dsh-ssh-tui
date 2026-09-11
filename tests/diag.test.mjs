/**
 * `/diag` renders one local snapshot plus the decision chain a support report
 * needs. The renderer is pure, so these tests pin the important verdicts:
 * zombie, live leftover, stale, dead socket residue, pid reuse.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from '../lib/i18n/index.js'
import { diagVerdicts, formatDiag, DIAG_ERR_TAIL_BYTES } from '../lib/diag.js'

setLocale('en')

function snapshot(overrides = {}) {
  return {
    pluginVersion: '0.5.10',
    hostVersion: '0.1.5-rc.1',
    nodeVersion: 'v24.20.0',
    platform: 'linux x64',
    sessionId: 'main-session-abc',
    hostProcess: false,
    locksDisabled: false,
    dshHome: '/root/.dsh',
    sockPath: '/root/.dsh/tui-socks/main-session-abc.sock',
    sockReachable: true,
    sockFilePresent: true,
    host: { kind: 'live', pid: 4242, state: 'attached', agentStatus: 'idle', path: '/root/.dsh/tui-socks/main-session-abc.sock' },
    link: { kind: 'ssh', rttMs: 55, probeState: 'measured' },
    lockHeldByThisProcess: false,
    otherLocks: [],
    ...overrides,
  }
}

test('a live leftover Host is explained with the attach advice', () => {
  const verdicts = diagVerdicts(snapshot())
  assert.match(verdicts[0], /attaches to the leftover Host/)
  assert.match(verdicts[1], /do not open a second window/)
})

test('a zombie names its pid and suggests the fix', () => {
  const verdicts = diagVerdicts(snapshot({
    host: { kind: 'zombie', pid: 77, state: 'paused', path: '/x.sock' },
  }))
  assert.match(verdicts[0], /reports a zombie/)
  assert.match(verdicts[0], /77/)
  assert.match(verdicts[1], /delete the lock/)
})

test('a stale lock is reported as takeable and says so', () => {
  const verdicts = diagVerdicts(snapshot({
    host: { kind: 'stale', pid: 9, path: '/x.sock' },
  }))
  assert.match(verdicts[0], /process is gone/)
  assert.match(verdicts[1], /just --resume/)
})

test('a dead socket file is called out as the first-attach trap', () => {
  const verdicts = diagVerdicts(snapshot({ sockReachable: false, sockFilePresent: true }))
  assert.equal(verdicts.some(line => /EPIPE/.test(line)), true)
})

test('an unresponsive terminal is explained, not hidden', () => {
  const verdicts = diagVerdicts(snapshot({ link: { kind: 'ssh', probeState: 'unknown' } }))
  assert.equal(verdicts.some(line => /did not answer CSI 6n/.test(line)), true)
})

test('pid reuse and unverifiable identity are surfaced', () => {
  const reused = diagVerdicts(snapshot({ host: { kind: 'zombie', pid: 5, identity: 'mismatch', path: '/x' } }))
  assert.equal(reused.some(line => /recycled/.test(line)), true)
  const unverifiable = diagVerdicts(snapshot({ host: { kind: 'live', pid: 5, identity: 'unverifiable', path: '/x' } }))
  assert.equal(unverifiable.some(line => /could not be verified/.test(line)), true)
})

test('a detached busy Host explains the lock it still holds', () => {
  const verdicts = diagVerdicts(snapshot({ host: { kind: 'live', pid: 12, state: 'running-detached', path: '/x' } }))
  assert.equal(verdicts.some(line => /releases the write lock once the current turn settles/.test(line)), true)
})

test('the report carries the facts a bug report needs', () => {
  const lines = formatDiag(snapshot({
    sessionLog: { format: 'v3 zstd', bytes: 4779726, seq: 4557 },
    errTail: 'dsh-ssh-tui: cannot listen on display socket',
    otherLocks: [{ sessionId: 'main-session-other', pid: 2139995, state: 'attached' }],
  })).join('\n')
  for (const needle of [
    'versions: plugin 0.5.10',
    'dsh 0.1.5-rc.1',
    'session: main-session-abc',
    'display channel: /root/.dsh/tui-socks/main-session-abc.sock (unix socket)',
    'connectable yes',
    'Host: alive and attachable · pid 4242',
    'RTT 55ms',
    'seq 4557',
    'main-session-other',
    'recent Host stderr',
    'cannot listen on display socket',
  ]) {
    assert.equal(lines.includes(needle), true, `report must include ${needle}`)
  }
  assert.equal(DIAG_ERR_TAIL_BYTES > 0, true)
})

test('the session log format never doubles the version prefix', () => {
  const lines = formatDiag(snapshot({ sessionLog: { format: 'v3 zstd', bytes: 379 } })).join('\n')
  assert.equal(lines.includes('vv3'), false, 'the artifact name already starts with v')
  assert.equal(lines.includes('v3 zstd'), true)
})

test('a missing session log is reported instead of throwing', () => {
  const lines = formatDiag(snapshot({ sessionLog: undefined })).join('\n')
  assert.equal(lines.includes('session log: missing'), true)
})

test('no verdict chain entry is empty when nothing is wrong', () => {
  const lines = formatDiag(snapshot({ host: { kind: 'none', path: '/x' }, sockReachable: false, sockFilePresent: false }))
  assert.equal(lines[0].startsWith('DeepSeek Harness'), true)
  assert.equal(lines.some(line => line.includes('idle and --resume starts a fresh Host')), true)
})
