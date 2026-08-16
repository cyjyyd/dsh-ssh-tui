/**
 * Shared history-session listing for the SSH TUI: the launch picker and the
 * in-app `/resume` command use the same candidates, labels, and ordering, so
 * both surfaces offer the same sessions.
 */

import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

/** One selectable history session. */
export interface ResumableSession {
  id: string
  label: string
  updatedAt: number
  cwd: string
}

/** `MM-DD HH:mm` local-time label for session lists. */
export function formatSessionTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * List the most recent resumable top-level sessions, newest first.
 *
 * Subagent-owned sessions and the current session are excluded; the label is
 * the user's first input, falling back to the session title and then the id.
 * @param persistence - the session persistence service.
 * @param currentId - the live session to exclude (empty at launch).
 * @returns up to nine candidates in display order.
 */
export async function listResumableSessions(
  persistence: SessionPersistence,
  currentId: string,
): Promise<ResumableSession[]> {
  const headers = await persistence.list()
  const candidates = headers
    .filter(meta =>
      meta.id !== currentId
      && meta.cwd !== undefined
      && meta.origin !== 'subagent'
      && (meta.delegationDepth ?? 0) === 0)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 9)
  return Promise.all(candidates.map(async (meta) => {
    try {
      const inspection = await persistence.inspect(meta.id)
      const firstUserMessage = inspection.events.find(
        (event): event is Extract<typeof event, { type: 'user/message' }> =>
          event.type === 'user/message'
          && event.data.source.kind === 'user')
      const firstUserText = firstUserMessage === undefined
        ? undefined
        : firstUserMessage.data.content
          .map((block) => {
            const candidate = block as { type: string; text?: unknown }
            return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : ''
          })
          .join(' ')
          .replace(/\s+/gu, ' ')
          .trim()
          .slice(0, 80)
      const titleEvent = [...inspection.events].reverse()
        .find(event => (event as { type: string }).type === 'session/title')
      const title = titleEvent === undefined
        ? undefined
        : (titleEvent as unknown as { data: { title: string } }).data.title
      const updatedAt = inspection.events.at(-1)?.time ?? meta.createdAt
      return { id: meta.id, label: firstUserText ?? title ?? meta.id, updatedAt, cwd: meta.cwd ?? '' }
    } catch {
      return { id: meta.id, label: meta.id, updatedAt: meta.createdAt, cwd: meta.cwd ?? '' }
    }
  }))
}
