/**
 * Line-level diffing for the tool card, and the word-level emphasis inside a
 * changed pair.
 *
 * The card used to print every old line as `-` and every new line as `+`: a
 * one-line change in a hundred-line file produced two hundred rows, which is
 * unreadable and hides the change it is trying to show. This module keeps the
 * classic shape — common lines as context, changes as `-`/`+` pairs, unchanged
 * stretches collapsed to a marker — and reports which characters inside a
 * replaced pair actually changed so the renderer can emphasise them.
 * @module dsh-ssh-tui/line-diff
 */

/** One line of the diff. */
export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
  /** 0-based index in the old text, for `same` and `del`. */
  oldIndex?: number
  /** 0-based index in the new text, for `same` and `add`. */
  newIndex?: number
}

/** A run of lines with its context, and how many unchanged lines were skipped. */
export interface DiffHunk {
  /** Unchanged lines collapsed before this run; 0 for the first. */
  omittedBefore: number
  lines: DiffLine[]
}

/** One emphasized range inside a line, in UTF-16 offsets. */
export interface DiffSpan {
  start: number
  end: number
}

/** Lines past this count fall back to a block replacement (the table is O(n·m)). */
const MAX_DIFF_LINES = 1_500

/** Split text into lines, treating an empty string as no lines. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  return text.split('\n')
}

/**
 * Diff two texts line by line.
 *
 * Equal lines are `same`, lines only in the old text are `del`, only in the new
 * are `add` — in the order a reader expects. A pair this module cannot afford
 * (see {@link MAX_DIFF_LINES}) degrades to "all removed, then all added", which
 * is what the card rendered before but is at least bounded.
 * @param oldText - the previous content; empty for a new file.
 * @param newText - the new content.
 * @returns the diff, oldest first.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return [
      ...oldLines.map((text, oldIndex) => ({ kind: 'del' as const, text, oldIndex })),
      ...newLines.map((text, newIndex) => ({ kind: 'add' as const, text, newIndex })),
    ]
  }
  // Longest common subsequence, computed from the end so the walk below reads
  // forward.
  const lengths: number[][] = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0))
  for (let oldAt = oldLines.length - 1; oldAt >= 0; oldAt -= 1) {
    for (let newAt = newLines.length - 1; newAt >= 0; newAt -= 1) {
      const row = lengths[oldAt]
      const next = lengths[oldAt + 1]
      if (row === undefined || next === undefined) continue
      row[newAt] = oldLines[oldAt] === newLines[newAt]
        ? (next[newAt + 1] ?? 0) + 1
        : Math.max(next[newAt] ?? 0, row[newAt + 1] ?? 0)
    }
  }
  const out: DiffLine[] = []
  let oldAt = 0
  let newAt = 0
  while (oldAt < oldLines.length && newAt < newLines.length) {
    if (oldLines[oldAt] === newLines[newAt]) {
      out.push({ kind: 'same', text: oldLines[oldAt] ?? '', oldIndex: oldAt, newIndex: newAt })
      oldAt += 1
      newAt += 1
      continue
    }
    const down = lengths[oldAt + 1]?.[newAt] ?? 0
    const right = lengths[oldAt]?.[newAt + 1] ?? 0
    if (down >= right) {
      out.push({ kind: 'del', text: oldLines[oldAt] ?? '', oldIndex: oldAt })
      oldAt += 1
      continue
    }
    out.push({ kind: 'add', text: newLines[newAt] ?? '', newIndex: newAt })
    newAt += 1
  }
  for (; oldAt < oldLines.length; oldAt += 1) {
    out.push({ kind: 'del', text: oldLines[oldAt] ?? '', oldIndex: oldAt })
  }
  for (; newAt < newLines.length; newAt += 1) {
    out.push({ kind: 'add', text: newLines[newAt] ?? '', newIndex: newAt })
  }
  return out
}

/**
 * Group a diff into runs of change with `context` unchanged lines around them,
 * reporting how many unchanged lines were left out between runs.
 * @param lines - a diff, as {@link diffLines} returns it.
 * @param context - unchanged lines to keep on each side of a change.
 * @returns the runs, in order; a diff with no changes yields no runs.
 */
export function diffHunks(lines: readonly DiffLine[], context = 3): DiffHunk[] {
  const changed = lines.map((line, index) => (line.kind === 'same' ? -1 : index)).filter(index => index !== -1)
  if (changed.length === 0) return []
  const runs: Array<{ start: number; end: number }> = []
  for (const index of changed) {
    const last = runs[runs.length - 1]
    if (last !== undefined && index - last.end <= context * 2 + 1) {
      last.end = index
      continue
    }
    runs.push({ start: index, end: index })
  }
  const hunks: DiffHunk[] = []
  let previousEnd = -1
  for (const run of runs) {
    const start = Math.max(0, run.start - context)
    const end = Math.min(lines.length - 1, run.end + context)
    hunks.push({
      omittedBefore: previousEnd < 0 ? start : start - previousEnd - 1,
      lines: lines.slice(start, end + 1),
    })
    previousEnd = end
  }
  return hunks
}

/**
 * The characters that differ between two lines: the common prefix and suffix
 * are trimmed away, and what is left is emphasised.
 *
 * Whole-line emphasis was the old behaviour and it reads as noise on a line that
 * changed one identifier. Trimming is greedy and therefore approximate — it does
 * not try to align moved words — but it is exact about the boundaries it does
 * report: everything outside the spans really is identical.
 * @param oldText - the removed line.
 * @param newText - the added line.
 * @returns one span list per side, possibly empty when they are equal.
 */
export function wordDiffSpans(oldText: string, newText: string): { old: DiffSpan[]; new: DiffSpan[] } {
  if (oldText === newText) return { old: [], new: [] }
  const oldChars = [...oldText]
  const newChars = [...newText]
  let prefix = 0
  while (prefix < oldChars.length && prefix < newChars.length && oldChars[prefix] === newChars[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldChars.length - prefix
    && suffix < newChars.length - prefix
    && oldChars[oldChars.length - 1 - suffix] === newChars[newChars.length - 1 - suffix]
  ) {
    suffix += 1
  }
  // Offsets are UTF-16, so the character counts have to be converted back.
  const oldPrefix = oldChars.slice(0, prefix).join('').length
  const newPrefix = newChars.slice(0, prefix).join('').length
  const oldEnd = oldText.length - oldChars.slice(oldChars.length - suffix).join('').length
  const newEnd = newText.length - newChars.slice(newChars.length - suffix).join('').length
  return {
    old: oldEnd > oldPrefix ? [{ start: oldPrefix, end: oldEnd }] : [],
    new: newEnd > newPrefix ? [{ start: newPrefix, end: newEnd }] : [],
  }
}
