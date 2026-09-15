/**
 * Line mode: one plain line per event, for screen readers, log capture, and
 * terminals where a full-screen repaint is the wrong shape.
 *
 * The TUI normally paints a framed screen: absolute cursor addressing, an
 * alternate screen buffer, only the rows that changed, and a spinner that
 * redraws in place. None of that survives a pipe, a screen reader, or a
 * recording — the same event can appear twice, out of order, or not at all.
 * This module turns a transcript row into the lines a log would carry, and the
 * caller appends them once, in order, and never repaints.
 *
 * Colour is deliberately absent: the caller may style a line, but the text has
 * to stand on its own because that is the point of the mode.
 * @module dsh-ssh-tui/line-mode
 */

import type { Row } from './transcript-types.js'

/** Whether the environment asks for line mode. `1/true/on/yes` all count. */
export function lineModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.DSH_TUI_LINE_MODE ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes'
}

/**
 * The lines one row contributes to the log.
 *
 * A row with embedded newlines contributes several lines — the alternative is
 * joining them, which corrupts a report's structure for the reader this mode
 * exists for. Rows that only make sense on a screen (the logo, a transient
 * reasoning buffer) contribute nothing rather than noise.
 * @param row - the transcript row that was just pushed.
 * @returns the lines to append, in order; empty when the row is screen-only.
 */
export function lineModeLines(row: Row): string[] {
  const split = (text: string): string[] => (text === '' ? [] : text.split('\n'))
  switch (row.kind) {
    case 'brand-logo':
      return []
    case 'tool': {
      const head = [row.title, row.summary].filter(part => part.trim() !== '').join('  ')
      const lines = head === '' ? [] : [head]
      if (row.diff !== undefined && row.diff.length > 0) {
        for (const hunk of row.diff) {
          lines.push(hunk.path)
          if (hunk.oldText !== null) for (const line of split(hunk.oldText)) lines.push(`- ${line}`)
          for (const line of split(hunk.newText)) lines.push(`+ ${line}`)
        }
      } else if (row.output !== undefined && row.output !== '') {
        lines.push(...split(row.output))
      }
      return lines
    }
    case 'plan':
      return [
        ...split(row.planMarkdown ?? ''),
        ...row.todos.map(item => `[${item.status}] ${item.content}`),
      ]
    case 'question':
      return [
        ...split(row.title),
        ...(row.header === undefined ? [] : split(row.header)),
        ...(row.detail === undefined ? [] : split(row.detail)),
      ]
    case 'subagent':
      return row.logs.flatMap(entry => split(entry.text))
    case 'compaction':
      return split([row.summary, row.error ?? ''].filter(part => part !== '').join('\n'))
    case 'goal':
      return [row.objective, ...(row.blockedReason === undefined ? [] : [row.blockedReason])]
    default:
      return split(row.text)
  }
}

/**
 * What one row's lines look like once appended.
 *
 * A trailing newline per line, and nothing else: no carriage returns (they
 * would overwrite the line just written on a terminal) and no escape sequences.
 */
export function appendRow(lines: readonly string[]): string {
  if (lines.length === 0) return ''
  return `${lines.join('\n')}\n`
}
