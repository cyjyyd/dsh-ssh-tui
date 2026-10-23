/**
 * WIN-CI1.H2 diagnostic trace — evidence for the lecacy Host/Relay race.
 *
 * Off by default. Enabled only when `DSH_TUI_DIAG_DIR` names a directory; the
 * launcher and the Host then write *separate* files
 * (`<dir>/<role>-<pid>.log`, mode 0600) and the relay/host event order becomes
 * readable after a failure.
 *
 * What it records, and what it deliberately does not:
 *
 * - events, counts, byte lengths, frame types, booleans and state transitions;
 * - never payload bytes, never a session id, never a credential, never a reply.
 *
 * The role is taken from the marker the Host bootstrap sets (`DSH_TUI_HOST=1`),
 * not from the process name: that is the only reliable way to say which side of
 * the socket a line came from.
 * @module dsh-ssh-tui/diag-trace
 */
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.DSH_TUI_DIAG_DIR
const hostMarker = process.env.DSH_TUI_HOST
const role = hostMarker === '1' || hostMarker === 'true' ? 'host' : 'launcher'

let file: string | undefined
let opened = false
let seq = 0
let writeFailures = 0

function openFile(): string | undefined {
  if (opened) return file
  opened = true
  if (dir === undefined || dir.trim() === '') return undefined
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${role}-${process.pid}.log`)
    appendFileSync(path, `# role=${role} pid=${process.pid} started=${Date.now()}\n`, { mode: 0o600 })
    try { chmodSync(path, 0o600) } catch { /* best effort on Windows */ }
    file = path
  } catch {
    file = undefined
  }
  return file
}

/** Whether the trace is on for this process. */
export function diagEnabled(): boolean {
  return openFile() !== undefined
}

/** The file this process writes, for the receipt. */
export function diagFile(): string | undefined {
  return openFile()
}

/**
 * One event.
 * @param event - a short, stable name (`claim`, `attach-relay`, `render-skip`).
 * @param fields - numbers, booleans and short labels; never payload bytes.
 */
export function diag(event: string, fields: Record<string, string | number | boolean | undefined> = {}): void {
  const path = openFile()
  if (path === undefined) return
  const parts: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    parts.push(`${key}=${typeof value === 'boolean' ? (value ? '1' : '0') : String(value)}`)
  }
  seq += 1
  try {
    appendFileSync(path, `${Date.now()} ${process.pid} ${role} ${seq} ${event}${parts.length === 0 ? '' : ` ${parts.join(' ')}`}\n`)
  } catch {
    writeFailures += 1
    // A trace must never take the TUI down, and must not retry a broken path.
    if (writeFailures > 3) file = undefined
  }
}
