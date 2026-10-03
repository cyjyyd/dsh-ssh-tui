/**
 * Plain-text extraction for /copy. Kept off tui.ts so tests do not load SshTui.
 */

import type { CollapsibleBlock, Row } from './transcript-types.js'

function clipCopy(text: string, maxChars = 80_000): string {
  const trimmed = text.replace(/\s+$/u, '')
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}\n…`
}

export function copyTextFromRow(row: Row | CollapsibleBlock | undefined): string {
  if (row === undefined) return ''
  switch (row.kind) {
    case 'assistant':
    case 'user':
    case 'reasoning':
    case 'system':
    case 'diag':
    case 'error':
    case 'brand':
      return clipCopy(row.text)
    case 'tool': {
      const parts = [
        row.command ?? '',
        row.summary,
        row.output,
      ].filter(part => part.trim() !== '')
      return clipCopy(parts.join('\n'))
    }
    case 'plan':
      return clipCopy([
        row.planMarkdown ?? '',
        ...row.todos.map(item => `- [${item.status}] ${item.content}`),
      ].filter(part => part.trim() !== '').join('\n'))
    case 'question':
      return clipCopy([row.header, row.detail, row.summary].filter(part => part !== undefined && part.trim() !== '').join('\n'))
    case 'goal':
      return clipCopy([row.objective, row.blockedReason ?? ''].filter(part => part.trim() !== '').join('\n'))
    case 'prompt':
      return clipCopy(row.text)
    case 'subagent':
      return clipCopy(row.logs.map(entry => entry.text).filter(text => text.trim() !== '').join('\n'))
    case 'compaction':
      return clipCopy([row.summary, row.error].filter(part => part !== undefined && part.trim() !== '').join('\n'))
    case 'changes':
      return clipCopy([row.header, ...row.files, row.more ?? ''].filter(part => part.trim() !== '').join('\n'))
    case 'streaming-reasoning':
      return ''
    default:
      return ''
  }
}

/** What a copy is aimed at: the highlighted card, or the model's last reply. */
export type CopyTarget = 'highlight' | 'reply'

/** The newest model reply with text, or `''` when the session has not produced one. */
export function latestReplyText(rows: readonly Row[]): string {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row?.kind === 'assistant' && row.text.trim() !== '') return clipCopy(row.text)
  }
  return ''
}

/**
 * The text one copy target holds.
 *
 * The two targets are deliberately exclusive. They used to be one rule —
 * "the highlighted card, else the newest reply" — and the fallback made the
 * reply unreachable: any card left highlighted (one click on a tool card is
 * enough) silently redirected `/copy`, with nothing on screen saying the reply
 * had been passed over. `/copy` now names its target and defaults to the reply;
 * `highlight` is the old rule with its own, honest, empty case.
 * @param rows - the rows the reader can see (a `/clear` cutoff is not searched).
 * @param focused - the highlighted row, if any.
 * @param target - what the reader asked for; `reply` is the command's default.
 */
export function copyTextFromTranscript(
  rows: readonly Row[],
  focused: Row | CollapsibleBlock | null,
  target: CopyTarget = 'reply',
): { text: string; source: 'focused' | 'assistant' | 'empty' } {
  if (target === 'highlight') {
    // A reply has no body to fold away and no card text of its own beyond its
    // lines, so `copyTextFromRow` is the whole rule for both kinds.
    const focusedText = copyTextFromRow(focused ?? undefined)
    return focusedText.trim() === ''
      ? { text: '', source: 'empty' }
      : { text: focusedText, source: 'focused' }
  }
  const reply = latestReplyText(rows)
  return reply === '' ? { text: '', source: 'empty' } : { text: reply, source: 'assistant' }
}
