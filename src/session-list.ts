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
  /**
   * `label` is a placeholder (the raw session id) because the log has not been
   * inspected yet. The picker holds these back instead of painting an id that
   * turns into a title two seconds later.
   */
  labelPending?: boolean
}

/** `MM-DD HH:mm` local-time label for session lists. */
export function formatSessionTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Whether one durable event is a message put in front of the model.
 *
 * Any source counts, not just `kind: 'user'`: cron continuations, goal nudges
 * and context snapshots are plugin-authored `user/message` events, and a
 * session carrying one is not a crashed boot. Treating those as "no input"
 * made a live mid-turn session look blank — and a blank verdict deletes the
 * session's directory and stops its Host.
 */
function isUserMessageEvent(event: unknown): boolean {
  return (event as { type?: string }).type === 'user/message'
}

/** A turn that started and never ended: the session is mid-work, never blank. */
function hasUnfinishedTurn(events: readonly unknown[]): boolean {
  let open = 0
  for (const event of events) {
    const type = (event as { type?: string }).type
    if (type === 'turn/start') open += 1
    else if (type === 'turn/end') open -= 1
  }
  return open > 0
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
 * The persisted generated title, else the user's first input (trimmed to one
 * short line). `undefined` means the log carries no name of its own and the
 * caller's fallback (usually the id) has to stand in.
 */
