/**
 * Startup history-session picker: a small raw-mode selector shown BEFORE the
 * main TUI mounts, so launching without an explicit session id lands on a
 * choice instead of a fresh main screen.
 */

import { StringDecoder } from 'node:string_decoder'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { formatSessionTime, listResumableSessions } from './session-list.js'

/** What the launch picker decided. */
export type SessionPickerResult =
  | { kind: 'resume'; id: string }
  | { kind: 'new' }
  | null

/**
 * Show the picker and wait for one digit, Enter (new session), or Esc/Ctrl+C
 * (cancel). Restores the terminal before resolving.
 * @param ctx - boot context supplying sessionPersistence.
 * @param color - whether to apply ANSI colors.
 * @returns the selection, or null when cancelled.
 */
export async function showSessionPicker(ctx: Context, color: boolean): Promise<SessionPickerResult> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) {
    process.stderr.write('dsh-ssh-tui: sessionPersistence service is unavailable\n')
    return { kind: 'new' }
  }
  const sessions = await listResumableSessions(persistence, '')
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
      style('DeepSeek Harness — 选择要恢复的历史会话', '1'),
      '─'.repeat(width),
    ]
    sessions.forEach((session, index) => {
      lines.push(`${index + 1}  ${session.label}`)
      lines.push(`   ${style(formatSessionTime(session.updatedAt), '90')} · ${style(session.cwd, '90')}`)
    })
    lines.push('')
    lines.push(`${style('0', '36')} / ${style('Enter', '36')}  新建会话`)
    lines.push(`${style('Esc', '36')}  取消`)
    process.stdout.write('\x1b[2J\x1b[H')
    for (const line of lines) {
      const wrapped = line.length > width ? `${line.slice(0, width - 1)}…` : line
      process.stdout.write(`${wrapped}\x1b[0m\x1b[K\n`)
    }
  }

  return new Promise<SessionPickerResult>((resolve) => {
    let done = false
    const cleanup = (result: SessionPickerResult): void => {
      if (done) return
      done = true
      process.stdin.removeListener('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write(`\x1b[0m\x1b[?25h${useAltScreen ? '\x1b[?1049l' : ''}\n`)
      resolve(result)
    }
    const onData = (chunk: Buffer): void => {
      const text = decoder.write(chunk)
      for (const char of text) {
        if (char === '\x1b' || char === '\x03') {
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
    process.stdin.on('data', onData)
    render()
  })
}
