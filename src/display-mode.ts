/**
 * Where the TUI's bytes go when the parent is not a terminal.
 *
 * The plugin paints through a display relay, and a relay normally *is* a
 * terminal: it writes ANSI to stdout, listens for `resize`, and puts stdin in raw
 * mode. A GUI, a browser terminal or a test harness has none of those, but it can
 * provide the same three things over pipes — bytes in, bytes out, and a size it
 * reports as a protocol frame. This module is the switch that says "the parent is
 * such a relay, do not require a TTY".
 *
 * Two entries, one mechanism and one sugar (as chosen when the mode was
 * designed):
 *
 *  - `DSH_TUI_DISPLAY=stdio` in the environment — the mechanism. Setting it *is*
 *    the parent's statement that it is a relay, so it is also what the no-TTY
 *    guard consults.
 *  - `--display stdio` on the command line — the sugar, declared in the profile's
 *    own grammar so it shows up in `--help` and a typo is an error rather than a
 *    silently inert plugin.
 *
 * @module dsh-ssh-tui/display-mode
 */

/** The environment variable that selects the display mode. */
export const DISPLAY_MODE_ENV = 'DSH_TUI_DISPLAY'

/**
 * `tty` is the default: paint to the process's own terminal. `stdio` means the
 * parent speaks the display protocol on stdin/stdout.
 */
export type DisplayMode = 'tty' | 'stdio'

/** A mode request, and what to say when the value was not one of the two. */
export interface DisplayRequest {
  mode?: DisplayMode
  /** The unrecognized value, when one was given. */
  invalid?: string
}

/**
 * Parse one mode word.
 * @param value - a value from the environment or a flag.
 * @returns the mode, or undefined for anything else (the caller reports it).
 */
export function parseDisplayMode(value: string | undefined): DisplayMode | undefined {
  const raw = String(value ?? '').trim().toLowerCase()
  return raw === 'stdio' || raw === 'tty' ? raw : undefined
}

/**
 * The `--display <mode>` value in an argument vector.
 *
 * Accepts both spellings a person may type (`--display stdio`,
 * `--display=stdio`) and only ever reads the pair it owns — everything else is
 * left where it is, because the same vector is parsed by the profile's own
 * grammar and by the host.
 * @param argv - an argument vector (defaults to this process's).
 * @returns the value found, if any.
 */
export function displayModeFromArgv(argv: readonly string[] = process.argv): string | undefined {
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] ?? ''
    if (arg.startsWith('--display=')) return arg.slice('--display='.length)
    if (arg === '--display') {
      const next = argv[at + 1]
      // A missing value is not silently "the default": leave it to the grammar,
      // which turns it into a usage error.
      return next === undefined || next.startsWith('-') ? '' : next
    }
  }
  return undefined
}

/**
 * Resolve the mode request from the environment and the command line.
 *
 * The environment wins when both are present: it is the mechanism, and a parent
 * that sets it is describing the channel it is about to speak on, whereas a flag
 * is a convenience the reader may have left in a wrapper script.
 * @param env - the environment to read.
 * @param argv - the argument vector to read.
 * @returns the requested mode, plus the offending value when one was useless.
 */
export function requestedDisplayMode(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): DisplayRequest {
  const fromEnv = env[DISPLAY_MODE_ENV]
  if (fromEnv !== undefined && String(fromEnv).trim() !== '') {
    const mode = parseDisplayMode(fromEnv)
    return mode === undefined ? { invalid: String(fromEnv).trim() } : { mode }
  }
  const fromArgv = displayModeFromArgv(argv)
  if (fromArgv === undefined || fromArgv === '') return {}
  const mode = parseDisplayMode(fromArgv)
  return mode === undefined ? { invalid: fromArgv } : { mode }
}

/**
 * A window-size report: `CSI 8 ; rows ; cols t`.
 *
 * This is the sequence a terminal sends when it is asked for its size, and it is
 * also how a pipe parent says "the panel is now this big". A pipe has no
 * `resize` event and no SIGWINCH, so without this the embedder's only way to
 * resize the TUI would be to restart it.
 */
export const WINDOW_SIZE_REPORT = /\u001b\[8;(\d+);(\d+)t/gu

/** A size a parent declared: columns first, the way the rest of the code wants it. */
export interface ParentResize {
  columns: number
  rows: number
}

/** Longest run that can still grow into a window-size report. */
const PARTIAL_REPORT_MAX = 16

/** `ESC`, `ESC [`, `ESC [ 8`, `ESC [ 8 ; 24`, … — but not a finished report. */
const PARTIAL_REPORT = /^\u001b(?:\[(?:8(?:;(?:\d*(?:;\d*)?)?)?)?)?$/u

/**
 * Split a parent's input into keystrokes and size reports.
 *
 * A report can arrive split across two reads (`ESC [ 8 ; 2` then `4 ; 80 t`),
 * and forwarding half of it as typing would send escape bytes to the model's
 * prompt. The tail is held until the next read, exactly like the cursor-reply
 * filter holds a half-arrived reply — with the same deadline that filter gets:
 * a lone `ESC` matches the prefix, and the byte after it may never come, so a
 * caller that forwards typing **must** release a {@link pending} run when its
 * window passes (`flush()`). Waiting for the next read instead swallows the
 * user's Escape key, and delivers it glued to whatever key follows as an Alt
 * chord. `TerminalInputGuard` is the same filter with that timer attached.
 * @returns a filter for one input stream.
 */
export function createParentResizeFilter(): {
  push(text: string): { forward: string; sizes: ParentResize[] }
  flush(): string
  readonly pending: boolean
} {
  let held = ''
  return {
    push(text: string) {
      const sizes: ParentResize[] = []
      const combined = held + text
      held = ''
      let forward = ''
      let cursor = 0
      for (const match of combined.matchAll(WINDOW_SIZE_REPORT)) {
        const at = match.index ?? 0
        forward += combined.slice(cursor, at)
        cursor = at + match[0].length
        // `CSI 8 ; rows ; cols t`: rows is the first number, columns the second.
        const rows = Number(match[1])
        const columns = Number(match[2])
        // A zero dimension is a malformed report, not a request to hide the TUI.
        if (rows > 0 && columns > 0) sizes.push({ columns, rows })
      }
      const rest = combined.slice(cursor)
      // Only the run from the last ESC can still grow into a report; everything
      // before it is typing this read already settled.
      const escapeAt = rest.lastIndexOf('\u001b')
      const candidate = escapeAt === -1 ? '' : rest.slice(escapeAt)
      const tail = candidate.length <= PARTIAL_REPORT_MAX && PARTIAL_REPORT.test(candidate) ? candidate : ''
      held = tail
      return { forward: forward + rest.slice(0, rest.length - tail.length), sizes }
    },
    flush() {
      const tail = held
      held = ''
      return tail
    },
    /** Is a run held that could still grow into a report? */
    get pending(): boolean {
      return held !== ''
    },
  }
}
