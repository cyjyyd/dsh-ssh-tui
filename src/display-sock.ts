/**
 * Length-prefixed local-socket frames between a leftover Host and a new
 * Display relay. Binary on purpose: paint bytes are raw ANSI, not JSON.
 *
 * Transport: an AF_UNIX socket at `$DSH_HOME/tui-socks/<id>.sock` on POSIX,
 * and a named pipe at `\\.\pipe\dsh-tui-<home>-<id>` on Windows. Node requires
 * the `\\.\pipe\` form there — a plain file path cannot be listened on — and
 * `fs.access()` cannot see pipes, so channel liveness always goes through
 * `displaySockExists()` instead of a raw filesystem check.
 *
 * Frame: u32be length | u8 type | payload
 *   1 stdin   — relay → host (key bytes)
 *   2 stdout  — host → relay (paint bytes)
 *   3 resize  — relay → host (u16be cols | u16be rows)
 *   4 hello   — either side, payload ignored
 *   5 goodbye — host → relay, then close (user /exit)
 *   6 rtt     — relay → host (u32be milliseconds; 0xffffffff = unknown)
 *   7 replaced — host → relay, then close (a newer Display took the session)
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { createHash } from 'node:crypto'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { closeSync, constants as fsConstants, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { TerminalInputFilter, TerminalInputPump } from './terminal-input.js'
import { dirname, join, resolve } from 'node:path'

export const FRAME_STDIN = 1
export const FRAME_STDOUT = 2
export const FRAME_RESIZE = 3
export const FRAME_HELLO = 4
export const FRAME_GOODBYE = 5
export const FRAME_RTT = 6
export const FRAME_REPLACED = 7

const MAX_FRAME = 1024 * 1024

/**
 * Grace period for a kicked relay to read FRAME_REPLACED before its socket is
 * torn down. Without the frame the relay only saw `close`, read it as "the
 * Host is going away", and re-attached — two SSH windows then kicked each
 * other off the display forever, repainting the whole screen on every lap.
 */
const REPLACED_GRACE_MS = 250

/**
 * How long a connection may stay silent before the Host treats it as a
 * liveness probe and drops it. A relay measures the terminal round-trip
 * *before* its HELLO (see `runDisplayRelay`), so this has to cover the whole
 * probe — and it must stay well under the launcher's own attach timeout.
 */
const DISPLAY_HELLO_GRACE_MS = 3_000

/**
 * Drop launcher SIGTERM/SIGINT/SIGHUP so closing SSH cannot dispose the tree
 * before hangup handling. Leaving the session with setsid() is best-effort:
 * a TTY session leader gets EPERM and stays in the SSH process group.
 */
export function detachFromSshSession(): void {
  try {
    const setsid = (process as NodeJS.Process & { setsid?: () => number }).setsid
    setsid?.()
  } catch {
    // EPERM when already the session leader (typical under SSH).
  }
  const ignore = (): void => {}
  for (const name of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) {
    process.removeAllListeners(name)
    process.on(name, ignore)
  }
}

export const TUI_HOST_ENV = 'DSH_TUI_HOST'

export function isTuiHostProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TUI_HOST_ENV] === '1' || env[TUI_HOST_ENV] === 'true'
}

/**
 * Windows named-pipe namespace. Node's `net` passes the string straight to
 * CreateNamedPipeW/CreateFileW, and those require this prefix — a drive-letter
 * path fails with ENOENT/EACCES and the Host never listens.
 */
export const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\'

/** Windows rejects pipe names longer than 256 chars; leave generous headroom. */
const WINDOWS_PIPE_MAX = 200

/** True for a Windows named-pipe address (`\\.\pipe\x`, `\\?\pipe\x`, `//./pipe/x`). */
export function isPipePath(path: string): boolean {
  const normalized = path.replaceAll('/', '\\').toLowerCase()
  return normalized.startsWith('\\\\.\\pipe\\') || normalized.startsWith('\\\\?\\pipe\\')
}

