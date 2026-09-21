/**
 * The one place that branches on the operating system.
 *
 * Everything else in `src/` takes the decision as a parameter (or imports it
 * from here), because a raw `process.platform` comparison buried in feature code
 * is a Windows bug nobody runs until a user does. That is not hypothetical: a
 * bare `spawn('dsh')` could not resolve a `.cmd` shim, an unset `TERM` read as
 * "no terminal", and `detached: true` (DETACHED_PROCESS) silently disabled
 * `windowsHide` so every tool call flashed a console window. Each was one line
 * that no Linux test ever executed.
 *
 * `tests/platform-guards.test.mjs` scans for the banned shape — a `process.platform`
 * *comparison* outside this file — so the next one fails in review rather than on
 * a desktop.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** This process is running on Windows. */
export const IS_WINDOWS = process.platform === 'win32'

/** Windows delivers resizes on the stream; everyone else raises SIGWINCH. */
export function usesSigwinch(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

/** The launcher's environment file: a shell fragment or a `cmd` script. */
export function envFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'env.cmd' : 'env.sh'
}

/** The shell a Windows user has: PowerShell, where POSIX code would say bash. */
export function shellName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'PowerShell' : 'bash'
}

/**
 * Whether lock liveness is decided by asking the OS about the process (Windows:
 * `Get-Process` + creation time) rather than by reading `/proc` (Linux) or the
 * command line (darwin).
 *
 * `lockOwnerIsAlive` returns early into `windowsProcessMatchesLock` when this is
 * true; the POSIX body below it has no meaning there (`/proc` does not exist).
 */
export function usesProcessIdentity(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

/**
 * How to start the background Host so it outlives this process *and* does not
 * make its own children flash console windows on Windows.
 *
 * POSIX wants `detached: true` (setsid) so the Host survives the launcher and a
 * hung-up terminal.
 *
 * Windows is the opposite: `detached: true` maps to DETACHED_PROCESS, which
 * gives the Host **no console at all**, and Windows ignores CREATE_NO_WINDOW
 * (what `windowsHide` sets) when DETACHED_PROCESS is present. Every console
 * child the Host then starts — each tool call, every shell, node, git — has to
 * allocate its own console, which is a visible window flashing over the TUI.
 * Dropping `detached` there lets `windowsHide` do its job: the Host gets its
 * own invisible console, and descendants inherit it instead of creating one.
 * The Host still outlives the launcher: Windows does not kill children with
 * their parent, and its console is its own, so closing the user's terminal does
 * not reach it either.
 */
export function hostSpawnOptions(platform: NodeJS.Platform = process.platform): {
  detached: boolean
  windowsHide: boolean
} {
  const windows = platform === 'win32'
  return { detached: !windows, windowsHide: true }
}

/**
 * A path a human can read, with the platform's own shorthand.
 *
 * `~/.dsh/env.sh` is the POSIX form; Windows users know `%USERPROFILE%`, and a
 * `C:\Users\...` prefix spelled out is noise in a one-line hint.
 */
export function displayHomePath(
  home: string,
  file: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; userHome?: string } = {},
): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (platform === 'win32') {
    const profile = env.USERPROFILE
    if (profile !== undefined && profile !== '' && home.toLowerCase().startsWith(profile.toLowerCase())) {
      return `%USERPROFILE%${home.slice(profile.length)}\\${file}`.replaceAll('/', '\\')
    }
    return `${home}\\${file}`.replaceAll('/', '\\')
  }
  const userHome = options.userHome ?? homedir()
  if (home === userHome) return `~/.dsh/${file}`
  if (home.startsWith(`${userHome}/`)) return `~/${home.slice(userHome.length + 1)}/${file}`
  return join(home, file)
}

