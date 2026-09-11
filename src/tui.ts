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
 *
 * Pure helpers live next to this file (`term-text`, `paint`, `footer`,
 * `quota`, `plan`, `tool-present`) and are re-exported here so existing
 * `lib/tui.js` imports keep working. The launch picker imports `paint` /
 * `term-text` directly and does not load this module.
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
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, errorChain, ReasoningEffortId, type GenerateOptions, type LlmCallConfig, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  commandAcceptsAttachments,
  forEachSessionEvent,
  forEachSessionEventAsync,
  isAssistantStreamEvent,
  isTokenDeltaChunk,
  listenHostEvent,
  REPLAY_YIELD_EVERY,
  sessionEventType,
  sessionEvents,
  settingsNamespace,
  streamChunkOf,
  streamFirstTokenTime,
  streamFrameAttemptId,
  streamFrameOwner,
  type StreamChunkLike,
} from './dsh-compat.js'
import { classifyApprovalDetailed, commandForApprovalRequest, isApprovalStatusArg, parseAutoApprovalMode, type AutoApprovalMode } from './auto-approval.js'
import { buildReviewUserMessage, parseReviewOutput, reviewSystemPrompt, type ReviewVerdict } from './approval-reviewer.js'
import { loadProviderCatalog, mergeProviderEntries, type CatalogPreset, type ProviderListEntry } from './provider-catalog.js'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'

import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { formatFooterCwd, formatSessionTime, listResumableSessions } from './session-list.js'
import { collectDiag, formatDiag } from './diag.js'
import { SessionStatsTracker, statsRowOf, type SessionStatsSnapshot } from './stats.js'
import {
  QUESTION_OPTION_KEYS,
  confirmAnswer,
  inspectClosesOn,
  moveQuestionCursor,
  optionsLength,
  questionSubmit,
  selectQuestionOptionByKey,
  type ConfirmDialog,
  type Dialog,
  type DialogAnswer,
  type QuestionDialog,
} from './dialogs.js'
import { commandSuggestions, localizedCommands, type CommandSuggestion } from './commands.js'
import {
  archiveStalePlans,
  boundTranscriptRows,
  findLivePlanRow,
  findMergeableToolRow,
  findToolRowByCallId,
  mergeToolCard,
  planShouldDefaultExpand,
  windowTranscript,
} from './rows.js'
import { detachFromSshSession, DisplayHost, isTuiHostProcess, resolveDshHome, sessionSockPath } from './display-sock.js'
import {
  applySavedLocale,
  getLocale,
  localeDisplayName,
  localeFromTag,
  setLocale,
  t,
  UI_LOCALE_NAMESPACE,
  type Locale,
} from './i18n/index.js'
import { defaultReasoningEffort } from './reasoning.js'
import { checkForPluginUpdate, installPluginLatest } from './update-check.js'
import {
  ROUTE_MEMORY_NAMESPACE,
  parseRouteMemory,
  rememberedRouteFor,
  upsertRememberedRoute,
  type RememberedRoute,
} from './route-memory.js'
import { AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-agent-default-model'
import {
  DEFAULT_SUBAGENT_MODEL,
  SUBAGENT_SETTINGS_NAMESPACE,
  defaultSubagentModelForProvider,
  subagentModelMatchesProvider,
  subagentSettingsValue,
  type SubagentSelection,
  type SubagentSelectionRef,
} from './subagent-model.js'
import { resolveFreshSuperGrokToken } from './supergrok-token.js'
import { copyTextFromTranscript } from './copy-text.js'

import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'

import type {
  CollapsibleBlock,
  DisplayKind,
  DisconnectPolicyName,
  PlanTodoItem,
  Row,
  SubagentLogEntry,
  ToolDiffHunk,
} from './transcript-types.js'
import {
  clipAnsiToWidth,
  hrefAtColumn,
  osc52Clipboard,
  paintedLinkHits,
  cursorVisualPosition,
  displayWidth,
  foldInputView,
  fmtElapsedCompact,
  lastCodePoints,
  padToWidth,
  sliceCodePoints,
  paintSegmentedLine,
  renderMarkdownLines,
  repeatToWidth,
  sanitizeTerminalText,
  shimmerText,
  truncate,
  truncateToWidth,
  waitCardCopy,
  wrap,
  wrapSegmented,
  wrapWaitDetails,
  type InputView,
  type TextSegment,
} from './term-text.js'
import {
  captureHangupSignals,
  composePaintOutput,
  detectSshSession,
  formatLinkQualityChip,
  HANGUP_CANCEL_TIMEOUT_MS,
  ignoreFurtherHangupSignals,
  isEscapePrefix,
  isHangupErrno,
  parseCursorPositionReply,
  PICKER_WINDOW,
  pickerWindowStart,
  probeTerminalRttMs,
  releaseHangupSignals,
  resolvePaintIntervalMs,
  waitUntilIdleOrTimeout,
  type PaintLinkKind,
} from './paint.js'
import { TerminalInputGuard } from './terminal-input.js'
import {
  contextPressureAlertText,
  contextPressureRingColor,
  contextPressureView,
  formatContextPressureRing,
  describeProviderRoute,
  fitFooterStatsLine,
  fitFooterStatusLine,
  footerActivity,
  footerIdentityParts,
  footerStatsGroups,
  formatContextPressureChip,
  formatStatusReport,
  formatTokens,
  parseContextPressure,
  promptPressureTokens,
  providerUsesLocalOAuth,
  shouldIdleAutoCompact,
  type ContextPressureView,
  type FooterStatsInput,
  type FooterStatusInput,
} from './footer.js'
import {
  crossedQuotaThresholds,
  DEEPSEEK_PUBLIC_BASE_URL,
  formatAccountBalance,
  formatFooterBalance,
  formatQuotaSnapshot,
  joinUrl,
  OPENAI_COMPAT_BALANCE_PATHS,
  OPENCODE_GO_USAGE_URL,
  OPENCODE_ZEN_BASE_URL,
  openCodeApiErrorMessage,
  openCodeSourceFor,
  parseDeepSeekBalance,
  parseOpenAiCompatibleBalance,
  parseOpenCodeGoQuota,
  parseSuperGrokBilling,
  quotaAlertText,
  quotaRefreshEverySteps,
  reasoningEffortsForDefault,
  SUPERGROK_BILLING_URL,
  tightestQuotaWindow,
  type AccountBalanceSnapshot,
  type LlmPiAiProviderProfile,
  type LlmPiAiSection,
  type OpenCodeSource,
  type QuotaSnapshot,
  type QuotaWindow,
} from './quota.js'
import {
  appendSubagentLog,
  applyTurnEndToPlan,
  cardCategoryLabel,
  cardCategoryOf,
  compactionHeaderText,
  formatCompactCommandError,
  isPromptInjectionMessage,
  matchTranscriptRows,
  parseFindQuery,
  parsePlanTodos,
  planCloseNudgeText,
  planMarkdownFromArgs,
  planDockNote,
  planIsLive,
  planTitleFromMarkdown,
  promptInjectionSources,
  promptInjectionTitle,
  subagentHeaderText,
  todoItemKind,
  todoProgressLabel,
  TODO_STATUS_MARK,
  type CardCategory,
} from './plan.js'
import {
  buildToolHeader,
  canMergeToolCall,
  compactEditPath,
  compactToolBursts,
  compactToolGroups,
  countDiffAddDel,
  countDiffLines,
  countOutputLines,
  diffMetaDiffs,
  diffStatToken,
  formatModelList,
  HIDDEN_TOOL_NAMES,
  parseExitStatus,
  planReviewOf,
  presentToolCall,
  type DiffDisplayLine,
  READ_TOOL_NAMES,
  SHELL_TOOL_NAMES,
  toolBodyFitsWorkspace,
  toolBodyLines,
  toolTitle,
  TOOL_FLIP_MS,
  wrappedToolBodyLineCount,
} from './tool-present.js'

export type {
  CollapsibleBlock,
  DisplayKind,
  DisconnectPolicyName,
  PlanTodoItem,
  Row,
  SubagentLogEntry,
  ToolDiffHunk,
} from './transcript-types.js'
export {
  clipAnsiToWidth,
  cursorVisualPosition,
  displayWidth,
  foldInputView,
  hrefAtColumn,
  osc52Clipboard,
  osc8Enabled,
  paintedLinkHits,
  fmtElapsedCompact,
  padAnsiToWidth,
  padToWidth,
  renderMarkdownLines,
  repeatToWidth,
  shimmerText,
  truncateToWidth,
  visibleWidth,
  waitCardCopy,
  waitSummaryFromReasoning,
  wrapWaitDetails,
} from './term-text.js'
export {
  captureHangupSignals,
  composePaintOutput,
  detectSshSession,
  formatLinkQualityChip,
  ignoreFurtherHangupSignals,
  isEscapePrefix,
  findCursorPositionReply,
  isHangupErrno,
  linkQualityOf,
  linkSignalPips,
  paintIntervalForRtt,
  paintLinkLabel,
  parseCursorPositionReply,
  pickerWindowStart,
  probeTerminalRttMs,
  releaseHangupSignals,
  resolvePaintIntervalMs,
  waitUntilIdleOrTimeout,
  writeBootSplash,
  type LinkQuality,
  type PaintLinkKind,
} from './paint.js'
export {
  CONTEXT_IDLE_COMPACT_RATIO,
  CONTEXT_PRESSURE_DANGER_RATIO,
  CONTEXT_PRESSURE_WARN_RATIO,
  CONTEXT_RING_EMPTY,
  CONTEXT_RING_SEGMENTS,
  contextPressureAlertText,
  contextPressureRingColor,
  contextPressureUsedTokens,
  contextPressureView,
  describeProviderRoute,
  dropFooterQuotaPlanName,
  fitFooterStatsLine,
  fitFooterStatusLine,
  footerActivity,
  footerIdentityParts,
  footerStatsGroups,
  formatContextPressureChip,
  formatContextPressureRing,
  formatContextPressureStatusLine,
  formatDuration,
  formatFooterQuota,
  formatQuotaBar,
  formatStatusReport,
  formatTokens,
  formatTokensPerSecond,
  parseContextPressure,
  promptPressureTokens,
  providerShortCode,
  providerUsesLocalOAuth,
  shouldIdleAutoCompact,
  subagentRouteLabel,
  type ContextPressureSample,
  type ContextPressureView,
  type FooterActivityKind,
  type FooterStatsInput,
  type FooterStatusInput,
  type StatusReportInput,
} from './footer.js'
export {
  crossedQuotaThresholds,
  formatAccountBalance,
  formatFooterBalance,
  formatOpenCodeGoUsage,
  formatQuotaSnapshot,
  formatQuotaStatusLine,
  joinUrl,
  openCodeSourceFor,
  parseDeepSeekBalance,
  parseOpenAiCompatibleBalance,
  parseOpenCodeGoQuota,
  parseSuperGrokBilling,
  quotaAlertText,
  quotaRefreshEverySteps,
  quotaRefreshEveryTurns,
  remainingPercentFromUsed,
  tightestQuotaWindow,
  type AccountBalanceLine,
  type AccountBalanceSnapshot,
  type OpenCodeFlavor,
  type OpenCodeSource,
  type QuotaPeriod,
  type QuotaSnapshot,
  type QuotaWindow,
} from './quota.js'
export {
  commandAcceptsAttachments,
  forEachSessionEvent,
  isAssistantStreamEvent,
  isTokenDeltaChunk,
  listPersistenceHeaders,
  inspectPersistenceSession,
  sessionEventType,
  sessionEvents,
  settingsNamespace,
  streamChunkOf,
  streamFirstTokenTime,
  streamFrameAttemptId,
  streamFrameOwner,
} from './dsh-compat.js'
export {
  applyTurnEndToPlan,
  askSummary,
  cardCategoryOf,
  compactionHeaderText,
  formatCompactCommandError,
  isPromptInjectionMessage,
  matchTranscriptRows,
  parseFindQuery,
  parsePlanTodos,
  planCloseNudgeText,
  planDockNote,
  planIsLive,
  planTitleFromMarkdown,
  planTurnLeftOpen,
  promptInjectionSources,
  promptInjectionTitle,
  subagentHeaderText,
  todoProgressLabel,
  todoSummary,
  type CardCategory,
} from './plan.js'
export {
  buildToolHeader,
  canMergeToolCall,
  compactEditPath,
  compactToolBursts,
  compactToolGroups,
  countDiffAddDel,
  countDiffLines,
  countOutputLines,
  diffMetaDiffs,
  diffStatToken,
  friendlyJsonLines,
  parseExitStatus,
  presentToolCall,
  READ_TOOL_NAMES,
  renderToolDiff,
  toolBodyFitsWorkspace,
  toolBodyLines,
  toolStateColor,
  toolStateLabel,
  wrappedToolBodyLineCount,
} from './tool-present.js'

/** Discover models in a way that works on both 0.1.1-rc.2 and 0.1.2-rc.1.
 *  0.1.1 reads `request.signal`; 0.1.2 reads the third argument and dropped
 *  `signal` from the request type. Passing both keeps cancellation on either. */
type ModelDiscoveryHost = {
  discoverModels(
    settingsNs: ReturnType<typeof settingsNamespace>,
    request: {
      baseURL?: string
      api?: string
      apiKey?: string
      provider?: string
      signal?: AbortSignal
    },
    signal?: AbortSignal,
  ): Promise<Array<{ id: string; name?: string }>>
}

function discoverProviderModels(
  llm: ModelDiscoveryHost,
  request: { provider?: string; baseURL?: string; api?: string; apiKey?: string },
  signal: AbortSignal,
): Promise<Array<{ id: string; name?: string }>> {
  return llm.discoverModels(settingsNamespace('llm-pi-ai'), { ...request, signal }, signal)
}

/** 0.1.1 registers a provider object; 0.1.2 answers through the waterfall. */
type UserQuestionAnswerer = {
  registerProvider?(provider: { ask: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer> }): () => void
}

/**
 * 0.1.2's `'user-questions/request'` is not in 0.1.1-rc.2's `Events`.
 * Name the listener here so `tsc` against either package can emit the runtime
 * fallback; the `registerProvider` branch still wins on 0.1.1.
 */
type UserQuestionWaterfallHost = {
  on(
    event: 'user-questions/request',
    listener: (
      request: AskUserQuestionRequest,
      next: () => Promise<AskUserQuestionAnswer>,
    ) => Promise<AskUserQuestionAnswer>,
  ): () => void
}

function installUserQuestionAnswerer(
  ctx: Context,
  questions: object,
  ask: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>,
): () => void {
  const provider = questions as UserQuestionAnswerer
  if (typeof provider.registerProvider === 'function') {
    return provider.registerProvider({ ask })
  }
  return (ctx as UserQuestionWaterfallHost).on('user-questions/request', async (request, next) => {
    try {
      return await ask(request)
    } catch (error: unknown) {
      if (error instanceof UserQuestionError && error.code === 'ASK_ABORTED') throw error
      return await next()
    }
  })
}

const ROUTE_MEMORY_NS = ROUTE_MEMORY_NAMESPACE


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
  /** One-line notice after entering a resumed session's working directory. */
  cwdNotice?: string
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
  /** Called after hangup when the Host is kept (busy) so the launcher can update the lock. */
  onHangup?: () => void | Promise<void>
  /** Called when a Display relay attaches after hangup. */
  onReattach?: () => void | Promise<void>
  /** Host process: no local TTY; paint only through the display socket. */
  headlessDisplay?: boolean
  /** Hangup policy while busy: pause cancels the turn; continue lets it finish detached. Idle hangup always exits. */
  disconnectPolicy?: DisconnectPolicyName
}

/** Whole-log session figures for the stats line below the input box. */
type OnboardingProviderType =
  | 'official'
  | 'opencode-go'
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'catalog'

interface ProviderTemplate {
  label: string
  defaultId: string
  defaultBaseUrl: string
  api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  defaultModels: string[]
}

