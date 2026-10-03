/**
 * Command-line intake for the SSH TUI. Parses the app arguments handed over
 * by the dsh launcher, mints or resumes the `main` agent identity, and
 * provides the `sshTuiStartup` service consumed by the agent-loop row and the
 * TUI row.
 */

import { randomUUID } from 'node:crypto'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { CONFIGURED_AGENT_IDENTITIES_KEY } from '@deepseek-ai/dsh-agent-loop'
import type { LauncherAgentIdentity } from '@deepseek-ai/dsh-agent-loop'
import { SessionId } from '@deepseek-ai/dsh-session'
import { detachFromSshSession } from './display-sock.js'
import { parseDisplayMode, type DisplayMode } from './display-mode.js'
import { desktopLauncher } from './platform.js'

/** Service key under which the parsed TUI launch options are provided. */
export const SSH_TUI_STARTUP_SERVICE = 'sshTuiStartup'

/** Config `id` of the agent-loop entry the TUI drives. */
export const MAIN_AGENT_ID = 'main'

/** Parsed TUI launch identity and presentation options. */
export interface SshTuiStartup {
  /** Exact session id the `main` agent runs under, fresh or resumed. */
  readonly sessionId: SessionId
  /** Whether the session resumes persisted history. */
  readonly resume: boolean
  /** Whether the launcher should open the history-session picker on boot. */
  readonly resumePicker: boolean
  /** Model override supplied at launch, when given. */
  readonly model?: string
  /** Provider route override supplied at launch, when given. */
  readonly provider?: string
  /** ANSI color opt-out supplied at launch. */
  readonly noColor?: boolean
  /**
   * Where the bytes go: `stdio` when the parent speaks the display protocol on
   * stdin/stdout (a GUI, a web terminal, a harness) instead of owning a TTY.
   */
  readonly display?: DisplayMode
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sshTuiStartup?: SshTuiStartup
  }
}

export const name = 'ssh-tui-startup'
export const inject = ['cmdlineArgs']

/**
 * Whether another application already owns this profile's command line.
 *
 * `@deepseek-ai/dsh-cmdline` has **no arbitration between apps**: every app plugin is
 * handed the same argv and parses it with its own grammar, and an unknown flag is
 * `program.error`, which exits the process. A profile that hosts two apps therefore
 * requires the second one to understand the first one's flags — and the desktop
 * application passes `--no-open` (the web app's own flag) to its host, so this row's
 * grammar rejected it: the host exited 1, the application reported
 * `dsh desktop host exited with 1: error: unknown option '--no-open'` and died. Only
 * the *startup* row did that; the TUI row never ran, which is why 0.8.1's inert-when-
 * headless fix could not have caught it.
 *
 * The signals are two, and they overlap on purpose:
 *
 * - the launcher facts (`desktopLauncher`): an Electron host, `DeepSeek Harness.exe`,
 *   or `app.asar` in argv — true whatever the profile's row order is;
 * - `webStartup`: the web app provides it as soon as it has parsed, and a `web`
 *   profile is not a terminal profile in any case.
 *
 * Stepping aside is not a degraded mode: the TUI row `inject`s `sshTuiStartup`, so
 * nothing of this plugin activates and the host keeps its own grammar and its own app.
 */
export function anotherAppOwnsCommandLine(ctx: Context): boolean {
  if (desktopLauncher({
    electron: process.versions.electron,
    execPath: process.execPath,
    argv: process.argv,
  })) return true
  return ctx.get('webStartup') !== undefined
}

/** One line, the way the plugin's other inert paths report themselves. */
function sayInactive(ctx: Context): void {
  const line = 'not enabled here: this profile\'s command line belongs to another app '
    + '(the desktop or web host), so the TUI leaves the arguments alone'
  const logger = (ctx as unknown as { logger?: (name: string) => { info?: (message: string) => void } }).logger
  const named = typeof logger === 'function' ? logger('ssh-tui') : undefined
  if (typeof named?.info === 'function') named.info(line)
  else process.stderr.write(`dsh-ssh-tui: ${line}\n`)
}

/**
 * Build the TUI command grammar and provide the session identity for the
 * agent-loop row plus the {@link SshTuiStartup} service. On `--help` or a
 * usage error nothing is provided, so dependent rows never activate and the
 * process exits through the cmdline exit seam.
 */
export function apply(ctx: Context): void {
  // Never claim a command line that is not ours to claim — see the function below.
  if (anotherAppOwnsCommandLine(ctx)) {
    sayInactive(ctx)
    return
  }
  const program = new Command()
    .name('dsh --profile tui')
    .description('SSH-friendly interactive terminal session over DeepSeek Harness')
    .helpOption('-h, --help', 'show this help')
    .argument('[mode]', 'resume — open the history-session picker')
    .argument('[session]', 'session id to resume (with the resume mode)')
    .option('--resume [session]', 'resume a persisted session (empty = session picker)')
    .option('--new', 'start a fresh session without the history picker')
    .option(
      '--display <mode>',
      'where the TUI paints: tty (default) or stdio, for a parent that speaks the display protocol on stdin/stdout',
    )
    .option('--model <model>', 'override the default model id')
    .option('--provider <provider>', 'override the default provider route')
    .option('--no-color', 'disable ANSI colors')

  program.action((
    mode: string | undefined,
    session: string | undefined,
    options: {
      resume?: string
      new?: boolean
      model?: string
      provider?: string
      color?: boolean
      display?: string
    },
  ) => {
    if (mode !== undefined && mode !== 'resume') {
      program.error(`dsh --profile tui: unknown argument "${mode}" (expected "resume")`)
      return
    }
    const flagValue = options.resume
    const flagId = typeof flagValue === 'string' ? flagValue.trim() : ''
    const positionalId = session?.trim() ?? ''
    if (positionalId !== '' && flagId !== '' && positionalId !== flagId) {
      program.error('dsh --profile tui: session id given twice with different values (--resume and positional)')
      return
    }
    if (positionalId !== '' && mode === undefined && flagValue === undefined) {
      program.error('dsh --profile tui: a session id requires resume mode or --resume')
      return
    }
    if (options.new === true && (flagValue !== undefined || positionalId !== '' || mode !== undefined)) {
      program.error('dsh --profile tui: --new cannot be combined with a resume session id or mode')
      return
    }
    if (options.display !== undefined && parseDisplayMode(options.display) === undefined) {
      program.error(`dsh --profile tui: unknown --display value "${options.display}" (expected tty or stdio)`)
      return
    }
    const resumeId = flagId !== '' ? flagId : positionalId
    const picker = resumeId === '' && (mode === 'resume' || flagValue !== undefined)
    const resume = resumeId !== ''
    const identity: LauncherAgentIdentity = resume
      ? { id: SessionId(resumeId), resume: true }
      : { id: SessionId(`main-session-${randomUUID()}`), resume: false }

    ctx.provide(CONFIGURED_AGENT_IDENTITIES_KEY, { [MAIN_AGENT_ID]: identity })
    ctx.provide(SSH_TUI_STARTUP_SERVICE, {
      sessionId: identity.id,
      resume: identity.resume,
      resumePicker: picker,
      model: options.model?.trim() || undefined,
      provider: options.provider?.trim() || undefined,
      noColor: options.color === false,
      ...(parseDisplayMode(options.display) === undefined ? {} : { display: parseDisplayMode(options.display) as DisplayMode }),
    } satisfies SshTuiStartup)
    ctx.provide(
      'tuiGoodbyeMessage',
      `To resume this session: dsh --profile tui --resume=${identity.id}`,
    )
    detachFromSshSession()
  })

  parseCmdline(ctx, program)
}
