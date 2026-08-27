/**
 * Startup history-session picker: a small raw-mode selector shown BEFORE the
 * main TUI mounts, so launching without an explicit session id lands on a
 * choice instead of a fresh main screen.
 */

import { StringDecoder } from 'node:string_decoder'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { formatSessionTime, listResumableSessions } from './session-list.js'
import { isEscapePrefix, truncateToWidth } from './tui.js'

/** What the launch picker decided. */
export type SessionPickerResult =
  | { kind: 'resume'; id: string }
  | { kind: 'new' }
  | null

/**
 * Show the picker and wait for one digit, Enter (new session), or a lone
 * Esc/Ctrl+C (cancel). Incomplete CSI/SS3 sequences are buffered briefly so
 * arrow keys are ignored instead of cancelling. Restores the terminal before
 * resolving; an AbortSignal cancels and restores as well.
 * @param ctx - boot context supplying sessionPersistence.
 * @param color - whether to apply ANSI colors.
 * @param signal - optional abort signal (fiber dispose) to cancel the picker.
 * @returns the selection, or null when cancelled.
 */
export async function showSessionPicker(ctx: Context, color: boolean, signal?: AbortSignal): Promise<SessionPickerResult> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) {
    process.stderr.write('dsh-ssh-tui: sessionPersistence service is unavailable\n')
    return { kind: 'new' }
  }
  const sessions = await listResumableSessions(persistence, '')
  if (signal?.aborted) return null
  if (sessions.length === 0) {
    process.stdout.write('dsh-ssh-tui: no resumable history sessions; starting a fresh session.\n')
    return { kind: 'new' }
  }

  const useAltScreen = process.env.DSH_TUI_NO_ALT_SCREEN !== '1'
    && process.env.DSH_TUI_NO_ALT_SCREEN !== 'true'
  const decoder = new StringDecoder('utf8')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdout.write(`${useAltScreen ? '\x1b[?1049h' : ''}\x1b[?25l`)

  const style = (text: string, code: string): string => color ? `\x1b[${code}m${text}\x1b[0m` : text
  const render = (): void => {
    const width = Math.max(20, process.stdout.columns || 80)
    const lines: string[] = [
      style(truncateToWidth('DeepSeek Harness — 选择要恢复的历史会话', width), '1'),
      '─'.repeat(width),
    ]
    sessions.forEach((session, index) => {
      lines.push(style(truncateToWidth(`${index + 1}  ${session.label}`, width), '1'))
      const meta = `${session.unreadable === true ? '⚠ 无法读取 · ' : ''}${formatSessionTime(session.updatedAt)} · ${session.cwd}`
      lines.push(`   ${style(truncateToWidth(meta, Math.max(1, width - 3)), '90')}`)
    })
    lines.push('')
    lines.push(`${style('0', '36')} / ${style('Enter', '36')}  新建会话`)
    lines.push(`${style('Esc', '36')}  取消`)
    process.stdout.write('\x1b[2J\x1b[H')
    for (const line of lines) {
      process.stdout.write(`${line}\x1b[0m\x1b[K\n`)
    }
  }

  return new Promise<SessionPickerResult>((resolve) => {
    let done = false
    let escapeBuffer = ''
    let escapeTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (result: SessionPickerResult): void => {
      if (done) return
      done = true
      if (escapeTimer !== undefined) clearTimeout(escapeTimer)
      signal?.removeEventListener('abort', onAbort)
      process.stdin.removeListener('data', onData)
      try {
        process.stdin.setRawMode(false)
      } catch {
        // The stream may already be closed during shutdown; restoring is best-effort.
      }
      process.stdin.pause()
      process.stdout.write(`\x1b[0m\x1b[?25h${useAltScreen ? '\x1b[?1049l' : ''}\n`)
      resolve(result)
    }
    const onAbort = (): void => {
      cleanup(null)
    }
    const onData = (chunk: Buffer): void => {
      const combined = escapeBuffer + decoder.write(chunk)
      escapeBuffer = ''
      if (escapeTimer !== undefined) {
        clearTimeout(escapeTimer)
        escapeTimer = undefined
      }

      // Ignore complete navigation / function-key sequences.
      if (
        /^\x1b\[[A-DHF]$/u.test(combined)
        || /^\x1b\[[1-6]~$/u.test(combined)
        || /^\x1bO[A-D]$/u.test(combined)
      ) {
        return
      }

      if (isEscapePrefix(combined)) {
        escapeBuffer = combined
        escapeTimer = setTimeout(() => {
          escapeTimer = undefined
          const pending = escapeBuffer
          escapeBuffer = ''
          if (pending === '\x1b') cleanup(null)
        }, 60)
        return
      }

      if (combined.startsWith('\x1b')) {
        // Unknown / complete escape sequence — ignore rather than cancel.
        return
      }

      for (const char of combined) {
        if (char === '\x03') {
          cleanup(null)
          return
        }
        if (char === '\r' || char === '\n' || char === '0') {
          cleanup({ kind: 'new' })
          return
        }
        if (char >= '1' && char <= '9') {
          const session = sessions[Number(char) - 1]
          if (session !== undefined) {
            cleanup({ kind: 'resume', id: session.id })
            return
          }
        }
      }
    }
    if (signal?.aborted) {
      cleanup(null)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    process.stdin.on('data', onData)
    render()
  })
}
