/**
 * Diagnostics for the real-PTY probes.
 *
 * The 0.9.0 main-push red (run 45735121259 attempt 1) was a setup probe that printed
 * `resumed first run: … workspace back` and then `FAIL` on the same run. Two things
 * were wrong with the evidence rather than with the product:
 *
 *   - the success line was emitted before the assertions were known to pass;
 *   - the failure left no screen, no child exit status and no versions behind.
 *
 * These cases pin the diagnostics contract: a workspace-ready signal that is more
 * than a stray `❯`/`╭`, a reporter that never prints a success line on failure, and
 * a sanitised bundle that a public CI artifact can carry.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  reportOutcome,
  sanitizeText,
  workspaceReady,
  writeDiagnosticBundle,
} from '../scripts/probe-diagnostics.mjs'

test('a workspace is only ready with both the cwd chip and a composer', () => {
  assert.equal(workspaceReady('❯ '), false, 'a bare prompt is not a workspace frame')
  assert.equal(workspaceReady('╭────╮'), false, 'a composer border alone is not a workspace frame')
  assert.equal(workspaceReady('目录:repo'), false, 'the footer chip alone is not a workspace frame')
  assert.equal(workspaceReady('目录:repo\n❯ '), true, 'footer chip + prompt')
  assert.equal(workspaceReady('目录：repo\n╭────╮'), true, 'footer chip + composer border (full-width colon)')
})

test('sanitisation drops keys, bearer tokens, homes and session ids', () => {
  const raw = [
    'home: /home/alice/project',
    'probe: /tmp/dsh-artifact-home-4BBDnN',
    'key=sk-live-1234567890',
    'Authorization: Bearer abc.def.ghi',
    'DEEPSEEK_API_KEY=sk-xyz-987654321',
    'resume=session-123e4567-e89b-12d3-a456-426614174000',
  ].join('\n')
  const safe = sanitizeText(raw, { home: '/home/alice/project' })
  assert.ok(!safe.includes('/home/alice'), safe)
  assert.ok(!safe.includes('dsh-artifact-home-4BBDnN'), safe)
  assert.ok(!safe.includes('sk-live-1234567890'), safe)
  assert.ok(!safe.includes('sk-xyz-987654321'), safe)
  assert.ok(!safe.includes('abc.def.ghi'), safe)
  assert.ok(!safe.includes('123e4567-e89b-12d3-a456-426614174000'), safe)
  assert.match(safe, /<home>/u)
  assert.match(safe, /<probe-home>/u)
  assert.match(safe, /<redacted-key>/u)
  assert.match(safe, /<redacted-token>/u)
  assert.match(safe, /<session-id>/u)
})

test('the outcome reporter never prints success lines for a failed run', () => {
  const success = []
  const errors = []
  const code = reportOutcome({
    problems: ['the workspace never came back'],
    successLines: ['resumed first run: workspace back'],
    log: line => success.push(line),
    error: line => errors.push(line),
  })
  assert.equal(code, 1)
  assert.deepEqual(success, [], 'no success line on failure')
  assert.match(errors.join('\n'), /FAIL/u)
  assert.match(errors.join('\n'), /the workspace never came back/u)

  const ok = []
  const codeOk = reportOutcome({
    problems: [],
    successLines: ['resumed first run: workspace back'],
    log: line => ok.push(line),
    error: () => assert.fail('no error output on success'),
  })
  assert.equal(codeOk, 0)
  assert.deepEqual(ok, ['resumed first run: workspace back'])
})

test('the failure bundle is written, sanitised and machine-readable', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-probe-diag-test-'))
  try {
    const result = writeDiagnosticBundle({
      dir: base,
      phase: 'resumed-save',
      problems: ['timed out waiting for workspace'],
      output: 'saved\nsk-live-1234567890\n/home/alice/project\n',
      screen: '安装向导 9/9\nsk-live-1234567890\n',
      child: { name: 'resumed', pid: 4242, exit: { exitCode: 1, signal: null } },
      elapsedMs: 30_123,
      runtime: { node: 'v24.20.0', npm: '11.19.0', pnpm: 'unavailable', os: 'linux 6.8 x64' },
      now: new Date('2026-11-26T02:30:00Z'),
    })
    assert.ok(existsSync(join(result.dir, 'diagnostics.json')))
    assert.ok(existsSync(join(result.dir, 'screen.txt')))
    assert.ok(existsSync(join(result.dir, 'transcript.txt')))
    assert.ok(existsSync(join(result.dir, 'versions.txt')))
    const json = JSON.parse(readFileSync(join(result.dir, 'diagnostics.json'), 'utf8'))
    assert.equal(json.schema, 'dsh-ssh-tui/probe-diagnostics/v1')
    assert.equal(json.phase, 'resumed-save')
    assert.equal(json.elapsedMs, 30_123)
    assert.equal(json.child.name, 'resumed')
    assert.equal(json.child.exit.exitCode, 1)
    assert.equal(json.runtime.pnpm, 'unavailable')
    assert.deepEqual(json.problems, ['timed out waiting for workspace'])
    for (const name of ['screen.txt', 'transcript.txt', 'versions.txt']) {
      const text = readFileSync(join(result.dir, name), 'utf8')
      assert.ok(!text.includes('sk-live-1234567890'), `${name} leaked the key`)
      assert.ok(!text.includes('/home/alice'), `${name} leaked the home`)
    }
    assert.match(readFileSync(join(result.dir, 'versions.txt'), 'utf8'), /node/u)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