/**
 * `DSH_HOME` the way dsh itself resolves it: a blank value counts as unset, and
 * the result is absolute. Both matter here because the launcher and the
 * detached Host compute channel names independently and the Host chdirs into
 * the session's working directory first — a relative or empty home would give
 * them two different sockets (or pipe names) and time the launch out.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.DSH_HOME?.trim()
  return resolve(configured !== undefined && configured !== '' ? configured : join(home, '.dsh'))
}

function defaultDshHome(): string {
  return resolveDshHome()
}

/** Directory holding per-session display runtime state (error logs). */
export function sessionSockDir(dshHome: string = defaultDshHome()): string {
  return join(dshHome, 'tui-socks')
}

/** Filesystem/pipe-safe form of a session id, as used for locks and channels. */
export function safeSessionId(sessionId: string): string {
  const safe = sessionId.replaceAll(/[^A-Za-z0-9._-]/g, '_')
  return safe === '' ? 'session' : safe
}

/**
 * Readable, collision-free short label for one session: a sanitized head plus a
 * digest of the raw id. The digest is always appended because sanitizing alone
 * collapses distinct ids (`abc`, `abc.`, `_abc`, `abc..`) into one name, and on
 * Windows the pipe namespace is machine-wide — the collapsed forms would share
 * a channel and a relay could attach to the wrong session.
 */
function sessionLabel(sessionId: string, maxLength: number): string {
  const digest = createHash('sha1').update(sessionId).digest('hex').slice(0, 8)
  const head = safeSessionId(sessionId)
    .replaceAll(/\.{2,}/gu, '_')
    .replace(/^[._-]+|[._-]+$/gu, '')
    .slice(0, Math.max(0, maxLength - digest.length - 1))
  return `${head === '' ? 'session' : head}-${digest}`
}

/**
 * Named pipes live in one flat, machine-wide namespace, so the DSH_HOME is
 * folded into the name (two homes must not fight over one session id) and the
 * label is clamped with a digest so long ids stay unique instead of truncated
 * into collisions.
 */
function windowsPipePath(sessionId: string, dshHome: string): string {
  const homeTag = createHash('sha1').update(resolve(dshHome).toLowerCase()).digest('hex').slice(0, 8)
  const room = WINDOWS_PIPE_MAX - WINDOWS_PIPE_PREFIX.length - 'dsh-tui-'.length - homeTag.length - 1
  return `${WINDOWS_PIPE_PREFIX}dsh-tui-${homeTag}-${sessionLabel(sessionId, room)}`
}

/**
 * Address of the per-session display channel: a filesystem path on POSIX, a
 * named pipe on Windows. `platform` is injectable so the Windows shape stays
 * testable from a POSIX test run.
 */
