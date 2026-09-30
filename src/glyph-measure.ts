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
 *
 * It touches the terminal as little as `probeTerminalRttMs` does — one write and
 * one listener, no raw mode, no `resume()`. That is not laziness: both of those
 * actions are visible to whatever else is driving the same pty, and the first
 * version of this probe broke the Windows terminal-capability leg by taking them.
 * A terminal that only answers a cursor request in raw mode simply answers
 * nothing here, and the caller keeps its locale-based default.
 *
 * @module dsh-ssh-tui/glyph-measure
 */
import process from 'node:process'

import { TerminalInputPump } from './terminal-input.js'

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

/**
 * Measure the ambiguous-glyph width on a real terminal.
 *
 * Returns `undefined` — never a guess — when there is no terminal, when it does
 * not answer, or when the answer matches neither expectation (a font with mixed
 * metrics: the caller then keeps its locale-based default rather than inventing a
 * table from one sample).
 *
 * The round trip goes through {@link TerminalInputPump.askPosition}, which
 * swallows the reply. That is not an implementation detail: a cursor reply that
 * nobody consumes is echoed on screen as literal `^[[1;5R` text, and a
 * hand-rolled version of this probe did exactly that at boot.
 * @param options - the streams (or a pump already running on them), the probe
 *   text, and the reply budget.
 * @returns what the terminal said, or undefined.
 */
export async function measureAmbiguousGlyphWidth(options: {
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  probe?: string
  timeoutMs?: number
  pump?: TerminalInputPump
} = {}): Promise<GlyphWidthMeasurement | undefined> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const probe = options.probe ?? GLYPH_PROBE_TEXT
  if (probe === '') return undefined
  if (options.pump === undefined && (stdin.isTTY !== true || stdout.isTTY !== true)) return undefined

  const count = [...probe].length
  const timeoutMs = options.timeoutMs ?? GLYPH_PROBE_TIMEOUT_MS
  const own = options.pump === undefined
  const pump = options.pump ?? new TerminalInputPump({ stdin, stdout, onInput: () => {} })
  if (own) pump.start()
  try {
    const reply = await pump.askPosition(probe, timeoutMs)
    if (reply === undefined) return undefined
    // The probe began at column 1 (the line was cleared first), so the column it
    // reports is one past the last cell the glyphs occupied.
    const cells = Math.max(0, reply.column - 1)
    if (cells === count) return { wide: false, cells }
    if (cells === count * 2) return { wide: true, cells }
    // A mixed-metric font: report nothing so the caller keeps its default.
    return undefined
  } finally {
    if (own) pump.stop()
  }
}
