#!/usr/bin/env node
/**
 * Build a throwaway `DSH_HOME` with a working `tui` profile, so the PTY probes
 * can run where no profile exists — CI, most obviously, and a fresh machine.
 *
 * Why this exists: every PTY probe (`tui-probe`, `tui-drop-probe`, …) drives the
 * real TUI, which needs a real profile tree. Locally that was the developer's own
 * `~/.dsh`, which is why the probes never ran in CI: the runners have no profile,
 * and building one was a bash-script-only path (`scripts/install.sh`). Windows
 * made that gap expensive — the Windows leg ran unit tests only, so every
 * Windows lifecycle bug was found by hand.
 *
 * This does the same steps in Node, on either platform:
 *
 *   1. `--from-default-profile headless` scaffolds a profile tree;
 *   2. the headless app is dropped from its bundle list (the TUI replaces it);
 *   3. `dsh plugin add <package>` installs this checkout into the profile;
 *   4. a configured probe runs one real TUI boot to let the product repair the
 *      profile, exits, and starts the actual probe on that restart.
 *
 * It deliberately does **not** pre-fill the agent-plane rows. That is the
 * product's first-run repair's job, and a helper that writes them before the
 * TUI boots would make the first-install gate green over the exact defect it
 * exists to catch. Step 4 is a product boot, not a file write.
 *
 * Usage:
 *   node scripts/probe-home.mjs                 # build a home, print its path
 *   node scripts/probe-home.mjs --probe         # build, run tui-probe.mjs, clean up
 *   node scripts/probe-home.mjs --probe -- --line-mode   # extra probe arguments
 *   node scripts/probe-home.mjs --probe --script tui-drop-probe.mjs
 *   node scripts/probe-home.mjs --keep          # keep the home for inspection
 *   node scripts/probe-home.mjs --home <dir>    # build at a fixed path
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')

/**
 * The last machine-readable verdict the prime boot printed.
 *
 * The prime's exit code alone is not enough: a normal developer machine may
 * intentionally `SKIP` when node-pty is absent, and that still exits 0. The
 * outer bootstrap must see the verdict so it cannot run the actual probe over
 * an uncompleted restart.
 * @param output - the captured stdout/stderr of the prime process.
 * @returns the final `OK` / `SKIP` / `FAIL` marker, or `NONE`.
 */
export function parsePrimeVerdict(output) {
  const matches = [...String(output).matchAll(/^PRIME: (OK|SKIP|FAIL)\b(.*)$/gmu)]
  const last = matches.at(-1)
  return last === undefined
    ? { kind: 'NONE', detail: '' }
    : { kind: last[1], detail: String(last[2] ?? '').trim() }
}

/**
 * Decide whether the actual probe may start after the prime boot.
 *
 * `OK` requires both the marker and exit 0. `SKIP` is still a skip on a normal
 * developer machine (a distinct exit code, never a pass), but a forced CI run
 * turns it into a failure. `FAIL` and a missing marker always fail. In every
 * non-OK case the caller must not start the actual probe.
 * @param options - prime exit code, captured output, and CI enforcement flag.
 * @returns whether to continue, the process code, and the reason.
 */
export function primeGate({ exitCode, output, required = false }) {
  const verdict = parsePrimeVerdict(output)
  if (verdict.kind === 'OK' && exitCode === 0) {
    return { ok: true, continue: true, code: 0, kind: 'OK', reason: verdict.detail }
  }
  const reason = verdict.kind === 'NONE'
    ? `the prime printed no PRIME: verdict (exit ${exitCode})`
    : `the prime reported ${verdict.kind}${verdict.detail === '' ? '' : `: ${verdict.detail}`} (exit ${exitCode})`
  if (verdict.kind === 'SKIP' && !required) {
    return { ok: false, continue: false, code: 2, kind: 'SKIP', reason }
  }
  return {
    ok: false,
    continue: false,
    code: 1,
    kind: required && verdict.kind === 'SKIP' ? 'FAIL' : verdict.kind,
    reason,
  }
}

