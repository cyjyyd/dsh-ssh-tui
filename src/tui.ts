/**
 * A small, dependency-light interactive terminal channel for DeepSeek
 * Harness. It renders the durable session transcript, streams assistant
 * output, shows tool-call cards, answers approval requests and
 * `ask_user_question` prompts from the keyboard, and drives one configured
 * agent with followup/steer.
 *
 * The renderer uses plain ANSI and a throttled full repaint, which keeps it
 * predictable over slow SSH links and avoids terminal-library dependency
 * drift inside the plugin.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, errorChain, ReasoningEffortId, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { formatSessionTime, listResumableSessions } from './session-list.js'
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
  /** Whether this launch resumes an existing persisted session. */
  resume?: boolean
  /** Provider route selected at launch (defaults to deepseek-official). */
  provider?: string
  /** Model selected at launch (defaults to the saved/fallback model). */
  model?: string
  /** Live model-selection ref installed on the agent; mutated by /model. */
  selectionRef?: ModelSelectionRef
  /** Active agent-preset id (standard/code/minimal/cordis/...). */
  presetId?: string
  /** Display name of the active preset. */
  presetName?: string
  /** Switch the running TUI to another session (used by /resume). */
  onSwitchSession?: (sessionId: string) => Promise<void> | void
  /** Open the history-session picker immediately after mounting (--resume). */
  resumePicker?: boolean
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
  | { kind: 'system'; text: string }
  | { kind: 'error'; text: string }

/** A reasoning/tool row or the live streaming-reasoning block. */
type CollapsibleBlock =
  | Extract<Row, { kind: 'reasoning' } | { kind: 'tool' }>
  | { kind: 'streaming-reasoning'; expanded: boolean }

type DisplayKind = Row['kind'] | 'tool-result' | 'diff-add' | 'diff-del' | 'diff-path'

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

const RENDER_INTERVAL_MS = 120
const WAIT_INDICATOR_MS = 8000
const STALL_WARNING_MS = 60000
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const RESERVED_BOTTOM_LINES = 3 // input line + stats line + status line
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
  return `~/.dsh/${file}`
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

const LOCAL_COMMANDS = [
  { name: 'help', description: 'show all available commands' },
  { name: 'model', description: 'select model and reasoning effort (same provider)' },
  { name: 'mode', description: 'switch agent mode / preset (standard, PTC, minimal, ...)' },
  { name: 'quit', description: 'exit the TUI' },
  { name: 'exit', description: 'exit the TUI' },
  { name: 'clear', description: 'clear the transcript view' },
  { name: 'status', description: 'show session, provider and model status' },
  { name: 'subagents', description: 'list active subagents' },
  { name: 'resume', description: 'resume a past session (empty = session picker)' },
  { name: 'setup', description: 're-open provider / API key setup' },
  { name: 'dialog-test', description: 'verify the question dialog' },
] as const

function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    width += wide ? 2 : 1
  }
  return width
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  for (const rawLine of text.split('\n')) {
    if (rawLine === '') {
      lines.push('')
      continue
    }
    let rest = rawLine
    while (displayWidth(rest) > width) {
      let cut = 0
      let used = 0
      for (const char of rest) {
        const charWidth = displayWidth(char)
        if (used + charWidth > width) break
        used += charWidth
        cut += char.length
      }
      if (cut === 0) cut = 1
      lines.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    lines.push(rest)
  }
  return lines
}

function truncate(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  const head = lines.slice(0, Math.max(1, maxLines - 1))
  const tail = lines.slice(-1)
  return [...head, `… ${lines.length - head.length - 1} more line(s) …`, ...tail].join('\n')
}

/** Cut one line to fit a width, appending an ellipsis when truncated. */
function truncateToWidth(text: string, width: number): string {
  if (displayWidth(text) <= width) return text
  let cut = 0
  let used = 0
  for (const char of text) {
    const charWidth = displayWidth(char)
    if (used + charWidth > width - 1) break
    used += charWidth
    cut += char.length
  }
  if (cut === 0) cut = 1
  return `${text.slice(0, cut)}…`
}

