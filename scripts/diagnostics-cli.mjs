#!/usr/bin/env node
/**
 * Operator/CI CLI for the metadata-only diagnostics handoff.
 *
 * Credentials and destination configuration come from the environment or the
 * 0600 config files; this CLI accepts no token flags and prints no secret
 * values. `publish` exits 0 when diagnostics are disabled/not configured so a
 * CI job is never turned green or red by an optional evidence upload.
 */
import process from 'node:process'
import {
  publishDiagnosticFailure,
  fetchDiagnosticBundle,
  drainDiagnosticsSpool,
  diagnosticsStatus,
} from '../lib/diagnostics/index.js'

function usage() {
  return `usage:
  node scripts/diagnostics-cli.mjs status
  node scripts/diagnostics-cli.mjs publish [--kind turn-error|boot-error|probe-failure]
      [--failure-code CODE] [--phase PHASE] [--exit-code N] [--problem-class CLASS] [--strict]
  node scripts/diagnostics-cli.mjs fetch <bundleId>
  node scripts/diagnostics-cli.mjs drain

Configuration is read only from DSH_DIAGNOSTICS_* environment variables or the
0600 files they point at. No token or key is accepted on the command line.`
}

function take(args, name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${name}`)
  args.splice(index, 2)
  return value
}

function fail(code, message) {
  process.stderr.write(`diagnostics: ${code}${message === undefined ? '' : ` (${message})`}\n`)
  return 1
}

async function main() {
  const args = process.argv.slice(2)
  const command = args.shift()
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  if (command === 'status') {
    const status = await diagnosticsStatus()
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
    return 0
  }
  if (command === 'publish') {
    const kind = take(args, '--kind', 'turn-error')
    const failureCode = take(args, '--failure-code', 'MANUAL_FAILURE')
    const phase = take(args, '--phase', 'unknown')
    const exitCode = Number(take(args, '--exit-code', '1'))
    const problemClass = take(args, '--problem-class', 'UNKNOWN')
    const strict = args.includes('--strict')
    const result = await publishDiagnosticFailure({
      kind,
      failureCode,
      phase,
      exitCode,
      problemClasses: [problemClass],
    })
    process.stdout.write(`diagnostics: ${result.state}${result.receipt === undefined ? '' : ` ${result.receipt.bundleId}`}${result.errorClass === undefined ? '' : ` ${result.errorClass}`}\n`)
    if (strict && (result.state === 'blocked' || result.state === 'failed')) return 1
    return 0
  }
  if (command === 'fetch') {
    const bundleId = args.shift()
    if (bundleId === undefined) return fail('USAGE', 'fetch requires a bundle id')
    try {
      const result = await fetchDiagnosticBundle(bundleId)
      process.stdout.write(`diagnostics: ${result.state} ${result.manifest.bundleId} exit=${result.exitCode ?? 'none'} ${result.verifiedContent ? 'content-verified' : 'envelope-verified'}\n`)
      return 0
    } catch (error) {
      return fail(error?.code ?? 'DOWNLOAD_FAILED')
    }
  }
  if (command === 'drain') {
    const result = await drainDiagnosticsSpool()
    process.stdout.write(`diagnostics: drain attempted=${result.attempted} verified=${result.verified} failed=${result.failed} pending=${result.skipped}\n`)
    return 0
  }
  return fail('USAGE')
}

main().then((code) => {
  process.exitCode = code
}).catch((error) => {
  process.exitCode = fail(error?.code ?? 'ERROR')
})
