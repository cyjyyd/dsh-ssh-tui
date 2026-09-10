/**
 * Shared history-session listing for the SSH TUI: the launch picker and the
 * in-app `/resume` command use the same candidates, labels, and ordering, so
 * both surfaces offer the same sessions.
 */

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import {
  inspectPersistenceSession,
  listPersistenceHeaders,
  persistenceLocate,
  type SessionHeaderLike,
} from './dsh-compat.js'
import { t } from './i18n/index.js'
import { listAttachableHosts } from './session-lock.js'
import {
  indexEntryMatchesStat,
  loadSessionIndex,
  PICKER_PRIORITY_COUNT,
  pruneSessionIndex,
  saveSessionIndex,
  sessionArtifactStat,
  sessionIndexPath,
  type SessionIndexEntry,
} from './session-index.js'

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
  persistence: object,
  meta: object,
): Promise<void> {
  try {
    const location = persistenceLocate(persistence, meta)
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

/** Incremental listing so the picker can paint before older logs are parsed. */
export interface ResumableSessionListing {
  /** Sessions already inspected (or restored from the disk cache). */
  sessions: ResumableSession[]
  /** Whether older logs are still being inspected. */
  pending: boolean
}

function toResumable(item: InspectedSession): ResumableSession {
  const { hasUserInput: _hasUserInput, hasReply: _hasReply, ...rest } = item
  return rest
}

function indexFromInspected(item: InspectedSession, stat: { mtimeMs: number; size: number }): SessionIndexEntry {
  return {
    id: item.id,
    label: item.label,
    updatedAt: item.updatedAt,
    cwd: item.cwd,
    hasUserInput: item.hasUserInput,
    hasReply: item.hasReply,
    ...(item.unreadable === true ? { unreadable: true } : {}),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  }
}

function inspectedFromIndex(entry: SessionIndexEntry): InspectedSession {
  return {
    id: entry.id,
    label: entry.label,
    updatedAt: entry.updatedAt,
    cwd: entry.cwd,
    hasUserInput: entry.hasUserInput,
    hasReply: entry.hasReply,
    ...(entry.unreadable === true ? { unreadable: true } : {}),
  }
}

/**
 * List resumable top-level sessions, newest first.
 *
 * Subagent-owned sessions and the current session are excluded. Sessions
 * whose event log cannot be inspected are kept (marked `unreadable`) instead
 * of silently disappearing from history; readable sessions with user input
 * sort first. The label is the persisted title, then the user's first input,
 * then the id.
 * @param persistence - the session persistence service.
 * @param currentId - the live session to exclude (empty at launch).
 * @returns every resumable candidate in display order (attachable live
 *   hosts first, then readable logs, then unreadable).
 */
export async function listResumableSessions(
  persistence: object,
  currentId: string,
  listHosts: typeof listAttachableHosts = listAttachableHosts,
): Promise<ResumableSession[]> {
  const listing = await listResumableSessionsProgressive(persistence, currentId, { listHosts })
  return listing.complete
}

/**
 * List resumable sessions, painting the recent page first.
 *
 * `onUpdate` fires after the priority page (cached + newest logs) and again
 * after each later inspect batch. Unchanged logs reuse `$DSH_HOME/tui-session-index.json`.
 */
export async function listResumableSessionsProgressive(
  persistence: object,
  currentId: string,
  options: {
    listHosts?: typeof listAttachableHosts
    onUpdate?: (listing: ResumableSessionListing) => void
    indexPath?: string
    priorityCount?: number
  } = {},
): Promise<ResumableSessionListing & { complete: ResumableSession[] }> {
  const listHosts = options.listHosts ?? listAttachableHosts
  const indexPath = options.indexPath
    ?? process.env.DSH_TUI_SESSION_INDEX
    ?? sessionIndexPath()
  const priorityCount = options.priorityCount ?? PICKER_PRIORITY_COUNT
  const headers = await listPersistenceHeaders(persistence)
  const candidates = headers
    .filter(meta =>
      meta.id !== currentId
      && meta.cwd !== undefined
      && meta.origin !== 'subagent'
      && (meta.delegationDepth ?? 0) === 0)
    .sort((a, b) => b.createdAt - a.createdAt)

  const [index, hosts] = await Promise.all([
    loadSessionIndex(indexPath),
    listHosts(),
  ])
  const keepIds = new Set(candidates.map(meta => String(meta.id)))
  const indexSizeBefore = index.size
  pruneSessionIndex(index, keepIds)
  let indexDirty = index.size !== indexSizeBefore

  const sketchFromHeader = (meta: SessionHeaderLike): InspectedSession => {
    const cached = index.get(String(meta.id))
    const stat = sessionArtifactStat(persistence, meta)
    if (stat.size > 0 && indexEntryMatchesStat(cached, stat) && cached !== undefined) {
      return inspectedFromIndex(cached)
    }
    return {
      id: meta.id,
      label: cached?.label && cached.label !== '' ? cached.label : meta.id,
      updatedAt: cached?.updatedAt ?? meta.createdAt,
      cwd: meta.cwd ?? cached?.cwd ?? '',
      hasUserInput: cached?.hasUserInput ?? true,
      hasReply: cached?.hasReply ?? true,
    }
  }
  const sketched = candidates.map(meta => toResumable(sketchFromHeader(meta)))
  const sketchedById = new Map(sketched.map(item => [item.id, item]))
  for (const host of hosts) {
    if (host.sessionId === currentId) continue
    const attach = { pid: host.lock.pid, sock: host.sock, state: host.lock.state }
    const existing = sketchedById.get(host.sessionId)
    if (existing !== undefined) {
      existing.attach = attach
      continue
    }
    sketched.unshift({
      id: host.sessionId,
      label: host.sessionId,
      updatedAt: Date.parse(host.lock.startedAt) || Date.now(),
      cwd: '',
      attach,
    })
  }
  options.onUpdate?.({ sessions: sketched, pending: true })

  const inspectCandidate = async (meta: SessionHeaderLike): Promise<InspectedSession> => {
    try {
      const inspection = await inspectPersistenceSession(persistence, meta.id)
      const firstUserMessage = inspection.events.find(event => isUserMessageEvent(event)) as
        | { data?: { content?: readonly unknown[] } }
        | undefined
      const firstUserText = firstUserMessage === undefined
        ? undefined
        : Array.from(
            (firstUserMessage.data?.content ?? [])
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
      const last = inspection.events.at(-1) as { time?: number } | undefined
      const updatedAt = last?.time ?? meta.createdAt
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

  const resolveCandidate = async (meta: SessionHeaderLike): Promise<InspectedSession | undefined> => {
    const stat = sessionArtifactStat(persistence, meta)
    const cached = index.get(String(meta.id))
    // Fingerprint 0/0 means locate/stat failed: never treat that as a hit.
    if (stat.size > 0 && indexEntryMatchesStat(cached, stat) && cached !== undefined) {
      return inspectedFromIndex(cached)
    }
    const item = await inspectCandidate(meta)
    if (item.unreadable !== true && isBlankSession(item.hasUserInput, item.hasReply)) {
      index.delete(String(meta.id))
      indexDirty = true
      void pruneSessionArtifacts(persistence, meta)
      return undefined
    }
    if (stat.size > 0) {
      index.set(String(meta.id), indexFromInspected(item, stat))
      indexDirty = true
    }
    return item
  }

  const inspected: InspectedSession[] = []
  const blankLiveIds = new Set<string>()
  const extraLive = new Map<string, InspectedSession>()
  const mergeHosts = async (items: InspectedSession[]): Promise<InspectedSession[]> => {
    const resumable = items.filter(item => item.hasUserInput || item.unreadable === true)
    const byId = new Map(resumable.map(item => [item.id, item]))
    for (const host of hosts) {
      if (host.sessionId === currentId || blankLiveIds.has(host.sessionId)) continue
      const attach = { pid: host.lock.pid, sock: host.sock, state: host.lock.state }
      const existing = byId.get(host.sessionId) ?? extraLive.get(host.sessionId)
      if (existing !== undefined) {
        existing.attach = attach
        if (!byId.has(host.sessionId)) {
          resumable.push(existing)
          byId.set(host.sessionId, existing)
        }
        continue
      }
      // A live Host whose session never saw input nor a reply is a crashed
      // boot: stop it, remove its artifacts, and keep it out of the picker.
      let blankLive = false
      let liveHasUserInput = true
      try {
        const inspection = await inspectPersistenceSession(persistence, host.sessionId)
        const hasInput = inspection.events.some(event => isUserMessageEvent(event))
        blankLive = isBlankSession(hasInput, sessionHasReply(inspection.events))
        liveHasUserInput = hasInput
      } catch {
        blankLive = true
        liveHasUserInput = false
      }
      if (blankLive) {
        blankLiveIds.add(host.sessionId)
        try { process.kill(attach.pid, 'SIGTERM') } catch { /* already gone */ }
        const header = candidates.find(candidate => candidate.id === host.sessionId)
        if (header !== undefined) void pruneSessionArtifacts(persistence, header)
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
      extraLive.set(host.sessionId, injected)
      resumable.push(injected)
      byId.set(host.sessionId, injected)
    }
    resumable.sort((a, b) =>
      (a.attach === undefined ? 1 : 0) - (b.attach === undefined ? 1 : 0)
      || (a.unreadable === true ? 1 : 0) - (b.unreadable === true ? 1 : 0)
      || b.updatedAt - a.updatedAt)
    return resumable
  }
  const emit = async (pending: boolean): Promise<ResumableSession[]> => {
    const listed = (await mergeHosts(inspected)).map(toResumable)
    options.onUpdate?.({ sessions: listed, pending })
    return listed
  }

  // Newest page first so the picker can paint before older logs are parsed.
  const priority = candidates.slice(0, Math.max(0, priorityCount))
  const rest = candidates.slice(priority.length)
  const first = await Promise.all(priority.map(async meta => ({ meta, item: await resolveCandidate(meta) })))
  for (const { item } of first) {
    if (item !== undefined) inspected.push(item)
  }
  await emit(rest.length > 0)

  for (let offset = 0; offset < rest.length; offset += INSPECT_BATCH_SIZE) {
    const batch = rest.slice(offset, offset + INSPECT_BATCH_SIZE)
    const settled = await Promise.all(batch.map(async meta => ({ meta, item: await resolveCandidate(meta) })))
    for (const { item } of settled) {
      if (item !== undefined) inspected.push(item)
    }
    await emit(offset + INSPECT_BATCH_SIZE < rest.length)
  }

  const complete = (await mergeHosts(inspected)).map(toResumable)
  if (indexDirty) await saveSessionIndex(indexPath, index)
  options.onUpdate?.({ sessions: complete, pending: false })
  return { sessions: complete, pending: false, complete }
}
