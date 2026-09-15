/**
 * Free-form selection over the painted transcript.
 *
 * The terminal cannot select text for us: the TUI claims the mouse (`?1000h`
 * plus SGR reports) so the wheel scrolls the transcript and a click expands a
 * card or opens a link. That is why a reply could only be copied with `/copy`
 * and the focused card. This module is the in-app replacement the user asked
 * for: drag across a reply, and the dragged text goes to the clipboard over
 * OSC 52 (the channel `/copy` already uses).
 *
 * Only **model replies** are freely selectable. Everything here is pure: the
 * caller passes the painted lines (plain text plus whether each one came from a
 * reply) and gets back the ordered selection, the cell spans to paint in
 * reverse video, and the text to copy. The IO — mouse reports, OSC 52, notices —
 * stays in `tui.ts`.
 *
 * Columns are **cells**, not characters: a CJK glyph is two cells wide, and a
 * selection that touches either half includes the whole glyph. Surrogate pairs
 * (emoji) are treated the same way.
 */

import { displayWidth } from './term-text.js'

/** One painted screen line, with the origin the selection rules care about. */
export interface SelectableLine {
  /** The line as the user sees it: no escape sequences, no padding. */
  text: string
  /** True when this line came from a model reply, the only freely copyable kind. */
  copyable: boolean
}

/** A point in the transcript: `line` indexes the painted lines, `column` is a cell. */
export interface SelectionPoint {
  line: number
  column: number
}

/** Two ordered points; `from` is never after `to`. */
export interface ScreenSelection {
  from: SelectionPoint
  to: SelectionPoint
}

/** A cell range on one line, `end` exclusive — what the painter inverts. */
export interface SelectionSpan {
  line: number
  start: number
  end: number
}

/** Order two dragged points, whichever way the drag went. */
export function orderPoints(anchor: SelectionPoint, extent: SelectionPoint): ScreenSelection {
  const before = anchor.line < extent.line
    || (anchor.line === extent.line && anchor.column <= extent.column)
  return before ? { from: anchor, to: extent } : { from: extent, to: anchor }
}

/**
 * The contiguous run of copyable lines around `line`, or undefined when that
 * line is not copyable at all — a drag that starts on a tool card or a notice
 * selects nothing, and the caller keeps its click behavior.
 */
export function copyableRun(
  lines: readonly SelectableLine[],
  line: number,
): { first: number; last: number } | undefined {
  if (line < 0 || line >= lines.length) return undefined
  if (lines[line]?.copyable !== true) return undefined
  let first = line
  while (first > 0 && lines[first - 1]?.copyable === true) first -= 1
  let last = line
  while (last + 1 < lines.length && lines[last + 1]?.copyable === true) last += 1
  return { first, last }
}

/**
 * Clamp a drag to the copyable run it started in, so dragging past a reply's
 * end cannot pick up a system notice or another card's text.
 */
export function clampSelection(
  lines: readonly SelectableLine[],
  anchor: SelectionPoint,
  extent: SelectionPoint,
): ScreenSelection | undefined {
  // The run comes from where the drag STARTED: a pointer that wanders above the
  // reply must not re-anchor the selection on whatever it passed over.
  const run = copyableRun(lines, anchor.line)
  if (run === undefined) return undefined
  const ordered = orderPoints(anchor, extent)
  const from = { line: ordered.from.line, column: Math.max(0, ordered.from.column) }
  const toLine = Math.min(ordered.to.line, run.last)
  const to = {
    line: toLine,
    column: toLine === ordered.to.line ? Math.max(0, ordered.to.column) : lineWidth(lines[toLine]?.text ?? ''),
  }
  return { from, to }
}

/** Width of one painted line in cells, measured the way the painter measures it. */
function lineWidth(text: string): number {
  return displayWidth(text)
}

/**
 * The offset of the glyph whose cell contains `column` — the **start** snap.
 *
 * A column inside a wide glyph (its second cell) maps to that glyph's own
 * offset, so starting a drag on either half includes the whole character.
 */
export function offsetAtColumn(text: string, column: number): number {
  if (column <= 0) return 0
  let used = 0
  let index = 0
  while (index < text.length) {
    const cp = text.codePointAt(index)
    if (cp === undefined) break
    const char = String.fromCodePoint(cp)
    const width = displayWidth(char)
    if (used + width > column) return index
    used += width
    index += char.length
  }
  return text.length
}

/**
 * The offset just past the glyph a boundary cuts through — the **end** snap.
 *
 * The two ends snap differently on purpose: a drag that stops on the second
 * cell of a wide glyph has visually covered that glyph, and half a glyph cannot
 * be copied, so the whole of it is included rather than dropped.
 */
export function offsetAfterColumn(text: string, column: number): number {
  if (column <= 0) return 0
  let used = 0
  let index = 0
  while (index < text.length) {
    const cp = text.codePointAt(index)
    if (cp === undefined) break
    const char = String.fromCodePoint(cp)
    const width = displayWidth(char)
    // A boundary exactly at a glyph's first cell excludes that glyph; only a
    // boundary strictly inside one (a wide glyph's second cell) includes it.
    if (used === column) return index
    if (used + width > column) return index + char.length
    used += width
    index += char.length
  }
  return text.length
}

/** The cell spans to paint in reverse video, one per covered line. */
export function selectionSpans(
  lines: readonly SelectableLine[],
  selection: ScreenSelection,
): SelectionSpan[] {
  const spans: SelectionSpan[] = []
  for (let line = selection.from.line; line <= selection.to.line; line += 1) {
    const text = lines[line]?.text ?? ''
    const width = lineWidth(text)
    const start = line === selection.from.line ? Math.min(selection.from.column, width) : 0
    const end = line === selection.to.line ? Math.min(selection.to.column, width) : width
    if (end > start) spans.push({ line, start, end })
  }
  return spans
}

/**
 * The text a drag selected: the lines as painted, joined with newlines and with
 * each line's trailing padding removed. Empty when the drag covered nothing.
 */
export function selectionText(
  lines: readonly SelectableLine[],
  selection: ScreenSelection,
): string {
  const parts: string[] = []
  for (let line = selection.from.line; line <= selection.to.line; line += 1) {
    const text = lines[line]?.text ?? ''
    const startOffset = line === selection.from.line ? offsetAtColumn(text, selection.from.column) : 0
    const endOffset = line === selection.to.line ? offsetAfterColumn(text, selection.to.column) : text.length
    if (endOffset <= startOffset) {
      // A drag that stops at a line's first cell still selects that line's break.
      parts.push('')
      continue
    }
    parts.push(text.slice(startOffset, endOffset).replace(/\s+$/u, ''))
  }
  return parts.join('\n').replace(/\n+$/u, '')
}
