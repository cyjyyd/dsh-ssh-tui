/**
 * Shared history-session listing for the SSH TUI: the launch picker and the
 * in-app `/resume` command use the same candidates, labels, and ordering, so
 * both surfaces offer the same sessions.
 */

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
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
/** Whether one durable event is a user-authored message. */
function isUserMessageEvent(event: unknown): boolean {
  const candidate = event as { type?: string; data?: { source?: { kind?: string } } }
  return candidate.type === 'user/message' && candidate.data?.source?.kind === 'user'
}

/**
 * Whether the session ever produced a model reply. A failed agent request
 * counts: the error state is the reply, and the user may want to keep or
 * inspect it.
 */
function sessionHasReply(events: readonly unknown[]): boolean {
  return events.some(event => {
    const candidate = event as {
      type?: string
      data?: { reason?: { kind?: string } }
    }
    if (candidate.type === 'assistant/message' || candidate.type === 'agent/error') return true
    if (candidate.type === 'turn/end') return candidate.data?.reason?.kind === 'error'
    return false
  })
}

/**
 * A blank session never saw user input nor a model reply — a boot that died
 * before doing anything. Such sessions are deleted (never listed as
 * resumable) so crashed launches stop littering the picker with raw ids.
 */
function isBlankSession(hasUserInput: boolean, hasReply: boolean): boolean {
  return !hasUserInput && !hasReply
}

/** Delete one session's on-disk artifacts (log directory), best effort. */
async function pruneSessionArtifacts(
  persistence: SessionPersistence,
  meta: Parameters<SessionPersistence['locate']>[0],
): Promise<void> {
  try {
    const location = persistence.locate(meta)
    if (location?.path !== undefined && location.path !== '') {
      await rm(dirname(location.path), { recursive: true, force: true })
    }
  } catch {
    // Best effort: a stuck artifact only means the row lingers once more.
  }
}

/** Upper bound on one inspection batch, so the picker never fans out unbounded. */
const INSPECT_BATCH_SIZE = 30

/** Internal inspection result before display filtering. */
type InspectedSession = ResumableSession & { hasUserInput: boolean; hasReply: boolean }

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
        // The persisted generated title first: the web session list shows the
        // same `session/title` value, so both surfaces name a session alike
        // and switching between them stays findable. First user input is the
        // fallback for sessions whose title has not been generated yet.
        label: title !== undefined && title !== ''
          ? title
          : firstUserText !== undefined && firstUserText !== ''
            ? firstUserText
            : meta.id,
        updatedAt,
        cwd: meta.cwd ?? '',
        hasUserInput: firstUserMessage !== undefined,
        hasReply: sessionHasReply(inspection.events),
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
        hasReply: false,
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
    const settled = await Promise.all(batch.map(async meta => ({ meta, item: await inspectCandidate(meta) })))
    for (const { meta, item } of settled) {
      // Unreadable logs stay visible regardless; a readable blank (a boot
      // that died before any input or reply) gets deleted so the raw id
      // never shows up as resumable again.
      if (item.unreadable !== true && isBlankSession(item.hasUserInput, item.hasReply)) {
        void pruneSessionArtifacts(persistence, meta)
        continue
      }
      inspected.push(item)
    }
    if (inspected.filter(item => item.hasUserInput).length >= 9) break
  }

  const resumable = inspected.filter(item => item.hasUserInput || item.unreadable === true)
  const hosts = await listHosts()
  const byId = new Map(resumable.map(item => [item.id, item]))
  for (const host of hosts) {
    if (host.sessionId === currentId) continue
    const attach = { pid: host.lock.pid, sock: host.sock, state: host.lock.state }
    // A live Host whose session never saw input nor a reply is a crashed
    // boot: stop it, remove its artifacts, and keep it out of the picker.
    let blankLive = false
    let liveHasUserInput = true
    try {
      const inspection = await persistence.inspect(host.sessionId as Parameters<SessionPersistence['inspect']>[0])
      const hasInput = inspection.events.some(event => isUserMessageEvent(event))
      blankLive = isBlankSession(hasInput, sessionHasReply(inspection.events))
      liveHasUserInput = hasInput
    } catch {
      // No durable log: the Host booted and never did anything.
      blankLive = true
      liveHasUserInput = false
    }
    if (blankLive) {
      try { process.kill(attach.pid, 'SIGTERM') } catch { /* already gone */ }
      const header = candidates.find(candidate => candidate.id === host.sessionId)
      if (header !== undefined) void pruneSessionArtifacts(persistence, header)
      continue
    }
    const existing = byId.get(host.sessionId)
    if (existing !== undefined) {
      existing.attach = attach
      continue
    }
    const injected: InspectedSession = {
      id: host.sessionId,
      label: host.sessionId,
      updatedAt: Date.parse(host.lock.startedAt) || Date.now(),
      cwd: '',
      hasUserInput: liveHasUserInput,
      hasReply: true,
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
