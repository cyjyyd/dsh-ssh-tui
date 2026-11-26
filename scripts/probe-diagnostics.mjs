/**
 * Diagnostics for the real-PTY probes.
 *
 * A probe failure used to leave only whatever the PTY stream happened to print. On
 * the 0.9.0 main-push red (run 45735121259 attempt 1) that was not enough to tell a
 * product hang from a probe bug, and the probe printed its success line *before* the
 * assertions were known to have passed. This module carries the missing half:
 *
 *   - `workspaceFrameReady` reads the *current* terminal frame (a composer boundary
 *     followed by its prompt, with the footer cwd chip below both) instead of the
 *     accumulated byte stream, where a cleared dialog or a transcript row can look
 *     like a workspace forever;
 *   - `reportOutcome` emits success lines only after every assertion passed;
 *   - `writeDiagnosticBundle` writes a sanitised, self-contained directory that CI can
 *     upload as an artifact (synthetic screen, transcript, child exit status, versions).
 *     The whole input is sanitised *before* any tail or excerpt is taken, and the
 *     result is re-checked before a single byte is written. If that check cannot
 *     prove the output safe, nothing is written and the caller fails closed.
 *
 * The bundle is public by construction: keys, bearer tokens, real home paths and
 * session ids are replaced before anything is written. The probe's home is a throwaway
 * tree, but the stream can still quote the runner's home or a pasted value, so the
 * sanitiser runs on every file.
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

// ANSI escapes are removed before the patterns run. A supported pattern is still a
// pattern when an SGR run lands in the middle of it (`sk-\x1b[31m...`), and a tail
// cut through the escape must not leave a fragment of the value behind either.
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/gu
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu
const SINGLE_ESCAPE = /\x1b[@-_]/gu
const C0 = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu

/** Strip terminal control sequences so a value split by SGR is one value again. */
export function stripTerminalControls(text) {
  return String(text ?? '')
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(SINGLE_ESCAPE, '')
    .replace(C0, '')
}

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
 * The whole value is cleaned, never a tail of it: a caller that trims first can cut
 * exactly the `sk-` prefix that makes the rest match.
 */
