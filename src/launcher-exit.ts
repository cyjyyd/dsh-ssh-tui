/**
 * The launcher's exit path: hand the terminal back, ask for a graceful
 * shutdown, and bound the wait for it.
 *
 * Two failures live here, both seen in the wild:
 *  - `quietTerminalInput()` (called on the way out to drain a cursor reply the
 *    probe is still owed) leaves raw mode ON, so a launcher that exits without
 *    `restoreTerminalInput()` gives the shell back with no echo and no line
 *    discipline — the user's typing vanishes and only dropping SSH helps;
 *  - `appExit` is a *graceful* shutdown (dispose the tree, set
 *    `process.exitCode`, wait for the event loop to drain), and a lingering
 *    handle (the profile patch watcher's inotify fd) can keep that drain from
 *    ever finishing, leaving the launcher alive in front of a shell that never
 *    gets its prompt back.
 */
import { restoreTerminalInput } from './display-sock.js'

/** Grace allowed to the launcher's graceful `appExit` before the process is forced out. */
export const EXIT_FALLBACK_MS = 2_000

export interface LauncherExitOptions {
  /** Resolves the host's graceful shutdown at exit time (it may be registered later). */
  appExit?: () => ((code: number) => void) | undefined
  /** Bound on the graceful drain; the TTY is already handed back when it fires. */
  fallbackMs?: number
  stdin?: NodeJS.ReadStream
  /** Process exit, injectable for tests. */
  force?: (code: number) => void
  /** Timer factory, injectable for tests. */
  schedule?: (handler: () => void, ms: number) => { unref?: () => void }
}

/**
 * Build the one function every launcher exit path calls. Esc from the picker,
 * a replaced window, `/exit`, and the error paths all funnel through it.
 */
export function createLauncherExit(options: LauncherExitOptions = {}): (code: number) => void {
  return (code: number): void => {
    restoreTerminalInput(options.stdin)
    const exit = options.appExit?.()
    if (exit === undefined) {
      ;(options.force ?? process.exit)(code)
      return
    }
    exit(code)
    const timer = (options.schedule ?? setTimeout)(() => {
      ;(options.force ?? process.exit)(code)
    }, options.fallbackMs ?? EXIT_FALLBACK_MS)
    // Never hold the process open by itself: the graceful path may still win.
    timer.unref?.()
  }
}
