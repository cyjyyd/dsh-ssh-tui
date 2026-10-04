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
 * mock server are optional for a machine without a built PTY stack. A skipped
 * step is never summarized as a pass — the run ends `INCOMPLETE` and exits 2 —
 * because a gate that reports success for work it did not do is not a gate.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'

/**
 * How to run `npm` on this machine.
 *
 * `spawn('npm', …)` works on POSIX and never on Windows: what is installed there
 * is `npm.cmd`, which Node refuses to spawn without a shell (CVE-2024-27980),
 * and the step failed with `spawn npm ENOENT` — reported as a red `typecheck`
 * and a red `full suite` in zero seconds, which reads like a code defect and is
 * not one. `npm_execpath` is the npm that is already running this (set under
 * `npm run`, the normal invocation), and it is the same npm either way.
 */
function npmInvocation(args) {
  const execpath = process.env.npm_execpath
  if (execpath !== undefined && execpath !== '' && existsSync(execpath)) {
    return { command: process.execPath, args: [execpath, ...args], shell: false }
  }
  // No `npm_execpath` means this was started as `node scripts/verify-batch.mjs`.
  // Windows has no `npm` executable — only `npm.cmd`, which Node refuses to spawn
  // without a shell (CVE-2024-27980); the whole line goes in as one string so
  // Node does not also warn about args passed alongside `shell: true` (DEP0190).
  if (process.platform === 'win32') return { command: `npm.cmd ${args.join(' ')}`, args: [], shell: true }
  return { command: 'npm', args, shell: false }
}

const STEPS = [
  { id: 'typecheck', label: 'typecheck', command: 'npm', args: ['run', 'typecheck'], timeoutMs: 300_000 },
  { id: 'test', label: 'full suite', command: 'npm', args: ['test'], timeoutMs: 900_000 },
  { id: 'probe', label: 'pty probe (real profile)', command: 'node', args: ['scripts/tui-probe.mjs'], timeoutMs: 300_000, realProfile: true },
  // The same probe on a profile this repo built itself: the path CI and a fresh
  // machine take, and the only one Windows can take.
  { id: 'home', label: 'pty probe (throwaway home)', command: 'node', args: ['scripts/probe-home.mjs', '--probe'], timeoutMs: 900_000 },
  // One boot per terminal family, asserting the escapes each would get: the
  // capability table is cheap to unit test, the wiring is what shipped wrong.
  { id: 'term', label: 'pty terminal-capability probe', command: 'node', args: ['scripts/probe-home.mjs', '--probe', '--script', 'tui-term-probe.mjs'], timeoutMs: 900_000 },
  // The link chip, in both shapes: a fresh session on a link that starts slow
  // (the original "the chip never recovered" report) and a *resume with history*,
  // where no frame may be composed until the log has been read — the window the
  // relay attaches inside, and the one a fix there can silently break.
  { id: 'link', label: 'pty link-quality probe (fresh + resume)', command: 'node', args: ['scripts/probe-home.mjs', '--probe', '--script', 'tui-rtt-probe.mjs'], timeoutMs: 900_000 },
  // The unmeasured link chip, in the shape the field reported it: a parent that
  // relays stdin/stdout is the terminal, so it can stay silent — which is the one
  // thing a ConPTY cannot be made to do (`CSI 6n` is answered for the app there).
  // Both legs run: silent reads `未测`, answering reads a measurement.
  { id: 'unmeasured', label: 'pipe link-chip probe (unmeasured + measured)', command: 'node', args: ['scripts/probe-home.mjs', '--probe', '--script', 'tui-unmeasured-probe.mjs'], timeoutMs: 900_000 },
  { id: 'drop', label: 'pty drop probe', command: 'node', args: ['scripts/tui-drop-probe.mjs'], timeoutMs: 300_000, realProfile: true },
  { id: 'mock', label: 'pty mock-turn probe', command: 'node', args: ['scripts/tui-mock-probe.mjs'], timeoutMs: 300_000 },
  { id: 'route', label: 'pty session-route probe', command: 'node', args: ['scripts/tui-route-probe.mjs'], timeoutMs: 300_000 },
  // Both halves of the busy drop: the window closing under a running turn (the
  // promise the lifecycle spec makes about a closed terminal) and the launcher
  // crashing outright. On Windows the two are the same call — `scripts/pty-window.mjs`
  // — so the assertion there is the surviving Host, not the manner of death.
  { id: 'busy', label: 'pty busy-drop probe (window closed)', command: 'node', args: ['scripts/tui-mock-probe.mjs', '--busy'], timeoutMs: 300_000 },
  { id: 'busycrash', label: 'pty busy-drop probe (TUI crashed)', command: 'node', args: ['scripts/tui-mock-probe.mjs', '--busy', '--crash'], timeoutMs: 300_000 },
  { id: 'linemode', label: 'pty line-mode probe', command: 'node', args: ['scripts/tui-probe.mjs', '--line-mode'], timeoutMs: 300_000, realProfile: true },
  // Rendered footer frames: the escape-body leak of B-1 passed every unit test
  // (they fed the fitter unstyled chips) and was only visible on a frame.
  { id: 'footer', label: 'footer frame check', command: 'node', args: ['scripts/capture-footer-frames.mjs', '--check-only'], timeoutMs: 300_000 },
]

