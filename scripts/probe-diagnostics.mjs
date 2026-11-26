/**
 * Diagnostics for the real-PTY probes.
 *
 * A probe failure used to leave only whatever the PTY stream happened to print. On
 * the 0.9.0 main-push red (run 45735121259 attempt 1) that was not enough to tell a
 * product hang from a probe bug, and the probe printed its success line *before* the
 * assertions were known to have passed. This module carries the missing half:
 *
 *   - `workspaceReady` reads an explicit workspace frame (footer cwd chip + composer),
 *     not a single glyph that can also appear in a transcript;
 *   - `reportOutcome` emits success lines only after every assertion passed;
 *   - `writeDiagnosticBundle` writes a sanitised, self-contained directory that CI can
 *     upload as an artifact (synthetic screen, transcript, child exit status, versions).
 *
 * The bundle is public by construction: keys, bearer tokens, real home paths and
 * session ids are replaced before anything is written. The probe's home is a
 * throwaway tree, but the stream can still quote the runner's home or a pasted value,
 * so the sanitiser runs on every file.
 *
 * @module dsh-ssh-tui/scripts/probe-diagnostics
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

/** The bundle schema; bump only when a consumer would have to change. */
export const DIAGNOSTICS_SCHEMA = 'dsh-ssh-tui/probe-diagnostics/v1'

const KEY = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/gu
const BEARER = /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/giu
const SESSION = /\bsession-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu
const PROBE_HOME = /(?:[A-Za-z]:)?[\\/][^\s"'<>]*dsh-(?:artifact|probe)-home-[A-Za-z0-9_-]+/gu
const PROBE_HOME_PATH = /(?:~|[A-Za-z]:)?[\\/][^\s"'<>]*probe-home-[A-Za-z0-9_-]+/gu
const USER_HOME = /(?:[A-Za-z]:)?[\\/](?:home|Users)[\\/][^\s"'<>\\/]+/gu

/** Last `max` characters, with a marker when the head was dropped. */
function tail(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `…[truncated ${value.length - max} chars]…\n${value.slice(-max)}`
}

/**
 * Remove values a public artifact must never carry.
 *
 * Deliberately conservative: the point is to keep a failure diagnosable, not to
 * publish a faithful copy of the user's environment. `home` is the real user's
 * home when the caller knows it; the probe's throwaway home is matched by shape.
 */
export function sanitizeText(text, { home } = {}) {
  let safe = String(text ?? '')
  if (typeof home === 'string' && home !== '') {
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    safe = safe.replace(new RegExp(escaped, 'gu'), '<home>')
  }
  safe = safe
    .replace(PROBE_HOME, '<probe-home>')
    .replace(PROBE_HOME_PATH, '<probe-home>')
    .replace(USER_HOME, '<home>')
    .replace(KEY, '<redacted-key>')
    .replace(BEARER, '$1<redacted-token>')
    .replace(SESSION, '<session-id>')
  return safe
}

/**
 * Is this a composed workspace frame?
 *
 * The old wait accepted `/❯|╭/`, which a transcript row or a dialog border can satisfy
 * on its own. The workspace paints its cwd chip (`目录:` / `目录：`) on the footer and
 * a composer at the bottom; requiring both is the explicit ready signal.
 */
export function workspaceReady(text) {
  const value = String(text ?? '')
  return /目录\s*[:：]/u.test(value) && /(?:❯|╭)/u.test(value)
}

/**
 * Emit the run's verdict. Success text is only reachable when `problems` is empty.
 *
 * The callback seams are for the test and for callers that already own output; the
 * probe uses the defaults.
 */
export function reportOutcome({ problems = [], successLines = [], log = console.log, error = console.error } = {}) {
  if (problems.length > 0) {
    error('FAIL')
    for (const problem of problems) error(`  - ${sanitizeText(String(problem))}`)
    return 1
  }
  for (const line of successLines) log(line)
  return 0
}

/** A version string, or `unavailable` when the command is not on this machine. */
function commandVersion(command, args) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
      shell: process.platform === 'win32',
    })
    if (result.status !== 0) return 'unavailable'
    const text = String(result.stdout ?? '').trim()
    return text === '' ? 'unavailable' : text
  } catch {
    return 'unavailable'
  }
}

/** Node/npm/pnpm/OS versions, the four facts a failure report needs. */
export function runtimeFacts() {
  return {
    node: process.version,
    npm: commandVersion('npm', ['--version']),
    pnpm: commandVersion('pnpm', ['--version']),
    os: `${platform()} ${release()} ${arch()}`,
  }
}

/**
 * Write a sanitised failure bundle and return its directory.
 *
 * `screen` is the synthetic terminal grid the caller rebuilt from the PTY bytes;
 * `output` is the plain transcript. Both are truncated and sanitised here so a
 * caller cannot accidentally publish a key by passing the raw stream.
 */
export function writeDiagnosticBundle({
  dir,
  phase = 'unknown',
  problems = [],
  output = '',
  screen = '',
  child,
  elapsedMs = 0,
  runtime = runtimeFacts(),
  now = new Date(),
  home,
} = {}) {
  const stamp = now.toISOString().replace(/[:.]/gu, '')
  const runDir = join(dir, `tui-setup-probe-${stamp}-${process.pid}`)
  mkdirSync(runDir, { recursive: true })

  const clean = text => sanitizeText(text, { home })
  const safeProblems = problems.map(problem => clean(String(problem)))
  const safeScreen = clean(tail(screen, 32 * 1024))
  const safeTranscript = clean(tail(output, 64 * 1024))
  const safeChild = child === undefined
    ? undefined
    : {
        name: sanitizeText(String(child.name ?? 'child')),
        pid: child.pid,
        exit: child.exit,
        alive: child.exit === undefined,
      }
  const document = {
    schema: DIAGNOSTICS_SCHEMA,
    createdAt: now.toISOString(),
    phase: clean(String(phase)),
    elapsedMs,
    problems: safeProblems,
    child: safeChild,
    runtime,
    files: {
      screen: 'screen.txt',
      transcript: 'transcript.txt',
      versions: 'versions.txt',
    },
  }

  const write = (name, text) => writeFileSync(join(runDir, name), text, { mode: 0o600 })
  write('diagnostics.json', `${JSON.stringify(document, null, 2)}\n`)
  write('screen.txt', safeScreen === '' ? '(no screen captured)\n' : `${safeScreen}\n`)
  write('transcript.txt', safeTranscript === '' ? '(no transcript captured)\n' : `${safeTranscript}\n`)
  write('versions.txt', [
    `node: ${runtime.node}`,
    `npm: ${runtime.npm}`,
    `pnpm: ${runtime.pnpm}`,
    `os: ${runtime.os}`,
    `created: ${now.toISOString()}`,
    '',
  ].join('\n'))
  return { dir: runDir, files: ['diagnostics.json', 'screen.txt', 'transcript.txt', 'versions.txt'] }
}
