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
