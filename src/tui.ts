/**
 * A small, dependency-light interactive terminal channel for DeepSeek
 * Harness. It renders the durable session transcript, streams assistant
 * output, shows tool-call cards, answers approval requests and
 * `ask_user_question` prompts from the keyboard, and drives one configured
 * agent with followup/steer.
 *
 * The renderer uses plain ANSI and coalesces each frame into one stdout
 * write of dirty rows only — jump-host / proxied SSH should see one packet
 * per paint, not one per line. Cadence is DSH_TUI_PAINT_MS, else local 80 ms
 * or an SSH tier from a CSI 6n round-trip (default 160 ms).
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { StringDecoder } from 'node:string_decoder'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, errorChain, ReasoningEffortId, type LlmCallConfig, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { formatSessionTime, listResumableSessions } from './session-list.js'
import { defaultReasoningEffort } from './reasoning.js'
import { checkForPluginUpdate } from './update-check.js'
import {
  DEFAULT_SUBAGENT_MODEL,
  SUBAGENT_SETTINGS_NAMESPACE,
  defaultSubagentModelForProvider,
  subagentModelMatchesProvider,
  subagentSettingsValue,
  type SubagentSelection,
  type SubagentSelectionRef,
} from './subagent-model.js'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'

/** Presentation configuration for the terminal channel. */
export interface TuiConfig {
  /** Exact shared agent/session identity driven by this terminal. */
  sessionId: string
  /** Render model reasoning blocks. */
  showReasoning?: boolean
  /** Maximum tool-result body lines retained on each card. */
  maxToolOutputLines?: number
  /** Apply ANSI colors. */
  color?: boolean
  /** Banner subtitle line shown while no session title exists. */
  welcome?: string
  /** Override for the launcher-provided goodbye/resume hint. */
  goodbye?: string
  /** Whether this launch resumes an existing persisted session. */
  resume?: boolean
  /** Provider route selected at launch (defaults to deepseek-official). */
  provider?: string
  /** Model selected at launch (defaults to the saved/fallback model). */
  model?: string
  /** Live model-selection ref installed on the agent; mutated by /model. */
  selectionRef?: ModelSelectionRef
  /** Settings-backed model/effort selection applied to subagent requests. */
  subagentSelection?: SubagentSelectionRef
  /** Active agent-preset id (standard/code/minimal/cordis/...). */
  presetId?: string
  /** Display name of the active preset. */
  presetName?: string
  /** Switch the running TUI to another session (used by /resume). */
  onSwitchSession?: (sessionId: string) => Promise<void> | void
  /** Notify the launcher of an explicit in-process selection change. */
  onSelectionChanged?: (selection: ModelSelection) => void
  /** Open the history-session picker immediately after mounting (--resume). */
  resumePicker?: boolean
  /**
   * Minimum milliseconds between paints while a turn is streaming.
   * Jump-host / proxied SSH can raise this so token ticks do not flood the
   * link. Defaults from `DSH_TUI_PAINT_MS` (160).
   */
  paintIntervalMs?: number
}

type SubagentLogKind = 'user' | 'assistant' | 'tool' | 'result' | 'turn' | 'approval' | 'team' | 'system'

/** One child-session event folded into a parent-side subagent card. */
export interface SubagentLogEntry {
  kind: SubagentLogKind
  text: string
}

/** One todo-list item as the plan card renders it. */
export interface PlanTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

type Row =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'reasoning'; text: string; expanded: boolean }
  | { kind: 'brand'; text: string }
  | { kind: 'brand-logo' }
  | {
      kind: 'tool'
      callId: string
      name: string
      args: string
      status?: 'running' | 'ok' | 'error'
      output: string
      title: string
      summary: string
      command?: string
      cwd?: string
      diff?: ToolDiffHunk[]
      exitCode?: number
      signal?: string
      expanded: boolean
    }
  | {
      kind: 'subagent'
      sessionId: string
      runId: string
      provider: string
      local: boolean
      label: string
      status: 'running' | 'ok' | 'error' | 'aborted'
      startedAt: number
      endedAt?: number
      stopReason?: string
      lastActivity: string
      logs: SubagentLogEntry[]
      expanded: boolean
    }
  | {
      kind: 'plan'
      active: boolean
      pending: boolean
      todos: PlanTodoItem[]
      planMarkdown?: string
      expanded: boolean
      /** When true the plan stays in the scrolling transcript, not the dock. */
      archived?: boolean
      /**
       * Display-only: the last turn ended while todos were still open.
       * Does not rewrite the session log.
       */
      turnLeftOpen?: boolean
    }
  | {
      kind: 'question'
      questionId: string
      title: string
      header?: string
      detail?: string
      intent: 'ask' | 'plan-review'
      status: 'waiting' | 'answered' | 'cancelled'
      summary: string
      expanded: boolean
    }
  | {
      kind: 'goal'
      objective: string
      phase: 'active' | 'paused' | 'blocked' | 'complete' | 'cleared'
      blockedReason?: string
      expanded: boolean
    }
  | {
      kind: 'compaction'
      compactionId: string
      status: 'running' | 'ok' | 'error'
      startedAt: number
      endedAt?: number
      pruneCount: number
      prunedTokens: number
      summary?: string
      error?: string
      expanded: boolean
    }
  | { kind: 'system'; text: string }
  | { kind: 'error'; text: string }

/** A reasoning/tool/subagent/plan row or the live streaming-reasoning block. */
type CollapsibleBlock =
  | Extract<Row, { kind: 'reasoning' } | { kind: 'tool' } | { kind: 'subagent' } | { kind: 'plan' } | { kind: 'question' } | { kind: 'goal' } | { kind: 'compaction' }>
  | { kind: 'streaming-reasoning'; expanded: boolean }

type DisplayKind = Row['kind'] | 'tool-result' | 'diff-add' | 'diff-del' | 'diff-path' | 'todo-done' | 'todo-active' | 'todo-pending' | 'plan-dock'

/** One file's change, matching the web diff-card contract (`card: 'diff'`). */
interface ToolDiffHunk {
  path: string
  oldText: string | null
  newText: string
}

/** Whole-log session figures for the stats line below the input box. */
interface SessionStats {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
}

interface UsageSample {
  turn: number
  step: number
  buckets: SessionStats['usage']
}

interface ConfirmDialog {
  kind: 'confirm'
  prompt: string
  hint: string
  resolve(value: 'y' | 'n' | 'cancel'): void
}

interface QuestionDialog {
  kind: 'questions'
  question: AskUserQuestionItem
  index: number
  total: number
  selected: Set<number>
  resolve(selection: { selected: string[]; custom?: string }): void
  reject(error: unknown): void
}

interface OnboardingDialog {
  kind: 'onboarding'
}

type Dialog = ConfirmDialog | QuestionDialog | OnboardingDialog

type OnboardingProviderType =
  | 'official'
  | 'opencode-go'
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'

interface ProviderTemplate {
  label: string
  defaultId: string
  defaultBaseUrl: string
  api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  defaultModels: string[]
}

const PROVIDER_TEMPLATES: Record<OnboardingProviderType, ProviderTemplate> = {
  official: {
    label: 'DeepSeek 官方',
    defaultId: 'deepseek-official',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModels: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  'opencode-go': {
    label: 'OpenCode Go（opencode.ai/zen/go）',
    defaultId: 'opencode-go',
    defaultBaseUrl: 'https://opencode.ai/zen/go/v1',
    api: 'openai-responses',
    defaultModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  'openai-completions': {
    label: '自定义 OpenAI 兼容网关（Completions）',
    defaultId: 'my-gateway',
    defaultBaseUrl: '',
    api: 'openai-completions',
    defaultModels: ['deepseek-v4-flash'],
  },
  'openai-responses': {
    label: '自定义 OpenAI Responses 网关',
    defaultId: 'my-responses',
    defaultBaseUrl: '',
    api: 'openai-responses',
    defaultModels: ['deepseek-v4-flash'],
  },
  'anthropic-messages': {
    label: 'Anthropic Messages 兼容网关',
    defaultId: 'my-anthropic',
    defaultBaseUrl: '',
    api: 'anthropic-messages',
    defaultModels: ['deepseek-v4-flash'],
  },
}

interface OnboardingState {
  step: 'provider' | 'id' | 'base-url' | 'key' | 'models' | 'confirm'
  providerType: OnboardingProviderType
  providerId: string
  baseUrl: string
  key: string
  models: string[]
  /** True while the wizard's async save is in flight; input is ignored. */
  saving: boolean
  resolve(saved: boolean): void
}

/** Result of one dialog interaction. */
interface DialogAnswer {
  selected: string[]
  custom?: string
}

/** Lifecycle handle for a mounted interactive terminal channel. */
export interface TuiController {
  dispose(): Promise<void>
}

const RENDER_INTERVAL_MS = 160
const LOCAL_PAINT_INTERVAL_MS = 80
const WAIT_INDICATOR_MS = 8000
const MIN_PAINT_INTERVAL_MS = 40
const MAX_PAINT_INTERVAL_MS = 1000
const DSR_PROBE_TIMEOUT_MS = 800

export type PaintLinkKind = 'local' | 'ssh'

/**
 * Explicit env/config always wins. Otherwise local TTYs stay snappy and SSH
 * sessions pick a tier from a measured round-trip (CSI 6n), falling back to
 * 160 ms when the probe is missing.
 */
export function resolvePaintIntervalMs(
  configured?: number,
  env: NodeJS.ProcessEnv = process.env,
  options: { ssh?: boolean; rttMs?: number } = {},
): number {
  const raw = configured ?? Number.parseInt(env.DSH_TUI_PAINT_MS ?? '', 10)
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(MAX_PAINT_INTERVAL_MS, Math.max(MIN_PAINT_INTERVAL_MS, Math.floor(raw)))
  }
  if (options.ssh === true) return paintIntervalForRtt(options.rttMs)
  return LOCAL_PAINT_INTERVAL_MS
}

/** True when this process is attached to an SSH session (jump host / proxy). */
export function detectSshSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY)
}

/** Map a CSI-6n round-trip to a paint cadence. Unknown RTT uses the SSH default. */
export function paintIntervalForRtt(rttMs: number | undefined): number {
  if (rttMs === undefined || !Number.isFinite(rttMs) || rttMs < 0) return RENDER_INTERVAL_MS
  if (rttMs < 50) return LOCAL_PAINT_INTERVAL_MS
  if (rttMs < 150) return 160
  if (rttMs < 350) return 250
  return 400
}

export function paintLinkLabel(kind: PaintLinkKind, intervalMs: number, probed: boolean): string {
  if (kind === 'local') return `本机绘制 ${intervalMs}ms`
  return probed ? `SSH 绘制 ${intervalMs}ms` : `SSH 绘制 ${intervalMs}ms（未测到往返）`
}

/** One incremental paint as a single stdout write (one SSH packet when corked). */
export function composePaintOutput(options: {
  width: number
  height: number
  paintRows: readonly string[]
  previousRows: readonly string[]
  sizeChanged: boolean
  chromeChanged: boolean
  chromeStart: number
  cursorRow: number
  cursorColumn: number
}): string {
  const { width, height, paintRows, previousRows, sizeChanged, chromeChanged, chromeStart } = options
  let out = '\x1b[?25l'
  const prev = sizeChanged ? [] : previousRows
  if (sizeChanged) out += '\x1b[H\x1b[J'
  // Never address row height+1: that scrolls the SSH viewport and leaves
  // thinking/tool/assistant glyphs sitting on the next card.
  const rowCount = Math.min(height, paintRows.length)
  for (let i = 0; i < rowCount; i++) {
    const current = paintRows[i] ?? ''
    if (current === prev[i] && !(chromeChanged && i >= chromeStart)) continue
    const clipped = padAnsiToWidth(current, width)
    // EL2 *before* the glyphs, from column 1. A full-width write followed
    // by EL hits DEC auto-margin: the cursor wraps, and EL then blanks the
    // next card instead of the row we just drew.
    out += `\x1b[${i + 1};1H\x1b[0m\x1b[2K${clipped}\x1b[0m`
  }
  if (rowCount < height) {
    out += `\x1b[${rowCount + 1};1H\x1b[J`
  }
  out += '\x1b[0m'
  const cursorRow = Math.min(height, Math.max(1, options.cursorRow))
  out += `\x1b[${cursorRow};${Math.max(1, options.cursorColumn)}H\x1b[?25h`
  return out
}
const PLUGIN_VERSION = ((): string => {
  try {
    const require = createRequire(import.meta.url)
    const parsed = require('../package.json') as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
const STALL_WARNING_MS = 60000
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const QUESTION_OPTION_KEYS = '123456789abcdefghijklmnopqrstuvwxyz'
const SUBAGENT_DEFAULT_EFFORT_LABEL = '跟随提供商默认'
const RESERVED_BOTTOM_LINES = 3 // input line + stats line + status line
const MAX_TRANSCRIPT_ROWS = 5000
const IS_WINDOWS = process.platform === 'win32'

function dshHomeDir(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function displayDshPath(file: string): string {
  const home = dshHomeDir()
  if (IS_WINDOWS) {
    const profile = process.env.USERPROFILE
    if (profile !== undefined && home.toLowerCase().startsWith(profile.toLowerCase())) {
      const rest = home.slice(profile.length)
      return `%USERPROFILE%${rest}\\${file}`.replaceAll('/', '\\')
    }
    return `${home}\\${file}`.replaceAll('/', '\\')
  }
  const userHome = homedir()
  if (home === userHome) return `~/.dsh/${file}`
  if (home.startsWith(`${userHome}/`)) return `~/${home.slice(userHome.length + 1)}/${file}`
  return join(home, file)
}

const DSH_ENV_FILE = join(dshHomeDir(), IS_WINDOWS ? 'env.cmd' : 'env.sh')

const DEEPSEEK_LOGO_VARIANTS: { width: number; lines: string[] }[] = [
  {
    width: 52,
    lines: [
      '',
      '',
      '                                   .:',
      '             ...... .-=*###-      .%%.',
      '        -+*%%%@@@@%%@@@@@@.       =@%%*-.        -*-.',
      '     :*%@@@@@@%%%%@@%%%%%%*:      -@%@@@%= -+***%@@.',
      '    +@@@%%%%%%%%%%%%%%%@@%@@#=     #@%%%@@%@@@@@@@=',
      '  .#@%%%%%%%%%%%%@@@@@@%%@%%@@%=    *@@%%%@%%@@@%=',
      '  #@@@@@@@@@@@%%%%%%@@@@%@%%%%%@%=   .*%%%%%%#*-',
      ' =@%*=---=+*#%@@@%%%%%@@@%@@%@@@@@%+: *@%%%-',
      ' #%@-        .-+%@@@%%%%%%%+: .=#@%@@@%@%%%%.',
      ' #%@*            :*%@%%@%%%+++  -%@%%@%@%%*',
      ' #%%%.             .+@@%%%@%%%   .#%%%%%%@:',
      ' =@%@*               :#@%%@@@%#=--#%%%%%@+',
      '  %@%@+                +@@%%%%@@@@@%@%%@*',
      '  :%@%@*                -%@%%%%%%%%@%@@+',
      '   :%@%@%-       -+-.    .*@@%%%%%@%@#-',
      '    .*@@@@#-.    :%@%*-    -%@@%%%%%*',
      '      :#@@@@%*=:::#%%@@%+:   -*@@@@@%#*=:',
      '        :+%@@@@@@@@%%%%%@@%#*+**+*##%%%#=',
      '           :+*%%@@@@@@@@@@@%#+:',
      '               .:-=====--:.',
    ],
  },
  {
    width: 44,
    lines: [
      '',
      '',
      '                  .:-==.     :#.',
      '       :=*#######%%@@@-      *@%=:       .=:',
      '    .+%@@@@@@@@@@@@%%%+:     *@%@@#::=+**%@:',
      '   +%@@%%%%%%%%%%%%%@%@@#-   .%@%%@%@@@@@@+',
      '  *@@@@@@@%%%%%%%@@%%@%%@@#-  .+%%%@@@@%#-',
      ' =@%####%%@@@@%%%%%@@@@@@@@@#-  =%%%#=-.',
      ' %%*     .:-*%@@@%%%%%%+-+#@@@%#%@%%=',
      '.%%#          :*%@%%%%%=+  =%%@@@%%@:',
      ' %%@-           .+@@%%@#@-  :%%%%%@*',
      ' +@%%.            :#@%%@%%*++%%%%@%.',
      ' .%@%#.             *@@%%@@@@@%%@%.',
      '  .%@@%-      .:.    =%@%%%%%%@@*.',
      '   .*@@@#-    .%%*=.  .*@@@%%%%-',
      '     -#@@@%+-::*@@@%*-  :+%@@@@#*=.',
      '       :+#@@@@@@@@%@@@@%*++-++****:',
      '          :=+*#%%%%%##*+-.',
    ],
  },
  {
    width: 36,
    lines: [
      '',
      '',
      '                 .:     ::',
      '      :-++++++*#%%-     %%-.      :.',
      '   .+%@@@@@@@@@@@%=.    %@@%+:=++#@=',
      '  =%@@%%%%%%%%%%%%@%*:  -%@@@@@@@@+',
      ' =@@@@@@@@@%%%%%@@%@@@*:  +%%%%#+:',
      '.%%-..:-=*%@@@%%%%%**%@@#=+%%%',
      ':@%.       :+%@%%%%=: +%@@@%%*',
      '.%%+         .+@@%%%#  =%%%%@.',
      ' *@%-          :%@%@@%##@%%@=',
      ' .#@%=           *@@%@@@%@%-',
      '  .*@@#-    **=.  -%@@%%%*',
      '    -#@@%+-:+@@%*- .=%@@@#*=',
      '      :+#@@@@@@@@@@#+=:-====',
      '         .:-=+++=-:.',
    ],
  },
  {
    width: 28,
    lines: [
      '',
      '',
      '     .:----=+*:   :#:      .',
      '  .+#%@@@@@@@@=.  -@@#--++%+',
      ' :%@@@@%%%%%%%@@+. =%@@@@@+',
      '.%#++*#%@@@%%@%%@@+:=%%+:.',
      '=%-     :+%@%%#=.+@@%%%',
      ':@#       .+@@%%- *%%@+',
      ' *@*        :%@%@@%@@*',
      '  *@#:   :=:  +%@@%%-',
      '   -#@%+-+@@#=.=#%@%+-',
      '     :+#%@%%@@#+:.::-:',
      '          ...',
    ],
  },
  {
    width: 20,
    lines: [
      '',
      '     ...:-.  -.',
      '  +#%%%%@@=  +@*-+*+',
      '.#@%@@@@%%@%+.+@@#+',
      '*#  .-+%@%#-*%*@=',
      '=@.     +@%*-%@%.',
      ' *%-   . :#@@@*.',
      '  -##++@%=-*#%+.',
      '    :=++*+=.  .',
    ],
  },
]

/** Human-facing kind for a live LLM route. */
export function describeProviderRoute(provider: string): { kind: string; short: string } {
  const id = provider.trim()
  if (id === 'deepseek-official' || id === 'deepseek') {
    return { kind: 'DeepSeek 官方', short: 'DeepSeek 官方' }
  }
  if (id === 'xai' || id === 'grok' || id.startsWith('xai-')) {
    return { kind: 'SuperGrok / X Premium 订阅', short: 'SuperGrok' }
  }
  if (id === 'opencode-go') return { kind: 'OpenCode Go', short: 'OpenCode Go' }
  if (id === 'opencode') return { kind: 'OpenCode Zen', short: 'OpenCode Zen' }
  return { kind: '已注册提供商', short: id }
}

/** Routes that authenticate without a harness API-key credential. */
export function providerUsesLocalOAuth(provider: string): boolean {
  const id = provider.trim()
  return id === 'xai' || id === 'grok' || id.startsWith('xai-')
}

const LOCAL_COMMANDS = [
  { name: 'help', description: 'show all available commands' },
  { name: 'model', description: 'select provider, model and reasoning effort' },
  { name: 'submodel', description: `select subagent model (default ${DEFAULT_SUBAGENT_MODEL}, same provider as parent)` },
  { name: 'subeffort', description: 'select subagent reasoning effort (default follows provider)' },
  { name: 'mode', description: 'switch agent mode / preset (standard, minimal, code, cordis, routing-suite, ...)' },
  { name: 'quit', description: 'exit the TUI' },
  { name: 'exit', description: 'exit the TUI' },
  { name: 'clear', description: 'clear the transcript view' },
  { name: 'status', description: 'show session, provider, model, paint, and plugin version' },
  { name: 'usage', description: 'show remaining quota for the current provider (OpenCode Go / SuperGrok)' },
  { name: 'quota', description: 'alias of /usage' },
  { name: 'subagents', description: 'list active subagents; kill <id> to stop one' },
  { name: 'resume', description: 'resume a past session (empty = session picker)' },
  { name: 'setup', description: 'configure an API-key provider (DeepSeek / OpenCode); SuperGrok uses local OAuth' },
  { name: 'find', description: 'search thinking / plan / subagent / reply cards' },
  { name: 'dialog-test', description: 'verify the question dialog' },
] as const

/**
 * Terminal cell width for one string.
 *
 * Match glibc wcwidth / typical UTF-8 SSH terminals: CJK ideographs and
 * fullwidth forms occupy two cells; East-Asian Ambiguous box-drawing and
 * ornaments (`─`, `●`, `·`, `▸`, `❯`, Braille spinners) occupy one. Counting
 * those ambiguous glyphs as two made `repeatToWidth('─', cols)` paint a
 * half-width rule and parked the input cursor half a cell past the text.
 *
 * Overflow into the input box is handled by clipping/padding painted rows to
 * the measured column count, not by inflating glyph width.
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    if (char === '\t') {
      // Tabs are expanded to spaces before rendering; keep the width
      // calculation consistent with `sanitizeTerminalText()`.
      width += 4
      continue
    }
    const cp = char.codePointAt(0) ?? 0
    if (cp === 0x00ad || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2060 && cp <= 0x2064) || cp === 0xfeff) {
      continue
    }
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) {
      continue
    }
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    width += wide ? 2 : 1
  }
  return width
}

/** Pad or clip one already-sanitized line so it occupies exactly `width` cells. */
export function padToWidth(text: string, width: number): string {
  const safe = sanitizeTerminalText(text)
  if (width <= 0) return ''
  const clipped = truncateToWidth(safe, width)
  const used = displayWidth(clipped)
  return used >= width ? clipped : `${clipped}${' '.repeat(width - used)}`
}

/**
 * Pad an already-styled ANSI line to `width` cells without resetting SGR.
 * Diff add/del rows keep their background across the whole terminal row
 * instead of only the glyphs.
 */
export function padAnsiToWidth(text: string, width: number): string {
  if (width <= 0) return ''
  const clipped = clipAnsiToWidth(text, width)
  const used = visibleWidth(clipped)
  if (used >= width) return clipped
  const pad = ' '.repeat(width - used)
  // Insert spaces before a trailing SGR reset so backgrounds (diff rows)
  // and the cell budget both fill the whole terminal row.
  if (clipped.endsWith('\x1b[0m')) return `${clipped.slice(0, -4)}${pad}\x1b[0m`
  return `${clipped}${pad}`
}

/** Visible width of an ANSI-styled line, ignoring CSI / OSC sequences. */
export function visibleWidth(text: string): number {
  let used = 0
  let index = 0
  while (index < text.length) {
    if (text.charCodeAt(index) === 0x1b) {
      index = skipAnsiSequence(text, index)
      continue
    }
    const cp = text.codePointAt(index)
    if (cp === undefined) break
    const char = String.fromCodePoint(cp)
    used += displayWidth(char)
    index += char.length
  }
  return used
}

/** Advance past one ESC sequence starting at `index`. */
function skipAnsiSequence(text: string, index: number): number {
  let seqEnd = index + 1
  if (seqEnd >= text.length) return text.length
  const intro = text.charCodeAt(seqEnd)
  if (intro === 0x5b) {
    seqEnd += 1
    while (seqEnd < text.length) {
      const code = text.charCodeAt(seqEnd)
      seqEnd += 1
      if (code >= 0x40 && code <= 0x7e) break
    }
    return seqEnd
  }
  if (intro === 0x5d) {
    seqEnd += 1
    while (seqEnd < text.length) {
      const code = text.charCodeAt(seqEnd)
      seqEnd += 1
      if (code === 0x07) break
      if (code === 0x1b && text.charCodeAt(seqEnd) === 0x5c) {
        seqEnd += 1
        break
      }
    }
    return seqEnd
  }
  while (seqEnd < text.length) {
    const code = text.charCodeAt(seqEnd)
    seqEnd += 1
    if (code >= 0x40 && code <= 0x7e) break
  }
  return seqEnd
}

/** Repeat a glyph until it occupies exactly `width` cells. */
export function repeatToWidth(glyph: string, width: number): string {
  if (width <= 0) return ''
  const unit = displayWidth(glyph)
  if (unit <= 0) return ' '.repeat(width)
  const count = Math.max(1, Math.floor(width / unit))
  return padToWidth(glyph.repeat(count), width)
}

/** Strip terminal control sequences and expand tabs for display output. */
function sanitizeTerminalText(text: string): string {
  return text
    .replace(/[\x1b\u009b]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replaceAll('\t', '    ')
}

/** UTF-16 length of the first code point, so fallback cuts never split a surrogate pair. */
function firstCodePointLength(text: string): number {
  return Array.from(text)[0]?.length ?? 1
}

function wrap(text: string, width: number): string[] {
  const limit = Math.max(1, width)
  const lines: string[] = []
  for (const sourceLine of text.split('\n')) {
    if (sourceLine === '') {
      lines.push('')
      continue
    }
    let rest = sanitizeTerminalText(sourceLine)
    while (displayWidth(rest) > limit) {
      let cut = 0
      let used = 0
      for (const char of rest) {
        const charWidth = displayWidth(char)
        if (charWidth > 0 && used + charWidth > limit) break
        used += charWidth
        cut += char.length
      }
      if (cut === 0) {
        // A single double-width glyph on a 1-cell row still has to occupy a
        // line; the next wrap continues after it so we never stall.
        cut = firstCodePointLength(rest)
      }
      lines.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    lines.push(rest)
  }
  return lines
}

function truncate(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (maxLines <= 0) return ''
  if (lines.length <= maxLines) return text
  if (maxLines === 1) return `… ${lines.length - 1} more line(s) …`
  const head = lines.slice(0, Math.max(0, maxLines - 2))
  const tail = lines.slice(-1)
  return [...head, `… ${lines.length - head.length - 1} more line(s) …`, ...tail].join('\n')
}
type InlineMarkdownKind = 'text' | 'bold' | 'italic' | 'code' | 'link' | 'muted'

interface MarkdownSegment {
  kind: InlineMarkdownKind
  text: string
}

type MarkdownBlockKind = 'assistant' | 'heading1' | 'heading2' | 'heading3' | 'code' | 'quote' | 'rule'

interface MarkdownBlockLine {
  base: MarkdownBlockKind
  segments: MarkdownSegment[]
}

const INLINE_MARKDOWN_PATTERN =
  /(\*\*[^*\n]+\*\*)|(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\n]+\))|(\*[^*\n]+\*)|(_[^_\n]+_)/gu

/** Parse one line's bold / italic / inline-code / link spans. */
function parseInlineMarkdown(line: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = []
  let last = 0
  for (const match of line.matchAll(INLINE_MARKDOWN_PATTERN)) {
    const index = match.index
    if (index > last) segments.push({ kind: 'text', text: line.slice(last, index) })
    const token = match[0]
    if (match[1] !== undefined) {
      segments.push({ kind: 'bold', text: token.slice(2, -2) })
    } else if (match[2] !== undefined) {
      segments.push({ kind: 'code', text: token.slice(1, -1) })
    } else if (match[3] !== undefined) {
      const labelEnd = token.indexOf('](')
      const label = token.slice(1, labelEnd)
      const url = token.slice(labelEnd + 2, -1)
      segments.push({ kind: 'link', text: label })
      if (url !== '') segments.push({ kind: 'muted', text: ` (${url})` })
    } else if (match[4] !== undefined) {
      segments.push({ kind: 'italic', text: token.slice(1, -1) })
    } else if (match[5] !== undefined) {
      segments.push({ kind: 'italic', text: token.slice(1, -1) })
    }
    last = index + token.length
  }
  if (last < line.length) segments.push({ kind: 'text', text: line.slice(last) })
  if (segments.length === 0) segments.push({ kind: 'text', text: line })
  return segments
}

function markdownSegmentWidth(segments: MarkdownSegment[]): number {
  return segments.reduce((total, segment) => total + displayWidth(segment.text), 0)
}

/** Wrap styled inline segments into visual rows, carrying a prefix only on row one. */
function wrapMarkdownSegments(
  segments: MarkdownSegment[],
  width: number,
  prefixSegments: MarkdownSegment[] = [],
): MarkdownSegment[][] {
  const limit = Math.max(1, width)
  const lines: MarkdownSegment[][] = []
  let current: MarkdownSegment[] = [...prefixSegments]
  let used = markdownSegmentWidth(current)

  for (const segment of segments) {
    let rest = segment.text
    while (rest !== '') {
      const available = limit - used
      if (available <= 0) {
        lines.push(current)
        current = []
        used = 0
        continue
      }
      const slice = forwardSliceByWidth(rest, available)
      let chunk = slice.text
      if (chunk === '') {
        // A wide character does not fit the remaining cell: wrap to the next
        // row instead of overflowing that cell into the input area.
        if (used > 0) {
          lines.push(current)
          current = []
          used = 0
          continue
        }
        chunk = Array.from(rest)[0] ?? rest.slice(0, 1)
      }
      current.push({ kind: segment.kind, text: chunk })
      used += displayWidth(chunk)
      rest = rest.slice(chunk.length)
      if (rest !== '') {
        lines.push(current)
        current = []
        used = 0
      }
    }
  }
  if (current.length > 0 || lines.length === 0) lines.push(current)
  return lines.map(line => line.length === 0 ? [{ kind: 'text', text: '' }] : line)
}

function markdownSegmentCode(kind: InlineMarkdownKind): string {
  switch (kind) {
    case 'bold': return '1;97'
    case 'italic': return '3;37'
    case 'code': return '36'
    case 'link': return '4;36'
    case 'muted': return '2;37'
    default: return ''
  }
}

function markdownBaseCode(kind: MarkdownBlockKind): string {
  switch (kind) {
    case 'heading1': return '1;4;97'
    case 'heading2': return '1;4;36'
    case 'heading3': return '1;36'
    case 'code': return '36'
    case 'quote': return '3;37'
    case 'rule': return '90'
    default: return '1;37'
  }
}

/** Render one pre-wrapped markdown line as ANSI (or plain text without color). */
function renderMarkdownBlockLine(block: MarkdownBlockLine, color: boolean): string {
  const segments = block.segments.map(segment => ({ ...segment, text: sanitizeTerminalText(segment.text) }))
  if (!color) return segments.map(segment => segment.text).join('')
  const base = markdownBaseCode(block.base)
  let out = `\x1b[${base}m`
  for (const segment of segments) {
    const code = markdownSegmentCode(segment.kind)
    if (code === '') {
      out += segment.text
    } else {
      out += `\x1b[${code}m${segment.text}\x1b[${base}m`
    }
  }
  return `${out}\x1b[0m`
}

/** Enlarge H1 text visually: fullwidth ASCII and spaced CJK glyphs. */
function expandHeadingText(text: string): string {
  let out = ''
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0
    if (cp >= 0x21 && cp <= 0x7e) {
      out += String.fromCodePoint(0xff01 + cp - 0x21)
    } else if (char.trim() === '') {
      out += ' '
    } else {
      out += `${char} `
    }
  }
  return out
}

function headingSegments(text: string, level: number): MarkdownSegment[] {
  const segments = parseInlineMarkdown(text)
  if (level !== 1) return segments
  return segments.map(segment =>
    segment.kind === 'code' || segment.kind === 'link' || segment.kind === 'muted'
      ? segment
      : { kind: segment.kind, text: expandHeadingText(segment.text) })
}

/**
 * Render workspace markdown into width-bounded terminal rows. Assistant
 * replies get a bold-white base; code blocks, headings, quotes, lists, rules,
 * links and inline spans keep their own ANSI treatment.
 */
export function renderMarkdownLines(text: string, width: number, color: boolean): string[] {
  const lines: string[] = []
  let inFence = false

  for (const sourceLine of text.split('\n')) {
    const raw = sanitizeTerminalText(sourceLine)
    const fence = /^```([^\n]*)$/u.exec(raw.trim())
    if (fence !== null) {
      inFence = !inFence
      lines.push(renderMarkdownBlockLine({
        base: 'code',
        segments: [{ kind: 'text', text: `\`\`\`${fence[1] ?? ''}` }],
      }, color))
      continue
    }
    if (inFence) {
      if (raw === '') {
        lines.push('')
        continue
      }
      for (const line of wrap(raw, width)) {
        lines.push(renderMarkdownBlockLine({
          base: 'code',
          segments: [{ kind: 'text', text: line }],
        }, color))
      }
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(raw)
    if (heading !== null) {
      // The hashes are markdown syntax, not content: replace them with
      // heading style. Levels differ visually: H1 is enlarged and
      // underlined, H2 underlined, H3 colored, H4+ bold white.
      const level = Math.min(6, (heading[1] ?? '#').length)
      const base: MarkdownBlockKind = level === 1
        ? 'heading1'
        : level === 2
          ? 'heading2'
          : level === 3
            ? 'heading3'
            : 'assistant'
      if (level === 1 && lines.at(-1) !== '') lines.push('')
      for (const segments of wrapMarkdownSegments(headingSegments(heading[2] ?? '', level), width)) {
        lines.push(renderMarkdownBlockLine({ base, segments }, color))
      }
      if (level === 1) lines.push('')
      continue
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(raw) && raw.trim() !== '') {
      lines.push(renderMarkdownBlockLine({
        base: 'rule',
        segments: [{ kind: 'text', text: repeatToWidth('─', Math.max(1, width)) }],
      }, color))
      continue
    }

    const quote = /^(\s*)>\s?(.*)$/u.exec(raw)
    if (quote !== null) {
      const indent = quote[1] ?? ''
      const prefix = `${indent}│ `
      for (const segments of wrapMarkdownSegments(
        parseInlineMarkdown(quote[2] ?? ''),
        width,
        [{ kind: 'text', text: prefix }],
      )) {
        lines.push(renderMarkdownBlockLine({ base: 'quote', segments }, color))
      }
      continue
    }

    const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(raw)
    if (list !== null) {
      const indent = list[1] ?? ''
      const marker = list[2] ?? '-'
      const prefix = `${indent}${marker} `
      for (const segments of wrapMarkdownSegments(
        parseInlineMarkdown(list[3] ?? ''),
        width,
        [{ kind: 'text', text: prefix }],
      )) {
        lines.push(renderMarkdownBlockLine({ base: 'assistant', segments }, color))
      }
      continue
    }

    if (raw === '') {
      lines.push('')
      continue
    }

    for (const segments of wrapMarkdownSegments(parseInlineMarkdown(raw), width)) {
      lines.push(renderMarkdownBlockLine({ base: 'assistant', segments }, color))
    }
  }
  return lines
}



