/**
 * `/diag`: one command that answers "why can't I get in?" with local facts only.
 *
 * Every reconnect/zombie/first-attach report so far took a hand-written probe to
 * explain: which lock file exists, whether its pid is really the Host, whether
 * the display channel answers, whether the artifact is a dead socket file left
 * by a killed Host. This module turns that probe into a product surface.
 *
 * The renderer is pure — it takes one already-collected snapshot and produces
 * the transcript lines, including the decision chain — so it is unit-testable
 * without a Host, a lock, or a filesystem. Collection (which does touch the
 * filesystem) lives in `collectDiag`, and every probe is best-effort: a failing
 * probe reports its failure rather than breaking the command.
 *
 * Nothing here leaves the machine: it prints versions, paths, and states.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { t } from './i18n/index.js'
import {
  displaySockExists,
  isPipePath,
  resolveDshHome,
  sessionErrPath,
  sessionSockPath,
} from './display-sock.js'
import { inspectLiveHost, sessionLockDisabled, sessionLockPath } from './session-lock.js'
import { sessionIndexPath } from './session-index.js'

/** How much of a Host stderr log the report carries. */
export const DIAG_ERR_TAIL_BYTES = 2000

export interface DiagHostState {
  /** 'none' — no lock file; 'live' — owner alive and channel reachable;
   *  'zombie' — owner alive but the channel does not answer;
   *  'stale' — lock exists but its owner is gone (stealable). */
  kind: 'none' | 'live' | 'zombie' | 'stale'
  pid?: number
  /** Lock state as written by the Host (`attached`/`paused`/`running-detached`). */
  state?: string
  agentStatus?: string
  disconnectPolicy?: string
  tty?: string
  /** Owner identity check: 'verified', 'mismatch', or 'unverifiable'. */
  identity?: 'verified' | 'mismatch' | 'unverifiable'
  lockPath?: string
  path: string
}

export interface DiagSnapshot {
  pluginVersion: string
  hostVersion: string
  nodeVersion: string
  platform: string
  sessionId: string
  /** This process is the detached Host rather than the launcher. */
  hostProcess: boolean
  locksDisabled: boolean
  dshHome: string
  sockPath: string
  /** `true` when a connect to the channel succeeded. */
  sockReachable: boolean
  /** A socket *file* exists on disk (POSIX only; pipes are invisible to fs). */
  sockFilePresent?: boolean
  host: DiagHostState
  link: {
    kind: 'ssh' | 'local'
    rttMs?: number
    probeState: 'measured' | 'unknown' | 'unprobed'
    paintIntervalMs?: number
  }
  lockHeldByThisProcess: boolean
  sessionLog?: {
    format: string
    bytes: number
    modifiedAt?: number
    events?: number
    seq?: number
  }
  /** Last lines the Host wrote to its stderr log, if any. */
  errTail?: string
  /** Locks found under DSH_HOME for *other* sessions (context for "who holds it"). */
  otherLocks: Array<{ sessionId: string; pid: number; state?: string }>
}

/** Tail of a Host stderr log, or undefined when there is nothing to read. */
export async function readErrTail(
  sessionId: string,
  dshHome = resolveDshHome(),
): Promise<string | undefined> {
  try {
    const raw = await readFile(sessionErrPath(sessionId, dshHome), 'utf8')
    const trimmed = raw.trim()
    if (trimmed === '') return undefined
    return trimmed.length <= DIAG_ERR_TAIL_BYTES ? trimmed : `…${trimmed.slice(-DIAG_ERR_TAIL_BYTES)}`
  } catch {
    return undefined
  }
}

/**
 * Why `--resume` would behave the way it does, as an ordered chain of verdicts.
 * The first entry is the actionable one; the rest is supporting context.
 */
export function diagVerdicts(snapshot: DiagSnapshot): string[] {
  const verdicts: string[] = []
  const { host } = snapshot

  if (host.kind === 'zombie') {
    verdicts.push(t('diag.v.zombie', { pid: String(host.pid ?? '?') }))
    verdicts.push(t('diag.v.zombieHint'))
  } else if (host.kind === 'live') {
    verdicts.push(t('diag.v.live', { pid: String(host.pid ?? '?') }))
    verdicts.push(t('diag.v.liveHint'))
  } else if (host.kind === 'stale') {
    verdicts.push(t('diag.v.stale', { pid: String(host.pid ?? '?') }))
    verdicts.push(t('diag.v.staleHint'))
  } else {
    verdicts.push(t('diag.v.free'))
  }

  if (host.identity === 'mismatch') {
    verdicts.push(t('diag.v.pidReused', { pid: String(host.pid ?? '?') }))
  } else if (host.identity === 'unverifiable' && host.pid !== undefined) {
    verdicts.push(t('diag.v.pidUnverified', { pid: String(host.pid) }))
  }

  // A socket file that exists but does not answer is the classic "first attach
  // dies with EPIPE, the second works" residue of a killed Host.
  if (snapshot.sockFilePresent === true && !snapshot.sockReachable) {
    verdicts.push(t('diag.v.deadSock'))
  }
  if (snapshot.errTail !== undefined && host.kind !== 'none') {
    verdicts.push(t('diag.v.errTail'))
  }
  if (snapshot.hostProcess) {
    verdicts.push(t('diag.v.thisIsHost'))
  }
  if (snapshot.locksDisabled) {
    verdicts.push(t('diag.v.locksOff'))
  }
  if (snapshot.link.probeState === 'unknown' && snapshot.link.kind === 'ssh') {
    verdicts.push(t('diag.v.rttUnknown'))
  }
  if (snapshot.host.state === 'running-detached') {
    verdicts.push(t('diag.v.detachedBusy'))
  }
  return verdicts
}

