/**
 * How a terminal window dies — one place, so no two probes disagree about what
 * they are simulating.
 *
 * The lifecycle spec in `docs/platform.md` names four deaths, and the probes
 * only mean something if each one drives the *right* primitive. Two of them
 * happen to a TUI that is still running; this module owns those two.
 *
 *   closeWindow(term)  the **terminal** goes away: the user closed the window,
 *                      or the SSH link dropped under it. The process inside is
 *                      still alive and learns about it the way its platform
 *                      tells it to.
 *                        POSIX — the kernel sends SIGHUP to the foreground
 *                        process group when the controlling terminal goes away.
 *                        `term.kill('SIGHUP')` delivers exactly that signal to
 *                        the launcher; destroying the master fd as well would
 *                        take away the output the probe still has to assert on,
 *                        and the launcher's stdin EOF is the *other* half of the
 *                        same hangup, already covered by
 *                        `tests/terminal-input.test.mjs`.
 *                        Windows — there is no signal to send: node-pty rejects
 *                        `kill('SIGHUP')` outright ("Signals not supported on
 *                        windows."). Closing a console window tears the ConPTY
 *                        down instead, which is precisely what `term.kill()`
 *                        does here (ClosePseudoConsole), so that is the faithful
 *                        call. Every process attached to the closed console gets
 *                        the console-close event; a process with its own console
 *                        — the Host, spawned with `windowsHide` — does not, and
 *                        that asymmetry is the promise the busy-drop probe
 *                        asserts on real Windows.
 *   crashWindow(term)  the **TUI process** dies without unwinding anything: no
 *                      goodbye, no terminal restore, no chance to update the
 *                      lock. POSIX delivers SIGKILL; Windows has no signals, so
 *                      it is the same `term.kill()` (TerminateProcess) as above.
 *                      That is why the Windows leg asserts the *surviving-Host*
 *                      promise rather than which of the two deaths happened —
 *                      the platform cannot express the difference.
 *
 * The third and fourth deaths belong to the other side and are driven by pid
 * instead: a launcher that dies mid-turn is `crashWindow`, and a Host that dies
 * is `process.kill(<lock pid>, 'SIGKILL')` (on Windows Node maps that to
 * TerminateProcess; `session-lock.ts` is what decides a pid is really gone).
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// `import()` needs a URL: on Windows `D:\…` is rejected with
// ERR_UNSUPPORTED_ESM_URL_SCHEME, the failure the first Windows CI run hit.
const { IS_WINDOWS } = await import(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../lib/platform.js')).href,
)

/** The terminal is gone; the TUI inside is still alive and must survive it. */
export function closeWindow(term) {
  if (IS_WINDOWS) term.kill()
  else term.kill('SIGHUP')
}

/** The TUI process dies abruptly: no goodbye, no restore, no lock update. */
export function crashWindow(term) {
  if (IS_WINDOWS) term.kill()
  else term.kill('SIGKILL')
}

/** One line for the probe log, so a CI run says which death it drove. */
export function windowDeathNote(kind) {
  if (IS_WINDOWS) {
    return kind === 'close'
      ? 'window closed: ConPTY torn down (no signals on Windows; the console-close event is the hangup)'
      : 'TUI crash: TerminateProcess (Windows has no SIGKILL; same call as a window close)'
  }
  return kind === 'close'
    ? 'window closed: SIGHUP to the launcher (the kernel hangup when the terminal goes away)'
    : 'TUI crash: SIGKILL to the launcher (no goodbye, no restore)'
}

/** True when the platform can express "window closed" differently from "crashed". */
export const WINDOW_DEATHS_DIFFER = !IS_WINDOWS

/**
 * Re-exported so the probes never write a raw `process.platform` comparison:
 * `src/platform.ts` is the one decision point, and a script that branches on
 * the platform is exactly where the two halves drift apart unnoticed.
 */
export { IS_WINDOWS }