/** Cut one line to fit a width, appending an ellipsis when truncated. */
export function truncateToWidth(text: string, width: number): string {
  const safe = sanitizeTerminalText(text)
  if (width <= 0) return ''
  if (displayWidth(safe) <= width) return safe
  if (width === 1) return '…'
  const limit = width - 1
  let cut = 0
  let used = 0
  for (const char of safe) {
    const charWidth = displayWidth(char)
    if (used + charWidth > limit) break
    used += charWidth
    cut += char.length
  }
  if (cut === 0) cut = firstCodePointLength(safe)
  return `${safe.slice(0, cut)}…`
}

/**
 * Clip an already-styled ANSI line to `width` terminal cells without dropping
 * the reset/SGR sequences. Used by the incremental painter so a leftover wide
 * glyph cannot wrap into the next row.
 */
export function clipAnsiToWidth(text: string, width: number): string {
  if (width <= 0) return ''
  let used = 0
  let out = ''
  let index = 0
  while (index < text.length) {
    if (text.charCodeAt(index) === 0x1b) {
      const seqEnd = skipAnsiSequence(text, index)
      out += text.slice(index, seqEnd)
      index = seqEnd
      continue
    }
    const cp = text.codePointAt(index)
    if (cp === undefined) break
    const char = String.fromCodePoint(cp)
    const charWidth = displayWidth(char)
    if (used + charWidth > width) break
    out += char
    used += charWidth
    index += char.length
  }
  return out
}

/** One renderable view of the input line: text plus the cursor's visual offset. */
interface InputView {
  text: string
  cursorOffset: number
  folded: boolean
}

/** Slice up to `maxWidth` display columns from the beginning of `text`. */
function forwardSliceByWidth(text: string, maxWidth: number): { text: string; width: number } {
  let cut = 0
  let used = 0
  for (const char of text) {
    const charWidth = displayWidth(char)
    if (used + charWidth > maxWidth) break
    used += charWidth
    cut += char.length
  }
  return { text: text.slice(0, cut), width: used }
}

/** Slice up to `maxWidth` display columns ending at `end` in `text`. */
function backwardSliceByWidth(text: string, end: number, maxWidth: number): { start: number; width: number } {
  if (end <= 0 || maxWidth <= 0) return { start: end, width: 0 }
  const chars = Array.from(text.slice(0, end))
  let used = 0
  let firstIncluded = chars.length
  for (let index = chars.length - 1; index >= 0; index--) {
    const charWidth = displayWidth(chars[index] ?? '')
    if (used + charWidth > maxWidth) break
    used += charWidth
    firstIncluded = index
  }
  return {
    start: chars.slice(0, firstIncluded).join('').length,
    width: used,
  }
}

/**
 * Fold a long single-line input into one terminal row around the cursor.
 * Only the *display* is clipped; the caller keeps the original `input` intact
 * for editing and submission.
 */
export function foldInputView(input: string, cursor: number, maxWidth: number): InputView {
  const width = Math.max(1, maxWidth)
  const totalWidth = displayWidth(input)
  const cursorOffset = displayWidth(input.slice(0, cursor))
  if (totalWidth <= width) {
    return { text: input, cursorOffset, folded: false }
  }
  const before = cursorOffset
  const after = totalWidth - cursorOffset
  const leftFolded = before > 0
  const rightFolded = after > 0
  const markers = (leftFolded ? 1 : 0) + (rightFolded ? 1 : 0)
  const available = Math.max(1, width - markers)
  let beforeBudget = Math.min(before, Math.ceil(available / 2))
  let afterBudget = Math.min(after, available - beforeBudget)
  // If the tail is shorter than its budget, spend the spare columns on the
  // side before the cursor so the cursor stays visible near its true offset.
  beforeBudget = Math.min(before, beforeBudget + (available - beforeBudget - afterBudget))
  const beforeSlice = backwardSliceByWidth(input, cursor, beforeBudget)
  const afterSlice = forwardSliceByWidth(input.slice(cursor), afterBudget)
  const beforeText = input.slice(beforeSlice.start, cursor)
  return {
    text: `${leftFolded ? '…' : ''}${beforeText}${afterSlice.text}${rightFolded ? '…' : ''}`,
    cursorOffset: (leftFolded ? 1 : 0) + displayWidth(beforeText),
    folded: true,
  }
}

/**
 * Map a character index in the input text to its visual (row, col) after the
 * same width wrapping `wrap()` applies to the rendered input. `row` is the
 * 0-based input display line, `col` the 0-based column within that line
 * (before any prompt prefix). This keeps the cursor on the correct line/column
 * when the input contains literal newlines from multi-line pastes.
 */
function cursorVisualPosition(text: string, cursor: number, width: number): { row: number; col: number } {
  let row = 0
  let col = 0
  let used = 0
  let offset = 0
  for (const char of text) {
    if (offset >= cursor) break
    if (char === '\n') {
      row += 1
      col = 0
      used = 0
    } else {
      const charWidth = displayWidth(char)
      if (used + charWidth > width) {
        row += 1
        col = 0
        used = 0
      }
      used += charWidth
      col += charWidth
    }
    offset += char.length
  }
  return { row, col }
}

/** A recognized OpenCode provider route, used by /usage and /quota. */
export type OpenCodeFlavor = 'zen' | 'go'

export interface OpenCodeSource {
  provider: string
  flavor: OpenCodeFlavor
  label: string
  apiKeyEnv: string
  baseURL?: string
}

interface LlmPiAiProviderProfile {
  displayName?: unknown
  apiKeyEnv?: unknown
  baseURL?: unknown
  api?: unknown
  models?: unknown
  reasoning?: unknown
}

interface LlmPiAiSection {
  providers?: Record<string, LlmPiAiProviderProfile>
}

/** Build per-model reasoningEfforts from a provider-level reasoning default. */
function reasoningEffortsForDefault(reasoning: unknown): Record<string, string | null> | undefined {
  if (typeof reasoning !== 'string') return undefined
  const level = reasoning.trim()
  if (level === '' || level === 'off') return undefined
  return { off: null, [level]: level }
}

const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1'
const SUPERGROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const QUOTA_ALERT_THRESHOLDS = [50, 25, 10, 5] as const
/** Remaining % at or below this is “close” and uses the faster cadence. */
const QUOTA_NEAR_THRESHOLD_PERCENT = 55

/**
 * Classify the currently selected provider as an OpenCode route. Built-in
 * `opencode`/`opencode-go` ids are recognized directly, and custom llm-pi-ai
 * routes are recognized by their `opencode.ai` base URL.
 */
export function openCodeSourceFor(provider: string, llmPiAiSection: unknown): OpenCodeSource | null {
  const section = llmPiAiSection as LlmPiAiSection | null | undefined
  const profile = section?.providers?.[provider]
  const baseURL = typeof profile?.baseURL === 'string' ? profile.baseURL : undefined
  const lowerBase = baseURL?.toLowerCase() ?? ''
  const isGo = provider === 'opencode-go' || lowerBase.includes('opencode.ai/zen/go')
  const isZen = provider === 'opencode' || (lowerBase.includes('opencode.ai/zen') && !isGo)
  if (!isGo && !isZen) return null

  const apiKeyEnv = typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv.trim() !== ''
    ? profile.apiKeyEnv
    : provider === 'opencode'
      ? 'OPENCODE_API_KEY'
      : provider === 'opencode-go'
        ? 'OPENCODE_GO_API_KEY'
        : `${provider.replaceAll('-', '_').toUpperCase()}_API_KEY`
  const label = typeof profile?.displayName === 'string' && profile.displayName.trim() !== ''
    ? profile.displayName
    : isGo ? 'OpenCode Go' : 'OpenCode Zen'

  return {
    provider,
    flavor: isGo ? 'go' : 'zen',
    label,
    apiKeyEnv,
    ...(baseURL === undefined ? {} : { baseURL }),
  }
}

interface OpenCodeGoUsageWindow {
  status?: string
  percent?: number
  resetsAt?: string
}

interface OpenCodeGoUsagePayload {
  usage?: {
    rolling?: OpenCodeGoUsageWindow
    weekly?: OpenCodeGoUsageWindow
    monthly?: OpenCodeGoUsageWindow
  }
}

function openCodeGoUsageWindow(value: unknown): OpenCodeGoUsageWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  return {
    ...(typeof raw.status === 'string' ? { status: raw.status } : {}),
    ...(typeof raw.percent === 'number' && Number.isFinite(raw.percent) ? { percent: raw.percent } : {}),
    ...(typeof raw.resetsAt === 'string' ? { resetsAt: raw.resetsAt } : {}),
  }
}

/** A days/hours/minutes/seconds relative duration for quota reset times. */
function formatRelativeDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60)}m`
  }
  return `${Math.floor(seconds / 86400)}d${Math.floor(seconds % 86400 / 3600)}h`
}

/** One compact `████░░ 40.0% · 正常 · 约 2m 后重置` line for a Go limit. */
function formatOpenCodeGoWindow(label: string, value: unknown): string {
  const window = openCodeGoUsageWindow(value)
  const percent = window?.percent === undefined
    ? null
    : Math.max(0, Math.min(100, window.percent))
  const state = window?.status === 'rate-limited'
    ? '已限流'
    : window?.status === 'ok'
      ? '正常'
      : window?.status ?? '未知状态'
  const parts: string[] = [label]
  if (percent !== null) {
    const barWidth = 16
    const filled = Math.round(percent / 100 * barWidth)
    parts.push(`${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)} ${percent.toFixed(1)}%`)
  }
  parts.push(state)
  if (window?.resetsAt !== undefined) {
    const reset = new Date(window.resetsAt)
    if (!Number.isNaN(reset.getTime())) {
      const until = reset.getTime() - Date.now()
      parts.push(until > 0
        ? `约 ${formatRelativeDuration(until)} 后重置（${reset.toLocaleString()}）`
        : `已于 ${reset.toLocaleString()} 重置`)
    }
  }
  return `  ${parts.join(' · ')}`
}

export type QuotaPeriod = 'hourly' | 'weekly' | 'monthly' | 'unknown'

export interface QuotaWindow {
  label: string
  period: QuotaPeriod
  /** Remaining percent of the window (100 = unused). */
  remainingPercent: number
  resetsAt?: string
}

export interface QuotaSnapshot {
  provider: string
  plan: string
  windows: QuotaWindow[]
}

export function remainingPercentFromUsed(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 100
  return Math.max(0, Math.min(100, Math.round((100 - usedPercent) * 10) / 10))
}

/** Cross a remaining-percent threshold from above (50 / 25 / 10 / 5). */
export function crossedQuotaThresholds(previousRemaining: number | undefined, remaining: number): number[] {
  return QUOTA_ALERT_THRESHOLDS.filter(threshold =>
    remaining <= threshold && (previousRemaining === undefined || previousRemaining > threshold))
}

export function quotaAlertText(snapshot: QuotaSnapshot, window: QuotaWindow): string {
  const reset = window.resetsAt === undefined ? '' : `（${formatQuotaReset(window.resetsAt)}）`
  return `⚠ 请注意你的 ${snapshot.plan} 的每${quotaPeriodLabel(window.period)}额度还剩余 ${window.remainingPercent.toFixed(0)}%${reset}，请合理规划剩余额度的使用。`
}

/**
 * How often to re-fetch quota, based on the tightest window.
 * Hourly/5h: every 10 turns, every 4 when near a threshold.
 * Weekly: every 50 turns, every 10 when near.
 * Monthly: every 80 turns, every 20 when near.
 */
export function quotaRefreshEveryTurns(window: QuotaWindow | undefined): number {
  if (window === undefined) return 10
  const near = window.remainingPercent <= QUOTA_NEAR_THRESHOLD_PERCENT
  if (window.period === 'hourly') return near ? 4 : 10
  if (window.period === 'weekly') return near ? 10 : 50
  if (window.period === 'monthly') return near ? 20 : 80
  return near ? 10 : 50
}

function quotaPeriodLabel(period: QuotaPeriod): string {
  if (period === 'hourly') return '5 小时'
  if (period === 'weekly') return '周'
  if (period === 'monthly') return '月'
  return '周期'
}

function formatQuotaReset(iso: string): string {
  const reset = new Date(iso)
  if (Number.isNaN(reset.getTime())) return iso
  const until = reset.getTime() - Date.now()
  return until > 0 ? `约 ${formatRelativeDuration(until)} 后重置` : `已于 ${reset.toLocaleString()} 重置`
}

export function parseSuperGrokBilling(payload: unknown): QuotaSnapshot {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('SuperGrok 额度接口返回格式无法识别')
  }
  const root = payload as Record<string, unknown>
  const cfg = root.config
  if (cfg === null || typeof cfg !== 'object') {
    throw new Error('SuperGrok 额度接口返回格式无法识别')
  }
  const config = cfg as Record<string, unknown>
  const usedRaw = config.creditUsagePercent ?? config.credit_usage_percent
  const used = typeof usedRaw === 'number' && Number.isFinite(usedRaw) ? usedRaw : 0
  const periodRaw = config.currentPeriod ?? config.current_period
  const periodObj = periodRaw !== null && typeof periodRaw === 'object' ? periodRaw as Record<string, unknown> : undefined
  const type = typeof periodObj?.type === 'string' ? periodObj.type : ''
  const period: QuotaPeriod = type.includes('WEEKLY') ? 'weekly' : type.includes('MONTHLY') ? 'monthly' : 'unknown'
  const end = typeof periodObj?.end === 'string'
    ? periodObj.end
    : typeof config.billingPeriodEnd === 'string'
      ? config.billingPeriodEnd
      : typeof config.billing_period_end === 'string'
        ? config.billing_period_end
        : undefined
  const plan = typeof root.subscription_tier === 'string' && root.subscription_tier.trim() !== ''
    ? root.subscription_tier.trim()
    : typeof root.subscriptionTier === 'string' && root.subscriptionTier.trim() !== ''
      ? root.subscriptionTier.trim()
      : 'SuperGrok'
  return {
    provider: 'xai',
    plan,
    windows: [{
      label: period === 'monthly' ? '本月' : '本周',
      period: period === 'unknown' ? 'weekly' : period,
      remainingPercent: remainingPercentFromUsed(used),
      ...(end === undefined ? {} : { resetsAt: end }),
    }],
  }
}

export function parseOpenCodeGoQuota(payload: unknown, provider: string): QuotaSnapshot {
  const raw = payload as OpenCodeGoUsagePayload | null | undefined
  const usage = raw?.usage
  if (usage === null || usage === undefined) throw new Error('额度接口返回格式无法识别')
  const windows: QuotaWindow[] = []
  const push = (label: string, period: QuotaPeriod, value: unknown): void => {
    const window = openCodeGoUsageWindow(value)
    if (window?.percent === undefined) return
    windows.push({
      label,
      period,
      remainingPercent: remainingPercentFromUsed(window.percent),
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    })
  }
  push('滚动 5 小时', 'hourly', usage.rolling)
  push('本周', 'weekly', usage.weekly)
  push('本月', 'monthly', usage.monthly)
  if (windows.length === 0) throw new Error('额度接口返回格式无法识别')
  return { provider, plan: 'OpenCode Go', windows }
}

export function formatQuotaSnapshot(snapshot: QuotaSnapshot): string {
  const lines = [`${snapshot.plan} 额度（${snapshot.provider}）`]
  for (const window of snapshot.windows) {
    const remaining = Math.max(0, Math.min(100, window.remainingPercent))
    const barWidth = 16
    const filled = Math.round(remaining / 100 * barWidth)
    const reset = window.resetsAt === undefined ? '' : ` · ${formatQuotaReset(window.resetsAt)}`
    lines.push(`  ${window.label} · ${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)} 剩余 ${remaining.toFixed(1)}%${reset}`)
  }
  return lines.join('\n')
}

/** Tightest remaining window — used for threshold alerts. */
export function tightestQuotaWindow(snapshot: QuotaSnapshot): QuotaWindow | undefined {
  return snapshot.windows.reduce<QuotaWindow | undefined>((best, window) => {
    if (best === undefined || window.remainingPercent < best.remainingPercent) return window
    return best
  }, undefined)
}

/** Render the OpenCode Go quota payload as a transcript block. */
export function formatOpenCodeGoUsage(payload: unknown, source: OpenCodeSource): string {
  return formatQuotaSnapshot(parseOpenCodeGoQuota(payload, source.provider))
}

/** Extract a safe human-readable message from an OpenCode error payload. */
function openCodeApiErrorMessage(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return ''
  const raw = payload as Record<string, unknown>
  const error = raw.error
  if (typeof error === 'string' && error.trim() !== '') return error.trim()
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim() !== '') return message.trim()
  }
  if (typeof raw.message === 'string' && raw.message.trim() !== '') return raw.message.trim()
  return ''
}

/** Whether `text` could still grow into a recognized escape sequence. */
export function isEscapePrefix(text: string): boolean {
  if (text === '\x1b') return true
  if (!text.startsWith('\x1b')) return false
  if (text === '\x1b[') return true
  if (text === '\x1bO' || /^\x1bO[A-Z]?$/u.test(text)) return true
  if (/^\x1b\[[A-D]$/u.test(text)) return true
  if (/^\x1b\[[HF]$/u.test(text)) return true
  if (/^\x1b\[\d+~?$/u.test(text)) return true
  if (/^\x1b\[\d+(?:;\d+)?R?$/u.test(text)) return true
  if (/^\x1b\[<(?:\d*;?)*[Mm]?$/u.test(text)) return true
  return false
}

/** Parse a Device Status Report cursor reply (`CSI row;col R`). */
export function parseCursorPositionReply(text: string): { row: number; column: number } | undefined {
  const match = /^\x1b\[(\d+);(\d+)R$/u.exec(text)
  if (match === null) return undefined
  return { row: Number(match[1]), column: Number(match[2]) }
}

/**
 * Round-trip to the attached terminal via CSI 6n. Returns undefined when the
 * reply never arrives (dumb pipe, blocked DSR). Does not interpret the
 * coordinates — only the elapsed milliseconds matter.
 */
export async function probeTerminalRttMs(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
  timeoutMs = DSR_PROBE_TIMEOUT_MS,
): Promise<number | undefined> {
  if (!stdin.isTTY || !stdout.isTTY) return undefined
  return await new Promise(resolve => {
    let buffer = ''
    let settled = false
    const started = Date.now()
    const finish = (value: number | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stdin.removeListener('data', onData)
      resolve(value)
    }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      if (parseCursorPositionReply(buffer) !== undefined) {
        finish(Math.max(0, Date.now() - started))
        return
      }
      if (buffer.length > 32 && !buffer.includes('\x1b[')) finish(undefined)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    stdin.on('data', onData)
    try {
      stdout.write('\x1b[6n')
    } catch {
      finish(undefined)
    }
  })
}

/** Parse a tool call's raw arguments JSON into an object; null when unparsable. */
function parseJsonArgs(args: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(args)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/** A short scalar rendering of one argument value, or null for objects/arrays. */
function scalarText(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}

/** Take the first `max` code points of a string without splitting surrogates. */
function sliceCodePoints(text: string, max: number): string {
  if (max <= 0) return ''
  return Array.from(text).slice(0, max).join('')
}

/** Take the last `max` code points of a string without splitting surrogates. */
function lastCodePoints(text: string, max: number): string {
  if (max <= 0) return ''
  return Array.from(text).slice(-max).join('')
}

/** Format a model list compactly: show the first few entries and an ellipsis. */
function formatModelList(models: readonly string[], max = 5): string {
  const shown = models.slice(0, max)
  const text = shown.join(', ')
  return models.length > max ? `${text}…（共 ${models.length} 个）` : text
}

/** Prefer the fields a human scans for; fall back to the first scalar pairs. */
function friendlyArgsSummary(name: string, args: string): string {
  const parsed = parseJsonArgs(args)
  if (parsed === null) return sliceCodePoints(args, 120)
  const preferred = [
    'path', 'file_path', 'file', 'query', 'pattern', 'url', 'command',
    'description', 'content', 'file_text', 'old_string', 'new_string',
    'old_str', 'new_str', 'insert_line', 'line', 'offset', 'limit',
  ]
  const parts: string[] = []
  for (const key of preferred) {
    const value = parsed[key]
    if (value === undefined || value === null || typeof value === 'object') continue
    parts.push(`${key}: ${String(value)}`)
    if (parts.length >= 3) break
  }
  if (parts.length === 0) {
    for (const [key, value] of Object.entries(parsed)) {
      const text = scalarText(value)
      if (text !== null) {
        parts.push(`${key}: ${text}`)
        if (parts.length >= 3) break
      }
    }
  }
  const summary = parts.join('  ')
  return summary === '' ? name : sliceCodePoints(summary, 160)
}

const SHELL_TOOL_NAMES = new Set(['bash', 'pwsh'])
const DIFF_TOOL_NAMES = new Set(['edit', 'write', 'str_replace_editor'])
const SUBAGENT_TOOL_NAMES = new Set(['subagent', 'subagent_fork', 'task'])
const MAX_SUBAGENT_LOGS = 80

const TODO_STATUS_MARK: Record<PlanTodoItem['status'], string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
}

/** True while a plan still belongs in the dock (latest incomplete work). */
export function planIsLive(plan: {
  active: boolean
  pending: boolean
  todos: readonly PlanTodoItem[]
  planMarkdown?: string
  archived?: boolean
}): boolean {
  if (plan.archived === true) return false
  if (plan.active || plan.pending) return true
  if (plan.todos.some(item => item.status !== 'completed')) return true
  return false
}

/** Open todos left behind when a turn ends without a completing todo_write. */
export function planTurnLeftOpen(plan: {
  todos: readonly PlanTodoItem[]
}): boolean {
  return plan.todos.some(item => item.status !== 'completed')
}

/** Mark leftover in-progress/pending todos as display-stale after turn/end. */
export function applyTurnEndToPlan<T extends {
  todos: PlanTodoItem[]
  turnLeftOpen?: boolean
}>(plan: T): T {
  if (!planTurnLeftOpen(plan)) {
    plan.turnLeftOpen = false
    return plan
  }
  plan.turnLeftOpen = true
  return plan
}

/** Follow-up that asks the model to close leftover todos. One per open list. */
export function planCloseNudgeText(plan: {
  todos: readonly PlanTodoItem[]
}): string {
  const leftover = plan.todos.filter(item => item.status !== 'completed')
  const lines = leftover.map(item => `- [${item.status}] ${item.content}`)
  return [
    '本轮结束时计划条还有未完成待办。请立刻再调用一次 todo_write，把已经做完的标成 completed，还没做的留 pending。不要开新任务。',
    ...lines,
  ].join('\n')
}

export type CardCategory = 'thinking' | 'plan' | 'subagent' | 'reply' | 'tool' | 'question' | 'goal'

/** Category for jump / search. Assistant replies are not collapsible cards. */
export function cardCategoryOf(row: { kind: string }): CardCategory | undefined {
  if (row.kind === 'reasoning' || row.kind === 'streaming-reasoning') return 'thinking'
  if (row.kind === 'plan') return 'plan'
  if (row.kind === 'subagent') return 'subagent'
  if (row.kind === 'assistant') return 'reply'
  if (row.kind === 'tool') return 'tool'
  if (row.kind === 'question') return 'question'
  if (row.kind === 'goal') return 'goal'
  if (row.kind === 'compaction') return 'tool'
  return undefined
}

const CARD_CATEGORY_LABEL: Record<CardCategory, string> = {
  thinking: '思考',
  plan: '计划',
  subagent: '子代理',
  reply: '回复',
  tool: '工具',
  question: '提问',
  goal: '目标',
}

const SEARCHABLE_CATEGORIES: readonly CardCategory[] = ['thinking', 'plan', 'subagent', 'reply']

function parseCardCategoryToken(token: string): CardCategory | undefined {
  const id = token.trim().toLowerCase()
  if (id === 'thinking' || id === 'think' || id === '推理' || id === '思考') return 'thinking'
  if (id === 'plan' || id === '计划') return 'plan'
  if (id === 'subagent' || id === 'sub' || id === '子代理') return 'subagent'
  if (id === 'reply' || id === 'assistant' || id === '回复') return 'reply'
  if (id === 'tool' || id === '工具') return 'tool'
  if (id === 'question' || id === '提问') return 'question'
  if (id === 'goal' || id === '目标') return 'goal'
  return undefined
}

/** Split `/find thinking padAnsi` into an optional category and a query. */
export function parseFindQuery(raw: string): { category?: CardCategory; query: string } {
  const text = raw.trim()
  if (text === '') return { query: '' }
  const match = /^(\S+)(?:\s+(.*))?$/u.exec(text)
  if (match === null) return { query: text }
  const category = parseCardCategoryToken(match[1] ?? '')
  if (category === undefined) return { query: text }
  return { category, query: (match[2] ?? '').trim() }
}

function rowSearchHaystack(row: Row): string {
  switch (row.kind) {
    case 'reasoning':
    case 'assistant':
    case 'user':
    case 'system':
    case 'error':
    case 'brand':
      return row.text
    case 'tool':
      return `${row.title} ${row.summary} ${row.output} ${row.args}`
    case 'subagent':
      return `${row.label} ${row.lastActivity} ${row.logs.map(entry => entry.text).join('\n')}`
    case 'plan':
      return `${row.planMarkdown ?? ''} ${row.todos.map(item => item.content).join('\n')}`
    case 'question':
      return `${row.title} ${row.summary} ${row.detail ?? ''} ${row.header ?? ''}`
    case 'goal':
      return `${row.objective} ${row.blockedReason ?? ''}`
    case 'compaction':
      return `${row.summary ?? ''} ${row.error ?? ''}`
    default:
      return ''
  }
}

export function compactionHeaderText(row: {
  status: 'running' | 'ok' | 'error'
  pruneCount: number
  prunedTokens: number
  error?: string
}): string {
  const recovered = row.prunedTokens > 0
    ? `回收 ${formatTokens(row.prunedTokens)} token`
    : row.pruneCount > 0
      ? `修剪 ${row.pruneCount} 段`
      : '准备摘要'
  if (row.status === 'running') return `压缩上下文 · ${recovered}`
  if (row.status === 'error') return `压缩失败 · ${row.error ?? '未知错误'}`
  return `压缩完成 · ${recovered}`
}

/** Transcript rows matching a `/find` query, newest last. */
export function matchTranscriptRows(
  rows: readonly Row[],
  raw: string,
): Row[] {
  const { category, query } = parseFindQuery(raw)
  const needle = query.toLowerCase()
  return rows.filter(row => {
    const kind = cardCategoryOf(row)
    if (kind === undefined) return false
    if (category !== undefined && kind !== category) return false
    if (needle === '') return SEARCHABLE_CATEGORIES.includes(kind) || category !== undefined
    return rowSearchHaystack(row).toLowerCase().includes(needle)
  })
}

/** One-line note under an expanded plan strip. */
export function planDockNote(plan: {
  active: boolean
  pending: boolean
  todos: readonly PlanTodoItem[]
  planMarkdown?: string
  turnLeftOpen?: boolean
}): string {
  const running = plan.todos.some(item => item.status === 'in_progress')
  const allDone = plan.todos.length > 0 && plan.todos.every(item => item.status === 'completed')
  const leftover = plan.todos.filter(item => item.status !== 'completed').length
  if (plan.turnLeftOpen === true && leftover > 0) {
    return `本轮未收尾：还剩 ${leftover} 项待办（会话日志未改）。`
  }
  if (plan.pending) return '模式切换将在下一步生效。'
  if (plan.active) return '只规划、不改代码；确认后再执行。'
  if (running) return '正在按计划执行。'
  if (allDone) return '计划任务已全部完成。'
  if (plan.todos.length > 0 || (plan.planMarkdown !== undefined && plan.planMarkdown !== '')) {
    return '计划还在，尚未全部完成。'
  }
  return '计划模式已关闭，可用 /plan 重新进入。'
}

/** Compact per-status counts matching the web plan strip. */
export function todoProgressLabel(todos: readonly PlanTodoItem[]): string {
  const done = todos.filter(item => item.status === 'completed').length
  const active = todos.filter(item => item.status === 'in_progress').length
  const pending = todos.length - done - active
  const parts: string[] = []
  if (done > 0) parts.push(`${done} 已完成`)
  if (active > 0) parts.push(`${active} 进行中`)
  if (pending > 0) parts.push(`${pending} 待处理`)
  return parts.join(' · ')
}

function todoItemKind(status: PlanTodoItem['status']): DisplayKind {
  if (status === 'completed') return 'todo-done'
  if (status === 'in_progress') return 'todo-active'
  return 'todo-pending'
}

function planMarkdownFromArgs(value: unknown): string | undefined {
  const root = typeof value === 'string' ? parseJsonArgs(value) : value
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return undefined
  const plan = (root as { plan?: unknown }).plan
  return typeof plan === 'string' && plan.trim() !== '' ? plan : undefined
}

/** First markdown heading of an exit_plan_mode plan body. */
export function planTitleFromMarkdown(markdown: string): string | undefined {
  const match = /^\s*#\s+(.+)$/mu.exec(markdown)
  const title = match?.[1]?.trim()
  return title === undefined || title === '' ? undefined : title
}

/** Parse a todo_write payload into displayable plan items. */
export function parsePlanTodos(value: unknown): PlanTodoItem[] {
  const root = typeof value === 'string' ? parseJsonArgs(value) : value
  const todos = root !== null && typeof root === 'object' && !Array.isArray(root)
    ? (root as { todos?: unknown }).todos
    : Array.isArray(root) ? root : undefined
  if (!Array.isArray(todos)) return []
  const out: PlanTodoItem[] = []
  for (const item of todos) {
    if (typeof item !== 'object' || item === null) continue
    const content = typeof (item as { content?: unknown }).content === 'string'
      ? (item as { content: string }).content.trim()
      : ''
    if (content === '') continue
    const status = (item as { status?: unknown }).status
    out.push({
      content,
      status: status === 'in_progress' || status === 'completed' ? status : 'pending',
    })
  }
  return out
}

/** Compact todo-list summary: done/total plus the first in-progress task. */
export function todoSummary(value: unknown): string {
  const todos = parsePlanTodos(value)
  if (todos.length === 0) return '计划列表'
  const done = todos.filter(item => item.status === 'completed').length
  const active = todos.find(item => item.status === 'in_progress')
  const extra = todos.filter(item => item.status === 'in_progress').length
  const head = `${done}/${todos.length} 完成`
  if (active === undefined) return head
  return extra > 1 ? `${head} · ${active.content} +${extra - 1}` : `${head} · ${active.content}`
}

/** Compact ask_user_question summary from tool arguments. */
export function askSummary(value: unknown): string {
  const root = typeof value === 'string' ? parseJsonArgs(value) : value
  const questions = root !== null && typeof root === 'object' && !Array.isArray(root)
    ? (root as { questions?: unknown }).questions
    : undefined
  if (!Array.isArray(questions) || questions.length === 0) return '等待回答'
  const first = questions[0]
  const text = typeof first === 'object' && first !== null && typeof (first as { question?: unknown }).question === 'string'
    ? (first as { question: string }).question
    : '等待回答'
  return questions.length > 1 ? `${text}（${questions.length} 题）` : text
}

/** One-line subagent card header used while collapsed. */
export function subagentHeaderText(row: Extract<Row, { kind: 'subagent' }>, now = Date.now()): string {
  const elapsed = Math.max(0, Math.floor(((row.endedAt ?? now) - row.startedAt) / 1000))
  const elapsedLabel = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`
  const state = row.status === 'running'
    ? '运行中'
    : row.status === 'ok'
      ? '完成'
      : row.status === 'aborted'
        ? '已中断'
        : '失败'
  const activity = row.lastActivity === '' ? '' : ` · ${row.lastActivity}`
  const id = row.sessionId.slice(0, 8)
  return `${row.label}  [${id}]  ${state} · ${elapsedLabel}${activity}`
}

