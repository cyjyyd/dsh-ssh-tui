#!/usr/bin/env node
/**
 * One command for a batch's acceptance evidence.
 *
 * The project's bar for a batch is: typecheck, the full suite, the real-PTY
 * probes, and CI — and gathering that by hand means five commands whose output
 * has to be read one at a time. This runs them in order, prints one line per
 * step with the numbers that matter, and exits non-zero if anything failed, so
 * "is this batch acceptable?" is a single answer tied to a commit.
 *
 * Usage:
 *   node scripts/verify-batch.mjs            # every step
 *   node scripts/verify-batch.mjs --batch B  # label the run (no behavior change)
 *   node scripts/verify-batch.mjs --only test,probe   # subset, for iteration
 *
 * A probe that prints `SKIP:` counts as skipped, not failed: node-pty and the
 * mock server are optional for a machine without a built PTY stack, and a skip
 * is reported as such rather than quietly passing.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'

const STEPS = [
  { id: 'typecheck', label: 'typecheck', command: 'npm', args: ['run', 'typecheck'], timeoutMs: 300_000 },
  { id: 'test', label: 'full suite', command: 'npm', args: ['test'], timeoutMs: 900_000 },
  { id: 'probe', label: 'pty probe (real profile)', command: 'node', args: ['scripts/tui-probe.mjs'], timeoutMs: 300_000 },
  // The same probe on a profile this repo built itself: the path CI and a fresh
  // machine take, and the only one Windows can take.
  { id: 'home', label: 'pty probe (throwaway home)', command: 'node', args: ['scripts/probe-home.mjs', '--probe'], timeoutMs: 900_000 },
  // One boot per terminal family, asserting the escapes each would get: the
  // capability table is cheap to unit test, the wiring is what shipped wrong.
  { id: 'term', label: 'pty terminal-capability probe', command: 'node', args: ['scripts/probe-home.mjs', '--probe', '--script', 'tui-term-probe.mjs'], timeoutMs: 900_000 },
  { id: 'drop', label: 'pty drop probe', command: 'node', args: ['scripts/tui-drop-probe.mjs'], timeoutMs: 300_000 },
  { id: 'mock', label: 'pty mock-turn probe', command: 'node', args: ['scripts/tui-mock-probe.mjs'], timeoutMs: 300_000 },
  { id: 'route', label: 'pty session-route probe', command: 'node', args: ['scripts/tui-route-probe.mjs'], timeoutMs: 300_000 },
  { id: 'busy', label: 'pty busy-drop probe', command: 'node', args: ['scripts/tui-mock-probe.mjs', '--busy'], timeoutMs: 300_000 },
  { id: 'linemode', label: 'pty line-mode probe', command: 'node', args: ['scripts/tui-probe.mjs', '--line-mode'], timeoutMs: 300_000 },
  // Rendered footer frames: the escape-body leak of B-1 passed every unit test
  // (they fed the fitter unstyled chips) and was only visible on a frame.
  { id: 'footer', label: 'footer frame check', command: 'node', args: ['scripts/capture-footer-frames.mjs', '--check-only'], timeoutMs: 300_000 },
]

function runStep(step) {
  return new Promise(resolve => {
    const started = Date.now()
    const child = spawn(step.command, step.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: 124, output: `${output}\n[timed out after ${step.timeoutMs}ms]`, ms: Date.now() - started })
    }, step.timeoutMs)
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ code: 127, output: `${output}\n${String(error)}`, ms: Date.now() - started })
    })
    child.on('exit', code => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, output, ms: Date.now() - started })
    })
  })
}

/** The numbers a human would look for, pulled out of each step's output. */
function summarize(step, result) {
  const text = result.output
  if (step.id === 'test') {
    const line = /^ℹ tests \d+$/mu.exec(text)?.[0]
    const pass = /^ℹ pass \d+$/mu.exec(text)?.[0]
    const fail = /^ℹ fail \d+$/mu.exec(text)?.[0]
    const skipped = /^ℹ skipped \d+$/mu.exec(text)?.[0]
    if (line !== undefined) {
      return [line, pass, fail, skipped].filter(Boolean).map(part => part.replace('ℹ ', '')).join(' · ')
    }
    return 'no test summary in the output'
  }
  if (step.id === 'typecheck') return result.code === 0 ? 'tsc --noEmit clean' : 'type errors'
  const skip = /^SKIP:.*$/mu.exec(text)?.[0]
  if (skip !== undefined) return skip
  const ok = /^OK:.*$/mu.exec(text)?.[0]
  if (ok !== undefined) return ok
  const verdict = /^RESULT: (?:PASS|FAIL).*$/mu.exec(text)?.[0]
  if (verdict !== undefined) return verdict
  return text.trim().split('\n').at(-1)?.slice(0, 120) ?? ''
}

function revision() {
  let commit = 'unknown'
  try {
    commit = readFileSync('.git/HEAD', 'utf8').trim()
    if (commit.startsWith('ref: ')) {
      commit = readFileSync(`.git/${commit.slice(5)}`, 'utf8').trim()
    }
  } catch {
    // Not a git checkout: the probe still runs.
  }
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version
  return `v${version} @ ${commit.slice(0, 7)}`
}

function parseArgs(argv) {
  const parsed = { batch: undefined, only: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--batch') parsed.batch = argv[++index]
    else if (arg === '--only') parsed.only = argv[++index]?.split(',').filter(Boolean)
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/verify-batch.mjs [--batch A|B|C] [--only typecheck,test,probe,drop,mock,route,busy,linemode,footer]')
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return parsed
}

const { batch, only } = parseArgs(process.argv.slice(2))
const steps = only === undefined ? STEPS : STEPS.filter(step => only.includes(step.id))
if (steps.length === 0) {
  console.error(`no steps selected; known ids: ${STEPS.map(step => step.id).join(', ')}`)
  process.exit(2)
}

console.log(`acceptance evidence${batch === undefined ? '' : ` for batch ${batch}`} — ${revision()}`)
console.log('')

const results = []
for (const step of steps) {
  process.stdout.write(`${step.label} … `)
  const result = await runStep(step)
  const skipped = result.code === 0 && /^SKIP:/mu.test(result.output)
  const verdict = result.code === 0 ? (skipped ? 'SKIP' : 'PASS') : 'FAIL'
  console.log(`${verdict}  (${(result.ms / 1000).toFixed(1)}s)  ${summarize(step, result)}`)
  results.push({ step, result, verdict })
}

const failed = results.filter(entry => entry.verdict === 'FAIL')
console.log('')
if (failed.length > 0) {
  for (const { step, result } of failed) {
    console.error(`--- ${step.label} failed (exit ${result.code}) ---`)
    console.error(result.output.trim().split('\n').slice(-25).join('\n'))
  }
  console.error(`RESULT: FAIL (${failed.map(entry => entry.step.id).join(', ')})`)
  process.exit(1)
}
const skipped = results.filter(entry => entry.verdict === 'SKIP').map(entry => entry.step.id)
console.log(`RESULT: PASS${skipped.length === 0 ? '' : ` (skipped: ${skipped.join(', ')})`}`)
