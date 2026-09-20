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
 *   3. `dsh plugin add link:<repo>` installs this checkout into the profile;
 *   4. the agent-preset roster is mounted (see `profile-rows.mjs`).
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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { mountProfileRows } from './profile-rows.mjs'

const require = createRequire(import.meta.url)
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')

const USAGE = `usage: node scripts/probe-home.mjs [--probe] [--keep] [--home <dir>] [--profile <name>] [-- <probe args>]

  --probe          run a PTY probe against the built home, then clean up
  --script <name>  which probe to run (default: tui-probe.mjs)
  --keep           keep the throwaway home (prints the path either way)
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
 * Create (or reuse) the home and return it.
 *
 * `--home` is for a caller that wants a stable path (the CI cache, or a human
 * poking at the result); otherwise a fresh temp directory is used so two runs
 * never share a session store.
 */
export function buildProbeHome({ home, profile = 'tui', repo = REPO, cli = CLI, log = console.log } = {}) {
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

  log(`==> installing ${repo} into profile '${profile}'`)
  run(process.execPath, [cli, 'plugin', '--profile', profile, 'add', `link:${repo}`], { env })
  mountProfileRows({ profile, home: target, cli, log })

  // A profile that composes but cannot boot is worse than no profile: fail here.
  run(process.execPath, [cli, '--profile', profile, '--dump-config'], { env, stdio: 'ignore' })
  log(`==> probe home ready: ${target}`)
  return target
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
  const home = buildProbeHome({ home: valueOf('--home'), profile: valueOf('--profile') ?? 'tui' })

  if (!runProbe) {
    console.log(`point a probe at it with: PROBE_HOME=${home} node scripts/tui-probe.mjs`)
    if (!keep) console.log('(it is left in place; pass --probe to run and clean up, or delete it yourself)')
    return 0
  }

  const script = valueOf('--script') ?? 'tui-probe.mjs'
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [join(REPO, 'scripts', script), ...probeArgs], {
      stdio: 'inherit',
      windowsHide: true,
      // A skipped probe is not coverage: the probe fails instead of skipping.
      env: { ...process.env, PROBE_HOME: home, PROBE_REQUIRE_PTY: '1' },
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
