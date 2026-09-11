/**
 * Exclusive lock so two TUI Hosts do not drive the same session.
 * Stale locks (dead pid) are stolen. A live lock with a reachable display
 * socket is an attach target, not a hard failure.
 */
import { readdir } from 'node:fs/promises'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { t } from './i18n/index.js'
import { displaySockExists, isPipePath, resolveDshHome, sessionSockPath } from './display-sock.js'

export type SessionLockState = 'attached' | 'paused' | 'running-detached'
export type DisconnectPolicy = 'pause' | 'continue'
export type SessionLockAgentStatus = 'idle' | 'running' | 'cancelling'

export interface SessionLockInfo {
  pid: number
  sessionId: string
  startedAt: string
  /** `/proc/sys/kernel/random/boot_id` when the lock was taken (POSIX only). */
  bootId?: string
  /** `/proc/<pid>/stat` starttime (field 22) of `pid` when the lock was taken. */
  pidStart?: string
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

export function sessionLockPath(sessionId: string, dshHome = resolveDshHome()): string {
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
      ...(optionalString(parsed.bootId) !== undefined ? { bootId: optionalString(parsed.bootId) } : {}),
      ...(optionalString(parsed.pidStart) !== undefined ? { pidStart: optionalString(parsed.pidStart) } : {}),
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

/** `/proc/sys/kernel/random/boot_id` or undefined where procfs is unavailable (win32). */
function readBootId(): string | undefined {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    return undefined
  }
}

/** `/proc/<pid>/stat` starttime (field 22) or undefined when unreadable/gone. */
function readProcStarttime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (close === -1) return undefined
    const fields = stat.slice(close + 2).split(' ')
    return fields[22 - 3]
  } catch {
    return undefined
  }
}

function readProcCmdline(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
  } catch {
    return undefined
  }
}

/** Slice of a Windows process identity needed to rule out pid reuse. */
export interface WindowsProcessIdentity {
  /** Executable name without `.exe`, lowercased (`node`). */
  name: string
  /** Process creation time in epoch milliseconds, when readable. */
  startedAt?: number
}

/** Clock/resolution slack when comparing a creation time with the lock write. */
export const PID_REUSE_SLACK_MS = 5_000

/**
 * Cache of Windows identities so one lock costs at most one probe per window.
 *
 * Keyed by pid *and* the lock instance that was inspected: scoping it to the
 * lock (not just the pid) is what keeps a recycled pid from being judged by an
 * identity it no longer has — a foreign cached identity applied to a fresh
 * lock would declare a live Host stale and let a second Host write the same
 * session. The short TTL bounds the same hazard for repeated inspections of
 * one lock.
 */
const WINDOWS_IDENTITY_TTL_MS = 10_000
const windowsIdentityCache = new Map<number, { identity: WindowsProcessIdentity; at: number; lockKey: string }>()

function lockInstanceKey(lock: SessionLockInfo): string {
  return `${lock.pid}:${lock.startedAt}`
}

/**
 * Parse the probe's stdout. Everything after the last non-empty line is
 * ignored (a stray warning banner must not masquerade as the image name), and
 * an unexpected shape is reported as "unverifiable" rather than as a
 * mismatch: mistaking noise for a foreign process would steal a live lock.
 */
export function parseWindowsProcessIdentity(stdout: string): WindowsProcessIdentity | undefined {
  // Keep the raw line: the tab between name and timestamp is the shape being
  // validated, and trimming whitespace off the end would delete it (a trailing
  // tab means "name known, creation time unreadable", which is still useful).
  const line = stdout.split('\n')
    .map(entry => entry.replace(/\r$/u, ''))
    .reverse()
    .find(entry => entry.trim() !== '')
  if (line === undefined || line.trim() === 'gone') return undefined
  const trimmed = line.trimStart()
  const tab = trimmed.indexOf('\t')
  if (tab <= 0) return undefined
  const name = trimmed.slice(0, tab).trim().toLowerCase()
  if (!/^[a-z0-9_.-]+$/u.test(name)) return undefined
  const startedAt = Date.parse(trimmed.slice(tab + 1).trim())
  return { name, ...Number.isFinite(startedAt) ? { startedAt } : {} }
}

