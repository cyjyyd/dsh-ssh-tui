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
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sshTuiStartup?: SshTuiStartup
  }
}

export const name = 'ssh-tui-startup'
export const inject = ['cmdlineArgs']

/**
 * Build the TUI command grammar and provide the session identity for the
 * agent-loop row plus the {@link SshTuiStartup} service. On `--help` or a
 * usage error nothing is provided, so dependent rows never activate and the
 * process exits through the cmdline exit seam.
 */
export function apply(ctx: Context): void {
  const program = new Command()
    .name('dsh --profile tui')
    .description('SSH-friendly interactive terminal session over DeepSeek Harness')
    .helpOption('-h, --help', 'show this help')
    .argument('[mode]', 'resume — open the history-session picker')
    .argument('[session]', 'session id to resume (with the resume mode)')
    .option('--resume [session]', 'resume a persisted session (empty = session picker)')
    .option('--new', 'start a fresh session without the history picker')
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
    } satisfies SshTuiStartup)
    ctx.provide(
      'tuiGoodbyeMessage',
      `To resume this session: dsh --profile tui --resume=${identity.id}`,
    )
  })

  parseCmdline(ctx, program)
}
