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
    case 'streaming-reasoning':
      return ''
    default:
      return ''
  }
}

export function copyTextFromTranscript(
  rows: readonly Row[],
  focused: Row | CollapsibleBlock | null,
): { text: string; source: 'focused' | 'assistant' | 'empty' } {
  const focusedText = copyTextFromRow(focused ?? undefined)
  if (focusedText.trim() !== '') return { text: focusedText, source: 'focused' }
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row?.kind === 'assistant' && row.text.trim() !== '') {
      return { text: clipCopy(row.text), source: 'assistant' }
    }
  }
  return { text: '', source: 'empty' }
}