/**
 * Run the prime boot and return its parsed verdict.
 *
 * Exported with an injectable spawn so the negative test can prove a skipped
 * prime is gated out without building a profile or starting a real TUI.
 * @param options - configured home, CI enforcement, and an optional spawn seam.
 * @returns the same gate the caller uses to decide whether the probe may start.
 */
export async function runPrimeProbe({ home, required = false, spawnPrime = spawn }) {
  let output = ''
  const result = await new Promise(resolve => {
    const prime = spawnPrime(process.execPath, [join(REPO, 'scripts/tui-prime-probe.mjs')], {
      // Capture as well as show: the marker is the verdict, not the exit code.
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PROBE_HOME: home, PROBE_REQUIRE_PRIME: required ? '1' : '0' },
    })
    prime.stdout?.on('data', chunk => {
      process.stdout.write(chunk)
      output += chunk
    })
    prime.stderr?.on('data', chunk => {
      process.stderr.write(chunk)
      output += chunk
    })
    prime.on('error', () => resolve({ code: 1, output }))
    prime.on('exit', value => resolve({ code: value ?? 1, output }))
  })
  return primeGate({ exitCode: result.code, output: result.output, required })
}

const USAGE = `usage: node scripts/probe-home.mjs [--probe] [--keep] [--home <dir>] [--profile <name>]
                                    [--pack | --tarball <tgz>] [-- <probe args>]

  --probe          run a PTY probe against the built home, then clean up
  --script <name>  which probe to run (default: tui-probe.mjs)
  --keep           keep the throwaway home (prints the path either way)
                   A configured probe first runs the real TUI once (the prime
                   restart). A prime SKIP reports untested and exits 2; with
                   CI/PROBE_REQUIRE_PRIME=1 it is a failure and exits 1.
  --unconfigured   leave the home without a credential, so the boot is a first run
                   (the setup wizard is what boots; use it with tui-setup-probe.mjs).
                   A probe run this way is told the wizard is *required*: a home this
                   script built unconfigured that boots straight to the workspace is the
                   0.8.1 first-run defect, not a skip.
  --pack           \`npm pack\` this checkout and install the tarball, not \`link:\`
  --tarball <tgz>  install this tarball instead of linking the checkout
  --home <dir>     build at this path instead of a fresh temp directory
  --profile <name> profile to build (default: tui)
  --               everything after this reaches the probe`

/** Run one step, inheriting the console, and fail the bootstrap if it fails. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? 'no status'}`)
  }
  return result.status ?? 1
}

/**
 * Write the credential a real user would have after finishing the wizard.
 *
 * The PTY probes drive the *workspace*: `/diag`, `/status`, a report Screen, a
 * menu. None of that is what a home with no provider shows — since 0.8.2 a home
 * with nothing configured boots into the **setup wizard** (that is the fix for a
 * bug that made the wizard unreachable: `hostArgvForSession` spawns the Host with
 * `--resume=<id>` even for a brand-new id, and the first-run guard read that flag
 * as "already configured"). These probes were only ever green because of that bug.
 *
 * The key is a placeholder on purpose. It exists so the *decision* ("is anything
 * configured?") is yes, exactly as it is on a machine that has been set up once;
 * a turn that reaches a provider with it fails, which is the same shape the probes
 * already ran against (they never had a working key either — `--dump-config` and
 * the boot path do not need one).
 *
 * `--unconfigured` skips this step, which is what `tui-setup-probe.mjs` needs.
 */
export function provisionProbeCredential({ home, profile = 'tui', cli = CLI, log = console.log }) {
  const env = { ...process.env, DSH_HOME: home, DSH_TUI_NO_UPDATE_CHECK: '1' }
  // Which ref? The one the plugin computes from the profile's route, so a home
  // pinned to a gateway (this repo's own tui patch names `command-code`) gets its
  // own variable rather than a DeepSeek one it would never read.
  const dumped = spawnSync(process.execPath, [cli, '--profile', profile, '--dump-config'], {
    env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  })
  const text = String(dumped.stdout ?? '')
  const route = /- id: agent-default-model[\s\S]{0,400}?provider:\s*([\w.-]+)/u.exec(text)?.[1] ?? 'deepseek-official'
  const ref = route === 'deepseek-official'
    ? 'DEEPSEEK_API_KEY'
    : `${route.replaceAll('-', '_').toUpperCase()}_API_KEY`
  const file = join(home, '.credentials.yaml')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (!new RegExp(`^${ref}\\s*:`, 'mu').test(existing)) {
    writeFileSync(file, `${existing}${ref}: probe-placeholder-not-a-real-key\n`, { mode: 0o600 })
  }
  // The store refuses a document the group can read, so the mode has to be right
  // even when the file already existed with a wider one. POSIX only: on Windows the
  // mode is not what protects the file (ACLs are, and the store's own check is
  // POSIX-only), and `chmodSync` there is at best a no-op.
  if (process.platform !== 'win32') chmodSync(file, 0o600)
  log(`==> provisioned ${ref} (placeholder) so the probe home boots configured`)
  return ref
}

