/**
 * Exclusive lock so two TUI processes do not drive the same session.
 * Stale locks (dead pid) are stolen. Live locks tell the user to attach tmux.
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { t } from './i18n/index.js'

export interface SessionLockInfo {
  pid: number
  sessionId: string
  startedAt: string
  tty?: string
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

export function parseSessionLock(raw: string): SessionLockInfo | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const pid = typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : undefined
    const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined
    if (pid === undefined || pid <= 0 || sessionId === undefined || sessionId === '') return undefined
    return {
      pid,
      sessionId,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      ...(typeof parsed.tty === 'string' && parsed.tty !== '' ? { tty: parsed.tty } : {}),
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

export async function acquireSessionLock(
  sessionId: string,
  options: { pid?: number; tty?: string | null; dshHome?: string } = {},
): Promise<{ path: string; info: SessionLockInfo }> {
  const path = sessionLockPath(sessionId, options.dshHome)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const info: SessionLockInfo = {
    pid: options.pid ?? process.pid,
    sessionId,
    startedAt: new Date().toISOString(),
    ...(options.tty ? { tty: options.tty } : {}),
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
