#!/usr/bin/env node
/**
 * Print what this terminal does with the ambiguous glyphs.
 *
 * The same measurement the display relay runs at attach, exposed for a human:
 * run it *in the terminal you use the TUI in*, and it prints the verdict — how
 * many cells the terminal advances for `①—…“”·•Ⅰ`, and therefore whether the TUI
 * will reserve a second cell.
 *
 *     node scripts/glyph-width-probe.mjs
 *
 * Exit code is 0 either way: "the terminal did not answer" is a fact, not a
 * failure. Nothing here is needed in normal use — it exists so that a rendering
 * report can be checked against the terminal instead of argued about.
 *
 * @module dsh-ssh-tui/scripts/glyph-width-probe
 */
import process from 'node:process'

import { GLYPH_PROBE_TEXT, measureAmbiguousGlyphWidth } from '../lib/glyph-measure.js'
import { ambiguousWidthIsTwo } from '../lib/term-text.js'

if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
  process.stderr.write('this needs a real terminal (stdin and stdout must be TTYs)\n')
  process.exit(2)
}

const cells = [...GLYPH_PROBE_TEXT].length
process.stdout.write(`probing ${GLYPH_PROBE_TEXT} (${cells} glyphs)\n`)
const measured = await measureAmbiguousGlyphWidth({ timeoutMs: 1_500 })

if (measured === undefined) {
  process.stdout.write('the terminal did not answer (or answered something else)\n')
  process.stdout.write(`→ the TUI falls back to the locale: ${ambiguousWidthIsTwo() ? 'two' : 'one'} cell(s)\n`)
} else {
  process.stdout.write(`the cursor moved ${measured.cells} cells for ${cells} glyphs\n`)
  process.stdout.write(`→ advance: ${measured.wide ? 'two' : 'one'} cell(s) per glyph\n`)
  process.stdout.write(measured.wide
    ? '→ the terminal spends both cells itself: the TUI adds no reserving space\n'
    : '→ the TUI will reserve the second cell with a space, so the next character is not painted on top\n')
}
process.stdout.write('\nIf the glyphs above look narrower or wider than that, the font is the answer rather than the width table.\n')