/**
 * Create (or reuse) the home and return it.
 *
 * `--home` is for a caller that wants a stable path (the CI cache, or a human
 * poking at the result); otherwise a fresh temp directory is used so two runs
 * never share a session store.
 */
export function buildProbeHome({
  home,
  profile = 'tui',
  repo = REPO,
  cli = CLI,
  log = console.log,
  credential = true,
  tarball,
} = {}) {
  const target = home ?? mkdtempSync(join(tmpdir(), 'dsh-probe-home-'))
  const env = { ...process.env, DSH_HOME: target, DSH_TUI_NO_UPDATE_CHECK: '1' }
  log(`==> building a probe home at ${target}`)

  // `--help` is deliberate: it scaffolds the profile and exits 0, where booting
  // the template app would ask for a task and fail after scaffolding anyway.
  run(process.execPath, [cli, '--profile', profile, '--from-default-profile', 'headless', '--help'], { env })

  const packageFile = join(target, 'profiles', profile, 'package.json')
  if (!existsSync(packageFile)) {
    throw new Error(`the profile was not scaffolded: ${packageFile} is missing`)
  }
  const manifest = JSON.parse(readFileSync(packageFile, 'utf8'))
  const bundles = manifest?.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    // The template's own app must go: the TUI is the app this profile boots.
    manifest.dsh.profile.bundles = bundles.filter(name => name !== '@deepseek-ai/dsh-headless')
    writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  // Two ways in, and they are not the same evidence. `link:` runs the checkout — the
  // source tree, with its `src/`, tests and build inputs — while a tarball runs exactly
  // what `npm publish` would upload. A gate about "does a real user's install work" has
  // to take the second one (`scripts/artifact-smoke.mjs`); the link stays the default
  // for every other probe because it needs no pack step and picks up local edits.
  const spec = tarball === undefined ? `link:${repo}` : `file:${resolve(tarball)}`
  log(`==> installing ${spec} into profile '${profile}'`)
  run(process.execPath, [cli, 'plugin', '--profile', profile, 'add', spec], { env })

  // No `mountProfileRows` here. This is the real first-install shape: the TUI
  // boots without the agent-plane rows and repairs them for the next launch.

  // A profile that composes but cannot boot is worse than no profile: fail here.
  run(process.execPath, [cli, '--profile', profile, '--dump-config'], { env, stdio: 'ignore' })
  if (credential) provisionProbeCredential({ home: target, profile, cli, log })
  else log('==> left unconfigured (--unconfigured): the boot is a first run')
  log(`==> probe home ready: ${target}`)
  return target
}

/**
 * `npm pack` this checkout into a temp directory and return the tarball path.
 *
 * The cache directory is passed explicitly: a sandbox whose shared npm cache is
 * read-only fails `npm pack` before it writes anything, and the failure reads like a
 * packaging defect. `.npm-cache-tmp` is this repo's own writable cache (git-ignored),
 * and on a normal machine it is simply where the pack logs go.
 */
export function packCheckout({ repo = REPO, log = console.log } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pack-'))
  const status = run('npm', ['pack', '--pack-destination', dir, '--cache', join(repo, '.npm-cache-tmp'), '--silent'], {
    cwd: repo,
    stdio: 'pipe',
    encoding: 'utf8',
    // `npm` is a `.cmd` shim on Windows: without a shell it cannot be spawned at all
    // (`status === null`, which reads like a packaging failure).
    shell: process.platform === 'win32',
  })
  if (status !== 0) throw new Error(`npm pack exited with ${status}`)
  const tarball = readdirSync(dir).find(name => name.endsWith('.tgz'))
  if (tarball === undefined) throw new Error(`npm pack left no tarball in ${dir}`)
  log(`==> packed ${join(dir, tarball)}`)
  return join(dir, tarball)
}

