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
  /** Whether the full event log could not be inspected (corrupt/unsupported). */
  unreadable?: boolean
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
 * Subagent-owned sessions and the current session are excluded. Sessions
 * whose event log cannot be inspected are kept (marked `unreadable`) instead
 * of silently disappearing from history; readable sessions with user input
 * sort first. The label is the user's first input, falling back to the
 * session title and then the id.
 * @param persistence - the session persistence service.
 * @param currentId - the live session to exclude (empty at launch).
 * @returns up to nine candidates in display order.
 */
/** Upper bound on one inspection batch, so the picker never fans out unbounded. */
const INSPECT_BATCH_SIZE = 30

/** Internal inspection result before display filtering. */
type InspectedSession = ResumableSession & { hasUserInput: boolean }

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

  const inspectCandidate = async (meta: (typeof candidates)[number]): Promise<InspectedSession> => {
    try {
      const inspection = await persistence.inspect(meta.id)
      const firstUserMessage = inspection.events.find(
        (event): event is Extract<typeof event, { type: 'user/message' }> =>
          event.type === 'user/message'
          && event.data.source.kind === 'user')
      const firstUserText = firstUserMessage === undefined
        ? undefined
        : Array.from(
            firstUserMessage.data.content
              .map((block) => {
                const candidate = block as { type: string; text?: unknown }
                return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : ''
              })
              .join(' ')
              .replace(/\s+/gu, ' ')
              .trim(),
          )
          .slice(0, 80)
          .join('')
      const titleEvent = [...inspection.events].reverse()
        .find(event => (event as { type: string }).type === 'session/title')
      const title = titleEvent === undefined
        ? undefined
        : (titleEvent as unknown as { data: { title: string } }).data.title
      const updatedAt = inspection.events.at(-1)?.time ?? meta.createdAt
      return {
        id: meta.id,
        label: firstUserText !== undefined && firstUserText !== ''
          ? firstUserText
          : title !== undefined && title !== ''
            ? title
            : meta.id,
        updatedAt,
        cwd: meta.cwd ?? '',
        hasUserInput: firstUserMessage !== undefined,
      }
    } catch {
      // A corrupt/unsupported log must not make the session vanish from the
      // picker: keep it visible under its id and let a resume attempt report
      // the real error.
      return {
        id: meta.id,
        label: meta.id,
        updatedAt: meta.createdAt,
        cwd: meta.cwd ?? '',
        hasUserInput: false,
        unreadable: true,
      }
    }
  }

  // Headers only carry creation time, so inspect by creation recency until
  // nine sessions with real user input are found. Recent empty boot rows (a
  // launch that exited before the first message) must not push older real
  // conversations out of the fixed window.
  const inspected: InspectedSession[] = []
  for (let offset = 0; offset < candidates.length; offset += INSPECT_BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + INSPECT_BATCH_SIZE)
    inspected.push(...await Promise.all(batch.map(inspectCandidate)))
    if (inspected.filter(item => item.hasUserInput).length >= 9) break
  }

  const resumable = inspected.filter(item => item.hasUserInput || item.unreadable === true)
  // Readable sessions with user input first, unreadable sessions after them;
  // within each group the inspected activity time puts the most recently
  // touched session first.
  resumable.sort((a, b) =>
    (a.unreadable === true ? 1 : 0) - (b.unreadable === true ? 1 : 0)
    || b.updatedAt - a.updatedAt)
  return resumable
    .slice(0, 9)
    .map(({ hasUserInput: _hasUserInput, ...rest }) => rest)
}
