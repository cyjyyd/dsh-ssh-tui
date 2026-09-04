/**
 * Length-prefixed unix-socket frames between a leftover Host and a new
 * Display relay. Binary on purpose: paint bytes are raw ANSI, not JSON.
 *
 * Frame: u32be length | u8 type | payload
 *   1 stdin   — relay → host (key bytes)
 *   2 stdout  — host → relay (paint bytes)
 *   3 resize  — relay → host (u16be cols | u16be rows)
 *   4 hello   — either side, payload ignored
 *   5 goodbye — host → relay, then close (user /exit)
 */
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { mkdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const FRAME_STDIN = 1
export const FRAME_STDOUT = 2
export const FRAME_RESIZE = 3
export const FRAME_HELLO = 4
export const FRAME_GOODBYE = 5

const MAX_FRAME = 1024 * 1024

export function sessionSockPath(
  sessionId: string,
  dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh'),
): string {
  const safe = sessionId.replaceAll(/[^A-Za-z0-9._-]/g, '_')
  return join(dshHome, 'tui-socks', `${safe}.sock`)
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
  onDetach(): void
  onAttach(): void
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
  ) {}

  async listen(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    try {
      await unlink(this.path)
    } catch {
      // missing is fine
    }
    await new Promise<void>((resolve, reject) => {
      const server = createServer(socket => this.accept(socket))
      server.once('error', reject)
      server.listen(this.path, () => {
        server.removeListener('error', reject)
        this.server = server
        resolve()
      })
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
        try {
          this.socket.destroy()
        } catch {
          // ignore
        }
        this.socket = undefined
        this.attached = false
        this.handlers.onDetach()
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
    setTimeout(dropProbe, 400)
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
    try {
      await unlink(this.path)
    } catch {
      // ignore
    }
  }
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
  reason: 'goodbye' | 'host-closed' | 'signal'
}

/**
 * Turn this process into a Display relay until the Host hangs up or the
 * local TTY dies. Restores the terminal before resolving.
 */
export async function runDisplayRelay(path: string): Promise<RelayResult> {
  const useAltScreen = process.env.DSH_TUI_NO_ALT_SCREEN !== '1'
    && process.env.DSH_TUI_NO_ALT_SCREEN !== 'true'
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path)
    const reader = new FrameReader()
    let settled = false
    const finish = (reason: RelayResult['reason']): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ reason })
    }
    const cleanup = (): void => {
      process.stdin.removeListener('data', onStdin)
      process.stdout.removeListener('resize', onResize)
      process.stdin.removeListener('end', onLocalHangup)
      process.stdin.removeListener('close', onLocalHangup)
      process.removeListener('SIGHUP', onLocalHangup)
      process.removeListener('SIGTERM', onLocalHangup)
      try {
        process.stdin.setRawMode(false)
      } catch {
        // ignore
      }
      try {
        process.stdin.pause()
      } catch {
        // ignore
      }
      try {
        process.stdout.write('\x1b]0;\x07')
        process.stdout.write('\x1b[0m\x1b[2J\x1b[3J\x1b[H')
        process.stdout.write(`\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h${useAltScreen ? '\x1b[?1049l' : ''}`)
      } catch {
        // TTY may already be gone
      }
      socket.destroy()
    }
    const onStdin = (chunk: Buffer): void => {
      try {
        socket.write(encodeFrame(FRAME_STDIN, chunk))
      } catch {
        finish('host-closed')
      }
    }
    const onResize = (): void => {
      try {
        socket.write(encodeResize(process.stdout.columns || 80, process.stdout.rows || 24))
      } catch {
        finish('host-closed')
      }
    }
    const onLocalHangup = (): void => {
      finish('signal')
    }
    socket.once('error', error => {
      if (!settled) reject(error)
    })
    socket.on('connect', () => {
      try {
        process.stdin.setRawMode(true)
        process.stdin.resume()
        process.stdin.on('data', onStdin)
        process.stdin.on('end', onLocalHangup)
        process.stdin.on('close', onLocalHangup)
        process.stdout.on('resize', onResize)
        process.on('SIGHUP', onLocalHangup)
        process.on('SIGTERM', onLocalHangup)
        socket.write(encodeFrame(FRAME_HELLO))
        socket.write(encodeResize(process.stdout.columns || 80, process.stdout.rows || 24))
      } catch (error) {
        reject(error)
      }
    })
    socket.on('data', chunk => {
      let frames: Array<{ type: number; payload: Buffer }>
      try {
        frames = reader.push(chunk)
      } catch (error) {
        reject(error)
        return
      }
      for (const frame of frames) {
        if (frame.type === FRAME_STDOUT) {
          try {
            process.stdout.write(frame.payload)
          } catch {
            finish('signal')
            return
          }
        } else if (frame.type === FRAME_GOODBYE) {
          finish('goodbye')
          return
        }
      }
    })
    socket.on('close', () => finish('host-closed'))
  })
}