function runStep(step, probeHome) {
  return new Promise(resolve => {
    const started = Date.now()
    // `npm` is not an executable on Windows; resolve it rather than assume it.
    const invocation = step.command === 'npm'
      ? npmInvocation(step.args)
      : { command: step.command, args: step.args, shell: false }
    /**
     * The steps that read a *profile* rather than building one.
     *
     * Their default is the machine's own `~/.dsh`, which is the point — that is
     * the installation a reader has. Where that home cannot be probed at all (a
     * first run: the setup wizard owns the screen, so `/diag` and `/status` never
     * answer), `--home <dir>` points them at a home this repo built. Without it
     * the run closes `INCOMPLETE`, which is honest but not evidence.
     */
    const env = step.realProfile === true && probeHome !== undefined
      ? { ...process.env, PROBE_HOME: probeHome }
      : process.env
    const child = spawn(invocation.command, invocation.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: invocation.shell,
      env,
    })
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
  const parsed = { batch: undefined, only: undefined, home: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--batch') parsed.batch = argv[++index]
    else if (arg === '--only') parsed.only = argv[++index]?.split(',').filter(Boolean)
    else if (arg === '--home') parsed.home = argv[++index]
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/verify-batch.mjs [--batch A|B|C] [--home <dir>] [--only typecheck,test,probe,home,term,link,unmeasured,drop,mock,route,busy,busycrash,linemode,footer]')
      console.log('')
      console.log('  --home <dir>  point the *real profile* steps (probe, drop, linemode) at this')
      console.log('                DSH_HOME instead of the machine\'s own. Use it when that home is')
      console.log('                a first run — the setup wizard owns the screen there, so those')
      console.log('                steps skip and the run closes INCOMPLETE.')
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return parsed
}

const { batch, only, home: probeHome } = parseArgs(process.argv.slice(2))
const steps = only === undefined ? STEPS : STEPS.filter(step => only.includes(step.id))
if (steps.length === 0) {
  console.error(`no steps selected; known ids: ${STEPS.map(step => step.id).join(', ')}`)
  process.exit(2)
}

console.log(`acceptance evidence${batch === undefined ? '' : ` for batch ${batch}`} — ${revision()}`)
if (probeHome !== undefined) console.log(`real-profile steps are pointed at ${probeHome}`)
console.log('')

const results = []
for (const step of steps) {
  process.stdout.write(`${step.label} … `)
  const result = await runStep(step, probeHome)
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
if (skipped.length > 0) {
  // A skip is evidence of nothing. It used to close the run with `RESULT: PASS
  // (skipped: …)`, which reads as a pass with a footnote — and a footnote is
  // exactly how a gate stops being one. INCOMPLETE exits 2, between "everything
  // ran" and "something failed", so a batch cannot be quoted as accepted.
  console.error(`RESULT: INCOMPLETE — ${skipped.join(', ')} skipped, so this run is not evidence`)
  process.exit(2)
}
console.log('RESULT: PASS')
