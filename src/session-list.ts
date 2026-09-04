/**
 * Shared history-session listing for the SSH TUI: the launch picker and the
 * in-app `/resume` command use the same candidates, labels, and ordering, so
 * both surfaces offer the same sessions.
 */

import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { t } from './i18n/index.js'
import { listAttachableHosts } from './session-lock.js'

/** Last path segment for the footer chip (`\root\genshin\srv` → `srv`). */
export function sessionCwdLabel(cwd: string): string {
  const raw = cwd.trim()
  if (raw === '') return ''
  const parts = raw.split(/[\\/]/u).filter(part => part !== '')
  const last = parts[parts.length - 1]
  if (last !== undefined && last !== '') return last
  return raw.startsWith('/') || raw.startsWith('\\') ? '/' : raw
}

export function formatFooterCwd(cwd: string): string {
  const label = sessionCwdLabel(cwd)
  return label === '' ? '' : t('footer.cwdChip', { name: label })
}

/**
 * Switch the process into a persisted session working directory. Returns the
 * directory actually used; missing/invalid paths stay put and are reported.
 */
export function enterSessionCwd(
  cwd: string | undefined,
  options: {
    current?: string
    exists?: (path: string) => boolean
    chdir?: (path: string) => void
  } = {},
): { cwd: string; changed: boolean; error?: string } {
  const current = options.current ?? process.cwd()
  const exists = options.exists ?? existsSync
  const chdir = options.chdir ?? ((path: string) => process.chdir(path))
  if (cwd === undefined || cwd.trim() === '') return { cwd: current, changed: false }
  const target = cwd.trim()
  if (!isAbsolute(target)) {
    return { cwd: current, changed: false, error: t('cwd.notAbsolute', { path: target }) }
  }
  if (!exists(target)) {
    return { cwd: current, changed: false, error: t('cwd.missing', { path: target }) }
  }
  if (target === current) return { cwd: current, changed: false }
  try {
    chdir(target)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { cwd: current, changed: false, error: t('cwd.failed', { path: target, error: message }) }
  }
  return { cwd: target, changed: true }
}

/** One selectable history session. */
export interface ResumableSession {
  id: string
  label: string
  updatedAt: number
  cwd: string
  /** Whether the full event log could not be inspected (corrupt/unsupported). */
  unreadable?: boolean
  /** Live Host that a new SSH can attach to. */
  attach?: { pid: number; sock: string; state?: string }
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
  listHosts: typeof listAttachableHosts = listAttachableHosts,
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
  const hosts = await listHosts()
  const byId = new Map(resumable.map(item => [item.id, item]))
  for (const host of hosts) {
    const existing = byId.get(host.sessionId)
    const attach = { pid: host.lock.pid, sock: host.sock, state: host.lock.state }
    if (existing !== undefined) {
      existing.attach = attach
      continue
    }
    const injected: InspectedSession = {
      id: host.sessionId,
      label: host.sessionId,
      updatedAt: Date.parse(host.lock.startedAt) || Date.now(),
      cwd: '',
      hasUserInput: true,
      attach,
    }
    resumable.push(injected)
    byId.set(host.sessionId, injected)
  }
  // Attachable live hosts first, then readable logs, then unreadable.
  resumable.sort((a, b) =>
    (a.attach === undefined ? 1 : 0) - (b.attach === undefined ? 1 : 0)
    || (a.unreadable === true ? 1 : 0) - (b.unreadable === true ? 1 : 0)
    || b.updatedAt - a.updatedAt)
  return resumable
    .slice(0, 9)
    .map(({ hasUserInput: _hasUserInput, ...rest }) => rest)
}
