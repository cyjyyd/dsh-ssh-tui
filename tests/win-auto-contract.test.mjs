/**
 * REL085-WIN-AUTO/v1 contract and summarizer.
 *
 * This is the Linux-side consumer of the same files a Windows runner reads.
 * It pins the frozen candidate, fixture integrity, closed case set, and the
 * rule that a simulated ConPTY PASS can never become a REAL_GUI_PASS.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = new URL('..', import.meta.url).pathname
const CONTRACT = join(ROOT, 'tests/windows-auto/gate-contract.v1.json')
const SUMMARIZER = join(ROOT, 'scripts/win-auto-summarize.mjs')
const contract = JSON.parse(readFileSync(CONTRACT, 'utf8'))

const statuses = new Set(['PASS', 'FAIL', 'SKIP', 'NOT_MEASURED', 'BLOCKED_ENV'])
const evidenceFor = item => [...new Set(['json', ...(item.min_evidence ?? [])])]

function runFor(item, host, { mode = item.mode, status = 'PASS', evidence = evidenceFor(item) } = {}) {
  const terminal = item.terminals[0]
  const assertions = item.stages.flatMap(stage => stage.assertions.map(assertion => ({
    id: assertion.id,
    kind: assertion.kind,
    expected: assertion.expected,
    actual: assertion.expected,
    passed: status === 'PASS',
  })))
  return {
    case_id: item.id,
    host,
    terminal,
    mode,
    status,
    started_at: '2026-11-09T00:00:00.000Z',
    finished_at: '2026-11-09T00:00:01.000Z',
    assertions,
    evidence: evidence.map(type => ({ type, path: `evidence/${item.id}-${type}.json` })),
    cleanup: { status: 'PASS' },
    ...(item.min_evidence?.includes('hwnd') ? {
      window: {
        hwnd: '0x1234', window_class: 'ConsoleWindowClass', window_title: 'synthetic',
        pid: 1234, process_name: 'WindowsTerminal.exe', visible: true,
        window_rect: { left: 0, top: 0, right: 100, bottom: 40 },
        terminal_kind: 'windows-terminal',
      },
    } : {}),
    ...(item.mode === 'REAL_SSH_NETWORK' ? {
      host_state: { pid: 1234, alive: true, session_state: 'running', tcp_state: 'ESTABLISHED', fin_or_rst: false },
    } : {}),
  }
}

function resultFor(cases, hosts, options = {}) {
  return {
    contract_version: contract.contract_version,
    runner: {
      os: options.os ?? 'Windows 11',
      machine: 'synthetic-test',
      utc_start: '2026-11-09T00:00:00.000Z',
      utc_end: '2026-11-09T00:00:01.000Z',
      session_id: 2,
    },
    candidate: {
      relay_sha: contract.candidate.relay_sha,
      relay_tarball_sha256: contract.candidate.relay_tarball_sha256,
    },
    runs: cases.flatMap(item => item.hosts.filter(host => hosts.includes(host)).map(host => runFor(item, host, options.run))),
  }
}

function summarize(payload, runner = 'windows') {
  const dir = mkdtempSync(join(tmpdir(), 'win-auto-test-'))
  const file = join(dir, 'results.json')
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
  const proc = spawnSync(process.execPath, [SUMMARIZER, '--contract', CONTRACT, '--results', file, '--runner', runner, '--json'], { encoding: 'utf8' })
  rmSync(dir, { recursive: true, force: true })
  return { status: proc.status, json: proc.stdout.trim() === '' ? undefined : JSON.parse(proc.stdout), stderr: proc.stderr }
}

test('the contract is versioned, closed, and pins the exact candidate', () => {
  assert.equal(contract.contract_version, 'REL085-WIN-AUTO/v1')
  assert.equal(contract.candidate.relay_sha, '5ba9eff4ae90170ea8374781c06b3af5a38d46b7')
  assert.equal(contract.candidate.relay_tarball_sha256, 'a76ccf388fed33b9b94bbc57d9c2575c1fe0066d53918d352af87317df4be0e6')
  assert.equal(contract.candidate.node, '>=24.9.0')
  assert.deepEqual(contract.candidate.targets.map(t => t.dsh), ['0.2.1-rc.5', '0.2.2-rc.1'])
  assert.equal(contract.cases.length, 12)
  assert.equal(new Set(contract.cases.map(item => item.id)).size, contract.cases.length)
  for (const item of contract.cases) {
    assert.ok(item.id.length > 0)
    assert.ok(statuses.has('PASS'))
    assert.ok(item.stages.length > 0, `${item.id}: stages`)
    for (const stage of item.stages) {
      assert.ok(stage.assertions.length > 0, `${item.id}/${stage.id}: assertions`)
      for (const assertion of stage.assertions) {
        assert.ok(assertion.kind.length > 0)
        assert.ok('expected' in assertion)
      }
    }
  }
})

test('fixtures are pure synthetic and their hashes match the contract', () => {
  for (const fixture of contract.fixture_manifest) {
    const bytes = readFileSync(join(ROOT, fixture.path))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256, fixture.path)
    const text = bytes.toString('utf8')
    assert.doesNotMatch(text, /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/u, `${fixture.path}: no email`)
    assert.doesNotMatch(text, /(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/u, `${fixture.path}: no credential-shaped token`)
  }
})

test('a complete real Windows matrix is REAL_GUI_PASS', () => {
  const windowsCases = contract.cases.filter(item => item.runner_os === 'windows')
  const payload = resultFor(windowsCases, ['0.2.1-rc.5', '0.2.2-rc.1'])
  const { status, json } = summarize(payload)
  assert.equal(status, 0, JSON.stringify(json))
  assert.equal(json.overall, 'REAL_GUI_PASS')
  assert.equal(json.hosts.every(host => host.real_gui_pass), true)
})

test('SIMULATED_CONPTY can never satisfy the real GUI contract', () => {
  const windowsCases = contract.cases.filter(item => item.runner_os === 'windows')
  const payload = resultFor(windowsCases, ['0.2.1-rc.5', '0.2.2-rc.1'], { run: { mode: 'SIMULATED_CONPTY' } })
  const { status, json } = summarize(payload)
  assert.notEqual(status, 0)
  assert.equal(json.overall, 'FAIL')
  assert.equal(json.failures.some(message => message.includes('mode SIMULATED_CONPTY')), true)
})

test('a missing case is HOLD, not PASS', () => {
  const windowsCases = contract.cases.filter(item => item.runner_os === 'windows')
  const payload = resultFor(windowsCases, ['0.2.1-rc.5', '0.2.2-rc.1'])
  payload.runs = payload.runs.filter(run => !(run.case_id === 'WIN-IME-01' && run.host === '0.2.2-rc.1'))
  const { status, json } = summarize(payload)
  assert.equal(status, 2)
  assert.equal(json.overall, 'HOLD')
  assert.equal(json.hosts.find(host => host.host === '0.2.2-rc.1').missing.includes('WIN-IME-01'), true)
})

test('the Linux H11 contract is REAL_SSH_PASS only with its evidence', () => {
  const h11 = contract.cases.find(item => item.id === 'H11-SSH-01')
  const payload = resultFor([h11], ['0.2.1-rc.5', '0.2.2-rc.1'], { os: 'Linux' })
  const { status, json } = summarize(payload, 'linux')
  assert.equal(status, 0, JSON.stringify(json))
  assert.equal(json.overall, 'REAL_SSH_PASS')
})