/** The whole report as transcript lines. Pure. */
export function formatDiag(snapshot: DiagSnapshot): string[] {
  const yes = t('diag.yes')
  const no = t('diag.no')
  const lines: string[] = []
  lines.push(t('diag.title'))
  lines.push(t('diag.rowVersions', {
    plugin: snapshot.pluginVersion,
    dsh: snapshot.hostVersion,
    node: snapshot.nodeVersion,
  }))
  lines.push(t('diag.rowPlatform', { platform: snapshot.platform }))
  lines.push(t('diag.rowSession', { session: snapshot.sessionId }))
  lines.push(t('diag.rowRole', {
    role: snapshot.hostProcess ? t('diag.roleHost') : t('diag.roleLauncher'),
    home: snapshot.dshHome,
  }))
  lines.push(t('diag.rowChannel', {
    path: snapshot.sockPath,
    kind: isPipePath(snapshot.sockPath) ? t('diag.channelPipe') : t('diag.channelSocket'),
    reachable: snapshot.sockReachable ? yes : no,
    file: snapshot.sockFilePresent === undefined
      ? t('diag.fileNotApplicable')
      : snapshot.sockFilePresent ? yes : no,
  }))
  lines.push(t('diag.rowHost', {
    kind: t(`diag.host.${snapshot.host.kind}`),
    pid: snapshot.host.pid === undefined ? '—' : String(snapshot.host.pid),
    identity: snapshot.host.identity === undefined ? '—' : t(`diag.identity.${snapshot.host.identity}`),
    state: snapshot.host.state ?? '—',
    agent: snapshot.host.agentStatus ?? '—',
  }))
  if (snapshot.host.lockPath !== undefined) {
    lines.push(t('diag.rowLockPath', { path: snapshot.host.lockPath }))
  }
  lines.push(t('diag.rowLink', {
    kind: snapshot.link.kind === 'ssh' ? 'SSH' : t('diag.linkLocal'),
    rtt: snapshot.link.rttMs === undefined ? '—' : `${snapshot.link.rttMs}ms`,
    probe: t(`diag.probe.${snapshot.link.probeState}`),
    paint: snapshot.link.paintIntervalMs === undefined ? '—' : `${snapshot.link.paintIntervalMs}ms`,
  }))
  if (snapshot.sessionLog === undefined) {
    lines.push(t('diag.rowLog', { format: t('diag.logMissing') }))
  } else {
    lines.push(t('diag.rowLog', {
      format: t('diag.logPresent', {
        format: snapshot.sessionLog.format,
        bytes: String(snapshot.sessionLog.bytes),
        events: snapshot.sessionLog.events === undefined ? '?' : String(snapshot.sessionLog.events),
        seq: snapshot.sessionLog.seq === undefined ? '?' : String(snapshot.sessionLog.seq),
      }),
    }))
  }
  lines.push(t('diag.rowLocks', {
    held: snapshot.lockHeldByThisProcess ? yes : no,
    others: String(snapshot.otherLocks.length),
  }))
  for (const other of snapshot.otherLocks.slice(0, 5)) {
    lines.push(t('diag.rowOtherLock', {
      session: other.sessionId,
      pid: String(other.pid),
      state: other.state ?? '—',
    }))
  }
  lines.push('')
  lines.push(t('diag.verdictsTitle'))
  for (const verdict of diagVerdicts(snapshot)) lines.push(`  · ${verdict}`)
  if (snapshot.errTail !== undefined) {
    lines.push('')
    lines.push(t('diag.errTitle'))
    for (const line of snapshot.errTail.split('\n').slice(-12)) lines.push(`  ${line}`)
  }
  return lines
}