export function sanitizeText(text, { home } = {}) {
  let safe = stripTerminalControls(text)
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
 * Fail closed when sanitisation cannot be shown to have removed everything.
 *
 * The patterns are re-run over the cleaned value: a match means cleaning did not
 * converge (a split key, an escape this module does not know, an unredacted home),
 * and the caller must not publish the value. The thrown message names the class and
 * never quotes the value.
 */
export function assertDiagnosticSafe(text, { home } = {}) {
  const value = String(text ?? '')
  if (CSI.test(value) || OSC.test(value) || SINGLE_ESCAPE.test(value)) {
    CSI.lastIndex = 0
    OSC.lastIndex = 0
    SINGLE_ESCAPE.lastIndex = 0
    throw new Error('diagnostic output is unsafe: terminal control sequence remains')
  }
  if (KEY.test(value)) {
    KEY.lastIndex = 0
    throw new Error('diagnostic output is unsafe: key-shaped value remains')
  }
  BEARER.lastIndex = 0
  if (BEARER.test(value)) {
    BEARER.lastIndex = 0
    throw new Error('diagnostic output is unsafe: bearer value remains')
  }
  if (SESSION.test(value)) {
    SESSION.lastIndex = 0
    throw new Error('diagnostic output is unsafe: session id remains')
  }
  if (PROBE_HOME.test(value) || PROBE_HOME_PATH.test(value) || USER_HOME.test(value)) {
    PROBE_HOME.lastIndex = 0
    PROBE_HOME_PATH.lastIndex = 0
    USER_HOME.lastIndex = 0
    throw new Error('diagnostic output is unsafe: home path remains')
  }
  if (typeof home === 'string' && home !== '' && value.includes(home)) {
    throw new Error('diagnostic output is unsafe: known home remains')
  }
  // A split or half-escaped key prefix is not a supported pattern, but it is still
  // evidence that a key may be in the value. Treat it as unverifiable, not safe.
  if (/\bsk-(?![A-Za-z0-9])/u.test(value)) {
    throw new Error('diagnostic output is unsafe: unverifiable key prefix remains')
  }
  return value
}

/** A sanitised excerpt: whole value first, then the tail. */
export function safeExcerpt(text, max, { home } = {}) {
  return tail(assertDiagnosticSafe(sanitizeText(text, { home }), { home }), max)
}

/** A sanitised tail of `count` rows, with the whole input cleaned first. */
export function safeRows(rows, count, { home } = {}) {
  const safe = assertDiagnosticSafe(sanitizeText(Array.isArray(rows) ? rows.join('\n') : rows, { home }), { home })
  return safe.split('\n').slice(-count).join('\n')
}

/**
 * Is this a composed workspace frame?
 *
 * The old wait accepted `/❯|╭/` on the accumulated stream, which a transcript row or
 * a dialog from *before* a clear can satisfy forever. Read the visible grid instead:
 * the composer opens with a full-width boundary, its prompt is the next row, and the
 * footer cwd chip is below it on one of the last two rows. A cleared dialog has none
 * of those rows even though its glyphs are still in the transcript.
 */
export function workspaceFrameReady(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false
  const lines = rows.map(row => stripTerminalControls(row).replace(/\s+$/u, ''))
  let composer = -1
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (/^\s*╭─{3,}/u.test(lines[index]) && /^\s*(?:❯|>)(?:\s|$)/u.test(lines[index + 1])) {
      composer = index
      break
    }
  }
  if (composer === -1) return false
  let footer = -1
  for (let index = lines.length - 1; index > composer; index -= 1) {
    if (/目录\s*[:：]/u.test(lines[index])) {
      footer = index
      break
    }
  }
  if (footer === -1) return false
  // The footer is the last or second-to-last visible row (the stats row sits above it).
  return footer >= lines.length - 2
}

/**
 * Emit the run's verdict. Success text is only reachable when `problems` is empty.
 *
 * The callback seams are for the test and for callers that already own output; the
 * probe uses the defaults.
 */