function appendSubagentLog(row: Extract<Row, { kind: 'subagent' }>, entry: SubagentLogEntry): void {
  row.logs.push(entry)
  if (row.logs.length > MAX_SUBAGENT_LOGS) row.logs.splice(0, row.logs.length - MAX_SUBAGENT_LOGS)
  row.lastActivity = entry.text
}

function planReviewOf(question: AskUserQuestionItem): boolean {
  return question.intent?.kind === 'plan-review' && question.detail !== undefined && question.detail !== ''
}

/** Derive the intended file change from a mutation tool's arguments. */
function diffHunksFromArgs(name: string, argsRaw: string): ToolDiffHunk[] | null {
  const args = parseJsonArgs(argsRaw)
  if (args === null) return null
  if (name === 'edit' || name === 'write') {
    const path = typeof args.file_path === 'string' ? args.file_path : ''
    if (path === '') return null
    if (name === 'edit') {
      return [{
        path,
        oldText: typeof args.old_string === 'string' ? args.old_string : null,
        newText: typeof args.new_string === 'string' ? args.new_string : '',
      }]
    }
    return [{
      path,
      oldText: null,
      newText: typeof args.content === 'string' ? args.content : '',
    }]
  }
  if (name === 'str_replace_editor') {
    const path = typeof args.path === 'string' ? args.path : ''
    const command = typeof args.command === 'string' ? args.command : ''
    if (path === '') return null
    if (command === 'create') {
      return [{ path, oldText: null, newText: typeof args.file_text === 'string' ? args.file_text : '' }]
    }
    if (command === 'str_replace') {
      return [{
        path,
        oldText: typeof args.old_str === 'string' ? args.old_str : null,
        newText: typeof args.new_str === 'string' ? args.new_str : '',
      }]
    }
  }
  return null
}

/** One-line friendly tool-call presentation (command / path / arg summary). */
export function presentToolCall(name: string, args: string): {
  title: string
  summary: string
  command?: string
  cwd?: string
  diff?: ToolDiffHunk[]
} {
  const parsed = parseJsonArgs(args)
  if (SHELL_TOOL_NAMES.has(name)) {
    const command = typeof parsed?.command === 'string' ? parsed.command : sliceCodePoints(args, 80)
    return {
      title: name,
      summary: `$ ${command}`,
      command,
      cwd: typeof parsed?.workdir === 'string' ? parsed.workdir : undefined,
    }
  }
  if (DIFF_TOOL_NAMES.has(name)) {
    const diff = diffHunksFromArgs(name, args)
    const path = diff?.[0]?.path
    return {
      title: name,
      summary: path ?? friendlyArgsSummary(name, args),
      ...diff === null || diff === undefined ? {} : { diff },
    }
  }
  if (SUBAGENT_TOOL_NAMES.has(name)) {
    const description = typeof parsed?.description === 'string' ? parsed.description.trim() : ''
    return {
      title: name === 'subagent_fork' ? '子代理 fork' : '子代理',
      summary: description === '' ? friendlyArgsSummary(name, args) : description,
    }
  }
  if (name === 'todo_write' || name === 'todo') {
    return { title: '更新待办', summary: todoSummary(parsed) }
  }
  if (name === 'ask_user_question') {
    return { title: '提问用户', summary: askSummary(parsed) }
  }
  if (name === 'exit_plan_mode') {
    const plan = typeof parsed?.plan === 'string' ? parsed.plan : ''
    return { title: '提交计划', summary: planTitleFromMarkdown(plan) ?? '等待确认计划' }
  }
  if (name === 'read') {
    const path = typeof parsed?.path === 'string' ? parsed.path
      : typeof parsed?.file_path === 'string' ? parsed.file_path
        : typeof parsed?.url === 'string' ? parsed.url
          : ''
    return { title: '读取', summary: path || friendlyArgsSummary(name, args) }
  }
  if (name === 'grep') {
    const pattern = typeof parsed?.pattern === 'string' ? parsed.pattern : ''
    const path = typeof parsed?.path === 'string' ? parsed.path : ''
    return { title: '搜索', summary: [pattern, path].filter(Boolean).join('  ') || friendlyArgsSummary(name, args) }
  }
  if (name === 'glob') {
    const pattern = typeof parsed?.pattern === 'string' ? parsed.pattern
      : typeof parsed?.glob_pattern === 'string' ? parsed.glob_pattern
        : ''
    return { title: '匹配文件', summary: pattern || friendlyArgsSummary(name, args) }
  }
  if (name === 'web_search') {
    const query = typeof parsed?.query === 'string' ? parsed.query : typeof parsed?.q === 'string' ? parsed.q : ''
    return { title: '网页搜索', summary: query || friendlyArgsSummary(name, args) }
  }
  if (name === 'web_fetch') {
    const url = typeof parsed?.url === 'string' ? parsed.url : ''
    return { title: '抓取网页', summary: url || friendlyArgsSummary(name, args) }
  }
  return { title: name, summary: friendlyArgsSummary(name, args) }
}

/** Validate a tool/result meta payload's structured diff, mirroring the web card. */
export function diffMetaDiffs(meta: unknown): ToolDiffHunk[] | null {
  if (typeof meta !== 'object' || meta === null) return null
  const diffs = (meta as { diffs?: unknown }).diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return null
  const out: ToolDiffHunk[] = []
  for (const hunk of diffs) {
    if (typeof hunk !== 'object' || hunk === null) return null
    const { path, oldText, newText } = hunk as Record<string, unknown>
    if (typeof path !== 'string' || typeof newText !== 'string') return null
    if (oldText !== null && typeof oldText !== 'string') return null
    out.push({ path, oldText: oldText as string | null, newText })
  }
  return out
}

/** Split one diff side into content lines (trailing newline is a terminator). */
function diffContentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/** One rendered diff body line with its display role. */
interface DiffDisplayLine {
  kind: DisplayKind
  text: string
}

/** Cap one flat diff/body row list to `maxLines` while preserving the final line. */
function capDisplayLines(lines: readonly DiffDisplayLine[], maxLines: number): DiffDisplayLine[] {
  const budget = Math.max(1, Math.floor(maxLines))
  if (lines.length <= budget) return [...lines]
  const omitted = lines.length - budget + 1
  const marker: DiffDisplayLine = { kind: 'tool-result', text: `… ${omitted} more line(s) …` }
  if (budget === 1) return [marker]
  return [...lines.slice(0, budget - 2), marker, ...lines.slice(-1)]
}

/** Flatten hunks into git-style `-`/`+` lines plus the web-compatible footer. */
export function renderToolDiff(diffs: ToolDiffHunk[], maxLines: number): DiffDisplayLine[] {
  const rows: DiffDisplayLine[] = []
  const paths = new Set<string>()
  let added = 0
  let removed = 0
  let prevPath: string | undefined
  for (const hunk of diffs) {
    paths.add(hunk.path)
    rows.push(hunk.path === prevPath
      ? { kind: 'diff-path', text: '⋯' }
      : { kind: 'diff-path', text: hunk.path })
    prevPath = hunk.path
    if (hunk.oldText !== null) {
      for (const line of diffContentLines(hunk.oldText)) {
        rows.push({ kind: 'diff-del', text: `- ${line}` })
        removed += 1
      }
    }
    for (const line of diffContentLines(hunk.newText)) {
      rows.push({ kind: 'diff-add', text: `+ ${line}` })
      added += 1
    }
  }
  rows.push({
    kind: 'tool-result',
    text: `└ +${added} -${removed} · ${paths.size} file${paths.size === 1 ? '' : 's'}`,
  })
  return capDisplayLines(rows, maxLines)
}

/** Keys whose multiline strings render as indented content blocks. */
const LONG_TEXT_KEYS = new Set([
  'program', 'content', 'file_text', 'new_string', 'old_string',
  'plan', 'markdown', 'details', 'description', 'text',
])

const JSON_STRING_CAP = 400
const JSON_MAX_DEPTH = 16
const JSON_MAX_ENTRIES = 60