/**
 * Who owns the files this plugin writes, and how to keep it that way.
 *
 * On POSIX the `mode` passed to `writeFile`/`mkdir` (`0o600`, `0o700`) is the
 * whole story. **On Windows it is silently ignored**, and the files that matter
 * here are not cosmetic: `env.cmd` carries API keys, the SuperGrok token file
 * carries an OAuth grant, and the lock/socket directories carry session
 * metadata. What they get instead is the ACL inherited from their parent — fine
 * under `%USERPROFILE%\.dsh`, and *not* fine when `DSH_HOME` points somewhere
 * shared (`C:\dsh`, a network share, a machine where `Users` can read the
 * directory), which is exactly when nobody notices.
 *
 * So the intent is applied explicitly: `icacls` with inheritance removed and a
 * single grant to the current user. The argv is built by a pure function so it
 * can be asserted on Linux; applying it is best-effort by design — a machine
 * without `icacls`, or a path held open by another process, must not fail the
 * write that just succeeded. Failing closed here would mean a TUI that cannot
 * save its own settings.
 */

/** The user `icacls` should grant, or undefined when the environment has none. */
export function aclUserName(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') return undefined
  for (const key of ['USERNAME', 'USER']) {
    const value = (env[key] ?? '').trim()
    if (value !== '') return value
  }
  return undefined
}

/**
 * The exact `icacls` arguments for one path.
 *
 * `/inheritance:r` drops what the parent offered (this is the part that matters:
 * adding a grant without removing inheritance leaves `Users` in place), and
 * `(OI)(CI)` makes a directory's grant apply to what is created inside it —
 * without it every new lock file would need its own call.
 */
export function restrictPathArgs(path: string, user: string, options: { directory?: boolean } = {}): string[] {
  const grant = options.directory === true ? `${user}:(OI)(CI)F` : `${user}:F`
  return [path, '/inheritance:r', '/grant:r', grant]
}

/** Directories and files whose contents must not be readable by other users. */
export interface RestrictDeps {
  /** Runner for `icacls`; injected by tests. Returns true on success. */
  run?: (command: string, args: string[]) => boolean
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

/**
 * Apply `mode` on POSIX, a single-user ACL on Windows.
 *
 * Returns whether the restriction was applied. Never throws: the caller has
 * already written the file, and a permission call is not worth losing it over.
 */
export async function restrictPathToUser(
  path: string,
  options: { mode: number; directory?: boolean } & RestrictDeps = { mode: 0o600 },
): Promise<boolean> {
  const platform = options.platform ?? process.platform
  try {
    if (platform !== 'win32') {
      const { chmod } = await import('node:fs/promises')
      await chmod(path, options.mode)
      return true
    }
    const user = aclUserName(options.env, platform)
    if (user === undefined) return false
    const args = restrictPathArgs(path, user, { directory: options.directory === true })
    if (options.run !== undefined) return options.run('icacls', args)
    return await runIcaclsAsync('icacls', args)
  } catch {
    return false
  }
}

/** Synchronous twin, for the sites that create their file with `openSync`. */
export function restrictPathToUserSync(
  path: string,
  options: { mode: number; directory?: boolean } & RestrictDeps = { mode: 0o600 },
): boolean {
  const platform = options.platform ?? process.platform
  try {
    if (platform !== 'win32') {
      chmodSync(path, options.mode)
      return true
    }
    const user = aclUserName(options.env, platform)
    if (user === undefined) return false
    const run = options.run ?? runIcaclsSync
    return run('icacls', restrictPathArgs(path, user, { directory: options.directory === true }))
  } catch {
    return false
  }
}

/** `icacls`, synchronously, with a hidden window and a short leash. */
function runIcaclsSync(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { stdio: 'ignore', windowsHide: true, timeout: 5_000 })
  return result.status === 0
}

/** Async form, so a slow `icacls` never blocks a paint. */
function runIcaclsAsync(command: string, args: string[]): Promise<boolean> {
  return import('node:child_process').then(({ spawn }) => new Promise<boolean>(resolve => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
      const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } resolve(false) }, 5_000)
      child.on('error', () => { clearTimeout(timer); resolve(false) })
      child.on('exit', code => { clearTimeout(timer); resolve(code === 0) })
    } catch {
      resolve(false)
    }
  }))
}
