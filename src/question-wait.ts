/**
 * What a question does while nobody is attached to answer it.
 *
 * A dropped SSH link leaves the question queued in memory, and the only trace of
 * it used to be a transcript line written *after* the user reconnected — which is
 * how a turn spent waiting for an answer went unnoticed until then. Two signals
 * exist before that:
 *
 * - a marker file under `$DSH_HOME/tui-socks/`, so logging back into the jump
 *   host shows a session waiting on an answer before the TUI is even open;
 * - one command the user configured, run once, carrying the question in its
 *   environment. Mail and WeCom are presets of that command rather than clients
 *   of their own: a jump host has whichever of them it already has, and neither
 *   belongs in this plugin's dependency tree.
 * @module dsh-ssh-tui/question-wait
 */

import { spawn } from 'node:child_process'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sessionErrPath, sessionSockDir } from './display-sock.js'
import { t } from './i18n/index.js'
import { restrictPathToUser } from './platform.js'

/** How long a notify command may run before it is killed. It must not stall the turn. */
const NOTIFY_TIMEOUT_MS = 10_000

/** One question waiting on a person who is not attached. */
export interface WaitingQuestion {
  /** The session the question belongs to. */
  sessionId: string
  /** How many questions are waiting, this one included. */
  count: number
  /** The question text, already clipped. */
  question: string
  /** When the wait started, so a later reader can say how long it has been. */
  since: number
}

/**
 * The marker for one session.
 *
 * Beside the session's stderr log, under the same digested label, so a long id
 * stays inside a Windows path and two ids that sanitize to the same stem do not
 * share a file. `.waiting` rather than a dotfile: the point is that `ls` shows it.
 * @param sessionId - the session that is waiting.
 * @param dshHome - the harness home; defaults to the process one.
 * @returns the marker path.
 */
export function waitingMarkerPath(sessionId: string, dshHome?: string): string {
  const dir = dshHome === undefined ? sessionSockDir() : sessionSockDir(dshHome)
  const err = dshHome === undefined ? sessionErrPath(sessionId) : sessionErrPath(sessionId, dshHome)
  // The stderr log's own stem, so the marker can never drift onto a name that
  // log does not already occupy. Both separators: the log is a pipe-derived
  // path on Windows and a socket path on POSIX.
  const base = err.slice(Math.max(err.lastIndexOf('/'), err.lastIndexOf('\\')) + 1)
  return `${dir}/${base.replace(/\.err$/u, '')}.waiting`
}

/**
 * Write the marker, replacing one already there.
 *
 * The question text is the only sensitive part, so the file is owner-only. A
 * failure to write is reported as `false` and never thrown: the question is
 * still queued, and a marker is not worth failing it over.
 * @param question - the question that just started waiting.
 * @param dshHome - the harness home; defaults to the process one.
 * @returns whether the marker is on disk.
 */