function labelFromEvents(events: readonly unknown[]): string | undefined {
  const titleEvent = [...events].reverse()
    .find(event => (event as { type?: string }).type === 'session/title')
  const title = titleEvent === undefined
    ? undefined
    : (titleEvent as unknown as { data?: { title?: string } }).data?.title
  if (title !== undefined && title !== '') return title
  const firstUserMessage = events.find(event => isUserMessageEvent(event)) as
    | { data?: { content?: readonly unknown[] } }
    | undefined
  if (firstUserMessage === undefined) return undefined
  const text = Array.from(
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
  return text === '' ? undefined : text
}

/**
 * A blank session never saw user input nor a model reply — a boot that died
 * before doing anything. Such sessions are deleted (never listed as
 * resumable) so crashed launches stop littering the picker with raw ids.
 */
function isBlankSession(hasUserInput: boolean, hasReply: boolean, unfinishedTurn = false): boolean {
  return !hasUserInput && !hasReply && !unfinishedTurn
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
type InspectedSession = ResumableSession & {
  hasUserInput: boolean
  hasReply: boolean
  /** A turn is still open: the log is mid-work and must never be pruned. */
  hasUnfinishedTurn?: boolean
}

/** Incremental listing so a caller can paint before older logs are parsed. */
export interface ResumableSessionListing {
  /** Sessions already inspected (or restored from the disk cache). */
  sessions: ResumableSession[]
  /** Whether older logs are still being inspected. */
  pending: boolean
}

/** One lazy page: everything read so far, plus what is still uninspected. */
export interface ResumableSessionPage {
  /** Resolved sessions in display order; a label here is never a placeholder. */
  sessions: ResumableSession[]
  /** Candidates not inspected yet (an upper bound on rows still to come). */
  remaining: number
  /** No candidates are left to inspect. */
  done: boolean
}

/**
 * A listing that grows on demand.
 *
 * The picker reads one page, paints it, and only reads on when the user reaches
 * for older sessions. A launch used to inspect every log before the first
 * frame, which is what made a large history feel like a hang; the first page
 * alone also has every title resolved, so nothing on screen is ever a raw id
 * that turns into a title a second later.
 */
export interface ResumableSessionPager {
  /** Inspect onward until `size` more rows exist, or history runs out. */
  page(size?: number): Promise<ResumableSessionPage>
  /** Read every remaining candidate (the `/resume` flow wants the whole list). */
  complete(): Promise<ResumableSession[]>
}

/** Sessions read before the picker's first paint, and per lazy page after it. */
export const PICKER_PAGE_SIZE = 9

function toResumable(item: InspectedSession): ResumableSession {
  const { hasUserInput: _hasUserInput, hasReply: _hasReply, hasUnfinishedTurn: _unfinished, ...rest } = item
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
 * One pass over the store: the header sketch, the cached labels, the attachable
 * hosts, and an inspection cursor that advances page by page.
 *
 * The lazy pager, the progressive listing and the full `/resume` list all drive
 * this, so the hardening lives in exactly one place: a failed or `detached`
 * read is never treated as a blank session, and a blank one is only pruned
 * after it was positively read.
 */
class ResumableSessionSource {
  private cursor = 0
  private indexDirty = false
  private readonly inspected: InspectedSession[] = []
  private readonly blankLiveIds = new Set<string>()
  private readonly extraLive = new Map<string, InspectedSession>()

  private constructor(
    private readonly persistence: object,
    private readonly currentId: string,
    private readonly candidates: SessionHeaderLike[],
    private readonly hosts: Awaited<ReturnType<typeof listAttachableHosts>>,
    private readonly index: Map<string, SessionIndexEntry>,
    private readonly indexPath: string,
  ) {}

  static async open(
    persistence: object,
    currentId: string,
    options: { listHosts?: typeof listAttachableHosts; indexPath?: string } = {},
  ): Promise<ResumableSessionSource> {
    const listHosts = options.listHosts ?? listAttachableHosts
    const indexPath = options.indexPath
      ?? process.env.DSH_TUI_SESSION_INDEX
      ?? sessionIndexPath()
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
    const source = new ResumableSessionSource(
      persistence, currentId, candidates, hosts, index, indexPath,
    )
    source.indexDirty = index.size !== indexSizeBefore
    return source
  }

  /** Header-only view: cached labels where known, the id (marked) for the rest. */
  sketch(): ResumableSession[] {
    const sketchFromHeader = (meta: SessionHeaderLike): InspectedSession => {
      const cached = this.index.get(String(meta.id))
      const stat = sessionArtifactStat(this.persistence, meta)
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
        // Nothing but the header has been read yet: the label is the id.
        labelPending: true,
      }
    }
    const sketched = this.candidates.map(meta => toResumable(sketchFromHeader(meta)))
    const sketchedById = new Map(sketched.map(item => [item.id, item]))
    for (const host of this.hosts) {
      if (host.sessionId === this.currentId) continue
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
        // A live Host whose header never made it into the candidate list has no
        // inspectable label yet either.
        labelPending: true,
      })
    }
    return sketched
  }

  /** Candidates this source has not inspected yet. */
  get remaining(): number {
    return this.candidates.length - this.cursor
  }

  /** Take the next `count` headers, in order. They are consumed by `resolve`. */
  peek(count: number): SessionHeaderLike[] {
    const batch = this.candidates.slice(this.cursor, this.cursor + Math.max(0, Math.floor(count)))
    this.cursor += batch.length
    return batch
  }

  /**
   * Inspect candidates until `count` rows were added, or history runs out.
   * A batch is read concurrently, but the rows keep the candidate order.
   */
  async take(count: number): Promise<void> {
    let added = 0
    while (added < count && this.cursor < this.candidates.length) {
      const size = Math.min(Math.max(1, count - added), INSPECT_BATCH_SIZE)
      const batch = this.peek(size)
      const settled = await Promise.all(batch.map(async meta => this.resolve(meta)))
      for (const item of settled) {
        if (item === undefined || !this.showable(item)) continue
        this.inspected.push(item)
        added += 1
      }
    }
  }

  /**
   * Whether a resolved row will actually be shown. A session with a reply but
   * no input of its own is not a picker row; counting it as one made a page
   * report rows it never painted (and, when nothing else was left, made the
   * picker believe the history was empty).
   */
  private showable(item: InspectedSession): boolean {
    return item.hasUserInput || item.unreadable === true
  }

  /** Keep a resolved row in the display list. */
  add(item: InspectedSession): void {
    if (!this.showable(item)) return
    this.inspected.push(item)
  }

  /** Resolve one header into a row. Blank sessions are pruned and skipped. */
  async resolve(meta: SessionHeaderLike): Promise<InspectedSession | undefined> {
    const stat = sessionArtifactStat(this.persistence, meta)
    const cached = this.index.get(String(meta.id))
    // Fingerprint 0/0 means locate/stat failed: never treat that as a hit.
    if (stat.size > 0 && indexEntryMatchesStat(cached, stat) && cached !== undefined) {
      return inspectedFromIndex(cached)
    }
    const item = await this.inspectCandidate(meta)
    if (item.unreadable !== true
      && isBlankSession(item.hasUserInput, item.hasReply, item.hasUnfinishedTurn === true)) {
      this.index.delete(String(meta.id))
      this.indexDirty = true
      void pruneSessionArtifacts(this.persistence, meta)
      return undefined
    }
    if (stat.size > 0) {
      this.index.set(String(meta.id), indexFromInspected(item, stat))
      this.indexDirty = true
    }
    return item
  }

  private async inspectCandidate(meta: SessionHeaderLike): Promise<InspectedSession> {
    try {
      const inspection = await inspectPersistenceSession(this.persistence, meta.id)
      // A `detached` slice (the writer is in this process and has not
      // materialized the artifact yet) or an empty one is an unreadable log,
      // never a blank session. Calling it blank made a listing delete a live
      // session's directory; keep it visible and let resume report the truth.
      if (inspection.eventState === 'detached' || inspection.events.length === 0) {
        const cached = this.index.get(String(meta.id))
        return {
          id: meta.id,
          label: cached?.label && cached.label !== '' ? cached.label : meta.id,
          updatedAt: cached?.updatedAt ?? meta.createdAt,
          cwd: meta.cwd ?? cached?.cwd ?? '',
          hasUserInput: cached?.hasUserInput ?? false,
          hasReply: cached?.hasReply ?? false,
          unreadable: true,
        }
      }
      const last = inspection.events.at(-1) as { time?: number } | undefined
      const updatedAt = last?.time ?? meta.createdAt
      return {
        id: meta.id,
        // The persisted generated title first: the web session list shows the
        // same `session/title` value, so both surfaces name a session alike
        // and switching between them stays findable. First user input is the
        // fallback for sessions whose title has not been generated yet.
        label: labelFromEvents(inspection.events) ?? meta.id,
        updatedAt,
        cwd: meta.cwd ?? '',
        hasUserInput: inspection.events.some(event => isUserMessageEvent(event)),
        hasReply: sessionHasReply(inspection.events),
        ...(hasUnfinishedTurn(inspection.events) ? { hasUnfinishedTurn: true } : {}),
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

  /**
   * The display list: the rows read so far with the attachable hosts merged in.
   * Attachable hosts come first, then readable logs newest-first, then the
   * unreadable ones (they may still be resumable, so they stay selectable).
   */
  async listing(): Promise<ResumableSession[]> {
    const resumable = this.inspected.filter(item => this.showable(item))
    const byId = new Map(resumable.map(item => [item.id, item]))
    for (const host of this.hosts) {
      if (host.sessionId === this.currentId || this.blankLiveIds.has(host.sessionId)) continue
      const attach = { pid: host.lock.pid, sock: host.sock, state: host.lock.state }
      const existing = byId.get(host.sessionId) ?? this.extraLive.get(host.sessionId)
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
      // Only a positively read, materialized blank log counts. A failed or
      // detached read is unknown — acting on it (SIGTERM + prune) removed a
      // live session's directory before.
      let blankLive = false
      let unreadableLive = false
      let liveHasUserInput = false
      let liveLabel: string | undefined
      try {
        const inspection = await inspectPersistenceSession(this.persistence, host.sessionId)
        const materialized = inspection.eventState !== 'detached' && inspection.events.length > 0
        if (!materialized) {
          unreadableLive = true
        } else {
          const hasInput = inspection.events.some(event => isUserMessageEvent(event))
          blankLive = isBlankSession(
            hasInput,
            sessionHasReply(inspection.events),
            hasUnfinishedTurn(inspection.events),
          )
          liveHasUserInput = hasInput
          // A Host that is running but absent from the header list still has a
          // log; read its title rather than offering the user a raw uuid.
          liveLabel = labelFromEvents(inspection.events)
        }
      } catch {
        // A read failure is not evidence of a blank boot either: keep the live
        // Host attachable instead of killing it and pruning its log.
        unreadableLive = true
      }
      if (blankLive) {
        this.blankLiveIds.add(host.sessionId)
        try { process.kill(attach.pid, 'SIGTERM') } catch { /* already gone */ }
        const header = this.candidates.find(candidate => candidate.id === host.sessionId)
        if (header !== undefined) void pruneSessionArtifacts(this.persistence, header)
        continue
      }
      const injected: InspectedSession = {
        id: host.sessionId,
        // No readable log means no title: say so instead of showing a uuid the
        // user cannot recognise (and let the tail of the id still be searched).
        label: liveLabel ?? (unreadableLive ? t('picker.noLogLabel', { short: host.sessionId.slice(-8) }) : host.sessionId),
        updatedAt: Date.parse(host.lock.startedAt) || Date.now(),
        cwd: '',
        hasUserInput: liveHasUserInput || unreadableLive,
        hasReply: true,
        ...(unreadableLive ? { unreadable: true } : {}),
        attach,
      }
      this.extraLive.set(host.sessionId, injected)
      resumable.push(injected)
      byId.set(host.sessionId, injected)
    }
    resumable.sort((a, b) =>
      (a.attach === undefined ? 1 : 0) - (b.attach === undefined ? 1 : 0)
      || (a.unreadable === true ? 1 : 0) - (b.unreadable === true ? 1 : 0)
      || b.updatedAt - a.updatedAt)
    return resumable.map(toResumable)
  }

  async emit(
    pending: boolean,
    onUpdate?: (listing: ResumableSessionListing) => void,
  ): Promise<ResumableSession[]> {
    const listed = await this.listing()
    onUpdate?.({ sessions: listed, pending })
    return listed
  }

  /**
   * Persist the labels read so far. Flushed after every page: a picker the user
   * closed (or a `/resume` that ran while the Host booted) must not leave the
   * next listing without titles again.
   */
  async flushIndex(): Promise<void> {
    if (!this.indexDirty) return
    await saveSessionIndex(this.indexPath, this.index)
    this.indexDirty = false
  }
}

/**
 * Open a pager over the store. Nothing is inspected until the first `page()`.
 */
export async function openResumableSessionPager(
  persistence: object,
  currentId: string,
  options: { listHosts?: typeof listAttachableHosts; indexPath?: string } = {},
): Promise<ResumableSessionPager> {
  const source = await ResumableSessionSource.open(persistence, currentId, options)
  return {
    page: async (size = PICKER_PAGE_SIZE): Promise<ResumableSessionPage> => {
      // `take` counts only showable rows, so a page that comes back with no
      // rows is a page the history is exhausted by — never a page whose rows
      // were filtered out after being counted.
      const wanted = Number.isFinite(size) && size > 0 ? Math.floor(size) : PICKER_PAGE_SIZE
      await source.take(wanted)
      await source.flushIndex()
      return {
        sessions: await source.listing(),
        remaining: source.remaining,
        done: source.remaining === 0,
      }
    },
    complete: async (): Promise<ResumableSession[]> => {
      await source.take(Number.POSITIVE_INFINITY)
      const sessions = await source.listing()
      await source.flushIndex()
      return sessions
    },
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
  const pager = await openResumableSessionPager(persistence, currentId, { listHosts })
  return pager.complete()
}

/**
 * List resumable sessions, painting the recent page first.
 *
 * `onUpdate` fires after the header sketch, after the first resolved title, and
 * again after each later inspect batch. Unchanged logs reuse
 * `$DSH_HOME/tui-session-index.json`.
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
  const source = await ResumableSessionSource.open(persistence, currentId, options)
  options.onUpdate?.({ sessions: source.sketch(), pending: true })

  const priorityCount = options.priorityCount ?? PICKER_PRIORITY_COUNT
  const priority = source.peek(priorityCount)
  // Paint the first real title as soon as it exists instead of waiting for the
  // whole newest page. With a cold index that is the difference between a
  // loading line and a list the user can already pick from.
  let firstPainted = false
  const first = await Promise.all(priority.map(async meta => {
    const item = await source.resolve(meta)
    // Only a caller that paints progressively gets the early frame.
    if (!firstPainted && item !== undefined && source.remaining > 0 && options.onUpdate !== undefined) {
      firstPainted = true
      source.add(item)
      await source.flushIndex()
      await source.emit(true, options.onUpdate)
      return { item, painted: true }
    }
    return { item, painted: false }
  }))
  for (const { item, painted } of first) {
    if (item !== undefined && !painted) source.add(item)
  }
  await source.flushIndex()
  await source.emit(source.remaining > 0, options.onUpdate)

  while (source.remaining > 0) {
    const batch = source.peek(INSPECT_BATCH_SIZE)
    const settled = await Promise.all(batch.map(async meta => source.resolve(meta)))
    for (const item of settled) {
      if (item !== undefined) source.add(item)
    }
    await source.emit(source.remaining > 0, options.onUpdate)
  }

  const complete = await source.listing()
  await source.flushIndex()
  options.onUpdate?.({ sessions: complete, pending: false })
  return { sessions: complete, pending: false, complete }
}
