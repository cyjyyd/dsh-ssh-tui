/**
 * Terminal cell metrics, wrapping, markdown, and input folding.
 *
 * Isolated so the launch session picker can clip labels without loading
 * the interactive TUI class.
 */

import { t } from './i18n/index.js'

/**
 * Codex-style compact elapsed: `0s`, `1m 05s`, `1h 01m 01s`.
 * Used by the workspace wait card while the model has not streamed yet.
 */
export function fmtElapsedCompact(elapsedSecs: number): string {
  const secs = Math.max(0, Math.floor(elapsedSecs))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) {
    const minutes = Math.floor(secs / 60)
    const seconds = secs % 60
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  }
  const hours = Math.floor(secs / 3600)
  const minutes = Math.floor((secs % 3600) / 60)
  const seconds = secs % 60
  return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`
}

/**
 * Sweep highlight across `text` (Codex `shimmer.rs`). Truecolor blends a
 * highlight band; otherwise DIM / default / BOLD. Process-start based so
 * every paint of the same frame stays in phase.
 */
export function shimmerText(text: string, nowMs: number, color: boolean): string {
  const chars = Array.from(text)
  if (chars.length === 0) return ''
  if (!color) return text
  const padding = 10
  const period = chars.length + padding * 2
  const sweepMs = 2000
  const pos = Math.floor(((nowMs % sweepMs) / sweepMs) * period)
  const bandHalf = 5
  let out = ''
  for (let index = 0; index < chars.length; index += 1) {
    const dist = Math.abs(index + padding - pos)
    const t = dist <= bandHalf
      ? 0.5 * (1 + Math.cos(Math.PI * (dist / bandHalf)))
      : 0
    const style = t < 0.2 ? '2' : t < 0.6 ? '0' : '1'
    out += `\x1b[${style}m${chars[index]}\x1b[0m`
  }
  return out
}

/**
 * Codex `extract_first_bold`: the first **closed** `**bold**` in the thinking
 * stream, else the first markdown heading. An unclosed `**` means the title
 * has not arrived yet, so return undefined and keep the default header —
 * never fall back to hard-truncated reasoning, reply, or prompt text.
 */
export function waitSummaryFromReasoning(text: string): string | undefined {
  const raw = text.replace(/\r\n?/gu, '\n')
  const chars = Array.from(raw)
  for (let i = 0; i + 1 < chars.length; i += 1) {
    if (chars[i] !== '*' || chars[i + 1] !== '*') continue
    let j = i + 2
    while (j + 1 < chars.length && !(chars[j] === '*' && chars[j + 1] === '*')) j += 1
    if (j + 1 >= chars.length) return undefined
    const inner = chars.slice(i + 2, j).join('').replace(/\s+/gu, ' ').trim()
    return inner === '' ? undefined : inner
  }
  const heading = /^#{1,6}\s+(.+)$/mu.exec(raw)?.[1]
  const source = heading?.replace(/\s+/gu, ' ').trim() ?? ''
  return source === '' ? undefined : source
}

/** Wait-card header + optional detail. Header tracks model work when known. */
export function waitCardCopy(input: {
  toolTitle?: string
  toolSummary?: string
  reasoning?: string
}): { header: string; detail?: string } {
  const toolTitle = input.toolTitle?.trim() ?? ''
  const toolSummary = input.toolSummary?.trim() ?? ''
  const header = waitSummaryFromReasoning(input.reasoning ?? '') ?? t('wait.working')
  if (toolTitle !== '') {
    return { header, detail: toolSummary === '' ? toolTitle : `${toolTitle}  ${toolSummary}` }
  }
  return { header }
}

const WAIT_DETAIL_PREFIX = '  └ '
const WAIT_DETAIL_MAX_LINES = 3

/**
 * Codex `wrapped_details_lines`: word-wrap the wait-card detail under the
 * `  └ ` prefix, continue wrapped rows at the prefix width, cap at 3 rows and
 * end the last one with an ellipsis when the text does not fit.
 */
export function wrapWaitDetails(detail: string, width: number, maxLines = WAIT_DETAIL_MAX_LINES): string[] {
  const prefixWidth = displayWidth(WAIT_DETAIL_PREFIX)
  const contentWidth = Math.max(1, width - prefixWidth)
  const rows: string[] = []
  let current = ''
  const flush = (): void => {
    if (current !== '') rows.push(current)
    current = ''
  }
  for (const word of detail.split(/\s+/u)) {
    if (word === '') continue
    let rest = word
    while (displayWidth(rest) > contentWidth) {
      flush()
      let cut = 0
      let used = 0
      for (const char of rest) {
        const charWidth = displayWidth(char)
        if (used + charWidth > contentWidth) break
        used += charWidth
        cut += char.length
      }
      if (cut === 0) cut = firstCodePointLength(rest)
      rows.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    if (rest === '') continue
    if (current === '') current = rest
    else if (displayWidth(current) + 1 + displayWidth(rest) <= contentWidth) current += ` ${rest}`
    else {
      flush()
      current = rest
    }
  }
  flush()
  if (rows.length === 0) return []
  const overflow = rows.length > maxLines
  const kept = overflow ? rows.slice(0, maxLines) : rows
  if (overflow) {
    // Codex rewrites the last kept row with an explicit ellipsis so it reads
    // as "more below", even when the row itself still has spare room.
    const last = kept[maxLines - 1] ?? ''
    const limit = Math.max(1, contentWidth - 1)
    let cut = 0
    let used = 0
    for (const char of last) {
      const charWidth = displayWidth(char)
      if (used + charWidth > limit) break
      used += charWidth
      cut += char.length
    }
    kept[maxLines - 1] = `${last.slice(0, cut)}…`
  }
  return kept.map((line, index) =>
    index === 0 ? `${WAIT_DETAIL_PREFIX}${line}` : `${' '.repeat(prefixWidth)}${line}`)
}

/**
 * Terminal cell width for one string.
 *
 * Match glibc wcwidth / typical UTF-8 SSH terminals: CJK ideographs and
 * fullwidth forms occupy two cells; East-Asian Ambiguous box-drawing and
 * ornaments (`─`, `●`, `·`, `▸`, `❯`, Braille spinners) occupy one. Counting
 * those ambiguous glyphs as two made `repeatToWidth('─', cols)` paint a
 * half-width rule and parked the input cursor half a cell past the text.
 *
 * Overflow into the input box is handled by clipping/padding painted rows to
 * the measured column count, not by inflating glyph width.
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    if (char === '\t') {
      // Tabs are expanded to spaces before rendering; keep the width
      // calculation consistent with `sanitizeTerminalText()`.
      width += 4
      continue
    }
    const cp = char.codePointAt(0) ?? 0
    if (cp === 0x00ad || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2060 && cp <= 0x2064) || cp === 0xfeff) {
      continue
    }
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) {
      continue
    }
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    width += wide ? 2 : 1
  }
  return width
}

/** Pad or clip one already-sanitized line so it occupies exactly `width` cells. */
export function padToWidth(text: string, width: number): string {
  const safe = sanitizeTerminalText(text)
  if (width <= 0) return ''
  const clipped = truncateToWidth(safe, width)
  const used = displayWidth(clipped)
  return used >= width ? clipped : `${clipped}${' '.repeat(width - used)}`
}

/**
 * Pad an already-styled ANSI line to `width` cells without resetting SGR.
 * Diff add/del rows keep their background across the whole terminal row
 * instead of only the glyphs.
 */
export function padAnsiToWidth(text: string, width: number): string {
  if (width <= 0) return ''
  const clipped = clipAnsiToWidth(text, width)
  const used = visibleWidth(clipped)
  if (used >= width) return clipped
  const pad = ' '.repeat(width - used)
  // Insert spaces before a trailing SGR reset so backgrounds (diff rows)
  // and the cell budget both fill the whole terminal row.
  if (clipped.endsWith('\x1b[0m')) return `${clipped.slice(0, -4)}${pad}\x1b[0m`
  return `${clipped}${pad}`
}

/** Visible width of an ANSI-styled line, ignoring CSI / OSC sequences. */
export function visibleWidth(text: string): number {
  let used = 0
  let index = 0
  while (index < text.length) {
    if (text.charCodeAt(index) === 0x1b) {
      index = skipAnsiSequence(text, index)
      continue
    }
    const cp = text.codePointAt(index)
    if (cp === undefined) break
    const char = String.fromCodePoint(cp)
    used += displayWidth(char)
    index += char.length
  }
  return used
}

/** Advance past one ESC sequence starting at `index`. */
function skipAnsiSequence(text: string, index: number): number {
  let seqEnd = index + 1
  if (seqEnd >= text.length) return text.length
  const intro = text.charCodeAt(seqEnd)
  if (intro === 0x5b) {
    seqEnd += 1
    while (seqEnd < text.length) {
      const code = text.charCodeAt(seqEnd)
      seqEnd += 1
      if (code >= 0x40 && code <= 0x7e) break
    }
    return seqEnd
  }
  if (intro === 0x5d) {
    seqEnd += 1
    while (seqEnd < text.length) {
      const code = text.charCodeAt(seqEnd)
      seqEnd += 1
      if (code === 0x07) break
      if (code === 0x1b && text.charCodeAt(seqEnd) === 0x5c) {
        seqEnd += 1
        break
      }
    }
    return seqEnd
  }
  while (seqEnd < text.length) {
    const code = text.charCodeAt(seqEnd)
    seqEnd += 1
    if (code >= 0x40 && code <= 0x7e) break
  }
  return seqEnd
}

/** Repeat a glyph until it occupies exactly `width` cells. */
export function repeatToWidth(glyph: string, width: number): string {
  if (width <= 0) return ''
  const unit = displayWidth(glyph)
  if (unit <= 0) return ' '.repeat(width)
  const count = Math.max(1, Math.floor(width / unit))
  return padToWidth(glyph.repeat(count), width)
}

/** Strip terminal control sequences and expand tabs for display output. */
export function sanitizeTerminalText(text: string): string {
  return text
    .replace(/[\x1b\u009b]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replaceAll('\t', '    ')
}

/** UTF-16 length of the first code point, so fallback cuts never split a surrogate pair. */
export function firstCodePointLength(text: string): number {
  return Array.from(text)[0]?.length ?? 1
}

export function wrap(text: string, width: number): string[] {
  const limit = Math.max(1, width)
  const lines: string[] = []
  for (const sourceLine of text.split('\n')) {
    if (sourceLine === '') {
      lines.push('')
      continue
    }
    let rest = sanitizeTerminalText(sourceLine)
    while (displayWidth(rest) > limit) {
      let cut = 0
      let used = 0
      for (const char of rest) {
        const charWidth = displayWidth(char)
        if (charWidth > 0 && used + charWidth > limit) break
        used += charWidth
        cut += char.length
      }
      if (cut === 0) {
        // A single double-width glyph on a 1-cell row still has to occupy a
        // line; the next wrap continues after it so we never stall.
        cut = firstCodePointLength(rest)
      }
      lines.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    lines.push(rest)
  }
  return lines
}

/** One colored span inside a tool-card header line. Offsets are UTF-16 char indices. */
export interface TextSegment {
  start: number
  end: number
  sgr: string
}

/** Wrap plain text and report each output line's char range in the source. */
export function wrapTracked(text: string, width: number): { line: string; start: number; end: number }[] {
  const limit = Math.max(1, width)
  const out: { line: string; start: number; end: number }[] = []
  let base = 0
  for (const sourceLine of text.split('\n')) {
    if (sourceLine === '') {
      out.push({ line: '', start: base, end: base })
      base += 1
      continue
    }
    let rest = sourceLine
    let cursor = base
    while (displayWidth(rest) > limit) {
      let cut = 0
      let used = 0
      for (const char of rest) {
        const charWidth = displayWidth(char)
        if (charWidth > 0 && used + charWidth > limit) break
        used += charWidth
        cut += char.length
      }
      if (cut === 0) cut = firstCodePointLength(rest)
      out.push({ line: rest.slice(0, cut), start: cursor, end: cursor + cut })
      rest = rest.slice(cut)
      cursor += cut
    }
    out.push({ line: rest, start: cursor, end: cursor + rest.length })
    base += sourceLine.length + 1
  }
  return out
}

/** Paint one already-wrapped output line by the segments overlapping its range. */
export function paintSegmentedLine(
  line: string,
  start: number,
  end: number,
  segments: readonly TextSegment[],
): string {
  if (segments.length === 0) return line
  let out = ''
  let cursor = start
  for (const seg of segments) {
    if (seg.end <= start) continue
    if (seg.start >= end) break
    const from = Math.max(seg.start, start)
    const to = Math.min(seg.end, end)
    if (to <= from) continue
    // Gaps (the tool title) stay default foreground — do not drop them.
    if (from > cursor) out += line.slice(cursor - start, from - start)
    out += `\x1b[${seg.sgr}m${line.slice(from - start, to - start)}\x1b[0m`
    cursor = to
  }
  if (cursor < end) out += line.slice(cursor - start, end - start)
  return out === '' ? line : out
}

/** Wrap `text` and color each output line by overlapping `segments`. */
export function wrapSegmented(
  text: string,
  width: number,
  segments: readonly TextSegment[],
): string[] {
  return wrapTracked(text, width).map(({ line, start, end }) =>
    paintSegmentedLine(line, start, end, segments))
}

export function truncate(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (maxLines <= 0) return ''
  if (lines.length <= maxLines) return text
  if (maxLines === 1) return `… ${lines.length - 1} more line(s) …`
  const head = lines.slice(0, Math.max(0, maxLines - 2))
  const tail = lines.slice(-1)
  return [...head, `… ${lines.length - head.length - 1} more line(s) …`, ...tail].join('\n')
}
type InlineMarkdownKind = 'text' | 'bold' | 'italic' | 'code' | 'link' | 'muted'

interface MarkdownSegment {
  kind: InlineMarkdownKind
  text: string
}

type MarkdownBlockKind = 'assistant' | 'heading1' | 'heading2' | 'heading3' | 'code' | 'quote' | 'rule'

interface MarkdownBlockLine {
  base: MarkdownBlockKind
  segments: MarkdownSegment[]
}

const INLINE_MARKDOWN_PATTERN =
  /(\*\*[^*\n]+\*\*)|(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\n]+\))|(\*[^*\n]+\*)|(_[^_\n]+_)/gu

/** Parse one line's bold / italic / inline-code / link spans. */
function parseInlineMarkdown(line: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = []
  let last = 0
  for (const match of line.matchAll(INLINE_MARKDOWN_PATTERN)) {
    const index = match.index
    if (index > last) segments.push({ kind: 'text', text: line.slice(last, index) })
    const token = match[0]
    if (match[1] !== undefined) {
      segments.push({ kind: 'bold', text: token.slice(2, -2) })
    } else if (match[2] !== undefined) {
      segments.push({ kind: 'code', text: token.slice(1, -1) })
    } else if (match[3] !== undefined) {
      const labelEnd = token.indexOf('](')
      const label = token.slice(1, labelEnd)
      const url = token.slice(labelEnd + 2, -1)
      segments.push({ kind: 'link', text: label })
      if (url !== '') segments.push({ kind: 'muted', text: ` (${url})` })
    } else if (match[4] !== undefined) {
      segments.push({ kind: 'italic', text: token.slice(1, -1) })
    } else if (match[5] !== undefined) {
      segments.push({ kind: 'italic', text: token.slice(1, -1) })
    }
    last = index + token.length
  }
  if (last < line.length) segments.push({ kind: 'text', text: line.slice(last) })
  if (segments.length === 0) segments.push({ kind: 'text', text: line })
  return segments
}

function markdownSegmentWidth(segments: MarkdownSegment[]): number {
  return segments.reduce((total, segment) => total + displayWidth(segment.text), 0)
}

/** Wrap styled inline segments into visual rows, carrying a prefix only on row one. */
function wrapMarkdownSegments(
  segments: MarkdownSegment[],
  width: number,
  prefixSegments: MarkdownSegment[] = [],
): MarkdownSegment[][] {
  const limit = Math.max(1, width)
  const lines: MarkdownSegment[][] = []
  let current: MarkdownSegment[] = [...prefixSegments]
  let used = markdownSegmentWidth(current)

  for (const segment of segments) {
    let rest = segment.text
    while (rest !== '') {
      const available = limit - used
      if (available <= 0) {
        lines.push(current)
        current = []
        used = 0
        continue
      }
      const slice = forwardSliceByWidth(rest, available)
      let chunk = slice.text
      if (chunk === '') {
        // A wide character does not fit the remaining cell: wrap to the next
        // row instead of overflowing that cell into the input area.
        if (used > 0) {
          lines.push(current)
          current = []
          used = 0
          continue
        }
        chunk = Array.from(rest)[0] ?? rest.slice(0, 1)
      }
      current.push({ kind: segment.kind, text: chunk })
      used += displayWidth(chunk)
      rest = rest.slice(chunk.length)
      if (rest !== '') {
        lines.push(current)
        current = []
        used = 0
      }
    }
  }
  if (current.length > 0 || lines.length === 0) lines.push(current)
  return lines.map(line => line.length === 0 ? [{ kind: 'text', text: '' }] : line)
}

function markdownSegmentCode(kind: InlineMarkdownKind): string {
  switch (kind) {
    case 'bold': return '1;97'
    case 'italic': return '3;37'
    case 'code': return '36'
    case 'link': return '4;36'
    case 'muted': return '2;37'
    default: return ''
  }
}

function markdownBaseCode(kind: MarkdownBlockKind): string {
  switch (kind) {
    case 'heading1': return '1;4;97'
    case 'heading2': return '1;4;36'
    case 'heading3': return '1;36'
    case 'code': return '36'
    case 'quote': return '3;37'
    case 'rule': return '90'
    default: return '1;37'
  }
}

/** Render one pre-wrapped markdown line as ANSI (or plain text without color). */
function renderMarkdownBlockLine(block: MarkdownBlockLine, color: boolean): string {
  const segments = block.segments.map(segment => ({ ...segment, text: sanitizeTerminalText(segment.text) }))
  if (!color) return segments.map(segment => segment.text).join('')
  const base = markdownBaseCode(block.base)
  let out = `\x1b[${base}m`
  for (const segment of segments) {
    const code = markdownSegmentCode(segment.kind)
    if (code === '') {
      out += segment.text
    } else {
      out += `\x1b[${code}m${segment.text}\x1b[${base}m`
    }
  }
  return `${out}\x1b[0m`
}

/** Enlarge H1 text visually: fullwidth ASCII and spaced CJK glyphs. */
function expandHeadingText(text: string): string {
  let out = ''
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0
    if (cp >= 0x21 && cp <= 0x7e) {
      out += String.fromCodePoint(0xff01 + cp - 0x21)
    } else if (char.trim() === '') {
      out += ' '
    } else {
      out += `${char} `
    }
  }
  return out
}

function headingSegments(text: string, level: number): MarkdownSegment[] {
  const segments = parseInlineMarkdown(text)
  if (level !== 1) return segments
  return segments.map(segment =>
    segment.kind === 'code' || segment.kind === 'link' || segment.kind === 'muted'
      ? segment
      : { kind: segment.kind, text: expandHeadingText(segment.text) })
}

/**
 * Render workspace markdown into width-bounded terminal rows. Assistant
 * replies get a bold-white base; code blocks, headings, quotes, lists, rules,
 * links and inline spans keep their own ANSI treatment.
 */
export function renderMarkdownLines(text: string, width: number, color: boolean): string[] {
  const lines: string[] = []
  let inFence = false

  for (const sourceLine of text.split('\n')) {
    const raw = sanitizeTerminalText(sourceLine)
    const fence = /^```([^\n]*)$/u.exec(raw.trim())
    if (fence !== null) {
      inFence = !inFence
      lines.push(renderMarkdownBlockLine({
        base: 'code',
        segments: [{ kind: 'text', text: `\`\`\`${fence[1] ?? ''}` }],
      }, color))
      continue
    }
    if (inFence) {
      if (raw === '') {
        lines.push('')
        continue
      }
      for (const line of wrap(raw, width)) {
        lines.push(renderMarkdownBlockLine({
          base: 'code',
          segments: [{ kind: 'text', text: line }],
        }, color))
      }
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(raw)
    if (heading !== null) {
      // The hashes are markdown syntax, not content: replace them with
      // heading style. Levels differ visually: H1 is enlarged and
      // underlined, H2 underlined, H3 colored, H4+ bold white.
      const level = Math.min(6, (heading[1] ?? '#').length)
      const base: MarkdownBlockKind = level === 1
        ? 'heading1'
        : level === 2
          ? 'heading2'
          : level === 3
            ? 'heading3'
            : 'assistant'
      if (level === 1 && lines.at(-1) !== '') lines.push('')
      for (const segments of wrapMarkdownSegments(headingSegments(heading[2] ?? '', level), width)) {
        lines.push(renderMarkdownBlockLine({ base, segments }, color))
      }
      if (level === 1) lines.push('')
      continue
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(raw) && raw.trim() !== '') {
      lines.push(renderMarkdownBlockLine({
        base: 'rule',
        segments: [{ kind: 'text', text: repeatToWidth('─', Math.max(1, width)) }],
      }, color))
      continue
    }

    const quote = /^(\s*)>\s?(.*)$/u.exec(raw)
    if (quote !== null) {
      const indent = quote[1] ?? ''
      const prefix = `${indent}│ `
      for (const segments of wrapMarkdownSegments(
        parseInlineMarkdown(quote[2] ?? ''),
        width,
        [{ kind: 'text', text: prefix }],
      )) {
        lines.push(renderMarkdownBlockLine({ base: 'quote', segments }, color))
      }
      continue
    }

    const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(raw)
    if (list !== null) {
      const indent = list[1] ?? ''
      const marker = list[2] ?? '-'
      const prefix = `${indent}${marker} `
      for (const segments of wrapMarkdownSegments(
        parseInlineMarkdown(list[3] ?? ''),
        width,
        [{ kind: 'text', text: prefix }],
      )) {
        lines.push(renderMarkdownBlockLine({ base: 'assistant', segments }, color))
      }
      continue
    }

    if (raw === '') {
      lines.push('')
      continue
    }

    for (const segments of wrapMarkdownSegments(parseInlineMarkdown(raw), width)) {
      lines.push(renderMarkdownBlockLine({ base: 'assistant', segments }, color))
    }
  }
  return lines
}



/** Cut one line to fit a width, appending an ellipsis when truncated. */
export function truncateToWidth(text: string, width: number): string {
  const safe = sanitizeTerminalText(text)
  if (width <= 0) return ''
  if (displayWidth(safe) <= width) return safe
  if (width === 1) return '…'
  const limit = width - 1
  let cut = 0
  let used = 0
  for (const char of safe) {
    const charWidth = displayWidth(char)
    if (used + charWidth > limit) break
    used += charWidth
    cut += char.length
  }
  if (cut === 0) cut = firstCodePointLength(safe)
  return `${safe.slice(0, cut)}…`
}

/**
 * Clip an already-styled ANSI line to `width` terminal cells without dropping
 * the reset/SGR sequences. Used by the incremental painter so a leftover wide
 * glyph cannot wrap into the next row.
 */
export function clipAnsiToWidth(text: string, width: number): string {
  if (width <= 0) return ''
  let used = 0
  let out = ''
  let index = 0
  while (index < text.length) {
    if (text.charCodeAt(index) === 0x1b) {
      const seqEnd = skipAnsiSequence(text, index)
      out += text.slice(index, seqEnd)
      index = seqEnd
      continue
    }
    const cp = text.codePointAt(index)
    if (cp === undefined) break
    const char = String.fromCodePoint(cp)
    const charWidth = displayWidth(char)
    if (used + charWidth > width) break
    out += char
    used += charWidth
    index += char.length
  }
  return out
}

/** One renderable view of the input line: text plus the cursor's visual offset. */
export interface InputView {
  text: string
  cursorOffset: number
  folded: boolean
}

/** Slice up to `maxWidth` display columns from the beginning of `text`. */
function forwardSliceByWidth(text: string, maxWidth: number): { text: string; width: number } {
  let cut = 0
  let used = 0
  for (const char of text) {
    const charWidth = displayWidth(char)
    if (used + charWidth > maxWidth) break
    used += charWidth
    cut += char.length
  }
  return { text: text.slice(0, cut), width: used }
}

/** Slice up to `maxWidth` display columns ending at `end` in `text`. */
function backwardSliceByWidth(text: string, end: number, maxWidth: number): { start: number; width: number } {
  if (end <= 0 || maxWidth <= 0) return { start: end, width: 0 }
  const chars = Array.from(text.slice(0, end))
  let used = 0
  let firstIncluded = chars.length
  for (let index = chars.length - 1; index >= 0; index--) {
    const charWidth = displayWidth(chars[index] ?? '')
    if (used + charWidth > maxWidth) break
    used += charWidth
    firstIncluded = index
  }
  return {
    start: chars.slice(0, firstIncluded).join('').length,
    width: used,
  }
}

/**
 * Fold a long input into one terminal row around the cursor.
 *
 * Newlines from a paste are display-only: they do not occupy cells, so a
 * naive `displayWidth(input)` under-counts a multi-line paste and parks the
 * caret in the middle of later text. Fold the *current line* (between the
 * surrounding newlines) and keep `\n` out of the visible slice.
 */
export function foldInputView(input: string, cursor: number, maxWidth: number): InputView {
  const width = Math.max(1, maxWidth)
  const safeCursor = Math.max(0, Math.min(cursor, input.length))
  const lineStart = input.lastIndexOf('\n', Math.max(0, safeCursor - 1)) + 1
  const lineEndRaw = input.indexOf('\n', safeCursor)
  const lineEnd = lineEndRaw === -1 ? input.length : lineEndRaw
  const line = input.slice(lineStart, lineEnd)
  const lineCursor = safeCursor - lineStart
  const totalWidth = displayWidth(line)
  const cursorOffset = displayWidth(line.slice(0, lineCursor))
  const hasMoreLines = lineStart > 0 || lineEnd < input.length
  if (totalWidth <= width && !hasMoreLines) {
    return { text: line, cursorOffset, folded: false }
  }
  if (totalWidth <= width) {
    return { text: line, cursorOffset, folded: true }
  }
  const before = cursorOffset
  const after = totalWidth - cursorOffset
  const leftFolded = before > 0
  const rightFolded = after > 0
  const markers = (leftFolded ? 1 : 0) + (rightFolded ? 1 : 0)
  const available = Math.max(1, width - markers)
  let beforeBudget = Math.min(before, Math.ceil(available / 2))
  let afterBudget = Math.min(after, available - beforeBudget)
  // If the tail is shorter than its budget, spend the spare columns on the
  // side before the cursor so the cursor stays visible near its true offset.
  beforeBudget = Math.min(before, beforeBudget + (available - beforeBudget - afterBudget))
  const beforeSlice = backwardSliceByWidth(line, lineCursor, beforeBudget)
  const afterSlice = forwardSliceByWidth(line.slice(lineCursor), afterBudget)
  const beforeText = line.slice(beforeSlice.start, lineCursor)
  return {
    text: `${leftFolded ? '…' : ''}${beforeText}${afterSlice.text}${rightFolded ? '…' : ''}`,
    cursorOffset: (leftFolded ? 1 : 0) + displayWidth(beforeText),
    folded: true,
  }
}

/**
 * Map a character index in the input text to its visual (row, col) after the
 * same width wrapping `wrap()` applies to the rendered input. `row` is the
 * 0-based input display line, `col` the 0-based column within that line
 * (before any prompt prefix). This keeps the cursor on the correct line/column
 * when the input contains literal newlines from multi-line pastes.
 */
export function cursorVisualPosition(text: string, cursor: number, width: number): { row: number; col: number } {
  let row = 0
  let col = 0
  let used = 0
  let offset = 0
  for (const char of text) {
    if (offset >= cursor) break
    if (char === '\n') {
      row += 1
      col = 0
      used = 0
    } else {
      const charWidth = displayWidth(char)
      if (used + charWidth > width) {
        row += 1
        col = 0
        used = 0
      }
      used += charWidth
      col += charWidth
    }
    offset += char.length
  }
  return { row, col }
}

/** Take the first `max` code points of a string without splitting surrogates. */
export function sliceCodePoints(text: string, max: number): string {
  if (max <= 0) return ''
  return Array.from(text).slice(0, max).join('')
}

/** Take the last `max` code points of a string without splitting surrogates. */
export function lastCodePoints(text: string, max: number): string {
  if (max <= 0) return ''
  return Array.from(text).slice(-max).join('')
}
