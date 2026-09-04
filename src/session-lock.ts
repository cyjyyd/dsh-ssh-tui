/**
 * Exclusive lock so two TUI Hosts do not drive the same session.
 * Stale locks (dead pid) are stolen. A live lock with a reachable display
 * socket is an attach target, not a hard failure.
 */
import { access, readdir } from 'node:fs/promises'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { t } from './i18n/index.js'
import { sessionSockPath } from './display-sock.js'

export type SessionLockState = 'attached' | 'paused' | 'running-detached'
export type DisconnectPolicy = 'pause' | 'continue'
export type SessionLockAgentStatus = 'idle' | 'running' | 'cancelling'

export interface SessionLockInfo {
  pid: number
  sessionId: string
  startedAt: string
  tty?: string
  sock?: string
  state?: SessionLockState
  disconnectPolicy?: DisconnectPolicy
  agentStatus?: SessionLockAgentStatus
}

export class SessionLockHeldError extends Error {
  readonly lock: SessionLockInfo
  readonly path: string
  constructor(lock: SessionLockInfo, path: string) {
    super(formatLockHeldMessage(lock))
    this.name = 'SessionLockHeldError'
    this.lock = lock
    this.path = path
  }
}

export function sessionLockPath(sessionId: string, dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')): string {
  const safe = sessionId.replaceAll(/[^A-Za-z0-9._-]/g, '_')
  return join(dshHome, 'tui-locks', `${safe}.json`)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function parseSessionLock(raw: string): SessionLockInfo | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const pid = typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : undefined
    const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined
    if (pid === undefined || pid <= 0 || sessionId === undefined || sessionId === '') return undefined
    const state = parsed.state
    const policy = parsed.disconnectPolicy
    const agentStatus = parsed.agentStatus
    return {
      pid,
      sessionId,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      ...(optionalString(parsed.tty) !== undefined ? { tty: optionalString(parsed.tty) } : {}),
      ...(optionalString(parsed.sock) !== undefined ? { sock: optionalString(parsed.sock) } : {}),
      ...(state === 'attached' || state === 'paused' || state === 'running-detached' ? { state } : {}),
      ...(policy === 'pause' || policy === 'continue' ? { disconnectPolicy: policy } : {}),
      ...(agentStatus === 'idle' || agentStatus === 'running' || agentStatus === 'cancelling'
        ? { agentStatus }
        : {}),
    }
  } catch {
    return undefined
  }
}

/** True when `pid` still exists on this machine (best-effort). */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function formatLockHeldMessage(lock: SessionLockInfo): string {
  const tty = lock.tty === undefined ? '' : ` · ${lock.tty}`
  return t('lock.held', { session: lock.sessionId, pid: lock.pid, tty })
}

export function sessionLockDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DSH_TUI_NO_SESSION_LOCK === '1' || env.DSH_TUI_NO_SESSION_LOCK === 'true'
}

export async function readSessionLock(
  sessionId: string,
  dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh'),
): Promise<{ path: string; info: SessionLockInfo } | undefined> {
  const path = sessionLockPath(sessionId, dshHome)
  try {
    const info = parseSessionLock(await readFile(path, 'utf8'))
    if (info === undefined) return undefined
    return { path, info }
  } catch {
    return undefined
  }
}

export async function writeSessionLock(path: string, info: SessionLockInfo): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 })
}

export async function acquireSessionLock(
  sessionId: string,
  options: {
    pid?: number
    tty?: string | null
    dshHome?: string
    sock?: string
    state?: SessionLockState
    disconnectPolicy?: DisconnectPolicy
    agentStatus?: SessionLockAgentStatus
  } = {},
): Promise<{ path: string; info: SessionLockInfo }> {
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const path = sessionLockPath(sessionId, dshHome)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const info: SessionLockInfo = {
    pid: options.pid ?? process.pid,
    sessionId,
    startedAt: new Date().toISOString(),
    ...(options.tty ? { tty: options.tty } : {}),
    sock: options.sock ?? sessionSockPath(sessionId, dshHome),
    state: options.state ?? 'attached',
    disconnectPolicy: options.disconnectPolicy ?? 'pause',
    agentStatus: options.agentStatus ?? 'idle',
  }
  const payload = `${JSON.stringify(info, null, 2)}\n`
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await writeFile(path, payload, { flag: 'wx', mode: 0o600 })
      return { path, info }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let existing: SessionLockInfo | undefined
      try {
        existing = parseSessionLock(await readFile(path, 'utf8'))
      } catch {
        existing = undefined
      }
      const ours = options.pid ?? process.pid
      if (existing !== undefined && processIsAlive(existing.pid) && existing.pid !== ours) {
        throw new SessionLockHeldError(existing, path)
      }
      try {
        await unlink(path)
      } catch {
        // Raced with another unlock; retry exclusive create.
      }
    }
  }
  throw new Error(t('lock.busy', { path }))
}

export async function releaseSessionLock(path: string, pid = process.pid): Promise<void> {
  try {
    const current = parseSessionLock(await readFile(path, 'utf8'))
    if (current !== undefined && current.pid !== pid) return
    await unlink(path)
  } catch {
    // Missing lock is fine.
  }
}

export type LiveHostKind = 'attachable' | 'zombie'

export async function inspectLiveHost(
  sessionId: string,
  dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh'),
): Promise<{ kind: LiveHostKind; lock: SessionLockInfo; path: string; sock: string } | undefined> {
  const held = await readSessionLock(sessionId, dshHome)
  if (held === undefined) return undefined
  return inspectHeldLock(held.path, held.info, dshHome)
}

async function inspectHeldLock(
  path: string,
  info: SessionLockInfo,
  dshHome: string,
): Promise<{ kind: LiveHostKind; lock: SessionLockInfo; path: string; sock: string } | undefined> {
  const sock = info.sock ?? sessionSockPath(info.sessionId, dshHome)
  const alive = processIsAlive(info.pid)
  let sockExists = false
  try {
    await access(sock, fsConstants.F_OK)
    sockExists = true
  } catch {
    sockExists = false
  }
  if (!alive) {
    // Host is gone. A leftover unix socket is not attachable — steal the
    // lock so --resume can reopen from the session log.
    if (sockExists) {
      try {
        await unlink(sock)
      } catch {
        // Stale socket; resume-from-log still works without it.
      }
    }
    try {
      await unlink(path)
    } catch {
      // Missing lock is fine.
    }
    return undefined
  }
  if (!sockExists) return { kind: 'zombie', lock: info, path, sock }
  return { kind: 'attachable', lock: info, path, sock }
}

/** Every lock file under `$DSH_HOME/tui-locks` whose Host pid is still alive. */
export async function listAttachableHosts(
  dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh'),
): Promise<Array<{ sessionId: string; lock: SessionLockInfo; sock: string }>> {
  let names: string[] = []
  try {
    names = await readdir(join(dshHome, 'tui-locks'))
  } catch {
    return []
  }
  const found: Array<{ sessionId: string; lock: SessionLockInfo; sock: string }> = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(dshHome, 'tui-locks', name)
    let info: SessionLockInfo | undefined
    try {
      info = parseSessionLock(await readFile(path, 'utf8'))
    } catch {
      continue
    }
    if (info === undefined) continue
    const live = await inspectHeldLock(path, info, dshHome)
    if (live?.kind !== 'attachable') continue
    found.push({ sessionId: live.lock.sessionId, lock: live.lock, sock: live.sock })
  }
  return found
}