/** Kill whatever host the probe left behind, then drop the home. */
function discardHome(home, log = console.log) {
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 })
    log(`==> removed ${home}`)
  } catch (error) {
    // A leftover Host can hold files on Windows; a dirty temp dir is not a
    // probe failure, so say so and move on.
    log(`==> could not remove ${home}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function main(argv) {
  const probeAt = argv.indexOf('--')
  const probeArgs = probeAt === -1 ? [] : argv.slice(probeAt + 1)
  const own = probeAt === -1 ? argv : argv.slice(0, probeAt)
  const keep = own.includes('--keep')
  const runProbe = own.includes('--probe')
  const valueOf = (flag) => {
    const at = own.indexOf(flag)
    return at === -1 ? undefined : own[at + 1]
  }
  if (own.includes('--help') || own.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  const tarballFlag = valueOf('--tarball')
  // `--pack` is the CI-shaped shorthand: this checkout, packed the way `npm publish`
  // would, installed into the throwaway home. The pack itself is `artifact-smoke.mjs`'s
  // job to *verify*; here it only has to produce the artifact.
  const tarball = tarballFlag ?? (own.includes('--pack') ? packCheckout() : undefined)
  if (tarball !== undefined) console.log(`==> tarball: ${tarball}`)
  const home = buildProbeHome({
    home: valueOf('--home'),
    profile: valueOf('--profile') ?? 'tui',
    credential: !own.includes('--unconfigured'),
    tarball,
  })

  if (!runProbe) {
    console.log(`point a probe at it with: PROBE_HOME=${home} node scripts/tui-probe.mjs`)
    if (!keep) console.log('(it is left in place; pass --probe to run and clean up, or delete it yourself)')
    return 0
  }

  const script = valueOf('--script') ?? 'tui-probe.mjs'
  // The product repairs the profile on its first boot; the probe must start on
  // the restart, not in the middle of that repair (the same restart a user is
  // told to make). This is a real TUI boot, not a test-side pre-fill. The
  // unconfigured path and the wizard probe own their own first run.
  if (!own.includes('--unconfigured') && script !== 'tui-setup-probe.mjs') {
    const requirePrime = process.env.PROBE_REQUIRE_PRIME === '1'
      || process.env.CI === 'true'
      || process.env.CI === '1'
    const gate = await runPrimeProbe({ home, required: requirePrime })
    if (!gate.ok) {
      if (gate.code === 2) {
        console.log(`SKIP: ${gate.reason}; the actual probe was not run (untested)`)
      } else {
        console.error(`FAIL: prime boot did not complete: ${gate.reason}; the actual probe was not run`)
      }
      if (!keep) discardHome(home)
      else console.log(`==> kept ${home}`)
      return gate.code
    }
  }
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [join(REPO, 'scripts', script), ...probeArgs], {
      stdio: 'inherit',
      windowsHide: true,
      // A skipped probe is not coverage: the probe fails instead of skipping. The
      // wizard is *required* on a home this script built unconfigured — "already
      // configured" there would mean the first run was skipped, which is the 0.8.1
      // defect this probe exists for.
      env: {
        ...process.env,
        PROBE_HOME: home,
        PROBE_REQUIRE_PTY: '1',
        ...(own.includes('--unconfigured') ? { PROBE_REQUIRE_WIZARD: '1' } : {}),
      },
    })
    child.on('error', () => resolve(1))
    child.on('exit', value => resolve(value ?? 1))
  })

  if (!keep) discardHome(home)
  else console.log(`==> kept ${home}`)
  return code
}

if (process.argv[1] !== undefined && import.meta.url.startsWith('file:')) {
  const { pathToFileURL } = await import('node:url')
  if (pathToFileURL(process.argv[1]).href === import.meta.url) {
    process.exitCode = await main(process.argv.slice(2))
  }
}