export function reportOutcome({ problems = [], successLines = [], log = console.log, error = console.error, home } = {}) {
  if (problems.length > 0) {
    error('FAIL')
    for (const problem of problems) error(`  - ${sanitizeText(String(problem), { home })}`)
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
 * Freeze the child's liveness/exit at the actual observation, before a teardown can
 * make a live child look like a spontaneous exit.
 */
export function observeChild(state, now = Date.now()) {
  const exit = state?.exit === undefined
    ? undefined
    : {
        exitCode: state.exit.exitCode ?? null,
        signal: state.exit.signal ?? null,
        ...(state.exit.at === undefined ? {} : { at: new Date(state.exit.at).toISOString() }),
      }
  return {
    name: String(state?.name ?? 'child'),
    pid: state?.pid,
    alive: exit === undefined,
    exit,
    teardown: state?.teardown === true,
    observedAt: new Date(now).toISOString(),
    ...(state?.startedAt === undefined ? {} : { elapsedMs: now - state.startedAt }),
  }
}

/**
 * Record that the probe is about to stop the child on purpose.
 *
 * Only a child that was alive at the observation is "torn down"; an exit that had
 * already happened is spontaneous, and a later cleanup does not turn it into one.
 */
export function markTeardown(state, now = Date.now()) {
  state.teardown = state.observed === undefined ? true : state.observed.alive !== false
  state.teardownAt = now
  return state
}

/** Normalise a tracked state or an already-frozen observation for the bundle. */
function childDocument(child, home) {
  if (child === undefined || child === null) return undefined
  const observed = child.observed ?? child
  const exit = observed.exit === undefined || observed.exit === null
    ? undefined
    : {
        exitCode: observed.exit.exitCode ?? null,
        signal: observed.exit.signal ?? null,
        ...(observed.exit.at === undefined ? {} : { at: observed.exit.at }),
      }
  const alive = observed.alive ?? (exit === undefined)
  const teardown = child.teardown === true
  const afterTeardown = teardown && observed.exit === undefined && child.exit !== undefined
    ? {
        exitCode: child.exit.exitCode ?? null,
        signal: child.exit.signal ?? null,
        ...(child.exit.at === undefined ? {} : { at: child.exit.at }),
      }
    : undefined
  const name = assertDiagnosticSafe(sanitizeText(String(child.name ?? observed.name ?? 'child'), { home }), { home })
  return {
    name,
    pid: child.pid ?? observed.pid,
    alive,
    spontaneous: alive === false,
    exit,
    teardown,
    ...(child.teardownAt === undefined ? {} : { teardownAt: new Date(child.teardownAt).toISOString() }),
    ...(afterTeardown === undefined ? {} : { exitAfterTeardown: afterTeardown }),
    ...(observed.observedAt === undefined ? {} : { observedAt: observed.observedAt }),
    ...(observed.elapsedMs === undefined ? {} : { observedMs: observed.elapsedMs }),
  }
}

/**
 * Write a sanitised failure bundle and return its directory.
 *
 * `screen` is the synthetic terminal grid the caller rebuilt from the PTY bytes;
 * `output` is the plain transcript. Both are sanitised *whole* first and only then
 * tailed here, so a caller cannot leak a key whose prefix sits on the cut line.
 * Every value is re-checked before the first write; an unsafe or unverifiable value
 * throws and leaves no files behind (fail closed).
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
  const clean = text => assertDiagnosticSafe(sanitizeText(text, { home }), { home })
  const safeProblems = problems.map(problem => clean(String(problem)))
  const safeScreen = tail(clean(String(screen ?? '')), 32 * 1024)
  const safeTranscript = tail(clean(String(output ?? '')), 64 * 1024)
  const safeChild = childDocument(child, home)
  const safeRuntime = {
    node: clean(runtime.node),
    npm: clean(runtime.npm),
    pnpm: clean(runtime.pnpm),
    os: clean(runtime.os),
  }
  const safePhase = clean(String(phase))
  const document = {
    schema: DIAGNOSTICS_SCHEMA,
    createdAt: now.toISOString(),
    phase: safePhase,
    elapsedMs,
    problems: safeProblems,
    child: safeChild,
    runtime: safeRuntime,
    files: {
      screen: 'screen.txt',
      transcript: 'transcript.txt',
      versions: 'versions.txt',
    },
  }
  const screenText = safeScreen === '' ? '(no screen captured)\n' : `${safeScreen}\n`
  const transcriptText = safeTranscript === '' ? '(no transcript captured)\n' : `${safeTranscript}\n`
  const versionsText = [
    `node: ${safeRuntime.node}`,
    `npm: ${safeRuntime.npm}`,
    `pnpm: ${safeRuntime.pnpm}`,
    `os: ${safeRuntime.os}`,
    `created: ${now.toISOString()}`,
    '',
  ].join('\n')
  const jsonText = `${JSON.stringify(document, null, 2)}\n`
  for (const value of [jsonText, screenText, transcriptText, versionsText]) {
    assertDiagnosticSafe(value, { home })
  }

  const stamp = now.toISOString().replace(/[:.]/gu, '')
  const runDir = join(dir, `tui-setup-probe-${stamp}-${process.pid}`)
  mkdirSync(runDir, { recursive: true })
  const write = (name, text) => writeFileSync(join(runDir, name), text, { mode: 0o600 })
  write('diagnostics.json', jsonText)
  write('screen.txt', screenText)
  write('transcript.txt', transcriptText)
  write('versions.txt', versionsText)
  return { dir: runDir, files: ['diagnostics.json', 'screen.txt', 'transcript.txt', 'versions.txt'] }
}