/** Gather everything the report needs. Every probe is best-effort. */
export async function collectDiag(options: {
  sessionId: string
  pluginVersion: string
  hostVersion: string
  hostProcess: boolean
  link: DiagSnapshot['link']
  paintIntervalMs?: number
  dshHome?: string
}): Promise<DiagSnapshot> {
  const dshHome = options.dshHome ?? resolveDshHome()
  const sockPath = sessionSockPath(options.sessionId, dshHome)
  const lockPath = sessionLockPath(options.sessionId, dshHome)

  const reachable = await displaySockExists(sockPath)
  let sockFilePresent: boolean | undefined
  if (!isPipePath(sockPath)) {
    sockFilePresent = await stat(sockPath).then(() => true).catch(() => false)
  }

  const live = await inspectLiveHost(options.sessionId, dshHome).catch(() => undefined)
  const host: DiagHostState = live === undefined
    ? { kind: 'none', path: lockPath }
    : {
        kind: live.kind === 'attachable' ? 'live' : 'zombie',
        pid: live.lock.pid,
        ...(live.lock.state === undefined ? {} : { state: live.lock.state }),
        ...(live.lock.agentStatus === undefined ? {} : { agentStatus: live.lock.agentStatus }),
        ...(live.lock.disconnectPolicy === undefined ? {} : { disconnectPolicy: live.lock.disconnectPolicy }),
        ...(live.lock.tty === undefined ? {} : { tty: live.lock.tty }),
        identity: 'verified',
        lockPath: live.path,
        path: live.sock,
      }
  // `inspectLiveHost` steals a dead lock, so a lock file that exists while the
  // inspection found nothing is the stale case.
  if (host.kind === 'none') {
    const raw = await readFile(lockPath, 'utf8').then(text => text, () => undefined)
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as { pid?: number; state?: string; agentStatus?: string }
        host.kind = 'stale'
        if (typeof parsed.pid === 'number') host.pid = parsed.pid
        if (typeof parsed.state === 'string') host.state = parsed.state
        if (typeof parsed.agentStatus === 'string') host.agentStatus = parsed.agentStatus
        host.lockPath = lockPath
      } catch {
        // An unreadable lock is reported as no lock.
      }
    }
  }

  const log = await sessionLogInfo(options.sessionId)
  const errTail = await readErrTail(options.sessionId, dshHome)

  return {
    ...(log === undefined ? {} : { sessionLog: log }),
    ...(errTail === undefined ? {} : { errTail }),
    pluginVersion: options.pluginVersion,
    hostVersion: options.hostVersion,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    sessionId: options.sessionId,
    hostProcess: options.hostProcess,
    locksDisabled: sessionLockDisabled(),
    dshHome,
    sockPath,
    sockReachable: reachable,
    ...(sockFilePresent === undefined ? {} : { sockFilePresent }),
    host,
    link: options.paintIntervalMs === undefined
      ? options.link
      : { ...options.link, paintIntervalMs: options.paintIntervalMs },
    lockHeldByThisProcess: host.kind !== 'none' && host.pid === process.pid,
    otherLocks: await listOtherLocks(options.sessionId, dshHome),
  }
}

/** Locks under DSH_HOME belonging to other sessions, for the report's context. */
async function listOtherLocks(
  sessionId: string,
  dshHome: string,
): Promise<DiagSnapshot['otherLocks']> {
  const dir = join(dshHome, 'tui-locks')
  const names = await readdir(dir).catch(() => [] as string[])
  const others: DiagSnapshot['otherLocks'] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as {
        sessionId?: unknown
        pid?: unknown
        state?: unknown
      }
      if (typeof parsed.sessionId !== 'string' || parsed.sessionId === sessionId) continue
      if (typeof parsed.pid !== 'number') continue
      others.push({
        sessionId: parsed.sessionId,
        pid: parsed.pid,
        ...(typeof parsed.state === 'string' ? { state: parsed.state } : {}),
      })
    } catch {
      // A corrupt lock is not this report's business.
    }
  }
  return others
}

/** Directory holding the per-session index, for callers that report it. */
export function diagIndexPath(dshHome = resolveDshHome()): string {
  return sessionIndexPath(dshHome)
}

/** Size and last-seq of one session artifact, when it has materialized. */
async function sessionLogInfo(sessionId: string): Promise<DiagSnapshot['sessionLog']> {
  const roots = await readdir(join(dshHomeDir(), 'sessions')).catch(() => [] as string[])
  for (const project of roots) {
    const dir = join(dshHomeDir(), 'sessions', project, sessionId)
    const names = await readdir(dir).catch(() => [] as string[])
    const log = names.find(name => name.startsWith('session.v') && name.includes('.jsonl'))
    if (log === undefined) continue
    const info = await stat(join(dir, log)).catch(() => undefined)
    if (info === undefined) continue
    // The last persisted seq is read from the tail of the decompressed log by
    // the caller's own persistence layer; here the durable file facts are
    // enough to answer "did this session ever materialize, and how big".
    const format = log.replace(/^session\./, '').replace(/\.jsonl(\.zstd)?$/, '')
    return {
      format: `${format}${log.endsWith('.zstd') ? ' zstd' : ''}`,
      bytes: info.size,
      modifiedAt: info.mtimeMs,
    }
  }
  return undefined
}

/** DSH_HOME resolved once, so the probes below cannot disagree about it. */
function dshHomeDir(): string {
  return resolveDshHome()
}
