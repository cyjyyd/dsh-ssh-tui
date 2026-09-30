/**
 * Ask the terminal how wide an ambiguous glyph actually is.
 *
 * `displayWidth` has to decide whether `①`, `—` and friends advance one cell or
 * two, and that depends on the terminal's font, not on any rule we can look up:
 * the same character is full width in a CJK configuration and narrow in a
 * Western one, and the locale is only a hint about which of those the user has.
 * Three rounds of "① is misaligned" reports came out of guessing.
 *
 * The terminal can answer directly. Print the glyphs on a clear line, ask for a
 * Device Status Report (`CSI 6n`), and read the column it reports: that column
 * *is* the width the terminal just spent. One round trip, and the answer applies
 * to every glyph in the probe.
 *
 * This is deliberately not built on {@link TerminalInputPump}: the pump counts
 * replies to time the link and keeps their contents to itself. Here the
 * coordinates are the whole point, so the reply is read straight from the stream.
 * The cursor request is only answered in raw mode — a canonical-mode terminal
 * would hold a reply with no newline in it forever — so raw mode is set for the
 * duration and restored exactly as it was found.
 *
 * @module dsh-ssh-tui/glyph-measure
 */
import process from 'node:process'

import { findCursorPositionReply } from './paint.js'

/**
 * The glyphs the probe prints.
 *
 * Drawn from the families {@link AMBIGUOUS_WIDE_RANGES} covers — an enclosed
 * digit, a dash, an ellipsis, a curly quote, a middle dot, a bullet, a roman
 * numeral. Mixing families is deliberate: a font may cover `①` from a fallback
 * face while treating `—` as typographic punctuation, and a single-glyph probe
 * would then decide the whole table from one sample. A terminal that treats the
 * ambiguous block as full width spends two cells on all seven.
 */
export const GLYPH_PROBE_TEXT = '①—…“”·•Ⅰ'

/** How long the terminal gets to answer the probe. */
const GLYPH_PROBE_TIMEOUT_MS = 400

export interface GlyphWidthMeasurement {
  /** True when the terminal spent two cells per probe glyph. */
  wide: boolean
  /** Cells the terminal reported for the whole probe string. */
  cells: number
}

/** The cursor request the probe ends with. */
const CURSOR_REQUEST = '\u001b[6n'

/** The sequence that returns the cursor to column 1 and clears the line. */
const CLEAR_LINE = '\r\u001b[2K'

/**
 * Measure the ambiguous-glyph width on a real terminal.
 *
 * Returns `undefined` — never a guess — when there is no terminal, when it does
 * not answer, or when the answer matches neither expectation (a font with mixed
 * metrics: the caller then keeps its locale-based default rather than inventing
 * a table from one sample).
 *
 * The probe line is cleared afterwards, so this may run while a boot splash is on
 * screen. It must not run while the TUI owns the screen: the caller decides when.
 * @param options - the streams, the probe text, and the reply budget.
 * @returns what the terminal said, or undefined.
 */
export async function measureAmbiguousGlyphWidth(options: {
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  probe?: string
  timeoutMs?: number
} = {}): Promise<GlyphWidthMeasurement | undefined> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const probe = options.probe ?? GLYPH_PROBE_TEXT
  if (probe === '') return undefined
  if (stdin.isTTY !== true || stdout.isTTY !== true) return undefined

  const count = [...probe].length
  const timeoutMs = options.timeoutMs ?? GLYPH_PROBE_TIMEOUT_MS
  const wasRaw = stdin.isRaw === true

  return await new Promise<GlyphWidthMeasurement | undefined>(resolve => {
    let settled = false
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const reply = findCursorPositionReply(text)
      if (reply === undefined) return
      // The probe began at column 1 (the line was cleared first), so the column
      // it reports is one past the last cell the glyphs occupied.
      const cells = Math.max(0, reply.column - 1)
      if (cells === count) settle({ wide: false, cells })
      else if (cells === count * 2) settle({ wide: true, cells })
      // A mixed-metric font: report nothing, so the caller keeps its default.
      else settle(undefined)
    }
    const cleanup = (): void => {
      stdin.removeListener('data', onData)
      if (!wasRaw) {
        try {
          stdin.setRawMode?.(false)
        } catch {
          // A terminal on its way out cannot be restored, and must not throw
          // into the boot path.
        }
      }
      try {
        stdout.write(CLEAR_LINE)
      } catch {
        // Same: the probe line is not worth a crash.
      }
    }
    const settle = (result: GlyphWidthMeasurement | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      resolve(result)
    }
    const timer = setTimeout(() => settle(undefined), timeoutMs)
    try {
      stdin.setRawMode?.(true)
      stdin.resume()
      stdin.on('data', onData)
      stdout.write(`${CLEAR_LINE}${probe}${CURSOR_REQUEST}`)
    } catch {
      settle(undefined)
    }
  })
}
