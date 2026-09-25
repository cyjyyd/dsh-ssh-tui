#!/usr/bin/env node
/**
 * The small shared pieces of the install / verify / uninstall scripts.
 *
 * Those scripts used to be bash, which is why a Windows checkout could not run
 * them at all. The behaviour lives here, in Node, and the `.sh` files are thin
 * wrappers that hand off to it — so `bash scripts/install.sh` keeps working on
 * POSIX while `node scripts/install.mjs` works everywhere Node does.
 *
 * Nothing here imports the plugin: these run before `npm run build`, and a
 * missing `lib/` must not stop an install.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/** This repository, regardless of the caller's working directory. */
export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where dsh keeps its profiles.
 *
 * Read straight from the environment rather than through the plugin, because
 * these scripts run against a machine that may not have built it yet.
 * @param env - the environment to read.
 * @returns the home directory dsh is using.
 */
export function dshHome(env = process.env) {
  const fromEnv = (env.DSH_HOME ?? '').trim()
  if (fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * The profile a script should act on: the argument, else the environment, else
 * `tui` — the same order the bash scripts resolved it in.
 * @param argv - the script's own arguments.
 * @param envName - which variable carries the default.
 * @param fallback - the profile used when nothing else names one.
 * @returns the profile name.
 */
export function profileFromArgs(argv, envName = 'DSH_TUI_PROFILE', fallback = 'tui') {
  const named = argv.find(arg => arg !== '' && !arg.startsWith('-'))
  if (named !== undefined) return named
  const fromEnv = (process.env[envName] ?? '').trim()
  return fromEnv === '' ? fallback : fromEnv
}

/**
 * The dsh CLI to run.
 *
 * A global `dsh` is a `dsh.cmd` shim on Windows, and CreateProcess does not
 * apply `PATHEXT` to a bare name — which is the `spawn dsh ENOENT` users hit.
 * Re-running the CLI through our own Node binary and its entry script needs no
 * PATH lookup and no shell. A global install that is not a dependency of this
 * checkout falls back to the bare name, and only that fallback needs a shell.
 * @returns the command, the arguments that precede the subcommand, and whether
 *   a shell has to resolve it.
 */
export function resolveDsh() {
  // The checkout's own dependency first: `dsh plugin` installs into a profile,
  // and the CLI that does it is the one this repo was built against.
  for (const spec of ['@deepseek-ai/dsh/lib/bin.js']) {
    try {
      return { command: process.execPath, prefix: [require.resolve(spec)], shell: false }
    } catch {
      // Not installed here; keep looking.
    }
  }
  const entry = process.argv[1]
  if (typeof entry === 'string' && entry.endsWith(`${join('dsh', 'lib', 'bin.js')}`) && existsSync(entry)) {
    return { command: process.execPath, prefix: [entry], shell: false }
  }
  // A global install puts the entry next to a `dsh` / `dsh.cmd` shim somewhere
  // on PATH. Finding the script ourselves avoids the shell, and the `.cmd`.
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(dir => dir !== '')
  for (const dir of pathDirs) {
    const candidate = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(candidate)) return { command: process.execPath, prefix: [candidate], shell: false }
  }
  return { command: 'dsh', prefix: [], shell: process.platform === 'win32' }
}

/**
 * Run one command and return what it printed.
 *
 * `shell` is only set for the bare-name fallback above; everywhere else the
 * arguments reach the process untouched, so a path with spaces needs no
 * quoting. The window stays hidden on Windows.
 * @param command - the executable.
 * @param args - its arguments.
 * @param options - `shell`, `allowFailure`, `env`, `input`.
 * @returns the exit status and the combined output.
 */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    env: options.env ?? process.env,
    input: options.input,
    encoding: 'utf8',
    shell: options.shell === true,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.error !== undefined && options.allowFailure !== true) throw result.error
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const status = result.status ?? 1
  if (status !== 0 && options.allowFailure !== true) {
    const reason = result.error?.message ?? `exited ${status}`
    const detail = output.trim()
    throw new Error(`${command} ${args.join(' ')} ${reason}${detail === '' ? '' : `\n${detail}`}`)
  }
  return { status, output }
}

/** Print a step banner, matching the `==>` the bash scripts used. */
export function step(text) {
  console.log(`==> ${text}`)
}

/** Fail the script with a message on stderr and a non-zero status. */
export function fail(text) {
  console.error(`error: ${text}`)
  process.exit(1)
}

/**
 * Complain when dsh itself is not runnable, before a later step fails with a
 * stack trace that does not say what to install.
 * @param dsh - the resolved invocation.
 */
export function assertDsh(dsh = resolveDsh()) {
  if (dsh.prefix.length > 0) return dsh
  const probe = spawnSync(dsh.command, ['--version'], {
    shell: dsh.shell, windowsHide: true, stdio: 'ignore',
  })
  if (probe.error !== undefined || probe.status !== 0) {
    fail("'dsh' not found on PATH (install @deepseek-ai/dsh first)")
  }
  return dsh
}
