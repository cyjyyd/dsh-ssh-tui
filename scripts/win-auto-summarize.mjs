#!/usr/bin/env node
/**
 * Validate and summarize a REL085-WIN-AUTO/v1 result file.
 *
 * The contract is the authority: a case ID that is not in the contract, a
 * duplicate case/host run, a wrong terminal/mode, a PASS without its minimum
 * evidence, or a SIMULATED_CONPTY PASS standing in for a REAL_GUI case all
 * fail closed. Exit 0 means every required case for the selected runner passed
 * in the required mode; exit 2 means HOLD/INCOMPLETE/FAIL.
 *
 * Usage:
 *   node scripts/win-auto-summarize.mjs --contract tests/windows-auto/gate-contract.v1.json --results results.json
 *   node scripts/win-auto-summarize.mjs ... --runner linux
 *   node scripts/win-auto-summarize.mjs ... --json
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const value = name => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}
const contractPath = value('contract')
const resultsPath = value('results')
const runner = value('runner') ?? 'windows'
const json = args.includes('--json')
if (contractPath === undefined || resultsPath === undefined) {
  console.error('usage: node scripts/win-auto-summarize.mjs --contract <contract.json> --results <results.json> [--runner windows|linux] [--json]')
  process.exit(2)
}

const load = path => JSON.parse(readFileSync(path, 'utf8'))
const contract = load(contractPath)
const results = load(resultsPath)
const failures = []
const warnings = []
const fail = message => failures.push(message)

if (contract.contract_version !== 'REL085-WIN-AUTO/v1') fail(`unsupported contract version ${contract.contract_version}`)
if (results.contract_version !== contract.contract_version) fail('results contract_version does not match the contract')
for (const key of ['relay_sha', 'relay_tarball_sha256']) {
  if (results.candidate?.[key] !== contract.candidate?.[key]) fail(`candidate.${key} does not match the contract`)
}
if (!['windows', 'linux'].includes(runner)) fail(`unknown runner ${runner}`)

// Fixture hashes are part of the contract, not optional metadata.
for (const fixture of contract.fixture_manifest ?? []) {
  try {
    const actual = createHash('sha256').update(readFileSync(join(ROOT, fixture.path))).digest('hex')
    if (actual !== fixture.sha256) fail(`fixture hash mismatch: ${fixture.path}`)
  } catch {
    fail(`fixture missing: ${fixture.path}`)
  }
}

const cases = new Map()
for (const item of contract.cases ?? []) {
  if (cases.has(item.id)) fail(`duplicate contract case ${item.id}`)
  cases.set(item.id, item)
}
const required = [...cases.values()].filter(item => item.required === true && item.runner_os === runner)
const seen = new Set()
const normalized = []
for (const run of results.runs ?? []) {
  const item = cases.get(run.case_id)
  if (item === undefined) {
    fail(`unknown case ${run.case_id}`)
    continue
  }
  if (item.runner_os !== runner) continue
  if (!item.hosts.includes(run.host)) fail(`${run.case_id}: host ${run.host} not allowed`)
  if (!item.terminals.includes(run.terminal)) fail(`${run.case_id}: terminal ${run.terminal} not allowed`)
  if (run.mode !== item.mode) fail(`${run.case_id}: mode ${run.mode} != contract ${item.mode}`)
  const key = `${run.case_id}::${run.host}`
  if (seen.has(key)) fail(`duplicate run ${key}`)
  seen.add(key)
  if (run.status === 'PASS') {
    if (!Array.isArray(run.evidence) || !run.evidence.some(e => e.type === 'json')) {
      fail(`${key}: PASS requires json evidence`)
    }
    for (const type of item.min_evidence ?? []) {
      if (!run.evidence?.some(e => e.type === type)) fail(`${key}: PASS requires ${type} evidence`)
    }
    if (!Array.isArray(run.assertions) || run.assertions.length === 0) {
      fail(`${key}: PASS requires at least one assertion`)
    } else if (run.assertions.some(a => a.passed !== true)) {
      fail(`${key}: PASS with a failed assertion`)
    }
  }
  if (item.min_evidence?.includes('hwnd') && run.status === 'PASS' && !run.window) {
    fail(`${key}: REAL_GUI PASS requires window evidence`)
  }
  normalized.push(run)
}

const hosts = [...new Set(required.flatMap(item => item.hosts))]
const matrix = []
for (const host of hosts) {
  const missing = []
  const failed = []
  const blocked = []
  let allReal = true
  for (const item of required) {
    if (!item.hosts.includes(host)) continue
    const run = normalized.find(entry => entry.case_id === item.id && entry.host === host)
    if (run === undefined) {
      missing.push(item.id)
      continue
    }
    if (run.status === 'FAIL') failed.push(item.id)
    if (run.status === 'BLOCKED_ENV') blocked.push(item.id)
    if (item.mode === 'REAL_GUI' && (run.mode !== 'REAL_GUI' || run.status !== 'PASS')) allReal = false
  }
  const status = failed.length > 0
    ? 'FAIL'
    : blocked.length > 0
      ? 'BLOCKED_ENV'
      : missing.length > 0
        ? 'HOLD'
        : 'PASS'
  matrix.push({
    host,
    status,
    real_gui_pass: runner === 'windows' && status === 'PASS' && allReal,
    missing,
    failed,
    blocked,
  })
}

const overall = failures.length > 0
  ? 'FAIL'
  : matrix.some(row => row.status === 'FAIL')
    ? 'FAIL'
    : matrix.some(row => row.status === 'BLOCKED_ENV')
      ? 'BLOCKED_ENV'
      : matrix.every(row => row.status === 'PASS') && matrix.length === hosts.length && hosts.length > 0
        ? (runner === 'windows' ? 'REAL_GUI_PASS' : 'REAL_SSH_PASS')
        : 'HOLD'

const summary = {
  contract_version: contract.contract_version,
  runner,
  candidate: results.candidate,
  overall,
  hosts: matrix,
  required_cases: required.map(item => item.id),
  runs: normalized.length,
  failures,
  warnings,
}
if (json) console.log(JSON.stringify(summary, null, 2))
else {
  console.log(`contract: ${contract.contract_version}`)
  console.log(`runner:   ${runner}`)
  console.log(`overall:  ${overall}`)
  for (const row of matrix) {
    console.log(`  ${row.host}: ${row.status}${row.real_gui_pass ? ' (REAL_GUI_PASS)' : ''} missing=${row.missing.length} failed=${row.failed.length} blocked=${row.blocked.length}`)
  }
  for (const failure of failures) console.error(`FAIL: ${failure}`)
}
process.exit(overall === 'REAL_GUI_PASS' || overall === 'REAL_SSH_PASS' ? 0 : 2)