export async function writeWaitingMarker(question: WaitingQuestion, dshHome?: string): Promise<boolean> {
  const path = waitingMarkerPath(question.sessionId, dshHome)
  const body = [
    `session=${question.sessionId}`,
    `waiting=${question.count}`,
    `since=${new Date(question.since).toISOString()}`,
    `question=${question.question.replaceAll('\n', ' ')}`,
    '',
  ].join('\n')
  try {
    await mkdir(dirname(path), { recursive: true })
    await restrictPathToUser(dirname(path), { mode: 0o700, directory: true })
    await writeFile(path, body, { mode: 0o600 })
    await restrictPathToUser(path, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * Remove the marker. Missing is fine: the question may have been answered, or
 * the marker may never have been written.
 * @param sessionId - the session whose wait ended.
 * @param dshHome - the harness home; defaults to the process one.
 */
export async function clearWaitingMarker(sessionId: string, dshHome?: string): Promise<void> {
  try {
    await unlink(waitingMarkerPath(sessionId, dshHome))
  } catch {
    // Already gone, or never written.
  }
}

/**
 * The command to run when a question starts waiting, if the user configured one.
 *
 * The environment wins over settings, the same order `/disconnect` uses, so a
 * one-off invocation can point somewhere else without editing the profile.
 * Empty and whitespace are "not configured".
 * @param env - the process environment.
 * @param saved - the `ssh-tui.notify` value, when settings has one.
 * @returns the command, or undefined when notifications are off.
 */
export function notifyCommand(env: NodeJS.ProcessEnv = process.env, saved?: string): string | undefined {
  const fromEnv = (env.DSH_TUI_NOTIFY ?? '').trim()
  if (fromEnv !== '') return fromEnv
  const fromSaved = (saved ?? '').trim()
  return fromSaved === '' ? undefined : fromSaved
}

/** What one notification knows about the question it is announcing. */
export interface NotifyContext {
  sessionId: string
  /** How many questions are waiting. */
  count: number
  /** The question text. */
  question: string
  /** Milliseconds the question has already been waiting. */
  waitedMs: number
  /** A command that reattaches to the session. */
  resumeCommand: string
  /** SMTP username, present only for an authenticated server. */
  smtpUser?: string
  /** SMTP password, present only for an authenticated server. */
  smtpPassword?: string
}

/**
 * One notify target, as `/notify` parsed it.
 *
 * `off` clears the command. `mail` is the local mailer. `smtp` is a submission
 * to a server, authenticated when a password is given. `local` is the machine's
 * own SMTP listener, which needs no account.
 */
export type NotifyTarget =
  | { kind: 'off' }
  | { kind: 'mail'; address: string }
  | { kind: 'smtp'; host: string; port: number; from: string; to: string; user?: string; password?: string }
  | { kind: 'local'; port: number; from: string; to: string }

const SMTP_PORT_DEFAULT = 587
const LOCAL_PORT_DEFAULT = 25

/**
 * Parse one `/notify` argument into a target.
 *
 * Four shapes, deliberately small:
 *
 * - empty, `off`, `none` — turn it off;
 * - `mail you@example.com` — the local mailer;
 * - `smtp host[:port] from to [user [password]]` — an SMTP server, port 587
 *   when omitted, authenticated only when a user is given;
 * - `local [port] from to` — the machine's own mailer on 25, or another port.
 *
 * @param raw - everything after `/notify`.
 * @returns the target, or undefined when the shape is not one of those.
 */
export function parseNotifyTarget(raw: string): NotifyTarget | undefined {
  const parts = raw.trim().split(/\s+/u).filter(part => part !== '')
  if (parts.length === 0) return { kind: 'off' }
  const head = (parts[0] ?? '').toLowerCase()
  if (head === 'off' || head === 'none') return parts.length === 1 ? { kind: 'off' } : undefined
  if (head === 'mail') {
    const address = parts[1]
    if (parts.length !== 2 || address === undefined || !address.includes('@')) return undefined
    return { kind: 'mail', address }
  }
  if (head === 'smtp') return parseSmtpTarget(parts.slice(1))
  if (head === 'local') return parseLocalTarget(parts.slice(1))
  return undefined
}

/** `host[:port] from to [user [password]]`, port defaulting to submission. */
function parseSmtpTarget(parts: readonly string[]): NotifyTarget | undefined {
  const server = splitHostPort(parts[0] ?? '', SMTP_PORT_DEFAULT)
  const from = parts[1]
  const to = parts[2]
  if (server === undefined || from === undefined || to === undefined) return undefined
  if (!from.includes('@') || !to.includes('@')) return undefined
  if (parts.length > 5) return undefined
  const user = parts[3]
  const password = parts[4]
  return {
    kind: 'smtp',
    host: server.host,
    port: server.port,
    from,
    to,
    ...(user === undefined ? {} : { user }),
    ...(password === undefined ? {} : { password }),
  }
}

/** `[port] from to`, the port defaulting to 25. */
function parseLocalTarget(parts: readonly string[]): NotifyTarget | undefined {
  const leadingPort = parts.length === 3 && /^\d{1,5}$/u.test(parts[0] ?? '')
  const port = leadingPort ? Number(parts[0]) : LOCAL_PORT_DEFAULT
  const from = parts[leadingPort ? 1 : 0]
  const to = parts[leadingPort ? 2 : 1]
  if (parts.length !== (leadingPort ? 3 : 2)) return undefined
  if (from === undefined || to === undefined || !from.includes('@') || !to.includes('@')) return undefined
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { kind: 'local', port, from, to }
}

/** `host`, `host:587`, or `[::1]:25`. */
function splitHostPort(text: string, fallback: number): { host: string; port: number } | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/u.exec(trimmed)
  if (bracketed !== null) {
    const port = bracketed[2] === undefined ? fallback : Number(bracketed[2])
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
    return { host: bracketed[1] ?? '', port }
  }
  const colon = trimmed.lastIndexOf(':')
  if (colon > 0 && /^\d{1,5}$/u.test(trimmed.slice(colon + 1))) {
    const port = Number(trimmed.slice(colon + 1))
    if (port < 1 || port > 65535) return undefined
    return { host: trimmed.slice(0, colon), port }
  }
  return { host: trimmed, port: fallback }
}

/**
 * The shell command one target runs.
 *
 * SMTP and the local mailer both go through Python's stdlib `smtplib`, which
 * is present on every jump host this plugin runs on (Node itself is). The
 * password, when there is one, is read from `DSH_TUI_NOTIFY_SMTP_PASSWORD` at
 * send time rather than written into the command, so it never lands in the
 * settings file or the process list. The message text arrives on stdin.
 * @param target - a parsed target other than `off`.
 * @returns the command `/notify` stores.
 */
/**
 * What `/notify` confirms back: the target in the user's own words, without the
 * password.
 * @param target - a parsed target other than `off`.
 * @returns a short label.
 */
export function notifyTargetLabel(target: Exclude<NotifyTarget, { kind: 'off' }>): string {
  if (target.kind === 'mail') return `mail ${target.address}`
  if (target.kind === 'local') return `127.0.0.1:${target.port} → ${target.to}`
  const auth = target.user === undefined ? '' : ` (${target.user})`
  return `${target.host}:${target.port}${auth} → ${target.to}`
}

export function notifyTargetCommand(target: Exclude<NotifyTarget, { kind: 'off' }>): string {
  if (target.kind === 'mail') return mailNotifyCommand(target.address)
  const host = target.kind === 'local' ? '127.0.0.1' : target.host
  return `python3 -c ${shellWord(smtpBridge(target.kind === 'smtp'))} ${shellWord(host)} ${String(target.port)} ${shellWord(target.from)} ${shellWord(target.to)}`
}

/**
 * The Python that reads the notice on stdin and hands it to `smtplib`.
 *
 * One script for both targets: the local mailer is the same call with no login.
 * Authentication happens only when the environment holds a password, so a
 * server that accepts unauthenticated submission needs nothing else.
 * @param authenticated - whether this target may log in.
 * @returns the script, with no host-specific data in it.
 */
function smtpBridge(authenticated: boolean): string {
  const login = authenticated
    ? [
        '    user=os.environ.get("DSH_TUI_NOTIFY_SMTP_USER","")',
        '    password=os.environ.get("DSH_TUI_NOTIFY_SMTP_PASSWORD","")',
        '    if user and password:',
        '        try:',
        '            s.login(user,password)',
        '        except smtplib.SMTPNotSupportedError:',
        '            pass',
      ].join('\n')
    : ''
  return [
    'import os,smtplib,sys',
    'host,port,sender,recipient=sys.argv[1],int(sys.argv[2]),sys.argv[3],sys.argv[4]',
    'body=sys.stdin.read()',
    'subject=os.environ.get("DSH_TUI_NOTIFY_SUBJECT","dsh")',
    'msg="Subject: "+subject+"\\r\\nContent-Type: text/plain; charset=utf-8\\r\\n\\r\\n"+body',
    's=smtplib.SMTP(host,port,timeout=10)',
    'try:',
    login.trimEnd(),
    '    s.sendmail(sender,[recipient],msg.encode("utf-8"))',
    'finally:',
    '    s.quit()',
  ].filter(line => line !== '').join('\n')
}

/**
 * A mail command for an address, using whichever sender the host has.
 *
 * `mail` (or `mailx`) is on most jump hosts and speaks SMTP for them; no
 * provider, token, or library joins this plugin. The body arrives on stdin, so
 * the question text is never a shell argument.
 * @param address - where the mail goes.
 * @returns the command.
 */
export function mailNotifyCommand(address: string): string {
  return `mail -s ${shellWord(t('notify.mailSubject'))} -- ${shellWord(address)}`
}

/**
 * A WeCom group-robot command for one webhook key.
 *
 * The payload is assembled by the caller and sent with `curl`, which a jump
 * host already has. The key is the only secret, and it stays in the command the
 * user configured rather than in this repo.
 * @param key - the robot's webhook key.
 * @returns the command.
 */
export function wecomNotifyCommand(key: string): string {
  const endpoint = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(key)}`
  return `curl -fsS -m 10 -X POST -H "Content-Type: application/json" --data-binary @- ${shellWord(endpoint)}`
}

/** One single-quoted shell word, so an address or URL survives the command line. */
function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * The text a notification shows. Short on purpose: a mail subject and a WeCom
 * message both get truncated by their carrier, so the resume command has to fit.
 * @param context - the question being announced.
 * @returns the message, one fact per line.
 */
export function notifyMessage(context: NotifyContext): string {
  return [
    t('notify.body', {
      session: context.sessionId,
      count: context.count,
      waited: formatWaited(context.waitedMs),
    }),
    context.question,
    t('notify.resume', { command: context.resumeCommand }),
  ].join('\n')
}

/** `45s`, `3m`, `2h` — coarse, since the carrier will not show seconds anyway. */
function formatWaited(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

/**
 * The body a WeCom robot expects: a text message whose content is the notice.
 * @param context - the question being announced.
 * @returns JSON.
 */
export function wecomPayload(context: NotifyContext): string {
  return JSON.stringify({ msgtype: 'text', text: { content: notifyMessage(context) } })
}

/**
 * Run the user's notify command once.
 *
 * The message goes to stdin and the facts go to the environment, so a command
 * can be either `mail` (reads stdin) or anything that reads the variables. The
 * command runs through a shell because it is a shell command by nature — the
 * user wrote it as one — and the platform's own shell, so a Windows host uses
 * `cmd`. Nothing it prints or fails with comes back: a notification that errors
 * must not surface in the transcript or delay the question.
 * @param command - the configured command.
 * @param context - the question being announced.
 * @param deps - injectable process spawn and clock, for tests.
 * @returns once the command has exited, timed out, or failed to start.
 */
export async function runNotify(
  command: string,
  context: NotifyContext,
  deps: { spawnFn?: typeof spawn; platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<void> {
  const spawnFn = deps.spawnFn ?? spawn
  const message = notifyMessage(context)
  const shell = notifyShell(deps.platform)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_TUI_NOTIFY_SESSION: context.sessionId,
    DSH_TUI_NOTIFY_COUNT: String(context.count),
    DSH_TUI_NOTIFY_QUESTION: context.question,
    DSH_TUI_NOTIFY_WAITED_MS: String(Math.max(0, context.waitedMs)),
    DSH_TUI_NOTIFY_RESUME: context.resumeCommand,
    DSH_TUI_NOTIFY_SUBJECT: t('notify.mailSubject'),
    ...(context.smtpUser === undefined ? {} : { DSH_TUI_NOTIFY_SMTP_USER: context.smtpUser }),
    ...(context.smtpPassword === undefined ? {} : { DSH_TUI_NOTIFY_SMTP_PASSWORD: context.smtpPassword }),
  }
  await new Promise<void>(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawnFn(shell.command, [shell.flag, command], {
        env,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
        detached: false,
      })
    } catch {
      resolve()
      return
    }
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish()
    }, deps.timeoutMs ?? NOTIFY_TIMEOUT_MS)
    timer.unref?.()
    child.on('error', finish)
    child.on('exit', finish)
    child.stdin?.on('error', finish)
    try {
      child.stdin?.end(message)
    } catch {
      finish()
    }
  })
}

/**
 * The shell that runs a notify command, and the flag that precedes it.
 *
 * A jump host means `sh -c`. Windows has no `sh` on PATH as a rule, so there
 * the command runs under `cmd /c` and the user writes it for `cmd`.
 * @param platform - injectable so the Windows shape is testable from POSIX.
 * @returns the executable and its command flag.
 */
export function notifyShell(platform: NodeJS.Platform = process.platform): { command: string; flag: string } {
  return platform === 'win32' ? { command: 'cmd', flag: '/c' } : { command: 'sh', flag: '-c' }
}