function providerTemplates(): Record<Exclude<OnboardingProviderType, 'catalog'>, ProviderTemplate> {
  return {
  official: {
    label: t('route.deepseek'),
    defaultId: 'deepseek-official',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModels: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  'opencode-go': {
    label: t('onboard.providerGo'),
    defaultId: 'opencode-go',
    defaultBaseUrl: 'https://opencode.ai/zen/go/v1',
    api: 'openai-responses',
    defaultModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  'openai-completions': {
    label: t('onboard.providerCompletions'),
    defaultId: 'my-gateway',
    defaultBaseUrl: '',
    api: 'openai-completions',
    defaultModels: ['deepseek-v4-flash'],
  },
  'openai-responses': {
    label: t('onboard.providerResponses'),
    defaultId: 'my-responses',
    defaultBaseUrl: '',
    api: 'openai-responses',
    defaultModels: ['deepseek-v4-flash'],
  },
  'anthropic-messages': {
    label: t('onboard.providerAnthropic'),
    defaultId: 'my-anthropic',
    defaultBaseUrl: '',
    api: 'anthropic-messages',
    defaultModels: ['deepseek-v4-flash'],
  },
  }
}

/**
 * The template the wizard's current step works against: the five pinned
 * shapes, or the web-catalog preset chosen through option 6.
 */
function onboardTemplate(state: OnboardingState): ProviderTemplate {
  if (state.providerType === 'catalog') {
    return {
      label: state.catalog?.name ?? state.catalog?.id ?? '',
      defaultId: state.catalog?.id ?? '',
      defaultBaseUrl: '',
      defaultModels: state.catalog?.modelIds ?? [],
    }
  }
  return providerTemplates()[state.providerType]
}

interface OnboardingState {
  step: 'provider' | 'id' | 'base-url' | 'key' | 'models' | 'confirm'
  providerType: OnboardingProviderType
  providerId: string
  baseUrl: string
  key: string
  models: string[]
  /** Web-aligned catalog presets; undefined while loading or when the host's
   *  pi-ai catalog is unreachable (option 6 stays hidden). */
  catalogPresets: CatalogPreset[] | undefined
  /** The catalog preset this run configures (providerType 'catalog'). */
  catalog: CatalogPreset | undefined
  /** Cursor into the merged provider list of the first step. */
  providerCursor: number
  /** True while the wizard's async save is in flight; input is ignored. */
  saving: boolean
  resolve(saved: boolean): void
}

/** Result of one dialog interaction. */
/** Lifecycle handle for a mounted interactive terminal channel. */
export interface TuiController {
  dispose(): Promise<void>
  handleHangup(): Promise<void>
  disconnectPolicy(): DisconnectPolicyName
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
const DEFAULT_DETACHED_IDLE_MS = 6 * 60 * 60 * 1000
/**
 * How long a leftover Host that has finished its work waits, with no display,
 * for the user to come back before it exits on its own.
 *
 * The Host holds the session's kernel write lock (`session.lock`) for its whole
 * life, and that lock is exactly what makes the browser surface answer
 * `resume failed for session "…"` (the persistence layer refuses a second
 * writer). A Host kept alive by a busy SSH drop therefore used to block the same
 * session in the Web UI for the full {@link DEFAULT_DETACHED_IDLE_MS} (six
 * hours), long after the turn it stayed behind for had already finished: the
 * session looked unreachable from both surfaces while an idle process held it.
 * A minute is enough to notice the drop and reattach; after that the turn has
 * long been flushed, so `--resume` reopens the same log in a fresh Host.
 *
 * `DSH_TUI_IDLE_EXIT_MS` (or `ssh-tui.idleExit` in settings.yaml) overrides it;
 * `0`/`off` restores the legacy "wait for the six-hour timer" behavior.
 */
const DEFAULT_IDLE_EXIT_MS = 60 * 1000
const CTRL_C_EXIT_WINDOW_MS = 2000
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SUBAGENT_DEFAULT_EFFORT_LABEL = (): string => t('footer.effortDefault')
const RESERVED_BOTTOM_LINES = 3 // input line + stats line + status line
const IS_WINDOWS = process.platform === 'win32'

function dshHomeDir(): string {
  return resolveDshHome()
}

/**
 * Version of the host packages this process booted from, for `/diag`. Resolved
 * from the running plugin's own tree, so it reports what is actually loaded
 * rather than what is installed elsewhere.
 */
function hostDshVersion(): string {
  for (const id of ['@deepseek-ai/dsh-agent/package.json', '@deepseek-ai/dsh/package.json']) {
    try {
      const parsed = createRequire(import.meta.url)(id) as { version?: unknown }
      if (typeof parsed.version === 'string') return parsed.version
    } catch {
      // try the next candidate
    }
  }
  return 'unknown'
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

export type WorkspaceView = 'detailed' | 'compact'

export function parseDisconnectPolicy(raw: string): DisconnectPolicyName | undefined {
  const id = raw.trim().toLowerCase()
  if (id === 'pause' || id === 'cancel' || id === '暂停') return 'pause'
  if (id === 'continue' || id === 'keep' || id === '继续') return 'continue'
  return undefined
}

const UNDECLARED_EFFORT_IDS = ['off', 'low', 'medium', 'high', 'max', 'xhigh'] as const
const DEFAULT_EFFORT_ALIASES = new Set(['default', 'none', 'auto', 'reset', '默认'])

function effortChoices(ids: readonly string[]): { id: string; label: string }[] {
  return ids.map(id => ({ id, label: t(`effort.option.${id}`) }))
}

function undeclaredEffortChoices(): { id: string; label: string }[] {
  return effortChoices(UNDECLARED_EFFORT_IDS)
}

function localOAuthEffortChoices(modelId: string): { id: string; label: string }[] {
  return effortChoices(modelId === 'grok-4.6'
    ? ['off', 'low', 'medium', 'high', 'xhigh']
    : ['off', 'low', 'medium', 'high'])
}

/** Parse `/effort high` / `/subeffort default`. Empty or unknown → undefined. */
export function parseEffortArg(raw: string): { kind: 'default' } | { kind: 'id'; id: string } | undefined {
  const id = raw.trim().toLowerCase()
  if (id === '') return undefined
  if (DEFAULT_EFFORT_ALIASES.has(id)) return { kind: 'default' }
  if (/^[a-z][a-z0-9_-]{0,31}$/u.test(id)) return { kind: 'id', id }
  return undefined
}

export function parseWorkspaceView(raw: string): WorkspaceView | undefined {
  const id = raw.trim().toLowerCase()
  if (id === 'detailed' || id === 'detail' || id === 'full' || id === '详细') return 'detailed'
  if (id === 'compact' || id === 'minimal' || id === 'min' || id === '极简') return 'compact'
  return undefined
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Owns one interactive terminal channel and its agent event wiring. */
export class SshTui {
  private readonly rows: Row[] = []
  private streaming: { text: string; reasoning: string } | undefined
  private autoApprovalMode: AutoApprovalMode = 'off'
  private autoAllowedCount = 0
  private autoDeniedCount = 0
  private aiReviewCount = 0
  /** Host knobs folded from the session log: auto mode needs approval=ask to see requests. */
  private hostSandboxMode: string | undefined
  private hostApprovalPolicy: string | undefined
  private approvalMismatchWarned = false
  /** Web-aligned provider presets from the host's pi-ai catalog (undefined until loaded / when unreachable). */
  private catalogPresets: CatalogPreset[] | undefined
  private catalogLoad: Promise<CatalogPreset[] | undefined> | undefined
  private input = ''
  private cursor = 0
  private inputFolded = false
  private inPaste = false
  private history: string[] = []
  private historyIndex = -1
  /** Live input parked while browsing history with ↑. Restored by ↓ past the newest item. */
  private historyDraft = ''
  private status = 'idle'
  private dialog: Dialog | undefined
  private readonly dialogQueue: Dialog[] = []
  private onboardingCompletion: Promise<boolean> | undefined
  private dirty = true
  private disposed = false
  private exiting = false
  private hangingUp = false
  private readonly onDirectResize = (): void => {
    this.forceFullPaint = true
    this.dirty = true
    this.paint()
  }
  private readonly headlessDisplay: boolean
  private disconnectPolicy: DisconnectPolicyName
  private detachedIdleTimer: ReturnType<typeof setTimeout> | undefined
  /** Armed once an SSH drop left this Host alive with work still running. */
  private hostKeptAlive = false
  private idleExitTimer: ReturnType<typeof setTimeout> | undefined
  private displayDetached = false
  private displayHost: DisplayHost | undefined
  private relayColumns: number | undefined
  private relayRows: number | undefined
  private readonly onHangup: (() => void | Promise<void>) | undefined
  private readonly onReattach: (() => void | Promise<void>) | undefined
  private renderTimer: ReturnType<typeof setInterval> | undefined
  private readonly decoder = new StringDecoder('utf8')
  private readonly color: boolean
  private readonly maxToolOutputLines: number
  private readonly showReasoning: boolean
  private workspaceView: WorkspaceView = 'detailed'
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
  private presetName = t('mode.standard')
  private readonly useAlternateScreen: boolean
  private agentGone = false
  private onboarding: OnboardingState | undefined
  private commandSuggestions: { name: string; description: string; local: boolean }[] = []
  private suggestionIndex = 0
  private focusedRow: CollapsibleBlock | null = null
  private pendingMessages = new Map<string, string>()
  private lastActivity = Date.now()
  private lastIdleCtrlCAt = 0
  private stalledWarningShown = false
  private lastPaintAt = 0
  private commandAbort: AbortController | undefined
  private readonly seenCommandDoneIds = new Set<string>()
  private activeSubagents = new Map<string, { id: string; provider: string; startedAt: number }>()
  private subagentSessions = new Set<string>()
  private openToolCalls = new Map<string, string>()
  /** Survives result settlement so a card-less result can still be labelled. */
  private toolCallNames = new Map<string, string>()
  /** Session totals; the tracker owns the arithmetic (see `stats.ts`). */
  private readonly statsTracker = new SessionStatsTracker()
  /** Snapshot of the session totals, for the footer and `/status`. */
  private get stats(): SessionStatsSnapshot {
    return this.statsTracker.snapshot()
  }
  /** Attempt whose live `start` frame opened the current token stream. */
  private liveStreamOwner: { attemptId: unknown; turn: number; step: number } | undefined
  /** Live events parked while the (yielding) history replay holds the floor. */
  private replayQueue: Array<{ session: { id: SessionId }; event: SessionEvent }> | undefined
  /** A relay claimed the display while a hangup was still cancelling/flushing. */
  private reattachedDuringHangup = false
  private scrollOffset = 0
  private readonly clickableRows = new Map<number, CollapsibleBlock>()
  private readonly paintedLinkHitsByRow = new Map<number, ReturnType<typeof paintedLinkHits>>()
  private copyYank = ''
  /** Last OSC-52 payload (tests; empty when nothing has been copied). */
  get lastCopiedText(): string {
    return this.copyYank
  }
  /** Screen-row → OSC 8 hits from the last paint (tests). */
  get linkHitsByRow(): Map<number, ReturnType<typeof paintedLinkHits>> {
    return this.paintedLinkHitsByRow
  }
  private streamingReasoning: { kind: 'streaming-reasoning'; expanded: boolean } | undefined
  private escapeBuffer = ''
  private escapeTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Cursor-position replies removed from the relay's stdin stream. A launcher
   * from an older release (or a reply that raced its own probe) would otherwise
   * type `[17;1R` into the prompt or cancel a dialog with a bare ESC.
   */
  private readonly inputGuard = new TerminalInputGuard(text => this.handleInputText(text))
  private thinkingStartedAt: number | undefined
  private waitStartedAt: number | undefined
  private completionSignaled = false
  private replaying = false
  /** Display-line budget for the first paint after resume; 0 = full transcript. */
  private paintTailBudget = 0
  private completedAt = 0
  private lastTitleUpdateAt = 0
  private lastPaintRows: string[] = []
  private lastPaintCursorColumn = 1
  private lastPaintCursorRow = 1
  private lastChromeKey = ''
  private lastPaintWidth = 0
  private lastPaintHeight = 0
  private lastChromeStart = 0
  private lastTranscriptStart = -1
  /** 1-based screen row of the footer `目录:` chip, when painted. */
  private cwdChipRow: number | undefined
  /** Set when a card expand/collapse moves chrome; next paint full-redraws. */
  private forceFullPaint = false
  private paintIntervalMs: number
  private paintLink: PaintLinkKind = 'local'
  private paintProbed = false
  private paintRttMs: number | undefined
  private sessionTitle = ''
  private llmRetry: { retry: number; maxRetries: number; delayMs: number; message: string } | undefined
  private quotaSnapshot: QuotaSnapshot | undefined
  private balanceSnapshot: AccountBalanceSnapshot | undefined
  private quotaAlerted = new Set<string>()
  private quotaStepsSinceRefresh = 0
  private quotaRefreshInFlight = false
  private contextPressure: ContextPressureView | undefined
  private contextAlertLevel: ContextPressureView['level'] | undefined
  private idleCompactInFlight = false
  private lastIdleCompactAt = 0
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
    this.workspaceView = this.readWorkspaceView()
    this.autoApprovalMode = this.readAutoApprovalMode()
    this.goodbye = config.goodbye
      ?? this.ctx.get('tuiGoodbyeMessage') as string | undefined
      ?? `To resume this session: dsh --profile tui --resume=${this.agent.id}`
    this.resume = config.resume === true
    this.providerName = config.provider ?? 'deepseek-official'
    this.selectionRef = config.selectionRef
    this.subagentSelection = config.subagentSelection ?? { current: { model: DEFAULT_SUBAGENT_MODEL } }
    this.onSwitchSession = config.onSwitchSession
    this.onSelectionChanged = config.onSelectionChanged
    this.onHangup = config.onHangup
    this.onReattach = config.onReattach
    this.headlessDisplay = config.headlessDisplay === true
    this.disconnectPolicy = config.disconnectPolicy ?? this.readDisconnectPolicy()
    this.resumePicker = config.resumePicker === true
    this.presetId = config.presetId ?? 'standard'
    this.presetName = config.presetName ?? this.presetId
    this.useAlternateScreen = process.env.DSH_TUI_NO_ALT_SCREEN !== '1' && process.env.DSH_TUI_NO_ALT_SCREEN !== 'true'
    this.paintLink = detectSshSession() ? 'ssh' : 'local'
    this.paintIntervalMs = resolvePaintIntervalMs(config.paintIntervalMs, process.env, {
      ssh: this.paintLink === 'ssh',
    })
    this.pushRow({ kind: 'brand-logo' })
    this.pushRow({ kind: 'system', text: t('boot.banner') })
    this.pushRow({ kind: 'system', text: t('boot.help') })
    if (config.cwdNotice !== undefined && config.cwdNotice !== '') {
      this.pushRow({ kind: /进入|Entered/u.test(config.cwdNotice) ? 'system' : 'error', text: config.cwdNotice })
    }
  }

  /** Enter raw mode, switch to the alternate screen, and start listening. */
  start(): void {
    detachFromSshSession()
    captureHangupSignals(this.handleHangupSignal)
    this.bindAgentEvents()
    void this.ensureDisplayHost().catch((error: unknown) => {
      if (this.disposed) return
      this.pushRow({ kind: 'error', text: t('boot.displayFailed', { error: errorChain(error) }) })
      this.markDirty()
    })
    if (this.headlessDisplay) {
      this.displayDetached = true
      this.startRenderTimer()
      this.bootBackgroundTasks()
      return
    }
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdout.on('resize', this.onDirectResize)
    if (process.platform !== 'win32') {
      process.on('SIGWINCH', this.onDirectResize)
    }
    process.stdin.prependListener('end', this.handleHangupStream)
    process.stdin.prependListener('close', this.handleHangupStream)
    process.stdout.on('error', this.handleIoError)
    process.stdin.on('error', this.handleIoError)

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
    this.bootBackgroundTasks()
  }

  private bindAgentEvents(): void {
    this.disposers.push(
      this.ctx.on('session/event', this.handleSessionEvent),
      listenHostEvent(this.ctx, 'agent/assistant-stream', this.handleAssistantStream),
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
      this.userQuestionDisposer = installUserQuestionAnswerer(this.ctx, questions, this.handleUserQuestions)
    }
  }

  private bootBackgroundTasks(): void {
    // Warm the web-aligned provider catalog so /setup has it ready instantly
    // (runs on both the interactive and the detached-display path).
    this.catalogLoad = loadProviderCatalog([process.argv[1], (this.ctx as { baseUrl?: string }).baseUrl])
    this.catalogLoad.then(presets => {
      this.catalogPresets = presets
      this.markDirty()
    }).catch(() => {})
    void this.maybeRunOnboarding().catch((error: unknown) => {
      if (this.disposed) return
      this.pushRow({ kind: 'error', text: t('onboard.checkFailed', { error: errorChain(error) }) })
      this.markDirty()
    })
    void this.syncSubagentToProvider(this.currentProviderId()).catch((error: unknown) => {
      if (this.disposed) return
      this.pushRow({ kind: 'error', text: t('onboard.syncSubFailed', { error: errorChain(error) }) })
      this.markDirty()
    })
    void this.refreshQuota({ reason: 'start', announce: false }).catch(() => {
      // Start-up quota is silent; /usage and threshold alerts still report.
    })
    void this.notifyPluginUpdate().catch(() => {
      // Update check is best-effort and never blocks the TUI.
    })
  }

  private async notifyPluginUpdate(): Promise<void> {
    const info = await checkForPluginUpdate(PLUGIN_VERSION)
    if (this.disposed || info === undefined) return
    const skipped = this.readSkippedUpdate()
    if (skipped !== undefined && skipped === info.latest) return
    try {
      const answer = await this.askQuestion({
        id: 'plugin-update',
        question: t('update.pick', { latest: info.latest, current: info.current }),
        options: [
          { label: t('update.now'), description: t('update.nowDesc', { command: info.command }) },
          { label: t('update.later'), description: t('update.laterDesc') },
          { label: t('update.skip'), description: t('update.skipDesc', { latest: info.latest }) },
        ],
      }, 0, 1, 0)
      if (this.disposed) return
      const picked = answer.selected[0]
      if (picked === t('update.skip')) {
        await this.persistSkippedUpdate(info.latest)
        this.pushRow({ kind: 'system', text: t('update.skipDesc', { latest: info.latest }) })
        this.markDirty()
        return
      }
      if (picked !== t('update.now')) return
      this.pushRow({ kind: 'system', text: t('update.installing', { latest: info.latest }) })
      this.markDirty()
      const result = await installPluginLatest(info.profile)
      if (this.disposed) return
      if (result.ok) {
        this.pushRow({ kind: 'system', text: t('update.installed', { latest: info.latest, profile: info.profile }) })
      } else {
        this.pushRow({ kind: 'error', text: t('update.failed', { error: result.output === '' ? info.command : result.output }) })
        this.pushRow({ kind: 'system', text: t('update.manual', { command: info.command }) })
      }
      this.markDirty()
    } catch {
      if (this.disposed) return
      this.pushRow({ kind: 'system', text: info.notice })
      this.markDirty()
    }
  }

  private readSkippedUpdate(): string | undefined {
    const raw = this.ctx.get('settings')?.get(UI_LOCALE_NAMESPACE)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const skip = (raw as { skipUpdate?: unknown }).skipUpdate
    return typeof skip === 'string' && skip.trim() !== '' ? skip.trim() : undefined
  }

  private async persistSkippedUpdate(latest: string): Promise<void> {
    await this.mergeUiSettings({ skipUpdate: latest })
  }

  private async mergeUiSettings(patch: {
    language?: string
    skipUpdate?: string
    view?: string
    disconnect?: DisconnectPolicyName
    autoApproval?: AutoApprovalMode
  }): Promise<void> {
    const settings = this.ctx.get('settings')
    if (settings === undefined) return
    const raw = settings.get(UI_LOCALE_NAMESPACE)
    const previous = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as { language?: string; skipUpdate?: string; view?: string; disconnect?: string; autoApproval?: string }
      : {}
    await settings.replace(UI_LOCALE_NAMESPACE, { ...previous, ...patch })
  }

  private readWorkspaceView(): WorkspaceView {
    const raw = this.ctx.get('settings')?.get(UI_LOCALE_NAMESPACE)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'detailed'
    return parseWorkspaceView(String((raw as { view?: unknown }).view ?? '')) ?? 'detailed'
  }

  private readDisconnectPolicy(): DisconnectPolicyName {
    const env = parseDisconnectPolicy(process.env.DSH_TUI_DISCONNECT ?? '')
    if (env !== undefined) return env
    const raw = this.ctx.get('settings')?.get(UI_LOCALE_NAMESPACE)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'pause'
    return parseDisconnectPolicy(String((raw as { disconnect?: unknown }).disconnect ?? '')) ?? 'pause'
  }

  private readAutoApprovalMode(): AutoApprovalMode {
    const env = parseAutoApprovalMode(process.env.DSH_TUI_AUTO_APPROVAL ?? '')
    if (env !== undefined) return env
    const raw = this.ctx.get('settings')?.get(UI_LOCALE_NAMESPACE)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'off'
    return parseAutoApprovalMode(String((raw as { autoApproval?: unknown }).autoApproval ?? '')) ?? 'off'
  }

  private detachedIdleMs(): number {
    const raw = Number.parseInt(process.env.DSH_TUI_DETACHED_IDLE_MS ?? '', 10)
    if (Number.isFinite(raw) && raw > 0) return raw
    return DEFAULT_DETACHED_IDLE_MS
  }

  private clearDetachedIdleTimer(): void {
    if (this.detachedIdleTimer !== undefined) clearTimeout(this.detachedIdleTimer)
    this.detachedIdleTimer = undefined
  }

  private armDetachedIdleTimer(): void {
    this.clearDetachedIdleTimer()
    const idleMs = this.detachedIdleMs()
    this.detachedIdleTimer = setTimeout(() => {
      if (this.disposed || this.exiting) return
      if (this.displayHost?.attached === true) return
      if (this.agent.status === 'running') {
        this.armDetachedIdleTimer()
        return
      }
      void this.requestExit(0)
    }, idleMs)
    this.detachedIdleTimer.unref?.()
  }

  /**
   * How long a leftover, finished Host may sit with no display before it exits
   * and hands the session back. `0` disables the exit (legacy behavior).
   */
  private idleExitMs(): number {
    const raw = Number.parseInt(process.env.DSH_TUI_IDLE_EXIT_MS ?? '', 10)
    if (Number.isFinite(raw) && raw >= 0) return raw
    const saved = this.ctx.get('settings')?.get(UI_LOCALE_NAMESPACE)
    if (saved !== null && typeof saved === 'object' && !Array.isArray(saved)) {
      const value = (saved as { idleExit?: unknown }).idleExit
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
      const text = String(value ?? '').trim().toLowerCase()
      if (text === 'off' || text === 'never' || text === 'false') return 0
      const parsed = Number.parseInt(text, 10)
      if (Number.isFinite(parsed) && parsed >= 0) return parsed
    }
    return DEFAULT_IDLE_EXIT_MS
  }

  private clearIdleExitTimer(): void {
    if (this.idleExitTimer !== undefined) clearTimeout(this.idleExitTimer)
    this.idleExitTimer = undefined
  }

  /**
   * Arm the exit for a Host a busy SSH drop left behind. Called when the agent
   * goes idle — the reason the Host was kept is gone, and every second it stays
   * is a second its `session.lock` keeps the browser surface from opening the
   * session (`resume failed for session "…"`). A reattach cancels it.
   */
  private armIdleExitTimer(): void {
    if (!this.headlessDisplay || !this.hostKeptAlive) return
    const idleMs = this.idleExitMs()
    if (idleMs <= 0) return
    this.clearIdleExitTimer()
    this.idleExitTimer = setTimeout(() => {
      this.idleExitTimer = undefined
      if (this.disposed || this.exiting) return
      if (this.displayHost?.attached === true) return
      if (this.isBusyForHangupKeepalive()) {
        this.armIdleExitTimer()
        return
      }
      // Flush + exit, exactly like an idle hangup: the turn already ended, so
      // nothing is cancelled and the lock goes back to the session store.
      void this.requestExit(0)
    }, idleMs)
    this.idleExitTimer.unref?.()
  }

  private isCompactView(): boolean {
    return this.workspaceView === 'compact'
  }

  /** Test helper: switch the workspace view without going through /view. */
  setWorkspaceView(view: WorkspaceView): void {
    this.workspaceView = view
  }

  private paintCompactBurst(
    addDisplay: (line: string, ref?: Row | CollapsibleBlock) => void,
    groups: ReturnType<typeof compactToolGroups>,
    width: number,
  ): void {
    const callAnchor = groups.calls.at(-1)
    const editAnchor = groups.edits.at(-1)
    if (callAnchor !== undefined) this.paintCompactSummary(addDisplay, callAnchor, 'calls', groups, width)
    if (editAnchor !== undefined) this.paintCompactSummary(addDisplay, editAnchor, 'edits', groups, width)
  }

  private paintCompactSummary(
    addDisplay: (line: string, ref?: Row | CollapsibleBlock) => void,
    anchor: Extract<Row, { kind: 'tool' }>,
    kind: 'edits' | 'calls',
    groups: ReturnType<typeof compactToolGroups>,
    width: number,
  ): void {
    const items = kind === 'edits' ? groups.edits : groups.calls
    const running = items.some(item => item.status === undefined || item.status === 'running')
    const failed = items.length > 0 && items.every(item => item.status === 'error')
    const status: 'running' | 'ok' | 'error' = running ? 'running' : failed ? 'error' : 'ok'
    const addDel = { add: 0, del: 0 }
    if (kind === 'edits') {
      for (const item of groups.edits) {
        const stat = countDiffAddDel(item.diff)
        addDel.add += stat.add
        addDel.del += stat.del
      }
    }
    const singleEditPath = kind === 'edits' && groups.edits.length === 1
      ? compactEditPath(groups.edits[0]!)
      : ''
    const title = kind === 'edits'
      ? (groups.edits.length > 1
        ? t('compact.editsFiles', { files: groups.edits.length })
        : singleEditPath === ''
          ? t('compact.edits')
          : t('compact.editsFile', { path: singleEditPath }))
      : (groups.failedCalls > 0
        ? t('compact.toolsFailed', { count: groups.calls.length, failed: groups.failedCalls })
        : t('compact.tools', { count: groups.calls.length }))
    const header = buildToolHeader({
      focused: this.focusedRow === anchor,
      expanded: anchor.expanded,
      title,
      summary: '',
      status,
      spinner: running ? ` ${this.spinnerFrame()}` : '',
      flipping: items.some(item => item.flipUntil !== undefined && Date.now() < item.flipUntil),
      ...(kind === 'edits' && (addDel.add > 0 || addDel.del > 0) ? { diffStat: addDel } : {}),
    })
    const headerSegments = this.color ? header.segments : []
    if (!anchor.expanded) {
      const collapsed = truncateToWidth(header.plain, Math.max(1, width - 2))
      const styled = headerSegments.length === 0
        ? this.styleLine('tool', collapsed)
        : paintSegmentedLine(collapsed, 0, collapsed.length, headerSegments)
      addDisplay(this.focusedRow === anchor && this.color ? `\x1b[7m${styled}\x1b[27m` : styled, anchor)
      return
    }
    const expandedHeaderLines = headerSegments.length === 0
      ? wrap(header.plain, width).map(line => this.styleLine('tool', line))
      : wrapSegmented(header.plain, Math.max(1, width), headerSegments)
    for (const wrapped of expandedHeaderLines) {
      addDisplay(this.focusedRow === anchor && this.color ? `\x1b[7m${wrapped}\x1b[27m` : wrapped, anchor)
    }
    for (const item of items) {
      if (kind === 'edits') {
        const stat = countDiffAddDel(item.diff)
        const token = diffStatToken(stat.add, stat.del)
        const extra = token === ''
          ? t('compact.lines', { count: countDiffLines(item.diff) || 1 })
          : token
        addDisplay(this.styleLine('tool-result', truncateToWidth(`    ${item.title}  ${extra}`, width)), item)
        for (const line of toolBodyLines(item, Number.MAX_SAFE_INTEGER)) {
          this.paintToolBodyLine(addDisplay, item, line, width)
        }
        continue
      }
      const extra = item.summary
      const state = item.status === 'error' ? '  [error]' : item.status === 'ok' ? '' : '  [running…]'
      addDisplay(this.styleLine('tool-result', truncateToWidth(`    ${item.title}  ${extra}${state}`, width)), item)
    }
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
        || this.waitCardVisible()
        || this.rows.some(row =>
          (row.kind === 'tool' && row.flipUntil !== undefined && now < row.flipUntil)
          || (row.kind === 'question' && row.status === 'waiting')
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
      this.markDirty()
      return
    }
    if (this.paintLink !== 'ssh') {
      this.markDirty()
      return
    }
    const rtt = await probeTerminalRttMs()
    if (this.disposed) return
    this.paintProbed = rtt !== undefined
    this.paintRttMs = rtt
    this.paintIntervalMs = resolvePaintIntervalMs(undefined, {}, { ssh: true, rttMs: rtt })
    this.markDirty()
  }

  /**
   * Replay the durable session log so a resumed session renders its history.
   * Chunked on purpose: a synchronous walk of a long log froze the TUI on the
   * pre-replay frame, so the relay's RTT frame could not be applied and the
   * footer sat on `SSH ○○○○` for the whole load.
   */
  async replayHistory(): Promise<void> {
    const parked: Array<{ session: { id: SessionId }; event: SessionEvent }> = []
    this.replayQueue = parked
    this.replaying = true
    try {
      await forEachSessionEventAsync(this.agent.session, (event) => {
        this.applySessionEvent(this.agent.session, event)
      }, REPLAY_YIELD_EVERY, () => this.disposed)
    } finally {
      this.replaying = false
      this.replayQueue = undefined
    }
    for (const item of parked) {
      if (this.disposed) return
      this.applySessionEvent(item.session, item.event)
    }
    this.streaming = undefined
    this.streamingReasoning = undefined
    this.thinkingStartedAt = undefined
    this.status = this.agent.status === 'running' ? 'running' : 'idle'
    this.refreshContextPressure({ compact: false })
    this.paintTailBudget = Math.max(24, this.screenRows() * 3)
    this.dirty = true
  }

  /** Show the first-launch provider/API-key onboarding when nothing is configured. */
  private async maybeRunOnboarding(): Promise<void> {
    const credentials = this.ctx.get('credentials')
    const provider = this.currentProviderId()
    if (providerUsesLocalOAuth(provider)) {
      this.pushRow({
        kind: 'system',
        text: t('onboard.oauthHint', { kind: describeProviderRoute(provider).kind, provider }),
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
          text: t('onboard.envInUse', { env: envRef }),
        })
        this.markDirty()
        return
      }
      this.pushRow({
        kind: 'system',
        text: t('onboard.envStale', { env: envRef }),
      })
      await this.runOnboarding()
      return
    }
    if (stored || this.resume) return
    this.pushRow({ kind: 'system', text: t('onboard.needSetup') })
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
        catalogPresets: undefined,
        catalog: undefined,
        providerCursor: 0,
        saving: false,
        resolve: (saved) => {
          this.onboardingCompletion = undefined
          resolve(saved)
        },
      }
      // Web-aligned catalog presets warm at construction; adopt whatever is
      // ready now and update the open wizard when the load settles.
      const state = this.onboarding
      state.catalogPresets = this.catalogPresets
      void this.catalogLoad?.then(presets => {
        if (this.onboarding === state && state.catalogPresets === undefined && presets !== undefined) {
          state.catalogPresets = presets
          this.markDirty()
        }
      })
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

  /**
   * Drop the TTY without disposing the agent. Safe to call when the fd is
   * already dead: DECSET restore is best-effort and never throws.
   */
  detachDisplay(): void {
    if (this.displayDetached) return
    if (this.renderTimer !== undefined) clearInterval(this.renderTimer)
    this.renderTimer = undefined
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer)
    this.escapeTimer = undefined
    this.inputGuard.stop()
    process.stdin.removeListener('data', this.handleData)
    process.stdout.removeListener('resize', this.onDirectResize)
    process.stdout.removeListener('error', this.handleIoError)
    process.stdin.removeListener('error', this.handleIoError)
    process.stdin.removeListener('end', this.handleHangupStream)
    process.stdin.removeListener('close', this.handleHangupStream)
    process.removeListener('SIGWINCH', this.onDirectResize)
    if (!this.hangingUp) releaseHangupSignals(this.handleHangupSignal)
    try {
      process.stdin.setRawMode(false)
    } catch {
      // stdin may already be closed after SIGHUP.
    }
    try {
      process.stdin.pause()
    } catch {
      // ignore
    }
    try {
      process.stdout.write('\x1b]0;\x07')
      process.stdout.write('\x1b[0m\x1b[2J\x1b[3J\x1b[H')
      process.stdout.write(`\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h${this.useAlternateScreen ? '\x1b[?1049l' : ''}`)
    } catch (error) {
      if (!isHangupErrno(error)) {
        try {
          process.stderr.write(`dsh-ssh-tui: failed to restore terminal: ${errorChain(error)}\n`)
        } catch {
          // both pipes gone
        }
      }
    }
    this.displayDetached = true
  }

  /** Restore the terminal and drop event wiring. Does not flush or exit. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.exiting = true
    this.clearDetachedIdleTimer()
    this.clearIdleExitTimer()
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
    this.commandAbort?.abort()
    this.commandAbort = undefined
    for (const dispose of this.disposers.splice(0)) {
      dispose()
    }
    this.userQuestionDisposer?.()
    this.userQuestionDisposer = undefined
    this.detachDisplay()
    const host = this.displayHost
    this.displayHost = undefined
    if (host !== undefined) await host.close()
  }

  /**
   * `/diag`: collect the local facts about this session's channel, lock, and
   * Host, then print the decision chain. Everything is local; nothing is sent
   * anywhere (see the privacy note in the README).
   */
  private async runDiagCommand(): Promise<void> {
    const snapshot = await collectDiag({
      sessionId: String(this.agent.id),
      pluginVersion: PLUGIN_VERSION,
      hostVersion: hostDshVersion(),
      hostProcess: isTuiHostProcess(),
      link: {
        kind: this.paintLink === 'ssh' ? 'ssh' : 'local',
        ...(this.paintRttMs === undefined ? {} : { rttMs: this.paintRttMs }),
        probeState: this.paintProbed ? 'measured' : this.paintLink === 'ssh' ? 'unknown' : 'unprobed',
      },
      ...(this.paintIntervalMs === undefined ? {} : { paintIntervalMs: this.paintIntervalMs }),
    })
    this.pushRow({ kind: 'system', text: formatDiag(snapshot).join('\n') })
    this.markDirty()
  }

  /** Human-facing exit with goodbye and flush; called from key handling. */
  async requestExit(code: number): Promise<void> {
    if (this.hangingUp) return
    if (this.disposed) return
    this.exiting = true
    this.clearDetachedIdleTimer()
    this.displayHost?.sendGoodbye()
    await this.dispose()
    if (!this.headlessDisplay) this.writeGoodbye()
    await this.flushSession()
    this.exitProcess(code)
  }

  /**
   * True while the session is doing work the user would lose by killing the
   * Host: a running turn (thinking / reply / tools), live subagents, in-flight
   * compaction, or an LLM retry. Idle (including a waiting approval dialog
   * after the turn has already settled) is not busy — hangup then exits
   * instead of leaving a leftover process.
   */
  private isBusyForHangupKeepalive(): boolean {
    if (this.agent.status === 'running') return true
    if (this.activeSubagents.size > 0) return true
    if (this.streaming !== undefined) return true
    if (this.openToolCalls.size > 0) return true
    if (this.llmRetry !== undefined) return true
    if (this.rows.some(row => row.kind === 'compaction' && row.status === 'running')) return true
    return false
  }

  /**
   * Display socket closed. Replacing a leftover Display with a new HELLO,
   * or closing a socket after we already detached, is not an SSH hangup.
   */
  handleDisplayDetach(info?: { replaced?: boolean }): void {
    if (this.disposed || this.hangingUp) return
    if (info?.replaced === true) return
    if (this.displayDetached) return
    void this.handleHangup()
  }

  /**
   * SSH / TTY hangup: drop the local display, flush, and either keep the Host
   * (busy: thinking / reply / tools / subagents) or exit (idle).
   * When keeping the Host, `pause` cancels the turn; `continue` lets it finish.
   * Ctrl+C is not a hangup.
   */
  async handleHangup(): Promise<void> {
    if (this.hangingUp || this.disposed) return
    this.hangingUp = true
    this.reattachedDuringHangup = false
    ignoreFurtherHangupSignals()
    this.detachDisplay()
    const busy = this.isBusyForHangupKeepalive()
    const pauseTurn = this.disconnectPolicy !== 'continue'
    if (pauseTurn && this.agent.status === 'running') {
      try {
        this.agent.cancel({ kind: 'user' })
      } catch {
        // cancel is best-effort; we still flush below.
      }
      await waitUntilIdleOrTimeout(
        () => this.agent.status !== 'running',
        HANGUP_CANCEL_TIMEOUT_MS,
      )
    }
    await this.flushSession()
    // A relay can reattach while the cancel/flush above was in flight — the
    // common case is a user reconnecting the moment the link drops. Deciding
    // from the snapshot taken at the start would dispose (or exit) the Host
    // under the display the user just got back, and the launcher would report
    // `write EPIPE` for an attach that had already succeeded.
    if (this.reattachedDuringHangup) {
      this.reattachedDuringHangup = false
      this.hangingUp = false
      this.clearDetachedIdleTimer()
      return
    }
    const keepHost = this.displayHost !== undefined && busy
    if (keepHost) {
      this.hangingUp = false
      // A relay that arrived while this hangup was unwinding set
      // `reattachedDuringHangup` so the hangup would honor it. That relay
      // *cancels* this hangup when it HELLOs, so reaching this keep-host path
      // means the flag is already cleared above; clearing it here too would be
      // dead code, and the status handler clears it on the next turn.
      this.hostKeptAlive = true
      this.armDetachedIdleTimer()
      await this.onHangup?.()
      return
    }
    this.exiting = true
    await this.dispose()
    this.exitProcess(129)
  }

  private readonly handleHangupSignal = (): void => {
    void this.handleHangup()
  }

  private readonly handleHangupStream = (): void => {
    void this.handleHangup()
  }

  private readonly handleIoError = (error: unknown): void => {
    if (isHangupErrno(error)) void this.handleHangup()
  }

  private writeGoodbye(): void {
    try {
      process.stdout.write(`\n${sanitizeTerminalText(this.goodbye)}\n`)
    } catch (error) {
      if (!isHangupErrno(error)) {
        try {
          process.stderr.write(`dsh-ssh-tui: failed to write goodbye: ${errorChain(error)}\n`)
        } catch {
          // both pipes gone
        }
      }
    }
  }

  private async flushSession(): Promise<void> {
    try {
      await this.ctx.get('sessions')?.flush(this.agent.session)
    } catch (error) {
      try {
        process.stderr.write(`dsh-ssh-tui: failed to flush session: ${errorChain(error)}\n`)
      } catch {
        // stderr may be gone after hangup
      }
    }
  }

  private exitProcess(code: number): void {
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

  /** Last CSI cursor column written by {@link paint} (1-based). Tests only. */
  lastPaintedCursorColumn(): number {
    return this.lastPaintCursorColumn
  }

  /** Last CSI cursor row written by {@link paint} (1-based). Tests only. */
  lastPaintedCursorRow(): number {
    return this.lastPaintCursorRow
  }

  private screenColumns(): number {
    if (this.headlessDisplay || this.displayDetached) {
      return this.relayColumns ?? process.stdout.columns ?? 80
    }
    return process.stdout.columns ?? 80
  }

  private screenRows(): number {
    if (this.headlessDisplay || this.displayDetached) {
      return this.relayRows ?? process.stdout.rows ?? 24
    }
    return process.stdout.rows ?? 24
  }

  private write(chunk: string): void {
    const host = this.displayHost
    if (host?.attached === true) {
      host.sendStdout(chunk)
      if (this.displayDetached) return
    } else if (this.displayDetached) {
      return
    }
    try {
      process.stdout.write(chunk)
    } catch (error) {
      if (isHangupErrno(error)) {
        void this.handleHangup()
        return
      }
      throw error
    }
  }

  private async ensureDisplayHost(): Promise<void> {
    if (this.displayHost !== undefined || this.disposed) return
    const host = new DisplayHost(sessionSockPath(String(this.agent.id)), {
      onStdin: (bytes) => {
        if (this.disposed) return
        this.handleData(bytes)
      },
      onResize: (columns, rows) => {
        const changed = this.relayColumns !== columns || this.relayRows !== rows
        this.relayColumns = columns
        this.relayRows = rows
        if (this.displayHost?.attached === true && this.displayDetached) {
          this.attachRelayDisplay()
          return
        }
        if (changed) {
          this.forceFullPaint = true
          this.dirty = true
          this.paint()
        }
      },
      onRtt: (rttMs) => {
        this.applyProbedRtt(rttMs)
      },
      onDetach: (info) => {
        this.handleDisplayDetach(info)
      },
      onAttach: () => {
        if (this.disposed) return
        if (this.relayColumns !== undefined && this.relayRows !== undefined) {
          this.attachRelayDisplay()
        }
      },
    })
    await host.listen()
    if (this.disposed) {
      await host.close()
      return
    }
    this.displayHost = host
  }

  /** Re-open DECSET and start painting to an attached Display relay. */
  attachRelayDisplay(): void {
    // A relay that HELLOs while a hangup is still unwinding must be honored by
    // that hangup: the snapshot taken at the drop would otherwise dispose (or
    // exit) the Host under the display the user just got back, and the
    // launcher reports `write EPIPE` for an attach that had already succeeded.
    if (this.hangingUp) this.reattachedDuringHangup = true
    this.displayDetached = false
    this.hangingUp = false
    this.hostKeptAlive = false
    this.clearDetachedIdleTimer()
    // The user is back: the leftover Host is a live session again, so the
    // idle exit must not fire out from under the display that just attached.
    this.clearIdleExitTimer()
    this.lastActivity = Date.now()
    this.stalledWarningShown = false
    this.lastPaintRows = []
    this.lastChromeKey = ''
    this.lastTranscriptStart = -1
    this.write(`${this.useAlternateScreen ? '\x1b[?1049h' : ''}\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?25l`)
    this.forceFullPaint = true
    this.dirty = true
    this.paint()
    this.startRenderTimer()
    void this.onReattach?.()
  }

  currentDisconnectPolicy(): DisconnectPolicyName {
    return this.disconnectPolicy
  }

  applyProbedRtt(rttMs: number | undefined): void {
    const envOverride = Number.parseInt(process.env.DSH_TUI_PAINT_MS ?? '', 10)
    this.paintLink = 'ssh'
    // A reattach whose probe missed its window reports "unknown"; the link has
    // not changed, so dropping a measurement we already have just blanks the
    // footer chip to four hollow circles. Keep it (the next attach re-measures).
    if (rttMs === undefined && this.paintProbed && this.paintRttMs !== undefined) return
    this.paintProbed = rttMs !== undefined
    this.paintRttMs = rttMs
    if (!(Number.isFinite(envOverride) && envOverride > 0)) {
      this.paintIntervalMs = resolvePaintIntervalMs(undefined, {}, { ssh: true, rttMs })
      this.startRenderTimer()
    }
    this.markDirty()
  }

  private markDirty = (): void => {
    this.dirty = true
  }

  private toolCardSummary(row: Extract<Row, { kind: 'tool' }>): string {
    const repeats = row.repeats ?? 1
    const parts: string[] = []
    if (row.summary !== '') parts.push(row.summary)
    if (repeats > 1) parts.push(t('tool.repeatCount', { count: repeats }))
    if (READ_TOOL_NAMES.has(row.name) && (row.totalChars !== undefined || row.totalLines !== undefined)) {
      const chars = row.totalChars ?? 0
      const lines = row.totalLines ?? 0
      parts.push(t('tool.readStats', { chars: formatTokens(chars), lines: String(lines) }))
    }
    return parts.join(' · ')
  }

  private mergeIntoToolCard(
    previous: Extract<Row, { kind: 'tool' }>,
    next: {
      callId: string
      name: string
      args: string
      title: string
      summary: string
      diff?: ToolDiffHunk[]
    },
  ): void {
    mergeToolCard(previous, next, Date.now(), this.replaying)
  }

  private findToolRowByCallId(callId: string): Extract<Row, { kind: 'tool' }> | undefined {
    return findToolRowByCallId(this.rows, callId)
  }

  private findMergeableToolRow(next: { name: string; args: string }): Extract<Row, { kind: 'tool' }> | undefined {
    return findMergeableToolRow(this.rows, next)
  }

  /** Append one transcript row, bounding memory on long sessions. */
  private pushRow(row: Row): void {
    this.rows.push(row)
    // Locate the focused card before trimming: after the splice every surviving
    // index shifts down and a stale index would clear the focus by accident.
    const focusedIndex = this.focusedRow === null || this.focusedRow.kind === 'streaming-reasoning'
      ? undefined
      : this.rows.indexOf(this.focusedRow)
    const removed = boundTranscriptRows(this.rows)
    if (removed === 0) return
    if (focusedIndex !== undefined && focusedIndex < removed) this.focusedRow = null
  }

  /** The transcript rows that support per-row expand/collapse. */
  private collapsibleRows(): CollapsibleBlock[] {
    const compact = this.isCompactView()
    if (compact) {
      const rows: CollapsibleBlock[] = this.rows.filter(
        (row): row is Extract<Row, { kind: 'subagent' } | { kind: 'plan' } | { kind: 'question' } | { kind: 'goal' } | { kind: 'compaction' }> =>
          row.kind === 'subagent'
          || row.kind === 'plan'
          || row.kind === 'question'
          || row.kind === 'goal'
          || row.kind === 'compaction')
      for (const burst of compactToolBursts(this.rows)) {
        const callAnchor = burst.groups.calls.at(-1)
        const editAnchor = burst.groups.edits.at(-1)
        if (callAnchor !== undefined) rows.push(callAnchor)
        if (editAnchor !== undefined) rows.push(editAnchor)
      }
      return rows
    }
    const rows: CollapsibleBlock[] = this.rows.filter(
      (row): row is Extract<Row, { kind: 'reasoning' } | { kind: 'tool' } | { kind: 'subagent' } | { kind: 'plan' } | { kind: 'question' } | { kind: 'goal' } | { kind: 'compaction' } | { kind: 'prompt' }> =>
        row.kind === 'reasoning'
        || row.kind === 'tool'
        || row.kind === 'subagent'
        || row.kind === 'plan'
        || row.kind === 'question'
        || row.kind === 'goal'
        || row.kind === 'compaction'
        || row.kind === 'prompt')
    if (this.streaming !== undefined && this.streaming.reasoning !== '') {
      this.streamingReasoning ??= { kind: 'streaming-reasoning', expanded: false }
      rows.push(this.streamingReasoning)
    }
    return rows
  }

  private spinnerFrame(periodMs = 120): string {
    return SPINNER[Math.floor(Date.now() / periodMs) % SPINNER.length] ?? '⠋'
  }

  /**
   * Codex wait card: shown while the turn is running. The live thinking
   * stream feeds the shimmer header; a live tool becomes the detail rows.
   * While the reply itself is streaming, the transcript paints those tokens
   * and the card yields (Codex hides the status row once output commits).
   */
  private waitCardVisible(): boolean {
    if (this.agent.status !== 'running') return false
    if (this.streaming?.text) return false
    if (this.rows.some(row => row.kind === 'compaction' && row.status === 'running')) return false
    if (this.dialog?.kind === 'questions' || this.dialog?.kind === 'confirm') return false
    return true
  }

  private beginWait(): void {
    this.waitStartedAt = Date.now()
  }

  private endWait(): void {
    this.waitStartedAt = undefined
  }

  private waitCardSource(): {
    toolTitle?: string
    toolSummary?: string
    reasoning?: string
  } {
    const liveTool = this.rows.findLast((row): row is Extract<Row, { kind: 'tool' }> =>
      row.kind === 'tool' && (row.status === undefined || row.status === 'running'))
    const liveSub = this.rows.findLast((row): row is Extract<Row, { kind: 'subagent' }> =>
      row.kind === 'subagent' && row.status === 'running')
    return {
      ...(liveTool === undefined ? {} : { toolTitle: liveTool.title, toolSummary: liveTool.summary }),
      ...(liveTool !== undefined || liveSub === undefined
        ? {}
        : { toolTitle: liveSub.label, toolSummary: liveSub.lastActivity }),
      ...(this.streaming?.reasoning ? { reasoning: this.streaming.reasoning } : {}),
    }
  }

  private findSubagentRow(sessionId: string): Extract<Row, { kind: 'subagent' }> | undefined {
    return this.rows.findLast((row): row is Extract<Row, { kind: 'subagent' }> =>
      row.kind === 'subagent' && row.sessionId === sessionId)
  }

  private findLivePlanRow(): Extract<Row, { kind: 'plan' }> | undefined {
    return findLivePlanRow(this.rows)
  }

  /** Older / finished plans stay in the scrolling transcript. */
  private archiveStalePlans(keep?: Extract<Row, { kind: 'plan' }>): void {
    archiveStalePlans(this.rows, keep)
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
      } else if (patch.expanded === undefined && planShouldDefaultExpand(existing)) {
        existing.expanded = true
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
    const active = patch.active ?? false
    const pending = patch.pending ?? false
    const todos = patch.todos ?? []
    const row: Extract<Row, { kind: 'plan' }> = {
      kind: 'plan',
      active,
      pending,
      todos,
      ...(patch.planMarkdown === undefined ? {} : { planMarkdown: patch.planMarkdown }),
      expanded: planShouldDefaultExpand({ active, pending, todos }),
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

  /** Send the leftover-todo nudge only from true idle, so /compact is not blocked. */
  private flushPlanCloseNudge(): void {
    if (this.replaying || this.agentGone || this.planNudgePending) return
    if (this.agent.status === 'running') return
    const plan = this.findLivePlanRow()
    if (plan === undefined || plan.turnLeftOpen !== true) return
    this.planNudgePending = true
    const text = planCloseNudgeText(plan)
    const queued = t('plan.nudgeQueued')
    this.pushRow({ kind: 'system', text: queued })
    // Plugin notice, not a user turn: the model still sees the follow-up, but
    // the workspace only shows the one-line queued hint — not the todo_write
    // instruction that used to paint as `❯ …`.
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-ssh-tui', form: 'notice', summary: queued },
    })
    try {
      this.agent.followup(message)
    } catch (error: unknown) {
      this.planNudgePending = false
      this.pushRow({ kind: 'error', text: t('plan.nudgeFailed', { error: errorChain(error) }) })
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
    const mode = plan.pending ? t('plan.switching')
      : leftOpen ? t('footer.planOpen')
      : plan.active ? t('footer.planMode')
      : running ? t('card.plan')
      : allDone ? t('plan.complete')
      : t('card.plan')
    const counts = todoProgressLabel(plan.todos)
    const title = planTitleFromMarkdown(plan.planMarkdown ?? '')
    const summary = title ?? (counts === '' ? t('plan.noTasks') : counts)
    const marker = plan.expanded ? '▾' : '▸'
    const focused = this.focusedRow === plan ? '▶ ' : '  '
    const header = `${focused}${marker} ${mode}${spinner} · ${summary}${plan.expanded || yieldBottom ? '' : t('card.expand')}`
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
        lines.push(this.styleLine('plan-dock', padToWidth(t('plan.moreLines', { count: markdown.length - budget }), width)))
      }
    }
    if (plan.todos.length === 0) {
      if (plan.planMarkdown === undefined || plan.planMarkdown === '') {
        lines.push(this.styleLine('todo-pending', padToWidth(t('plan.noTodos'), width)))
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

  private paintToolBodyLine(
    addDisplay: (line: string, ref?: Row | CollapsibleBlock) => void,
    row: Row | CollapsibleBlock | undefined,
    line: DiffDisplayLine,
    width: number,
  ): void {
    const inner = Math.max(1, width - 2)
    const fillRow = line.kind === 'diff-add' || line.kind === 'diff-del'
    for (const wrapped of wrap(line.text, inner)) {
      const body = fillRow ? padToWidth(`  ${wrapped}`, width) : `  ${wrapped}`
      const kind = line.kind
      const style = kind === 'diff-add' || kind === 'diff-del' || kind === 'diff-path'
        ? this.styleLine(kind, body)
        : kind === 'todo-done' || kind === 'todo-active' || kind === 'todo-pending'
          ? this.styleLine(kind, body)
          : kind === 'error'
            ? this.styleLine('error', body)
            : kind === 'assistant'
              ? this.styleLine('assistant', body)
              : this.styleLine('tool-result', body)
      addDisplay(style, row)
    }
  }

  private workspaceRowsFor(_width: number, height: number): number {
    const header = 2
    const chrome = RESERVED_BOTTOM_LINES + 1
    return Math.max(1, height - header - chrome)
  }

  private paintInspectOverlay(width: number, height: number): void {
    const dialog = this.dialog
    if (dialog === undefined || dialog.kind !== 'inspect') return
    const header = this.styleLine('system', truncateToWidth(t('tool.inspectTitle', { title: dialog.title }), width))
    const hint = this.styleLine('system', truncateToWidth(t('tool.inspectHint'), width))
    const divider = this.styleLine('system', repeatToWidth('─', width))
    const bodyBudget = Math.max(1, height - 4)
    const rendered: string[] = []
    for (const line of dialog.lines) {
      const inner = Math.max(1, width - 2)
      const fillRow = line.kind === 'diff-add' || line.kind === 'diff-del'
      for (const wrapped of wrap(line.text, inner)) {
        const body = fillRow ? padToWidth(`  ${wrapped}`, width) : `  ${wrapped}`
        const kind = line.kind
        rendered.push(
          kind === 'diff-add' || kind === 'diff-del' || kind === 'diff-path'
            ? this.styleLine(kind, body)
            : kind === 'todo-done' || kind === 'todo-active' || kind === 'todo-pending'
              ? this.styleLine(kind, body)
              : kind === 'error'
                ? this.styleLine('error', body)
                : kind === 'assistant'
                  ? this.styleLine('assistant', body)
                  : this.styleLine('tool-result', body),
        )
      }
    }
    const maxOffset = Math.max(0, rendered.length - bodyBudget)
    if (dialog.offset > maxOffset) dialog.offset = maxOffset
    if (dialog.offset < 0) dialog.offset = 0
    const slice = rendered.slice(dialog.offset, dialog.offset + bodyBudget)
    while (slice.length < bodyBudget) slice.push('')
    const pos = rendered.length === 0
      ? '0/0'
      : `${dialog.offset + 1}–${Math.min(rendered.length, dialog.offset + bodyBudget)}/${rendered.length}`
    const footer = this.styleLine('system', truncateToWidth(t('tool.inspectFooter', { pos }), width))
    const paintRows = [header, divider, ...slice, hint, footer]
    this.write(composePaintOutput({
      width,
      height,
      paintRows,
      previousRows: this.lastPaintRows,
      sizeChanged: true,
      chromeChanged: true,
      chromeStart: 0,
      previousChromeStart: 0,
      cursorRow: height,
      cursorColumn: 1,
    }))
    this.lastPaintCursorRow = height
    this.lastPaintCursorColumn = 1
    this.lastPaintRows = paintRows.length > height ? paintRows.slice(0, height) : paintRows
    this.lastChromeKey = `inspect:${dialog.offset}:${width}x${height}`
    this.lastPaintWidth = width
    this.lastPaintHeight = height
    this.lastChromeStart = 0
    this.lastTranscriptStart = -1
  }

  private openToolInspect(row: Extract<Row, { kind: 'tool' }>): void {
    const lines = toolBodyLines(row, Number.MAX_SAFE_INTEGER)
    this.openDialog({
      kind: 'inspect',
      title: `${row.title}${row.summary === '' ? '' : `  ${row.summary}`}`,
      lines,
      offset: 0,
    })
  }

  closeInspect(): void {
    if (this.dialog?.kind !== 'inspect') return
    this.dialog = undefined
    this.forceFullPaint = true
    this.markDirty()
    this.showNextDialog()
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
  toggleCollapsible(): void {
    const rows = this.collapsibleRows()
    if (rows.length === 0) return
    const focused = this.focusedRow !== null && rows.includes(this.focusedRow)
      ? this.focusedRow
      : undefined
    const target = focused ?? rows[rows.length - 1]
    if (target === undefined) return
    this.toggleCard(target)
  }

  toggleCard(target: CollapsibleBlock): void {
    if (target.kind === 'tool' && !target.expanded) {
      const width = Math.max(10, this.screenColumns())
      const height = Math.max(6, this.screenRows())
      const body = toolBodyLines(target, Number.MAX_SAFE_INTEGER)
      const bodyRows = wrappedToolBodyLineCount(body, width)
      if (!toolBodyFitsWorkspace(bodyRows, this.workspaceRowsFor(width, height))) {
        this.focusedRow = target
        this.openToolInspect(target)
        return
      }
    }
    target.expanded = !target.expanded
    this.focusedRow = target
    this.forceFullPaint = true
    this.markDirty()
  }

  /** Expand all collapsible blocks, or collapse them again when all are open. */
  toggleAllCollapsible(): void {
    const rows = this.collapsibleRows()
    if (rows.length === 0) return
    const allExpanded = rows.every(row => row.expanded)
    if (allExpanded) {
      for (const row of rows) row.expanded = false
      this.focusedRow = null
    } else {
      const width = Math.max(10, this.screenColumns())
      const height = Math.max(6, this.screenRows())
      const workspace = this.workspaceRowsFor(width, height)
      for (const row of rows) {
        if (row.kind === 'tool') {
          const bodyRows = wrappedToolBodyLineCount(toolBodyLines(row, Number.MAX_SAFE_INTEGER), width)
          if (!toolBodyFitsWorkspace(bodyRows, workspace)) continue
        }
        row.expanded = true
      }
      this.focusedRow = rows[rows.length - 1] ?? null
    }
    this.forceFullPaint = true
    this.markDirty()
  }

  private highlightSearchLine(line: string): string {
    if (line.includes('\x1b[7m')) return line
    return this.color ? `\x1b[7m${line}\x1b[27m` : `» ${line}`
  }

  private revealRow(row: Row | CollapsibleBlock | undefined): void {
    if (row === undefined) return
    if (row.kind === 'tool') {
      const width = Math.max(10, this.screenColumns())
      const height = Math.max(6, this.screenRows())
      const body = toolBodyLines(row, Number.MAX_SAFE_INTEGER)
      const bodyRows = wrappedToolBodyLineCount(body, width)
      if (!toolBodyFitsWorkspace(bodyRows, this.workspaceRowsFor(width, height))) {
        this.focusedRow = row
        this.openToolInspect(row)
        return
      }
    }
    if (row.kind !== 'assistant' && 'expanded' in row) {
      row.expanded = true
      this.focusedRow = row as CollapsibleBlock
      this.forceFullPaint = true
    } else {
      this.focusedRow = null
    }
    if (this.paintTailBudget > 0) {
      this.paintTailBudget = 0
      this.forceFullPaint = true
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
        this.pushRow({ kind: 'system', text: t('jump.planDock', { category: cardCategoryLabel(category) }) })
        this.revealRow(live)
        return
      }
    }
    const target = this.rows.findLast(row => cardCategoryOf(row) === category)
    if (target === undefined) {
      this.pushRow({ kind: 'system', text: t('jump.missing', { category: cardCategoryLabel(category) }) })
      this.markDirty()
      return
    }
    this.pushRow({ kind: 'system', text: t('jump.latest', { category: cardCategoryLabel(category) }) })
    this.revealRow(target)
  }

  private applySearchHits(query: string, hits: Row[]): void {
    this.searchQuery = query
    this.searchHits = hits
    if (hits.length === 0) {
      this.searchIndex = -1
      this.pushRow({
        kind: 'system',
        text: query === '' ? t('find.none') : t('find.noMatch', { query }),
      })
      this.markDirty()
      return
    }
    this.searchIndex = hits.length - 1
    const hit = hits[this.searchIndex]
    const where = hit === undefined ? '' : cardCategoryLabel(cardCategoryOf(hit) ?? 'reply')
    this.pushRow({
      kind: 'system',
      text: t('find.hits', {
        count: hits.length,
        query: query === '' ? '' : `「${query}」`,
        where,
      }),
    })
    this.revealRow(hit)
  }

  private runFindCommand(arg: string): void {
    const parsed = parseFindQuery(arg)
    const label = parsed.category === undefined ? '' : `${cardCategoryLabel(parsed.category)} `
    const hits = matchTranscriptRows(this.rows, arg)
    this.applySearchHits(`${label}${parsed.query}`.trim(), hits)
  }

  private stepSearch(delta: number): void {
    if (this.searchHits.length === 0) {
      this.pushRow({ kind: 'system', text: t('find.empty') })
      this.markDirty()
      return
    }
    const count = this.searchHits.length
    this.searchIndex = (this.searchIndex + delta + count) % count
    const hit = this.searchHits[this.searchIndex]
    const where = hit === undefined ? '' : cardCategoryLabel(cardCategoryOf(hit) ?? 'reply')
    this.pushRow({
      kind: 'system',
      text: t('find.step', {
        query: this.searchQuery,
        index: this.searchIndex + 1,
        total: count,
        where,
      }),
    })
    this.revealRow(hit)
  }

  private paint = (): void => {
    if (this.exiting) return
    const width = Math.max(10, this.screenColumns())
    const height = Math.max(6, this.screenRows())
    if (this.dialog?.kind === 'inspect') {
      this.paintInspectOverlay(width, height)
      return
    }

    const display: string[] = []
    const displayRefs: (Row | CollapsibleBlock | undefined)[] = []
    const searchHit = this.searchHits[this.searchIndex]
    const addDisplay = (
      line: string,
      ref?: Row | CollapsibleBlock,
    ): void => {
      const clipped = clipAnsiToWidth(line, width)
      const hit = ref !== undefined && ref === searchHit
      display.push(hit ? this.highlightSearchLine(clipped) : clipped)
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

    const compact = this.isCompactView()
    const compactBursts = compact ? compactToolBursts(this.rows) : []
    const compactBurstByReply = new Map<Extract<Row, { kind: 'assistant' }>, (typeof compactBursts)[number]>()
    for (const burst of compactBursts) {
      if (burst.after !== undefined) compactBurstByReply.set(burst.after, burst)
    }

    const skipMiddle = this.paintTailBudget > 0 && this.scrollOffset === 0 && this.pendingReveal === undefined
      && this.rows.length > this.paintTailBudget + 8
    const historyStart = skipMiddle ? Math.max(0, this.rows.length - this.paintTailBudget) : 0
    let paintedLeadingCompact = skipMiddle
    for (let rowIndex = 0; rowIndex < this.rows.length; rowIndex += 1) {
      if (skipMiddle && rowIndex >= 4 && rowIndex < historyStart) {
        if (rowIndex === 4) addDisplay(this.styleLine('system', t('history.folded')))
        continue
      }
      const row = this.rows[rowIndex]
      if (row === undefined) continue
      if (compact && (row.kind === 'reasoning' || row.kind === 'prompt' || row.kind === 'tool')) continue
      if (compact && !paintedLeadingCompact && (row.kind === 'assistant' || row.kind === 'user')) {
        const leading = compactBursts.find(burst => burst.after === undefined)
        if (leading !== undefined) this.paintCompactBurst(addDisplay, leading.groups, width)
        paintedLeadingCompact = true
      }
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
        const header = t('reason.done', { marker, lines }) + (row.expanded ? '' : t('card.expand'))
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
        const focused = this.focusedRow === row
        const header = buildToolHeader({
          focused,
          expanded: row.expanded,
          title: toolTitle(row.name),
          summary: this.toolCardSummary(row),
          status: row.status,
          command: row.command,
          signal: row.signal,
          exitCode: row.exitCode,
          spinner: running ? ` ${this.spinnerFrame()}` : '',
          flipping: row.flipUntil !== undefined && Date.now() < row.flipUntil,
          ...(row.diff !== undefined && row.diff.length > 0
            ? { diffStat: countDiffAddDel(row.diff) }
            : {}),
        })
        const headerSegments = this.color ? header.segments : []
        if (!row.expanded) {
          const collapsed = truncateToWidth(header.plain, Math.max(1, width - 2))
          const styled = headerSegments.length === 0
            ? collapsed
            : paintSegmentedLine(collapsed, 0, collapsed.length, headerSegments)
          addDisplay(focused && this.color ? `\x1b[7m${styled}\x1b[27m` : styled, row)
          continue
        }
        const expandedHeaderLines = headerSegments.length === 0
          ? wrap(header.plain, width)
          : wrapSegmented(header.plain, Math.max(1, width), headerSegments)
        for (const wrapped of expandedHeaderLines) {
          addDisplay(wrapped, row)
        }
        for (const line of toolBodyLines(row, Number.MAX_SAFE_INTEGER)) {
          this.paintToolBodyLine(addDisplay, row, line, width)
        }
        continue
      }
      if (row.kind === 'subagent') {
        const running = row.status === 'running'
        const ok = row.status === 'ok'
        const aborted = row.status === 'aborted'
        const dotColor = !this.color ? undefined : running ? '33' : ok ? '32' : aborted ? '33' : '31'
        const styleHeader = (line: string): string => {
          const safe = sanitizeTerminalText(line)
          if (!this.color) return safe
          const dotIndex = safe.indexOf('●')
          if (dotColor === undefined || dotIndex === -1) return safe
          return `${safe.slice(0, dotIndex)}\x1b[${dotColor}m●\x1b[0m${safe.slice(dotIndex + 1)}`
        }
        const spinner = running ? ` ${this.spinnerFrame()}` : ''
        const header = `● ${subagentHeaderText(row)}${spinner}${row.expanded ? '' : t('card.expand')}`
        this.paintCollapsibleHeader(addDisplay, row, 'system', header, width, styleHeader)
        if (row.expanded) {
          addDisplay(this.styleLine('system', t('sub.cardSession', {
            id: row.sessionId,
            provider: row.provider,
            external: row.local ? '' : t('sub.external'),
          })), row)
          if (row.stopReason !== undefined) {
            addDisplay(this.styleLine('system', t('sub.stopReason', { reason: row.stopReason })), row)
          }
          if (row.logs.length === 0) {
            addDisplay(this.styleLine('system', running ? t('sub.cardWait') : t('sub.cardEmpty')), row)
          } else {
            for (const entry of row.logs) {
              const kind: DisplayKind = entry.kind === 'assistant'
                ? 'assistant'
                : entry.kind === 'result' && row.status === 'error'
                  ? 'error'
                  : 'system'
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
        const summary = title ?? (counts === '' ? t('plan.archived') : counts)
        const header = t('plan.header', { summary }) + (row.expanded ? '' : t('card.expand'))
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
      if (row.kind === 'prompt') {
        const header = `● ${promptInjectionTitle(row.sources)}${row.expanded ? '' : t('card.expand')}`
        this.paintCollapsibleHeader(addDisplay, row, 'system', header, width)
        if (row.expanded) {
          for (const wrapped of wrap(row.text, Math.max(1, width - 2))) {
            addDisplay(this.styleLine('system', `  ${wrapped}`), row)
          }
        }
        continue
      }
      if (row.kind === 'question') {
        const waiting = row.status === 'waiting'
        const spinner = waiting ? ` ${this.spinnerFrame()}` : ''
        const state = waiting ? t('question.waiting') : row.status === 'answered' ? t('question.answered') : t('question.cancelled')
        const title = row.intent === 'plan-review' ? t('question.planTitle') : t('question.askTitle')
        const header = `● ${title}${spinner} · ${state} · ${row.summary}${row.expanded ? '' : t('card.expand')}`
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
            ? t('question.dialogHint')
            : `  ${row.summary}`), row)
        }
        continue
      }
      if (row.kind === 'goal') {
        const live = row.phase === 'active' || row.phase === 'blocked'
        const spinner = live ? ` ${this.spinnerFrame()}` : ''
        const phase = row.phase === 'active' ? t('goal.active')
          : row.phase === 'paused' ? t('goal.paused')
          : row.phase === 'blocked' ? t('goal.blocked')
          : row.phase === 'complete' ? t('goal.complete')
          : t('goal.cleared')
        const header = t('goal.header', { spinner, phase, objective: row.objective }) + (row.expanded ? '' : t('card.expand'))
        this.paintCollapsibleHeader(addDisplay, row, live ? 'tool' : 'system', header, width)
        if (row.expanded) {
          addDisplay(this.styleLine('system', t('goal.help')), row)
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
        const header = `● ${compactionHeaderText(row)}${spinner} · ${elapsed}s${row.expanded ? '' : t('card.expand')}`
        this.paintCollapsibleHeader(addDisplay, row, running ? 'tool' : row.status === 'error' ? 'error' : 'system', header, width)
        if (row.expanded) {
          addDisplay(this.styleLine('system', running
            ? t('compact.bodyRunning')
            : row.status === 'error'
              ? t('compact.bodyError', { error: row.error ?? t('quota.unknown') })
              : t('compact.bodyDone')), row)
          if (row.summary !== undefined && row.summary !== '') {
            for (const wrapped of wrap(row.summary, Math.max(1, width - 2)).slice(0, 12)) {
              addDisplay(this.styleLine('assistant', `  ${wrapped}`), row)
            }
          }
        }
        continue
      }
      pushRow(row.kind, row.text, row)
      if (compact && row.kind === 'assistant') {
        const burst = compactBurstByReply.get(row)
        const lastAssistant = this.rows.findLast((item): item is Extract<Row, { kind: 'assistant' }> => item.kind === 'assistant')
        if (burst !== undefined && (row !== lastAssistant || this.streaming === undefined)) {
          this.paintCompactBurst(addDisplay, burst.groups, width)
        }
      }
    }

    if (this.streaming !== undefined) {
      if (!compact && this.showReasoning && this.streaming.reasoning !== '') {
        const block = this.streamingReasoning ??= { kind: 'streaming-reasoning', expanded: false }
        const focused = this.focusedRow === block
        const marker = block.expanded ? '▾' : '▸'
        const spinner = SPINNER[Math.floor(Date.now() / 120) % SPINNER.length]
        const chars = this.streaming.reasoning.length
        const elapsed = this.thinkingStartedAt === undefined
          ? 0
          : Math.floor((Date.now() - this.thinkingStartedAt) / 1000)
        const header = t('reason.live', { marker, spinner, chars })
          + (elapsed > 0 ? t('reason.elapsed', { seconds: elapsed }) : '')
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
    if (compact) {
      const lastAssistant = this.rows.findLast((row): row is Extract<Row, { kind: 'assistant' }> => row.kind === 'assistant')
      if (this.streaming !== undefined) {
        const openBurst = compactBursts.find(burst => burst.after === lastAssistant)
        if (openBurst !== undefined) this.paintCompactBurst(addDisplay, openBurst.groups, width)
      }
      const leading = compactBursts.find(burst => burst.after === undefined)
      if (leading !== undefined && !paintedLeadingCompact) {
        this.paintCompactBurst(addDisplay, leading.groups, width)
      }
    }
    if (this.waitCardVisible()) {
      const copy = waitCardCopy(this.waitCardSource())
      const started = this.waitStartedAt ?? Date.now()
      const elapsed = fmtElapsedCompact((Date.now() - started) / 1000)
      const hint = t('wait.interrupt', { elapsed })
      const spinner = this.spinnerFrame()
      const header = this.color
        ? `${spinner} ${shimmerText(copy.header, Date.now(), true)}  ${this.styleLine('system', hint)}`
        : `${spinner} ${copy.header}  ${hint}`
      addDisplay(header)
      for (const line of wrapWaitDetails(copy.detail ?? '', width)) {
        addDisplay(this.styleLine('system', line))
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
          const template = onboardTemplate(ob)
          const providerLabel = `${template.label}${template.defaultBaseUrl === '' ? '' : `（${template.defaultBaseUrl}）`}`
          switch (ob.step) {
            case 'provider': {
              const options = this.mergedProviderEntries(ob)
              addDialog(t('onboard.title'))
              if (options.length === 0) {
                addDialog(t('onboard.catalogEmpty'))
                break
              }
              const start = pickerWindowStart(ob.providerCursor, options.length)
              const end = Math.min(options.length, start + PICKER_WINDOW)
              if (start > 0) addDialog(`  ${t('picker.moreAbove', { count: start })}`)
              for (let index = start; index < end; index += 1) {
                const option = options[index]
                if (option === undefined) continue
                const focused = index === ob.providerCursor ? '›' : ' '
                addDialog(` ${focused} ○ ${option.label}${option.detail === '' ? '' : ` — ${option.detail}`}`)
              }
              if (end < options.length) addDialog(`  ${t('picker.moreBelow', { count: options.length - end })}`)
              if (this.input.trim() !== '') addDialog(t('onboard.catalogHint', { count: options.length }))
              addDialog(t('onboard.pickHint'))
              break
            }
            case 'id':
              addDialog(t('onboard.providerLine', { label: providerLabel }))
              addDialog(t('onboard.idPrompt'))
              addDialog(t('onboard.default', { value: template.defaultId }))
              addDialog(t('onboard.enterEsc'))
              break
            case 'base-url':
              addDialog(t('onboard.providerLine', { label: providerLabel }))
              addDialog(t('onboard.basePrompt', {
                fallback: template.defaultBaseUrl !== ''
                  ? template.defaultBaseUrl
                  : ob.providerType === 'catalog' ? t('onboard.baseFallbackCatalog') : t('onboard.baseFallback'),
              }))
              addDialog(t('onboard.enterEsc'))
              break
            case 'models':
              addDialog(t('onboard.providerLine', { label: providerLabel }))
              addDialog(t('onboard.modelsPrompt'))
              addDialog(ob.models.length > 0
                ? t('onboard.modelsFetched', { count: ob.models.length, list: formatModelList(ob.models, 6) })
                : t('onboard.default', { value: template.defaultModels.join(', ') }))
              if (template.api !== undefined) addDialog(t('onboard.ctrlF'))
              if (ob.providerType === 'catalog') addDialog(t('onboard.modelsCatalogHint'))
              addDialog(t('onboard.enterEsc'))
              break
            case 'confirm':
              addDialog(t('onboard.confirmTitle'))
              addDialog(t('onboard.confirmProvider', { label: providerLabel }))
              addDialog(`  Provider ID: ${ob.providerId}`)
              addDialog(t('onboard.confirmBase', { url: ob.baseUrl === '' ? (template.defaultBaseUrl || t('onboard.defaultParen')) : ob.baseUrl }))
              addDialog(t('onboard.confirmApi', {
                api: template.api ?? (ob.providerType === 'catalog' ? t('onboard.apiCatalog') : 'deepseek-official'),
              }))
              addDialog(t('onboard.confirmModels', { list: formatModelList(ob.models, 8) }))
              addDialog(t('onboard.confirmKey', {
                head: sliceCodePoints(ob.key, 6),
                tail: lastCodePoints(ob.key, 4),
                length: ob.key.length,
              }))
              addDialog(t('onboard.confirmHint'))
              break
          }
        }
      } else {
        const d = this.dialog
        const review = planReviewOf(d.question)
        if (review) {
          addDialog(t('dialog.planReview', { index: d.index + 1, total: d.total }) + (d.question.header === undefined ? '' : ` · ${d.question.header}`))
          addDialog(d.question.question)
          if (d.question.detail !== undefined && d.question.detail !== '') {
            for (const line of renderMarkdownLines(d.question.detail, Math.max(1, width - 2), this.color).slice(0, 16)) {
              dialogLines.push(this.styleLine('assistant', line))
            }
          }
        } else {
          addDialog(t('dialog.ask', { index: d.index + 1, total: d.total, question: d.question.question }))
          if (d.question.header !== undefined && d.question.header !== '') addDialog(d.question.header)
          if (d.question.detail !== undefined && d.question.detail !== '') {
            addDialog(truncate(d.question.detail, 6))
          }
        }
        const options = d.question.options ?? []
        const approve = d.question.intent?.approve
        const start = pickerWindowStart(d.cursor, options.length)
        const end = Math.min(options.length, start + PICKER_WINDOW)
        if (start > 0) addDialog(`  ${t('picker.moreAbove', { count: start })}`)
        for (let index = start; index < end; index += 1) {
          const option = options[index]
          if (option === undefined) continue
          const marker = d.selected.has(index) ? '●' : '○'
          const key = QUESTION_OPTION_KEYS[index] ?? '↕'
          const focused = index === d.cursor ? '›' : ' '
          const recommended = option.label === approve ? t('dialog.recommended') : ''
          const extra = option.description === undefined ? '' : ` — ${option.description}`
          addDialog(` ${focused}${key} ${marker} ${option.label}${recommended}${extra}`)
        }
        if (end < options.length) addDialog(`  ${t('picker.moreBelow', { count: options.length - end })}`)
        if (options.length === 0) {
          addDialog(t('dialog.freeform'))
        }
        addDialog(d.question.multiSelect === true ? t('dialog.multiHint') : t('dialog.singleHint'))
      }
    }

    const fitLine = (text: string): string => truncateToWidth(text, Math.max(1, width))
    const headerLines = [
      this.styleLine('system', fitLine(`${t('boot.banner')}  [${this.presetName}]  ${this.currentSelectionLabel()}`)),
      this.styleLine('system', repeatToWidth('─', width)),
    ]
    if (this.scrollOffset > 0) {
      headerLines.push(this.styleLine('system', fitLine(t('dialog.scrolled', { count: this.scrollOffset }))))
    }
    this.commandSuggestions = this.dialog === undefined ? this.buildSuggestions() : []
    if (this.suggestionIndex >= this.commandSuggestions.length) {
      this.suggestionIndex = Math.max(0, this.commandSuggestions.length - 1)
    }
    const suggestionLines: string[] = []
    const suggestionStart = pickerWindowStart(this.suggestionIndex, this.commandSuggestions.length)
    const suggestionEnd = Math.min(this.commandSuggestions.length, suggestionStart + PICKER_WINDOW)
    if (suggestionStart > 0) {
      suggestionLines.push(this.styleLine('system', fitLine(`  ${t('suggest.moreAbove', { count: suggestionStart })}`)))
    }
    for (let index = suggestionStart; index < suggestionEnd; index += 1) {
      const command = this.commandSuggestions[index]
      if (command === undefined) continue
      const marker = index === this.suggestionIndex ? '›' : ' '
      const line = `  ${marker} /${command.name.padEnd(14)} ${command.description}${command.local ? '' : '  (dsh)'}`
      suggestionLines.push(index === this.suggestionIndex && this.color
        ? `\x1b[7m${fitLine(line)}\x1b[27m`
        : this.styleLine('system', fitLine(line)))
    }
    if (suggestionEnd < this.commandSuggestions.length) {
      suggestionLines.push(this.styleLine(
        'system',
        fitLine(`  ${t('suggest.moreBelow', { count: this.commandSuggestions.length - suggestionEnd })}`),
      ))
    }

    const promptPlain = this.color ? '❯ ' : '> '
    const prompt = this.color ? `\x1b[36m${promptPlain.trimEnd()}\x1b[0m ` : promptPlain
    const promptWidth = displayWidth(promptPlain)
    const masked = this.dialog?.kind === 'onboarding' && this.onboarding?.step === 'key'
    const inputTextWidth = Math.max(1, width - promptWidth)
    const inputView: InputView = masked
      ? { text: '•'.repeat(this.input.length), cursorOffset: displayWidth('•'.repeat(this.cursor)), folded: false }
      : this.inputFolded
        ? foldInputView(this.input, this.cursor, inputTextWidth)
        : { text: this.input, cursorOffset: displayWidth(this.input.slice(0, this.cursor)), folded: false }
    const inputTextLines = wrap(inputView.text, inputTextWidth)
    const inputDisplayLines = inputTextLines.map((line, index) =>
      index === 0 ? `${prompt}${line}` : line)

    // Folded/masked views are one logical row around the caret. Place the
    // cursor with the prompt width of that row — never wrap the offset
    // across the full terminal grid, which parked the caret on a later
    // chrome line after a long paste. Un-folded multi-line input still
    // maps through wrap() so newlines stay on the right visual row.
    //
    // A caret after a glyph that filled the row must move to col 1 of the
    // next row (and that row must exist). Parking it on the last cell
    // punches through the glyph; parking at width+1 trips DEC auto-margin
    // onto the stats line.
    let cursorRowOffset: number
    let column: number
    if (inputView.folded || masked) {
      cursorRowOffset = 0
      column = Math.min(width, promptWidth + inputView.cursorOffset + 1)
    } else {
      const pos = cursorVisualPosition(inputView.text, this.cursor, inputTextWidth)
      while (pos.row >= inputDisplayLines.length) inputDisplayLines.push('')
      cursorRowOffset = pos.row
      const rowPrefix = pos.row === 0 ? promptWidth : 0
      column = Math.min(width, rowPrefix + pos.col + 1)
    }
    const inputRows = Math.max(1, inputDisplayLines.length)

    const yieldPlanDock = this.dialog !== undefined || suggestionLines.length > 0
    const planDockLines = this.shouldDockPlan()
      ? this.paintPlanDock(width, yieldPlanDock)
      : []
    const inputDivider = this.styleLine('system', repeatToWidth('─', width))
    const reserved = RESERVED_BOTTOM_LINES + (inputRows - 1) + headerLines.length + suggestionLines.length + planDockLines.length + 1
    const available = Math.max(0, height - reserved - dialogLines.length)
    const window = windowTranscript({
      lines: display,
      refs: displayRefs,
      available,
      scrollOffset: this.scrollOffset,
      reveal: this.pendingReveal,
    })
    this.pendingReveal = undefined
    this.scrollOffset = window.scrollOffset
    const start = window.start
    const visible = window.visibleLines
    const visibleRefs = window.visibleRefs
    this.clickableRows.clear()
    this.paintedLinkHitsByRow.clear()
    for (let index = 0; index < visibleRefs.length; index++) {
      const ref = visibleRefs[index]
      const screenY = headerLines.length + index + 1
      if (ref !== undefined && 'expanded' in ref) this.clickableRows.set(screenY, ref)
      const hits = paintedLinkHits(visible[index] ?? '')
      if (hits.length > 0) this.paintedLinkHitsByRow.set(screenY, hits)
    }
    const dockPlan = this.findLivePlanRow()
    if (dockPlan !== undefined && planDockLines.length > 0) {
      const dockTop = headerLines.length + visible.length + 1
      this.clickableRows.set(dockTop, dockPlan)
    }

    const linkChip = formatLinkQualityChip(
      this.paintLink, this.paintIntervalMs, this.paintRttMs, this.paintProbed, this.color,
    )
    const statsGroups = footerStatsGroups(statsRowOf(this.statsTracker.snapshot()))
    const statsPlain = fitFooterStatsLine(
      formatLinkQualityChip(this.paintLink, this.paintIntervalMs, this.paintRttMs, this.paintProbed, false),
      statsGroups,
      Math.max(1, width),
    )
    const chipVisible = formatLinkQualityChip(this.paintLink, this.paintIntervalMs, this.paintRttMs, this.paintProbed, false)
    const statsLine = statsPlain.startsWith(chipVisible)
      ? clipAnsiToWidth(`${linkChip}${this.styleLine('system', statsPlain.slice(chipVisible.length))}`, Math.max(1, width))
      : this.styleLine('system', statsPlain)

    const idleMs = Date.now() - this.lastActivity
    const livePlan = this.findLivePlanRow()
    const liveGoal = this.rows.findLast((row): row is Extract<Row, { kind: 'goal' }> => row.kind === 'goal')
    const current = this.selectionRef?.current
    const provider = this.currentProviderId()
    const quotaWindow = this.quotaSnapshot === undefined ? undefined : tightestQuotaWindow(this.quotaSnapshot)
    const balanceText = this.balanceSnapshot !== undefined && this.balanceSnapshot.provider === provider
      ? formatFooterBalance(this.balanceSnapshot)
      : undefined
    const waitingQuestions = this.rows.some(row => row.kind === 'question' && row.status === 'waiting')
    const compacting = this.rows.some(row => row.kind === 'compaction' && row.status === 'running')
    const parentModel = current?.model ?? this.agent.options.model ?? ''
    const sub = this.subagentSelection.current
    const footer = {
      running: this.agent.status === 'running',
      planReview: this.dialog?.kind === 'questions' && planReviewOf(this.dialog.question),
      waitingQuestion: waitingQuestions || (this.dialog?.kind === 'questions' && !planReviewOf(this.dialog.question)),
      compacting,
      ...(this.llmRetry === undefined ? {} : { retry: this.llmRetry }),
      subagents: this.activeSubagents.size,
      tools: this.openToolCalls.size,
      planLeftOpen: livePlan?.turnLeftOpen === true,
      planPending: livePlan?.pending === true,
      planActive: livePlan?.active === true,
      ...(liveGoal?.phase === 'active' || liveGoal?.phase === 'paused' || liveGoal?.phase === 'blocked'
        ? { goalPhase: liveGoal.phase }
        : {}),
      idleMs,
      model: parentModel,
      preset: this.presetName,
      ...(current?.reasoningEffort === undefined ? {} : { effort: current.reasoningEffort }),
      provider,
      parentModel,
      subModel: sub.model,
      ...(sub.provider === undefined ? {} : { subProvider: sub.provider }),
      ...(sub.reasoningEffort === undefined ? {} : { subEffort: String(sub.reasoningEffort) }),
      ...(quotaWindow === undefined || this.quotaSnapshot === undefined || this.quotaSnapshot.provider !== provider
        ? {}
        : { quotaCode: this.quotaSnapshot.plan, quotaPercent: quotaWindow.remainingPercent }),
      ...(this.contextPressure === undefined
        ? {}
        : { contextChip: formatContextPressureChip(this.contextPressure, false) }),
      ...(balanceText === undefined ? {} : { balanceText }),
      ...(this.searchHits.length > 0 && this.searchIndex >= 0
        ? { search: { index: this.searchIndex, total: this.searchHits.length } }
        : {}),
      foldedInput: inputView.folded,
      multiLineInput: inputRows > 1,
      queued: this.pendingMessages.size,
      cwdLabel: formatFooterCwd(this.workspaceCwd()),
      compactView: this.isCompactView(),
    } satisfies FooterStatusInput
    const activity = footerActivity(footer)
    const activityText = activity.kind === 'compacting'
      ? `${this.spinnerFrame()} ${activity.text}`
      : activity.kind === 'subagents'
        ? `${this.spinnerFrame(160)} ${activity.text}`
        : activity.text
    const identity = footerIdentityParts(footer)
    const statusText = fitFooterStatusLine(activityText, identity, Math.max(1, width))
    const statusLine = this.contextPressure === undefined || !this.color
      ? this.styleLine('system', statusText)
      : this.styleLine('system', statusText).replace(
        formatContextPressureRing(this.contextPressure.percent),
        `\x1b[${contextPressureRingColor(this.contextPressure.level)}m${formatContextPressureRing(this.contextPressure.percent)}\x1b[0m\x1b[90m`,
      )

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
      statsPlain,
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
      this.dialog?.kind === 'questions' ? String(this.dialog.cursor) : '',
      planDockLines.join('\n'),
      String(chromeStart),
    ].join('\x1f')
    const chromeChanged = chromeKey !== this.lastChromeKey || chromeStart !== this.lastChromeStart
    const transcriptScrolled = start !== this.lastTranscriptStart
    const sizeChanged = this.forceFullPaint
      || width !== this.lastPaintWidth
      || height !== this.lastPaintHeight
      || transcriptScrolled
    this.forceFullPaint = false

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
      previousChromeStart: this.lastChromeStart,
      cursorRow: row,
      cursorColumn: column,
    }))
    this.lastPaintCursorRow = row
    this.lastPaintCursorColumn = Math.min(width, Math.max(1, column))
    this.lastPaintRows = paintRows.length > height ? paintRows.slice(0, height) : paintRows
    this.lastChromeKey = chromeKey
    this.lastPaintWidth = width
    this.lastPaintHeight = height
    this.lastChromeStart = chromeStart
    this.lastTranscriptStart = start
    const cwdChip = formatFooterCwd(this.workspaceCwd())
    this.cwdChipRow = cwdChip !== '' && statusText.includes(cwdChip)
      ? Math.min(height, paintRows.length)
      : undefined
  }

  private workspaceCwd(): string {
    return this.agent.session.header?.cwd ?? process.cwd()
  }

  private announceWorkspaceCwd(): void {
    const cwd = this.workspaceCwd()
    this.pushRow({ kind: 'system', text: t('cwd.full', { cwd }) })
    this.markDirty()
  }

  private buildSuggestions(): CommandSuggestion[] {
    // The host's commands arrive last (a local name wins the duplicate) and are
    // localized here, where the i18n catalog is already loaded.
    const foreign: CommandSuggestion[] = (this.ctx.get('commands')?.list(this.agent) ?? [])
      .map(command => {
        const desc = t(`cmd.${command.name}`, undefined, command.description)
        return {
          name: command.name,
          description: commandAcceptsAttachments(command.input)
            ? t('cmd.withImagesSuffix', { desc })
            : desc,
          local: false,
        }
      })
    return commandSuggestions(this.input, foreign)
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

  /** Compact session stats groups for the first footer row. */
  private statsText(): string {
    return footerStatsGroups(statsRowOf(this.statsTracker.snapshot())).join(' │ ')
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
      this.write(t('title.done', { suffix: titleSuffix }))
      return
    }
    if (this.agent.status === 'running') {
      if (now - this.lastTitleUpdateAt < 800) return
      this.lastTitleUpdateAt = now
      const spinner = SPINNER[Math.floor(now / 800) % SPINNER.length]
      let detail = t('title.running')
      if (this.dialog?.kind === 'questions') {
        detail = planReviewOf(this.dialog.question) ? t('question.planTitle') : t('title.waitAnswer')
      } else if (this.rows.some(row => row.kind === 'compaction' && row.status === 'running')) {
        detail = t('title.compacting')
      } else if (this.activeSubagents.size > 0) {
        detail = t('title.subagents', { count: this.activeSubagents.size })
      } else if (this.openToolCalls.size > 0) {
        detail = t('title.tools', { count: this.openToolCalls.size })
      } else if (this.findLivePlanRow()?.active === true) {
        detail = t('title.planMode')
      } else {
        const liveGoal = this.rows.findLast((row): row is Extract<Row, { kind: 'goal' }> => row.kind === 'goal')
        if (liveGoal?.phase === 'active') detail = t('footer.goalActive')
        else if (liveGoal?.phase === 'blocked') detail = t('footer.goalBlocked')
      }
      this.write(`\x1b]0;dsh ${spinner} ${detail}${titleSuffix}\x07`)
      return
    }
    this.write(t('title.idle', { suffix: titleSuffix }))
  }

  /** Terminal bell on completion (opt out with DSH_TUI_NO_BELL=1). */
  private playCompletionSignal(): void {
    const disabled = process.env.DSH_TUI_NO_BELL === '1' || process.env.DSH_TUI_NO_BELL === 'true'
    if (disabled) return
    this.write('\x07')
  }

  private render = (): void => {
    if (!this.dirty || this.exiting) return
    if ((this.displayDetached || this.headlessDisplay) && this.displayHost?.attached !== true) return
    if (
      this.agent.status === 'running'
      && Date.now() - this.lastActivity > STALL_WARNING_MS
      && !this.stalledWarningShown
      && this.openToolCalls.size === 0
      && this.activeSubagents.size === 0
    ) {
      this.stalledWarningShown = true
      this.pushRow({ kind: 'error', text: t('stall.warning') })
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
      kind === 'assistant' ? '37' :
      kind === 'reasoning' ? '2;3' :
      kind === 'brand' ? '1;38;2;77;107;253' :
      kind === 'tool' || kind === 'tool-result' ? '37' :
      // Codex-like: muted add/del that blend into the terminal background.
      kind === 'diff-add' ? '38;2;122;168;116;48;2;18;42;24' :
      kind === 'diff-del' ? '38;2;196;122;122;48;2;48;20;20' :
      kind === 'diff-path' ? '1;36' :
      kind === 'todo-done' ? '2;32' :
      kind === 'todo-active' ? '1;36' :
      kind === 'todo-pending' ? '90' :
      kind === 'plan-dock' ? '38;5;180' :
      kind === 'error' ? '31' :
      '90'
    return `\x1b[${code}m${safe}\x1b[0m`
  }

  /**
   * Fold one live or durable stream chunk into the in-progress assistant
   * row. 0.1.2 hosts append `assistant/chunk`; 0.1.5 emits the same chunk
   * on `agent/assistant-stream` and never writes it to the log.
   */
  private applyStreamChunk(streamed: {
    chunk: StreamChunkLike
    turn: number
    step: number
    time: number
    stepKnown: boolean
  }, statsOnly = false): void {
    const { chunk } = streamed
    if (isTokenDeltaChunk(chunk)) {
      this.statsTracker.noteFirstToken(streamed.turn, streamed.step, streamed.time)
    }
    if (chunk.type === 'usage' && chunk.usage !== undefined && streamed.stepKnown) {
      this.statsTracker.recordUsage(streamed.turn, streamed.step, chunk.usage as TokenUsage)
    }
    if (statsOnly) return
    if (chunk.type === 'text-delta') {
      this.streaming ??= { text: '', reasoning: '' }
      this.streaming.text += chunk.text ?? ''
      this.markDirty()
    } else if (chunk.type === 'reasoning-delta') {
      this.streaming ??= { text: '', reasoning: '' }
      if (this.streaming.reasoning === '' && (chunk.text ?? '') !== '') {
        this.thinkingStartedAt = Date.now()
        this.streamingReasoning = { kind: 'streaming-reasoning', expanded: false }
      }
      this.streaming.reasoning += chunk.text ?? ''
      this.markDirty()
    }
  }

  /**
   * 0.1.5 live tokens arrive as process-local `agent/assistant-stream`
   * frames (start / chunk / end). Chunk frames carry the same
   * `StreamChunk` the 0.1.2 log used to store as `assistant/chunk`.
   */
  readonly handleAssistantStream = (...args: unknown[]): void => {
    const payload = args[0] as { agent?: Agent; frame?: unknown } | undefined
    if (payload === undefined) return
    const agent = payload.agent
    if (agent === undefined || agent !== this.agent) return
    if (this.replaying) return
    this.lastActivity = Date.now()
    this.refreshContextPressure()
    const owner = streamFrameOwner(payload.frame)
    if (owner !== undefined) {
      // Live chunk frames carry no turn/step: remember the attempt's step here
      // or every chunk is attributed to step 0 and the stats never match.
      this.liveStreamOwner = owner
      return
    }
    if ((payload.frame as { type?: unknown } | undefined)?.type === 'end') {
      this.liveStreamOwner = undefined
      return
    }
    const attemptId = streamFrameAttemptId(payload.frame)
    const current = this.liveStreamOwner
    const fallback = current !== undefined && (attemptId === undefined || attemptId === current.attemptId)
      ? current
      : this.statsTracker.currentStep()
    const streamed = streamChunkOf(payload.frame, fallback)
    if (streamed !== undefined) this.applyStreamChunk(streamed)
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
      : defaultSubagentModelForProvider(provider, [], this.selectionRef?.current?.model)
    return {
      ...resolved,
      provider,
      model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }
  }

  readonly handleSessionEvent = (session: { id: SessionId }, event: SessionEvent): void => {
    if (this.replayQueue !== undefined) {
      // The replay yields between chunks, so live events can arrive mid-load.
      // Folding them now would interleave newer events under older history;
      // park them and drain in arrival order once the walk is done.
      this.replayQueue.push({ session, event })
      return
    }
    this.applySessionEvent(session, event)
  }

  private applySessionEvent(session: { id: SessionId }, event: SessionEvent): void {
    if (session.id !== this.agent.id) {
      if (this.subagentSessions.has(session.id)) this.handleSubagentSessionEvent(session.id, event)
      return
    }
    this.lastActivity = Date.now()
    if (this.replaying && isAssistantStreamEvent(event)) {
      // Replay skips the in-progress row, but durable chunks still carry the
      // timing the footer needs: a resumed session must keep TTFT and tok/s.
      const streamed = streamChunkOf(event)
      if (streamed !== undefined) this.applyStreamChunk(streamed, true)
      return
    }
    if (!this.replaying) this.refreshContextPressure()
    const eventType = sessionEventType(event)
    if (eventType === 'assistant/chunk') {
      const streamed = streamChunkOf(event)
      if (streamed !== undefined) this.applyStreamChunk(streamed)
      return
    }
    switch (event.type) {
      case 'user/message': {
        const text = event.data.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
        if (text !== '') {
          const source = event.data.source as { kind?: string; plugin?: string; form?: string; summary?: string }
          const sourceKind = source.kind ?? ''
          if (sourceKind === 'user') {
            this.pushRow({ kind: 'user', text: `❯ ${text}` })
            if (!this.replaying) this.beginWait()
          } else if (sourceKind === 'plugin' && source.form === 'notice') {
            const summary = source.summary?.trim() ?? ''
            // Body stays off the workspace (the model still received it).
            const last = this.rows.at(-1)
            const alreadyShown = last?.kind === 'system' && last.text === summary
            if (summary !== '' && !alreadyShown) this.pushRow({ kind: 'system', text: summary })
            if (!this.replaying) this.beginWait()
          } else if (isPromptInjectionMessage(sourceKind, text, source.plugin)) {
            this.pushPromptInjection(text, source.plugin)
          } else if (sourceKind === 'plugin' && source.form === 'snapshot') {
            this.pushRow({ kind: 'system', text: text })
          } else {
            this.pushRow({ kind: 'system', text: t('prompt.contextPrefix', { text }) })
          }
          this.streaming = undefined
          this.streamingReasoning = undefined
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
        // The settlement's own packed stream is authoritative: a retried step
        // keeps the failed attempt's first token in the live latch, and spanning
        // both attempts reported a rate ~20x off. 0.1.2 has no `stream` and still
        // relies on the replayed `assistant/chunk` events (or the live latch).
        this.statsTracker.settleMessage({
          turn: event.data.turn,
          step: event.data.step,
          time: event.time,
          firstTokenTime: streamFirstTokenTime((event.data as { stream?: unknown }).stream),
          outputTokens: event.data.usage?.outputTokens,
        })
        if (event.data.usage !== undefined) {
          this.statsTracker.recordUsage(event.data.turn, event.data.step, event.data.usage)
        }
        const reasoningExpanded = this.streamingReasoning?.expanded ?? false
        const interrupted = event.data.interrupted === true
        this.streaming = undefined
        this.streamingReasoning = undefined
        this.thinkingStartedAt = undefined
        const interruptedMark = interrupted ? t('stream.interrupted') : ''
        if (reasoning !== '') {
          this.pushRow({ kind: 'reasoning', text: `${reasoning}${interruptedMark}`, expanded: reasoningExpanded })
        }
        if (text !== '') {
          this.pushRow({ kind: 'assistant', text: `${text}${interruptedMark}` })
        } else if (interrupted && reasoning === '') {
          this.pushRow({ kind: 'system', text: t('stream.interruptedEmpty') })
        }
        this.markDirty()
        break
      }
      case 'tool/call': {
        this.openToolCalls.set(String(event.data.callId), event.data.name)
        this.toolCallNames.set(String(event.data.callId), event.data.name)
        this.statsTracker.noteToolStart(String(event.data.callId), event.time)
        if (!HIDDEN_TOOL_NAMES.has(event.data.name)) {
          const present = presentToolCall(event.data.name, event.data.arguments)
          const previous = this.findMergeableToolRow({ name: event.data.name, args: event.data.arguments })
          if (previous !== undefined) {
            this.mergeIntoToolCard(previous, {
              callId: String(event.data.callId),
              name: event.data.name,
              args: event.data.arguments,
              title: present.title,
              summary: present.summary,
              ...present.diff === undefined ? {} : { diff: present.diff },
            })
          } else {
            const row: Row = {
              kind: 'tool',
              callId: String(event.data.callId),
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
          }
        }
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
        this.statsTracker.noteToolEnd(String(event.data.message.source.callId), event.time)
        const callId = String(event.data.message.source.callId)
        const row = this.findToolRowByCallId(callId)
        const output = collectText(event.data.message.content)
        if (row !== undefined) {
          const metaDiffs = diffMetaDiffs(event.data.meta)
          if (metaDiffs !== null) {
            row.diff = (row.repeats ?? 1) > 1 && row.diff !== undefined && row.diff.length > 0
              ? [...row.diff, ...metaDiffs]
              : metaDiffs
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
          if (READ_TOOL_NAMES.has(row.name)) {
            row.totalChars = (row.totalChars ?? 0) + row.output.length
            row.totalLines = (row.totalLines ?? 0) + countOutputLines(row.output)
          }
        } else {
          const sourceName = (event.data.message.source as { name?: unknown }).name
          const recordedName = this.toolCallNames.get(callId)
            ?? (typeof sourceName === 'string' ? sourceName : '')
          if (recordedName !== '' && HIDDEN_TOOL_NAMES.has(recordedName)) break
          // Never title a card with the call id (`call-<uuid>`). Prefer the
          // recorded tool name; fall back to a generic tool card.
          const toolName = recordedName === '' || recordedName.startsWith('call-')
            ? 'tool'
            : recordedName
          const present = presentToolCall(toolName, '')
          this.pushRow({
            kind: 'tool',
            callId,
            name: toolName,
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
        this.statsTracker.noteStepStart(event.data.turn, event.data.step, event.time)
        this.markDirty()
        break
      }
      case 'step/end': {
        this.statsTracker.noteStepEnd(event.data.turn, event.data.step)
        if (!this.replaying) {
          this.quotaStepsSinceRefresh += 1
          const every = quotaRefreshEverySteps(this.quotaSnapshot === undefined
            ? undefined
            : tightestQuotaWindow(this.quotaSnapshot))
          if (this.quotaStepsSinceRefresh >= every) {
            this.quotaStepsSinceRefresh = 0
            void this.refreshQuota({ reason: 'step', announce: false }).catch(() => {})
          }
        }
        this.markDirty()
        break
      }
      case 'sandbox/mode':
        this.hostSandboxMode = String((event.data as { mode?: unknown }).mode ?? '')
        break
      case 'approval/policy':
        this.hostApprovalPolicy = String((event.data as { policy?: unknown }).policy ?? '')
        if (this.hostApprovalPolicy === 'never') this.warnApprovalMismatch()
        break
      case 'turn/start':
        this.stalledWarningShown = false
        this.llmRetry = undefined
        this.status = `turn ${event.data.turn} running`
        this.markDirty()
        break
      case 'turn/end': {
        const reason = event.data.reason
        this.openToolCalls.clear()
        this.toolCallNames.clear()
        this.statsTracker.noteTurnEnd()
        this.stalledWarningShown = false
        this.pendingMessages.clear()
        // Aborted/errored turns may close without an assembled
        // assistant/message; never leave a half-streamed thinking block behind.
        this.streaming = undefined
        this.streamingReasoning = undefined
        this.thinkingStartedAt = undefined
        this.endWait()
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
          this.pushRow({ kind: 'error', text: t('turn.failed', { turn: event.data.turn, error: reason.error.message }) })
        }
        const livePlan = this.findLivePlanRow()
        if (livePlan !== undefined && reason.kind === 'completed') {
          applyTurnEndToPlan(livePlan)
          if (livePlan.turnLeftOpen === true) {
            this.pushRow({
              kind: 'system',
              text: planDockNote(livePlan),
            })
            // Driver is still `running` while `turn/end` is appended. Wait for
            // idle so this follow-up does not make `/compact` report busy.
            queueMicrotask(() => this.flushPlanCloseNudge())
          }
        }
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
      // Work is running again, so any reattach that raced a former hangup has
      // long been honored; keeping the flag would swallow the next drop.
      this.reattachedDuringHangup = false
      this.completionSignaled = false
      this.completedAt = 0
      if (this.waitStartedAt === undefined) this.beginWait()
    } else if (!this.completionSignaled && this.status === 'running') {
      this.completionSignaled = true
      this.completedAt = Date.now()
      this.updateTerminalTitle()
      this.playCompletionSignal()
      this.endWait()
    }
    if (status !== 'running') this.endWait()
    this.status = status === 'running' ? 'running' : 'idle'
    if (status !== 'running') {
      this.flushPlanCloseNudge()
      this.maybeIdleAutoCompact()
      // A leftover Host exists only because this turn was still running when
      // SSH dropped. Now that it settled, give the user a short window to
      // reattach before exiting and freeing the session's write lock for the
      // browser surface.
      this.armIdleExitTimer()
    } else {
      this.clearIdleExitTimer()
    }
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
    this.pushRow({ kind: 'error', text: t('agent.disposed') })
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
          ? t('plan.entered')
          : t('plan.exited'),
      })
      this.markDirty()
      return
    }
    if (type === 'todo/write') {
      this.upsertPlanRow({ todos: parsePlanTodos((data as { todos?: unknown } | undefined)?.todos) })
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
      this.pushRow({ kind: 'system', text: t('retry.generatingTitle') })
      this.markDirty()
      return
    }
    if (type === 'llm/retry') {
      const retry = typeof (data as { retry?: unknown } | undefined)?.retry === 'number' ? (data as { retry: number }).retry : 1
      const maxRetries = typeof (data as { maxRetries?: unknown } | undefined)?.maxRetries === 'number' ? (data as { maxRetries: number }).maxRetries : retry
      const delayMs = typeof (data as { delayMs?: unknown } | undefined)?.delayMs === 'number' ? (data as { delayMs: number }).delayMs : 0
      const failure = (data as { failure?: { message?: unknown } } | undefined)?.failure
      const message = typeof failure?.message === 'string' ? failure.message : t('retry.busy')
      this.llmRetry = { retry, maxRetries, delayMs, message }
      this.pushRow({
        kind: 'system',
        text: t('retry.progress', {
          ms: Math.round(delayMs),
          retry,
          max: maxRetries,
          message,
        }),
      })
      this.markDirty()
      return
    }
    if (type === 'llm/retry-started') {
      if (this.llmRetry !== undefined) {
        this.pushRow({ kind: 'system', text: t('retry.started', { retry: this.llmRetry.retry }) })
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
      this.pushRow({ kind: 'system', text: t('team.event', { type }) })
      this.markDirty()
    }
  }

  private findCompactionRow(id?: string): Extract<Row, { kind: 'compaction' }> | undefined {
    if (id !== undefined && id !== '') {
      const named = this.rows.findLast((row): row is Extract<Row, { kind: 'compaction' }> =>
        row.kind === 'compaction' && row.compactionId === id)
      if (named !== undefined) return named
    }
    return undefined
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
      this.status = t('compact.status')
      this.markDirty()
      return
    }
    const row = this.findCompactionRow(compactionId)
    if (type === 'compaction/prune') {
      const tokens = typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0
      // Automatic tool-result prunes have no compactionId. Never attach them
      // to a leftover /compact card — that made the next /compact look failed.
      if (row !== undefined) {
        row.pruneCount += 1
        row.prunedTokens += Math.max(0, tokens)
        this.markDirty()
      }
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
          text: error === undefined ? t('compact.finished') : t('compact.failedNotice', { error }),
        })
      }
      if (this.status.startsWith(t('compact.short')) || this.status.startsWith('compact')) {
        this.status = this.agent.status === 'running' ? 'running' : 'idle'
      }
      this.idleCompactInFlight = false
      this.markDirty()
      this.refreshContextPressure()
    }
  }

  private readContextPressure(): ContextPressureView | undefined {
    const projections = this.ctx.get('sessionProjections') as {
      snapshot?: (session: unknown) => { values?: { contextPressure?: unknown } }
    } | undefined
    const fromProjection = parseContextPressure(projections?.snapshot?.(this.agent.session)?.values?.contextPressure)
    if (fromProjection !== undefined) return contextPressureView(fromProjection)
    const requestContext = (this.agent.session as { requestContext?: () => { contextWindow?: unknown } | undefined }).requestContext?.()
    const window = typeof requestContext?.contextWindow === 'number' && requestContext.contextWindow > 0
      ? requestContext.contextWindow
      : undefined
    if (window === undefined) return undefined
    const used = promptPressureTokens(this.stats.usage)
    if (used <= 0) return undefined
    return contextPressureView({ usedTokens: used, contextWindow: window })
  }

  private refreshContextPressure(options: { compact?: boolean } = {}): void {
    const next = this.readContextPressure()
    const previous = this.contextPressure
    this.contextPressure = next
    if (this.replaying) {
      this.contextAlertLevel = next?.level === 'ok' ? undefined : next?.level
      return
    }
    if (next !== undefined && next.level !== 'ok' && next.level !== this.contextAlertLevel) {
      this.contextAlertLevel = next.level
      this.pushRow({ kind: 'system', text: contextPressureAlertText(next) })
    } else if (next === undefined || next.level === 'ok') {
      this.contextAlertLevel = undefined
    }
    if (
      previous?.usedTokens !== next?.usedTokens
      || previous?.contextWindow !== next?.contextWindow
      || previous?.level !== next?.level
    ) {
      this.markDirty()
    }
    if (options.compact !== false && this.agent.status !== 'running') this.maybeIdleAutoCompact()
  }

  private canRunCompactCommand(): boolean {
    if (this.replaying || this.agentGone || this.exiting) return false
    if (this.agent.status === 'running') return false
    if (this.idleCompactInFlight) return false
    if (this.rows.some(row => row.kind === 'compaction' && row.status === 'running')) return false
    return this.ctx.get('commands') !== undefined
  }

  private maybeIdleAutoCompact(): void {
    if (!this.canRunCompactCommand()) return
    if (!shouldIdleAutoCompact(this.contextPressure)) return
    if (Date.now() - this.lastIdleCompactAt < 8_000) return
    this.dispatchCompactCommand('idle')
  }

  private dispatchCompactCommand(reason: 'idle' | 'user'): void {
    const commands = this.ctx.get('commands') as {
      execute?: (agent: Agent, text: string, attachments: unknown[], signal: AbortSignal) => Promise<{
        commandId?: unknown
        result?: { kind?: unknown; text?: unknown }
      } | undefined>
    } | undefined
    if (commands?.execute === undefined) {
      if (reason === 'user') this.pushRow({ kind: 'error', text: t('cmd.unknown', { command: 'compact' }) })
      return
    }
    if (this.agent.status === 'running'
      || this.rows.some(row => row.kind === 'compaction' && row.status === 'running')) {
      if (reason === 'user') this.pushRow({ kind: 'error', text: t('compact.busy') })
      this.markDirty()
      return
    }
    this.idleCompactInFlight = true
    this.lastIdleCompactAt = Date.now()
    if (reason === 'idle') {
      const view = this.contextPressure
      this.pushRow({
        kind: 'system',
        text: view === undefined
          ? t('context.autoCompact')
          : t('context.autoCompactAt', {
            used: formatTokens(view.usedTokens),
            window: formatTokens(view.contextWindow),
            percent: view.percent.toFixed(0),
          }),
      })
    }
    this.commandAbort?.abort()
    const controller = new AbortController()
    this.commandAbort = controller
    void commands.execute(this.agent, '/compact', [], controller.signal).then((execution) => {
      if (execution === undefined) {
        this.idleCompactInFlight = false
        if (reason === 'user') this.pushRow({ kind: 'error', text: t('cmd.unknown', { command: 'compact' }) })
        return
      }
      const compactionRunning = (): boolean =>
        this.rows.some(row => row.kind === 'compaction' && row.status === 'running')
      const releaseIfSettled = (): void => {
        queueMicrotask(() => {
          if (!compactionRunning()) this.idleCompactInFlight = false
        })
      }
      if (this.seenCommandDoneIds.has(String(execution.commandId))) {
        releaseIfSettled()
        return
      }
      if (execution.result?.kind === 'error') {
        this.idleCompactInFlight = false
        this.pushRow({
          kind: 'error',
          text: formatCompactCommandError(this.formatCommandText(String(execution.result.text ?? ''))),
        })
      } else if (typeof execution.result?.text === 'string' && execution.result.text !== '') {
        this.pushRow({ kind: 'system', text: this.formatCommandText(execution.result.text) })
        releaseIfSettled()
      } else {
        releaseIfSettled()
      }
    }).catch((error: unknown) => {
      this.idleCompactInFlight = false
      this.pushRow({ kind: 'error', text: t('cmd.failedNamed', { command: 'compact', error: errorChain(error) }) })
    }).finally(() => {
      if (this.commandAbort === controller) this.commandAbort = undefined
      this.markDirty()
    })
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
        text: wantsActive ? t('plan.requestOn') : t('plan.requestOff'),
      })
      this.markDirty()
      return
    }
    if (name === 'compact') {
      this.status = t('compact.status')
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

  private formatCommandText(text: string): string {
    const permMatch = text.match(/^current preset (\S+) \(available: (.+)\)$/)
    if (permMatch) {
      const current = permMatch[1] ?? ''
      const avail = permMatch[2] ?? ''
      const localize = (name: string): string => {
        const key = `preset.${name}`
        const trans = t(key)
        return trans !== key ? t('preset.named', { name, label: trans }) : name
      }
      const currentLabel = localize(current)
      const availLabel = avail.split(', ').map(s => localize(s.trim())).join(t('list.sep'))
      return t('permission.currentInfo', { current: currentLabel, available: availLabel })
    }
    const permSwitched = text.match(/^preset (\S+)$/)
    if (permSwitched) {
      const name = permSwitched[1] ?? ''
      const key = `preset.${name}`
      const trans = t(key)
      const label = trans !== key ? t('preset.named', { name, label: trans }) : name
      return t('permission.switched', { preset: label })
    }
    return text
  }

  private handleCommandDone(data: unknown): void {
    const payload = data !== null && typeof data === 'object' ? data as Record<string, unknown> : {}
    const commandId = typeof payload.commandId === 'string' ? payload.commandId : ''
    if (commandId !== '') this.seenCommandDoneIds.add(commandId)
    const kind = typeof payload.kind === 'string' ? payload.kind : ''
    const text = typeof payload.text === 'string' ? payload.text.trim() : ''
    if (kind === 'error') {
      const errText = formatCompactCommandError(this.formatCommandText(text))
      this.pushRow({ kind: 'error', text: errText === '' ? t('command.failed') : errText })
      if (this.status.startsWith(t('compact.short')) || this.status.startsWith('compact')) {
        this.status = this.agent.status === 'running' ? 'running' : 'idle'
      }
      if (!this.rows.some(row => row.kind === 'compaction' && row.status === 'running')) {
        this.idleCompactInFlight = false
      }
      this.markDirty()
      return
    }
    if (text !== '') {
      this.pushRow({ kind: 'system', text: this.formatCommandText(text) })
    }
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
        this.pushRow({ kind: 'goal', objective: t('goal.clearedLabel'), phase: 'cleared', expanded: false })
      }
      this.pushRow({ kind: 'system', text: t('goal.clearedNotice') })
      this.markDirty()
      return
    }
    const goal = payload.goal !== null && typeof payload.goal === 'object' ? payload.goal as Record<string, unknown> : {}
    const objective = typeof goal.objective === 'string' && goal.objective.trim() !== '' ? goal.objective.trim() : t('goal.unnamed')
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
    const notice = phase === 'active' ? t('goal.set')
      : phase === 'paused' ? t('goal.pausedNotice')
      : phase === 'blocked' ? t('goal.blockedNotice')
      : t('goal.doneNotice')
    this.pushRow({ kind: 'system', text: `${notice}：${objective}` })
    this.markDirty()
  }

  private pushPromptInjection(text: string, plugin?: string): void {
    const sources = promptInjectionSources(text, plugin)
    this.pushRow({
      kind: 'prompt',
      sources,
      text,
      ...(plugin === undefined ? {} : { plugin }),
      expanded: false,
    })
  }

  private handleSubagentExtensionEvent(row: Extract<Row, { kind: 'subagent' }>, event: SessionEvent): void {
    const type = String(event.type)
    const data = (event as SessionEvent & { data?: unknown }).data as { active?: unknown } | undefined
    if (type === 'plan/mode') {
      appendSubagentLog(row, {
        kind: 'system',
        text: data?.active === true ? t('plan.enterMode') : t('plan.exitMode'),
      })
      return
    }
    if (type.startsWith('team/')) {
      appendSubagentLog(row, { kind: 'team', text: t('team.event', { type }) })
    }
  }

  /** Fold a live subagent's own session events into that child's card. */
  readonly handleSubagentSessionEvent = (sessionId: SessionId, event: SessionEvent): void => {
    const row = this.findSubagentRow(String(sessionId))
    if (row === undefined) return
    if (sessionEventType(event) === 'assistant/chunk') return
    switch (event.type) {
      case 'user/message': {
        const text = collectText(event.data.content)
        if (text !== '') appendSubagentLog(row, { kind: 'user', text: `❯ ${truncate(text, 4)}` })
        break
      }
      case 'assistant/message': {
        const text = collectText(event.data.message.content)
        if (text !== '') appendSubagentLog(row, { kind: 'assistant', text: truncate(text, 8) })
        break
      }
      case 'tool/call': {
        if (HIDDEN_TOOL_NAMES.has(event.data.name)) break
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
        appendSubagentLog(row, { kind: 'turn', text: t('sub.turnEnd', { reason: event.data.reason.kind }) })
        break
      case 'approval/asked':
        appendSubagentLog(row, { kind: 'approval', text: t('sub.approval', { tool: event.data.toolName }) })
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
      existing.lastActivity = t('sub.started')
      existing.expanded = false
      appendSubagentLog(existing, { kind: 'system', text: t('sub.startedDetail', { provider: info.provider, external: info.local ? '' : t('sub.external') }) })
    } else {
      this.pushRow({
        kind: 'subagent',
        sessionId,
        runId: String(info.runId),
        provider: info.provider,
        local: info.local,
        label: t('sub.label', { provider: info.provider }),
        status: 'running',
        startedAt: Date.now(),
        lastActivity: t('sub.started'),
        logs: [{ kind: 'system', text: t('sub.startedDetail', { provider: info.provider, external: info.local ? '' : t('sub.external') }) }],
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
        text: t('sub.ended', { reason: info.stopReason }) + (output === '' ? '' : ` · ${output}`),
      })
    } else {
      this.pushRow({
        kind: 'subagent',
        sessionId: String(info.id),
        runId: String(info.runId),
        provider: info.provider,
        local: info.local,
        label: t('sub.label', { provider: info.provider }),
        status: info.stopReason === 'aborted' ? 'aborted' : failed ? 'error' : 'ok',
        startedAt: Date.now(),
        endedAt: Date.now(),
        stopReason: info.stopReason,
        lastActivity: t('sub.ended', { reason: info.stopReason }),
        logs: [{ kind: 'system', text: t('sub.ended', { reason: info.stopReason }) + (output === '' ? '' : ` · ${output}`) }],
        expanded: false,
      })
    }
    this.markDirty()
  }

  // ── approval and questions ──────────────────────────────────────────────

  private hasLiveDisplay(): boolean {
    if (this.disposed || this.exiting) return false
    if (this.headlessDisplay || this.displayDetached) return this.displayHost?.attached === true
    return true
  }

  private waitForLiveDisplay(signal?: AbortSignal): Promise<void> {
    if (this.hasLiveDisplay()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        clearInterval(timer)
        if (ok) resolve()
        else reject(new UserQuestionError('ask_user_question was interrupted before the user answered', 'ASK_ABORTED'))
      }
      const onAbort = (): void => { finish(false) }
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setInterval(() => {
        if (this.disposed || this.exiting) {
          finish(false)
          return
        }
        if (this.hasLiveDisplay()) finish(true)
      }, 200)
      timer.unref?.()
    })
  }

  /**
   * Auto mode rides the approval waterfall: when the host approval policy is
   * `never` no request is ever produced, so the classifier silently does
   * nothing. Say so instead of letting the user believe a guard is active.
   */
  private warnApprovalMismatch(): void {
    if (this.autoApprovalMode !== 'auto' || this.approvalMismatchWarned) return
    if (this.hostApprovalPolicy !== 'never') return
    this.approvalMismatchWarned = true
    this.pushRow({ kind: 'system', text: t('approval.mismatchNever') })
    this.markDirty()
  }

  /**
   * AI review for rule-table `ask` outcomes: one shot at the subagent
   * model route with a compact, injection-fenced context. Returns
   * 'allow' | 'deny', or undefined when the reviewer is unavailable or its
   * output was unusable (caller falls back to prompt/reject).
   */
  private latestUserAuthorizationText(agent: ApprovalRequest['agent']): string {
    const session = (agent as { session?: object }).session ?? this.agent.session
    const events = sessionEvents(session)
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event?.type !== 'user/message') continue
      const source = (event.data as { source?: { kind?: string } }).source
      if (source?.kind !== 'user') continue
      const text = collectText((event.data as { content?: Parameters<typeof collectText>[0] }).content ?? [])
      if (text.trim() !== '') return text
    }
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      const row = this.rows[i]
      if (row !== undefined && row.kind === 'user' && row.text.trim() !== '') {
        return row.text.replace(/^❯\s*/u, '')
      }
    }
    return ''
  }

  private async reviewUnknownWithModel(
    request: ApprovalRequest,
    command: string | undefined,
    args: string | undefined,
  ): Promise<ReviewVerdict | undefined> {
    const llm = this.ctx.get('llm')
    if (llm === undefined) return undefined
    const selection = this.subagentSelection.current
    const parentProvider = this.selectionRef?.current?.provider ?? this.agent.options.provider ?? this.providerName
    const provider = selection.provider ?? parentProvider
    const model = subagentModelMatchesProvider(provider, selection.model)
      ? selection.model
      : defaultSubagentModelForProvider(provider, [], this.selectionRef?.current?.model)
    // 最近模型输出/思考（≤2 段）与会话日志里最新用户消息（跳过 plugin notice）
    const segments: string[] = []
    for (let i = this.rows.length - 1; i >= 0 && segments.length < 2; i -= 1) {
      const row = this.rows[i]
      if (row !== undefined && (row.kind === 'assistant' || row.kind === 'reasoning') && row.text.trim() !== '') {
        segments.unshift(row.text)
      }
    }
    const userText = this.latestUserAuthorizationText(request.agent)
    const signals = [request.signal, AbortSignal.timeout(15_000)].filter(s => s !== undefined)
    const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined
    const options: GenerateOptions = {
      provider,
      model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: buildReviewUserMessage({
          userText,
          segments,
          toolName: request.toolName,
          command: command ?? t('approval.noCommand', { tool: request.toolName }),
          ...(args === undefined || args.trim() === '' ? {} : { args }),
          ...(request.reason === undefined || request.reason.trim() === '' ? {} : { reason: request.reason }),
          ...(this.hostSandboxMode === undefined || this.hostSandboxMode.trim() === '' ? {} : { sandboxMode: this.hostSandboxMode }),
        }) }],
        source: { kind: 'plugin', plugin: 'dsh-ssh-tui' },
      })],
      system: reviewSystemPrompt(getLocale()),
      maxTokens: 400,
      reasoningEffort: ReasoningEffortId('off'),
      signal,
    }
    this.aiReviewCount += 1
    let text = ''
    try {
      for await (const chunk of llm.stream(options)) {
        // Classifier reads the final assistant reply only. Reasoning/thinking
        // is ignored even when it happens to contain JSON.
        if (chunk.type === 'text-delta') text += chunk.text
      }
    } catch (error: unknown) {
      this.pushRow({
        kind: 'system',
        text: t('approval.reviewFailed', { error: errorChain(error) }),
      })
      this.markDirty()
      return undefined
    }
    const verdict = parseReviewOutput(text)
    if (verdict === undefined) {
      const preview = text.trim() === '' ? t('approval.reviewNoReply') : text.trim()
      this.pushRow({
        kind: 'system',
        text: t('approval.reviewUnparsed', { output: preview.slice(0, 160) }),
      })
      this.markDirty()
      return undefined
    }
    this.pushRow({
      kind: 'system',
      text: t('approval.reviewRow', {
        verdict: verdict.approved ? t('approval.reviewApproved') : t('approval.reviewRejected'),
        risk: verdict.risk,
        authorization: verdict.authorization,
        reason: verdict.reason,
      }),
    })
    this.markDirty()
    return verdict
  }

  private recordAutoApproval(
    decision: 'allow' | 'deny',
    risk: 'low' | 'medium' | 'high',
    toolName: string,
    command: string | undefined,
    reason: string,
  ): void {
    if (decision === 'allow') this.autoAllowedCount += 1
    else this.autoDeniedCount += 1
    const subject = (command ?? '').trim() !== ''
      ? command!.replace(/\s+/gu, ' ').trim()
      : toolName
    const clipped = Array.from(subject).length > 160
      ? `${Array.from(subject).slice(0, 160).join('')}…`
      : subject
    const rowText = t('approval.decisionRow', {
      verdict: decision === 'allow' ? t('approval.reviewApproved') : t('approval.reviewRejected'),
      command: clipped,
      risk,
      reason,
    })
    this.pushRow({ kind: 'system', text: rowText })
    this.markDirty()
    if (decision === 'deny') this.tellModelApprovalDenied(clipped, reason, rowText)
  }

  /**
   * Host ApprovalOutcome cannot carry a reason, so the model only sees
   * `the user rejected tool "bash"`. Steer a plugin notice with the real
   * classifier/reviewer reason. Summary matches the workspace decision row
   * so the handler does not paint the body twice.
   */
  private tellModelApprovalDenied(command: string, reason: string, summary: string): void {
    if (this.replaying || this.agentGone) return
    const text = t('approval.modelDenied', { command, reason })
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-ssh-tui', form: 'notice', summary },
    })
    try {
      if (this.agent.status === 'running') this.agent.steer(message)
      else this.agent.followup(message)
    } catch {
      // Outcome already settled; a missing notice only loses the extra hint.
    }
  }

  readonly handleApproval = async (
    request: ApprovalRequest,
    _next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> => {
    // Auto mode classifies BEFORE waiting for a display, Codex-style: allow
    // shapes approve, danger shapes REJECT (the model reads the rejection and
    // adapts instead of paging the human), unknown shapes ask only while a
    // human is attached — detached turns reject so they complete instead of
    // stalling toward the idle kill.
    if (this.autoApprovalMode === 'auto') {
      const row = request.callId === undefined
        ? undefined
        : this.findToolRowByCallId(String(request.callId))
      const command = commandForApprovalRequest({
        toolName: request.toolName,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        ...(row === undefined ? {} : { row: { name: row.name, args: row.args, ...(row.command === undefined ? {} : { command: row.command }) } }),
      })
      const classified = classifyApprovalDetailed({
        toolName: request.toolName,
        ...(command === undefined ? {} : { command }),
        ...(row?.args === undefined || row.args.trim() === '' ? {} : { args: row.args }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        workspaceCwd: this.workspaceCwd(),
      })
      const ruleReason = t(`approval.reason.${classified.reasonKey}`, undefined, classified.reasonKey)
      if (classified.decision === 'allow') {
        this.recordAutoApproval('allow', classified.risk, request.toolName, command, ruleReason)
        return 'allowed-once'
      }
      if (classified.decision === 'deny') {
        this.recordAutoApproval('deny', classified.risk, request.toolName, command, ruleReason)
        return 'rejected'
      }
      // Unknown shape: the rule table cannot judge it — hand it to the
      // subagent-configured model with compact context (AI review). Without
      // a display there is nobody to fall back on, so unreviewable asks
      // reject and the turn completes instead of stalling.
      const reviewed = await this.reviewUnknownWithModel(request, command, row?.args)
      if (reviewed?.approved === true) {
        this.recordAutoApproval(
          'allow',
          reviewed.risk,
          request.toolName,
          command,
          reviewed.reason === '' ? t('approval.reviewApproved') : reviewed.reason,
        )
        return 'allowed-once'
      }
      if (reviewed !== undefined) {
        this.recordAutoApproval(
          'deny',
          reviewed.risk,
          request.toolName,
          command,
          reviewed.reason === '' ? t('approval.reviewRejected') : reviewed.reason,
        )
        return 'rejected'
      }
      if (!this.hasLiveDisplay()) {
        this.recordAutoApproval('deny', 'medium', request.toolName, command, t('approval.ruleDetached'))
        return 'rejected'
      }
    }
    if (!this.hasLiveDisplay()) {
      try {
        await this.waitForLiveDisplay(request.signal)
      } catch {
        return 'cancelled'
      }
    }
    const agentLabel = request.agent.id === this.agent.id
      ? t('approval.thisSession')
      : t('sub.agentLabel', { id: request.agent.id })
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
        t('approval.prompt', {
          tool: request.toolName,
          agent: agentLabel,
          reason: request.reason === undefined ? '' : `\n${request.reason}`,
        }),
        t('approval.hint'),
        (answer) => {
          request.signal?.removeEventListener('abort', onAbort)
          resolve(answer === 'y' ? 'allowed-once' : answer === 'n' ? 'rejected' : 'cancelled')
        },
      )
    })
  }

  readonly handleUserQuestions = async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
    if (!this.hasLiveDisplay()) await this.waitForLiveDisplay(request.signal)
    const answers: AskUserQuestionAnswer['answers'] = []
    const agentLabel = request.agent === undefined || request.agent.id === this.agent.id
      ? undefined
      : t('sub.agentLabel', { id: request.agent.id })
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
            : answer.selected.join(', ') || t('question.answered')
        }
      }
      settleCards('answered', t('question.answered'))
      return { answers }
    } catch (error) {
      settleCards('cancelled', error instanceof UserQuestionError ? error.message : t('question.cancelled'))
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
      cursor: preselected !== undefined && preselected >= 0 ? preselected : 0,
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
    if (provider === 'opencode-go') return providerTemplates()['opencode-go'].defaultBaseUrl
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
    const discovered = await discoverProviderModels(llm, {
      baseURL,
      ...(api === undefined ? {} : { api }),
      ...(apiKey === undefined ? {} : { apiKey }),
    }, AbortSignal.timeout(15_000))
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
      this.pushRow({ kind: 'system', text: t('model.added', { model: modelId, provider }) })
      this.markDirty()
      return true
    } catch (error) {
      this.pushRow({ kind: 'error', text: t('model.addFailed', { model: modelId, error: errorChain(error) }) })
      this.markDirty()
      return false
    }
  }

  /**
   * One pick across a possibly long model list. The question dialog keeps a
   * 12-row sliding window so dozens of models stay selectable with ↑/↓.
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
    const currentIndex = unique.findIndex(option => option.id === currentModel && option.id !== '__switch_provider__')
    const answer = await this.askQuestion({
      id: 'model-pick',
      question: t('model.pick', {
        provider,
        source: sourceLabel,
        pages: unique.length > PICKER_WINDOW ? t('model.pickPages', { count: unique.length }) : '',
      }),
      options: unique.map(option => ({
        label: option.label,
        description: option.id === currentModel ? t('model.current') : undefined,
      })),
    }, 0, 1, currentIndex >= 0 ? currentIndex : undefined)
    const picked = answer.selected[0]
    if (picked === undefined) return undefined
    return unique.find(option => option.label === picked)
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
    add('deepseek-official', t('route.deepseek'))
    add('opencode-go', t('route.go'))
    add('opencode', t('route.zen'))
    return out
  }

  /** Built-in SuperGrok catalog used when the live adapter list is still warming up. */
  private static readonly XAI_FALLBACK_MODELS: { id: string; label: string }[] = [
    { id: 'grok-4.6', label: 'Grok 4.6' },
    { id: 'grok-4.5', label: 'Grok 4.5' },
    { id: 'grok-4.3', label: 'Grok 4.3' },
  ]

  private async loadModelOptions(provider: string): Promise<{ options: { id: string; label: string }[]; source: string }> {
    const llm = this.ctx.get('llm')
    let options: { id: string; label: string }[] = []
    let source = t('model.configured')
    if (this.piAiProviderProfile(provider) !== undefined || provider === 'opencode' || provider === 'opencode-go') {
      const previousStatus = this.status
      try {
        this.status = t('model.fetching', { provider })
        this.markDirty()
        options = await this.discoverEndpointModels(provider)
        if (options.length > 0) {
          source = t('model.live')
          try {
            const listed = (await llm?.listModels(provider)) ?? []
            const endpointIds = new Set(options.map(model => model.id))
            for (const model of listed) {
              if (!endpointIds.has(model.id)) {
                options.push({ id: model.id, label: model.name || model.id })
              }
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
    if (options.length === 0 && providerUsesLocalOAuth(provider)) {
      options = SshTui.XAI_FALLBACK_MODELS.map(option => ({ ...option }))
      source = t('model.xaiCatalog')
    }
    if (options.length === 0) {
      const remembered = this.rememberedRoute(provider)?.model
      const fallback = remembered
        ?? (providerUsesLocalOAuth(provider) ? 'grok-4.6' : 'deepseek-v4-flash')
      options = [{ id: fallback, label: fallback }]
    }
    return { options, source }
  }

  /** /model: models and effort for the current provider only. */
  private async runModelCommand(): Promise<void> {
    const provider = this.currentProviderId()
    const current = this.selectionRef?.current
    const loaded = await this.loadModelOptions(provider)
    let modelOptions = loaded.options
    if (current?.model !== undefined && !modelOptions.some(option => option.id === current.model)) {
      modelOptions = [{ id: current.model, label: current.model }, ...modelOptions]
    }
    const selected = await this.pickModelOption(modelOptions, provider, loaded.source, current?.model)
    if (selected === undefined) return
    await this.applyModelSelection(provider, selected.id, modelOptions.map(option => option.id))
  }

  /** /provider: pick a provider, then its model (remembered route pre-filled). */
  private async runProviderCommand(): Promise<void> {
    const providers = this.listSelectableProviders()
    const current = this.currentProviderId()
    if (providers.length === 0) {
      this.pushRow({ kind: 'error', text: t('provider.none') })
      this.markDirty()
      return
    }
    const currentIndex = Math.max(0, providers.findIndex(option => option.id === current))
    const pickedAnswer = await this.askQuestion({
      id: 'provider-pick',
      question: t('provider.pick'),
      options: providers.map(option => ({
        label: option.label,
        description: option.id === current
          ? t('provider.currentKind', { kind: describeProviderRoute(option.id).kind })
          : describeProviderRoute(option.id).kind,
      })),
    }, 0, 1, currentIndex)
    const provider = providers.find(option => option.label === pickedAnswer.selected[0])?.id
    if (provider === undefined) return
    const remembered = this.rememberedRoute(provider)
    const loaded = await this.loadModelOptions(provider)
    let modelOptions = loaded.options
    if (remembered !== undefined && !modelOptions.some(option => option.id === remembered.model)) {
      modelOptions = [{ id: remembered.model, label: remembered.model }, ...modelOptions]
    }
    const selected = await this.pickModelOption(
      modelOptions,
      provider,
      loaded.source,
      remembered?.model ?? (provider === current ? this.selectionRef?.current?.model : undefined),
    )
    if (selected === undefined) return
    await this.applyModelSelection(provider, selected.id, modelOptions.map(option => option.id), remembered?.reasoningEffort)
  }

  /** Persist a provider/model/effort choice and keep the subagent on the same family. */
  private rememberedRoute(provider: string): RememberedRoute | undefined {
    const section = this.ctx.get('settings')?.get(ROUTE_MEMORY_NS)
    const memory = section !== null && typeof section === 'object' && !Array.isArray(section)
      ? parseRouteMemory((section as Record<string, unknown>).providers)
      : {}
    return rememberedRouteFor(memory, provider)
  }

  private async rememberRoute(selection: ModelSelection): Promise<void> {
    const settings = this.ctx.get('settings')
    if (settings === undefined) return
    const section = settings.get(ROUTE_MEMORY_NS)
    const memory = section !== null && typeof section === 'object' && !Array.isArray(section)
      ? parseRouteMemory((section as Record<string, unknown>).providers)
      : {}
    const next = upsertRememberedRoute(memory, selection.provider, {
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: String(selection.reasoningEffort) }),
    })
    await settings.mutate(ROUTE_MEMORY_NS, [
      { op: 'set', path: ['providers'], value: next },
    ])
  }

  private async applyModelSelection(
    provider: string,
    modelId: string,
    listed: readonly string[] = [],
    preferredEffort?: string,
  ): Promise<void> {
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
      effortOptions = localOAuthEffortChoices(modelId)
    }

    const isUndeclared = effortOptions.length === 0
    const available = isUndeclared ? undeclaredEffortChoices() : effortOptions

    const choices: { id: string | undefined; label: string; desc?: string }[] = [
      {
        id: undefined,
        label: t('footer.effortDefault'),
        desc: isUndeclared ? t('effort.descUndeclared') : t('effort.descFollow'),
      },
      ...available.map(opt => ({
        id: opt.id,
        label: opt.label,
        desc: undefined,
      })),
    ]

    const rememberedEffort = this.rememberedRoute(provider)?.reasoningEffort ?? preferredEffort ?? ''
    const currentEffort = current?.provider === provider
      ? String(current?.reasoningEffort ?? '')
      : rememberedEffort
    const currentIndex = Math.max(0, choices.findIndex(option => option.id === (currentEffort === '' ? undefined : currentEffort)))
    const effortAnswer = await this.askQuestion({
      id: 'effort-pick',
      question: isUndeclared
        ? t('effort.pickUndeclared', { model: modelId })
        : t('effort.pick', { model: modelId }),
      options: choices.map(option => ({
        label: option.label,
        description: option.id === (currentEffort === '' ? undefined : currentEffort) ? t('disconnect.current') : option.desc,
      })),
    }, 0, 1, currentIndex)
    const effort = choices.find(option => option.label === effortAnswer.selected[0])?.id

    const next: ModelSelection = {
      provider,
      model: modelId,
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
    }
    if (this.selectionRef !== undefined) this.selectionRef.current = next
    this.onSelectionChanged?.(next)
    await this.persistDefaultSelection(next)
    await this.rememberRoute(next)
    const kind = describeProviderRoute(provider)
    const effortText = effort ?? t('effort.defaultShort')
    const note = isUndeclared && effort !== undefined ? t('effort.manualNote') : ''
    this.pushRow({
      kind: 'system',
      text: t('effort.switchedModel', { kind: kind.kind, provider, model: modelId, effort: effortText, note }),
    })
    const listedIds = listed.filter(id => id !== '__switch_provider__' && id !== '')
    const previousProvider = current?.provider ?? this.agent.options.provider ?? this.providerName
    if (previousProvider !== provider) {
      await this.syncSubagentToProvider(provider, listedIds, true)
      this.clearQuotaForProvider(provider)
      void this.refreshQuota({ reason: 'command', announce: false }).catch(() => {})
    } else {
      await this.syncSubagentToProvider(provider, listedIds)
    }
    this.markDirty()
  }

  /**
   * Persist the default provider/model selection. `agentDefaultModel` may be
   * unavailable or its settings namespace may not be registered in this
   * process, so a failed `saveSelection` falls back to writing the
   * `agent-default-model` settings section directly and surfaces a warning
   * when neither path sticks.
   */
  private async persistDefaultSelection(next: ModelSelection): Promise<boolean> {
    const settings = this.ctx.get('settings')
    const defaultModel = this.ctx.get('agentDefaultModel')
    if (defaultModel !== undefined) {
      try {
        await defaultModel.saveSelection(next)
        return true
      } catch {
        // Fall through to the direct settings write.
      }
    }
    if (settings !== undefined) {
      try {
        await settings.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, {
          provider: next.provider,
          model: next.model,
          ...(next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) }),
        })
        return true
      } catch (error: unknown) {
        this.pushRow({
          kind: 'error',
          text: t('model.persistFailSettings', { error: errorChain(error) }),
        })
        this.markDirty()
        return false
      }
    }
    this.pushRow({ kind: 'error', text: t('model.persistFailNone') })
    this.markDirty()
    return false
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
  private async syncSubagentToProvider(
    provider: string,
    listed: readonly string[] = [],
    force = false,
  ): Promise<void> {
    const current = this.subagentSelection.current
    if (!force && current.provider !== undefined && current.provider !== provider) return
    if (!force && subagentModelMatchesProvider(provider, current.model, listed)) return
    let catalog = [...listed]
    if (catalog.length === 0) {
      try {
        const { options } = await this.subagentModelOptions(provider)
        catalog = options.map(option => option.id)
      } catch {
        catalog = []
      }
    }
    const parentModel = this.selectionRef?.current?.model ?? this.agent.options.model
    const nextModel = defaultSubagentModelForProvider(provider, catalog, parentModel)
    if (!force && nextModel === current.model && current.provider === undefined) return
    const persisted = await this.saveSubagentSelection({
      model: nextModel,
      reasoningEffort: undefined,
    })
    this.pushRow({
      kind: 'system',
      text: t('sub.followed', { provider, model: nextModel, sessionOnly: persisted ? '' : t('sub.sessionOnly') }),
    })
  }

  private clearQuotaForProvider(provider: string): void {
    const quotaSame = this.quotaSnapshot !== undefined && this.quotaSnapshot.provider === provider
    const balanceSame = this.balanceSnapshot !== undefined && this.balanceSnapshot.provider === provider
    if (quotaSame && balanceSame) return
    if (!quotaSame) {
      this.quotaSnapshot = undefined
      this.quotaAlerted.clear()
    }
    if (!balanceSame) this.balanceSnapshot = undefined
    this.quotaStepsSinceRefresh = 0
    this.markDirty()
  }

  /** Persist one subagent selection and publish it to the live request waterfall. */
  private async saveSubagentSelection(next: SubagentSelection): Promise<boolean> {
    this.subagentSelection.current = next
    const settings = this.ctx.get('settings')
    if (settings === undefined) {
      this.pushRow({ kind: 'error', text: t('sub.settingsMissing') })
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
    let source = t('model.configured')
    if (this.piAiProviderProfile(provider) !== undefined || provider === 'opencode' || provider === 'opencode-go') {
      const previousStatus = this.status
      try {
        this.status = t('sub.fetchingModels', { provider })
        this.markDirty()
        options = await this.discoverEndpointModels(provider)
        if (options.length > 0) {
          source = t('model.live')
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
    if (direct.toLowerCase() === 'reset' || direct === '跟随' || direct === '默认') {
      const parentProvider = this.currentProviderId()
      const nextModel = defaultSubagentModelForProvider(
        parentProvider,
        [],
        this.selectionRef?.current?.model ?? this.agent.options.model,
      )
      const persisted = await this.saveSubagentSelection({
        model: nextModel,
        reasoningEffort: undefined,
      })
      this.pushRow({
        kind: 'system',
        text: t('sub.followed', { provider: parentProvider, model: nextModel, sessionOnly: persisted ? '' : t('sub.sessionOnly') }),
      })
      this.markDirty()
      return
    }
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
      text: (current.provider === undefined
        ? t('sub.modelFollow', { model: selectedId, provider })
        : t('sub.modelPinned', { model: selectedId, provider }))
        + (persisted ? '' : t('sub.sessionOnly')),
    })
    this.markDirty()
  }

  /** /effort: pick or set the reasoning effort for the current model. */
  private async runEffortCommand(arg?: string): Promise<void> {
    const provider = this.currentProviderId()
    const current = this.selectionRef?.current
    if (current === undefined || current.model === undefined) {
      this.pushRow({ kind: 'error', text: t('effort.noModel') })
      this.markDirty()
      return
    }
    const modelId = current.model
    const llm = this.ctx.get('llm')

    let declaredOptions: { id: string; label: string }[] = []
    try {
      const info = await llm?.resolveModelInfo(provider, modelId)
      declaredOptions = (info?.reasoning?.efforts ?? []).map(e => ({ id: String(e.id), label: e.name }))
    } catch {
      declaredOptions = []
    }
    if (declaredOptions.length === 0 && providerUsesLocalOAuth(provider)) {
      declaredOptions = localOAuthEffortChoices(modelId)
    }

    const parsed = parseEffortArg(arg ?? '')
    if ((arg ?? '').trim() !== '') {
      if (parsed === undefined) {
        this.pushRow({ kind: 'error', text: t('effort.unknown', { id: (arg ?? '').trim() }) })
        this.markDirty()
        return
      }
      const allowed: readonly string[] = declaredOptions.length === 0
        ? UNDECLARED_EFFORT_IDS
        : declaredOptions.map(option => option.id)
      if (parsed.kind === 'id' && !allowed.includes(parsed.id)) {
        this.pushRow({ kind: 'error', text: t('effort.unknown', { id: parsed.id }) })
        this.markDirty()
        return
      }
      await this.setReasoningEffort(
        provider,
        modelId,
        parsed.kind === 'default' ? undefined : parsed.id,
        declaredOptions.length === 0,
      )
      return
    }

    const isUndeclared = declaredOptions.length === 0
    const available = isUndeclared ? undeclaredEffortChoices() : declaredOptions

    const currentEffort = current.reasoningEffort === undefined ? undefined : String(current.reasoningEffort)

    const choices: { id: string | undefined; label: string; desc?: string }[] = [
      {
        id: undefined,
        label: t('footer.effortDefault'),
        desc: isUndeclared ? t('effort.descUndeclared') : t('effort.descFollow'),
      },
      ...available.map(opt => ({
        id: opt.id,
        label: opt.label,
        desc: undefined,
      })),
    ]

    const currentIndex = Math.max(0, choices.findIndex(c => c.id === currentEffort))
    const answer = await this.askQuestion({
      id: 'effort-pick',
      question: isUndeclared
        ? t('effort.pickCurrentUndeclared', { provider, model: modelId })
        : t('effort.pickCurrent', { provider, model: modelId }),
      options: choices.map(c => ({
        label: c.label,
        description: c.id === currentEffort ? t('disconnect.current') : c.desc,
      })),
    }, 0, 1, currentIndex)

    const picked = choices.find(c => c.label === answer.selected[0])
    if (picked === undefined) return
    await this.setReasoningEffort(provider, modelId, picked.id, isUndeclared)
  }

  private async setReasoningEffort(
    provider: string,
    modelId: string,
    effort: string | undefined,
    isUndeclared: boolean,
  ): Promise<void> {
    const next: ModelSelection = {
      provider,
      model: modelId,
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
    }
    if (this.selectionRef !== undefined) this.selectionRef.current = next
    this.onSelectionChanged?.(next)
    await this.persistDefaultSelection(next)
    await this.rememberRoute(next)
    const effortText = effort ?? t('effort.defaultExplicit')
    const note = isUndeclared && effort !== undefined ? t('effort.manualNote') : ''
    this.pushRow({
      kind: 'system',
      text: t('effort.updated', { provider, model: modelId, effort: effortText, note }),
    })
    this.markDirty()
  }

  /** /subeffort: pick the reasoning effort subagent children use. */
  private async runSubeffortCommand(arg?: string): Promise<void> {
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

    const parsed = parseEffortArg(arg ?? '')
    if ((arg ?? '').trim() !== '') {
      if (parsed === undefined) {
        this.pushRow({ kind: 'error', text: t('effort.unknown', { id: (arg ?? '').trim() }) })
        this.markDirty()
        return
      }
      const allowed: readonly string[] = effortOptions.length === 0
        ? UNDECLARED_EFFORT_IDS
        : effortOptions.map(option => option.id)
      if (parsed.kind === 'id' && !allowed.includes(parsed.id)) {
        this.pushRow({ kind: 'error', text: t('effort.unknown', { id: parsed.id }) })
        this.markDirty()
        return
      }
      const targetEffort = parsed.kind === 'default' ? undefined : parsed.id
      const next: SubagentSelection = {
        ...current,
        ...(targetEffort === undefined ? { reasoningEffort: undefined } : { reasoningEffort: ReasoningEffortId(targetEffort) }),
      }
      const persisted = await this.saveSubagentSelection(next)
      this.pushRow({
        kind: 'system',
        text: `${targetEffort === undefined
          ? t('effort.subDefault')
          : t('effort.subSwitched', { effort: targetEffort })}${persisted ? '' : t('effort.sessionOnly')}`,
      })
      this.markDirty()
      return
    }

    const isUndeclared = effortOptions.length === 0
    const available = isUndeclared ? undeclaredEffortChoices() : effortOptions

    const choices: { id: string | undefined; label: string; desc?: string }[] = [
      {
        id: undefined,
        label: SUBAGENT_DEFAULT_EFFORT_LABEL(),
        desc: isUndeclared ? t('effort.subDescUndeclared') : t('effort.subDescFollow'),
      },
      ...available.map(option => ({ id: option.id, label: option.label, desc: undefined })),
    ]
    const currentEffort = current.reasoningEffort === undefined ? undefined : String(current.reasoningEffort)
    const currentIndex = Math.max(0, choices.findIndex(c => c.id === currentEffort))
    const answer = await this.askQuestion({
      id: 'subagent-effort-pick',
      question: isUndeclared
        ? t('effort.pickSubUndeclared', { provider, model: current.model })
        : t('effort.pickSub', { provider, model: current.model }),
      options: choices.map(option => ({
        label: option.label,
        description: option.id === currentEffort ? t('disconnect.current') : option.desc,
      })),
    }, 0, 1, currentIndex)
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
        ? t('effort.subDefault')
        : t('effort.subSwitched', { effort: picked.id })}${persisted ? '' : t('effort.sessionOnly')}`,
    })
    this.markDirty()
  }

  /** /language or /lang: persist zh/en and repaint chrome immediately. */
  private async runLanguageCommand(arg: string): Promise<void> {
    const direct = localeFromTag(arg)
    let next: Locale | undefined = direct
    if (next === undefined && arg.trim() !== '') {
      this.pushRow({ kind: 'error', text: t('lang.unknown', { id: arg.trim() }) })
      this.markDirty()
      return
    }
    if (next === undefined) {
      const current = getLocale()
      const answer = await this.askQuestion({
        id: 'language-pick',
        question: t('lang.pick'),
        options: [
          { label: t('lang.zh'), description: current === 'zh' ? t('lang.current') : t('lang.zhDesc') },
          { label: t('lang.en'), description: current === 'en' ? t('lang.current') : t('lang.enDesc') },
        ],
      }, 0, 1, current === 'en' ? 1 : 0)
      const picked = answer.selected[0]
      next = picked === t('lang.en') ? 'en' : 'zh'
    }
    setLocale(next)
    const settings = this.ctx.get('settings')
    if (settings === undefined) {
      this.pushRow({ kind: 'error', text: t('lang.settingsMissing') })
    } else {
      await this.mergeUiSettings({ language: next })
      applySavedLocale({ language: next })
    }
    this.forceFullPaint = true
    this.pushRow({ kind: 'system', text: t('lang.switched', { name: localeDisplayName(next) }) })
    this.markDirty()
  }

  /** /view: detailed (see the work) vs compact (Codex-like summary). */
  private async runViewCommand(arg: string): Promise<void> {
    const direct = parseWorkspaceView(arg)
    let next: WorkspaceView | undefined = direct
    if (next === undefined && arg.trim() !== '') {
      this.pushRow({ kind: 'error', text: t('view.unknown', { id: arg.trim() }) })
      this.markDirty()
      return
    }
    if (next === undefined) {
      const current = this.workspaceView
      const answer = await this.askQuestion({
        id: 'view-pick',
        question: t('view.pick'),
        options: [
          { label: t('view.detailed'), description: current === 'detailed' ? t('view.current') : t('view.detailedDesc') },
          { label: t('view.compact'), description: current === 'compact' ? t('view.current') : t('view.compactDesc') },
        ],
      }, 0, 1, current === 'compact' ? 1 : 0)
      const picked = answer.selected[0]
      next = picked === t('view.compact') ? 'compact' : 'detailed'
    }
    this.workspaceView = next
    await this.mergeUiSettings({ view: next })
    this.forceFullPaint = true
    this.pushRow({ kind: 'system', text: t('view.switched', { name: next === 'compact' ? t('view.compact') : t('view.detailed') }) })
    this.markDirty()
  }

  /** /disconnect: pause (default) or continue the turn after SSH drop. */
  private async runDisconnectCommand(arg: string): Promise<void> {
    const direct = parseDisconnectPolicy(arg)
    let next: DisconnectPolicyName | undefined = direct
    if (next === undefined && arg.trim() !== '') {
      this.pushRow({ kind: 'error', text: t('disconnect.unknown', { id: arg.trim() }) })
      this.markDirty()
      return
    }
    if (next === undefined) {
      const current = this.disconnectPolicy
      const answer = await this.askQuestion({
        id: 'disconnect-pick',
        question: t('disconnect.pick'),
        options: [
          { label: t('disconnect.pause'), description: current === 'pause' ? t('disconnect.current') : t('disconnect.pauseDesc') },
          { label: t('disconnect.continue'), description: current === 'continue' ? t('disconnect.current') : t('disconnect.continueDesc') },
        ],
      }, 0, 1, current === 'continue' ? 1 : 0)
      const picked = answer.selected[0]
      next = picked === t('disconnect.continue') ? 'continue' : 'pause'
    }
    this.disconnectPolicy = next
    await this.mergeUiSettings({ disconnect: next })
    this.forceFullPaint = true
    this.pushRow({
      kind: 'system',
      text: t('disconnect.switched', { name: next === 'continue' ? t('disconnect.continue') : t('disconnect.pause') }),
    })
    this.markDirty()
  }

  /** /mode: pick an agent preset (standard / minimal / ptc / cordis / routing-suite / ...). */
  private async runModeCommand(arg = ''): Promise<void> {
    const agentPresets = this.ctx.get('agentPresets')
    if (agentPresets === undefined) {
      this.pushRow({ kind: 'error', text: t('mode.missingService') })
      this.markDirty()
      return
    }
    const presets = await agentPresets.list()
    if (presets.length === 0) {
      this.pushRow({ kind: 'error', text: t('mode.none') })
      this.markDirty()
      return
    }
    const direct = arg.trim().toLowerCase()
    let selected = direct === ''
      ? undefined
      : presets.find(preset =>
        preset.id.toLowerCase() === direct
        || (preset.name ?? '').toLowerCase() === direct)
    if (selected === undefined && direct !== '') {
      this.pushRow({
        kind: 'error',
        text: t('mode.unknown', { id: arg.trim(), available: presets.map(preset => preset.id).join(', ') }),
      })
      this.markDirty()
      return
    }
    if (selected === undefined) {
      const answer = await this.askQuestion({
        id: 'mode-pick',
        question: t('mode.pick'),
        options: presets.map(preset => ({
          label: preset.name ?? preset.id,
          description: `${preset.id === this.presetId ? t('mode.currentPrefix') : ''}${preset.description ?? ''}`.trim(),
        })),
      })
      selected = presets.find(preset => (preset.name ?? preset.id) === answer.selected[0])
    }
    if (selected === undefined) return
    const selectedName = selected.name ?? selected.id
    const hasWork = sessionEvents(this.agent.session).some(event => event.type === 'turn/start')
    if (!hasWork) {
      await agentPresets.recompose(this.agent.ctx, selected.id)
      this.presetId = selected.id
      this.presetName = selectedName
      this.pushRow({ kind: 'system', text: t('mode.switched', { name: selectedName }) })
    } else {
      this.pushRow({
        kind: 'system',
        text: t('mode.remembered', { name: selectedName }),
      })
    }
    await this.ctx.get('settings')?.update(settingsNamespace('agent-presets'), { default: selected.id })
    this.markDirty()
  }

  /** /resume: switch to a past session, or open a picker when no id is given. */
  private async runResumeCommand(arg: string, fromLaunch = false): Promise<void> {
    const target = arg.trim()
    if (!fromLaunch && this.agent.status === 'running') {
      this.pushRow({ kind: 'error', text: t('resume.running') })
      this.markDirty()
      return
    }
    if (target !== '') {
      if (target === String(this.agent.id)) {
        this.pushRow({ kind: 'system', text: t('resume.same') })
        this.markDirty()
        return
      }
      if (this.onSwitchSession === undefined) {
        this.pushRow({ kind: 'error', text: t('resume.noCallback') })
        this.markDirty()
        return
      }
      this.pushRow({ kind: 'system', text: t('resume.switching', { id: target }) })
      this.markDirty()
      await this.onSwitchSession(target)
      return
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      this.pushRow({ kind: 'error', text: t('resume.noPersistence') })
      this.markDirty()
      return
    }
    const inspected = await listResumableSessions(persistence, String(this.agent.id))
    if (inspected.length === 0) {
      this.pushRow({ kind: 'system', text: t('resume.none') })
      this.markDirty()
      return
    }
    const labelCount = new Map<string, number>()
    for (const item of inspected) {
      labelCount.set(item.label, (labelCount.get(item.label) ?? 0) + 1)
    }
    const choices = inspected.map(item => ({
      item,
      label: (labelCount.get(item.label) ?? 0) > 1 ? `${item.label} · ${item.id}` : item.label,
      description: `${item.unreadable === true ? t('resume.unreadable') : ''}${formatSessionTime(item.updatedAt)} · ${item.cwd}`,
    }))
    const answer = await this.askQuestion({
      id: 'resume-pick',
      question: inspected.length > PICKER_WINDOW
        ? t('resume.pickMany', { count: inspected.length })
        : t('resume.pick'),
      options: choices.map(choice => ({ label: choice.label, description: choice.description })),
    })
    const picked = choices.find(choice => choice.label === answer.selected[0])?.item
    if (picked === undefined) return
    if (this.onSwitchSession === undefined) {
      this.pushRow({ kind: 'error', text: t('resume.noCallback') })
      this.markDirty()
      return
    }
    this.pushRow({ kind: 'system', text: t('resume.switching', { id: picked.id }) })
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
      throw new Error(t('usage.goFetchFail', { error: errorChain(error) }))
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
        throw new Error(t('usage.go401', { detail: message === '' ? '' : `：${message}` }))
      }
      if (response.status === 403) {
        throw new Error(t('usage.go403', { detail: message === '' ? '' : `：${message}` }))
      }
      throw new Error(t('usage.goHttp', { status: response.status, detail: message === '' ? '' : `：${message}` }))
    }
    return payload
  }

  /** Explain Zen metered billing instead of pretending it has a quota. */
  private zenUsageText(source: OpenCodeSource): string {
    const usage = this.stats.usage
    const billedInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    const tokenLine = billedInput > 0 || usage.outputTokens > 0
      ? t('usage.sessionTokens', { input: formatTokens(billedInput), output: formatTokens(usage.outputTokens) })
      : t('usage.sessionNone')
    return [
      t('usage.zenHeader', { provider: source.provider }),
      t('usage.zenBody'),
      tokenLine,
    ].join('\n')
  }

  /** /usage and /balance: remaining quota or prepaid balance for the current provider. */
  private async runUsageCommand(): Promise<void> {
    const previousStatus = this.status
    this.status = t('usage.querying')
    this.markDirty()
    try {
      const quota = await this.refreshQuota({ reason: 'command', announce: true })
      if (quota !== undefined) return
      if (this.balanceSnapshot !== undefined) {
        this.pushRow({ kind: 'system', text: formatAccountBalance(this.balanceSnapshot) })
        return
      }
      const provider = this.currentProviderId()
      const llmPiAi = this.ctx.get('settings')?.get(settingsNamespace('llm-pi-ai'))
      const source = openCodeSourceFor(provider, llmPiAi)
      if (source?.flavor === 'zen') {
        this.pushRow({ kind: 'system', text: this.zenUsageText(source) })
      } else {
        this.pushRow({
          kind: 'system',
          text: t('usage.none', { provider }),
        })
      }
    } catch (error: unknown) {
      this.pushRow({ kind: 'error', text: t('cmd.failedNamed', { command: 'balance', error: errorChain(error) }) })
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

  private async refreshQuota(options: { reason: 'start' | 'step' | 'command'; announce: boolean }): Promise<QuotaSnapshot | undefined> {
    if (this.quotaRefreshInFlight && options.reason !== 'command') return this.quotaSnapshot
    this.quotaRefreshInFlight = true
    try {
      const provider = this.currentProviderId()
      const snapshot = await this.fetchQuotaSnapshot(provider)
      if (snapshot !== undefined) {
        this.balanceSnapshot = undefined
        this.applyQuotaSnapshot(snapshot, options.announce)
        return snapshot
      }
      try {
        const balance = await this.fetchAccountBalance(provider)
        if (balance !== undefined) {
          this.balanceSnapshot = balance
          this.quotaSnapshot = undefined
          this.quotaAlerted.clear()
          if (options.announce) this.pushRow({ kind: 'system', text: formatAccountBalance(balance) })
          this.markDirty()
          return undefined
        }
      } catch (error: unknown) {
        if (options.reason === 'command') throw error
        this.markDirty()
        return this.quotaSnapshot
      }
      if (this.quotaSnapshot !== undefined && this.quotaSnapshot.provider !== provider) {
        this.quotaSnapshot = undefined
        this.quotaAlerted.clear()
        this.markDirty()
      }
      if (this.balanceSnapshot !== undefined && this.balanceSnapshot.provider !== provider) {
        this.balanceSnapshot = undefined
        this.markDirty()
      }
      return undefined
    } finally {
      this.quotaRefreshInFlight = false
    }
  }

  private async fetchAccountBalance(provider: string): Promise<AccountBalanceSnapshot | undefined> {
    if (provider === 'deepseek-official' || provider === 'deepseek') {
      const apiKey = await this.resolveCredential('DEEPSEEK_API_KEY')
      if (apiKey === undefined) throw new Error(t('usage.noDeepseekKey'))
      const section = this.ctx.get('settings')?.get(settingsNamespace('llm-deepseek')) as { baseURL?: unknown } | undefined
      const baseURL = typeof section?.baseURL === 'string' && section.baseURL.trim() !== ''
        ? section.baseURL.trim()
        : (process.env.DEEPSEEK_BASE_URL?.trim() || DEEPSEEK_PUBLIC_BASE_URL)
      const payload = await this.fetchJson(joinUrl(baseURL, '/user/balance'), {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      }, 'DeepSeek')
      return parseDeepSeekBalance(payload, provider)
    }
    const profile = this.piAiProviderProfile(provider)
    const api = typeof profile?.api === 'string' ? profile.api : undefined
    const baseURL = typeof profile?.baseURL === 'string' && profile.baseURL.trim() !== '' ? profile.baseURL.trim() : undefined
    if (baseURL === undefined || (api !== undefined && api !== 'openai-completions')) return undefined
    const apiKeyEnv = typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv.trim() !== ''
      ? profile.apiKeyEnv.trim()
      : `${provider.replaceAll('-', '_').toUpperCase()}_API_KEY`
    const apiKey = await this.resolveCredential(apiKeyEnv)
    if (apiKey === undefined) throw new Error(t('usage.noCred', { env: apiKeyEnv }))
    const errors: string[] = []
    for (const path of OPENAI_COMPAT_BALANCE_PATHS) {
      const url = joinUrl(baseURL, path)
      try {
        const payload = await this.fetchJson(url, {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
        }, provider)
        const parsed = parseOpenAiCompatibleBalance(payload, provider, path)
        if (parsed !== undefined) return parsed
        errors.push(t('usage.pathBad', { path }))
      } catch (error: unknown) {
        errors.push(`${path}: ${errorChain(error)}`)
      }
    }
    throw new Error(t('usage.noGateway', { errors: errors.join(t('list.sep')) }))
  }

  private async fetchQuotaSnapshot(provider: string): Promise<QuotaSnapshot | undefined> {
    if (providerUsesLocalOAuth(provider)) {
      const token = await this.resolveSuperGrokToken()
      if (token === undefined) throw new Error(t('usage.noGrokToken'))
      const headers = {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'x-grok-client-mode': 'cli',
        'x-grok-client-version': '1.0.0',
      }
      try {
        const payload = await this.fetchJson(SUPERGROK_BILLING_URL, headers, 'SuperGrok')
        return parseSuperGrokBilling(payload)
      } catch (error: unknown) {
        const message = errorChain(error)
        if (!message.includes('HTTP 401') && !message.includes('HTTP 403')) throw error
        const retried = await this.resolveSuperGrokToken({ force: true })
        if (retried === undefined || retried === token) throw error
        const payload = await this.fetchJson(SUPERGROK_BILLING_URL, {
          ...headers,
          authorization: `Bearer ${retried}`,
        }, 'SuperGrok')
        return parseSuperGrokBilling(payload)
      }
    }
    const llmPiAi = this.ctx.get('settings')?.get(settingsNamespace('llm-pi-ai'))
    const source = openCodeSourceFor(provider, llmPiAi)
    if (source === null || source.flavor !== 'go') return undefined
    const apiKey = await this.resolveCredential(source.apiKeyEnv)
    if (apiKey === undefined) throw new Error(t('usage.noGoCred', { env: source.apiKeyEnv }))
    const payload = await this.fetchOpenCodeGoUsage(apiKey)
    return parseOpenCodeGoQuota(payload, source.provider)
  }

  private async resolveSuperGrokToken(options: { force?: boolean } = {}): Promise<string | undefined> {
    return resolveFreshSuperGrokToken(options)
  }

  private async fetchJson(url: string, headers: Record<string, string>, label: string): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
    } catch (error) {
      throw new Error(t('usage.fetchFail', { label, error: errorChain(error) }))
    }
    let payload: unknown
    try {
      payload = await response.json() as unknown
    } catch {
      payload = undefined
    }
    if (!response.ok) {
      throw new Error(t('usage.http', { label, status: response.status }))
    }
    return payload
  }

  // ── keyboard ────────────────────────────────────────────────────────────

  private readonly handleData = (chunk: Buffer): void => {
    const decoded = this.decoder.write(chunk)
    if (decoded === '') return
    this.inputGuard.push(decoded)
  }

  private handleInputText(text: string): void {
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
          if (this.dialog?.kind === 'inspect') {
            this.scrollInspectOrTranscript(-1)
          } else if (this.moveQuestionCursor(-1)) {
            return
          } else if (this.dialog?.kind === 'onboarding' && this.moveProviderCursor(-1)) {
            return
          } else if (this.suggestionsVisible()) {
            this.suggestionIndex = Math.max(0, this.suggestionIndex - 1)
            this.markDirty()
          } else if (this.input === '' && this.collapsibleRows().length > 0) {
            this.moveCollapsibleFocus(-1)
          } else {
            this.historyBack()
          }
          return
        case 'B':
          if (this.dialog?.kind === 'inspect') {
            this.scrollInspectOrTranscript(1)
          } else if (this.moveQuestionCursor(1)) {
            return
          } else if (this.dialog?.kind === 'onboarding' && this.moveProviderCursor(1)) {
            return
          } else if (this.suggestionsVisible()) {
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
          this.scrollInspectOrTranscript(3)
          return
        }
        if (button === 65) {
          this.scrollInspectOrTranscript(-3)
          return
        }
        if (button === 0) {
          const x = Number(sgrMouse[2])
          this.handleMouseClick(y, x)
          return
        }
      }
      return
    }
    if (combined === '\x1b[5~') {
      this.scrollInspectOrTranscript(Math.max(3, Math.floor(this.screenRows() / 2)))
      return
    }
    if (combined === '\x1b[6~') {
      this.scrollInspectOrTranscript(-Math.max(3, Math.floor(this.screenRows() / 2)))
      return
    }
    if (parseCursorPositionReply(combined) !== undefined) return
    if (combined === '\x1b[H' || combined === '\x1b[1~') { this.cursor = 0; this.markDirty(); return }
    if (combined === '\x1b[F' || combined === '\x1b[4~') { this.cursor = this.input.length; this.markDirty(); return }
    if (combined === '\x1b[3~') { this.deleteAtCursor(); return }
    // kitty / CSI-u Ctrl+Shift+C (codepoint 99, mods 6 = Ctrl+Shift)
    if (combined === '\x1b[99;6u') {
      this.copyFocusedCard()
      return
    }
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
    this.leaveHistoryBrowse()
    this.input = `${this.input.slice(0, this.cursor)}${normalized}${this.input.slice(this.cursor)}`
    this.cursor += normalized.length
    const cols = Math.max(10, this.screenColumns())
    const lineWidth = Math.max(1, cols - 2)
    if (normalized.includes('\n') || displayWidth(this.input) > lineWidth) this.inputFolded = true
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
      case '\x15': this.leaveHistoryBrowse(); this.input = ''; this.cursor = 0; this.inputFolded = false; this.markDirty(); return
      case '\x0b': this.leaveHistoryBrowse(); this.input = this.input.slice(0, this.cursor); this.markDirty(); return
      case '\x0e': this.moveCollapsibleFocus(1); return
      case '\x10': this.moveCollapsibleFocus(-1); return
      case '\x12':
        if (this.focusedRow === null) this.toggleCollapsible()
        else this.toggleAllCollapsible()
        return
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
      this.leaveHistoryBrowse()
      this.input = `${this.input.slice(0, this.cursor)}${char}${this.input.slice(this.cursor)}`
      this.cursor += char.length
      this.markDirty()
    }
  }

  private moveQuestionCursor(delta: number): boolean {
    const dialog = this.dialog
    if (dialog === undefined || dialog.kind !== 'questions') return false
    if (!moveQuestionCursor(dialog, delta)) return false
    this.markDirty()
    return true
  }

  private handleDialogChar(text: string): void {
    const dialog = this.dialog
    if (dialog === undefined) return
    if (dialog.kind === 'inspect') {
      if (inspectClosesOn(text)) this.closeInspect()
      return
    }
    if (dialog.kind === 'onboarding') {
      this.handleOnboardingChar(text)
      return
    }
    if (dialog.kind === 'confirm') {
      const answer = confirmAnswer(text)
      if (answer !== undefined) this.closeConfirm(answer)
      return
    }
    if (selectQuestionOptionByKey(dialog, text)) this.markDirty()
    if (text === '\r' || text === '\n') {
      const submit = questionSubmit(dialog, this.input)
      if (submit.kind === 'reject') {
        // no selection: treat as cancel unless there are no options
        dialog.reject(new UserQuestionError('ask_user_question was cancelled', 'ASK_ABORTED'))
        return
      }
      if (submit.kind === 'resolve') {
        dialog.resolve({ selected: submit.selected, ...(submit.custom === undefined ? {} : { custom: submit.custom }) })
        if (submit.custom !== undefined) {
          this.input = ''
          this.cursor = 0
        }
        return
      }
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

  /**
   * The wizard's first-step list: the pinned templates plus the web-catalog
   * presets (deduped), filtered by the search box text.
   */
  private mergedProviderEntries(state: OnboardingState): ProviderListEntry[] {
    const templates = providerTemplates()
    const templateEntries: ProviderListEntry[] = [
      { key: 'template:official', label: templates.official.label, detail: 'api.deepseek.com' },
      { key: 'template:opencode-go', label: templates['opencode-go'].label, detail: 'opencode.ai/zen/go · Responses' },
      { key: 'template:openai-completions', label: templates['openai-completions'].label, detail: 'openai-completions' },
      { key: 'template:openai-responses', label: templates['openai-responses'].label, detail: 'openai-responses' },
      { key: 'template:anthropic-messages', label: templates['anthropic-messages'].label, detail: 'anthropic-messages' },
    ]
    return mergeProviderEntries(templateEntries, state.catalogPresets ?? [], ['deepseek', 'opencode-go'], this.input)
  }

  private moveProviderCursor(delta: number): boolean {
    const state = this.onboarding
    if (state === undefined || state.step !== 'provider') return false
    const total = this.mergedProviderEntries(state).length
    if (total === 0) return false
    state.providerCursor = Math.max(0, Math.min(total - 1, state.providerCursor + delta))
    this.markDirty()
    return true
  }

  private handleOnboardingChar(text: string): void {
    const state = this.onboarding
    if (state === undefined) return
    switch (state.step) {
      case 'provider': {
        const options = this.mergedProviderEntries(state)
        if (text === '\r' || text === '\n') {
          const index = Math.min(state.providerCursor, options.length - 1)
          const entry = options[index]
          if (entry === undefined) {
            this.markDirty()
            return
          }
          state.providerId = ''
          state.baseUrl = ''
          state.key = ''
          state.models = []
          this.input = ''
          this.cursor = 0
          if (entry.catalog !== undefined) {
            state.providerType = 'catalog'
            state.catalog = entry.catalog
            state.step = 'id'
          } else {
            state.providerType = entry.key.slice('template:'.length) as OnboardingProviderType
            this.advanceOnboarding()
          }
          this.markDirty()
          return
        }
        if (text === '\x7f') {
          if (this.input !== '') {
            this.input = this.input.slice(0, -1)
            state.providerCursor = 0
          }
          this.markDirty()
          return
        }
        let changed = false
        for (const char of text) {
          if (char >= ' ' && char !== '\x7f') {
            this.input = `${this.input.slice(0, this.cursor)}${char}${this.input.slice(this.cursor)}`
            this.cursor += char.length
            changed = true
          }
        }
        if (changed) {
          state.providerCursor = 0
          this.markDirty()
        }
        return
      }
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
            const template = onboardTemplate(state)
            const id = value === '' ? template.defaultId : value
            if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
              this.pushRow({ kind: 'error', text: t('onboard.idInvalid') })
              this.markDirty()
              return
            }
            state.providerId = id
          } else if (state.step === 'key') {
            if (value === '' && state.providerType !== 'catalog') {
              this.pushRow({ kind: 'error', text: t('onboard.keyEmpty') })
              this.markDirty()
              return
            }
            state.key = value
          } else if (state.step === 'models') {
            const template = onboardTemplate(state)
            const parsed = value === ''
              ? template.defaultModels
              : value.split(/[\s,，]+/u).filter(Boolean)
            if (parsed.length === 0) {
              this.pushRow({ kind: 'error', text: t('onboard.needModel') })
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
    const template = onboardTemplate(state)
    const providerType = state.providerType
    const baseUrl = state.baseUrl
    const key = state.key
    const baseURL = baseUrl === '' ? template.defaultBaseUrl : baseUrl
    if (baseURL === '' && providerType !== 'catalog') {
      this.pushRow({ kind: 'error', text: t('onboard.needBase') })
      this.markDirty()
      return
    }
    const previousStatus = this.status
    this.status = t('onboard.fetchingModels')
    this.markDirty()
    try {
      const llm = this.ctx.get('llm')
      if (llm === undefined) throw new Error(t('onboard.llmMissing'))
      const discovered = await discoverProviderModels(llm, {
        ...(providerType === 'catalog' && state.catalog !== undefined && baseURL === ''
          ? {}
          : { baseURL }),
        ...(providerType === 'catalog' && state.catalog !== undefined ? { provider: state.catalog.id } : {}),
        ...(template.api === undefined ? {} : { api: template.api }),
        ...(key === '' ? {} : { apiKey: key }),
      }, AbortSignal.timeout(15_000))
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
        this.pushRow({ kind: 'error', text: t('onboard.noModels') })
      } else {
        state.models = ids
        this.input = ''
        this.cursor = 0
        this.pushRow({ kind: 'system', text: t('onboard.fetchedModels', { count: ids.length, list: formatModelList(ids, 6) }) })
      }
    } catch (error) {
      this.pushRow({ kind: 'error', text: t('onboard.fetchFailed', { error: errorChain(error) }) })
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
      const template = onboardTemplate(state)

      if (state.providerType === 'official') {
        const envRef = 'DEEPSEEK_API_KEY'
        await this.saveCredential(credentials, envRef, state.key)
        const model = state.models[0] ?? 'deepseek-v4-pro'
        await this.ctx.get('agentDefaultModel')?.saveSelection({ provider: 'deepseek-official', model })
        if (this.selectionRef !== undefined) {
          this.selectionRef.current = { provider: 'deepseek-official', model }
        }
        this.onSelectionChanged?.({ provider: 'deepseek-official', model })
        await this.rememberRoute({ provider: 'deepseek-official', model })
        await this.syncSubagentToProvider('deepseek-official', state.models)
        if (state.baseUrl !== '' && settings !== undefined) {
          await settings.update(settingsNamespace('llm-deepseek'), { baseURL: state.baseUrl })
          this.pushRow({ kind: 'system', text: t('onboard.baseSaved', { path: displayDshPath('settings.yaml') }) })
        }
        if (saved) {
          this.pushRow({
            kind: 'system',
            text: t('onboard.officialDone', { model }),
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
        const existing = this.piAiProviderProfile(state.providerId)
        const existingModels = Array.isArray(existing?.models) ? existing.models : []
        const mergedIds: string[] = []
        const seen = new Set<string>()
        for (const id of state.models) {
          if (id !== '' && !seen.has(id)) {
            seen.add(id)
            mergedIds.push(id)
          }
        }
        for (const raw of existingModels) {
          const id = typeof raw === 'string'
            ? raw
            : typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string'
              ? (raw as { id: string }).id
              : ''
          if (id !== '' && !seen.has(id)) {
            seen.add(id)
            mergedIds.push(id)
          }
        }
        // Catalog routes mirror the web's model settings: an empty profile is
        // valid — the installed catalog serves endpoint, protocol, and models,
        // and an absent key defers to the provider's own environment auth.
        const catalogRoute = state.providerType === 'catalog' && state.catalog !== undefined
        const keyless = catalogRoute && state.key === ''
        const profile = {
          displayName: typeof existing?.displayName === 'string' && existing.displayName.trim() !== ''
            ? existing.displayName
            : template.label,
          ...(keyless ? {} : { apiKeyEnv: envRef }),
          api: template.api ?? existing?.api,
          ...(catalogRoute && state.baseUrl === ''
            ? {}
            : {
                baseURL: state.baseUrl === ''
                  ? (typeof existing?.baseURL === 'string' && existing.baseURL !== '' ? existing.baseURL : template.defaultBaseUrl)
                  : state.baseUrl,
              }),
          models: mergedIds.map(id => ({
            id,
            ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
          })),
          ...(defaultEffort === undefined ? {} : { reasoning: defaultEffort }),
        }
        if (settings === undefined) {
          this.pushRow({ kind: 'error', text: t('onboard.settingsMissing') })
          saved = false
        } else {
          await settings.mutate(settingsNamespace('llm-pi-ai'), [
            { op: 'set', path: ['providers', state.providerId], value: profile },
          ])
          this.pushRow({ kind: 'system', text: t('onboard.providerSaved', { id: state.providerId, path: displayDshPath('settings.yaml') }) })
        }
        // Only store the key when its provider profile actually made it to
        // settings; otherwise the saved key points at an unusable route.
        if (saved && !keyless) await this.saveCredential(credentials, envRef, state.key)
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
          await this.rememberRoute(selection)
          await this.syncSubagentToProvider(state.providerId, state.models)
          this.pushRow({
            kind: 'system',
            text: t('onboard.customDone', { id: state.providerId, model }),
          })
        }
      }
    } catch (error) {
      saved = false
      this.pushRow({ kind: 'error', text: t('onboard.saveFailed', { error: errorChain(error) }) })
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
      this.pushRow({ kind: 'system', text: t('onboard.credSaved', { env: envRef, path: displayDshPath('.credentials.yaml') }) })
      return
    }
    await this.writeLaunchEnv({ [envRef]: key })
    this.pushRow({
      kind: 'system',
      text: shadowed
        ? IS_WINDOWS
          ? t('onboard.envShadowWin', { env: envRef })
          : t('onboard.envShadowUnix', { env: envRef })
        : t('onboard.credMissing', { path: displayDshPath(IS_WINDOWS ? 'env.cmd' : 'env.sh') }),
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
      if (this.dialog.kind === 'inspect') {
        this.closeInspect()
        return
      }
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
      this.pushRow({ kind: 'system', text: t('cancel.esc') })
      this.agent.cancel({ kind: 'user' })
      this.status = 'cancelling…'
      this.markDirty()
    }
  }

  /** Toggle the collapsible row under a click, or copy an OSC-8 link. */
  handleMouseClick(y: number, x = 1): void {
    if (this.dialog !== undefined) return
    const hits = this.paintedLinkHitsByRow.get(y)
    const href = hits === undefined ? undefined : hrefAtColumn(hits, Math.max(0, x - 1))
    if (href !== undefined && href.trim() !== '') {
      this.copyPlainText(href, t('copy.link', { url: href }))
      return
    }
    if (this.cwdChipRow !== undefined && y === this.cwdChipRow) {
      this.announceWorkspaceCwd()
      return
    }
    const row = this.clickableRows.get(y)
    if (row === undefined) return
    this.toggleCard(row)
  }

  private copyPlainText(text: string, notice: string): void {
    this.copyYank = text
    this.focusedRow = null
    this.input = ''
    this.cursor = 0
    this.inputFolded = false
    this.leaveHistoryBrowse()
    this.write(osc52Clipboard(text))
    this.pushRow({ kind: 'system', text: notice })
    this.markDirty()
  }

  copyFocusedCard(): boolean {
    if (this.dialog !== undefined) return false
    const picked = copyTextFromTranscript(this.rows, this.focusedRow)
    if (picked.text.trim() === '') {
      this.pushRow({ kind: 'system', text: t('copy.empty') })
      this.markDirty()
      return false
    }
    const source = picked.source === 'focused' ? t('copy.sourceFocused') : t('copy.sourceAssistant')
    this.copyPlainText(picked.text, t('copy.ok', { chars: picked.text.length, source }))
    return true
  }

  private scrollInspectOrTranscript(delta: number): void {
    if (this.dialog?.kind === 'inspect') {
      this.dialog.offset = Math.max(0, this.dialog.offset + delta)
      this.markDirty()
      return
    }
    if (this.paintTailBudget > 0) {
      this.paintTailBudget = 0
      this.forceFullPaint = true
    }
    this.scrollOffset = Math.max(0, this.scrollOffset + delta)
    this.markDirty()
  }

  private handleCtrlC(): void {
    if (this.dialog !== undefined) {
      this.handleEscape()
      this.lastIdleCtrlCAt = 0
      return
    }
    if (this.agent.status === 'running') {
      this.lastIdleCtrlCAt = 0
      this.pushRow({ kind: 'system', text: t('cancel.ctrlC') })
      this.agent.cancel({ kind: 'user' })
      this.status = 'cancelling…'
      this.markDirty()
      return
    }
    const now = Date.now()
    if (now - this.lastIdleCtrlCAt <= CTRL_C_EXIT_WINDOW_MS) {
      this.lastIdleCtrlCAt = 0
      void this.requestExit(130)
      return
    }
    this.lastIdleCtrlCAt = now
    this.pushRow({ kind: 'system', text: t('exit.ctrlCAgain') })
    this.markDirty()
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
      this.historyIndex = this.history.length
      this.historyDraft = ''
      this.runCommand(text)
      return
    }
    if (this.agentGone) return
    this.history.push(text)
    this.historyIndex = this.history.length
    this.historyDraft = ''
    this.input = ''
    this.cursor = 0
    this.inputFolded = false
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    if (this.agent.status === 'running') {
      this.pendingMessages.set(message.id, text)
      this.pushRow({ kind: 'system', text: t('steer.queued', { text }) })
      this.agent.steer(message)
    } else {
      this.beginWait()
      this.agent.followup(message)
    }
    this.markDirty()
  }

  private runCommand(text: string): void {
    const [command, ...rest] = text.slice(1).split(/\s+/u)
    const arg = rest.join(' ')
    switch (command) {
      case 'help': {
        const local = localizedCommands()
          .filter(item => item.name !== 'help' && item.aliasOf === undefined)
          .map(item => `/${item.name.padEnd(12)} ${item.description}`)
        const seen = new Set(localizedCommands().map(item => item.name))
        const dsh = (this.ctx.get('commands')?.list(this.agent) ?? [])
          .filter(item => !seen.has(item.name))
          .map(item => {
            const descKey = `cmd.${item.name}`
            const desc = t(descKey, undefined, item.description)
            return `/${item.name.padEnd(12)} ${commandAcceptsAttachments(item.input) ? t('cmd.withImagesSuffix', { desc }) : desc}  (dsh)`
          })
        this.pushRow({
          kind: 'system',
          text: [
            ...local,
            ...dsh,
            '',
            t('help.intro1'),
            t('help.intro2'),
            t('help.intro3'),
            t('help.intro4'),
            t('help.intro5'),
            t('help.intro6'),
            t('help.intro7'),
            t('help.intro8'),
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
            this.pushRow({ kind: 'system', text: t('help.modelCancel') })
          } else {
            this.pushRow({ kind: 'error', text: t('cmd.failedNamed', { command: 'model', error: errorChain(error) }) })
          }
          this.markDirty()
        })
        break
      case 'effort':
        void this.runEffortCommand(arg).catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow({ kind: 'system', text: t('help.effortCancel') })
          } else {
            this.pushRow({ kind: 'error', text: t('cmd.failedNamed', { command: 'effort', error: errorChain(error) }) })
          }
          this.markDirty()
        })
        break
      case 'provider':
        void this.runProviderCommand().catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow({ kind: 'system', text: t('help.providerCancel') })
          } else {
            this.pushRow({ kind: 'error', text: t('cmd.failedNamed', { command: 'provider', error: errorChain(error) }) })
          }
          this.markDirty()
        })
        break
      case 'submodel':
        void this.runSubmodelCommand(arg).catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow({ kind: 'system', text: t('help.submodelCancel') })
          } else {
            this.pushRow({ kind: 'error', text: t('cmd.failedNamed', { command: 'submodel', error: errorChain(error) }) })
          }
          this.markDirty()
        })
        break
      case 'subeffort':
        void this.runSubeffortCommand(arg).catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow({ kind: 'system', text: t('help.subeffortCancel') })
          } else {
            this.pushRow({ kind: 'error', text: t('cmd.failedNamed', { command: 'subeffort', error: errorChain(error) }) })
          }
          this.markDirty()
        })
        break
      case 'mode':
        void this.runModeCommand(arg).catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow({ kind: 'system', text: t('help.modeCancel') })
          } else {
            this.pushRow({ kind: 'error', text: t('cmd.failedNamed', { command: 'mode', error: errorChain(error) }) })
          }
          this.markDirty()
        })
        break
      case 'language':
      case 'lang':
        void this.runLanguageCommand(arg).catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow({ kind: 'system', text: t('help.modeCancel') })
          } else {
            this.pushRow({ kind: 'error', text: t('cmd.failedNamed', { command: 'language', error: errorChain(error) }) })
          }
          this.markDirty()
        })
        break
      case 'view':
        void this.runViewCommand(arg).catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow({ kind: 'system', text: t('help.modeCancel') })
          } else {
            this.pushRow({ kind: 'error', text: t('cmd.failedNamed', { command: 'view', error: errorChain(error) }) })
          }
          this.markDirty()
        })
        break
      case 'disconnect':
        void this.runDisconnectCommand(arg).catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow({ kind: 'system', text: t('help.modeCancel') })
          } else {
            this.pushRow({ kind: 'error', text: t('cmd.failedNamed', { command: 'disconnect', error: errorChain(error) }) })
          }
          this.markDirty()
        })
        break
      case 'copy':
        this.copyFocusedCard()
        break
      case 'find':
        this.runFindCommand(arg)
        break
      case 'clear':
        this.rows.length = 0
        this.streaming = undefined
        this.streamingReasoning = undefined
        this.thinkingStartedAt = undefined
        this.waitStartedAt = undefined
        this.focusedRow = null
        this.searchHits = []
        this.searchIndex = -1
        this.searchQuery = ''
        this.planNudgePending = false
        this.pendingReveal = undefined
        this.pushRow({ kind: 'system', text: t('clear.transcript') })
        break
      case 'status':
        {
          const plan = this.findLivePlanRow()
          const waiting = this.rows.filter(row => row.kind === 'question' && row.status === 'waiting').length
          const provider = this.currentProviderId()
          const model = this.selectionRef?.current?.model ?? this.agent.options.model ?? 'default'
          const effort = this.selectionRef?.current?.reasoningEffort
          const sub = this.subagentSelection.current
          const quota = this.quotaSnapshot !== undefined && this.quotaSnapshot.provider === provider
            ? this.quotaSnapshot
            : undefined
          const lines = formatStatusReport({
            sessionId: this.agent.id,
            pluginVersion: PLUGIN_VERSION,
            provider,
            model,
            ...(effort === undefined ? {} : { effort }),
            agentStatus: this.agent.status,
            preset: this.presetName,
            activeSubagents: this.activeSubagents.size,
            plan: plan === undefined ? 'off' : plan.pending ? 'pending' : plan.active ? 'on' : 'off',
            paint: formatLinkQualityChip(this.paintLink, this.paintIntervalMs, this.paintRttMs, this.paintProbed),
            disconnect: this.disconnectPolicy,
            waitingQuestions: waiting,
            ...(quota === undefined ? {} : { quota }),
            ...(this.contextPressure === undefined ? {} : { context: this.contextPressure }),
            parentModel: model,
            ...(sub.provider === undefined ? {} : { subProvider: sub.provider }),
            subModel: sub.model,
            cwd: this.workspaceCwd(),
          })
          this.pushRow({ kind: 'system', text: lines.join('\n') })
        }
        break
      case 'diag':
        void this.runDiagCommand().catch((error: unknown) => {
          this.pushRow({ kind: 'error', text: t('cmd.failedNamed', { command, error: errorChain(error) }) })
          this.markDirty()
        })
        break
      case 'usage':
      case 'balance':
      case 'quota':
        void this.runUsageCommand().catch((error: unknown) => {
          this.pushRow({ kind: 'error', text: t('cmd.failedNamed', { command, error: errorChain(error) }) })
          this.markDirty()
        })
        break
      case 'subagents': {
        const trimmed = arg.trim()
        if (trimmed !== '' && trimmed !== 'list') {
          const [action, ...ids] = trimmed.split(/\s+/u)
          if (action === 'kill' || action === 'stop') {
            if (ids.length === 0) {
              this.pushRow({ kind: 'error', text: t('sub.killNeedId') })
              break
            }
            const subagents = this.ctx.get('subagents')
            if (subagents === undefined) {
              this.pushRow({ kind: 'error', text: t('cmd.serviceMissing', { service: 'subagents' }) })
              break
            }
            const targets = ids.map(id => SessionId(id))
            void subagents.drainContinuableChildren(this.agent, targets).then(() => {
              this.pushRow({ kind: 'system', text: t('sub.killRequested', { ids: ids.join(', ') }) })
              this.markDirty()
            }).catch((error: unknown) => {
              this.pushRow({ kind: 'error', text: `/subagents kill failed: ${errorChain(error)}` })
              this.markDirty()
            })
            break
          }
          this.pushRow({ kind: 'error', text: t('sub.unknownAction', { action }) })
          break
        }
        if (this.activeSubagents.size === 0) {
          this.pushRow({ kind: 'system', text: t('sub.none') })
        } else {
          const lines = [...this.activeSubagents.entries()].map(([runId, sub]) => {
            const card = this.findSubagentRow(sub.id)
            const label = card?.label ?? sub.id
            const activity = card?.lastActivity ? ` · ${card.lastActivity}` : ''
            return t('sub.listLine', {
              label,
              id: sub.id,
              provider: sub.provider,
              seconds: Math.floor((Date.now() - sub.startedAt) / 1000),
              run: runId.slice(0, 8),
              activity,
            })
          })
          this.pushRow({ kind: 'system', text: t('sub.listHint', { lines: lines.join('\n') }) })
        }
        break
      }
      case 'resume':
        void this.runResumeCommand(arg).catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow({ kind: 'system', text: t('resume.cancelled') })
          } else {
            this.pushRow({ kind: 'error', text: t('cmd.failedNamed', { command: 'resume', error: errorChain(error) }) })
          }
          this.markDirty()
        })
        break
      case 'approval': {
        const requested = arg.trim() === '' ? 'toggle' : arg.trim()
        if (isApprovalStatusArg(requested)) {
          this.pushRow({
            kind: 'system',
            text: this.autoApprovalMode === 'auto'
              ? t('approval.statusAuto', {
                allowed: this.autoAllowedCount,
                denied: this.autoDeniedCount,
                reviewed: this.aiReviewCount,
              })
              : t('approval.statusOff'),
          })
          this.markDirty()
          break
        }
        const next = requested === 'toggle'
          ? this.autoApprovalMode === 'auto' ? 'off' : 'auto'
          : parseAutoApprovalMode(requested)
        if (next === undefined) {
          this.pushRow({ kind: 'error', text: t('approval.unknown', { arg: requested }) })
          this.markDirty()
          break
        }
        this.autoApprovalMode = next
        void this.mergeUiSettings({ autoApproval: next }).catch((error: unknown) => {
          this.pushRow({ kind: 'error', text: t('cmd.failedNamed', { command: 'approval', error: errorChain(error) }) })
          this.markDirty()
        })
        this.pushRow({
          kind: 'system',
          text: next === 'auto' ? t('approval.autoOn') : t('approval.autoOff'),
        })
        if (next === 'auto') this.warnApprovalMismatch()
        this.markDirty()
        break
      }
      case 'setup':
        void this.runOnboarding()
        break
      case 'dialog-test': {
        const questions = this.ctx.get('userQuestions')
        if (questions === undefined) {
          this.pushRow({ kind: 'error', text: t('cmd.serviceMissing', { service: 'userQuestions' }) })
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
            this.pushRow({ kind: 'system', text: t('dialog.answer', { json: JSON.stringify(answer) }) })
            this.markDirty()
          },
          (error) => {
            this.pushRow({ kind: 'error', text: t('dialog.error', { error: errorChain(error) }) })
            this.markDirty()
          },
        )
        break
      }
      default:
        {
          const commands = this.ctx.get('commands')
          if (commands === undefined) {
            this.pushRow({ kind: 'error', text: t('cmd.unknown', { command }) })
            break
          }
          if (command === 'compact') {
            this.dispatchCompactCommand('user')
            break
          }
          this.commandAbort?.abort()
          const controller = new AbortController()
          this.commandAbort = controller
          void commands.execute(this.agent, text, [], controller.signal).then((execution) => {
            if (execution === undefined) {
              this.pushRow({ kind: 'error', text: t('cmd.unknown', { command }) })
              return
            }
            // command/run + command/done already paint via handleCommandDone
            // when the session log is live. Fall back if those events never
            // arrived (no persistence, or a handler that skipped the log).
            if (this.seenCommandDoneIds.has(String(execution.commandId))) return
            if (execution.result.kind === 'error') {
              this.pushRow({ kind: 'error', text: formatCompactCommandError(this.formatCommandText(execution.result.text)) })
            } else if (execution.result.text !== undefined && execution.result.text !== '') {
              this.pushRow({ kind: 'system', text: this.formatCommandText(execution.result.text) })
            }
          }).catch((error: unknown) => {
            this.pushRow({ kind: 'error', text: t('cmd.failedNamed', { command, error: errorChain(error) }) })
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
    this.leaveHistoryBrowse()
    const range = this.graphemeBefore(this.cursor)
    this.input = `${this.input.slice(0, range.start)}${this.input.slice(range.end)}`
    this.cursor = range.start
    this.markDirty()
  }

  private deleteAtCursor(): void {
    const range = this.graphemeAfter(this.cursor)
    if (range === undefined) return
    this.leaveHistoryBrowse()
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
    if (this.historyIndex === this.history.length) this.historyDraft = this.input
    if (this.historyIndex <= 0) return
    this.historyIndex -= 1
    this.input = this.history[this.historyIndex] ?? ''
    this.cursor = this.input.length
    this.markDirty()
  }

  private historyForward(): void {
    if (this.historyIndex < 0 || this.historyIndex >= this.history.length) return
    this.historyIndex += 1
    this.input = this.historyIndex >= this.history.length
      ? this.historyDraft
      : (this.history[this.historyIndex] ?? '')
    this.cursor = this.input.length
    this.markDirty()
  }

  /** Typing while browsing history detaches from the saved item. */
  private leaveHistoryBrowse(): void {
    if (this.historyIndex >= 0 && this.historyIndex < this.history.length) {
      this.historyIndex = this.history.length
      this.historyDraft = this.input
    }
  }
}

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
    // Not awaited: the first frames paint while the (chunked) replay fills the
    // transcript, and relay RTT/resize frames keep flowing during the load.
    void controller.replayHistory()
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
    async handleHangup(): Promise<void> {
      await controller?.handleHangup()
    },
    disconnectPolicy(): DisconnectPolicyName {
      return controller?.currentDisconnectPolicy() ?? 'pause'
    },
  }
}