export function sessionSockPath(
  sessionId: string,
  dshHome: string = defaultDshHome(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') return windowsPipePath(sessionId, dshHome)
  return join(sessionSockDir(dshHome), `${safeSessionId(sessionId)}.sock`)
}

/**
 * Host stderr log for one session. POSIX keeps the historical `<sock>.err`
 * next to the socket; a Windows pipe name is not a file path, so the log lives
 * in the `tui-socks` state directory instead — under the same digested label,
 * which also keeps long ids inside the Windows path limit and keeps reserved
 * device names (`CON`, `NUL`, …) from becoming the file stem.
 */
export function sessionErrPath(
  sessionId: string,
  dshHome: string = defaultDshHome(),
  platform: NodeJS.Platform = process.platform,
): string {
  const sock = sessionSockPath(sessionId, dshHome, platform)
  if (isPipePath(sock)) return join(sessionSockDir(dshHome), `${sessionLabel(sessionId, 64)}.err`)
  return `${sock}.err`
}

export function encodeFrame(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (type < 1 || type > 255) throw new Error(`dsh-ssh-tui: invalid frame type ${type}`)
  if (payload.length > MAX_FRAME) throw new Error('dsh-ssh-tui: frame too large')
  const header = Buffer.alloc(5)
  header.writeUInt32BE(1 + payload.length, 0)
  header.writeUInt8(type, 4)
  return Buffer.concat([header, payload])
}

export function encodeResize(columns: number, rows: number): Buffer {
  const payload = Buffer.alloc(4)
  payload.writeUInt16BE(Math.max(0, Math.min(0xffff, columns)), 0)
  payload.writeUInt16BE(Math.max(0, Math.min(0xffff, rows)), 2)
  return encodeFrame(FRAME_RESIZE, payload)
}

export function decodeResize(payload: Buffer): { columns: number; rows: number } | undefined {
  if (payload.length < 4) return undefined
  return { columns: payload.readUInt16BE(0), rows: payload.readUInt16BE(2) }
}

export function encodeRtt(rttMs: number | undefined): Buffer {
  const payload = Buffer.alloc(4)
  payload.writeUInt32BE(
    rttMs === undefined || !Number.isFinite(rttMs) || rttMs < 0 ? 0xffffffff : Math.min(0xfffffffe, Math.round(rttMs)),
    0,
  )
  return encodeFrame(FRAME_RTT, payload)
}

export function decodeRtt(payload: Buffer): number | undefined {
  if (payload.length < 4) return undefined
  const value = payload.readUInt32BE(0)
  return value === 0xffffffff ? undefined : value
}

/** Incremental decoder for one socket. */
export class FrameReader {
  private buffer = Buffer.alloc(0)

  push(chunk: Buffer): Array<{ type: number; payload: Buffer }> {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const frames: Array<{ type: number; payload: Buffer }> = []
    while (this.buffer.length >= 5) {
      const length = this.buffer.readUInt32BE(0)
      if (length < 1 || length > MAX_FRAME + 1) {
        throw new Error(`dsh-ssh-tui: invalid frame length ${length}`)
      }
      if (this.buffer.length < 4 + length) break
      const type = this.buffer.readUInt8(4)
      const payload = this.buffer.subarray(5, 4 + length)
      this.buffer = this.buffer.subarray(4 + length)
      frames.push({ type, payload })
    }
    return frames
  }
}

export interface DisplayHostHandlers {
  onStdin(bytes: Buffer): void
  onResize(columns: number, rows: number): void
  onRtt?(rttMs: number | undefined): void
  onDetach(info?: { replaced?: boolean }): void
  onAttach(): void
}

/**
 * Turn a raw listen() errno into an actionable message. Windows pipe failures
 * are opaque (`ENOENT` for a bad name, `EACCES`/`EADDRINUSE` for a pipe that a
 * live Host already owns), so name the likely cause.
 */
function wrapListenError(error: NodeJS.ErrnoException, path: string, pipe: boolean): Error {
  const code = error.code ?? error.message
  const hint = pipe && (code === 'EADDRINUSE' || code === 'EACCES' || code === 'EPERM')
    ? ' (another dsh-ssh-tui host may already own this session)'
    : ''
  const wrapped = new Error(`dsh-ssh-tui: cannot listen on display socket ${path} (${code})${hint}`)
  ;(wrapped as NodeJS.ErrnoException).code = error.code
  return wrapped
}

/**
 * Host-side listener. At most one Display is attached; a new hello kicks the
 * previous relay so two SSH windows cannot both drive the session.
 */
export class DisplayHost {
  private server: Server | undefined
  private socket: Socket | undefined
  private reader = new FrameReader()
  attached = false

  constructor(
    readonly path: string,
    private readonly handlers: DisplayHostHandlers,
    /** Test seam: how long a silent connection may wait for its HELLO. */
    private readonly options: { helloGraceMs?: number } = {},
  ) {}

  async listen(): Promise<void> {
    const pipe = isPipePath(this.path)
    if (!pipe) {
      // Pipes are not files: they need no directory, cannot be unlinked, and
      // vanish with the owning process.
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      try {
        await unlink(this.path)
      } catch {
        // missing is fine
      }
    }
    await new Promise<void>((resolve, reject) => {
      const server = createServer(socket => this.accept(socket))
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening)
        reject(wrapListenError(error, this.path, pipe))
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        this.server = server
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.path)
    })
  }

  private accept(socket: Socket): void {
    const reader = new FrameReader()
    let claimed = false
    const dropProbe = (): void => {
      if (claimed) return
      socket.destroy()
    }
    const claim = (): void => {
      if (claimed) return
      claimed = true
      if (this.socket !== undefined && this.socket !== socket) {
        const previous = this.socket
        this.socket = undefined
        this.attached = false
        // Tell the old relay *why* it is being dropped before the socket goes
        // away. It used to see a bare `close`, report `host-closed`, and retry
        // the attach — so two SSH windows kicked each other off the display in
        // a loop, each lap repainting the full screen and leaving the TTY in
        // cooked mode long enough to echo the replies still in flight.
        // Flush before reaping: if the relay is slow to read (a stalled event
        // loop, a paused process) the frame would still be in this socket's
        // buffer when the backstop below destroys it, and the kicked relay
        // would see a bare close — the retry this frame exists to prevent.
        const reap = setTimeout(() => {
          try {
            previous.destroy()
          } catch {
            // already gone
          }
        }, REPLACED_GRACE_MS)
        reap.unref?.()
        try {
          previous.end(encodeFrame(FRAME_REPLACED), () => {
            clearTimeout(reap)
            try {
              previous.destroy()
            } catch {
              // already gone
            }
          })
        } catch {
          clearTimeout(reap)
          try {
            previous.destroy()
          } catch {
            // already gone
          }
        }
        // Replacing a Display is not an SSH hangup. The previous socket's
        // `close` handler must not fire onDetach after we already claimed
        // the new relay — that would idle-exit a leftover Host the user
        // just reattached to.
        this.handlers.onDetach({ replaced: true })
      }
      this.reader = reader
      this.socket = socket
      this.attached = true
      this.handlers.onAttach()
      try {
        socket.write(encodeFrame(FRAME_HELLO))
      } catch {
        drop()
      }
    }
    const drop = (): void => {
      if (!claimed) return
      if (this.socket !== socket) return
      this.socket = undefined
      this.attached = false
      this.handlers.onDetach()
    }
    socket.on('data', chunk => {
      let frames: Array<{ type: number; payload: Buffer }>
      try {
        frames = reader.push(chunk)
      } catch {
        socket.destroy()
        return
      }
      for (const frame of frames) {
        if (frame.type === FRAME_HELLO) claim()
        else if (!claimed) continue
        else if (frame.type === FRAME_STDIN) this.handlers.onStdin(frame.payload)
        else if (frame.type === FRAME_RESIZE) {
          const size = decodeResize(frame.payload)
          if (size !== undefined) this.handlers.onResize(size.columns, size.rows)
        } else if (frame.type === FRAME_RTT) {
          this.handlers.onRtt?.(decodeRtt(frame.payload))
        }
      }
    })
    socket.on('close', () => {
      if (claimed) drop()
    })
    socket.on('error', () => {
      if (claimed) drop()
      else dropProbe()
    })
    // A connect() with no HELLO is a liveness probe; do not steal the display.
    const probeGrace = setTimeout(dropProbe, this.options.helloGraceMs ?? DISPLAY_HELLO_GRACE_MS)
    probeGrace.unref?.()
  }

  sendStdout(bytes: Buffer | string): boolean {
    const socket = this.socket
    if (socket === undefined || this.attached !== true) return false
    const payload = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes
    try {
      socket.write(encodeFrame(FRAME_STDOUT, payload))
      return true
    } catch {
      return false
    }
  }

  sendGoodbye(): void {
    const socket = this.socket
    if (socket === undefined) return
    try {
      socket.write(encodeFrame(FRAME_GOODBYE))
    } catch {
      // ignore
    }
  }

  async close(): Promise<void> {
    this.sendGoodbye()
    const socket = this.socket
    this.socket = undefined
    this.attached = false
    socket?.destroy()
    const server = this.server
    this.server = undefined
    await new Promise<void>(resolve => {
      if (server === undefined) {
        resolve()
        return
      }
      server.close(() => resolve())
    })
    if (!isPipePath(this.path)) {
      try {
        await unlink(this.path)
      } catch {
        // ignore
      }
    }
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * True once a Host is actually accepting on the display channel.
 *
 * Always a real connect, never a filesystem check: a leftover `.sock` file
 * (killed Host, or one that is mid-dispose) is a directory entry, not a peer,
 * and `fs.access()` used to report it as ready — the launcher then wrote HELLO
 * into a dead socket and the first reconnect after a drop died with
 * `write EPIPE`. Windows pipes additionally cannot be seen by `fs.access` at
 * all. The Host treats a connect without HELLO as a liveness probe and drops
 * it without stealing the display.
 */
export async function displaySockExists(path: string, timeoutMs = 250): Promise<boolean> {
  return await probeDisplaySock(path, timeoutMs)
}

/** Watches a freshly spawned Host so a crash is reported immediately. */
export interface HostExitWatch {
  /** Resolves with the exit code (or null when killed) once the Host exits. */
  readonly exited: Promise<number | null>
  /** Stop watching; call once the channel is confirmed up. */
  dispose(): void
}

function watchHostExit(child: ChildProcess): HostExitWatch {
  let settle: (code: number | null) => void = () => {}
  const exited = new Promise<number | null>(resolve => { settle = resolve })
  const onExit = (code: number | null): void => { settle(code) }
  const onError = (): void => { settle(null) }
  child.once('exit', onExit)
  child.once('error', onError)
  return {
    exited,
    dispose(): void {
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
    },
  }
}

export async function waitForDisplaySock(
  path: string,
  timeoutMs = 15_000,
  pid?: number,
  errFile?: string,
  exitWatch?: HostExitWatch,
): Promise<void> {
  const readDetail = async (): Promise<string> => {
    if (errFile === undefined) return ''
    try {
      const detail = (await readFile(errFile, 'utf8')).trim()
      await unlink(errFile)
      return detail
    } catch {
      return ''
    }
  }
  const exitedWith = (detail: string): Error => {
    const suffix = detail !== '' ? `:\n${detail}` : ''
    return new Error(`dsh-ssh-tui: host process pid ${pid ?? '?'} exited before display socket appeared${suffix}`)
  }
  const deadline = Date.now() + timeoutMs
  let hostExited = false
  let hostExitCode: number | null = null
  if (exitWatch !== undefined) {
    void exitWatch.exited.then(code => {
      hostExited = true
      hostExitCode = code
    })
  }
  while (Date.now() < deadline) {
    if (await displaySockExists(path)) {
      if (errFile !== undefined) {
        try { await unlink(errFile) } catch { /* ignore */ }
      }
      return
    }
    if (hostExited) {
      // The pid may still answer kill(pid, 0) on Windows while the handle is
      // open, so trust the exit event: fail fast instead of waiting 15s.
      const detail = await readDetail()
      const reason = hostExitCode === null ? '' : ` (exit code ${hostExitCode})`
      const suffix = detail !== '' ? `:\n${detail}` : ''
      throw new Error(
        `dsh-ssh-tui: host process pid ${pid ?? '?'} exited before display socket appeared${reason}${suffix}`,
      )
    }
    if (pid !== undefined && !isPidAlive(pid)) {
      throw exitedWith(await readDetail())
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const detail = await readDetail()
  const suffix = detail !== '' ? `:\n${detail}` : ''
  throw new Error(`dsh-ssh-tui: host display socket did not appear: ${path}${suffix}`)
}

export function hostArgvForSession(sessionId: string, argv = process.argv.slice(1), execArgv = process.execArgv): string[] {
  const args = [...execArgv, ...argv]
  const filtered: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg === 'resume' || arg === '--resume') {
      const next = args[index + 1]
      if (next !== undefined && !next.startsWith('-')) index += 1
      continue
    }
    if (arg.startsWith('--resume=')) continue
    if (arg === '--new') continue
    filtered.push(arg)
  }
  filtered.push(`--resume=${sessionId}`)
  return filtered
}

export interface SpawnedHost {
  pid: number
  /** Channel address: a socket file on POSIX, a named pipe on Windows. */
  sock: string
  /** Host stderr log; present when it could be opened. */
  errFile?: string
  /** Exit watch so a Host that dies before listening is reported at once. */
  exitWatch: HostExitWatch
}

/**
 * Keep what the user types while no display exists yet.
 *
 * A fresh Host takes a moment to boot; the launcher used to leave stdin flowing
 * with nobody listening, so every key pressed in that window was dropped. The
 * capture strips cursor replies (it is the same stream the relay will probe)
 * and hands the rest to the relay as its `seed`.
 */
export function captureTerminalInput(stdin: NodeJS.ReadStream = process.stdin): { stop(): string } {
  const filter = new TerminalInputFilter()
  const decoder = new StringDecoder('utf8')
  let kept = ''
  const onData = (chunk: Buffer): void => {
    const text = filter.push(decoder.write(chunk)).forward
    if (text === '') return
    kept += text
    if (kept.length > MAX_CAPTURED_INPUT) kept = kept.slice(-MAX_CAPTURED_INPUT)
  }
  try {
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.on('data', onData)
  } catch {
    // A dying TTY cannot be captured; the seed stays empty.
  }
  return {
    stop(): string {
      try {
        stdin.removeListener('data', onData)
        // Pause rather than leave the stream flowing with no listener: bytes
        // typed between here and the relay's own `resume()` would otherwise be
        // discarded instead of waiting for it.
        stdin.pause()
      } catch {
        // ignore
      }
      const tail = (() => {
        try {
          return decoder.end()
        } catch {
          return ''
        }
      })()
      const text = filter.flush() + tail
      return text === '' ? kept : kept + text
    },
  }
}

/** Longest typing burst carried across a Host boot. */
const MAX_CAPTURED_INPUT = 8 * 1024

/**
 * Keep the terminal quiet while the launcher retries or waits for a Host.
 *
 * Between attempts the TTY is back in cooked mode, so a DSR reply still in
 * flight from the previous probe is echoed to the screen as `^[[17;1R`-style
 * garbage. Raw mode plus a drain swallows those bytes instead: they are either
 * stale replies or keys typed before any display existed, and neither should
 * reach the shell.
 */
export function quietTerminalInput(stdin: NodeJS.ReadStream = process.stdin): number {
  let dropped = 0
  try {
    stdin.setRawMode?.(true)
    stdin.resume()
    for (;;) {
      const chunk = stdin.read() as Buffer | null
      if (chunk === null) break
      dropped += chunk.length
    }
  } catch {
    // A dying TTY cannot be quieted; nothing to do.
  }
  return dropped
}

/** Spawn a detached Host copy of this `dsh` invocation and return its sock path. */
export function spawnDetachedHost(sessionId: string): SpawnedHost {
  const sock = sessionSockPath(sessionId)
  // On Windows the channel is a pipe name, which is not a file path: the log
  // must live in the state directory next to the locks instead.
  const errFile = sessionErrPath(sessionId)
  let errFd: number | undefined
  try {
    mkdirSync(dirname(errFile), { recursive: true, mode: 0o700 })
    errFd = openSync(errFile, 'w')
  } catch {
    errFd = undefined
  }
  const child = spawn(process.execPath, hostArgvForSession(sessionId), {
    // DSH_HOME is pinned to the resolved absolute path: the Host chdirs into
    // the session's working directory before it listens, so an unset, blank or
    // relative home would otherwise resolve differently there and the two
    // processes would compute different channel names.
    env: { ...process.env, [TUI_HOST_ENV]: '1', DSH_HOME: resolveDshHome() },
    detached: true,
    // A detached Host has no console on Windows; hide the console window that
    // would otherwise flash on screen when it is created.
    windowsHide: true,
    stdio: ['ignore', 'ignore', errFd ?? 'ignore'],
  })
  if (errFd !== undefined) {
    try { closeSync(errFd) } catch { /* ignore */ }
  }
  if (child.pid === undefined) throw new Error('dsh-ssh-tui: failed to spawn host process')
  const exitWatch = watchHostExit(child)
  child.unref()
  return { pid: child.pid, sock, exitWatch, ...errFd !== undefined ? { errFile } : {} }
}

export async function probeDisplaySock(path: string, timeoutMs = 400): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = createConnection(path)
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      finish(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      finish(false)
    })
  })
}