/** Convert any parsed JSON value into readable indented display lines. */
export function friendlyJsonLines(value: unknown, depth = 0): string[] {
  const pad = '  '.repeat(depth)
  if (value === null) return [`${pad}null`]
  if (typeof value === 'string') {
    const capped = value.length > JSON_STRING_CAP ? `${value.slice(0, JSON_STRING_CAP)}…` : value
    return [`${pad}${capped}`]
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [`${pad}${String(value)}`]
  }
  if (depth >= JSON_MAX_DEPTH) {
    return [`${pad}…`]
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`]
    const shown = value.slice(0, JSON_MAX_ENTRIES)
    const lines: string[] = []
    for (const item of shown) {
      if (item !== null && typeof item === 'object') {
        lines.push(`${pad}-`)
        lines.push(...friendlyJsonLines(item, depth + 1))
      } else {
        lines.push(`${pad}- ${friendlyJsonLines(item, 0)[0] ?? ''}`)
      }
    }
    if (value.length > shown.length) lines.push(`${pad}… ${value.length - shown.length} more item(s)`)
    return lines
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return [`${pad}{}`]
    const shown = entries.slice(0, JSON_MAX_ENTRIES)
    const lines: string[] = []
    for (const [key, item] of shown) {
      if (typeof item === 'string' && item.includes('\n') && LONG_TEXT_KEYS.has(key)) {
        const contentLines = item.split('\n')
        lines.push(`${pad}${key}:`)
        for (const contentLine of contentLines.slice(0, 80)) {
          lines.push(`${pad}  │ ${contentLine}`)
        }
        if (contentLines.length > 80) {
          lines.push(`${pad}  … ${contentLines.length - 80} more line(s)`)
        }
      } else if (item !== null && typeof item === 'object') {
        lines.push(`${pad}${key}:`)
        lines.push(...friendlyJsonLines(item, depth + 1))
      } else {
        const scalar = friendlyJsonLines(item, 0)[0] ?? ''
        lines.push(`${pad}${key}: ${scalar}`)
      }
    }
    if (entries.length > shown.length) lines.push(`${pad}… ${entries.length - shown.length} more field(s)`)
    return lines
  }
  return [`${pad}${String(value)}`]
}

/** Minimal tool-row shape the expanded-body renderer reads. */
interface ToolBodySource {
  name?: string
  diff?: ToolDiffHunk[]
  command?: string
  status?: 'running' | 'ok' | 'error'
  output: string
  args: string
}

/** Try to parse a result body as one JSON document, when it looks like one. */
function parseJsonBody(text: string): unknown | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
}

/**
 * The expanded body of one tool card: diffs and shell output keep their
 * dedicated views; every other tool's JSON arguments and JSON result are
 * converted into readable indented content instead of raw JSON text.
 */
export function toolBodyLines(row: ToolBodySource, maxLines: number): DiffDisplayLine[] {
  if (row.diff !== undefined && row.diff.length > 0) {
    // File-edit diffs are never truncated: omitting hunks would hide the
    // exact code change the model applied. `maxLines` only governs shell and
    // generic JSON output bodies.
    return renderToolDiff(row.diff, Number.MAX_SAFE_INTEGER)
  }
  if (row.command !== undefined) {
    const out: DiffDisplayLine[] = []
    if (row.output !== '') {
      for (const line of truncate(row.output, maxLines).split('\n')) {
        out.push({ kind: row.status === 'error' ? 'error' : 'tool-result', text: line })
      }
    } else if (row.status !== 'running' && row.status !== undefined) {
      out.push({ kind: 'tool-result', text: '(无输出)' })
    }
    return out
  }

  const specialized = specializedToolBody(row)
  if (specialized !== null) return capDisplayLines(specialized, maxLines)

  const out: DiffDisplayLine[] = []
  const args = parseJsonArgs(row.args)
  if (args !== null && Object.keys(args).length > 0) {
    out.push({ kind: 'diff-path', text: '参数' })
    for (const line of friendlyJsonLines(args)) {
      out.push({ kind: 'tool-result', text: line })
    }
  }
  if (row.output !== '') {
    out.push({ kind: 'diff-path', text: '结果' })
    const parsed = parseJsonBody(row.output)
    if (parsed !== null) {
      for (const line of friendlyJsonLines(parsed)) {
        out.push({ kind: 'tool-result', text: line })
      }
    } else {
      for (const line of truncate(row.output, maxLines).split('\n')) {
        out.push({ kind: 'tool-result', text: line })
      }
    }
  }
  return capDisplayLines(out, maxLines)
}

interface NamedToolBodySource extends ToolBodySource {
  name?: string
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

function specializedToolBody(row: NamedToolBodySource): DiffDisplayLine[] | null {
  const name = row.name ?? ''
  const args = parseJsonArgs(row.args)
  if (name === 'todo_write' || name === 'todo') {
    const todos = parsePlanTodos(args ?? row.args)
    const out: DiffDisplayLine[] = [{ kind: 'diff-path', text: todoProgressLabel(todos) || '待办列表' }]
    if (todos.length === 0) {
      out.push({ kind: 'tool-result', text: '还没有任务' })
    } else {
      for (const item of todos) {
        out.push({ kind: todoItemKind(item.status), text: `${TODO_STATUS_MARK[item.status]} ${item.content}` })
      }
    }
    return out
  }
  if (name === 'exit_plan_mode') {
    const markdown = planMarkdownFromArgs(args ?? row.args) ?? ''
    const out: DiffDisplayLine[] = [{ kind: 'diff-path', text: planTitleFromMarkdown(markdown) ?? '待审计划' }]
    if (markdown === '') {
      out.push({ kind: 'tool-result', text: '计划正文为空' })
    } else {
      for (const line of markdown.split('\n')) {
        out.push({ kind: 'assistant', text: line })
      }
    }
    return out
  }
  if (name === 'read' && args !== null) {
    const path = firstString(args, ['path', 'file_path', 'url'])
    const out: DiffDisplayLine[] = []
    if (path !== '') out.push({ kind: 'diff-path', text: path })
    const offset = typeof args.offset === 'number' ? args.offset : undefined
    const limit = typeof args.limit === 'number' ? args.limit : undefined
    if (offset !== undefined || limit !== undefined) {
      out.push({ kind: 'tool-result', text: `offset ${offset ?? 1}${limit === undefined ? '' : ` · limit ${limit}`}` })
    }
    if (row.output !== '') {
      for (const line of truncate(row.output, 40).split('\n')) {
        out.push({ kind: 'tool-result', text: line })
      }
    } else if (row.status === 'running') {
      out.push({ kind: 'tool-result', text: '读取中…' })
    }
    return out.length > 0 ? out : null
  }
  if ((name === 'grep' || name === 'glob') && args !== null) {
    const pattern = firstString(args, ['pattern', 'glob_pattern', 'query'])
    const path = firstString(args, ['path', 'glob'])
    const out: DiffDisplayLine[] = [{ kind: 'diff-path', text: [pattern, path].filter(Boolean).join('  ') || name }]
    if (row.output !== '') {
      for (const line of truncate(row.output, 30).split('\n')) {
        out.push({ kind: 'tool-result', text: line })
      }
    }
    return out
  }
  if ((name === 'web_search' || name === 'web_fetch') && args !== null) {
    const query = firstString(args, ['query', 'q', 'url'])
    const out: DiffDisplayLine[] = [{ kind: 'diff-path', text: query || name }]
    if (row.output !== '') {
      for (const line of truncate(row.output, 24).split('\n')) {
        out.push({ kind: 'assistant', text: line })
      }
    }
    return out
  }
  return null
}

/** Recover the shell tools' exit marker, mirroring @deepseek-ai/dsh-shell/render. */
export function parseExitStatus(text: string): {
  body: string
  exitCode?: number
  signal?: string
} {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal?.[1] !== undefined) {
    return { body: text.slice(0, signal.index), signal: signal[1] }
  }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined) {
    return { body: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  }
  return { body: text, exitCode: 0 }
}

/** Compact token count, matching the web stats line (517 / 12.2K / 1.2M). */
export function formatTokens(n: number): string {
  const scaled = (value: number): string =>
    value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** Compact duration, matching the web stats line (45.2s / 2m42s). */
export function formatDuration(ms: number): string {
  const seconds = ms / 1_000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

export function formatTokensPerSecond(tokensPerSecond: number): string {
  return `${Math.round(tokensPerSecond)} tok/s`
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Owns one interactive terminal channel and its agent event wiring. */
export class SshTui {
  private readonly rows: Row[] = []
  private streaming: { text: string; reasoning: string } | undefined
  private input = ''
  private cursor = 0
  private inputFolded = false
  private inPaste = false
  private history: string[] = []
  private historyIndex = -1
  private status = 'idle'
  private dialog: Dialog | undefined
  private readonly dialogQueue: Dialog[] = []
  private onboardingCompletion: Promise<boolean> | undefined
  private dirty = true
  private disposed = false
  private exiting = false
  private renderTimer: ReturnType<typeof setInterval> | undefined
  private readonly decoder = new StringDecoder('utf8')
  private readonly color: boolean
  private readonly maxToolOutputLines: number
  private readonly showReasoning: boolean
  private readonly goodbye: string
  private readonly resume: boolean
  private readonly providerName: string
  private readonly selectionRef: ModelSelectionRef | undefined
  private readonly subagentSelection: SubagentSelectionRef
  private readonly onSwitchSession: ((sessionId: string) => Promise<void> | void) | undefined
  private readonly onSelectionChanged: ((selection: ModelSelection) => void) | undefined
  private readonly resumePicker: boolean
  private readonly disposers: (() => void)[] = []
  private userQuestionDisposer: (() => void) | undefined
  private presetId = 'standard'
  private presetName = '标准模式'
  private readonly useAlternateScreen: boolean
  private agentGone = false
  private onboarding: OnboardingState | undefined
  private commandSuggestions: { name: string; description: string; local: boolean }[] = []
  private suggestionIndex = 0
  private focusedRow: CollapsibleBlock | null = null
  private pendingMessages = new Map<string, string>()
  private lastActivity = Date.now()
  private stalledWarningShown = false
  private lastPaintAt = 0
  private commandAbort: AbortController | undefined
  private activeSubagents = new Map<string, { id: string; provider: string; startedAt: number }>()
  private subagentSessions = new Set<string>()
  private openToolCalls = new Map<string, string>()
  private readonly stats: SessionStats = {
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  }
  private openStepStats: { turn: number; step: number; startTime: number; firstTokenTime: number | null } | undefined
  private readonly pendingToolTimes = new Map<string, number>()
  private readonly usageByStep = new Map<string, SessionStats['usage']>()
  private lastStatsTurn: number | null = null
  private scrollOffset = 0
  private readonly clickableRows = new Map<number, CollapsibleBlock>()
  private streamingReasoning: { kind: 'streaming-reasoning'; expanded: boolean } | undefined
  private escapeBuffer = ''
  private escapeTimer: ReturnType<typeof setTimeout> | undefined
  private thinkingStartedAt: number | undefined
  private completionSignaled = false
  private replaying = false
  private completedAt = 0
  private lastTitleUpdateAt = 0
  private lastPaintRows: string[] = []
  private lastChromeKey = ''
  private lastPaintWidth = 0
  private lastPaintHeight = 0
  private paintIntervalMs: number
  private paintLink: PaintLinkKind = 'local'
  private paintProbed = false
  private sessionTitle = ''
  private llmRetry: { retry: number; maxRetries: number; delayMs: number; message: string } | undefined
  private quotaSnapshot: QuotaSnapshot | undefined
  private quotaAlerted = new Set<string>()
  private quotaTurnsSinceRefresh = 0
  private quotaRefreshInFlight = false
  private searchHits: Row[] = []
  private searchIndex = -1
  private searchQuery = ''
  private planNudgePending = false
  private pendingReveal: Row | CollapsibleBlock | undefined

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    config: TuiConfig,
  ) {
    const noColorEnv = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== ''
    this.color = config.color !== false && !noColorEnv && process.env.TERM !== 'dumb'
    this.maxToolOutputLines = Math.max(1, config.maxToolOutputLines ?? 6)
    this.showReasoning = config.showReasoning !== false
    this.goodbye = config.goodbye
      ?? this.ctx.get('tuiGoodbyeMessage') as string | undefined
      ?? `To resume this session: dsh --profile tui --resume=${this.agent.id}`
    this.resume = config.resume === true
    this.providerName = config.provider ?? 'deepseek-official'
    this.selectionRef = config.selectionRef
    this.subagentSelection = config.subagentSelection ?? { current: { model: DEFAULT_SUBAGENT_MODEL } }
    this.onSwitchSession = config.onSwitchSession
    this.onSelectionChanged = config.onSelectionChanged
    this.resumePicker = config.resumePicker === true
    this.presetId = config.presetId ?? 'standard'
    this.presetName = config.presetName ?? this.presetId
    this.useAlternateScreen = process.env.DSH_TUI_NO_ALT_SCREEN !== '1' && process.env.DSH_TUI_NO_ALT_SCREEN !== 'true'
    this.paintLink = detectSshSession() ? 'ssh' : 'local'
    this.paintIntervalMs = resolvePaintIntervalMs(config.paintIntervalMs, process.env, {
      ssh: this.paintLink === 'ssh',
    })
    this.pushRow({ kind: 'brand-logo' })
    this.pushRow({ kind: 'system', text: 'DeepSeek Harness — SSH TUI' })
    this.pushRow({ kind: 'system', text: '输入 /help 查看快捷键 · /find 搜索思考/计划/子代理/回复 · 空输入时 ↑/↓ 选卡片' })
  }

  /** Enter raw mode, switch to the alternate screen, and start listening. */
  start(): void {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdout.on('resize', this.markDirty)
    process.on('SIGWINCH', this.markDirty)

    this.disposers.push(
      this.ctx.on('session/event', this.handleSessionEvent),
      this.ctx.on('agent/status', this.handleStatus),
      this.ctx.on('agent/error', this.handleError),
      this.ctx.on('agent/disposed', this.handleDisposed),
      this.ctx.on('agent/inbox/claimed', this.handleInboxClaimed),
      this.ctx.on('agent/inbox/discarded', this.handleInboxDiscarded),
      this.ctx.on('agent/request', this.handleAgentRequest),
      this.ctx.on('subagent/start', this.handleSubagentStart),
      this.ctx.on('subagent/end', this.handleSubagentEnd),
      this.ctx.on('approval/request', this.handleApproval),
    )
    const questions = this.ctx.get('userQuestions')
    if (questions !== undefined) {
      this.userQuestionDisposer = questions.registerProvider({ ask: this.handleUserQuestions })
    }

    this.write(`${this.useAlternateScreen ? '\x1b[?1049h' : ''}\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?25l`)
    this.render()
    this.updateTerminalTitle()
    if (this.resumePicker) {
      void this.runResumeCommand('', true)
    }
    void this.calibratePaintInterval().finally(() => {
      if (this.disposed) return
      process.stdin.on('data', this.handleData)
      this.startRenderTimer()
    })

    void this.maybeRunOnboarding().catch((error: unknown) => {
      if (this.disposed) return
      this.pushRow({ kind: 'error', text: `首次配置检查失败: ${errorChain(error)}` })
      this.markDirty()
    })
    void this.syncSubagentToProvider(this.currentProviderId()).catch((error: unknown) => {
      if (this.disposed) return
      this.pushRow({ kind: 'error', text: `同步子代理模型失败: ${errorChain(error)}` })
      this.markDirty()
    })
    void this.refreshQuota({ reason: 'start', announce: true }).catch(() => {
      // Start-up quota is best-effort; /usage still reports errors.
    })
    void this.notifyPluginUpdate().catch(() => {
      // Update check is best-effort and never blocks the TUI.
    })
  }

  private async notifyPluginUpdate(): Promise<void> {
    const notice = await checkForPluginUpdate(PLUGIN_VERSION)
    if (this.disposed || notice === undefined) return
    this.pushRow({ kind: 'system', text: notice })
    this.markDirty()
  }

  private startRenderTimer(): void {
    if (this.renderTimer !== undefined) {
      clearInterval(this.renderTimer)
      this.renderTimer = undefined
    }
    this.renderTimer = setInterval(() => {
      const now = Date.now()
      if (this.agent.status === 'running') this.updateTerminalTitle()
      const animating = (this.streaming !== undefined && this.streaming.reasoning !== '')
        || this.activeSubagents.size > 0
        || this.rows.some(row =>
          (row.kind === 'question' && row.status === 'waiting')
          || (row.kind === 'plan' && (row.active || row.pending || row.todos.some(item => item.status === 'in_progress')))
          || (row.kind === 'goal' && (row.phase === 'active' || row.phase === 'blocked'))
          || (row.kind === 'compaction' && row.status === 'running'))
      if (animating && now - this.lastPaintAt >= Math.max(this.paintIntervalMs, 200)) {
        this.dirty = true
      }
      const idleWaiting = this.agent.status === 'running' && !this.dirty
      if (idleWaiting && now - this.lastPaintAt < 1000) return
      if (this.agent.status === 'running' && !this.dirty && now - this.lastPaintAt >= 1000) {
        this.dirty = true
      }
      if (this.dirty) {
        this.lastPaintAt = now
        this.render()
      }
    }, this.paintIntervalMs)
    this.renderTimer.unref?.()
  }

  private async calibratePaintInterval(): Promise<void> {
    const envOverride = Number.parseInt(process.env.DSH_TUI_PAINT_MS ?? '', 10)
    if (Number.isFinite(envOverride) && envOverride > 0) {
      this.paintProbed = false
      this.pushRow({
        kind: 'system',
        text: `${paintLinkLabel(this.paintLink, this.paintIntervalMs, false)} · DSH_TUI_PAINT_MS`,
      })
      return
    }
    if (this.paintLink !== 'ssh') {
      this.pushRow({ kind: 'system', text: paintLinkLabel('local', this.paintIntervalMs, false) })
      return
    }
    const rtt = await probeTerminalRttMs()
    if (this.disposed) return
    this.paintProbed = rtt !== undefined
    this.paintIntervalMs = resolvePaintIntervalMs(undefined, {}, { ssh: true, rttMs: rtt })
    this.pushRow({
      kind: 'system',
      text: rtt === undefined
        ? paintLinkLabel('ssh', this.paintIntervalMs, false)
        : `${paintLinkLabel('ssh', this.paintIntervalMs, true)} · 往返 ${Math.round(rtt)}ms`,
    })
    this.markDirty()
  }

  /** Replay the durable session log so a resumed session renders its history. */
  replayHistory(): void {
    this.replaying = true
    try {
      for (const event of this.agent.session.events) {
        this.handleSessionEvent(this.agent.session, event)
      }
    } finally {
      this.replaying = false
    }
    this.streaming = undefined
    this.streamingReasoning = undefined
    this.thinkingStartedAt = undefined
    this.status = this.agent.status === 'running' ? 'running' : 'idle'
    this.dirty = true
  }

  /** Show the first-launch provider/API-key onboarding when nothing is configured. */
  private async maybeRunOnboarding(): Promise<void> {
    const credentials = this.ctx.get('credentials')
    const provider = this.currentProviderId()
    if (providerUsesLocalOAuth(provider)) {
      this.pushRow({
        kind: 'system',
        text: `当前是 ${describeProviderRoute(provider).kind}（${provider}），走本机 SuperGrok / X Premium OAuth，无需 API Key。用 /model 切换 Grok 模型和思考强度；只有要改成 DeepSeek 官方或 OpenCode 这类 Key 提供商时才需要 /setup。`,
      })
      this.markDirty()
      return
    }
    const envRef = provider === 'deepseek-official' ? 'DEEPSEEK_API_KEY' : envRefForId(provider)
    const envKey = process.env[envRef]
    let stored = false
    if (credentials !== undefined) {
      stored = (await credentials.describe(credentialRef(envRef))).configured
      if (this.disposed) return
    }
    if (!stored) {
      // Belt-and-braces: the file provider may not have its in-memory snapshot
      // visible to this plugin copy yet; the managed document is authoritative.
      try {
        const credentialFile = join(dshHomeDir(), '.credentials.yaml')
        if (existsSync(credentialFile)) {
          const content = await readFile(credentialFile, 'utf8')
          if (this.disposed) return
          stored = new RegExp(`^${escapeRegex(envRef)}\\s*:\\s*\\S`, 'm').test(content)
        }
      } catch {
        // Ignore unreadable/missing documents; the wizard will ask again.
      }
    }
    if (envKey !== undefined && envKey !== '') {
      if (stored || existsSync(DSH_ENV_FILE) || this.resume) {
        this.pushRow({
          kind: 'system',
          text: `当前使用 ${envRef}（环境变量/启动环境文件）。如需更换，随时输入 /setup 重新配置。`,
        })
        this.markDirty()
        return
      }
      this.pushRow({
        kind: 'system',
        text: `检测到系统已注入 ${envRef}（可能已失效）。首次启动向导将覆盖为你的 Key，保存后重启 TUI 生效。`,
      })
      await this.runOnboarding()
      return
    }
    if (stored || this.resume) return
    this.pushRow({ kind: 'system', text: '首次启动：请先配置提供商和 API Key（随时可输入 /setup 重新配置）。' })
    await this.runOnboarding()
  }

  /** Run the provider/API-key onboarding wizard. Resolves true when saved. */
  private runOnboarding(): Promise<boolean> {
    if (this.onboardingCompletion !== undefined) return this.onboardingCompletion
    this.onboardingCompletion = new Promise<boolean>((resolve) => {
      this.onboarding = {
        step: 'provider',
        providerType: 'official',
        providerId: '',
        baseUrl: '',
        key: '',
        models: [],
        saving: false,
        resolve: (saved) => {
          this.onboardingCompletion = undefined
          resolve(saved)
        },
      }
      this.input = ''
      this.cursor = 0
      this.dialog = { kind: 'onboarding' }
      this.markDirty()
    })
    return this.onboardingCompletion
  }

  private cancelOnboarding(): void {
    const state = this.onboarding
    if (state === undefined || state.saving) return
    this.onboarding = undefined
    if (this.dialog?.kind === 'onboarding') this.dialog = undefined
    this.input = ''
    this.cursor = 0
    state.resolve(false)
    this.showNextDialog()
    this.markDirty()
  }

  /** Restore the terminal, flush the session, and request process exit. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.exiting = true
    const dialog = this.dialog
    const queued = this.dialogQueue.splice(0)
    this.dialog = undefined
    if (dialog !== undefined) {
      if (dialog.kind === 'confirm') {
        dialog.resolve('cancel')
      } else if (dialog.kind === 'questions') {
        dialog.reject(new UserQuestionError('TUI closed before the question was answered', 'ASK_ABORTED'))
      } else {
        this.cancelOnboarding()
      }
    }
    for (const pending of queued) {
      if (pending.kind === 'confirm') {
        pending.resolve('cancel')
      } else if (pending.kind === 'questions') {
        pending.reject(new UserQuestionError('TUI closed before the question was answered', 'ASK_ABORTED'))
      }
    }
    if (this.renderTimer !== undefined) clearInterval(this.renderTimer)
    this.renderTimer = undefined
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer)
    this.escapeTimer = undefined
    this.commandAbort?.abort()
    this.commandAbort = undefined
    for (const dispose of this.disposers.splice(0)) {
      dispose()
    }
    this.userQuestionDisposer?.()
    this.userQuestionDisposer = undefined
    process.stdin.removeListener('data', this.handleData)
    process.stdout.removeListener('resize', this.markDirty)
    process.removeListener('SIGWINCH', this.markDirty)
    process.stdin.setRawMode(false)
    process.stdin.pause()
    this.write('\x1b]0;\x07')
    // Clear every screen (regular + scrollback) before restoring the terminal.
    // In no-alternate-screen mode this removes the last painted frame that
    // would otherwise stay behind the shell prompt after exit.
    this.write('\x1b[0m\x1b[2J\x1b[3J\x1b[H')
    this.write(`\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h${this.useAlternateScreen ? '\x1b[?1049l' : ''}`)
  }

  /** Human-facing exit with goodbye and flush; called from key handling. */
  async requestExit(code: number): Promise<void> {
    if (this.exiting) return
    this.exiting = true
    await this.dispose()
    process.stdout.write(`\n${sanitizeTerminalText(this.goodbye)}\n`)
    try {
      await this.ctx.get('sessions')?.flush(this.agent.session)
    } catch (error) {
      process.stdout.write(`dsh-ssh-tui: failed to flush session: ${errorChain(error)}\n`)
    }
    const exit = this.ctx.get('appExit')
    if (exit !== undefined) exit(code)
    else process.exit(code)
  }

  // ── terminal output ─────────────────────────────────────────────────────

  /** Capture one painted frame. Used by README screenshot fixtures. */
  captureFrame(columns = 80, rows = 24): string[] {
    const previousColumns = process.stdout.columns
    const previousRows = process.stdout.rows
    const previousWrite = this.write.bind(this)
    this.write = () => {}
    process.stdout.columns = columns
    process.stdout.rows = rows
    try {
      this.paint()
      return [...this.lastPaintRows]
    } finally {
      this.write = previousWrite
      process.stdout.columns = previousColumns
      process.stdout.rows = previousRows
    }
  }

  private write(chunk: string): void {
    process.stdout.write(chunk)
  }

  private markDirty = (): void => {
    this.dirty = true
  }

  /** Append one transcript row, bounding memory on long sessions. */
  private pushRow(row: Row): void {
    this.rows.push(row)
    if (this.rows.length > MAX_TRANSCRIPT_ROWS) {
      const removed = this.rows.length - MAX_TRANSCRIPT_ROWS
      if (this.focusedRow !== null
        && this.focusedRow.kind !== 'streaming-reasoning'
        && this.rows.indexOf(this.focusedRow) < removed) {
        this.focusedRow = null
      }
      this.rows.splice(0, removed)
    }
  }

  /** The transcript rows that support per-row expand/collapse. */
  private collapsibleRows(): CollapsibleBlock[] {
    const rows: CollapsibleBlock[] = this.rows.filter(
      (row): row is Extract<Row, { kind: 'reasoning' } | { kind: 'tool' } | { kind: 'subagent' } | { kind: 'plan' } | { kind: 'question' } | { kind: 'goal' } | { kind: 'compaction' }> =>
        row.kind === 'reasoning'
        || row.kind === 'tool'
        || row.kind === 'subagent'
        || row.kind === 'plan'
        || row.kind === 'question'
        || row.kind === 'goal'
        || row.kind === 'compaction')
    if (this.streaming !== undefined && this.streaming.reasoning !== '') {
      this.streamingReasoning ??= { kind: 'streaming-reasoning', expanded: false }
      rows.push(this.streamingReasoning)
    }
    return rows
  }

  private spinnerFrame(periodMs = 120): string {
    return SPINNER[Math.floor(Date.now() / periodMs) % SPINNER.length] ?? '⠋'
  }

  private findSubagentRow(sessionId: string): Extract<Row, { kind: 'subagent' }> | undefined {
    return this.rows.findLast((row): row is Extract<Row, { kind: 'subagent' }> =>
      row.kind === 'subagent' && row.sessionId === sessionId)
  }

  private findLivePlanRow(): Extract<Row, { kind: 'plan' }> | undefined {
    return this.rows.findLast((row): row is Extract<Row, { kind: 'plan' }> =>
      row.kind === 'plan' && planIsLive(row))
  }

  /** Older / finished plans stay in the scrolling transcript. */
  private archiveStalePlans(keep?: Extract<Row, { kind: 'plan' }>): void {
    for (const row of this.rows) {
      if (row.kind !== 'plan' || row === keep) continue
      if (row.archived === true) continue
      row.archived = true
      row.active = false
      row.pending = false
      row.expanded = false
    }
  }

  private upsertPlanRow(patch: Partial<Extract<Row, { kind: 'plan' }>>): Extract<Row, { kind: 'plan' }> {
    const existing = this.findLivePlanRow()
    // A new docked plan only starts when the current one is no longer live
    // (completed / archived). Re-entering plan mode on the same incomplete
    // list must keep updating that row, not archive it.
    if (existing !== undefined && planIsLive(existing)) {
      Object.assign(existing, patch)
      existing.archived = false
      if (patch.todos !== undefined || patch.active !== undefined || patch.pending !== undefined) {
        existing.turnLeftOpen = false
        this.planNudgePending = false
      }
      if (!planIsLive(existing)) {
        existing.archived = true
        existing.expanded = false
      }
      this.archiveStalePlans(planIsLive(existing) ? existing : undefined)
      return existing
    }
    if (existing !== undefined) {
      existing.archived = true
      existing.active = false
      existing.pending = false
      existing.expanded = false
    }
    const row: Extract<Row, { kind: 'plan' }> = {
      kind: 'plan',
      active: patch.active ?? false,
      pending: patch.pending ?? false,
      todos: patch.todos ?? [],
      ...(patch.planMarkdown === undefined ? {} : { planMarkdown: patch.planMarkdown }),
      expanded: false,
      archived: false,
    }
    this.pushRow(row)
    this.archiveStalePlans(row)
    return row
  }

  /** Whether the live plan strip should occupy the workspace footer. */
  private shouldDockPlan(): boolean {
    return this.findLivePlanRow() !== undefined
  }

  /** One follow-up per leftover list; replay and cancelled turns stay quiet. */
  private queuePlanCloseNudge(plan: Extract<Row, { kind: 'plan' }>): void {
    if (this.replaying || this.agentGone || this.planNudgePending) return
    if (this.agent.status === 'running') return
    this.planNudgePending = true
    const text = planCloseNudgeText(plan)
    this.pushRow({ kind: 'system', text: '已请模型补一次待办状态（本轮只问一次）。' })
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    try {
      this.agent.followup(message)
    } catch (error: unknown) {
      this.planNudgePending = false
      this.pushRow({ kind: 'error', text: `补待办状态失败：${errorChain(error)}` })
    }
  }

  /** Compact web-style plan strip pinned above the input, not in the transcript. */
  private paintPlanDock(width: number, yieldBottom: boolean): string[] {
    const plan = this.findLivePlanRow()
    if (plan === undefined) return []
    const inner = Math.max(1, width - 2)
    const running = plan.todos.some(item => item.status === 'in_progress')
    const allDone = plan.todos.length > 0 && plan.todos.every(item => item.status === 'completed')
    const leftOpen = plan.turnLeftOpen === true && !allDone && !plan.pending
    const spinner = (plan.pending || ((plan.active || running) && !leftOpen)) ? ` ${this.spinnerFrame()}` : ''
    const mode = plan.pending ? '切换中'
      : leftOpen ? '本轮未收尾'
      : plan.active ? '计划模式'
      : running ? '计划'
      : allDone ? '计划完成'
      : '计划'
    const counts = todoProgressLabel(plan.todos)
    const title = planTitleFromMarkdown(plan.planMarkdown ?? '')
    const summary = title ?? (counts === '' ? '还没有任务' : counts)
    const marker = plan.expanded ? '▾' : '▸'
    const focused = this.focusedRow === plan ? '▶ ' : '  '
    const header = `${focused}${marker} ${mode}${spinner} · ${summary}${plan.expanded || yieldBottom ? '' : ' · Enter 展开'}`
    const lines = [this.styleLine('plan-dock', padToWidth(header, width))]
    if (yieldBottom || !plan.expanded) return lines

    const note = planDockNote(plan)
    lines.push(this.styleLine('plan-dock', padToWidth(`   ${note}`, width)))
    if (plan.planMarkdown !== undefined && plan.planMarkdown !== '') {
      const markdown = renderMarkdownLines(plan.planMarkdown, inner, this.color)
      const budget = Math.max(4, Math.min(12, markdown.length))
      for (const line of markdown.slice(0, budget)) {
        lines.push(`${clipAnsiToWidth(`  ${line}`, width)}\x1b[0m`)
      }
      if (markdown.length > budget) {
        lines.push(this.styleLine('plan-dock', padToWidth(`   … 还有 ${markdown.length - budget} 行计划`, width)))
      }
    }
    if (plan.todos.length === 0) {
      if (plan.planMarkdown === undefined || plan.planMarkdown === '') {
        lines.push(this.styleLine('todo-pending', padToWidth('   还没有任务列表', width)))
      }
    } else {
      for (const item of plan.todos) {
        const mark = TODO_STATUS_MARK[item.status]
        const kind = todoItemKind(item.status)
        for (const wrapped of wrap(`${mark} ${item.content}`, inner)) {
          lines.push(this.styleLine(kind, padToWidth(`  ${wrapped}`, width)))
        }
      }
    }
    return lines
  }

  private paintCollapsibleHeader(
    addDisplay: (line: string, ref?: Row | CollapsibleBlock) => void,
    row: CollapsibleBlock,
    kind: DisplayKind,
    header: string,
    width: number,
    colorize?: (line: string) => string,
  ): void {
    const focused = this.focusedRow === row
    const marker = row.expanded ? '▾' : '▸'
    const prefix = focused ? '▶ ' : '  '
    const plain = `${prefix}${marker} ${header}`
    const paint = colorize ?? ((line: string) => this.styleLine(kind, line))
    if (!row.expanded) {
      const collapsed = truncateToWidth(plain, Math.max(1, width - 2))
      const styled = paint(collapsed)
      addDisplay(focused && this.color ? `\x1b[7m${styled}\x1b[27m` : styled, row)
      return
    }
    for (const wrapped of wrap(plain, width)) {
      const styled = paint(wrapped)
      addDisplay(focused && this.color ? `\x1b[7m${styled}\x1b[27m` : styled, row)
    }
  }

  /** Move the expand/collapse focus among reasoning and tool rows. */
  private moveCollapsibleFocus(delta: number): void {
    const rows = this.collapsibleRows()
    if (rows.length === 0) return
    if (this.focusedRow === null) {
      const target = delta >= 0 ? rows[0] : rows[rows.length - 1]
      if (target !== undefined) this.focusedRow = target
    } else {
      const current = rows.indexOf(this.focusedRow)
      const next = rows[current === -1 ? (delta >= 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, current + delta))]
      if (next !== undefined) this.focusedRow = next
    }
    this.markDirty()
  }

  /** Toggle the focused block; without focus, toggle the most recent one. */
  private toggleCollapsible(): void {
    const rows = this.collapsibleRows()
    if (rows.length === 0) return
    const focused = this.focusedRow !== null && rows.includes(this.focusedRow)
      ? this.focusedRow
      : undefined
    const target = focused ?? rows[rows.length - 1]
    if (target === undefined) return
    target.expanded = !target.expanded
    this.focusedRow = target
    this.markDirty()
  }

  /** Expand all collapsible blocks, or collapse them again when all are open. */
  private toggleAllCollapsible(): void {
    const rows = this.collapsibleRows()
    if (rows.length === 0) return
    const allExpanded = rows.every(row => row.expanded)
    for (const row of rows) row.expanded = !allExpanded
    this.focusedRow = allExpanded ? null : rows[rows.length - 1] ?? null
    this.markDirty()
  }

  private highlightSearchLine(line: string): string {
    if (line.includes('\x1b[7m')) return line
    return this.color ? `\x1b[7m${line}\x1b[27m` : `» ${line}`
  }

  private revealRow(row: Row | CollapsibleBlock | undefined): void {
    if (row === undefined) return
    if (row.kind !== 'assistant' && 'expanded' in row) {
      row.expanded = true
      this.focusedRow = row as CollapsibleBlock
    } else {
      this.focusedRow = null
    }
    this.pendingReveal = row
    this.markDirty()
  }

  private focusCard(row: Row | CollapsibleBlock | undefined): void {
    this.revealRow(row)
  }

  /** Jump to the newest card in a category (thinking / plan / subagent / reply). */
  private jumpToCategory(category: CardCategory): void {
    if (category === 'plan') {
      const live = this.findLivePlanRow()
      if (live !== undefined) {
        this.focusCard(live)
        this.pushRow({ kind: 'system', text: `已跳到${CARD_CATEGORY_LABEL[category]}（底栏计划条）。` })
        this.revealRow(live)
        return
      }
    }
    const target = this.rows.findLast(row => cardCategoryOf(row) === category)
    if (target === undefined) {
      this.pushRow({ kind: 'system', text: `当前没有${CARD_CATEGORY_LABEL[category]}卡片。` })
      this.markDirty()
      return
    }
    this.pushRow({ kind: 'system', text: `已跳到最新${CARD_CATEGORY_LABEL[category]}。` })
    this.revealRow(target)
  }

  private applySearchHits(query: string, hits: Row[]): void {
    this.searchQuery = query
    this.searchHits = hits
    if (hits.length === 0) {
      this.searchIndex = -1
      this.pushRow({ kind: 'system', text: query === '' ? '没有可搜索的卡片。' : `没有匹配「${query}」的卡片。` })
      this.markDirty()
      return
    }
    this.searchIndex = hits.length - 1
    const hit = hits[this.searchIndex]
    const where = hit === undefined ? '' : CARD_CATEGORY_LABEL[cardCategoryOf(hit) ?? 'reply']
    this.pushRow({
      kind: 'system',
      text: `找到 ${hits.length} 条${query === '' ? '' : `「${query}」`} · 第 ${hits.length}/${hits.length} 条（${where}）。Ctrl+G / Alt+N 下一条，Alt+P 上一条。`,
    })
    this.revealRow(hit)
  }

  private runFindCommand(arg: string): void {
    const parsed = parseFindQuery(arg)
    const label = parsed.category === undefined ? '' : `${CARD_CATEGORY_LABEL[parsed.category]} `
    const hits = matchTranscriptRows(this.rows, arg)
    this.applySearchHits(`${label}${parsed.query}`.trim(), hits)
  }

  private stepSearch(delta: number): void {
    if (this.searchHits.length === 0) {
      this.pushRow({ kind: 'system', text: '还没有搜索结果。用 /find 思考 padAnsi，或 Ctrl+/ 打开搜索。' })
      this.markDirty()
      return
    }
    const count = this.searchHits.length
    this.searchIndex = (this.searchIndex + delta + count) % count
    const hit = this.searchHits[this.searchIndex]
    const where = hit === undefined ? '' : CARD_CATEGORY_LABEL[cardCategoryOf(hit) ?? 'reply']
    this.pushRow({
      kind: 'system',
      text: `搜索「${this.searchQuery}」· 第 ${this.searchIndex + 1}/${count} 条（${where}）。`,
    })
    this.revealRow(hit)
  }

  private paint = (): void => {
    if (this.exiting) return
    const width = Math.max(10, process.stdout.columns || 80)
    const height = Math.max(6, process.stdout.rows || 24)

    const display: string[] = []
    const displayRefs: (Row | CollapsibleBlock | undefined)[] = []
    const searchHit = this.searchHits[this.searchIndex]
    const addDisplay = (
      line: string,
      ref?: Row | CollapsibleBlock,
    ): void => {
      const hit = ref !== undefined && ref === searchHit
      display.push(hit ? this.highlightSearchLine(line) : line)
      displayRefs.push(ref)
    }
    const pushRow = (kind: DisplayKind, text: string, ref?: Row): void => {
      if (kind === 'assistant') {
        for (const line of renderMarkdownLines(text, width, this.color)) {
          addDisplay(line, ref)
        }
        return
      }
      for (const line of wrap(text, width)) {
        addDisplay(this.styleLine(kind, line), ref)
      }
    }

    for (const row of this.rows) {
      if (row.kind === 'brand-logo') {
        const variant = DEEPSEEK_LOGO_VARIANTS.find(candidate => candidate.width <= width - 2)
          ?? DEEPSEEK_LOGO_VARIANTS[DEEPSEEK_LOGO_VARIANTS.length - 1]
        for (const line of variant.lines) {
          const pad = Math.max(0, Math.floor((width - displayWidth(line)) / 2))
          addDisplay(this.styleLine('brand', ' '.repeat(pad) + line))
        }
        const wordmark = 'DeepSeek'
        const wordmarkPad = Math.max(0, Math.floor((width - displayWidth(wordmark)) / 2))
        addDisplay(this.styleLine('brand', ' '.repeat(wordmarkPad) + wordmark))
        continue
      }
      if (row.kind === 'reasoning') {
        const focused = this.focusedRow === row
        const marker = row.expanded ? '▾' : '▸'
        const lines = row.text.split('\n').length
        const header = `${marker} 已思考 · ${lines} 行${row.expanded ? '' : ' · Enter 展开'}`
        const line = `${focused ? '▶ ' : '  '}${header}`
        const styled = this.styleLine('reasoning', line)
        addDisplay(focused && this.color ? `\x1b[7m${styled}\x1b[27m` : styled, row)
        if (row.expanded) {
          for (const wrapped of wrap(row.text, width)) {
            addDisplay(this.styleLine('reasoning', wrapped), row)
          }
        }
        continue
      }
      if (row.kind === 'tool') {
        const running = row.status === undefined || row.status === 'running'
        const ok = row.status === 'ok'
        // The status dot carries its own ANSI color. `styleLine` sanitizes its
        // input, so embedding the escape sequence there would leave literal
        // "[33m" text on screen; color the dot between two sanitized halves.
        const dotColor = !this.color ? undefined : running ? '33' : ok ? '32' : '31'
        const styleToolHeader = (line: string): string => {
          const safe = sanitizeTerminalText(line)
          if (!this.color) return safe
          const dotIndex = safe.indexOf('●')
          if (dotColor === undefined || dotIndex === -1) return this.styleLine('tool', safe)
          return `\x1b[33m${safe.slice(0, dotIndex)}\x1b[${dotColor}m●\x1b[33m${safe.slice(dotIndex + 1)}\x1b[0m`
        }
        const spinner = running ? ` ${this.spinnerFrame()}` : ''
        const state = running ? 'running…' : ok ? 'ok' : 'error'
        const summary = row.summary === '' ? '' : `  ${row.summary}`
        const exit = !running && row.command !== undefined
          ? row.signal !== undefined
            ? `  [信号 ${row.signal}]`
            : (row.exitCode ?? 0) !== 0
              ? `  [退出码 ${row.exitCode}]`
              : ''
          : ''
        const focused = this.focusedRow === row
        const marker = row.expanded ? '▾' : '▸'
        const plainHeader = `${marker} ● ${row.title}${summary}  [${state}]${exit}${spinner}`
        if (!row.expanded) {
          const collapsed = truncateToWidth(
            `${focused ? '▶ ' : '  '}${plainHeader}`,
            Math.max(1, width - 2),
          )
          const styled = styleToolHeader(collapsed)
          addDisplay(focused && this.color ? `\x1b[7m${styled}\x1b[27m` : styled, row)
          continue
        }
        for (const wrapped of wrap(plainHeader, width)) {
          addDisplay(styleToolHeader(wrapped), row)
        }
        for (const line of toolBodyLines(row, this.maxToolOutputLines)) {
          const inner = Math.max(1, width - 2)
          const fillRow = line.kind === 'diff-add' || line.kind === 'diff-del'
          for (const wrapped of wrap(line.text, inner)) {
            const body = fillRow ? padToWidth(`  ${wrapped}`, width) : `  ${wrapped}`
            addDisplay(this.styleLine(line.kind, body), row)
          }
        }
        continue
      }
      if (row.kind === 'subagent') {
        const running = row.status === 'running'
        const ok = row.status === 'ok'
        const dotColor = !this.color ? undefined : running ? '33' : ok ? '32' : '31'
        const styleHeader = (line: string): string => {
          const safe = sanitizeTerminalText(line)
          if (!this.color) return safe
          const dotIndex = safe.indexOf('●')
          if (dotColor === undefined || dotIndex === -1) return this.styleLine('tool', safe)
          return `\x1b[33m${safe.slice(0, dotIndex)}\x1b[${dotColor}m●\x1b[33m${safe.slice(dotIndex + 1)}\x1b[0m`
        }
        const spinner = running ? ` ${this.spinnerFrame()}` : ''
        const header = `● ${subagentHeaderText(row)}${spinner}${row.expanded ? '' : ' · Enter 展开'}`
        this.paintCollapsibleHeader(addDisplay, row, 'tool', header, width, styleHeader)
        if (row.expanded) {
          addDisplay(this.styleLine('tool-result', `  会话 ${row.sessionId} · ${row.provider}${row.local ? '' : ' · 外部进程'}`), row)
          if (row.stopReason !== undefined) {
            addDisplay(this.styleLine('tool-result', `  结束原因：${row.stopReason}`), row)
          }
          if (row.logs.length === 0) {
            addDisplay(this.styleLine('tool-result', running ? '  等待子代理输出…' : '  没有可见输出'), row)
          } else {
            for (const entry of row.logs) {
              const kind: DisplayKind = entry.kind === 'assistant'
                ? 'assistant'
                : entry.kind === 'result' && row.status === 'error'
                  ? 'error'
                  : 'tool-result'
              for (const wrapped of wrap(entry.text, Math.max(1, width - 2))) {
                addDisplay(this.styleLine(kind, `  ${wrapped}`), row)
              }
            }
          }
        }
        continue
      }
      if (row.kind === 'plan') {
        if (planIsLive(row) && this.findLivePlanRow() === row) continue
        const counts = todoProgressLabel(row.todos)
        const title = planTitleFromMarkdown(row.planMarkdown ?? '')
        const summary = title ?? (counts === '' ? '已归档' : counts)
        const header = `计划 · ${summary}${row.expanded ? '' : ' · Enter 展开'}`
        this.paintCollapsibleHeader(addDisplay, row, 'plan-dock', header, width)
        if (row.expanded) {
          addDisplay(this.styleLine('plan-dock', `   ${planDockNote({ ...row, active: false, pending: false })}`), row)
          if (row.planMarkdown !== undefined && row.planMarkdown !== '') {
            for (const line of renderMarkdownLines(row.planMarkdown, Math.max(1, width - 2), this.color).slice(0, 8)) {
              addDisplay(`  ${line}`, row)
            }
          }
          for (const item of row.todos) {
            const mark = TODO_STATUS_MARK[item.status]
            for (const wrapped of wrap(`${mark} ${item.content}`, Math.max(1, width - 2))) {
              addDisplay(this.styleLine(todoItemKind(item.status), `  ${wrapped}`), row)
            }
          }
        }
        continue
      }
      if (row.kind === 'question') {
        const waiting = row.status === 'waiting'
        const spinner = waiting ? ` ${this.spinnerFrame()}` : ''
        const state = waiting ? '等待回答' : row.status === 'answered' ? '已回答' : '已取消'
        const title = row.intent === 'plan-review' ? '计划待审' : '提问用户'
        const header = `● ${title}${spinner} · ${state} · ${row.summary}${row.expanded ? '' : ' · Enter 展开'}`
        this.paintCollapsibleHeader(addDisplay, row, waiting ? 'tool' : 'system', header, width)
        if (row.expanded) {
          if (row.header !== undefined) addDisplay(this.styleLine('system', `  ${row.header}`), row)
          for (const wrapped of wrap(row.title, Math.max(1, width - 2))) {
            addDisplay(this.styleLine('assistant', `  ${wrapped}`), row)
          }
          if (row.detail !== undefined && row.detail !== '') {
            if (row.intent === 'plan-review') {
              for (const line of renderMarkdownLines(row.detail, Math.max(1, width - 2), this.color)) {
                addDisplay(`  ${line}`, row)
              }
            } else {
              for (const wrapped of wrap(row.detail, Math.max(1, width - 2))) {
                addDisplay(this.styleLine('tool-result', `  ${wrapped}`), row)
              }
            }
          }
          addDisplay(this.styleLine('system', waiting
            ? '  用下方对话框选择，数字/字母选中，Enter 提交，Esc 取消。'
            : `  ${row.summary}`), row)
        }
        continue
      }
      if (row.kind === 'goal') {
        const live = row.phase === 'active' || row.phase === 'blocked'
        const spinner = live ? ` ${this.spinnerFrame()}` : ''
        const phase = row.phase === 'active' ? '进行中'
          : row.phase === 'paused' ? '已暂停'
          : row.phase === 'blocked' ? '受阻'
          : row.phase === 'complete' ? '已完成'
          : '已清除'
        const header = `● 目标${spinner} · ${phase} · ${row.objective}${row.expanded ? '' : ' · Enter 展开'}`
        this.paintCollapsibleHeader(addDisplay, row, live ? 'tool' : 'system', header, width)
        if (row.expanded) {
          addDisplay(this.styleLine('system', '  用 /goal 查看、暂停、恢复或清除当前目标。'), row)
          if (row.blockedReason !== undefined) {
            for (const wrapped of wrap(row.blockedReason, Math.max(1, width - 2))) {
              addDisplay(this.styleLine('error', `  ${wrapped}`), row)
            }
          }
        }
        continue
      }
      if (row.kind === 'compaction') {
        const running = row.status === 'running'
        const spinner = running ? ` ${this.spinnerFrame()}` : ''
        const elapsed = Math.max(0, Math.floor(((row.endedAt ?? Date.now()) - row.startedAt) / 1000))
        const header = `● ${compactionHeaderText(row)}${spinner} · ${elapsed}s${row.expanded ? '' : ' · Enter 展开'}`
        this.paintCollapsibleHeader(addDisplay, row, running ? 'tool' : row.status === 'error' ? 'error' : 'system', header, width)
        if (row.expanded) {
          addDisplay(this.styleLine('system', running
            ? '  正在压缩会话上下文，完成后旧工具结果会被摘要替换。'
            : row.status === 'error'
              ? `  ${row.error ?? '压缩失败'}`
              : '  压缩已写入会话日志，模型下一轮会看到更短的历史。'), row)
          if (row.summary !== undefined && row.summary !== '') {
            for (const wrapped of wrap(row.summary, Math.max(1, width - 2)).slice(0, 12)) {
              addDisplay(this.styleLine('assistant', `  ${wrapped}`), row)
            }
          }
        }
        continue
      }
      pushRow(row.kind, row.text, row)
    }

    if (this.streaming !== undefined) {
      if (this.showReasoning && this.streaming.reasoning !== '') {
        const block = this.streamingReasoning ??= { kind: 'streaming-reasoning', expanded: false }
        const focused = this.focusedRow === block
        const marker = block.expanded ? '▾' : '▸'
        const spinner = SPINNER[Math.floor(Date.now() / 120) % SPINNER.length]
        const chars = this.streaming.reasoning.length
        const elapsed = this.thinkingStartedAt === undefined
          ? 0
          : Math.floor((Date.now() - this.thinkingStartedAt) / 1000)
        const header = `${marker} 思考中 ${spinner} · ${chars} 字${elapsed > 0 ? ` · ${elapsed}s` : ''}`
        const line = `${focused ? '▶ ' : '  '}${header}`
        const styled = this.styleLine('reasoning', line)
        addDisplay(focused && this.color ? `\x1b[7m${styled}\x1b[27m` : styled, block)
        if (block.expanded) {
          for (const wrapped of wrap(this.streaming.reasoning, width)) {
            addDisplay(this.styleLine('reasoning', wrapped), block)
          }
        }
      }
      if (this.streaming.text !== '') {
        // Streaming text is the model's live token stream: while reasoning is
        // being produced (before a final assistant message has assembled) it
        // can contain the raw thinking/chain-of-thought. Rendering it as
        // markdown here would style that thinking instead of keeping it in the
        // collapsible reasoning block, so keep the in-progress stream plain.
        // The completed assistant message is what gets markdown-rendered.
        for (const line of wrap(this.streaming.text, width)) {
          addDisplay(this.styleLine('assistant', line))
        }
      }
    }

    const dialogLines: string[] = []
    const addDialog = (text: string): void => {
      for (const wrapped of wrap(text, Math.max(1, width))) {
        dialogLines.push(this.styleLine('system', wrapped))
      }
    }
    if (this.dialog !== undefined) {
      if (this.dialog.kind === 'confirm') {
        addDialog(this.dialog.prompt)
        addDialog(`  ${this.dialog.hint}`)
      } else if (this.dialog.kind === 'onboarding') {
        const ob = this.onboarding
        if (ob !== undefined) {
          const template = PROVIDER_TEMPLATES[ob.providerType]
          const providerLabel = `${template.label}${template.defaultBaseUrl === '' ? '' : `（${template.defaultBaseUrl}）`}`
          switch (ob.step) {
            case 'provider':
              addDialog('首次配置向导 — 选择提供商（与官方 Models 页一致）')
              addDialog('  1  DeepSeek 官方（api.deepseek.com）')
              addDialog('  2  OpenCode Go（opencode.ai/zen/go，Responses 协议）')
              addDialog('  3  自定义 OpenAI 兼容网关（Completions）')
              addDialog('  4  自定义 OpenAI Responses 网关')
              addDialog('  5  Anthropic Messages 兼容网关')
              addDialog('  按 1-5 选择，Esc 取消')
              break
            case 'id':
              addDialog(`提供商：${providerLabel}`)
              addDialog('Provider ID（小写字母/数字/连字符，永久标识）：')
              addDialog(`  默认：${template.defaultId}`)
              addDialog('  Enter 确认，Esc 取消')
              break
            case 'key':
              addDialog(`提供商：${providerLabel}`)
              addDialog('请输入 API Key（输入时以 • 显示）：')
              addDialog('  Enter 确认，Esc 取消')
              break
            case 'base-url':
              addDialog(`提供商：${providerLabel}`)
              addDialog(`请输入 Base URL（留空使用 ${template.defaultBaseUrl || '官方/模板默认'}）：`)
              addDialog('  Enter 确认，Esc 取消')
              break
            case 'models':
              addDialog(`提供商：${providerLabel}`)
              addDialog('模型 ID（多个用逗号或空格分隔）：')
              addDialog(ob.models.length > 0
                ? `  已获取（${ob.models.length}）：${formatModelList(ob.models, 6)}`
                : `  默认：${template.defaultModels.join(', ')}`)
              if (template.api !== undefined) addDialog('  Ctrl+F = 从端点获取模型列表')
              addDialog('  Enter 确认，Esc 取消')
              break
            case 'confirm':
              addDialog('确认保存以下配置？')
              addDialog(`  提供商:  ${providerLabel}`)
              addDialog(`  Provider ID: ${ob.providerId}`)
              addDialog(`  Base URL: ${ob.baseUrl === '' ? (template.defaultBaseUrl || '(默认)') : ob.baseUrl}`)
              addDialog(`  API 协议: ${template.api ?? 'deepseek-official'}`)
              addDialog(`  模型: ${formatModelList(ob.models, 8)}`)
              addDialog(`  API Key:  ${sliceCodePoints(ob.key, 6)}…${lastCodePoints(ob.key, 4)}（长度 ${ob.key.length}）`)
              addDialog('  y = 保存, n = 重填, Esc = 取消')
              break
          }
        }
      } else {
        const d = this.dialog
        const review = planReviewOf(d.question)
        if (review) {
          addDialog(`计划待审 ${d.index + 1}/${d.total}${d.question.header === undefined ? '' : ` · ${d.question.header}`}`)
          addDialog(d.question.question)
          if (d.question.detail !== undefined && d.question.detail !== '') {
            for (const line of renderMarkdownLines(d.question.detail, Math.max(1, width - 2), this.color).slice(0, 16)) {
              dialogLines.push(this.styleLine('assistant', line))
            }
          }
        } else {
          addDialog(`提问用户 ${d.index + 1}/${d.total}: ${d.question.question}`)
          if (d.question.header !== undefined && d.question.header !== '') addDialog(d.question.header)
          if (d.question.detail !== undefined && d.question.detail !== '') {
            addDialog(truncate(d.question.detail, 6))
          }
        }
        const options = d.question.options ?? []
        const approve = d.question.intent?.approve
        for (const [index, option] of options.entries()) {
          const marker = d.selected.has(index) ? '●' : '○'
          const key = QUESTION_OPTION_KEYS[index] ?? '?'
          const recommended = option.label === approve ? '（推荐）' : ''
          const extra = option.description === undefined ? '' : ` — ${option.description}`
          addDialog(`  ${key} ${marker} ${option.label}${recommended}${extra}`)
        }
        if (options.length === 0) {
          addDialog('  （自由输入：在下方输入后按 Enter）')
        }
        addDialog(`  ${d.question.multiSelect === true ? '数字/字母切换，Enter 提交' : '数字/字母选择，Enter 提交'}，Esc 取消`)
      }
    }

    const fitLine = (text: string): string => truncateToWidth(text, Math.max(1, width))
    const headerLines = [
      this.styleLine('system', fitLine(`DeepSeek Harness — SSH TUI  [${this.presetName}]  ${this.currentSelectionLabel()}`)),
      this.styleLine('system', repeatToWidth('─', width)),
    ]
    if (this.scrollOffset > 0) {
      headerLines.push(this.styleLine('system', fitLine(`↑ 已回看 ${this.scrollOffset} 行 · PgUp/PgDn/滚轮滚动 · Esc 回到底部`)))
    }
    this.commandSuggestions = this.dialog === undefined ? this.buildSuggestions() : []
    if (this.suggestionIndex >= this.commandSuggestions.length) {
      this.suggestionIndex = Math.max(0, this.commandSuggestions.length - 1)
    }
    const suggestionLines: string[] = []
    for (const [index, command] of this.commandSuggestions.entries()) {
      const marker = index === this.suggestionIndex ? '›' : ' '
      const line = `  ${marker} /${command.name.padEnd(14)} ${command.description}${command.local ? '' : '  (dsh)'}`
      suggestionLines.push(index === this.suggestionIndex && this.color
        ? `\x1b[7m${fitLine(line)}\x1b[27m`
        : this.styleLine('system', fitLine(line)))
    }

    const promptPlain = this.color ? '❯ ' : '> '
    const prompt = this.color ? `\x1b[36m${promptPlain.trimEnd()}\x1b[0m ` : promptPlain
    const promptWidth = displayWidth(promptPlain)
    const masked = this.dialog?.kind === 'onboarding' && this.onboarding?.step === 'key'
    const inputView: InputView = masked
      ? { text: '•'.repeat(this.input.length), cursorOffset: displayWidth('•'.repeat(this.cursor)), folded: false }
      : this.inputFolded
        ? foldInputView(this.input, this.cursor, Math.max(1, width - promptWidth))
        : { text: this.input, cursorOffset: displayWidth(this.input.slice(0, this.cursor)), folded: false }
    const inputTextWidth = Math.max(1, width - promptWidth)
    const inputTextLines = wrap(inputView.text, inputTextWidth)
    const inputDisplayLines = inputTextLines.map((line, index) =>
      index === 0 ? `${prompt}${line}` : line)

    // Cursor visual position. Folded/masked views are single-line and use
    // the existing flat offset model; normal multi-line input maps the cursor
    // index through the same wrap() layout so it stays on the right line.
    let cursorRowOffset: number
    let column: number
    if (inputView.folded || masked) {
      const grid = Math.max(1, width)
      const cursorPlainOffset = promptWidth + inputView.cursorOffset
      if (
        !inputView.folded
        && cursorPlainOffset > 0
        && cursorPlainOffset % grid === 0
        && Math.floor(cursorPlainOffset / grid) >= inputDisplayLines.length
      ) {
        inputDisplayLines.push('')
      }
      cursorRowOffset = Math.min(
        Math.floor(cursorPlainOffset / grid),
        Math.max(0, inputDisplayLines.length - 1),
      )
      column = cursorPlainOffset % grid + 1
      if (
        cursorPlainOffset > 0
        && cursorPlainOffset % grid === 0
        && Math.floor(cursorPlainOffset / grid) >= inputDisplayLines.length
      ) {
        column = grid
      }
    } else {
      const pos = cursorVisualPosition(inputView.text, this.cursor, inputTextWidth)
      // A cursor exactly at the end of a full-width row sits at the start of
      // the next row; if that row does not exist yet, reserve an empty row.
      if (pos.col === inputTextWidth) {
        if (pos.row + 1 >= inputDisplayLines.length) inputDisplayLines.push('')
        cursorRowOffset = Math.min(pos.row + 1, Math.max(0, inputDisplayLines.length - 1))
        column = (cursorRowOffset === 0 ? promptWidth : 0) + 1
      } else {
        cursorRowOffset = Math.min(pos.row, Math.max(0, inputDisplayLines.length - 1))
        column = (pos.row === 0 ? promptWidth : 0) + pos.col + 1
      }
    }
    const inputRows = Math.max(1, inputDisplayLines.length)

    const yieldPlanDock = this.dialog !== undefined || suggestionLines.length > 0
    const planDockLines = this.shouldDockPlan()
      ? this.paintPlanDock(width, yieldPlanDock)
      : []
    const inputDivider = this.styleLine('system', repeatToWidth('─', width))
    const reserved = RESERVED_BOTTOM_LINES + (inputRows - 1) + headerLines.length + suggestionLines.length + planDockLines.length + 1
    const available = Math.max(1, height - reserved - dialogLines.length)
    const maxOffset = Math.max(0, display.length - available)
    const reveal = this.pendingReveal
    if (reveal !== undefined) {
      this.pendingReveal = undefined
      const first = displayRefs.findIndex(ref => ref === reveal)
      if (first !== -1) {
        let last = first
        while (last + 1 < displayRefs.length && displayRefs[last + 1] === reveal) last += 1
        const span = last - first + 1
        this.scrollOffset = Math.max(0, display.length - available - first)
      }
    }
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset
    const start = Math.max(0, display.length - available - this.scrollOffset)
    const visible = display.slice(start, start + available)
    const visibleRefs = displayRefs.slice(start, start + available)
    const padding = Math.max(0, available - visible.length)
    for (let index = 0; index < padding; index++) {
      visible.unshift('')
      visibleRefs.unshift(undefined)
    }
    this.clickableRows.clear()
    for (let index = 0; index < visibleRefs.length; index++) {
      const ref = visibleRefs[index]
      if (ref !== undefined && 'expanded' in ref) this.clickableRows.set(headerLines.length + index + 1, ref)
    }
    const dockPlan = this.findLivePlanRow()
    if (dockPlan !== undefined && planDockLines.length > 0) {
      const dockTop = headerLines.length + visible.length + 1
      this.clickableRows.set(dockTop, dockPlan)
    }

    const statsText = this.statsText()
    const statsLine = this.styleLine('system', fitLine(statsText === '' ? '— 尚无会话统计' : statsText))

    let statusText = `${this.status}  [${this.presetName}]  ${this.currentSelectionLabel()}`
    const sub = this.subagentSelection.current
    const subProvider = sub.provider ?? this.selectionRef?.current?.provider ?? this.agent.options.provider ?? this.providerName
    const subEffort = sub.reasoningEffort === undefined ? '' : `(${sub.reasoningEffort})`
    statusText += sub.provider === undefined
      ? ` · sub:${sub.model}${subEffort}`
      : ` · sub:${subProvider}/${sub.model}${subEffort}`
    if (this.searchHits.length > 0 && this.searchIndex >= 0) {
      statusText += ` · 搜索 ${this.searchIndex + 1}/${this.searchHits.length}`
    }
    if (inputView.folded) statusText += ' · 输入已折叠 · Ctrl+T 展开'
    else if (inputRows > 1) statusText += ' · Ctrl+T 折叠输入'
    if (this.pendingMessages.size > 0) statusText += ` · 排队 ${this.pendingMessages.size}`
    statusText += ` · ${this.paintLink === 'ssh' ? 'ssh' : '本机'}${this.paintIntervalMs}ms`
    const idleMs = Date.now() - this.lastActivity
    const livePlan = this.findLivePlanRow()
    const waitingQuestions = this.rows.some(row => row.kind === 'question' && row.status === 'waiting')
    if (waitingQuestions || this.dialog?.kind === 'questions') {
      statusText += this.dialog?.kind === 'questions' && planReviewOf(this.dialog.question)
        ? ' · 计划待审'
        : ' · 等待用户回答'
    } else if (livePlan?.turnLeftOpen === true) {
      statusText += ' · 本轮未收尾'
    } else if (livePlan?.active === true || livePlan?.pending === true) {
      statusText += livePlan.pending ? ' · 计划模式切换中' : ' · 计划模式'
    }
    const liveGoal = this.rows.findLast((row): row is Extract<Row, { kind: 'goal' }> => row.kind === 'goal')
    if (liveGoal !== undefined && (liveGoal.phase === 'active' || liveGoal.phase === 'paused' || liveGoal.phase === 'blocked')) {
      const phase = liveGoal.phase === 'active' ? '目标进行中' : liveGoal.phase === 'paused' ? '目标已暂停' : '目标受阻'
      statusText += ` · ${phase}`
    }
    const compacting = this.rows.some(row => row.kind === 'compaction' && row.status === 'running')
    if (compacting) {
      statusText += ` · ${this.spinnerFrame()} 压缩上下文`
    } else if (this.activeSubagents.size > 0) {
      const spinner = this.spinnerFrame(160)
      statusText += ` · ${spinner} 子代理 ${this.activeSubagents.size}`
    } else if (this.agent.status === 'running' && this.openToolCalls.size > 0) {
      statusText += ` · 工具执行中 ${this.openToolCalls.size}`
    } else if (this.llmRetry !== undefined) {
      statusText += ` · 重试 ${this.llmRetry.retry}/${this.llmRetry.maxRetries}`
    } else if (this.agent.status === 'running' && idleMs > WAIT_INDICATOR_MS) {
      statusText += ` · 等待响应 ${Math.floor(idleMs / 1000)}s`
    }
    const quotaWindow = this.quotaSnapshot === undefined ? undefined : tightestQuotaWindow(this.quotaSnapshot)
    if (quotaWindow !== undefined) {
      statusText += ` · ${this.quotaSnapshot?.plan} 剩余 ${quotaWindow.remainingPercent.toFixed(0)}%`
    }
    const statusLine = this.styleLine('system', fitLine(statusText))

    const paintRows: string[] = [
      ...headerLines,
      ...visible,
      ...planDockLines,
      ...dialogLines,
      inputDivider,
      ...suggestionLines,
      ...inputDisplayLines,
      `${statsLine}\x1b[0m`,
      `${statusLine}\x1b[0m`,
    ]

    // Bottom chrome is force-repainted whenever its state changes while the
    // agent is working; this clears any stale cell left behind by a previous
    // frame even when the row strings happen to be identical.
    const chromeStart = Math.max(0, paintRows.length - inputRows - suggestionLines.length - dialogLines.length - planDockLines.length - 3)
    const chromeKey = [
      this.status,
      this.agent.status,
      this.scrollOffset,
      statsText,
      statusText,
      inputView.text,
      inputView.folded,
      inputRows,
      paintRows.length,
      width,
      height,
      this.pendingMessages.size,
      this.commandSuggestions.length,
      this.suggestionIndex,
      this.activeSubagents.size,
      this.dialog?.kind ?? '',
      planDockLines.join('\n'),
    ].join('\x1f')
    const chromeChanged = chromeKey !== this.lastChromeKey
    const sizeChanged = width !== this.lastPaintWidth || height !== this.lastPaintHeight

    // One stdout write per frame: dirty rows only, so jump-host SSH sees a
    // single packet instead of one write per line. Clip/pad so leftover
    // wide glyphs cannot wrap into the input box.
    const inputTopRow = visible.length + planDockLines.length + dialogLines.length + suggestionLines.length + headerLines.length + 2
    const row = Math.min(height, inputTopRow + cursorRowOffset)
    this.write(composePaintOutput({
      width,
      height,
      paintRows,
      previousRows: this.lastPaintRows,
      sizeChanged,
      chromeChanged,
      chromeStart,
      cursorRow: row,
      cursorColumn: column,
    }))
    this.lastPaintRows = paintRows.length > height ? paintRows.slice(0, height) : paintRows
    this.lastChromeKey = chromeKey
    this.lastPaintWidth = width
    this.lastPaintHeight = height
  }

  private buildSuggestions(): { name: string; description: string; local: boolean }[] {
    const input = this.input
    if (!input.startsWith('/')) return []
    const prefix = input.slice(1).toLowerCase()
    const dsh = (this.ctx.get('commands')?.list(this.agent) ?? []).map(command => ({
      name: command.name,
      description: command.input?.images === true ? `${command.description}（可附图）` : command.description,
      local: false,
    }))
    const all = [
      ...LOCAL_COMMANDS.map(command => ({ name: command.name, description: command.description, local: true })),
      ...dsh,
    ]
    const filtered = prefix === ''
      ? all
      : all.filter(command => command.name.startsWith(prefix) || command.name.includes(prefix))
    return filtered.slice(0, 12)
  }

  private suggestionsVisible(): boolean {
    return this.commandSuggestions.length > 0 && this.dialog === undefined
  }

  private currentProviderId(): string {
    return this.selectionRef?.current?.provider ?? this.agent.options.provider ?? this.providerName
  }

  private currentSelectionLabel(): string {
    const current = this.selectionRef?.current
    const provider = this.currentProviderId()
    const model = current?.model ?? this.agent.options.model ?? 'unknown'
    const effort = current?.reasoningEffort
    const kind = describeProviderRoute(provider).short
    return `${provider}/${model}${effort === undefined ? '' : ` (${effort})`} · ${kind}`
  }

  /** Replace one step's usage sample so a repeated report never double counts. */
  private recordUsage(turn: number, step: number, usage: TokenUsage): void {
    const key = `${turn}:${step}`
    const next: SessionStats['usage'] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    }
    const previous = this.usageByStep.get(key)
    const totals = this.stats.usage
    this.stats.usage = {
      inputTokens: totals.inputTokens - (previous?.inputTokens ?? 0) + next.inputTokens,
      outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
      cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
    }
    this.usageByStep.set(key, next)
  }

  /** The web-aligned session stats strip: counts, timings, cache, tokens. */
  private statsText(): string {
    const stats = this.stats
    const groups: string[] = []
    if (stats.steps > 0) groups.push(`${stats.turns} 轮 · ${stats.steps} 步`)
    const durations: string[] = []
    if (stats.llmMs > 0) durations.push(`模型 ${formatDuration(stats.llmMs)}`)
    if (stats.toolMs > 0) durations.push(`工具 ${formatDuration(stats.toolMs)}`)
    if (durations.length > 0) groups.push(durations.join(' · '))
    const speeds: string[] = []
    if (stats.ttftSteps > 0) speeds.push(`首字 ${formatDuration(stats.ttftMs / stats.ttftSteps)}`)
    if (stats.decodeMs > 0 && stats.decodeTokens > 0) {
      speeds.push(formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)))
    }
    if (speeds.length > 0) groups.push(speeds.join(' · '))
    const usage = stats.usage
    const billedInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    if (billedInput > 0 || usage.outputTokens > 0) {
      if (billedInput > 0) {
        groups.push(`缓存命中 ${Math.round(usage.cacheReadTokens / billedInput * 100)}%`)
      }
      groups.push(`输入 ${formatTokens(billedInput)} · 输出 ${formatTokens(usage.outputTokens)}`)
    }
    return groups.join(' | ')
  }

  /** Refresh the terminal window title (throttled while running). */
  private updateTerminalTitle(): void {
    if (this.exiting) return
    const now = Date.now()
    // Completion wins over a still-running agent status: the turn/end event
    // lands before agent/status flips to idle, and the title must not stay
    // on the running spinner until the next repaint trigger.
    const titleSuffix = this.sessionTitle === '' ? '' : ` · ${this.sessionTitle}`
    if (this.completedAt !== 0 && now - this.completedAt < 5000) {
      this.write(`\x1b]0;dsh ✓ 已完成${titleSuffix}\x07`)
      return
    }
    if (this.agent.status === 'running') {
      if (now - this.lastTitleUpdateAt < 800) return
      this.lastTitleUpdateAt = now
      const spinner = SPINNER[Math.floor(now / 800) % SPINNER.length]
      let detail = '运行中'
      if (this.dialog?.kind === 'questions') {
        detail = planReviewOf(this.dialog.question) ? '计划待审' : '等待用户回答'
      } else if (this.rows.some(row => row.kind === 'compaction' && row.status === 'running')) {
        detail = '压缩上下文'
      } else if (this.activeSubagents.size > 0) {
        detail = `运行中 · 子代理 ${this.activeSubagents.size}`
      } else if (this.openToolCalls.size > 0) {
        detail = `运行中 · 工具 ${this.openToolCalls.size}`
      } else if (this.findLivePlanRow()?.active === true) {
        detail = '计划模式'
      } else {
        const liveGoal = this.rows.findLast((row): row is Extract<Row, { kind: 'goal' }> => row.kind === 'goal')
        if (liveGoal?.phase === 'active') detail = '目标进行中'
        else if (liveGoal?.phase === 'blocked') detail = '目标受阻'
      }
      this.write(`\x1b]0;dsh ${spinner} ${detail}${titleSuffix}\x07`)
      return
    }
    this.write(`\x1b]0;dsh 待命${titleSuffix}\x07`)
  }

  /** Terminal bell on completion (opt out with DSH_TUI_NO_BELL=1). */
  private playCompletionSignal(): void {
    const disabled = process.env.DSH_TUI_NO_BELL === '1' || process.env.DSH_TUI_NO_BELL === 'true'
    if (disabled) return
    process.stdout.write('\x07')
  }

  private render = (): void => {
    if (!this.dirty || this.exiting) return
    if (
      this.agent.status === 'running'
      && Date.now() - this.lastActivity > STALL_WARNING_MS
      && !this.stalledWarningShown
      && this.openToolCalls.size === 0
      && this.activeSubagents.size === 0
    ) {
      this.stalledWarningShown = true
      this.pushRow({ kind: 'error', text: '模型/工具长时间无响应，可按 Esc 或 Ctrl+C 中断当前轮次。' })
      this.markDirty()
      return
    }
    this.dirty = false
    this.paint()
  }

  private styleLine(kind: DisplayKind, text: string): string {
    const safe = sanitizeTerminalText(text)
    if (!this.color) return safe
    const code =
      kind === 'user' ? '36' :
      kind === 'assistant' ? '1;37' :
      kind === 'reasoning' ? '2;3' :
      kind === 'brand' ? '1;38;2;77;107;253' :
      kind === 'tool' || kind === 'tool-result' ? '33' :
      kind === 'diff-add' ? '38;5;22;48;5;194' :
      kind === 'diff-del' ? '38;5;124;48;5;224' :
      kind === 'diff-path' ? '1;36' :
      kind === 'todo-done' ? '2;32' :
      kind === 'todo-active' ? '1;36' :
      kind === 'todo-pending' ? '90' :
      kind === 'plan-dock' ? '38;5;180' :
      kind === 'error' ? '31' :
      '90'
    return `\x1b[${code}m${safe}\x1b[0m`
  }

  // ── event handling ──────────────────────────────────────────────────────

  /**
   * Apply the TUI's subagent model selection to every child-agent request.
   * The parent request is left untouched (its own `/model` waterfall already
   * owns the route); direct children created by tool-subagent inherit the
   * parent provider unless `/submodel` stored an explicit subagent provider.
   */
  readonly handleAgentRequest = async (
    { agent }: { agent: Agent },
    next: () => Promise<LlmCallConfig>,
  ): Promise<LlmCallConfig> => {
    const resolved = await next()
    if (agent === this.agent) return resolved
    const selection = this.subagentSelection.current
    const parentProvider = this.selectionRef?.current?.provider ?? this.agent.options.provider ?? this.providerName
    const provider = selection.provider ?? parentProvider
    const model = subagentModelMatchesProvider(provider, selection.model)
      ? selection.model
      : defaultSubagentModelForProvider(provider)
    return {
      ...resolved,
      provider,
      model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }
  }

  readonly handleSessionEvent = (session: { id: SessionId }, event: SessionEvent): void => {
    if (session.id !== this.agent.id) {
      if (this.subagentSessions.has(session.id)) this.handleSubagentSessionEvent(session.id, event)
      return
    }
    this.lastActivity = Date.now()
    switch (event.type) {
      case 'user/message': {
        const text = event.data.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
        if (text !== '') {
          const sourceKind = event.data.source.kind
          if (sourceKind === 'user') {
            this.pushRow({ kind: 'user', text: `❯ ${text}` })
          } else if (sourceKind === 'plugin' && event.data.source.form === 'snapshot') {
            this.pushRow({ kind: 'system', text: text })
          } else {
            this.pushRow({ kind: 'system', text: `(context) ${text}` })
          }
          this.streaming = undefined
          this.streamingReasoning = undefined
          this.markDirty()
        }
        break
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        const open = this.openStepStats
        if (open !== null && open !== undefined
          && open.turn === event.data.turn && open.step === event.data.step) {
          if (open.firstTokenTime === null
            && chunk.type === 'text-delta'
            && chunk.text !== '') {
            this.openStepStats = { ...open, firstTokenTime: event.time }
          }
        }
        if (chunk.type === 'usage' && chunk.usage !== undefined) {
          this.recordUsage(event.data.turn, event.data.step, chunk.usage)
        }
        if (chunk.type === 'text-delta') {
          this.streaming ??= { text: '', reasoning: '' }
          this.streaming.text += chunk.text
          this.markDirty()
        } else if (chunk.type === 'reasoning-delta') {
          this.streaming ??= { text: '', reasoning: '' }
          if (this.streaming.reasoning === '' && chunk.text !== '') {
            this.thinkingStartedAt = Date.now()
            this.streamingReasoning = { kind: 'streaming-reasoning', expanded: false }
          }
          this.streaming.reasoning += chunk.text
          this.markDirty()
        }
        break
      }
      case 'assistant/message': {
        const text = event.data.message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
        const reasoning = event.data.message.content
          .filter(block => block.type === 'reasoning')
          .map(block => block.text)
          .join('')
        const open = this.openStepStats
        if (open !== undefined && open.turn === event.data.turn && open.step === event.data.step) {
          this.stats.llmMs += Math.max(0, event.time - open.startTime)
          if (open.firstTokenTime !== null) {
            this.stats.ttftMs += Math.max(0, open.firstTokenTime - open.startTime)
            this.stats.ttftSteps += 1
            const outputTokens = event.data.usage?.outputTokens
            if (typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens >= 0) {
              this.stats.decodeMs += Math.max(0, event.time - open.firstTokenTime)
              this.stats.decodeTokens += outputTokens
            }
          }
          this.openStepStats = undefined
        }
        if (event.data.usage !== undefined) {
          this.recordUsage(event.data.turn, event.data.step, event.data.usage)
        }
        const reasoningExpanded = this.streamingReasoning?.expanded ?? false
        const interrupted = event.data.interrupted === true
        this.streaming = undefined
        this.streamingReasoning = undefined
        this.thinkingStartedAt = undefined
        const interruptedMark = interrupted ? ' ⚠ 已中断' : ''
        if (reasoning !== '') {
          this.pushRow({ kind: 'reasoning', text: `${reasoning}${interruptedMark}`, expanded: reasoningExpanded })
        }
        if (text !== '') {
          this.pushRow({ kind: 'assistant', text: `${text}${interruptedMark}` })
        } else if (interrupted && reasoning === '') {
          this.pushRow({ kind: 'system', text: '本轮输出已中断，没有可见内容。' })
        }
        this.markDirty()
        break
      }
      case 'tool/call': {
        this.openToolCalls.set(String(event.data.callId), event.data.name)
        this.pendingToolTimes.set(String(event.data.callId), event.time)
        const present = presentToolCall(event.data.name, event.data.arguments)
        const row: Row = {
          kind: 'tool',
          callId: event.data.callId,
          name: event.data.name,
          args: event.data.arguments,
          status: 'running',
          output: '',
          title: present.title,
          summary: present.summary,
          ...present.command === undefined ? {} : { command: present.command },
          ...present.cwd === undefined ? {} : { cwd: present.cwd },
          ...present.diff === undefined ? {} : { diff: present.diff },
          expanded: DIFF_TOOL_NAMES.has(event.data.name) && !SUBAGENT_TOOL_NAMES.has(event.data.name),
        }
        this.pushRow(row)
        if (event.data.name === 'exit_plan_mode') {
          const markdown = planMarkdownFromArgs(event.data.arguments)
          if (markdown !== undefined) this.upsertPlanRow({ planMarkdown: markdown, expanded: false })
        }
        this.streaming = undefined
        this.markDirty()
        break
      }
      case 'tool/result': {
        this.openToolCalls.delete(String(event.data.message.source.callId))
        const dispatchedAt = this.pendingToolTimes.get(String(event.data.message.source.callId))
        if (dispatchedAt !== undefined) {
          this.stats.toolMs += Math.max(0, event.time - dispatchedAt)
          this.pendingToolTimes.delete(String(event.data.message.source.callId))
        }
        const row = this.rows.findLast((candidate): candidate is Extract<Row, { kind: 'tool' }> =>
          candidate.kind === 'tool' && candidate.callId === event.data.message.source.callId,
        )
        const output = collectText(event.data.message.content)
        if (row !== undefined) {
          const metaDiffs = diffMetaDiffs(event.data.meta)
          if (metaDiffs !== null) {
            row.diff = metaDiffs
            if (DIFF_TOOL_NAMES.has(row.name)) row.expanded = true
          }
          const isShell = SHELL_TOOL_NAMES.has(row.name)
          if (isShell) {
            const parsed = parseExitStatus(output)
            row.output = parsed.body
            if (parsed.signal !== undefined) row.signal = parsed.signal
            else row.exitCode = parsed.exitCode
          } else {
            row.output = output
          }
          const failed = event.data.error !== undefined
            || event.data.message.content[0]?.isError === true
            || (isShell && ((row.exitCode !== undefined && row.exitCode !== 0) || row.signal !== undefined))
          row.status = failed ? 'error' : 'ok'
        } else {
          const present = presentToolCall(event.data.message.source.callId, '')
          this.pushRow({
            kind: 'tool',
            callId: event.data.message.source.callId,
            name: event.data.message.source.callId,
            args: '',
            status: event.data.error === undefined ? 'ok' : 'error',
            output,
            title: present.title,
            summary: present.summary,
            expanded: false,
          })
        }
        this.markDirty()
        break
      }
      case 'step/start': {
        this.openStepStats = {
          turn: event.data.turn,
          step: event.data.step,
          startTime: event.time,
          firstTokenTime: null,
        }
        this.markDirty()
        break
      }
      case 'step/end': {
        if (this.lastStatsTurn !== event.data.turn) {
          this.stats.turns += 1
          this.lastStatsTurn = event.data.turn
        }
        this.stats.steps += 1
        this.openStepStats = undefined
        // Usage accounting is complete for this step; the map only exists to
        // deduplicate repeated usage reports during the step.
        this.usageByStep.delete(`${event.data.turn}:${event.data.step}`)
        this.markDirty()
        break
      }
      case 'turn/start':
        this.stalledWarningShown = false
        this.llmRetry = undefined
        this.status = `turn ${event.data.turn} running`
        this.markDirty()
        break
      case 'turn/end': {
        this.quotaTurnsSinceRefresh += 1
        const every = quotaRefreshEveryTurns(this.quotaSnapshot === undefined
          ? undefined
          : tightestQuotaWindow(this.quotaSnapshot))
        if (this.quotaTurnsSinceRefresh >= every) {
          this.quotaTurnsSinceRefresh = 0
          void this.refreshQuota({ reason: 'turn', announce: false }).catch(() => {})
        }
        const reason = event.data.reason
        this.openToolCalls.clear()
        this.pendingToolTimes.clear()
        this.stalledWarningShown = false
        this.pendingMessages.clear()
        // Aborted/errored turns may close without an assembled
        // assistant/message; never leave a half-streamed thinking block behind.
        this.streaming = undefined
        this.streamingReasoning = undefined
        this.thinkingStartedAt = undefined
        if (reason.kind === 'completed' && !this.replaying && !this.completionSignaled) {
          this.completionSignaled = true
          this.completedAt = Date.now()
          this.updateTerminalTitle()
          this.playCompletionSignal()
        }
        this.status = reason.kind === 'completed'
          ? 'idle'
          : reason.kind === 'error'
            ? `error: ${reason.error.message}`
            : `idle (${reason.kind})`
        if (reason.kind === 'error') {
          this.pushRow({ kind: 'error', text: `Turn ${event.data.turn} failed: ${reason.error.message}` })
        }
        const livePlan = this.findLivePlanRow()
        if (livePlan !== undefined && reason.kind === 'completed') {
          applyTurnEndToPlan(livePlan)
          if (livePlan.turnLeftOpen === true) {
            this.pushRow({
              kind: 'system',
              text: planDockNote(livePlan),
            })
            this.queuePlanCloseNudge(livePlan)
          }
        }
        this.markDirty()
        break
      }
      case 'todo/write': {
        this.upsertPlanRow({ todos: parsePlanTodos(event.data.todos) })
        this.markDirty()
        break
      }
      default:
        this.handleExtensionEvent(event)
        break
    }
  }

  private readonly handleStatus = ({ agent, status }: { agent: Agent; status: string }): void => {
    if (agent !== this.agent) return
    this.lastActivity = Date.now()
    if (status === 'running') {
      this.completionSignaled = false
      this.completedAt = 0
    } else if (!this.completionSignaled && this.status === 'running') {
      this.completionSignaled = true
      this.completedAt = Date.now()
      this.updateTerminalTitle()
      this.playCompletionSignal()
    }
    this.status = status === 'running' ? 'running' : 'idle'
    this.markDirty()
  }

  private readonly handleError = ({ agent, error }: { agent: Agent; error: unknown }): void => {
    if (agent !== this.agent) return
    this.lastActivity = Date.now()
    this.pushRow({ kind: 'error', text: errorChain(error) })
    this.markDirty()
  }

  private readonly handleInboxClaimed = ({ agent, message }: { agent: Agent; message: { id: string } }): void => {
    if (agent !== this.agent) return
    if (this.pendingMessages.delete(message.id)) this.markDirty()
  }

  private readonly handleInboxDiscarded = ({ agent, message }: { agent: Agent; message: { id: string } }): void => {
    if (agent !== this.agent) return
    if (this.pendingMessages.delete(message.id)) this.markDirty()
  }

  private readonly handleDisposed = ({ agent }: { agent: Agent }): void => {
    if (agent !== this.agent) return
    this.agentGone = true
    this.pushRow({ kind: 'error', text: 'Agent was disposed; press Ctrl+C to exit.' })
    this.status = 'disposed'
    this.markDirty()
  }

  /** Plan-mode / command / team events that plugins merge into SessionEventMap. */
  private handleExtensionEvent(event: SessionEvent): void {
    const type = String(event.type)
    const data = (event as SessionEvent & { data?: unknown }).data as { active?: unknown; name?: unknown; args?: unknown } | undefined
    if (type === 'plan/mode') {
      const active = data?.active === true
      this.upsertPlanRow({ active, pending: false })
      this.pushRow({
        kind: 'system',
        text: active
          ? '已进入计划模式：先规划、等确认后再改代码。可用 /plan off 退出。'
          : '已退出计划模式，可以继续执行改动。',
      })
      this.markDirty()
      return
    }
    if (type === 'command/run') {
      this.handleCommandRun(data)
      return
    }
    if (type === 'command/done') {
      this.handleCommandDone(data)
      return
    }
    if (type === 'session/title') {
      const title = typeof (data as { title?: unknown } | undefined)?.title === 'string'
        ? (data as { title: string }).title.trim()
        : ''
      if (title !== '') {
        this.sessionTitle = title
        this.updateTerminalTitle()
        this.markDirty()
      }
      return
    }
    if (type === 'session/title-llm-request') {
      this.pushRow({ kind: 'system', text: '正在用模型生成会话标题…' })
      this.markDirty()
      return
    }
    if (type === 'llm/retry') {
      const retry = typeof (data as { retry?: unknown } | undefined)?.retry === 'number' ? (data as { retry: number }).retry : 1
      const maxRetries = typeof (data as { maxRetries?: unknown } | undefined)?.maxRetries === 'number' ? (data as { maxRetries: number }).maxRetries : retry
      const delayMs = typeof (data as { delayMs?: unknown } | undefined)?.delayMs === 'number' ? (data as { delayMs: number }).delayMs : 0
      const failure = (data as { failure?: { message?: unknown } } | undefined)?.failure
      const message = typeof failure?.message === 'string' ? failure.message : '模型请求失败，正在重试'
      this.llmRetry = { retry, maxRetries, delayMs, message }
      this.pushRow({
        kind: 'system',
        text: `模型请求失败，${Math.round(delayMs)}ms 后重试 ${retry}/${maxRetries}：${message}`,
      })
      this.markDirty()
      return
    }
    if (type === 'llm/retry-started') {
      if (this.llmRetry !== undefined) {
        this.pushRow({ kind: 'system', text: `开始第 ${this.llmRetry.retry} 次重试。` })
      }
      this.markDirty()
      return
    }
    if (type === 'goal/change') {
      this.handleGoalChange(data)
      return
    }
    if (type.startsWith('compaction/')) {
      this.handleCompactionEvent(type, event)
      return
    }
    if (type.startsWith('team/')) {
      this.pushRow({ kind: 'system', text: `[团队] ${type}` })
      this.markDirty()
    }
  }

  private findCompactionRow(id?: string): Extract<Row, { kind: 'compaction' }> | undefined {
    if (id !== undefined && id !== '') {
      const named = this.rows.findLast((row): row is Extract<Row, { kind: 'compaction' }> =>
        row.kind === 'compaction' && row.compactionId === id)
      if (named !== undefined) return named
    }
    return this.rows.findLast((row): row is Extract<Row, { kind: 'compaction' }> =>
      row.kind === 'compaction' && row.status === 'running')
  }

  private handleCompactionEvent(type: string, event: SessionEvent): void {
    const payload = (event as SessionEvent & { data?: unknown }).data
    const data = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const compactionId = typeof data.compactionId === 'string' ? data.compactionId : ''
    if (type === 'compaction/start') {
      this.pushRow({
        kind: 'compaction',
        compactionId,
        status: 'running',
        startedAt: event.time || Date.now(),
        pruneCount: 0,
        prunedTokens: 0,
        expanded: false,
      })
      this.status = '压缩上下文…'
      this.markDirty()
      return
    }
    const row = this.findCompactionRow(compactionId)
    if (type === 'compaction/prune') {
      const tokens = typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0
      if (row !== undefined) {
        row.pruneCount += 1
        row.prunedTokens += Math.max(0, tokens)
      }
      this.markDirty()
      return
    }
    if (type === 'compaction/summary') {
      const blocks = Array.isArray(data.summary) ? data.summary : []
      const text = blocks.map(block => {
        if (typeof block === 'string') return block
        if (block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
          return (block as { text: string }).text
        }
        return ''
      }).filter(part => part !== '').join('\n')
      if (row !== undefined && text !== '') row.summary = text.slice(0, 4000)
      this.markDirty()
      return
    }
    if (type === 'compaction/end') {
      const error = typeof data.error === 'string' && data.error !== '' ? data.error : undefined
      if (row !== undefined) {
        row.status = error === undefined ? 'ok' : 'error'
        row.endedAt = event.time || Date.now()
        if (error !== undefined) row.error = error
      } else {
        this.pushRow({
          kind: 'system',
          text: error === undefined ? '上下文压缩已完成。' : `上下文压缩失败：${error}`,
        })
      }
      if (this.status.startsWith('压缩')) this.status = this.agent.status === 'running' ? 'running' : 'idle'
      this.markDirty()
    }
  }

  private handleCommandRun(data: { name?: unknown; args?: unknown } | undefined): void {
    const name = String(data?.name ?? '').trim()
    const args = String(data?.args ?? '').trim()
    if (name === 'plan') {
      const wantsActive = args !== 'off'
      const current = this.findLivePlanRow()
      this.upsertPlanRow({
        pending: current !== undefined && current.active !== wantsActive,
        active: current?.active ?? false,
      })
      this.pushRow({
        kind: 'system',
        text: wantsActive ? '已请求进入计划模式。' : '已请求退出计划模式。',
      })
      this.markDirty()
      return
    }
    if (name === 'compact') {
      this.status = '压缩上下文…'
      this.markDirty()
      return
    }
    if (name === '') return
    this.pushRow({
      kind: 'system',
      text: args === '' ? `/${name}` : `/${name} ${args}`,
    })
    this.markDirty()
  }

  private handleCommandDone(data: unknown): void {
    const payload = data !== null && typeof data === 'object' ? data as Record<string, unknown> : {}
    const kind = typeof payload.kind === 'string' ? payload.kind : ''
    const text = typeof payload.text === 'string' ? payload.text.trim() : ''
    if (kind === 'error') {
      this.pushRow({ kind: 'error', text: text === '' ? '命令失败。' : text })
      if (this.status.startsWith('压缩')) this.status = this.agent.status === 'running' ? 'running' : 'idle'
      this.markDirty()
      return
    }
    if (text !== '') this.pushRow({ kind: 'system', text })
    this.markDirty()
  }

  private handleGoalChange(data: unknown): void {
    const payload = data !== null && typeof data === 'object' ? data as Record<string, unknown> : {}
    const existing = this.rows.findLast((row): row is Extract<Row, { kind: 'goal' }> => row.kind === 'goal')
    if (payload.operation === 'clear') {
      if (existing !== undefined) {
        existing.phase = 'cleared'
        existing.blockedReason = undefined
      } else {
        this.pushRow({ kind: 'goal', objective: '（已清除）', phase: 'cleared', expanded: false })
      }
      this.pushRow({ kind: 'system', text: '当前目标已清除。' })
      this.markDirty()
      return
    }
    const goal = payload.goal !== null && typeof payload.goal === 'object' ? payload.goal as Record<string, unknown> : {}
    const objective = typeof goal.objective === 'string' && goal.objective.trim() !== '' ? goal.objective.trim() : '（未命名目标）'
    const phase = goal.phase === 'paused' || goal.phase === 'blocked' || goal.phase === 'complete' ? goal.phase : 'active'
    const blocked = goal.blockedReason !== null && typeof goal.blockedReason === 'object'
      ? (goal.blockedReason as { message?: unknown }).message
      : undefined
    const blockedReason = typeof blocked === 'string' ? blocked : undefined
    if (existing !== undefined) {
      existing.objective = objective
      existing.phase = phase
      existing.blockedReason = blockedReason
    } else {
      this.pushRow({
        kind: 'goal',
        objective,
        phase,
        ...(blockedReason === undefined ? {} : { blockedReason }),
        expanded: false,
      })
    }
    const notice = phase === 'active' ? '已设置目标'
      : phase === 'paused' ? '目标已暂停'
      : phase === 'blocked' ? '目标受阻'
      : '目标已完成'
    this.pushRow({ kind: 'system', text: `${notice}：${objective}` })
    this.markDirty()
  }

  private handleSubagentExtensionEvent(row: Extract<Row, { kind: 'subagent' }>, event: SessionEvent): void {
    const type = String(event.type)
    const data = (event as SessionEvent & { data?: unknown }).data as { active?: unknown } | undefined
    if (type === 'plan/mode') {
      appendSubagentLog(row, {
        kind: 'system',
        text: data?.active === true ? '进入计划模式' : '退出计划模式',
      })
      return
    }
    if (type.startsWith('team/')) {
      appendSubagentLog(row, { kind: 'team', text: `[团队] ${type}` })
    }
  }

  /** Fold a live subagent's own session events into that child's card. */
  readonly handleSubagentSessionEvent = (sessionId: SessionId, event: SessionEvent): void => {
    const row = this.findSubagentRow(String(sessionId))
    if (row === undefined) return
    switch (event.type) {
      case 'user/message': {
        const text = collectText(event.data.content)
        if (text !== '') appendSubagentLog(row, { kind: 'user', text: `❯ ${truncate(text, 4)}` })
        break
      }
      case 'assistant/chunk':
        break
      case 'assistant/message': {
        const text = collectText(event.data.message.content)
        if (text !== '') appendSubagentLog(row, { kind: 'assistant', text: truncate(text, 8) })
        break
      }
      case 'tool/call': {
        const present = presentToolCall(event.data.name, event.data.arguments)
        appendSubagentLog(row, { kind: 'tool', text: `▶ ${present.title} ${present.summary}` })
        break
      }
      case 'tool/result': {
        const output = truncate(collectText(event.data.message.content), 3)
        const ok = event.data.error === undefined && event.data.message.content[0]?.isError !== true
        appendSubagentLog(row, {
          kind: 'result',
          text: `${ok ? '✓' : '✗'} ${event.data.message.source.callId}${output === '' ? '' : ` · ${output}`}`,
        })
        break
      }
      case 'turn/end':
        appendSubagentLog(row, { kind: 'turn', text: `轮次结束（${event.data.reason.kind}）` })
        break
      case 'approval/asked':
        appendSubagentLog(row, { kind: 'approval', text: `等待审批：${event.data.toolName}` })
        break
      default:
        this.handleSubagentExtensionEvent(row, event)
        break
    }
    this.lastActivity = Date.now()
    this.markDirty()
  }

  readonly handleSubagentStart = (info: SubagentRunInfo): void => {
    const sessionId = String(info.id)
    this.activeSubagents.set(String(info.runId), {
      id: sessionId,
      provider: info.provider,
      startedAt: Date.now(),
    })
    this.subagentSessions.add(sessionId)
    this.lastActivity = Date.now()
    const existing = this.findSubagentRow(sessionId)
    if (existing !== undefined) {
      existing.runId = String(info.runId)
      existing.provider = info.provider
      existing.local = info.local
      existing.status = 'running'
      existing.startedAt = Date.now()
      existing.endedAt = undefined
      existing.stopReason = undefined
      existing.lastActivity = '已启动'
      existing.expanded = false
      appendSubagentLog(existing, { kind: 'system', text: `已启动（${info.provider}${info.local ? '' : '，外部进程'}）` })
    } else {
      this.pushRow({
        kind: 'subagent',
        sessionId,
        runId: String(info.runId),
        provider: info.provider,
        local: info.local,
        label: `子代理 ${info.provider}`,
        status: 'running',
        startedAt: Date.now(),
        lastActivity: '已启动',
        logs: [{ kind: 'system', text: `已启动（${info.provider}${info.local ? '' : '，外部进程'}）` }],
        expanded: false,
      })
    }
    this.markDirty()
  }

  readonly handleSubagentEnd = (info: SubagentRunEndInfo): void => {
    this.activeSubagents.delete(String(info.runId))
    this.subagentSessions.delete(String(info.id))
    this.lastActivity = Date.now()
    const output = info.lastAssistantMessage === undefined
      ? ''
      : truncate(collectText(info.lastAssistantMessage), 6)
    const row = this.findSubagentRow(String(info.id)) ?? this.rows.findLast((candidate): candidate is Extract<Row, { kind: 'subagent' }> =>
      candidate.kind === 'subagent' && candidate.runId === String(info.runId))
    const failed = info.stopReason !== 'completed'
    if (row !== undefined) {
      row.status = info.stopReason === 'aborted' ? 'aborted' : failed ? 'error' : 'ok'
      row.endedAt = Date.now()
      row.stopReason = info.stopReason
      appendSubagentLog(row, {
        kind: failed ? 'result' : 'assistant',
        text: `结束（${info.stopReason}）${output === '' ? '' : ` · ${output}`}`,
      })
    } else {
      this.pushRow({
        kind: 'subagent',
        sessionId: String(info.id),
        runId: String(info.runId),
        provider: info.provider,
        local: info.local,
        label: `子代理 ${info.provider}`,
        status: info.stopReason === 'aborted' ? 'aborted' : failed ? 'error' : 'ok',
        startedAt: Date.now(),
        endedAt: Date.now(),
        stopReason: info.stopReason,
        lastActivity: `结束（${info.stopReason}）`,
        logs: [{ kind: 'system', text: `结束（${info.stopReason}）${output === '' ? '' : ` · ${output}`}` }],
        expanded: false,
      })
    }
    this.markDirty()
  }

  // ── approval and questions ──────────────────────────────────────────────

  private readonly handleApproval = async (
    request: ApprovalRequest,
    _next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> => {
    const agentLabel = request.agent.id === this.agent.id
      ? '当前会话'
      : `子代理 ${request.agent.id}`
    return new Promise<ApprovalOutcome>((resolve) => {
      if (request.signal?.aborted === true) {
        resolve('cancelled')
        return
      }
      let dialog: ConfirmDialog | undefined
      const onAbort = (): void => {
        request.signal?.removeEventListener('abort', onAbort)
        if (dialog !== undefined) this.abortConfirm(dialog)
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      dialog = this.openConfirm(
        `允许工具 "${request.toolName}"？（${agentLabel}）${request.reason === undefined ? '' : `\n${request.reason}`}`,
        'y = 允许一次, n = 拒绝, Esc = 取消',
        (answer) => {
          request.signal?.removeEventListener('abort', onAbort)
          resolve(answer === 'y' ? 'allowed-once' : answer === 'n' ? 'rejected' : 'cancelled')
        },
      )
    })
  }

  readonly handleUserQuestions = async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
    const answers: AskUserQuestionAnswer['answers'] = []
    const agentLabel = request.agent === undefined || request.agent.id === this.agent.id
      ? undefined
      : `子代理 ${request.agent.id}`
    const cards: Extract<Row, { kind: 'question' }>[] = []
    for (const question of request.questions) {
      const card: Extract<Row, { kind: 'question' }> = {
        kind: 'question',
        questionId: question.id,
        title: question.question,
        ...(question.header === undefined ? {} : { header: question.header }),
        ...(question.detail === undefined ? {} : { detail: question.detail }),
        intent: planReviewOf(question) ? 'plan-review' : 'ask',
        status: 'waiting',
        summary: question.question,
        expanded: false,
      }
      cards.push(card)
      this.pushRow(card)
    }
    this.markDirty()
    const settleCards = (status: 'answered' | 'cancelled', summary: string): void => {
      for (const card of cards) {
        if (card.status === 'waiting') {
          card.status = status
          card.summary = summary
        }
      }
    }
    try {
      for (const [index, question] of request.questions.entries()) {
        const answer = await new Promise<DialogAnswer>((resolve, reject) => {
          const fail = (error: unknown): void => {
            request.signal?.removeEventListener('abort', onAbort)
            reject(error)
          }
          const onAbort = (): void => {
            request.signal?.removeEventListener('abort', onAbort)
            if (dialog !== undefined) {
              dialog.reject(new UserQuestionError('ask_user_question was interrupted before the user answered', 'ASK_ABORTED'))
            } else {
              reject(new UserQuestionError('ask_user_question was interrupted before the user answered', 'ASK_ABORTED'))
            }
          }
          let dialog: QuestionDialog | undefined
          request.signal?.addEventListener('abort', onAbort, { once: true })
          if (request.signal?.aborted === true) {
            onAbort()
            return
          }
          const labeled: AskUserQuestionItem = agentLabel === undefined
            ? question
            : { ...question, question: `[${agentLabel}] ${question.question}` }
          dialog = this.openQuestion(labeled, index, request.questions.length, (selection) => {
            request.signal?.removeEventListener('abort', onAbort)
            resolve(selection)
          }, fail)
        })
        answers.push({ id: question.id, selected: answer.selected, custom: answer.custom })
        const card = cards[index]
        if (card !== undefined) {
          card.status = 'answered'
          card.summary = answer.custom !== undefined && answer.custom !== ''
            ? answer.custom
            : answer.selected.join(', ') || '已回答'
        }
      }
      settleCards('answered', '已回答')
      return { answers }
    } catch (error) {
      settleCards('cancelled', error instanceof UserQuestionError ? error.message : '已取消')
      throw error
    }
  }

  /** Queue one dialog behind an already-open one instead of overwriting it. */
  private openDialog(dialog: Dialog): void {
    if (this.dialog === undefined) {
      this.dialog = dialog
    } else {
      this.dialogQueue.push(dialog)
    }
    this.markDirty()
  }

  private showNextDialog(): void {
    if (this.dialog !== undefined) return
    const next = this.dialogQueue.shift()
    if (next !== undefined) {
      this.dialog = next
      this.markDirty()
    }
  }

  private removeQueuedDialog(dialog: Dialog): void {
    const index = this.dialogQueue.indexOf(dialog)
    if (index !== -1) this.dialogQueue.splice(index, 1)
  }

  private settleQuestion(dialog: QuestionDialog, finish: () => void): void {
    if (this.dialog === dialog) {
      this.dialog = undefined
    } else {
      this.removeQueuedDialog(dialog)
    }
    finish()
    this.showNextDialog()
    this.markDirty()
  }

  private openConfirm(prompt: string, hint: string, resolve: (value: 'y' | 'n' | 'cancel') => void): ConfirmDialog {
    const dialog: ConfirmDialog = { kind: 'confirm', prompt, hint, resolve }
    this.openDialog(dialog)
    return dialog
  }

  private closeConfirm(value: 'y' | 'n' | 'cancel'): void {
    const dialog = this.dialog
    if (dialog === undefined || dialog.kind !== 'confirm') return
    this.dialog = undefined
    dialog.resolve(value)
    this.showNextDialog()
    this.markDirty()
  }

  /** Resolve one queued or active confirm from its abort signal. */
  private abortConfirm(dialog: ConfirmDialog): void {
    if (this.dialog === dialog) {
      this.dialog = undefined
      dialog.resolve('cancel')
      this.showNextDialog()
      this.markDirty()
      return
    }
    this.removeQueuedDialog(dialog)
    dialog.resolve('cancel')
  }

  private openQuestion(
    question: AskUserQuestionItem,
    index: number,
    total: number,
    resolve: (answer: DialogAnswer) => void,
    reject: (error: unknown) => void,
    preselected?: number,
  ): QuestionDialog {
    const dialog: QuestionDialog = {
      kind: 'questions',
      question,
      index,
      total,
      selected: new Set(preselected !== undefined && preselected >= 0 ? [preselected] : []),
      resolve: (selection) => {
        this.settleQuestion(dialog, () => resolve(selection))
      },
      reject: (error) => {
        this.settleQuestion(dialog, () => reject(error))
      },
    }
    this.openDialog(dialog)
    return dialog
  }

  /** Open one question dialog and await its answer (cancellation rejects). */
  private askQuestion(question: AskUserQuestionItem, index = 0, total = 1, preselected?: number): Promise<DialogAnswer> {
    return new Promise<DialogAnswer>((resolve, reject) => {
      this.openQuestion(question, index, total, resolve, reject, preselected)
    })
  }

  /** The stored llm-pi-ai profile for one provider route, when settings provide one. */
  private piAiProviderProfile(provider: string): LlmPiAiProviderProfile | undefined {
    if (provider === 'deepseek-official') return undefined
    const section = this.ctx.get('settings')?.get(settingsNamespace('llm-pi-ai')) as LlmPiAiSection | null | undefined
    return section?.providers?.[provider]
  }

  /** Default listing endpoint for a built-in OpenCode route with no stored base URL. */
  private openCodeListingBaseURL(provider: string): string | undefined {
    if (provider === 'opencode-go') return PROVIDER_TEMPLATES['opencode-go'].defaultBaseUrl
    if (provider === 'opencode') return OPENCODE_ZEN_BASE_URL
    return undefined
  }

  /**
   * Fetch the live model list for an OpenCode or third-party provider from its
   * OpenAI-compatible listing endpoint. The provider route is deliberately not
   * passed to discovery: pi-ai would answer a catalog route from its installed
   * registry, while the TUI wants the endpoint's current list.
   */
  private async discoverEndpointModels(provider: string): Promise<{ id: string; label: string }[]> {
    const llmPiAi = this.ctx.get('settings')?.get(settingsNamespace('llm-pi-ai'))
    const profile = this.piAiProviderProfile(provider)
    const source = openCodeSourceFor(provider, llmPiAi)
    const baseURL = typeof profile?.baseURL === 'string' && profile.baseURL.trim() !== ''
      ? profile.baseURL.trim()
      : this.openCodeListingBaseURL(provider)
    if (baseURL === undefined) return []
    const api = typeof profile?.api === 'string' && profile.api.trim() !== '' ? profile.api.trim() : undefined
    const apiKeyEnv = typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv.trim() !== ''
      ? profile.apiKeyEnv.trim()
      : source?.apiKeyEnv
    const apiKey = apiKeyEnv === undefined ? undefined : await this.resolveCredential(apiKeyEnv)
    const llm = this.ctx.get('llm')
    if (llm === undefined) return []
    const discovered = await llm.discoverModels(settingsNamespace('llm-pi-ai'), {
      baseURL,
      ...(api === undefined ? {} : { api }),
      ...(apiKey === undefined ? {} : { apiKey }),
      signal: AbortSignal.timeout(15_000),
    })
    return discovered.map(model => ({ id: model.id, label: model.name || model.id }))
  }

  /** Add one endpoint-listed model to the stored provider profile when needed. */
  private async ensureProviderModelConfigured(provider: string, modelId: string): Promise<boolean> {
    const settings = this.ctx.get('settings')
    const profile = this.piAiProviderProfile(provider)
    if (settings === undefined || profile === undefined) return true
    // A profile may legitimately have no models yet (e.g. onboarding saved an
    // empty list); the picked endpoint model must still be persisted so the
    // harness can serve it.
    const models = Array.isArray(profile.models) ? profile.models : []
    const ids = new Set<string>()
    for (const raw of models) {
      const id = typeof raw === 'string'
        ? raw
        : typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string'
          ? (raw as { id: string }).id
          : undefined
      if (typeof id === 'string' && id.length > 0) ids.add(id)
    }
    if (ids.has(modelId)) return true
    const modelEntry: Record<string, unknown> = { id: modelId }
    const reasoningEfforts = reasoningEffortsForDefault(profile.reasoning)
    if (reasoningEfforts !== undefined) modelEntry.reasoningEfforts = reasoningEfforts
    try {
      await settings.mutate(settingsNamespace('llm-pi-ai'), [
        { op: 'set', path: ['providers', provider, 'models'], value: [...models, modelEntry] },
      ])
      this.pushRow({ kind: 'system', text: `模型 ${modelId} 已加入提供商 ${provider} 的配置。` })
      this.markDirty()
      return true
    } catch (error) {
      this.pushRow({ kind: 'error', text: `无法把模型 ${modelId} 写入提供商配置：${errorChain(error)}` })
      this.markDirty()
      return false
    }
  }

  /** How many endpoint-listed models fit on one picker page alongside navigation. */
  private readonly MODEL_PAGE_SIZE = 7
  private readonly MODEL_PAGE_PREV = '« 上一页'
  private readonly MODEL_PAGE_NEXT = '» 下一页'

  /**
   * One pick across a possibly long model list, paging through the digit
   * dialog so an endpoint with dozens of models stays selectable.
   */
  private async pickModelOption(
    modelOptions: readonly { id: string; label: string }[],
    provider: string,
    sourceLabel: string,
    currentModel: string | undefined,
  ): Promise<{ id: string; label: string } | undefined> {
    const seen = new Set<string>()
    const unique = modelOptions.filter(option => {
      if (seen.has(option.id)) return false
      seen.add(option.id)
      return true
    })
    if (unique.length === 0) return undefined
    let offset = 0
    for (;;) {
      const page = unique.slice(offset, offset + this.MODEL_PAGE_SIZE)
      const hasPrev = offset > 0
      const hasNext = offset + this.MODEL_PAGE_SIZE < unique.length
      const pageCount = Math.max(1, Math.ceil(unique.length / this.MODEL_PAGE_SIZE))
      const currentPage = Math.floor(offset / this.MODEL_PAGE_SIZE) + 1
      const options = page.map(option => ({
        label: option.label,
        description: option.id === currentModel ? '当前' : undefined,
      }))
      if (hasPrev) options.push({ label: this.MODEL_PAGE_PREV, description: undefined })
      if (hasNext) options.push({ label: this.MODEL_PAGE_NEXT, description: undefined })
      const currentIndex = page.findIndex(option => option.id === currentModel && option.id !== '__switch_provider__')
      const answer = await this.askQuestion({
        id: 'model-pick',
        question: `选择模型（提供商 ${provider} · ${sourceLabel}${hasPrev || hasNext ? `，第 ${currentPage}/${pageCount} 页` : ''}）`,
        options,
      }, 0, 1, currentIndex >= 0 ? currentIndex : undefined)
      const picked = options.find(option => option.label === answer.selected[0])
      if (picked === undefined) return undefined
      if (picked.label === this.MODEL_PAGE_NEXT) {
        offset += this.MODEL_PAGE_SIZE
        continue
      }
      if (picked.label === this.MODEL_PAGE_PREV) {
        offset = Math.max(0, offset - this.MODEL_PAGE_SIZE)
        continue
      }
      return page.find(option => option.label === picked.label)
    }
  }

  /** Live adapter routes the TUI can switch to, plus the current selection. */
  private listSelectableProviders(): { id: string; label: string }[] {
    const llm = this.ctx.get('llm')
    const current = this.currentProviderId()
    const seen = new Set<string>()
    const out: { id: string; label: string }[] = []
    const add = (id: string, name?: string): void => {
      if (id === '' || seen.has(id)) return
      seen.add(id)
      const kind = describeProviderRoute(id)
      const display = name !== undefined && name !== '' && name !== id ? name : kind.short
      out.push({ id, label: `${display} · ${id}` })
    }
    add(current)
    for (const info of llm?.listProviders() ?? []) add(info.id, info.name)
    add('xai', 'SuperGrok')
    add('deepseek-official', 'DeepSeek 官方')
    add('opencode-go', 'OpenCode Go')
    add('opencode', 'OpenCode Zen')
    return out
  }

  /** Built-in SuperGrok catalog used when the live adapter list is still warming up. */
  private static readonly XAI_FALLBACK_MODELS: { id: string; label: string }[] = [
    { id: 'grok-4.6', label: 'Grok 4.6' },
    { id: 'grok-4.5', label: 'Grok 4.5' },
    { id: 'grok-4.3', label: 'Grok 4.3' },
  ]

  /** /model: stay on the current provider by default; switching providers is opt-in. */
  private async runModelCommand(): Promise<void> {
    const llm = this.ctx.get('llm')
    const current = this.selectionRef?.current
    const providers = this.listSelectableProviders()
    let provider = this.currentProviderId()
    const SWITCH_PROVIDER_ID = '__switch_provider__'
    const pickProvider = async (): Promise<string | undefined> => {
      if (providers.length <= 1) return provider
      const currentIndex = Math.max(0, providers.findIndex(option => option.id === provider))
      const pickedAnswer = await this.askQuestion({
        id: 'provider-pick',
        question: '选择提供商',
        options: providers.map(option => ({
          label: option.label,
          description: option.id === provider
            ? `${describeProviderRoute(option.id).kind} · 当前`
            : describeProviderRoute(option.id).kind,
        })),
      }, 0, 1, currentIndex)
      return providers.find(option => option.label === pickedAnswer.selected[0])?.id
    }

    let modelOptions: { id: string; label: string }[] = []
    let modelSource = '已配置列表'
    // OpenCode and other third-party routes are interrogated live so the picker
    // shows what the endpoint actually serves, not just the stored catalog.
    if (this.piAiProviderProfile(provider) !== undefined || provider === 'opencode' || provider === 'opencode-go') {
      const previousStatus = this.status
      try {
        this.status = `正在从端点获取 ${provider} 的模型列表…`
        this.markDirty()
        modelOptions = await this.discoverEndpointModels(provider)
        if (modelOptions.length > 0) {
          modelSource = '端点实时列表'
          // Keep models the endpoint does not list (e.g. ones already stored
          // for the route) selectable, so the live list never hides the
          // current model.
          try {
            const listed = (await llm?.listModels(provider)) ?? []
            const endpointIds = new Set(modelOptions.map(model => model.id))
            for (const model of listed) {
              if (!endpointIds.has(model.id)) {
                modelOptions.push({ id: model.id, label: model.name || model.id })
              }
            }
          } catch {
            // The endpoint list stands alone when the catalog cannot be read.
          }
        }
      } catch {
        modelOptions = []
      } finally {
        this.status = previousStatus
        this.markDirty()
      }
    }
    if (modelOptions.length === 0) {
      try {
        const listed = (await llm?.listModels(provider)) ?? []
        modelOptions = listed.map(model => ({ id: model.id, label: model.name || model.id }))
      } catch {
        modelOptions = []
      }
    }
    if (modelOptions.length === 0 && providerUsesLocalOAuth(provider)) {
      modelOptions = SshTui.XAI_FALLBACK_MODELS.map(option => ({ ...option }))
      modelSource = 'SuperGrok 目录'
    }
    if (modelOptions.length === 0) {
      const fallback = current?.model ?? this.agent.options.model ?? (
        providerUsesLocalOAuth(provider) ? 'grok-4.6' : 'deepseek-v4-flash'
      )
      modelOptions = [{ id: fallback, label: fallback }]
    }
    if (current?.model !== undefined && !modelOptions.some(option => option.id === current.model)) {
      modelOptions = [{ id: current.model, label: current.model }, ...modelOptions]
    }

    if (providers.length > 1) {
      modelOptions = [
        ...modelOptions,
        { id: SWITCH_PROVIDER_ID, label: '更换提供商…' },
      ]
    }
    const selected = await this.pickModelOption(modelOptions, provider, modelSource, current?.model)
    if (selected === undefined) return
    if (selected.id === SWITCH_PROVIDER_ID) {
      const nextProvider = await pickProvider()
      if (nextProvider === undefined || nextProvider === provider) return
      provider = nextProvider
      modelOptions = []
      modelSource = '已配置列表'
      // Reload the model list for the newly chosen provider.
      if (this.piAiProviderProfile(provider) !== undefined || provider === 'opencode' || provider === 'opencode-go') {
        try {
          modelOptions = await this.discoverEndpointModels(provider)
          if (modelOptions.length > 0) modelSource = '端点实时列表'
        } catch {
          modelOptions = []
        }
      }
      if (modelOptions.length === 0) {
        try {
          const listed = (await llm?.listModels(provider)) ?? []
          modelOptions = listed.map(model => ({ id: model.id, label: model.name || model.id }))
        } catch {
          modelOptions = []
        }
      }
      if (modelOptions.length === 0 && providerUsesLocalOAuth(provider)) {
        modelOptions = SshTui.XAI_FALLBACK_MODELS.map(option => ({ ...option }))
        modelSource = 'SuperGrok 目录'
      }
      if (modelOptions.length === 0) {
        const fallback = providerUsesLocalOAuth(provider) ? 'grok-4.6' : 'deepseek-v4-flash'
        modelOptions = [{ id: fallback, label: fallback }]
      }
      const switched = await this.pickModelOption(modelOptions, provider, modelSource, undefined)
      if (switched === undefined) return
      return await this.applyModelSelection(provider, switched.id, undefined)
    }
    await this.applyModelSelection(provider, selected.id, modelOptions.map(option => option.id).filter(id => id !== SWITCH_PROVIDER_ID))
  }

  /** Persist a provider/model/effort choice and keep the subagent on the same family. */
  private async applyModelSelection(provider: string, modelId: string, listed: readonly string[] = []): Promise<void> {
    if (!(await this.ensureProviderModelConfigured(provider, modelId))) return
    const llm = this.ctx.get('llm')
    const current = this.selectionRef?.current
    let effortOptions: { id: string; label: string }[] = []
    try {
      const info = await llm?.resolveModelInfo(provider, modelId)
      effortOptions = (info?.reasoning?.efforts ?? []).map(effort => ({ id: String(effort.id), label: effort.name }))
    } catch {
      effortOptions = []
    }
    if (effortOptions.length === 0 && providerUsesLocalOAuth(provider)) {
      effortOptions = modelId === 'grok-4.6'
        ? [
            { id: 'off', label: 'Off' },
            { id: 'low', label: 'Low' },
            { id: 'medium', label: 'Medium' },
            { id: 'high', label: 'High' },
            { id: 'xhigh', label: 'Extra high' },
          ]
        : [
            { id: 'off', label: 'Off' },
            { id: 'low', label: 'Low' },
            { id: 'medium', label: 'Medium' },
            { id: 'high', label: 'High' },
          ]
    }

    let effort: string | undefined
    if (effortOptions.length > 0) {
      const currentEffort = current?.provider === provider ? String(current?.reasoningEffort ?? '') : ''
      const currentIndex = Math.max(0, effortOptions.findIndex(option => option.id === currentEffort))
      const effortAnswer = await this.askQuestion({
        id: 'effort-pick',
        question: `选择思考强度（${modelId}）`,
        options: effortOptions.map(option => ({
          label: option.label,
          description: option.id === currentEffort ? '当前' : undefined,
        })),
      }, 0, 1, currentIndex)
      effort = effortOptions.find(option => option.label === effortAnswer.selected[0])?.id
    }

    const next: ModelSelection = {
      provider,
      model: modelId,
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
    }
    if (this.selectionRef !== undefined) this.selectionRef.current = next
    this.onSelectionChanged?.(next)
    await this.ctx.get('agentDefaultModel')?.saveSelection(next)
    const kind = describeProviderRoute(provider)
    this.pushRow({
      kind: 'system',
      text: `已切换到 ${kind.kind}：${provider}/${modelId}（思考强度 ${effort ?? '默认'}${effortOptions.length === 0 ? '，该模型未声明可选强度' : ''}）；下一步请求生效。`,
    })
    await this.syncSubagentToProvider(provider, listed.filter(id => id !== '__switch_provider__' && id !== ''))
    this.markDirty()
  }

  /** Provider route the next subagent request should use. */
  private effectiveSubagentProvider(): string {
    return this.subagentSelection.current.provider
      ?? this.selectionRef?.current?.provider
      ?? this.agent.options.provider
      ?? this.providerName
  }

  /**
   * When the parent provider changes (OAuth or API key), keep the subagent
   * on a same-family model. An explicit leftover DeepSeek flash id after
   * switching to xAI is treated as stale.
   */
  private async syncSubagentToProvider(provider: string, listed: readonly string[] = []): Promise<void> {
    const current = this.subagentSelection.current
    if (current.provider !== undefined && current.provider !== provider) return
    if (subagentModelMatchesProvider(provider, current.model, listed)) return
    let catalog = [...listed]
    if (catalog.length === 0) {
      try {
        const { options } = await this.subagentModelOptions(provider)
        catalog = options.map(option => option.id)
      } catch {
        catalog = []
      }
    }
    const nextModel = defaultSubagentModelForProvider(provider, catalog)
    if (nextModel === current.model) return
    const persisted = await this.saveSubagentSelection({
      ...current,
      model: nextModel,
      reasoningEffort: undefined,
    })
    this.pushRow({
      kind: 'system',
      text: `子代理已跟随提供商 ${provider}，模型改为 ${nextModel}${persisted ? '' : '（仅当前会话）'}。`,
    })
  }

  /** Persist one subagent selection and publish it to the live request waterfall. */
  private async saveSubagentSelection(next: SubagentSelection): Promise<boolean> {
    this.subagentSelection.current = next
    const settings = this.ctx.get('settings')
    if (settings === undefined) {
      this.pushRow({ kind: 'error', text: '设置服务不可用，子代理选择仅当前会话生效。' })
      this.markDirty()
      return false
    }
    await settings.replace(SUBAGENT_SETTINGS_NAMESPACE, subagentSettingsValue(next))
    return true
  }

  /** Resolve the picker model list for one provider (endpoint first, then catalog). */
  private async subagentModelOptions(provider: string): Promise<{
    options: { id: string; label: string }[]
    source: string
  }> {
    const llm = this.ctx.get('llm')
    let options: { id: string; label: string }[] = []
    let source = '已配置列表'
    if (this.piAiProviderProfile(provider) !== undefined || provider === 'opencode' || provider === 'opencode-go') {
      const previousStatus = this.status
      try {
        this.status = `正在从端点获取子代理模型列表（${provider}）…`
        this.markDirty()
        options = await this.discoverEndpointModels(provider)
        if (options.length > 0) {
          source = '端点实时列表'
          try {
            const listed = (await llm?.listModels(provider)) ?? []
            const endpointIds = new Set(options.map(model => model.id))
            for (const model of listed) {
              if (!endpointIds.has(model.id)) options.push({ id: model.id, label: model.name || model.id })
            }
          } catch {
            // The endpoint list stands alone when the catalog cannot be read.
          }
        }
      } catch {
        options = []
      } finally {
        this.status = previousStatus
        this.markDirty()
      }
    }
    if (options.length === 0) {
      try {
        const listed = (await llm?.listModels(provider)) ?? []
        options = listed.map(model => ({ id: model.id, label: model.name || model.id }))
      } catch {
        options = []
      }
    }
    return { options, source }
  }

  /** /submodel: pick (or set) the model subagent children use. */
  private async runSubmodelCommand(arg: string): Promise<void> {
    const provider = this.effectiveSubagentProvider()
    const current = this.subagentSelection.current
    const direct = arg.trim()
    let selectedId = direct

    if (selectedId === '') {
      const { options, source } = await this.subagentModelOptions(provider)
      if (options.length === 0) {
        options.push({ id: current.model, label: current.model })
      }
      const selected = await this.pickModelOption(options, provider, source, current.model)
      if (selected === undefined) return
      selectedId = selected.id
    }
    if (!(await this.ensureProviderModelConfigured(provider, selectedId))) return

    const persisted = await this.saveSubagentSelection({ ...current, model: selectedId })
    this.pushRow({
      kind: 'system',
      text: `${current.provider === undefined
        ? `子代理模型已切换：${selectedId}（提供方跟随父会话 ${provider}）。`
        : `子代理模型已切换：${selectedId}（提供方 ${provider}）。`}${persisted ? '' : '（仅当前会话）'}`,
    })
    this.markDirty()
  }

  /** /subeffort: pick the reasoning effort subagent children use. */
  private async runSubeffortCommand(): Promise<void> {
    const provider = this.effectiveSubagentProvider()
    const current = this.subagentSelection.current
    const llm = this.ctx.get('llm')

    let effortOptions: { id: string; label: string }[] = []
    try {
      const info = await llm?.resolveModelInfo(provider, current.model)
      effortOptions = (info?.reasoning?.efforts ?? []).map(effort => ({ id: String(effort.id), label: effort.name }))
    } catch {
      effortOptions = []
    }
    if (effortOptions.length === 0 && current.reasoningEffort === undefined) {
      this.pushRow({
        kind: 'system',
        text: `模型 ${provider}/${current.model} 未声明可选 reasoning effort，已保持提供商默认；请勿手动设置 high/max。`,
      })
      this.markDirty()
      return
    }

    const choices: { id: string | undefined; label: string }[] = [
      { id: undefined, label: SUBAGENT_DEFAULT_EFFORT_LABEL },
      ...effortOptions.map(option => ({ id: option.id, label: option.label })),
    ]
    const answer = await this.askQuestion({
      id: 'subagent-effort-pick',
      question: `选择子代理思考强度（${provider}/${current.model}）`,
      options: choices.map(option => ({
        label: option.label,
        description: option.id === undefined
          ? '清空自定义强度，跟随提供商/模型默认'
          : option.id === String(current.reasoningEffort)
            ? '当前'
            : undefined,
      })),
    })
    const picked = choices.find(option => option.label === answer.selected[0])
    if (picked === undefined) return

    const next: SubagentSelection = {
      ...current,
      ...(picked.id === undefined
        ? { reasoningEffort: undefined }
        : { reasoningEffort: ReasoningEffortId(picked.id) }),
    }
    const persisted = await this.saveSubagentSelection(next)
    this.pushRow({
      kind: 'system',
      text: `${picked.id === undefined
        ? '子代理思考强度已恢复为提供商默认。'
        : `子代理思考强度已切换：${picked.id}。`}${persisted ? '' : '（仅当前会话）'}`,
    })
    this.markDirty()
  }

  /** /mode: pick an agent preset (standard / minimal / code / cordis / routing-suite / ...). */
  private async runModeCommand(): Promise<void> {
    const agentPresets = this.ctx.get('agentPresets')
    if (agentPresets === undefined) {
      this.pushRow({ kind: 'error', text: 'agentPresets 服务不可用。' })
      this.markDirty()
      return
    }
    const presets = await agentPresets.list()
    if (presets.length === 0) {
      this.pushRow({ kind: 'error', text: '没有可用的模式（preset）。' })
      this.markDirty()
      return
    }
    const answer = await this.askQuestion({
      id: 'mode-pick',
      question: '选择模式',
      options: presets.map(preset => ({
        label: preset.name ?? preset.id,
        description: `${preset.id === this.presetId ? '当前 · ' : ''}${preset.description ?? ''}`.trim(),
      })),
    })
    const selected = presets.find(preset => (preset.name ?? preset.id) === answer.selected[0])
    if (selected === undefined) return
    const selectedName = selected.name ?? selected.id
    const hasWork = this.agent.session.events.some(event => event.type === 'turn/start')
    if (!hasWork) {
      await agentPresets.recompose(this.agent.ctx, selected.id)
      this.presetId = selected.id
      this.presetName = selectedName
      this.pushRow({ kind: 'system', text: `已切换到模式：${selectedName}（当前会话生效）。` })
    } else {
      this.pushRow({
        kind: 'system',
        text: `当前会话已有内容，无法中途切换模式；已记住 ${selectedName}，下次启动生效。`,
      })
    }
    await this.ctx.get('settings')?.update(settingsNamespace('agent-presets'), { default: selected.id })
    this.markDirty()
  }

  /** /resume: switch to a past session, or open a picker when no id is given. */
  private async runResumeCommand(arg: string, fromLaunch = false): Promise<void> {
    const target = arg.trim()
    if (!fromLaunch && this.agent.status === 'running') {
      this.pushRow({ kind: 'error', text: '当前轮次运行中，请等待结束或按 Esc 取消后再切换会话。' })
      this.markDirty()
      return
    }
    if (target !== '') {
      if (target === String(this.agent.id)) {
        this.pushRow({ kind: 'system', text: '已在当前会话。' })
        this.markDirty()
        return
      }
      if (this.onSwitchSession === undefined) {
        this.pushRow({ kind: 'error', text: '会话切换回调不可用，无法 /resume。' })
        this.markDirty()
        return
      }
      this.pushRow({ kind: 'system', text: `正在切换到会话 ${target}…` })
      this.markDirty()
      await this.onSwitchSession(target)
      return
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      this.pushRow({ kind: 'error', text: 'sessionPersistence 服务不可用。' })
      this.markDirty()
      return
    }
    const inspected = await listResumableSessions(persistence, String(this.agent.id))
    if (inspected.length === 0) {
      this.pushRow({ kind: 'system', text: '没有可恢复的历史会话（也可以直接 /resume <session-id>）。' })
      this.markDirty()
      return
    }
    const answer = await this.askQuestion({
      id: 'resume-pick',
      question: '选择要恢复的历史会话',
      options: inspected.map(item => ({
        label: item.label,
        description: `${item.unreadable === true ? '⚠ 无法读取 · ' : ''}${formatSessionTime(item.updatedAt)} · ${item.cwd}`,
      })),
    })
    const picked = inspected.find(item => item.label === answer.selected[0])
    if (picked === undefined) return
    if (this.onSwitchSession === undefined) {
      this.pushRow({ kind: 'error', text: '会话切换回调不可用，无法 /resume。' })
      this.markDirty()
      return
    }
    this.pushRow({ kind: 'system', text: `正在切换到会话 ${picked.id}…` })
    this.markDirty()
    await this.onSwitchSession(picked.id)
  }

  /** Current provider route selected for the running agent. */
  private currentProvider(): string {
    // `agent.options` is authoritative for the launched agent; the selection
    // ref can still hold the persisted default when a CLI override is active.
    return this.agent.options.provider ?? this.selectionRef?.current?.provider ?? this.providerName
  }

  /** Resolve one credential reference without exposing its value. */
  private async resolveCredential(envRef: string): Promise<string | undefined> {
    const env = process.env[envRef]
    if (env !== undefined && env.trim() !== '') return env.trim()
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) return undefined
    const resolved = await credentials.resolve(credentialRef(envRef))
    return resolved?.value.trim() === '' ? undefined : resolved?.value.trim()
  }

  /** Query the OpenCode Go quota endpoint. */
  private async fetchOpenCodeGoUsage(apiKey: string): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(OPENCODE_GO_USAGE_URL, {
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      throw new Error(`无法访问 OpenCode 额度接口：${errorChain(error)}`)
    }
    let payload: unknown
    try {
      payload = await response.json() as unknown
    } catch {
      payload = undefined
    }
    if (!response.ok) {
      const message = openCodeApiErrorMessage(payload)
      if (response.status === 401) {
        throw new Error(`OpenCode Go API Key 无效或未授权（401）${message === '' ? '' : `：${message}`}`)
      }
      if (response.status === 403) {
        throw new Error(`当前 Key 未订阅 OpenCode Go，或额度服务不可用（403）${message === '' ? '' : `：${message}`}`)
      }
      throw new Error(`OpenCode Go 额度接口返回 HTTP ${response.status}${message === '' ? '' : `：${message}`}`)
    }
    return payload
  }

  /** Explain Zen metered billing instead of pretending it has a quota. */
  private zenUsageText(source: OpenCodeSource): string {
    const usage = this.stats.usage
    const billedInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    const tokenLine = billedInput > 0 || usage.outputTokens > 0
      ? `本会话已记录 token：输入 ${formatTokens(billedInput)} · 输出 ${formatTokens(usage.outputTokens)}（会话统计，非账单金额）`
      : '本会话尚无 token 用量记录。'
    return [
      `OpenCode Zen 按量计费（${source.provider}）`,
      'Zen 没有固定额度：请求按 API 账单计费，余额与账单请前往 https://opencode.ai/zen 查看。',
      tokenLine,
    ].join('\n')
  }

  /** /usage and /quota: remaining quota for the current subscription provider. */
  private async runUsageCommand(): Promise<void> {
    const previousStatus = this.status
    this.status = '查询额度…'
    this.markDirty()
    try {
      const snapshot = await this.refreshQuota({ reason: 'command', announce: true })
      if (snapshot === undefined) {
        const provider = this.currentProviderId()
        const llmPiAi = this.ctx.get('settings')?.get(settingsNamespace('llm-pi-ai'))
        const source = openCodeSourceFor(provider, llmPiAi)
        if (source?.flavor === 'zen') {
          this.pushRow({ kind: 'system', text: this.zenUsageText(source) })
        } else {
          this.pushRow({
            kind: 'system',
            text: `当前提供商 ${provider} 没有固定额度接口。OpenCode Go 与 SuperGrok 可查剩余额度；DeepSeek 官方按 API 计费。`,
          })
        }
      }
    } catch (error: unknown) {
      this.pushRow({ kind: 'error', text: `/usage failed: ${errorChain(error)}` })
    } finally {
      this.status = previousStatus
      this.markDirty()
    }
  }

  private applyQuotaSnapshot(snapshot: QuotaSnapshot, announce: boolean): void {
    const previous = this.quotaSnapshot === undefined ? undefined : tightestQuotaWindow(this.quotaSnapshot)
    this.quotaSnapshot = snapshot
    if (announce) this.pushRow({ kind: 'system', text: formatQuotaSnapshot(snapshot) })
    const window = tightestQuotaWindow(snapshot)
    if (window !== undefined) {
      for (const threshold of crossedQuotaThresholds(previous?.remainingPercent, window.remainingPercent)) {
        const key = `${snapshot.provider}:${window.period}:${threshold}`
        if (this.quotaAlerted.has(key)) continue
        this.quotaAlerted.add(key)
        this.pushRow({ kind: 'system', text: quotaAlertText(snapshot, window) })
      }
    }
    this.markDirty()
  }

  private async refreshQuota(options: { reason: 'start' | 'turn' | 'command'; announce: boolean }): Promise<QuotaSnapshot | undefined> {
    if (this.quotaRefreshInFlight && options.reason !== 'command') return this.quotaSnapshot
    this.quotaRefreshInFlight = true
    try {
      const provider = this.currentProviderId()
      const snapshot = await this.fetchQuotaSnapshot(provider)
      if (snapshot !== undefined) this.applyQuotaSnapshot(snapshot, options.announce)
      return snapshot
    } finally {
      this.quotaRefreshInFlight = false
    }
  }

  private async fetchQuotaSnapshot(provider: string): Promise<QuotaSnapshot | undefined> {
    if (providerUsesLocalOAuth(provider)) {
      const token = await this.resolveSuperGrokToken()
      if (token === undefined) throw new Error('未找到 SuperGrok OAuth token（~/.grok-bridge/auth.json）')
      const payload = await this.fetchJson(SUPERGROK_BILLING_URL, {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'x-grok-client-mode': 'cli',
        'x-grok-client-version': '1.0.0',
      }, 'SuperGrok')
      return parseSuperGrokBilling(payload)
    }
    const llmPiAi = this.ctx.get('settings')?.get(settingsNamespace('llm-pi-ai'))
    const source = openCodeSourceFor(provider, llmPiAi)
    if (source === null || source.flavor !== 'go') return undefined
    const apiKey = await this.resolveCredential(source.apiKeyEnv)
    if (apiKey === undefined) throw new Error(`未找到 OpenCode Go 凭据 ${source.apiKeyEnv}`)
    const payload = await this.fetchOpenCodeGoUsage(apiKey)
    return parseOpenCodeGoQuota(payload, source.provider)
  }

  private async resolveSuperGrokToken(): Promise<string | undefined> {
    const fromFile = async (path: string): Promise<string | undefined> => {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as {
          access_token?: unknown
          accessToken?: unknown
        }
        const token = typeof parsed.access_token === 'string' ? parsed.access_token : parsed.accessToken
        return typeof token === 'string' && token.trim() !== '' ? token.trim() : undefined
      } catch {
        return undefined
      }
    }
    return await fromFile(join(homedir(), '.grok-bridge', 'auth.json'))
      ?? await fromFile(join(homedir(), '.grok', 'auth.json'))
  }

  private async fetchJson(url: string, headers: Record<string, string>, label: string): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
    } catch (error) {
      throw new Error(`无法访问 ${label} 额度接口：${errorChain(error)}`)
    }
    let payload: unknown
    try {
      payload = await response.json() as unknown
    } catch {
      payload = undefined
    }
    if (!response.ok) {
      throw new Error(`${label} 额度接口返回 HTTP ${response.status}`)
    }
    return payload
  }

  // ── keyboard ────────────────────────────────────────────────────────────

  private readonly handleData = (chunk: Buffer): void => {
    const text = this.decoder.write(chunk)
    const combined = this.escapeBuffer + text
    this.escapeBuffer = ''
    if (this.escapeTimer !== undefined) {
      clearTimeout(this.escapeTimer)
      this.escapeTimer = undefined
    }

    // Bracketed paste: terminals wrap pasted content in \x1b[200~ ... \x1b[201~.
    // While inside a paste, CR/LF are literal input characters rather than
    // submit, so copying a multi-line error message arrives as one message.
    if (this.inPaste || combined.includes('\x1b[200~') || combined.includes('\x1b[201~')) {
      this.processPasteChunk(combined)
      return
    }

    const escape = /^\x1b\[([A-D])$/u
    const match = combined.match(escape)
    if (match !== null) {
      switch (match[1]) {
        case 'A':
          if (this.suggestionsVisible()) {
            this.suggestionIndex = Math.max(0, this.suggestionIndex - 1)
            this.markDirty()
          } else if (this.input === '' && this.collapsibleRows().length > 0) {
            this.moveCollapsibleFocus(-1)
          } else {
            this.historyBack()
          }
          return
        case 'B':
          if (this.suggestionsVisible()) {
            this.suggestionIndex = Math.min(this.commandSuggestions.length - 1, this.suggestionIndex + 1)
            this.markDirty()
          } else if (this.input === '' && this.collapsibleRows().length > 0) {
            this.moveCollapsibleFocus(1)
          } else {
            this.historyForward()
          }
          return
        case 'C': this.moveCursor(1); return
        case 'D': this.moveCursor(-1); return
      }
    }
    const sgrMouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/u.exec(combined)
    if (sgrMouse !== null) {
      const button = Number(sgrMouse[1])
      const y = Number(sgrMouse[3])
      if (sgrMouse[4] === 'M') {
        if (button === 64) {
          this.scrollOffset += 3
          this.markDirty()
          return
        }
        if (button === 65) {
          this.scrollOffset = Math.max(0, this.scrollOffset - 3)
          this.markDirty()
          return
        }
        if (button === 0) {
          this.handleMouseClick(y)
          return
        }
      }
      return
    }
    if (combined === '\x1b[5~') {
      this.scrollOffset += Math.max(3, Math.floor((process.stdout.rows || 24) / 2))
      this.markDirty()
      return
    }
    if (combined === '\x1b[6~') {
      this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(3, Math.floor((process.stdout.rows || 24) / 2)))
      this.markDirty()
      return
    }
    if (parseCursorPositionReply(combined) !== undefined) return
    if (combined === '\x1b[H' || combined === '\x1b[1~') { this.cursor = 0; this.markDirty(); return }
    if (combined === '\x1b[F' || combined === '\x1b[4~') { this.cursor = this.input.length; this.markDirty(); return }
    if (combined === '\x1b[3~') { this.deleteAtCursor(); return }
    const ss3 = /^\x1bO[A-Z]/u.exec(combined)
    if (ss3 !== null) {
      const rest = combined.slice(ss3[0].length)
      if (rest !== '') this.handlePlainText(rest)
      return
    }
    if (isEscapePrefix(combined)) {
      this.escapeBuffer = combined
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = undefined
        const pending = this.escapeBuffer
        this.escapeBuffer = ''
        if (pending === '\x1b') {
          this.handleChar('\x1b')
        } else if (pending === '\x1bO') {
          // ESC O without an SS3 final byte is an Alt+O keystroke, not a
          // function key.
          this.handlePlainText('O')
        } else if (pending.startsWith('\x1b[') || pending.startsWith('\x1bO')) {
          // An escape sequence that never completed: consume it silently
          // instead of treating its ESC byte as a cancel.
        } else if (pending !== '') {
          this.handlePlainText(pending)
        }
      }, 60)
      return
    }
    if (combined.startsWith('\x1b[') || combined.startsWith('\x1bO')) {
      // Unknown escape sequence (including SS3 function keys) — consume
      // without side effects.
      return
    }
    if (combined.startsWith('\x1b') && combined.length > 1) {
      const alt = combined.slice(1)
      if (alt === '1') { this.jumpToCategory('thinking'); return }
      if (alt === '2') { this.jumpToCategory('plan'); return }
      if (alt === '3') { this.jumpToCategory('subagent'); return }
      if (alt === '4') { this.jumpToCategory('reply'); return }
      if (alt === 'n' || alt === 'N') { this.stepSearch(1); return }
      if (alt === 'p' || alt === 'P') { this.stepSearch(-1); return }
      if (alt === 'f' || alt === 'F' || alt === '/') {
        this.input = '/find '
        this.cursor = this.input.length
        this.markDirty()
        return
      }
      // Other Alt+<key>: ignore ESC so it does not cancel, type the remainder.
      this.handlePlainText(alt)
      return
    }
    this.handlePlainText(combined)
  }

  /** Handle one data chunk that may contain bracketed-paste markers. */
  private processPasteChunk(combined: string): void {
    let index = 0
    while (index < combined.length) {
      if (combined.startsWith('\x1b[200~', index)) {
        this.inPaste = true
        index += 6
        continue
      }
      if (combined.startsWith('\x1b[201~', index)) {
        this.inPaste = false
        index += 6
        continue
      }
      let end = index
      while (end < combined.length
        && !combined.startsWith('\x1b[200~', end)
        && !combined.startsWith('\x1b[201~', end)) {
        end += 1
      }
      if (end > index) {
        const part = combined.slice(index, end)
        if (this.inPaste) this.handlePasteText(part)
        else this.handlePlainText(part)
        index = end
      } else {
        index += 1
      }
    }
  }

  /** Insert pasted text into the input buffer; CR/LF are literal newlines. */
  private handlePasteText(text: string): void {
    const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
    if (normalized === '') return
    this.input = `${this.input.slice(0, this.cursor)}${normalized}${this.input.slice(this.cursor)}`
    this.cursor += normalized.length
    this.markDirty()
  }

  private handlePlainText(text: string): void {
    // Fallback for terminals without bracketed paste: a burst of multiple line
    // breaks in one chunk is a paste, not repeated Enter presses.
    let newlines = 0
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index]
      if (char === '\r' && text[index + 1] !== '\n') newlines += 1
      else if (char === '\n' && text[index - 1] !== '\r') newlines += 1
    }
    if (newlines > 1) {
      this.handlePasteText(text)
      return
    }

    let previous = ''
    for (const char of text) {
      // Windows terminals may deliver Enter as CRLF; consume only the first half.
      if (char === '\n' && previous === '\r') {
        previous = char
        continue
      }
      if (char === '\r' && previous === '\n') {
        previous = char
        continue
      }
      this.handleChar(char)
      previous = char
    }
  }

  private handleChar(char: string): void {
    switch (char) {
      case '\x1b': this.handleEscape(); return
      case '\r':
      case '\n': this.submit(); return
      case '\x7f': this.backspace(); return
      case '\x08': this.backspace(); return
      case '\x03': this.handleCtrlC(); return
      case '\x04': void this.requestExit(0); return
      case '\x0c':
        this.lastPaintRows = []
        this.lastChromeKey = ''
        this.lastPaintWidth = 0
        this.lastPaintHeight = 0
        this.dirty = true
        this.render()
        return
      case '\x01': this.cursor = 0; this.markDirty(); return
      case '\x05': this.cursor = this.input.length; this.markDirty(); return
      case '\x15': this.input = ''; this.cursor = 0; this.inputFolded = false; this.markDirty(); return
      case '\x0b': this.input = this.input.slice(0, this.cursor); this.markDirty(); return
      case '\x0e': this.moveCollapsibleFocus(1); return
      case '\x10': this.moveCollapsibleFocus(-1); return
      case '\x12': this.toggleAllCollapsible(); return
      case '\x14': this.inputFolded = !this.inputFolded; this.markDirty(); return
    }
    if (this.dialog !== undefined) {
      this.handleDialogChar(char)
      return
    }
    if (char === '\x07') {
      this.stepSearch(1)
      return
    }
    if (char === '\x1f') {
      this.input = '/find '
      this.cursor = this.input.length
      this.markDirty()
      return
    }
    if (char === '\t') {
      if (this.suggestionsVisible()) {
        const selected = this.commandSuggestions[this.suggestionIndex]
        if (selected !== undefined) {
          this.input = `/${selected.name} `
          this.cursor = this.input.length
          this.commandSuggestions = []
          this.suggestionIndex = 0
          this.markDirty()
          return
        }
      }
      this.input = `${this.input.slice(0, this.cursor)}  ${this.input.slice(this.cursor)}`
      this.cursor += 2
      this.markDirty()
      return
    }
    if (char >= ' ' && char !== '\x7f') {
      this.input = `${this.input.slice(0, this.cursor)}${char}${this.input.slice(this.cursor)}`
      this.cursor += char.length
      this.markDirty()
    }
  }

  private handleDialogChar(text: string): void {
    const dialog = this.dialog
    if (dialog === undefined) return
    if (dialog.kind === 'onboarding') {
      this.handleOnboardingChar(text)
      return
    }
    if (dialog.kind === 'confirm') {
      if (text === 'y' || text === 'Y') this.closeConfirm('y')
      else if (text === 'n' || text === 'N') this.closeConfirm('n')
      else if (text === '\x03' || text === '\x1b') this.closeConfirm('cancel')
      return
    }
    const key = text.toLowerCase()
    const index = QUESTION_OPTION_KEYS.indexOf(key)
    if (index >= 0 && index < (dialog.question.options?.length ?? 0)) {
      if (dialog.question.multiSelect === true) {
        if (dialog.selected.has(index)) dialog.selected.delete(index)
        else dialog.selected.add(index)
      } else {
        dialog.selected.clear()
        dialog.selected.add(index)
      }
      this.markDirty()
    }
    if (text === '\r' || text === '\n') {
      const options = dialog.question.options ?? []
      const selected = [...dialog.selected].map(index => options[index]?.label).filter((label): label is string => label !== undefined)
      if (selected.length === 0 && options.length > 0 && dialog.question.multiSelect !== true) {
        // no selection: treat as cancel unless there are no options
        dialog.reject(new UserQuestionError('ask_user_question was cancelled', 'ASK_ABORTED'))
        return
      }
      if (options.length === 0) {
        dialog.resolve({ selected: [], custom: this.input })
        this.input = ''
        this.cursor = 0
        return
      }
      dialog.resolve({ selected })
      return
    }
    if (text === '\x1b' || text === '\x03') {
      dialog.reject(new UserQuestionError('ask_user_question was cancelled', 'ASK_ABORTED'))
      return
    }
    if (optionsLength(dialog) === 0) {
      for (const char of text) {
        if (char >= ' ' && char !== '\x7f') {
          this.input = `${this.input.slice(0, this.cursor)}${char}${this.input.slice(this.cursor)}`
          this.cursor += char.length
        }
      }
      this.markDirty()
    }
  }

  private handleOnboardingChar(text: string): void {
    const state = this.onboarding
    if (state === undefined) return
    switch (state.step) {
      case 'provider':
        {
          const selected = text === '1' ? 'official'
            : text === '2' ? 'opencode-go'
            : text === '3' ? 'openai-completions'
            : text === '4' ? 'openai-responses'
            : text === '5' ? 'anthropic-messages'
            : undefined
          if (selected !== undefined) {
            state.providerType = selected
            state.providerId = ''
            state.baseUrl = ''
            state.key = ''
            state.models = []
            this.input = ''
            this.cursor = 0
            this.advanceOnboarding()
          }
        }
        return
      case 'id':
      case 'base-url':
      case 'key':
      case 'models': {
        if (state.step === 'models' && text === '\x06') {
          void this.fetchOnboardingModels()
          return
        }
        if (text === '\r' || text === '\n') {
          const value = this.input.trim()
          if (state.step === 'id') {
            const template = PROVIDER_TEMPLATES[state.providerType]
            const id = value === '' ? template.defaultId : value
            if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
              this.pushRow({ kind: 'error', text: 'Provider ID 只能包含小写字母、数字和连字符，且不能以连字符开头。' })
              this.markDirty()
              return
            }
            state.providerId = id
          } else if (state.step === 'key') {
            if (value === '') {
              this.pushRow({ kind: 'error', text: 'API Key 不能为空，请重新输入。' })
              this.markDirty()
              return
            }
            state.key = value
          } else if (state.step === 'models') {
            const template = PROVIDER_TEMPLATES[state.providerType]
            const parsed = value === ''
              ? template.defaultModels
              : value.split(/[\s,，]+/u).filter(Boolean)
            if (parsed.length === 0) {
              this.pushRow({ kind: 'error', text: '至少需要一个模型 ID。' })
              this.markDirty()
              return
            }
            state.models = parsed
          } else {
            state.baseUrl = value
          }
          this.input = ''
          this.cursor = 0
          this.advanceOnboarding()
          return
        }
        for (const char of text) {
          if (char >= ' ' && char !== '\x7f') {
            this.input = `${this.input.slice(0, this.cursor)}${char}${this.input.slice(this.cursor)}`
            this.cursor += char.length
          }
        }
        this.markDirty()
        return
      }
      case 'confirm':
        if (state.saving) return
        if (text === 'y' || text === 'Y') {
          state.saving = true
          this.input = ''
          this.cursor = 0
          void this.saveOnboarding()
        } else if (text === 'n' || text === 'N') {
          state.step = 'provider'
          state.providerType = 'official'
          state.providerId = ''
          state.baseUrl = ''
          state.key = ''
          state.models = []
          this.input = ''
          this.cursor = 0
          this.markDirty()
        }
        return
    }
  }

  private advanceOnboarding(): void {
    const state = this.onboarding
    if (state === undefined) return
    if (state.step === 'provider') {
      state.step = state.providerType === 'official' ? 'key' : 'id'
    } else if (state.step === 'id') {
      state.step = 'base-url'
    } else if (state.step === 'base-url') {
      state.step = 'key'
    } else if (state.step === 'key') {
      state.step = 'models'
    } else if (state.step === 'models') {
      state.step = 'confirm'
    }
    this.input = ''
    this.cursor = 0
    this.markDirty()
  }

  /** Fetch the endpoint's model list into the onboarding wizard's models step. */
  private async fetchOnboardingModels(): Promise<void> {
    const state = this.onboarding
    if (state === undefined || state.step !== 'models') return
    const template = PROVIDER_TEMPLATES[state.providerType]
    const providerType = state.providerType
    const baseUrl = state.baseUrl
    const key = state.key
    const baseURL = baseUrl === '' ? template.defaultBaseUrl : baseUrl
    if (baseURL === '') {
      this.pushRow({ kind: 'error', text: '请先填写 Base URL 再获取模型列表。' })
      this.markDirty()
      return
    }
    const previousStatus = this.status
    this.status = '正在从端点获取模型列表…'
    this.markDirty()
    try {
      const llm = this.ctx.get('llm')
      if (llm === undefined) throw new Error('llm 服务不可用')
      const discovered = await llm.discoverModels(settingsNamespace('llm-pi-ai'), {
        baseURL,
        ...(template.api === undefined ? {} : { api: template.api }),
        ...(key === '' ? {} : { apiKey: key }),
        signal: AbortSignal.timeout(15_000),
      })
      // Apply only if the wizard is still on the same draft the fetch started
      // from, so a stale reply cannot overwrite a newer edit or a reset.
      const stillCurrent = this.onboarding === state
        && state.step === 'models'
        && state.providerType === providerType
        && state.baseUrl === baseUrl
        && state.key === key
      if (!stillCurrent) return
      const ids = [...new Set(discovered.map(model => model.id).filter(id => id.length > 0))]
      if (ids.length === 0) {
        this.pushRow({ kind: 'error', text: '端点没有返回可用模型，请手动输入模型 ID。' })
      } else {
        state.models = ids
        this.input = ''
        this.cursor = 0
        this.pushRow({ kind: 'system', text: `已从端点获取 ${ids.length} 个模型：${formatModelList(ids, 6)}（Enter 确认，也可继续修改）。` })
      }
    } catch (error) {
      this.pushRow({ kind: 'error', text: `获取模型列表失败：${errorChain(error)}` })
    } finally {
      this.status = previousStatus
      this.markDirty()
    }
  }

  private async saveOnboarding(): Promise<void> {
    const state = this.onboarding
    if (state === undefined) return
    let saved = true
    try {
      const credentials = this.ctx.get('credentials')
      const settings = this.ctx.get('settings')
      const template = PROVIDER_TEMPLATES[state.providerType]

      if (state.providerType === 'official') {
        const envRef = 'DEEPSEEK_API_KEY'
        await this.saveCredential(credentials, envRef, state.key)
        const model = state.models[0] ?? 'deepseek-v4-pro'
        await this.ctx.get('agentDefaultModel')?.saveSelection({ provider: 'deepseek-official', model })
        if (this.selectionRef !== undefined) {
          this.selectionRef.current = { provider: 'deepseek-official', model }
        }
        this.onSelectionChanged?.({ provider: 'deepseek-official', model })
        await this.syncSubagentToProvider('deepseek-official', state.models)
        if (state.baseUrl !== '' && settings !== undefined) {
          await settings.update(settingsNamespace('llm-deepseek'), { baseURL: state.baseUrl })
          this.pushRow({ kind: 'system', text: `Base URL 已保存 → ${displayDshPath('settings.yaml')}` })
        }
        if (saved) {
          this.pushRow({
            kind: 'system',
            text: `配置完成，已记住默认提供商/模型：deepseek-official / ${model}。以后直接运行 dsh --profile tui 即可。`,
          })
        }
      } else {
        const envRef = envRefForId(state.providerId)
        const model = state.models[0]
        // OpenCode / third-party (llm-pi-ai) routes have no adapter-level
        // reasoning default. Re-running setup must not silently drop the
        // effort that makes thinking arrive as `reasoning` blocks; default it
        // to a supported level (if any) and persist it in both the profile
        // and the default-model selection.
        const llm = this.ctx.get('llm')
        const defaultEffort = model !== undefined && llm !== undefined
          ? await defaultReasoningEffort(llm, state.providerId, model)
          : undefined
        const reasoningEfforts = defaultEffort === undefined
          ? undefined
          : { off: null, [defaultEffort]: defaultEffort }
        const profile = {
          displayName: template.label,
          apiKeyEnv: envRef,
          api: template.api,
          baseURL: state.baseUrl === '' ? template.defaultBaseUrl : state.baseUrl,
          models: state.models.map(id => ({
            id,
            ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
          })),
          ...(defaultEffort === undefined ? {} : { reasoning: defaultEffort }),
        }
        if (settings === undefined) {
          this.pushRow({ kind: 'error', text: '设置服务不可用，自定义提供商未保存。' })
          saved = false
        } else {
          await settings.mutate(settingsNamespace('llm-pi-ai'), [
            { op: 'set', path: ['providers', state.providerId], value: profile },
          ])
          this.pushRow({ kind: 'system', text: `提供商 ${state.providerId} 已保存 → ${displayDshPath('settings.yaml')}` })
        }
        // Only store the key when its provider profile actually made it to
        // settings; otherwise the saved key points at an unusable route.
        if (saved) await this.saveCredential(credentials, envRef, state.key)
        if (saved) {
          const selection: ModelSelection = {
            provider: state.providerId,
            model,
            ...(defaultEffort === undefined ? {} : { reasoningEffort: defaultEffort }),
          }
          await this.ctx.get('agentDefaultModel')?.saveSelection(selection)
          if (this.selectionRef !== undefined) {
            this.selectionRef.current = selection
          }
          this.onSelectionChanged?.(selection)
          await this.syncSubagentToProvider(state.providerId, state.models)
          this.pushRow({
            kind: 'system',
            text: `配置完成，已记住默认提供商/模型：${state.providerId} / ${model}。以后直接运行 dsh --profile tui 即可（--provider/--model 可临时覆盖）。`,
          })
        }
      }
    } catch (error) {
      saved = false
      this.pushRow({ kind: 'error', text: `保存配置失败: ${errorChain(error)}` })
    } finally {
      this.onboarding = undefined
      if (this.dialog?.kind === 'onboarding') this.dialog = undefined
      state.resolve(saved)
      this.showNextDialog()
      this.markDirty()
    }
  }

  /** Store one credential, falling back to a launch-environment override on shadow/absence. */
  private async saveCredential(
    credentials: CredentialProvider | undefined,
    envRef: string,
    key: string,
  ): Promise<void> {
    const shadowing = process.env[envRef]
    const shadowed = shadowing !== undefined && shadowing !== ''
    if (credentials !== undefined && !shadowed) {
      await credentials.set(credentialRef(envRef), key)
      this.pushRow({ kind: 'system', text: `${envRef} 已保存 → ${displayDshPath('.credentials.yaml')}` })
      return
    }
    await this.writeLaunchEnv({ [envRef]: key })
    this.pushRow({
      kind: 'system',
      text: shadowed
        ? IS_WINDOWS
          ? `环境变量 ${envRef} 已存在且优先，已用 setx + env.cmd 覆盖；新开的终端生效。`
          : `环境变量 ${envRef} 已存在且优先，已写入启动环境覆盖；新开的终端生效。`
        : `凭据服务不可用，已写入启动环境覆盖 → ${displayDshPath(IS_WINDOWS ? 'env.cmd' : 'env.sh')}`,
    })
  }

  /** Write launch-environment overrides so they beat system-injected variables. */
  private async writeLaunchEnv(entries: Record<string, string>): Promise<void> {
    const home = dshHomeDir()
    const file = join(home, IS_WINDOWS ? 'env.cmd' : 'env.sh')
    await mkdir(home, { recursive: true, mode: 0o700 })

    if (IS_WINDOWS) {
      let previous = ''
      try {
        previous = await readFile(file, 'utf8')
      } catch {
        // File absent: start fresh below.
      }
      const preserved = previous.split(/\r?\n/u).filter(Boolean).filter(line => {
        if (/^@echo off$/iu.test(line.trim())) return false
        if (/^rem Generated by dsh-ssh-tui onboarding\.$/iu.test(line.trim())) return false
        for (const name of Object.keys(entries)) {
          if (new RegExp(`^set\\s+"?${escapeRegex(name)}"?=`, 'iu').test(line.trim())) return false
        }
        return true
      })
      const additions = Object.entries(entries).map(([name, value]) => `set "${name}=${value.replaceAll('"', '')}"`)
      const lines = ['@echo off', 'rem Generated by dsh-ssh-tui onboarding.', ...preserved, ...additions]
      await writeFile(file, `${lines.join('\r\n')}\r\n`, { mode: 0o600 })
      // Persist for future processes; best-effort, env.cmd remains as a manual fallback.
      await Promise.all(Object.entries(entries).map(([name, value]) => this.setWindowsEnv(name, value))).catch(() => {})
      return
    }
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
    let previous = ''
    try {
      previous = await readFile(file, 'utf8')
    } catch {
      // File absent: start fresh below.
    }
    const preserved = previous.split('\n').filter(Boolean).filter(line => {
      if (line.trim() === '# Generated by dsh-ssh-tui onboarding.') return false
      for (const name of Object.keys(entries)) {
        if (new RegExp(`^export\\s+${escapeRegex(name)}=`).test(line)) return false
      }
      return true
    })
    const additions = Object.entries(entries).map(([name, value]) => `export ${name}=${quote(value)}`)
    await writeFile(file, `${['# Generated by dsh-ssh-tui onboarding.', ...preserved, ...additions].join('\n')}\n`, { mode: 0o600 })
    await this.ensurePosixEnvHook()
  }

  /** Persist one variable into the Windows user environment (best-effort). */
  private setWindowsEnv(name: string, value: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const child = spawn('setx', [name, value], { stdio: 'ignore', windowsHide: true })
      child.on('error', () => resolve())
      child.on('exit', () => resolve())
    })
  }

  /** Idempotently source $DSH_HOME/env.sh from the user's POSIX shell rc files. */
  private async ensurePosixEnvHook(): Promise<void> {
    if (process.env.DSH_TUI_NO_RC_HOOK === '1' || process.env.DSH_TUI_NO_RC_HOOK === 'true') return
    const envFile = join(dshHomeDir(), 'env.sh')
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
    const sourceLine = `[ -f ${quote(envFile)} ] && . ${quote(envFile)}`
    const marker = '# dsh-ssh-tui launch environment'
    const shell = process.env.SHELL ?? ''
    const targets: string[] = []
    if (shell.endsWith('zsh')) targets.push('.zshenv', '.zshrc')
    else if (shell.endsWith('fish')) targets.push('.config/fish/config.fish')
    else targets.push('.bashrc')
    targets.push('.profile')
    for (const relative of targets) {
      const file = join(homedir(), relative)
      let content = ''
      try {
        content = await readFile(file, 'utf8')
      } catch {
        // File absent: create it below when it is a primary target.
      }
      if (content.includes(marker)) continue
      const line = relative.endsWith('config.fish')
        ? `test -f ${quote(envFile)}; and source ${quote(envFile)}`
        : sourceLine
      const addition = `${content === '' ? '' : '\n'}${marker}\n${line}\n`
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await writeFile(file, content + addition, { mode: 0o600 })
    }
  }

  private handleEscape(): void {
    if (this.dialog !== undefined) {
      if (this.dialog.kind === 'confirm') this.closeConfirm('cancel')
      else if (this.dialog.kind === 'onboarding') this.cancelOnboarding()
      else this.dialog.reject(new UserQuestionError('ask_user_question was cancelled', 'ASK_ABORTED'))
      return
    }
    if (this.scrollOffset > 0) {
      this.scrollOffset = 0
      this.markDirty()
      return
    }
    if (this.focusedRow !== null) {
      this.focusedRow = null
      this.markDirty()
      return
    }
    if (this.suggestionsVisible()) {
      this.commandSuggestions = []
      this.suggestionIndex = 0
      this.markDirty()
      return
    }
    if (this.agent.status === 'running') {
      this.pushRow({ kind: 'system', text: '已请求取消当前轮次…' })
      this.agent.cancel({ kind: 'user' })
      this.status = 'cancelling…'
      this.markDirty()
    }
  }

  /** Toggle the collapsible row under a click on the transcript area. */
  private handleMouseClick(y: number): void {
    if (this.dialog !== undefined) return
    const row = this.clickableRows.get(y)
    if (row === undefined) return
    this.focusedRow = row
    row.expanded = !row.expanded
    this.markDirty()
  }

  private handleCtrlC(): void {
    if (this.dialog !== undefined) {
      this.handleEscape()
      return
    }
    if (this.agent.status === 'running') {
      this.pushRow({ kind: 'system', text: '已请求取消当前轮次…（Ctrl+C）' })
      this.agent.cancel({ kind: 'user' })
      this.status = 'cancelling…'
      this.markDirty()
      return
    }
    void this.requestExit(130)
  }

  private submit(): void {
    if (this.dialog !== undefined) {
      this.handleDialogChar('\r')
      return
    }
    this.scrollOffset = 0
    if (this.input.trim() === '' && this.collapsibleRows().length > 0) {
      this.toggleCollapsible()
      return
    }
    if (this.suggestionsVisible()) {
      const selected = this.commandSuggestions[this.suggestionIndex]
      if (selected !== undefined && selected.name.startsWith(this.input.slice(1))) {
        this.input = `/${selected.name}`
        this.cursor = this.input.length
      }
    }
    const text = this.input.trim()
    if (text === '') return
    if (text.startsWith('/')) {
      this.runCommand(text)
      return
    }
    if (this.agentGone) return
    this.history.push(text)
    this.historyIndex = this.history.length
    this.input = ''
    this.cursor = 0
    this.inputFolded = false
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    if (this.agent.status === 'running') {
      this.pendingMessages.set(message.id, text)
      this.pushRow({ kind: 'system', text: `⚡ ${text}（运行中已提交，将在下个步骤生效；Esc/Ctrl+C 可中断）` })
      this.agent.steer(message)
    } else {
      this.agent.followup(message)
    }
    this.markDirty()
  }

  private runCommand(text: string): void {
    const [command, ...rest] = text.slice(1).split(/\s+/u)
    const arg = rest.join(' ')
    switch (command) {
      case 'help': {
        const local = LOCAL_COMMANDS
          .filter(item => item.name !== 'help' && item.name !== 'exit')
          .map(item => `/${item.name.padEnd(12)} ${item.description}`)
        const dsh = (this.ctx.get('commands')?.list(this.agent) ?? [])
          .map(item => `/${item.name.padEnd(12)} ${item.description}${item.input?.images === true ? '（可附图）' : ''}  (dsh)`)
        this.pushRow({
          kind: 'system',
          text: [
            ...local,
            ...dsh,
            '',
            '运行中按 Enter 可插入指示；Esc 取消选择或当前轮次；空闲 Ctrl+C 退出。',
            '空输入时 ↑/↓ 选卡片（与 Ctrl+N/P 相同）；Enter 展开；Ctrl+R 全部展开/收起；Ctrl+T 折叠输入。',
            'Alt+1 最新思考 · Alt+2 计划 · Alt+3 子代理 · Alt+4 最新回复。',
            '/find [思考|计划|子代理|回复] 关键字；Ctrl+/ 或 Alt+/ 打开搜索，Ctrl+G / Alt+N 下一条。',
            '/model 默认列出当前提供商的模型；当前是 SuperGrok 时直接选 grok-4.6 / grok-4.5 和思考强度（含 xhigh）。要换提供商再选「更换提供商」。',
            '/setup 只用于配置 API Key 提供商。SuperGrok / X Premium 走本机 OAuth，不需要填 Key。',
            '/status 会标明当前是 DeepSeek 官方、SuperGrok 订阅、OpenCode Go / Zen，还是其它已注册提供商。',
          ].join('\n'),
        })
        break
      }
      case 'quit':
      case 'exit':
        void this.requestExit(0)
        break
      case 'model':
        void this.runModelCommand().catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow({ kind: 'system', text: '模型选择已取消。' })
          } else {
            this.pushRow({ kind: 'error', text: `/model failed: ${errorChain(error)}` })
          }
          this.markDirty()
        })
        break
      case 'submodel':
        void this.runSubmodelCommand(arg).catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow({ kind: 'system', text: '子代理模型选择已取消。' })
          } else {
            this.pushRow({ kind: 'error', text: `/submodel failed: ${errorChain(error)}` })
          }
          this.markDirty()
        })
        break
      case 'subeffort':
        void this.runSubeffortCommand().catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow({ kind: 'system', text: '子代理思考强度选择已取消。' })
          } else {
            this.pushRow({ kind: 'error', text: `/subeffort failed: ${errorChain(error)}` })
          }
          this.markDirty()
        })
        break
      case 'mode':
        void this.runModeCommand().catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow({ kind: 'system', text: '模式选择已取消。' })
          } else {
            this.pushRow({ kind: 'error', text: `/mode failed: ${errorChain(error)}` })
          }
          this.markDirty()
        })
        break
      case 'find':
        this.runFindCommand(arg)
        break
      case 'clear':
        this.rows.length = 0
        this.streaming = undefined
        this.streamingReasoning = undefined
        this.thinkingStartedAt = undefined
        this.focusedRow = null
        this.searchHits = []
        this.searchIndex = -1
        this.searchQuery = ''
        this.planNudgePending = false
        this.pendingReveal = undefined
        this.pushRow({ kind: 'system', text: '转录已清空。子代理、计划与提问卡片会在新事件到达时重新出现。' })
        break
      case 'status':
        {
          const plan = this.findLivePlanRow()
          const waiting = this.rows.filter(row => row.kind === 'question' && row.status === 'waiting').length
          const provider = this.currentProviderId()
          const route = describeProviderRoute(provider)
          const model = this.selectionRef?.current?.model ?? this.agent.options.model ?? 'default'
          const effort = this.selectionRef?.current?.reasoningEffort
          const lines = [
            `session: ${this.agent.id}`,
            `plugin: dsh-ssh-tui ${PLUGIN_VERSION}`,
            `route: ${provider}/${model}${effort === undefined ? '' : ` (${effort})`}`,
            `provider: ${route.kind}`,
            `status: ${this.agent.status}`,
            `preset: ${this.presetName}`,
            `subagents: ${this.activeSubagents.size}`,
            `plan: ${plan === undefined ? 'off' : plan.pending ? 'pending' : plan.active ? 'on' : 'off'}`,
            `paint: ${paintLinkLabel(this.paintLink, this.paintIntervalMs, this.paintProbed)}`,
            waiting > 0 ? `questions: waiting ${waiting}` : 'questions: none',
          ]
          this.pushRow({ kind: 'system', text: lines.join('\n') })
        }
        break
      case 'usage':
      case 'quota':
        void this.runUsageCommand().catch((error: unknown) => {
          this.pushRow({ kind: 'error', text: `/${command} failed: ${errorChain(error)}` })
          this.markDirty()
        })
        break
      case 'subagents': {
        const trimmed = arg.trim()
        if (trimmed !== '' && trimmed !== 'list') {
          const [action, ...ids] = trimmed.split(/\s+/u)
          if (action === 'kill' || action === 'stop') {
            if (ids.length === 0) {
              this.pushRow({ kind: 'error', text: '/subagents kill <session-id> — 缺少子代理会话 ID' })
              break
            }
            const subagents = this.ctx.get('subagents')
            if (subagents === undefined) {
              this.pushRow({ kind: 'error', text: 'subagents service is unavailable' })
              break
            }
            const targets = ids.map(id => SessionId(id))
            void subagents.drainContinuableChildren(this.agent, targets).then(() => {
              this.pushRow({ kind: 'system', text: `已请求释放子代理：${ids.join(', ')}` })
              this.markDirty()
            }).catch((error: unknown) => {
              this.pushRow({ kind: 'error', text: `/subagents kill failed: ${errorChain(error)}` })
              this.markDirty()
            })
            break
          }
          this.pushRow({ kind: 'error', text: `/subagents 未知操作 "${action}"（支持 list / kill <id>）` })
          break
        }
        if (this.activeSubagents.size === 0) {
          this.pushRow({ kind: 'system', text: '当前没有活动的子代理。' })
        } else {
          const lines = [...this.activeSubagents.entries()].map(([runId, sub]) => {
            const card = this.findSubagentRow(sub.id)
            const label = card?.label ?? sub.id
            const activity = card?.lastActivity ? ` · ${card.lastActivity}` : ''
            return `▶ ${label}  ${sub.id}（${sub.provider}）运行 ${Math.floor((Date.now() - sub.startedAt) / 1000)}s  [${runId.slice(0, 8)}]${activity}`
          })
          this.pushRow({ kind: 'system', text: `${lines.join('\n')}\n空输入时 ↑/↓ 选卡片，Enter 展开；Alt+3 跳到最新子代理。` })
        }
        break
      }
      case 'resume':
        void this.runResumeCommand(arg).catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow({ kind: 'system', text: '会话选择已取消。' })
          } else {
            this.pushRow({ kind: 'error', text: `/resume failed: ${errorChain(error)}` })
          }
          this.markDirty()
        })
        break
      case 'setup':
        void this.runOnboarding()
        break
      case 'dialog-test': {
        const questions = this.ctx.get('userQuestions')
        if (questions === undefined) {
          this.pushRow({ kind: 'error', text: 'userQuestions service is unavailable' })
          break
        }
        void questions.ask({
          questions: [{
            id: 'tui-test',
            question: 'Choose an option to verify the dialog',
            options: [{ label: 'Option A' }, { label: 'Option B' }],
          }],
          agent: this.agent,
        }).then(
          (answer) => {
            this.pushRow({ kind: 'system', text: `dialog answer: ${JSON.stringify(answer)}` })
            this.markDirty()
          },
          (error) => {
            this.pushRow({ kind: 'error', text: `dialog error: ${errorChain(error)}` })
            this.markDirty()
          },
        )
        break
      }
      default:
        {
          const commands = this.ctx.get('commands')
          if (commands === undefined) {
            this.pushRow({ kind: 'error', text: `Unknown command: /${command} (try /help)` })
            break
          }
          this.commandAbort?.abort()
          const controller = new AbortController()
          this.commandAbort = controller
          void commands.execute(this.agent, text, [], controller.signal).then((execution) => {
            if (execution === undefined) {
              this.pushRow({ kind: 'error', text: `Unknown command: /${command} (try /help)` })
              return
            }
            const result = execution.result
            if (result.kind === 'success') {
              if (result.text !== undefined && result.text !== '') {
                this.pushRow({ kind: 'system', text: result.text })
              }
            } else {
              this.pushRow({ kind: 'error', text: result.text })
            }
          }).catch((error: unknown) => {
            this.pushRow({ kind: 'error', text: `/${command} failed: ${errorChain(error)}` })
          }).finally(() => {
            if (this.commandAbort === controller) this.commandAbort = undefined
            this.markDirty()
          })
        }
        break
    }
    this.input = ''
    this.cursor = 0
    this.inputFolded = false
    this.markDirty()
  }

  /** Grapheme cluster immediately before `cursor`; cursor-internal positions delete it whole. */
  private graphemeBefore(cursor: number): { start: number; end: number } {
    if (cursor <= 0) return { start: 0, end: 0 }
    let previousStart = 0
    let previousEnd = 0
    for (const segment of GRAPHEME_SEGMENTER.segment(this.input)) {
      const start = segment.index
      const end = start + segment.segment.length
      if (cursor === start) return { start: previousStart, end: previousEnd }
      if (cursor > start && cursor < end) return { start, end }
      previousStart = start
      previousEnd = end
    }
    return { start: previousStart, end: previousEnd }
  }

  /** Grapheme cluster containing or following `cursor`. */
  private graphemeAfter(cursor: number): { start: number; end: number } | undefined {
    for (const segment of GRAPHEME_SEGMENTER.segment(this.input)) {
      const start = segment.index
      const end = start + segment.segment.length
      if (cursor === start || (cursor > start && cursor < end)) return { start, end }
    }
    return undefined
  }

  private backspace(): void {
    if (this.cursor === 0) return
    const range = this.graphemeBefore(this.cursor)
    this.input = `${this.input.slice(0, range.start)}${this.input.slice(range.end)}`
    this.cursor = range.start
    this.markDirty()
  }

  private deleteAtCursor(): void {
    const range = this.graphemeAfter(this.cursor)
    if (range === undefined) return
    this.input = `${this.input.slice(0, range.start)}${this.input.slice(range.end)}`
    this.cursor = range.start
    this.markDirty()
  }

  private moveCursor(delta: number): void {
    if (delta < 0) {
      let target = 0
      for (const segment of GRAPHEME_SEGMENTER.segment(this.input)) {
        if (segment.index >= this.cursor) break
        target = segment.index
      }
      this.cursor = target
    } else {
      let target = this.input.length
      for (const segment of GRAPHEME_SEGMENTER.segment(this.input)) {
        const start = segment.index
        const end = start + segment.segment.length
        if (start > this.cursor) {
          target = start
          break
        }
        if (end > this.cursor) {
          target = end
          break
        }
      }
      this.cursor = target
    }
    this.markDirty()
  }

  private historyBack(): void {
    if (this.history.length === 0) return
    if (this.historyIndex <= 0) return
    this.historyIndex -= 1
    this.input = this.history[this.historyIndex] ?? ''
    this.cursor = this.input.length
    this.markDirty()
  }

  private historyForward(): void {
    if (this.historyIndex >= this.history.length) return
    this.historyIndex += 1
    this.input = this.history[this.historyIndex] ?? ''
    this.cursor = this.input.length
    this.markDirty()
  }
}

function optionsLength(dialog: Dialog): number {
  return dialog.kind === 'questions' ? dialog.question.options?.length ?? 0 : 0
}

/** Escape a string for safe interpolation into a RegExp source. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function envRefForId(providerId: string): string {
  return `${providerId.replaceAll('-', '_').toUpperCase()}_API_KEY`
}

function collectText(
  blocks: readonly {
    type: string
    text?: string
    content?: readonly { type: string; text?: string }[]
  }[],
): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text !== undefined) parts.push(block.text)
    else if (block.type === 'tool-result' && block.content !== undefined) parts.push(collectText(block.content))
  }
  return parts.join('\n')
}

/**
 * Mount the terminal channel once the configured agent exists.
 *
 * @param ctx - context supplying the agent registry, sessions, and event stream.
 * @param config - target agent and presentation config.
 * @returns lifecycle controller used by the Cordis effect disposer.
 */
export function mountTui(ctx: Context, config: TuiConfig): TuiController {
  const sessionId = SessionId(config.sessionId)
  let settled = false
  let controller: SshTui | undefined

  const start = (agent: Agent): void => {
    if (settled || agent.id !== sessionId || !ctx.agents.roots().includes(agent)) return
    settled = true
    stopWaiting()
    controller = new SshTui(ctx, agent, config)
    controller.start()
    controller.replayHistory()
  }

  const fail = (failedSessionId: SessionId, error: unknown): void => {
    if (settled || failedSessionId !== sessionId) return
    settled = true
    stopWaiting()
    process.stdout.write(`dsh-ssh-tui: session "${sessionId}" failed to start: ${errorChain(error)}\n`)
    const exit = ctx.get('appExit')
    if (exit !== undefined) exit(1)
    else process.exit(1)
  }

  const disposeCreated = ctx.on('agent/created', ({ agent }) => start(agent))
  const disposeFailure = ctx.on('agent-loop/config-start-failed', ({ sessionId: failedSessionId, error }) => fail(failedSessionId, error))

  const stopWaiting = (): void => {
    disposeCreated()
    disposeFailure()
  }

  const existing = ctx.agents.roots().find(agent => agent.id === sessionId)
  if (existing !== undefined) start(existing)

  return {
    async dispose(): Promise<void> {
      stopWaiting()
      await controller?.dispose()
    },
  }
}