/** Whether `text` could still grow into a recognized escape sequence. */
function isEscapePrefix(text: string): boolean {
  if (text === '\x1b') return true
  if (!text.startsWith('\x1b')) return false
  if (text === '\x1b[') return true
  if (/^\x1b\[[A-D]$/u.test(text)) return true
  if (/^\x1b\[[HF]$/u.test(text)) return true
  if (/^\x1b\[\d~?$/u.test(text)) return true
  if (/^\x1b\[<(?:\d*;?)*[Mm]?$/u.test(text)) return true
  return false
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

/** Prefer the fields a human scans for; fall back to the first scalar pairs. */
function friendlyArgsSummary(name: string, args: string): string {
  const parsed = parseJsonArgs(args)
  if (parsed === null) return args.slice(0, 120)
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
  return summary === '' ? name : summary.slice(0, 160)
}

const SHELL_TOOL_NAMES = new Set(['bash', 'pwsh'])
const DIFF_TOOL_NAMES = new Set(['edit', 'write', 'str_replace_editor'])

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
    const command = typeof parsed?.command === 'string' ? parsed.command : args.slice(0, 80)
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
  if (rows.length <= maxLines) return rows
  const head = rows.slice(0, Math.max(1, maxLines - 1))
  const tail = rows.slice(-1)
  return [
    ...head,
    { kind: 'tool-result', text: `… ${rows.length - head.length - 1} more line(s) …` },
    ...tail,
  ]
}

/** Keys whose multiline strings render as indented content blocks. */
const LONG_TEXT_KEYS = new Set([
  'program', 'content', 'file_text', 'new_string', 'old_string',
  'plan', 'markdown', 'details', 'description', 'text',
])

const JSON_STRING_CAP = 400

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
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`]
    const lines: string[] = []
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        lines.push(`${pad}-`)
        lines.push(...friendlyJsonLines(item, depth + 1))
      } else {
        lines.push(`${pad}- ${friendlyJsonLines(item, 0)[0] ?? ''}`)
      }
    }
    return lines
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return [`${pad}{}`]
    const lines: string[] = []
    for (const [key, item] of entries) {
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
    return lines
  }
  return [`${pad}${String(value)}`]
}

/** Minimal tool-row shape the expanded-body renderer reads. */
interface ToolBodySource {
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
    return renderToolDiff(row.diff, maxLines)
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
  return out
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

/** Owns one interactive terminal channel and its agent event wiring. */
export class SshTui {
  private readonly rows: Row[] = []
  private streaming: { text: string; reasoning: string } | undefined
  private input = ''
  private cursor = 0
  private history: string[] = []
  private historyIndex = -1
  private status = 'idle'
  private dialog: Dialog | undefined
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
  private readonly onSwitchSession: ((sessionId: string) => Promise<void> | void) | undefined
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
  private completedAt = 0
  private lastTitleUpdateAt = 0
  private lastPaintRows: string[] = []

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    config: TuiConfig,
  ) {
    const noColorEnv = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== ''
    this.color = config.color !== false && !noColorEnv && process.env.TERM !== 'dumb'
    this.maxToolOutputLines = Math.max(1, config.maxToolOutputLines ?? 6)
    this.showReasoning = config.showReasoning !== false
    this.goodbye = this.ctx.get('tuiGoodbyeMessage') as string | undefined
      ?? `To resume this session: dsh --profile tui --resume=${this.agent.id}`
    this.resume = config.resume === true
    this.providerName = config.provider ?? 'deepseek-official'
    this.selectionRef = config.selectionRef
    this.onSwitchSession = config.onSwitchSession
    this.resumePicker = config.resumePicker === true
    this.presetId = config.presetId ?? 'standard'
    this.presetName = config.presetName ?? this.presetId
    this.useAlternateScreen = process.env.DSH_TUI_NO_ALT_SCREEN !== '1' && process.env.DSH_TUI_NO_ALT_SCREEN !== 'true'
    this.pushRow({ kind: 'brand-logo' })
    this.pushRow({ kind: 'system', text: 'DeepSeek Harness — SSH TUI' })
    this.pushRow({ kind: 'system', text: 'Type /help for commands · /setup provider & key · ↑/↓ select · Enter expand/collapse · Esc cancels' })
  }

  /** Enter raw mode, switch to the alternate screen, and start listening. */
  start(): void {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', this.handleData)
    process.stdout.on('resize', this.markDirty)
    process.on('SIGWINCH', this.markDirty)

    this.disposers.push(
      this.ctx.on('session/event', this.handleSessionEvent),
      this.ctx.on('agent/status', this.handleStatus),
      this.ctx.on('agent/error', this.handleError),
      this.ctx.on('agent/disposed', this.handleDisposed),
      this.ctx.on('agent/inbox/claimed', this.handleInboxClaimed),
      this.ctx.on('agent/inbox/discarded', this.handleInboxDiscarded),
      this.ctx.on('subagent/start', this.handleSubagentStart),
      this.ctx.on('subagent/end', this.handleSubagentEnd),
      this.ctx.on('approval/request', this.handleApproval),
    )
    const questions = this.ctx.get('userQuestions')
    if (questions !== undefined) {
      this.userQuestionDisposer = questions.registerProvider({ ask: this.handleUserQuestions })
    }

    this.write(`${this.useAlternateScreen ? '\x1b[?1049h' : ''}\x1b[?1000h\x1b[?1006h\x1b[?25l`)
    this.render()
    this.updateTerminalTitle()
    if (this.resumePicker) {
      void this.runResumeCommand('', true)
    }
    this.renderTimer = setInterval(() => {
      const now = Date.now()
      if (this.agent.status === 'running') this.updateTerminalTitle()
      if (this.streaming !== undefined
        && this.streaming.reasoning !== ''
        && now - this.lastPaintAt >= 200) {
        this.dirty = true
      }
      // While a turn is waiting on the provider with no new events, repaint at
      // most once per second so slow SSH links do not drown in redraws.
      const idleWaiting = this.agent.status === 'running' && !this.dirty
      if (idleWaiting && now - this.lastPaintAt < 1000) return
      // Running with no fresh events only needs the seconds-bearing status
      // line refreshed; force one repaint per second instead of every tick.
      if (this.agent.status === 'running' && !this.dirty && now - this.lastPaintAt >= 1000) {
        this.dirty = true
      }
      if (this.dirty) {
        this.lastPaintAt = now
        this.render()
      }
    }, RENDER_INTERVAL_MS)
    this.renderTimer.unref?.()

    void this.maybeRunOnboarding()
  }

  /** Replay the durable session log so a resumed session renders its history. */
  replayHistory(): void {
    for (const event of this.agent.session.events) {
      this.handleSessionEvent(this.agent.session, event)
    }
    this.streaming = undefined
    this.status = this.agent.status === 'running' ? 'running' : 'idle'
    this.dirty = true
  }

  /** Show the first-launch provider/API-key onboarding when nothing is configured. */
  private async maybeRunOnboarding(): Promise<void> {
    const credentials = this.ctx.get('credentials')
    const provider = this.providerName
    const envRef = provider === 'deepseek-official' ? 'DEEPSEEK_API_KEY' : envRefForId(provider)
    const envKey = process.env[envRef]
    let stored = false
    if (credentials !== undefined) {
      stored = (await credentials.describe(credentialRef(envRef))).configured
    }
    if (!stored) {
      // Belt-and-braces: the file provider may not have its in-memory snapshot
      // visible to this plugin copy yet; the managed document is authoritative.
      try {
        const credentialFile = join(dshHomeDir(), '.credentials.yaml')
        if (existsSync(credentialFile)) {
          const content = await readFile(credentialFile, 'utf8')
          stored = new RegExp(`^${envRef}\\s*:\\s*\\S`, 'm').test(content)
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
    return new Promise<boolean>((resolve) => {
      this.onboarding = {
        step: 'provider',
        providerType: 'official',
        providerId: '',
        baseUrl: '',
        key: '',
        models: [],
        resolve,
      }
      this.input = ''
      this.cursor = 0
      this.dialog = { kind: 'onboarding' }
      this.markDirty()
    })
  }

  private cancelOnboarding(): void {
    const state = this.onboarding
    if (state === undefined) return
    this.onboarding = undefined
    this.dialog = undefined
    this.input = ''
    this.cursor = 0
    state.resolve(false)
    this.markDirty()
  }

  /** Restore the terminal, flush the session, and request process exit. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.exiting = true
    const dialog = this.dialog
    if (dialog !== undefined) {
      if (dialog.kind === 'confirm') {
        dialog.resolve('cancel')
      } else if (dialog.kind === 'questions') {
        dialog.reject(new UserQuestionError('TUI closed before the question was answered', 'ASK_ABORTED'))
      } else {
        this.cancelOnboarding()
      }
      this.dialog = undefined
    }
    if (this.renderTimer !== undefined) clearInterval(this.renderTimer)
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
    this.write(`\x1b[0m\x1b[?1000l\x1b[?1006l\x1b[?25h${this.useAlternateScreen ? '\x1b[?1049l' : ''}`)
  }

  /** Human-facing exit with goodbye and flush; called from key handling. */
  async requestExit(code: number): Promise<void> {
    if (this.exiting) return
    this.exiting = true
    await this.dispose()
    process.stdout.write(`\n${this.goodbye}\n`)
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

  private write(chunk: string): void {
    process.stdout.write(chunk)
  }

  private markDirty = (): void => {
    this.dirty = true
  }

  /** Append one transcript row, bounding memory on long sessions. */
  private pushRow(row: Row): void {
    this.rows.push(row)
    if (this.rows.length > 500) {
      const removed = this.rows.length - 500
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
      (row): row is Extract<Row, { kind: 'reasoning' } | { kind: 'tool' }> =>
        row.kind === 'reasoning' || row.kind === 'tool')
    if (this.streaming !== undefined && this.streaming.reasoning !== '') {
      this.streamingReasoning ??= { kind: 'streaming-reasoning', expanded: false }
      rows.push(this.streamingReasoning)
    }
    return rows
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

  private paint = (): void => {
    if (this.exiting) return
    const width = Math.max(10, process.stdout.columns || 80)
    const height = Math.max(6, process.stdout.rows || 24)

    const display: string[] = []
    const displayRefs: (CollapsibleBlock | undefined)[] = []
    const addDisplay = (
      line: string,
      ref?: CollapsibleBlock,
    ): void => {
      display.push(line)
      displayRefs.push(ref)
    }
    const pushRow = (kind: DisplayKind, text: string): void => {
      for (const line of wrap(text, width)) {
        addDisplay(this.styleLine(kind, line))
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
        const header = `${marker} 已思考 · ${lines} 行${row.expanded ? '' : ' · Ctrl+R 展开'}`
        const line = `${focused ? '▶ ' : '  '}${header}`
        const styled = this.styleLine('reasoning', line)
        addDisplay(focused && this.color ? `\x1b[7m${styled}\x1b[27m` : styled, row)
        if (row.expanded) {
          for (const wrapped of wrap(row.text, width)) {
            addDisplay(this.styleLine('reasoning', wrapped))
          }
        }
        continue
      }
      if (row.kind === 'tool') {
        const running = row.status === undefined || row.status === 'running'
        const ok = row.status === 'ok'
        const dot = this.color
          ? running ? '\x1b[33m●\x1b[0m' : ok ? '\x1b[32m●\x1b[0m' : '\x1b[31m●\x1b[0m'
          : '●'
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
        const plainHeader = `${marker} ● ${row.title}${summary}  [${state}]${exit}`
        if (!row.expanded) {
          const collapsed = truncateToWidth(
            `${focused ? '▶ ' : '  '}${plainHeader}`,
            Math.max(1, width - 2),
          )
          const dotIndex = collapsed.indexOf('●')
          const withDot = dotIndex === -1
            ? collapsed
            : `${collapsed.slice(0, dotIndex)}${dot}${collapsed.slice(dotIndex + 1)}`
          const styled = this.styleLine('tool', withDot)
          addDisplay(focused && this.color ? `\x1b[7m${styled}\x1b[27m` : styled, row)
          continue
        }
        for (const [index, wrapped] of wrap(plainHeader, width).entries()) {
          const dotIndex = index === 0 ? wrapped.indexOf('●') : -1
          const withDot = dotIndex === -1
            ? wrapped
            : `${wrapped.slice(0, dotIndex)}${dot}${wrapped.slice(dotIndex + 1)}`
          addDisplay(this.styleLine('tool', withDot), row)
        }
        for (const line of toolBodyLines(row, this.maxToolOutputLines)) {
          for (const wrapped of wrap(line.text, Math.max(1, width - 2))) {
            addDisplay(this.styleLine(line.kind, `  ${wrapped}`))
          }
        }
        continue
      }
      pushRow(row.kind, row.text)
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
            addDisplay(this.styleLine('reasoning', wrapped))
          }
        }
      }
      if (this.streaming.text !== '') {
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
              addDialog(`  默认：${template.defaultModels.join(', ')}`)
              addDialog('  Enter 确认，Esc 取消')
              break
            case 'confirm':
              addDialog('确认保存以下配置？')
              addDialog(`  提供商:  ${providerLabel}`)
              addDialog(`  Provider ID: ${ob.providerId}`)
              addDialog(`  Base URL: ${ob.baseUrl === '' ? (template.defaultBaseUrl || '(默认)') : ob.baseUrl}`)
              addDialog(`  API 协议: ${template.api ?? 'deepseek-official'}`)
              addDialog(`  模型: ${ob.models.join(', ')}`)
              addDialog(`  API Key:  ${ob.key.slice(0, 6)}…${ob.key.slice(-4)}（长度 ${ob.key.length}）`)
              addDialog('  y = 保存, n = 重填, Esc = 取消')
              break
          }
        }
      } else {
        const d = this.dialog
        addDialog(`Question ${d.index + 1}/${d.total}: ${d.question.question}`)
        if (d.question.detail !== undefined && d.question.detail !== '') {
          addDialog(truncate(d.question.detail, 6))
        }
        const options = d.question.options ?? []
        for (const [index, option] of options.entries()) {
          const marker = d.selected.has(index) ? '●' : '○'
          const extra = option.description === undefined ? '' : ` — ${option.description}`
          addDialog(`  ${index + 1} ${marker} ${option.label}${extra}`)
        }
        if (options.length === 0) {
          addDialog('  (free text: type below and press Enter)')
        }
        addDialog(`  ${d.question.multiSelect === true ? 'digits toggle, Enter submit' : 'digit to select, Enter submit'}, Esc to cancel`)
      }
    }

    const fitLine = (text: string): string => truncateToWidth(text, Math.max(1, width))
    const headerLines = [
      this.styleLine('system', fitLine(`DeepSeek Harness — SSH TUI  [${this.presetName}]  ${this.currentSelectionLabel()}`)),
      this.styleLine('system', '─'.repeat(width)),
    ]
    if (this.scrollOffset > 0) {
      headerLines.push(this.styleLine('system', fitLine(`↑ 已回看 ${this.scrollOffset} 行 · PgUp/PgDn/滚轮滚动 · Esc 回到底部`)))
    }
    const inputDivider = this.styleLine('system', '─'.repeat(width))

    this.commandSuggestions = this.dialog === undefined ? this.buildSuggestions() : []
    if (this.suggestionIndex >= this.commandSuggestions.length) {
      this.suggestionIndex = Math.max(0, this.commandSuggestions.length - 1)
    }
    const suggestionLines: string[] = []
    for (const [index, command] of this.commandSuggestions.entries()) {
      const marker = index === this.suggestionIndex ? '›' : ' '
      const line = `  ${marker} /${command.name.padEnd(14)} ${command.description}${command.local ? '' : '  (dsh)'}`
      suggestionLines.push(index === this.suggestionIndex
        ? `\x1b[7m${fitLine(line)}\x1b[27m`
        : this.styleLine('system', fitLine(line)))
    }

    const promptPlain = this.color ? '❯ ' : '> '
    const prompt = this.color ? `\x1b[36m${promptPlain.trimEnd()}\x1b[0m ` : promptPlain
    const promptWidth = displayWidth(promptPlain)
    const masked = this.dialog?.kind === 'onboarding' && this.onboarding?.step === 'key'
    const visibleInput = masked ? '•'.repeat(this.input.length) : this.input
    const inputPlainWidth = displayWidth(`${promptPlain}${visibleInput}`)
    const inputRows = Math.max(1, Math.ceil(inputPlainWidth / Math.max(1, width)))

    const reserved = RESERVED_BOTTOM_LINES + (inputRows - 1) + headerLines.length + suggestionLines.length + 1 // +1 input divider
    const available = Math.max(1, height - reserved - dialogLines.length)
    const maxOffset = Math.max(0, display.length - available)
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
      if (ref !== undefined) this.clickableRows.set(headerLines.length + index + 1, ref)
    }

    const inputLine = `${prompt}${visibleInput}`
    const statsText = this.statsText()
    const statsLine = this.styleLine('system', fitLine(statsText === '' ? '— 尚无会话统计' : statsText))

    let statusText = `${this.status}  ${this.agent.id}  [${this.presetName}]  ${this.currentSelectionLabel()}`
    if (this.pendingMessages.size > 0) statusText += ` · 排队 ${this.pendingMessages.size}`
    const idleMs = Date.now() - this.lastActivity
    if (this.agent.status === 'running' && this.activeSubagents.size > 0) {
      statusText += ` · 子代理执行中 ${this.activeSubagents.size}`
    } else if (this.agent.status === 'running' && this.openToolCalls.size > 0) {
      statusText += ` · 工具执行中 ${this.openToolCalls.size}`
    } else if (this.agent.status === 'running' && idleMs > WAIT_INDICATOR_MS) {
      statusText += ` · 等待响应 ${Math.floor(idleMs / 1000)}s`
    }
    const statusLine = this.styleLine('system', fitLine(statusText))

    const paintRows: string[] = [
      ...headerLines,
      ...visible,
      ...dialogLines,
      inputDivider,
      ...suggestionLines,
      `${inputLine}\x1b[0m`,
      `${statsLine}\x1b[0m`,
      `${statusLine}\x1b[0m`,
    ]

    // Incremental repaint: rewrite only rows whose content changed, so slow
    // SSH links don't rebuild (and flicker) the whole screen on every tick.
    this.write('\x1b[?25l')
    const maxRows = Math.max(paintRows.length, this.lastPaintRows.length)
    for (let i = 0; i < maxRows; i++) {
      const current = paintRows[i]
      if (current === this.lastPaintRows[i]) continue
      this.write(`\x1b[${i + 1};1H${current ?? ''}\x1b[K`)
    }
    if (paintRows.length < this.lastPaintRows.length) {
      this.write(`\x1b[${paintRows.length + 1};1H\x1b[J`)
    }
    this.lastPaintRows = paintRows

    const column = (promptWidth + displayWidth(visibleInput.slice(0, this.cursor))) % Math.max(1, width) + 1
    const inputTopRow = visible.length + dialogLines.length + suggestionLines.length + headerLines.length + 2
    const row = Math.min(height, inputTopRow + inputRows - 1)
    this.write(`\x1b[${row};${Math.max(1, column)}H\x1b[?25h`)
  }

  private buildSuggestions(): { name: string; description: string; local: boolean }[] {
    const input = this.input
    if (!input.startsWith('/')) return []
    const prefix = input.slice(1).toLowerCase()
    const dsh = (this.ctx.get('commands')?.list(this.agent) ?? []).map(command => ({
      name: command.name,
      description: command.description,
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

  private currentSelectionLabel(): string {
    const current = this.selectionRef?.current
    const provider = current?.provider ?? this.agent.options.provider ?? this.providerName
    const model = current?.model ?? this.agent.options.model ?? 'unknown'
    const effort = current?.reasoningEffort
    return `${provider}/${model}${effort === undefined ? '' : ` (${effort})`}`
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
    if (this.completedAt !== 0 && now - this.completedAt < 5000) {
      this.write('\x1b]0;dsh ✓ 已完成\x07')
      return
    }
    if (this.agent.status === 'running') {
      if (now - this.lastTitleUpdateAt < 800) return
      this.lastTitleUpdateAt = now
      const spinner = SPINNER[Math.floor(now / 800) % SPINNER.length]
      let detail = '运行中'
      if (this.openToolCalls.size > 0) detail = `运行中 · 工具 ${this.openToolCalls.size}`
      else if (this.activeSubagents.size > 0) detail = `运行中 · 子代理 ${this.activeSubagents.size}`
      this.write(`\x1b]0;dsh ${spinner} ${detail}\x07`)
      return
    }
    this.write('\x1b]0;dsh 待命\x07')
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
    if (!this.color) return text
    const code =
      kind === 'user' ? '36' :
      kind === 'assistant' ? '32' :
      kind === 'reasoning' ? '2;3' :
      kind === 'brand' ? '1;38;2;77;107;253' :
      kind === 'tool' || kind === 'tool-result' ? '33' :
      kind === 'diff-add' ? '32' :
      kind === 'diff-del' ? '31' :
      kind === 'diff-path' ? '1;36' :
      kind === 'error' ? '31' :
      '90'
    return `\x1b[${code}m${text}`
  }

  // ── event handling ──────────────────────────────────────────────────────

  private readonly handleSessionEvent = (session: { id: SessionId }, event: SessionEvent): void => {
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
        this.streaming = undefined
        this.streamingReasoning = undefined
        this.thinkingStartedAt = undefined
        if (reasoning !== '') {
          this.pushRow({ kind: 'reasoning', text: reasoning, expanded: reasoningExpanded })
        }
        if (text !== '') this.pushRow({ kind: 'assistant', text })
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
          expanded: false,
        }
        this.pushRow(row)
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
          if (metaDiffs !== null) row.diff = metaDiffs
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
        this.markDirty()
        break
      }
      case 'turn/start':
        this.stalledWarningShown = false
        this.status = `turn ${event.data.turn} running`
        this.markDirty()
        break
      case 'turn/end': {
        const reason = event.data.reason
        this.openToolCalls.clear()
        this.pendingToolTimes.clear()
        this.stalledWarningShown = false
        this.pendingMessages.clear()
        if (reason.kind === 'completed' && !this.completionSignaled) {
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
        this.markDirty()
        break
      }
      default:
        break
    }
  }

  private readonly handleStatus = ({ agent, status }: { agent: Agent; status: string }): void => {
    if (agent !== this.agent) return
    this.lastActivity = Date.now()
    if (status === 'running') {
      this.completionSignaled = false
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

  /** Render a live subagent's own session events so its progress is visible. */
  private readonly handleSubagentSessionEvent = (sessionId: SessionId, event: SessionEvent): void => {
    const label = `[子代理 ${String(sessionId).slice(0, 8)}]`
    switch (event.type) {
      case 'user/message': {
        const text = collectText(event.data.content)
        if (text !== '') this.pushRow({ kind: 'system', text: `${label} ❯ ${truncate(text, 6)}` })
        break
      }
      case 'assistant/chunk': {
        // Child chunks are coalesced into assistant/message to avoid flooding.
        break
      }
      case 'assistant/message': {
        const text = collectText(event.data.message.content)
        if (text !== '') this.pushRow({ kind: 'assistant', text: `${label} ${truncate(text, 12)}` })
        break
      }
      case 'tool/call':
        this.pushRow({ kind: 'system', text: `${label} ▶ ${event.data.name} ${event.data.arguments.slice(0, 160)}` })
        break
      case 'tool/result': {
        const output = truncate(collectText(event.data.message.content), 4)
        const ok = event.data.error === undefined && !event.data.message.content[0]?.isError
        this.pushRow({ kind: 'system', text: `${label} ${ok ? '✓' : '✗'} ${event.data.message.source.callId}${output === '' ? '' : `\n  ${output}`}` })
        break
      }
      case 'turn/end':
        this.pushRow({ kind: 'system', text: `${label} 轮次结束（${event.data.reason.kind}）` })
        break
      case 'approval/asked':
        this.pushRow({ kind: 'system', text: `${label} 等待审批：${event.data.toolName}` })
        break
      default:
        break
    }
    this.lastActivity = Date.now()
    this.markDirty()
  }

  private readonly handleSubagentStart = (info: SubagentRunInfo): void => {
    this.activeSubagents.set(String(info.runId), {
      id: String(info.id),
      provider: info.provider,
      startedAt: Date.now(),
    })
    this.subagentSessions.add(String(info.id))
    this.lastActivity = Date.now()
    this.pushRow({ kind: 'system', text: `▶ 子代理 ${info.id} 已启动（${info.provider}${info.local ? '' : '，外部进程'}）` })
    this.markDirty()
  }

  private readonly handleSubagentEnd = (info: SubagentRunEndInfo): void => {
    this.activeSubagents.delete(String(info.runId))
    this.subagentSessions.delete(String(info.id))
    this.lastActivity = Date.now()
    const output = info.lastAssistantMessage === undefined
      ? ''
      : truncate(collectText(info.lastAssistantMessage), 6)
    this.pushRow({
      kind: 'system',
      text: `✓ 子代理 ${info.id} 结束（${info.stopReason}）${output === '' ? '' : `\n  ${output}`}`,
    })
    this.markDirty()
  }

  // ── approval and questions ──────────────────────────────────────────────

  private readonly handleApproval = async (
    request: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> => {
    const agentLabel = request.agent.id === this.agent.id
      ? '当前会话'
      : `子代理 ${request.agent.id}`
    return new Promise<ApprovalOutcome>((resolve) => {
      const onAbort = (): void => {
        this.closeConfirm('cancel')
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      this.openConfirm(
        `允许工具 "${request.toolName}"？（${agentLabel}）${request.reason === undefined ? '' : `\n${request.reason}`}`,
        'y = 允许一次, n = 拒绝, Esc = 取消',
        (answer) => {
          request.signal?.removeEventListener('abort', onAbort)
          resolve(answer === 'y' ? 'allowed-once' : answer === 'n' ? 'rejected' : 'cancelled')
        },
      )
    })
  }

  private readonly handleUserQuestions = async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
    const answers: AskUserQuestionAnswer['answers'] = []
    const agentLabel = request.agent === undefined || request.agent.id === this.agent.id
      ? undefined
      : `子代理 ${request.agent.id}`
    for (const [index, question] of request.questions.entries()) {
      const answer = await new Promise<DialogAnswer>((resolve, reject) => {
        const onAbort = (): void => {
          this.dialog = undefined
          reject(new UserQuestionError('ask_user_question was interrupted before the user answered', 'ASK_ABORTED'))
        }
        request.signal?.addEventListener('abort', onAbort, { once: true })
        const labeled: AskUserQuestionItem = agentLabel === undefined
          ? question
          : { ...question, question: `[${agentLabel}] ${question.question}` }
        this.openQuestion(labeled, index, request.questions.length, (selection) => {
          request.signal?.removeEventListener('abort', onAbort)
          resolve(selection)
        }, reject)
      })
      answers.push({ id: question.id, selected: answer.selected, custom: answer.custom })
    }
    return { answers }
  }

  private openConfirm(prompt: string, hint: string, resolve: (value: 'y' | 'n' | 'cancel') => void): void {
    this.dialog = { kind: 'confirm', prompt, hint, resolve }
    this.markDirty()
  }

  private closeConfirm(value: 'y' | 'n' | 'cancel'): void {
    const dialog = this.dialog
    if (dialog === undefined || dialog.kind !== 'confirm') return
    this.dialog = undefined
    dialog.resolve(value)
    this.markDirty()
  }

  private openQuestion(
    question: AskUserQuestionItem,
    index: number,
    total: number,
    resolve: (answer: DialogAnswer) => void,
    reject: (error: unknown) => void,
  ): void {
    this.dialog = {
      kind: 'questions',
      question,
      index,
      total,
      selected: new Set(),
      resolve: (selection) => {
        this.dialog = undefined
        resolve(selection)
        this.markDirty()
      },
      reject: (error) => {
        this.dialog = undefined
        reject(error)
        this.markDirty()
      },
    }
    this.markDirty()
  }

  /** Open one question dialog and await its answer (cancellation rejects). */
  private askQuestion(question: AskUserQuestionItem, index = 0, total = 1): Promise<DialogAnswer> {
    return new Promise<DialogAnswer>((resolve, reject) => {
      this.openQuestion(question, index, total, resolve, reject)
    })
  }

  /** /model: pick a model and reasoning effort for the current provider. */
  private async runModelCommand(): Promise<void> {
    const llm = this.ctx.get('llm')
    const current = this.selectionRef?.current
    const provider = current?.provider ?? this.agent.options.provider ?? this.providerName

    let modelOptions: { id: string; label: string }[] = []
    try {
      const listed = (await llm?.listModels(provider)) ?? []
      modelOptions = listed.map(model => ({ id: model.id, label: model.name || model.id }))
    } catch {
      modelOptions = []
    }
    if (modelOptions.length === 0) {
      const fallback = current?.model ?? this.agent.options.model ?? 'deepseek-v4-flash'
      modelOptions = [{ id: fallback, label: fallback }]
    }

    const modelAnswer = await this.askQuestion({
      id: 'model-pick',
      question: `选择模型（提供商 ${provider}）`,
      options: modelOptions.map(option => ({
        label: option.label,
        description: option.id === current?.model ? '当前' : undefined,
      })),
    })
    const selected = modelOptions.find(option => option.label === modelAnswer.selected[0])
    if (selected === undefined) return

    let effortOptions: { id: string; label: string }[] = []
    try {
      const info = await llm?.resolveModelInfo(provider, selected.id)
      effortOptions = (info?.reasoning?.efforts ?? []).map(effort => ({ id: String(effort.id), label: effort.name }))
    } catch {
      effortOptions = []
    }
    if (effortOptions.length === 0) {
      effortOptions = ['off', 'high', 'max'].map(id => ({ id, label: id }))
    }

    const effortAnswer = await this.askQuestion({
      id: 'effort-pick',
      question: `选择思考强度（${selected.id}）`,
      options: effortOptions.map(option => ({
        label: option.label,
        description: option.id === String(current?.reasoningEffort) ? '当前' : undefined,
      })),
    })
    const effort = effortOptions.find(option => option.label === effortAnswer.selected[0])?.id

    const next: ModelSelection = {
      provider,
      model: selected.id,
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
    }
    if (this.selectionRef !== undefined) this.selectionRef.current = next
    await this.ctx.get('agentDefaultModel')?.saveSelection(next)
    this.pushRow({ kind: 'system', text: `模型已切换：${selected.id}（思考强度 ${effort ?? '默认'}）；下一步请求生效。` })
    this.markDirty()
  }

  /** /mode: pick an agent preset (standard / PTC / minimal / ...). */
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
      this.pushRow({ kind: 'system', text: `正在切换到会话 ${target}…` })
      this.markDirty()
      await this.onSwitchSession?.(target)
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
        description: `${formatSessionTime(item.updatedAt)} · ${item.cwd}`,
      })),
    })
    const picked = inspected.find(item => item.label === answer.selected[0])
    if (picked === undefined) return
    this.pushRow({ kind: 'system', text: `正在切换到会话 ${picked.id}…` })
    this.markDirty()
    await this.onSwitchSession?.(picked.id)
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
    if (combined === '\x1b[H' || combined === '\x1b[1~') { this.cursor = 0; this.markDirty(); return }
    if (combined === '\x1b[F' || combined === '\x1b[4~') { this.cursor = this.input.length; this.markDirty(); return }
    if (combined === '\x1b[3~') { this.deleteAtCursor(); return }
    if (isEscapePrefix(combined)) {
      this.escapeBuffer = combined
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = undefined
        const pending = this.escapeBuffer
        this.escapeBuffer = ''
        if (pending === '\x1b') {
          this.handleChar('\x1b')
        } else if (pending.startsWith('\x1b[')) {
          // An escape sequence that never completed: consume it silently
          // instead of treating its ESC byte as a cancel.
        } else if (pending !== '') {
          this.handlePlainText(pending)
        }
      }, 60)
      return
    }
    if (combined.startsWith('\x1b[')) {
      // Unknown escape sequence — consume without side effects.
      return
    }
    if (combined.startsWith('\x1b')) {
      this.handleChar('\x1b')
      const rest = combined.slice(1)
      if (rest !== '') this.handlePlainText(rest)
      return
    }
    this.handlePlainText(combined)
  }

  private handlePlainText(text: string): void {
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
      case '\x0c': this.dirty = true; this.render(); return
      case '\x01': this.cursor = 0; this.markDirty(); return
      case '\x05': this.cursor = this.input.length; this.markDirty(); return
      case '\x15': this.input = ''; this.cursor = 0; this.markDirty(); return
      case '\x0b': this.input = this.input.slice(0, this.cursor); this.markDirty(); return
      case '\x0e': this.moveCollapsibleFocus(1); return
      case '\x10': this.moveCollapsibleFocus(-1); return
      case '\x12': this.toggleCollapsible(); return
    }
    if (this.dialog !== undefined) {
      this.handleDialogChar(char)
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
    const digit = /^[0-9]$/u.exec(text)?.[0]
    if (digit !== undefined) {
      const index = Number(digit) - 1
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
      return
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
        if (text === 'y' || text === 'Y') {
          this.dialog = undefined
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
        const profile = {
          displayName: template.label,
          apiKeyEnv: envRef,
          api: template.api,
          baseURL: state.baseUrl === '' ? template.defaultBaseUrl : state.baseUrl,
          models: state.models.map(id => ({ id })),
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
        await this.saveCredential(credentials, envRef, state.key)
        if (saved) {
          const model = state.models[0]
          await this.ctx.get('agentDefaultModel')?.saveSelection({ provider: state.providerId, model })
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
      state.resolve(saved)
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
      const lines = ['@echo off', 'rem Generated by dsh-ssh-tui onboarding.']
      for (const [name, value] of Object.entries(entries)) {
        lines.push(`set "${name}=${value.replaceAll('"', '')}"`)
      }
      await writeFile(file, `${lines.join('\r\n')}\r\n`, { mode: 0o600 })
      // Persist for future processes; best-effort, env.cmd remains as a manual fallback.
      await Promise.all(Object.entries(entries).map(([name, value]) => this.setWindowsEnv(name, value))).catch(() => {})
      return
    }
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
    const lines = ['# Generated by dsh-ssh-tui onboarding.']
    for (const [name, value] of Object.entries(entries)) {
      lines.push(`export ${name}=${quote(value)}`)
    }
    await writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600 })
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
    const sourceLine = `[ -f "$HOME/.dsh/env.sh" ] && . "$HOME/.dsh/env.sh"`
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
        ? 'test -f "$HOME/.dsh/env.sh"; and source "$HOME/.dsh/env.sh"'
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
          .map(item => `/${item.name.padEnd(12)} ${item.description}  (dsh)`)
        this.pushRow({
          kind: 'system',
          text: [
            ...local,
            ...dsh,
            '',
            'Enter while running steers the agent; Esc or Ctrl+C cancels the turn.',
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
      case 'clear':
        this.rows.length = 0
        this.streaming = undefined
        break
      case 'status':
        this.pushRow({
          kind: 'system',
          text: `session: ${this.agent.id}\nmodel: ${this.agent.options.model ?? 'default'}\nprovider: ${this.agent.options.provider ?? 'default'}\nstatus: ${this.agent.status}`,
        })
        break
      case 'subagents': {
        if (this.activeSubagents.size === 0) {
          this.pushRow({ kind: 'system', text: '当前没有活动的子代理。' })
        } else {
          const lines = [...this.activeSubagents.entries()].map(([runId, sub]) =>
            `▶ ${sub.id}（${sub.provider}）运行 ${Math.floor((Date.now() - sub.startedAt) / 1000)}s  [${runId.slice(0, 8)}]`,
          )
          this.pushRow({ kind: 'system', text: lines.join('\n') })
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
          (answer) => this.pushRow({ kind: 'system', text: `dialog answer: ${JSON.stringify(answer)}` }),
          (error) => this.pushRow({ kind: 'error', text: `dialog error: ${errorChain(error)}` }),
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
          const controller = new AbortController()
          void commands.execute(this.agent, text, controller.signal).then((execution) => {
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
          })
        }
        break
    }
    this.input = ''
    this.cursor = 0
    this.markDirty()
  }

  private backspace(): void {
    if (this.cursor === 0) return
    this.input = `${this.input.slice(0, this.cursor - 1)}${this.input.slice(this.cursor)}`
    this.cursor -= 1
    this.markDirty()
  }

  private deleteAtCursor(): void {
    if (this.cursor >= this.input.length) return
    this.input = `${this.input.slice(0, this.cursor)}${this.input.slice(this.cursor + 1)}`
    this.markDirty()
  }

  private moveCursor(delta: number): void {
    this.cursor = Math.max(0, Math.min(this.input.length, this.cursor + delta))
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