export interface RelayResult {
  /** Host sent goodbye — user exited from the attached session. */
  reason: 'goodbye' | 'host-closed' | 'signal' | 'replaced'
}

/** Typing that arrives while the relay is still measuring is kept, then sent. */
const MAX_PENDING_INPUT = 64 * 1024

/** Terminal and signal sources; injectable so a test can drive the relay. */
export interface DisplayRelayOptions {
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  signals?: Pick<NodeJS.Process, 'on' | 'off' | 'removeListener'>
  /** Link kind for the RTT probe; defaults to this process's SSH env. */
  ssh?: boolean
  /** Typing captured before this relay existed; sent to the Host after HELLO. */
  seed?: string
  /**
   * The waiting status line currently on screen, if the launcher announced one.
   * It is erased here — after the measurement, before the Host's first paint —
   * so the picker's screen does not sit frozen while the probe runs.
   */
  announce?: boolean
}

/**
 * Turn this process into a Display relay until the Host hangs up or the
 * local TTY dies. Restores the terminal before resolving.
 */
export async function runDisplayRelay(
  path: string,
  options: DisplayRelayOptions = {},
): Promise<RelayResult> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const signals = options.signals ?? process
  const useAltScreen = process.env.DSH_TUI_NO_ALT_SCREEN !== '1'
    && process.env.DSH_TUI_NO_ALT_SCREEN !== 'true'
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path)
    const reader = new FrameReader()
    let settled = false
    let live = false
    // Set when the Host tells us a newer Display took this session over. The
    // terminal restore below is the one write that must NOT happen then: this
    // relay no longer owns any screen, and if the link is dead (window killed,
    // laptop asleep, network dropped) those escape bytes sit in the connection
    // and are flushed onto that user's terminal the moment it comes back — the
    // "character leak on entry" line, exactly when they resumed in a new window.
    let replaced = false
    const pending: Buffer[] = []
    let pendingBytes = 0
    if (options.seed !== undefined && options.seed !== '') {
      const seed = Buffer.from(options.seed, 'utf8')
      pending.push(seed)
      pendingBytes += seed.length
    }
    const finish = (reason: RelayResult['reason']): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ reason })
    }
    /** Reject like `finish`, but restore the terminal first. */
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const cleanup = (): void => {
      pump.stop()
      stdout.removeListener('resize', onResize)
      stdin.removeListener('end', onLocalHangup)
      stdin.removeListener('close', onLocalHangup)
      stdin.removeListener('error', onLocalHangup)
      signals.removeListener('SIGHUP', onLocalHangup)
      signals.removeListener('SIGTERM', onLocalHangup)
      try {
        stdin.setRawMode(false)
      } catch {
        // ignore
      }
      if (resizeTimer !== undefined) {
        clearTimeout(resizeTimer)
        resizeTimer = undefined
      }
      stdout.off('resize', onResize)
      if (process.platform !== 'win32') {
        signals.off('SIGWINCH', onResize)
      }
      try {
        stdin.pause()
      } catch {
        // ignore
      }
      if (replaced) return
      try {
        stdout.write('\x1b]0;\x07')
        stdout.write('\x1b[0m\x1b[2J\x1b[3J\x1b[H')
        stdout.write(`\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h${useAltScreen ? '\x1b[?1049l' : ''}`)
      } catch {
        // TTY may already be gone
      }
      socket.destroy()
    }
    /**
     * Keystrokes typed while the relay was still measuring used to be dropped
     * on the floor: the probe owned the only stdin listener and the forwarder
     * was attached afterwards. Hold them (bounded) and flush on HELLO.
     */
    const deliver = (text: string): void => {
      if (text === '') return
      const bytes = Buffer.from(text, 'utf8')
      if (!live) {
        pending.push(bytes)
        pendingBytes += bytes.length
        while (pendingBytes > MAX_PENDING_INPUT && pending.length > 1) {
          pendingBytes -= pending.shift()?.length ?? 0
        }
        return
      }
      try {
        socket.write(encodeFrame(FRAME_STDIN, bytes))
      } catch {
        finish('host-closed')
      }
    }
    const pump = new TerminalInputPump({
      stdin,
      stdout,
      onInput: deliver,
      ...(options.ssh === undefined ? {} : { ssh: options.ssh }),
      // Only while the boot splash is up: the TUI is not painted yet, so a
      // diagnostic line cannot garble a live screen.
      ...(process.env.DSH_TUI_DEBUG === '1'
        ? { debug: (message: string) => { process.stderr.write(`dsh-ssh-tui: ${message}\n`) } }
        : {}),
    })
    let resizeTimer: NodeJS.Timeout | undefined
    const sendResize = (): void => {
      try {
        socket.write(encodeResize(stdout.columns || 80, stdout.rows || 24))
      } catch {
        finish('host-closed')
      }
    }
    const onResize = (): void => {
      if (resizeTimer !== undefined) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined
        sendResize()
      }, 20)
    }
    const onLocalHangup = (): void => {
      finish('signal')
    }
    socket.once('error', error => {
      fail(error)
    })
    socket.on('connect', () => {
      void (async () => {
        try {
          stdin.setRawMode(true)
          stdin.resume()
          // Subscribed before the first await: an EOF that lands during the
          // probe (SSH dropped while the TTY was quiet) used to be missed
          // entirely, and the launcher then stayed alive with a dead TTY —
          // the zombie that fought the next window for the display.
          stdin.on('end', onLocalHangup)
          stdin.on('close', onLocalHangup)
          // A PTY can report EIO instead of a clean EOF; without this the
          // launcher dies on an unhandled 'error' event instead of resolving.
          stdin.on('error', onLocalHangup)
          signals.on('SIGHUP', onLocalHangup)
          signals.on('SIGTERM', onLocalHangup)
          // A TTY that is already gone (this launcher started after the SSH
          // session ended) never fires `end` again; without this the relay
          // would sit on a dead channel as another zombie.
          if (stdin.readableEnded === true || stdin.destroyed === true) {
            finish('signal')
            return
          }
          pump.start()
          // Measure *before* HELLO: the Host answers a HELLO with a full
          // repaint, and a request queued behind that burst measures the
          // repaint (1900 ms) instead of the link (50 ms).
          const rtt = await pump.measure()
          if (settled) return
          const columns = stdout.columns || 80
          const rows = stdout.rows || 24
          socket.write(Buffer.concat([
            encodeFrame(FRAME_HELLO),
            encodeResize(columns, rows),
            encodeRtt(rtt),
          ]))
          live = true
          if (options.announce === true) {
            try {
              stdout.write('\r\x1b[2K')
            } catch {
              // The TTY may already be gone.
            }
          }
          for (const chunk of pending.splice(0)) {
            try {
              socket.write(encodeFrame(FRAME_STDIN, chunk))
            } catch {
              finish('host-closed')
              return
            }
          }
          pendingBytes = 0
          stdout.on('resize', onResize)
          if (process.platform !== 'win32') {
            signals.on('SIGWINCH', onResize)
          }
        } catch (error) {
          fail(error)
        }
      })()
    })
    socket.on('data', chunk => {
      let frames: Array<{ type: number; payload: Buffer }>
      try {
        frames = reader.push(chunk)
      } catch (error) {
        fail(error)
        return
      }
      for (const frame of frames) {
        if (frame.type === FRAME_STDOUT) {
          try {
            stdout.write(frame.payload)
          } catch {
            finish('signal')
            return
          }
        } else if (frame.type === FRAME_GOODBYE) {
          finish('goodbye')
          return
        } else if (frame.type === FRAME_REPLACED) {
          // A newer Display owns this session now. Caller exits quietly; the
          // retry it used to trigger is what made two windows fight. Nothing is
          // written back to this link either — see `replaced`.
          replaced = true
          finish('replaced')
          return
        }
      }
    })
    socket.on('close', () => finish('host-closed'))
  })
}