/** Absolute Windows PowerShell, for hosts where the bare name is not on PATH. */
function systemPowerShell(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/**
 * `Get-Process` beats WMI here: it is a single .NET call that reports both the
 * image name (works across users) and the creation time. The script avoids
 * double quotes so Node's CreateProcess quoting stays trivial, and formats the
 * timestamp with the invariant culture so native-digit locales cannot turn it
 * into NaN.
 */
async function queryWindowsProcess(pid: number): Promise<WindowsProcessIdentity | undefined> {
  const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; `
    + `if ($null -eq $p) { 'gone' } else { `
    + `$st = ''; try { $st = $p.StartTime.ToUniversalTime().ToString('yyyy-MM-dd\\THH\\:mm\\:ss.fff\\Z', [System.Globalization.CultureInfo]::InvariantCulture) } catch {}; `
    + `$p.ProcessName.ToLower() + [char]9 + $st }`
  for (const exe of ['powershell.exe', systemPowerShell()]) {
    const stdout = await runPowerShell(exe, script)
    // `undefined` means the interpreter could not run at all (missing,
    // blocked, timed out); a readable answer — including `gone` — is final.
    if (stdout === undefined) continue
    return parseWindowsProcessIdentity(stdout)
  }
  return undefined
}

/**
 * Async on purpose: this runs on the TUI's render path (`/resume` lists every
 * lock), where a synchronous spawn would freeze painting and keystrokes for
 * the whole probe.
 */
function runPowerShell(exe: string, script: string): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error !== null) {
        resolve(undefined)
        return
      }
      resolve(typeof stdout === 'string' ? stdout : '')
    })
  })
}

async function windowsProcessIdentity(lock: SessionLockInfo): Promise<WindowsProcessIdentity | undefined> {
  const key = lockInstanceKey(lock)
  const cached = windowsIdentityCache.get(lock.pid)
  if (cached !== undefined && cached.lockKey === key && Date.now() - cached.at < WINDOWS_IDENTITY_TTL_MS) {
    return cached.identity
  }
  const identity = await queryWindowsProcess(lock.pid)
  // Only successful probes are cached: a transient failure must not make the
  // pid look permanently dead for the rest of this process's life.
  if (identity === undefined) {
    windowsIdentityCache.delete(lock.pid)
    return undefined
  }
  if (windowsIdentityCache.size > 64) windowsIdentityCache.clear()
  windowsIdentityCache.set(lock.pid, { identity, at: Date.now(), lockKey: key })
  return identity
}

/** Image name this Host runs as (`node` / `dsh`), without `.exe`. */
export function hostImageName(execPath = process.execPath): string {
  // Split on both separators: the Windows probe's answer is compared on any
  // platform, and tests may feed a Windows-style path from POSIX.
  const file = execPath.split(/[\\/]/u).pop() ?? execPath
  return file.replace(/\.exe$/iu, '').toLowerCase()
}

/**
 * Decide whether a live Windows pid can still be the lock's Host.
 *
 * Windows recycles pids aggressively, and without procfs an unrelated process
 * inheriting the recorded pid used to look like a permanent live-but-silent
 * Host ("zombie"), which blocked `--resume` until the lock was deleted by
 * hand. Two facts rule reuse out:
 *  - the Host always runs this same executable, so a different image name is
 *    someone else's process;
 *  - the Host existed before it wrote the lock, so a process created after the
 *    lock was written cannot be its owner.
 * An unverifiable process keeps the legacy best-effort answer (alive).
 */
export function windowsProcessMatchesLock(
  lock: SessionLockInfo,
  identity: WindowsProcessIdentity | undefined,
  expectedName: string = hostImageName(),
  slackMs: number = PID_REUSE_SLACK_MS,
): boolean {
  if (identity === undefined) return true
  const lockStarted = Date.parse(lock.startedAt)
  if (identity.startedAt !== undefined && Number.isFinite(lockStarted)) {
    // The Host existed before it wrote the lock, so a process created after
    // that cannot be its owner. The timeline answers on its own, which also
    // covers a Host launched by a different runtime (bun vs node) or a renamed
    // executable: only a pid the OS recycled can post-date the lock.
    return identity.startedAt <= lockStarted + slackMs
  }
  // No comparable timeline: the image name is the only signal left, and a
  // mismatch there is weak enough that "unverifiable" is the safer answer.
  if (identity.name !== '' && expectedName !== '' && identity.name !== expectedName) return false
  return true
}

/**
 * True when `pid` is genuinely the Host process that wrote `lock`.
 *
 * `processIsAlive` alone is not enough: the pid may have been recorded inside
 * a different pid namespace (sandbox/container) and then be recycled by an
 * unrelated host process — e.g. a lock written as pid 5 in a sandbox matches
 * the forever-alive pid 5 kernel thread on the host, which used to produce a
 * permanent false "zombie" that blocked `--resume`. We therefore verify the
 * process identity:
 *  - new locks carry `bootId` + `pidStart` (boot_id + /proc/<pid>/stat
 *    starttime): a matching pair can only be the same process on the same
 *    boot, so a recycled or cross-namespace pid fails the check;
 *  - older locks fall back to `/proc/<pid>/cmdline`: the detached Host is
 *    always launched with `--resume=<sessionId>` in argv, so any other
 *    process (kernel threads have an empty cmdline) is proven stale;
 *  - Windows has neither: a `Get-Process` probe supplies the image name and
 *    creation time instead (see {@link windowsProcessMatchesLock}).
 * On platforms where none of this is available the legacy kill(pid, 0)
 * behavior is kept.
 *
 * Async because the Windows probe spawns PowerShell, and this runs on the
 * render path (`/resume` inspects every lock); a synchronous spawn would
 * freeze painting and keystrokes for the duration of the probe.
 */
export async function lockOwnerIsAlive(lock: SessionLockInfo): Promise<boolean> {
  const pid = lock.pid
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (!processIsAlive(pid)) return false
  if (process.platform === 'win32') {
    return windowsProcessMatchesLock(lock, await windowsProcessIdentity(lock))
  }
  if (lock.bootId !== undefined && lock.pidStart !== undefined) {
    return readBootId() === lock.bootId && readProcStarttime(pid) === lock.pidStart
  }
  const cmdline = readProcCmdline(pid)
  if (cmdline === undefined) return true // no /proc (darwin): legacy best-effort
  return cmdline.includes(`--resume=${lock.sessionId}`)
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
  dshHome = resolveDshHome(),
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
  const dshHome = options.dshHome ?? resolveDshHome()
  const path = sessionLockPath(sessionId, dshHome)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const pid = options.pid ?? process.pid
  const bootId = readBootId()
  const pidStart = bootId !== undefined ? readProcStarttime(pid) : undefined
  const info: SessionLockInfo = {
    pid,
    sessionId,
    startedAt: new Date().toISOString(),
    ...(bootId !== undefined ? { bootId } : {}),
    ...(pidStart !== undefined ? { pidStart } : {}),
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
      if (existing !== undefined && existing.pid !== ours && await lockOwnerIsAlive(existing)) {
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
  dshHome = resolveDshHome(),
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
  // A Windows named pipe is not a filesystem entry: fs.access() can never see
  // it, so liveness must be probed with a connect (and it needs no unlink —
  // Windows removes the pipe when the owning process exits). A reachable pipe
  // also proves the owner is alive, so the pid identity probe can be skipped.
  const sockExists = await displaySockExists(sock)
  const alive = (isPipePath(sock) && sockExists) || await lockOwnerIsAlive(info)
  if (!alive) {
    // Host is gone. A leftover unix socket is not attachable — steal the
    // lock so --resume can reopen from the session log, and remove the dead
    // directory entry: the reachability probe cannot report it as ready, so
    // it is cleaned by path (a Windows pipe is not a file entry and is
    // already reclaimed by the OS).
    if (!isPipePath(sock)) {
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
  dshHome = resolveDshHome(),
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
