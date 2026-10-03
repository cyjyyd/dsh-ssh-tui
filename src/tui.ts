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
import { METADATA_FILE, readPresetMetadata, type AgentPreset } from './preset-compat.js'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, errorChain, ReasoningEffortId, type GenerateOptions, type LlmCallConfig, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  commandAcceptsAttachments,
  forEachSessionEvent,
  forEachSessionEventAsync,
  hostSettingsGeneration,
  isTokenDeltaChunk,
  listenHostEvent,
  readSettingsSection,
  REPLAY_YIELD_EVERY,
  sessionEvents,
  settingsNamespace,
  streamChunkOf,
  streamFirstTokenTime,
  streamFrameAttemptId,
  streamFrameOwner,
  toolResultFailed,
  TUI_SOURCE_KIND,
  type SettingsGeneration,
  type StreamChunkLike,
} from './dsh-compat.js'
import { classifyApprovalDetailed, commandForApprovalRequest, isApprovalStatusArg, parseAutoApprovalMode, type AutoApprovalMode } from './auto-approval.js'
import type { FooterActivityKind } from './footer-budget.js'
import {
  auditQuestionPrimaries,
  auditRepresentations,
  formatRepresentationAudit,
  isRepresentation,
  represent,
  REPRESENTATION_POLICY,
  type Durability,
  type Representation,
  type RepresentationAudit,
  type RepresentationMeta,
  type RepresentationSource,
} from './representation.js'
import {
  clampScreenOffset,
  reportRowKind,
  screenFromDialog,
  screenLayout,
  screenPositionText,
  type ReportKind,
  type ScreenState,
} from './screen.js'
import { screenRuntimeStrip } from './footer-budget.js'
import { buildReviewUserMessage, parseReviewOutput, reviewSystemPrompt, type ReviewVerdict } from './approval-reviewer.js'
import { loadProviderCatalog, mergeProviderEntries, type CatalogPreset, type ProviderListEntry } from './provider-catalog.js'
import {
  catalogContextWindow,
  catalogWindowIndex,
  suggestedRouteContextWindow,
} from './context-window.js'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'

import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { formatFooterCwd } from './session-list.js'
import { pruneBlankSessions } from './session-list.js'
import { collectDiag, formatDiag } from './diag.js'
import { ApprovalVerdictCache, cacheableShape, verdictKey, type VerdictKeyInput } from './approval-cache.js'
import { collectDoctor, doctorChecks, formatDoctorReport, rowsToRepair, type DoctorFacts, type DoctorRouting } from './doctor.js'
import { colorDepth, downgradeSgr, type ColorDepth } from './color-depth.js'
import { appendRow, lineModeEnabled, lineModeLines } from './line-mode.js'
import { keymapReport, resolveKeymap, type KeyAction, type ResolvedKeymap } from './keymap.js'
import { classifyAuthFailure, isReasoningReplayFailure, isRequestRejectedFailure, type AuthFailure } from './auth-failure.js'
import {
  activeTheme,
  resolveTheme,
  setActiveTheme,
  themeByName,
  themeEmphasisToken,
  themeExtraToken,
  themeNames,
  themeToken,
  type Theme,
} from './theme.js'
import { presetLabel, profileFromArgv } from './preset-label.js'
import { flattenGroups, groupPresets, optionMatches, type PresetPickerOption } from './preset-picker.js'
import {
  isRefusal,
  planCopy,
  planDelete,
  planMetadata,
  presetDirectory,
  type PresetAuthoringApi,
  type PresetRefusal,
} from './preset-authoring.js'
import {
  ensureRosterRows,
  planDuplicateRepair,
  planRosterRepair,
  formsRowsDeclared,
  rosterPatchPath,
  rosterRows,
  writePatchWithBackup,
  ALL_ROSTER_ROWS,
  type RosterRow,
} from './preset-rows.js'
import {
  SessionStatsTracker,
  sessionTokenTotal,
  statsRowOf,
  type SessionStatsRow,
  type SessionStatsSnapshot,
} from './stats.js'
import {
  QUESTION_OPTION_KEYS,
  applyQuestionFilter,
  backspaceQuestionFilter,
  clearQuestionFilter,
  typeQuestionFilter,
  visibleQuestionIndexes,
  confirmAnswer,
  inspectClosesOn,
  type InspectDialog,
  moveQuestionCursor,
  optionsLength,
  questionOptionIndex,
  initialQuestionSelection,
  questionOptionMarker,
  questionSubmit,
  selectQuestionOptionByKey,
  windowInteractionLines,
  PICKER_ROLE,
  interactionRole,
  stallsTask,
  surfacePriority,
  type ConfirmDialog,
  type Dialog,
  type DialogAnswer,
  type InteractionKind,
  type QuestionDialog,
  type SurfaceRole,
  isSurfaceDialog,
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
  displayHomePath,
  envFileName,
  hostHasOwnConsole,
  IS_WINDOWS,
  restrictPathToUser,
  usesSigwinch,
} from './platform.js'
import { asciiFallbackEnabled } from './platform.js'
import {
  bracketedPasteSequence,
  mouseDisableSequence,
  mouseEnableSequence,
  terminalCapabilities,
  type TerminalCapabilities,
} from './terminal-caps.js'
import { sameSessionRoute, sessionRouteInput, type SessionRoute } from './session-route.js'
import {
  GATEWAY_PROTOCOL_SUFFIX,
  GATEWAY_PROTOCOL_ENDPOINT,
  GATEWAY_PROTOCOL_PREFERENCE,
  advertisedProtocols,
  baseProviderIdOf,
  declaredProtocol,
  gatewayModelTable,
  gatewayServesModel,
  isSiblingOf,
  siblingProviderId,
  siblingProtocolOf,
  splitModelsByProtocol,
  type GatewayProtocol,
} from './gateway-protocol.js'
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
import {
  DEFAULT_SUBAGENT_MODEL,
  SUBAGENT_SETTINGS_NAMESPACE,
  defaultSubagentModelForProvider,
  subagentModelMatchesProvider,
  subagentProviderDiffers,
  subagentSettingsValue,
  type SubagentSelection,
  type SubagentSelectionRef,
} from './subagent-model.js'
import { resolveFreshSuperGrokToken } from './supergrok-token.js'
import { copyTextFromRow, copyTextFromTranscript, latestReplyText } from './copy-text.js'
import {
  artifactIsLive,
  artifactProgress,
  foldPlanArtifacts,
  livePlanArtifact,
  type PlanArtifact,
  type PlanEvent,
  type PlanState,
} from './plan-projection.js'
import {
  approvalDetailText,
  approvalStateFromOutcome,
  inferredApprovalFromResult,
  mergeApproval,
  sameApproval,
  type ToolApproval,
} from './approval-state.js'
import { displayToolName, subagentCourtesyName } from './job-label.js'
import {
  clearWaitingMarker,
  notifyCommand,
  notifyTargetCommand,
  notifyTargetLabel,
  parseNotifyTarget,
  runNotify,
  writeWaitingMarker,
  type NotifyContext,
} from './question-wait.js'
import {
  changesFileLine,
  changesHeader,
  changesRemainderLine,
  changesSummaryVisible,
  renderChangesDiff,
  workspaceChangesOf,
  type ChangesSummary,
} from './workspace-changes.js'

import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import {
  durableQuestionRecords,
  answerSummaryText,
  questionViewOf,
  type QuestionView,
  type DurableQuestionRecord,
} from './question-state.js'

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
  cursorVisualPosition,
  displayWidth,
  fmtElapsedCompact,
  foldInputView,
  highlightAnsiNeedle,
  hrefAtColumn,
  lastCodePoints,
  osc52Clipboard,
  padToWidth,
  paintSegmentedLine,
  paintedLinkHits,
  renderMarkdownLines,
  repeatToWidth,
  sanitizeTerminalText,
  searchContains,
  setAmbiguousWidthMeasured,
  setAmbiguousWidthReserve,
  shimmerText,
  sliceCodePoints,
  stripAnsi,
  truncate,
  truncateToWidth,
  type InputView,
  type TextSegment,
  visibleWidth,
  waitCardCopy,
  wrap,
  wrapSegmented,
  wrapWaitDetails,
} from './term-text.js'
import {
  clampSelection,
  offsetAfterColumn,
  offsetAtColumn,
  orderPoints,
  selectionSpans,
  selectionText,
  type ScreenSelection,
  type SelectableLine,
  type SelectionPoint,
} from './selection.js'
import {
  captureHangupSignals,
  advancePaintedRows,
  composePaintFrame,
  composePaintOutput,
  frameByteBudget,
  detectSshSession,
  formatLinkQualityChip,
  HANGUP_CANCEL_TIMEOUT_MS,
  ignoreFurtherHangupSignals,
  isEscapePrefix,
  isHangupErrno,
  linkQualityOf,
  linkRedrawBudgetMs,
  parseCursorPositionReply,
  PICKER_WINDOW,
  pickerWindowStart,
  probeTerminalRttMs,
  releaseHangupSignals,
  resolvePaintIntervalMs,
  toolBodyLineLimit,
  waitUntilIdleOrTimeout,
  type PaintCadenceSource,
  type PaintLinkKind,
  RTT_HISTORY,
  medianRtt,
} from './paint.js'
import { TerminalInputGuard } from './terminal-input.js'
import {
  contextPressureAlertText,
  contextPressureRingColor,
  contextPressureView,
  formatContextPressureRing,
  describeProviderRoute,
  fitFooterChips,
  fitFooterStatusLine,
  footerActivity,
  footerHealthChip,
  footerIdentityParts,
  footerSubagentForeign,
  paintFooterSubagentChip,
  footerStatsGroups,
  formatContextPressureChip,
  runtimeStrip,
  providerHasQuotaSurface,
  formatStatusReport,
  planRouteBadge,
  shortQuotaPlanName,
  formatTokens,
  parseContextPressure,
  promptPressureTokens,
  providerUsesLocalOAuth,
  shouldIdleAutoCompact,
  type ContextPressureView,
  type FooterChip,
  type FooterStatsInput,
  type FooterStatusInput,
  type FooterStripInput,
} from './footer.js'
import {
  COMMAND_CODE_CREDITS_URL,
  COMMAND_CODE_SUBSCRIPTIONS_URL,
  COMMAND_CODE_USAGE_URL,
  commandCodePeriodStart,
  commandCodeSourceFor,
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
  parseCommandCodeQuota,
  parseDeepSeekBalance,
  parseOpenAiCompatibleBalance,
  parseOpenCodeGoQuota,
  parseSuperGrokBilling,
  preferredQuotaWindow,
  quotaAlertText,
  quotaRefreshEverySteps,
  reasoningEffortsForDefault,
  SUPERGROK_BILLING_URL,
  tightestQuotaWindow,
  type AccountBalanceSnapshot,
  type CommandCodeSource,
  type LlmPiAiProviderProfile,
  type LlmPiAiSection,
  type OpenCodeSource,
  type QuotaSnapshot,
  type QuotaWindow,
} from './quota.js'
import {
  appendSubagentLog,
  foldSubagentUserLog,
  applyTurnEndToPlan,
  buildSubagentHeader,
  cardCategoryLabel,
  cardCategoryOf,
  clipSubagentActivity,
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
  planTurnLeftOpen,
  promptInjectionSources,
  promptInjectionTitle,
  describeSubagentFailure,
  subagentChipSummary,
  subagentDisplayName,
  subagentInspectLines,
  subagentRowFromSpawnTool,
  todoItemKind,
  askQuestions,
  todoProgressLabel,
  TODO_STATUS_MARK,
  type CardCategory,
} from './plan.js'
import {
  buildToolHeader,
  compactEditPath,
  compactFailureLines,
  compactFileStats,
  compactToolBursts,
  compactToolGroups,
  countDiffAddDel,
  countDiffLines,
  countOutputLines,
  diffMetaDiffs,
  diffStatToken,
  formatModelList,
  HIDDEN_TOOL_NAMES,
  PLAN_TOOL_NAMES,
  QUESTION_TOOL_NAMES,
  parseExitStatus,
  planReviewOf,
  presentToolCall,
  type DiffDisplayLine,
  READ_TOOL_NAMES,
  SHELL_TOOL_NAMES,
  SUBAGENT_TOOL_NAMES,
  toolBodyFitsWorkspace,
  toolBodyLines,
  toolTitle,
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
  linkRedrawBudgetMs,
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
  footerSubagentForeign,
  paintFooterSubagentChip,
  formatContextPressureChip,
  formatContextPressureRing,
  formatContextPressureStatusLine,
  formatDuration,
  formatFooterQuota,
  formatQuotaBar,
  formatQuotaUnknown,
  formatStatusReport,
  formatStatusThroughput,
  formatStatusStats,
  providerHasQuotaSurface,
  quotaWindowTag,
  runtimeStrip,
  shortModelName,
  shortQuotaPlanName,
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
  commandCodePeriodStart,
  commandCodeSourceFor,
  crossedQuotaThresholds,
  formatAccountBalance,
  formatFooterBalance,
  formatOpenCodeGoUsage,
  formatQuotaSnapshot,
  formatQuotaStatusLine,
  joinUrl,
  openCodeSourceFor,
  parseCommandCodeQuota,
  parseDeepSeekBalance,
  parseOpenAiCompatibleBalance,
  parseOpenCodeGoQuota,
  parseSuperGrokBilling,
  preferredQuotaWindow,
  quotaAlertText,
  quotaRefreshEverySteps,
  quotaRefreshEveryTurns,
  remainingPercentFromUsed,
  tightestQuotaWindow,
  type AccountBalanceLine,
  type AccountBalanceSnapshot,
  type CommandCodeSource,
  type OpenCodeFlavor,
  type OpenCodeSource,
  type QuotaPeriod,
  type QuotaSnapshot,
  type QuotaWindow,
} from './quota.js'
export {
  commandAcceptsAttachments,
  forEachSessionEvent,
  isTokenDeltaChunk,
  listPersistenceHeaders,
  inspectPersistenceSession,
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
  buildSubagentHeader,
  clipSubagentActivity,
  describeSubagentFailure,
  subagentChipSummary,
  subagentDisplayName,
  subagentInspectLines,
  subagentRowFromSpawnTool,
  foldSubagentUserLog,
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

/**
 * The preset service as `/preset` uses it: the members every supported host
 * has, plus the authoring members the 0.1.5 roster exposes and the 0.1.7
 * registry does not (feature-detected at each call site, never assumed).
 */
type PresetService = PresetAuthoringApi & {
  list(): Promise<AgentPreset[]>
  defaultId: string
  recompose?(ctx: unknown, id: string): Promise<unknown>
  roots?: readonly { path: string; trust: string }[]
}

/** One model an endpoint listing advertises, with whatever capacities it disclosed. */
type DiscoveredModel = { id: string; name?: string; contextWindow?: number; maxTokens?: number }

/** Discover models through the request type both supported lines read.
 *  Cancellation is the third argument (`LlmModelDiscoveryOperation.signal`). */
type ModelDiscoveryHost = {
  discoverModels(
    settingsNs: ReturnType<typeof settingsNamespace>,
    request: {
      baseURL?: string
      api?: string
      apiKey?: string
      provider?: string
    },
    signal?: AbortSignal,
  ): Promise<DiscoveredModel[]>
}

function discoverProviderModels(
  llm: ModelDiscoveryHost,
  request: { provider?: string; baseURL?: string; api?: string; apiKey?: string },
  signal: AbortSignal,
): Promise<DiscoveredModel[]> {
  return llm.discoverModels(settingsNamespace('llm-pi-ai'), request, signal)
}

/**
 * Ask a gateway which routes each of its models answers (`supported_endpoints`
 * in an OpenAI-shaped `GET {baseURL}/models` reply). Command Code publishes
 * them; most gateways do not, and the split then falls back to the built-in
 * table. Best-effort by design: no key, no field, a network error or a shape we
 * do not recognise all mean "no answer", never a failed setup.
 */
async function fetchModelEndpoints(
  baseURL: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Map<string, readonly string[]> | undefined> {
  if (baseURL === '' || apiKey === '') return undefined
  try {
    const response = await fetch(`${baseURL.replace(/\/+$/u, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      // An outer signal (a picker that must not stall) wins when it is shorter.
      signal: signal ?? AbortSignal.timeout(10_000),
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { data?: { id?: unknown; supported_endpoints?: unknown }[] }
    const endpoints = new Map<string, readonly string[]>()
    for (const entry of body.data ?? []) {
      const id = typeof entry?.id === 'string' ? entry.id : ''
      const list = Array.isArray(entry?.supported_endpoints)
        ? entry.supported_endpoints.filter((value): value is string => typeof value === 'string')
        : []
      if (id !== '' && list.length > 0) endpoints.set(id, list)
    }
    return endpoints.size === 0 ? undefined : endpoints
  } catch {
    return undefined
  }
}

/**
 * `'user-questions/request'` is not in the compile-time `Events` map this build
 * sees, so name the listener here and let Cordis dispatch the plain string.
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
  ask: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>,
): () => void {
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

/**
 * The `agent-default-model` settings entry `/model` falls back to writing.
 *
 * 0.1.5 exports this id as `AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE`; 0.1.7
 * removed the export and let the profile own entry ids, which keeps the name the
 * legacy `settings.yaml` section is imported under. Inlined so one build runs
 * against either host — the primary path, `agentDefaultModel.saveSelection`,
 * is the same call on both.
 */
const AGENT_DEFAULT_MODEL_NS = settingsNamespace('agent-default-model')

/**
 * The window llm-pi-ai falls back to when neither a model entry nor the
 * installed catalog sizes a model. The wizard pre-fills it only so a route
 * whose capacity nothing could discover still shows the number it will use.
 */
const HARNESS_DEFAULT_CONTEXT_WINDOW = 262_144


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
  /**
   * The route this resumed session ran on, when it has a record. Applied before
   * the TUI mounts; this is only for saying so on screen.
   */
  restoredRoute?: SessionRoute
  /**
   * What the launcher decided about the resumed route: a supplier that is gone,
   * or one that cannot be routed to at all. Pushed on screen at boot.
   */
  launchNotices?: readonly { kind: 'system' | 'error'; text: string }[]
  /**
   * Report a settled route to the launcher, which owns the per-session record.
   * Absent in tests and in line mode: nothing here touches the disk.
   */
  onRouteSettled?: (route: Omit<SessionRoute, 'updatedAt'>) => void
  /** Provider route selected at launch (defaults to deepseek-official). */
  provider?: string
  /** Model selected at launch (defaults to the saved/fallback model). */
  model?: string
  /** Live model-selection ref installed on the agent; mutated by /model. */
  selectionRef?: ModelSelectionRef
  /** Settings-backed model/effort selection applied to subagent requests. */
  subagentSelection?: SubagentSelectionRef
  /**
   * The terminal capabilities to act on. Defaults to reading the environment;
   * tests pass their own so a suite does not change meaning with the terminal
   * it happens to run in (`TERM=linux node --test` used to fail three cases).
   */
  terminalCaps?: TerminalCapabilities
  /** Active agent-preset id (standard/code/minimal/cordis/...). */
  presetId?: string
  /** Display name of the active preset. */
  presetName?: string
  /**
   * Trust of the root the active preset came from (`system`/`user`). A `user`
   * preset keeps its own published name; a shipped one resolves through the
   * locale dictionary.
   */
  presetTrust?: string
  /** Notify the launcher of an explicit in-process selection change. */
  onSelectionChanged?: (selection: ModelSelection) => void
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
  /**
   * The display just went away, before the Host has decided whether to stay.
   *
   * The lock stops saying `attached` from here: that field is what a resume (and
   * the launch picker's list) reads to decide whether another window is on the
   * session, and leaving it set for the whole cancel-and-flush below turned a
   * reconnect in that window into "already attached to another window".
   */
  onDetach?: () => void | Promise<void>
  /** Host process: no local TTY; paint only through the display socket. */
  headlessDisplay?: boolean
  /** Append events as plain lines instead of painting (see `line-mode`). */
  lineMode?: boolean
  /** Key overrides, action to key name (see `keymap`). */
  keys?: Readonly<Record<string, string>>
  /** Hangup policy while busy: pause cancels the turn; continue lets it finish detached. Idle hangup always exits. */
  disconnectPolicy?: DisconnectPolicyName
}

type OnboardingProviderType =
  | 'official'
  | 'opencode-go'
  | 'command-code'
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'catalog'

interface ProviderTemplate {
  label: string
  defaultId: string
  defaultBaseUrl: string
  api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  /**
   * A gateway whose catalogue spans protocols: one wizard row, several provider
   * entries. Saving files each model under the first protocol here that it
   * supports, so the wizard never asks the user to guess (see
   * `gateway-protocol.ts`).
   */
  protocols?: readonly GatewayProtocol[]
  defaultModels: string[]
  /** Capacities already verified for the template's default models, by id. */
  defaultModelCapacity?: Record<string, { contextWindow?: number; maxTokens?: number }>
}

function providerTemplates(): Record<Exclude<OnboardingProviderType, 'catalog'>, ProviderTemplate> {
  return {
  official: {
    label: t('route.deepseek'),
    defaultId: 'deepseek-official',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModels: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  // One row, both routes: the wizard files each model under the protocol it
  // speaks (the gateway publishes `supported_endpoints`, and its pinned
  // defaults are verified on responses), so nobody has to pick a protocol by
  // hand or discover later that half the catalogue needs the other one.
  'opencode-go': {
    label: t('onboard.providerGo'),
    defaultId: 'opencode-go',
    defaultBaseUrl: 'https://opencode.ai/zen/go/v1',
    api: 'openai-responses',
    protocols: ['openai-responses', 'openai-completions', 'anthropic-messages'],
    defaultModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  // Same shape for Command Code: its chat route bills through the API root's
  // `/alpha/billing/credits`, and its catalogue is split across three
  // protocols, which the splitter reads off `GET /provider/v1/models`.
  'command-code': {
    label: t('onboard.providerCommandCode'),
    defaultId: 'command-code',
    defaultBaseUrl: 'https://api.commandcode.ai/provider/v1',
    api: 'openai-responses',
    protocols: ['openai-responses', 'openai-completions', 'anthropic-messages'],
    defaultModels: ['deepseek/deepseek-v4.1-flash'],
    defaultModelCapacity: { 'deepseek/deepseek-v4.1-flash': { contextWindow: 1_048_576 } },
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
  step: 'provider' | 'id' | 'base-url' | 'key' | 'models' | 'models-pick' | 'model-default' | 'context' | 'confirm'
  providerType: OnboardingProviderType
  providerId: string
  baseUrl: string
  key: string
  models: string[]
  /**
   * The model this session should run once the wizard saves. Chosen explicitly
   * on the models step; when absent the first configured model is used, which
   * is what a typed model list has always meant.
   */
  defaultModel?: string
  /** Models the picker step offers, and the indexes the user checked. */
  modelCandidates?: string[]
  modelChecked?: Set<number>
  /** Highlight in either picker step: the candidate list, then the checked set. */
  modelCursor?: number
  /**
   * `supported_endpoints` per model, when the gateway publishes them (Command
   * Code does). Captured while the key is in hand, because that is the only
   * moment the wizard can ask; absent means the split falls back to the
   * built-in table and then to the gateway's primary protocol.
   */
  modelEndpoints?: Map<string, readonly string[]>
  /** Capacities the endpoint's model listing disclosed, keyed by model id.
   *  A hand-declared gateway has no pi-ai catalog entry, so this is the only
   *  source for its context window and output cap. */
  modelCapacity?: Map<string, { contextWindow?: number; maxTokens?: number }>
  /** Route-level `defaultContextWindow` the wizard will persist, pre-filled
   *  from whatever the listing or the installed catalog sized. */
  routeContextWindow?: number
  /** Web-aligned catalog presets; undefined while loading or when the host's
   *  pi-ai catalog is unreachable (option 6 stays hidden). */
  catalogPresets: CatalogPreset[] | undefined
  /** The catalog preset this run configures (providerType 'catalog'). */
  catalog: CatalogPreset | undefined
  /** Cursor into the merged provider list of the first step. */
  providerCursor: number
  /** True while the wizard's async save is in flight; input is ignored. */
  saving: boolean
  /**
   * The wizard's **own** field, and its caret.
   *
   * It used to borrow the composer's (`setField`), which meant opening `/setup`
   * cleared the draft the reader had typed and typing in the wizard wrote into it
   * — the workspace's text, owned by a screen that is not the workspace (B2.6 §4).
   */
  field: string
  fieldCursor: number
  /**
   * The wizard's own message row: validation, a fetch result, a save error.
   *
   * These were transcript rows; a setup screen owns its own surface, and the
   * framed flow leaves no history behind (B2.6 §12/§13).
   */
  notice?: { kind: 'system' | 'error'; text: string }
  /** True once the wizard has run to completion, so `close` knows what happened. */
  saved?: boolean
  resolve(saved: boolean): void
}

/**
 * The wizard steps that choose models, however they are presented: the id
 * prompt, the multi-select picker, and the session-model pick.
 */
function isModelsStep(step: OnboardingState['step']): boolean {
  return step === 'models' || step === 'models-pick' || step === 'model-default'
}

/**
 * How long a compaction may claim to be running before it is treated as
 * abandoned. A real one finishes in seconds to a couple of minutes; the Host
 * dying mid-compaction leaves `compaction/start` in the log with no end, and
 * that row would otherwise keep the footer on 压缩中 and refuse /compact for
 * the rest of the session's life.
 */
const COMPACTION_STALE_MS = 15 * 60_000

/** How many `<family>\0<model>` → row decisions are remembered. */
const FAMILY_OWNER_CACHE_MAX = 512

/** Lifecycle handle for a mounted interactive terminal channel. */
/**
 * Row fields the display rendering reads, for the per-row render cache.
 *
 * Kept next to the cache's fingerprint rather than beside the row type: the list
 * only has to be complete for *rendering* purposes, and a single place makes it
 * obvious what to extend when the rendering starts reading something new.
 */
const SCALAR_KEY_FIELDS = [
  'kind', 'text', 'summary', 'detail', 'header', 'title', 'output', 'planMarkdown',
  'blockedReason', 'diff', 'command', 'expanded', 'archived', 'status', 'phase', 'signal',
  'more', 'startedAt', 'endedAt', 'flipUntil', 'modelProvider', 'provider', 'model', 'id', 'callId',
] as const

/** Row fields holding structures the rendering walks; compared one level deep. */
const NESTED_KEY_FIELDS = ['todos', 'sources', 'intent'] as const

export interface TuiController {
  dispose(): Promise<void>
  handleHangup(): Promise<void>
  disconnectPolicy(): DisconnectPolicyName
  /**
   * Whether the reader ever typed into this session.
   *
   * The launch path uses it on the way out: a fresh session nothing was typed
   * into is deleted rather than left for other profiles' menus to list.
   */
  sessionHadUserInput(): boolean
}

/**
 * A short duration in the shortest useful unit: `12s` / `3m` / `1h`.
 * Locale-neutral on purpose — it reads the same in both catalogs.
 */
/**
 * The `keys` section of this plugin's settings, if the deployment has one.
 *
 * Read once at construction: a keymap that changed under a running session would
 * move a key mid-use, which is worse than asking for a restart.
 */
function readConfiguredKeys(ctx: { get(name: string): unknown }): Record<string, string> {
  const settings = ctx.get('settings') as { get?: (namespace: string) => unknown } | undefined
  const section = settings?.get?.(settingsNamespace('ssh-tui'))
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return {}
  const keys = (section as { keys?: unknown }).keys
  if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) return {}
  const out: Record<string, string> = {}
  for (const [action, value] of Object.entries(keys as Record<string, unknown>)) {
    if (typeof value === 'string') out[action] = value
  }
  return out
}

function formatShortDuration(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

/**
 * How long a footer echo / notice lives before the row goes back to normal (0.8.2).
 *
 * Six seconds: long enough to read a line that just appeared, short enough that the
 * chrome is the session's again by the time the reader looks up from the keyboard.
 */
const FEEDBACK_TTL_MS = 6_000

/**
 * `DSH_TUI_FEEDBACK_MS` — how long that is, in milliseconds.
 *
 * `0` is the pre-0.8.2 behaviour and a legitimate preference: keep an acknowledgement
 * or a warning until the reader submits something. Anything unreadable or negative
 * falls back to the default rather than to a surprise.
 */
export function resolveFeedbackTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(String(env.DSH_TUI_FEEDBACK_MS ?? '').trim(), 10)
  return Number.isFinite(raw) && raw >= 0 ? raw : FEEDBACK_TTL_MS
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
/** Files named on a collapsed compact burst before the rest are counted. */
const MAX_COMPACT_FILE_STATS = 4
/** Lines of an inspect body that line mode writes into the log before trimming. */
const LINE_MODE_INSPECT_LINES = 80
/**
 * Emphasis inside a filled diff row: a lighter shade of the row's own fill, so
 * a changed word is marked without stepping outside the muted palette. The
 * fills they lighten live in `styleLine` (`diff-add` / `diff-del`).
 */
const STALL_WARNING_MS = 60000
/**
 * A resize this quiet is treated as *the* size, and its frame is painted.
 *
 * It is also the floor on the drag's frame rate: a frame that is cheap both to
 * compose and to deliver repaints as often as this. Forty milliseconds is bought
 * against the *felt* latency rather than against the frame count — on an SSH link
 * the reader is looking at the last frame that reached them, so what they
 * experience while dragging is "how long after I stop moving does the screen
 * agree with the window", and this window is the one knob in that path that is
 * not already fixed by the link, the compose, or the relay's own debounce. A
 * frame that is expensive to compose or to deliver paces itself instead (see
 * {@link resizeBudgetMs}).
 *
 * Dragging a window edge emits a resize event every few milliseconds, and each
 * one used to get a synchronous full repaint: with a long transcript that is
 * ~100 ms of rendering per event, so a two-second drag queued seconds of work
 * and the screen trailed the pointer. Nothing about an intermediate geometry is
 * worth a frame — the reader cannot use it and the next event invalidates it —
 * so a burst collapses to the size the window ends on. This is the same rule the
 * paint path already applies to a burst of streaming tokens.
 */
const RESIZE_SETTLE_MS = 40
/**
 * The ceiling on how long a drag may go unpainted.
 *
 * Without it, a slow drag would leave the chrome (dividers, footer) at the old
 * width for as long as the pointer keeps moving. The real figure is derived from
 * what a frame costs on *this* session — see {@link resizeBudgetMs}.
 */
const RESIZE_MAX_WAIT_MS = 400
/**
 * The smallest gap between two resize frames, on a wire that is keeping up.
 *
 * Not a rate limit — the backlog check is that — but a floor on *self* interference:
 * a terminal can emit resize events in bursts of several within a millisecond, and
 * composing one frame per event there would spend the whole burst on geometries the
 * next event already invalidates. Sixteen milliseconds is one display frame at
 * 60 Hz: below the interval at which a reader can tell two updates apart, and far
 * below the terminal's own redraw of the reflowed grid.
 */
const RESIZE_MIN_INTERVAL_MS = 16
/**
 * How much transcript a resize frame is allowed to re-render.
 *
 * A resize changes the width, and a width is part of every row's render
 * fingerprint: **every** row of the transcript is re-wrapped and re-clipped,
 * every frame. Measured on this machine, one resize frame of a 2400-row session
 * cost 43 ms of synchronous rendering — 75 ms at 5000 rows — and that time is
 * the event loop, so it is also the delay on the reader's next keystroke and on
 * the next resize event. Ten resize events at 8 ms therefore took 947 ms even
 * though only twenty frames were painted, which is exactly what "the screen
 * trails the pointer, and the input box only answers after the reflow" is from
 * the inside.
 *
 * The window shows about {@link RESERVED_BOTTOM_LINES} rows' worth of
 * transcript; the other two thousand are being re-rendered for a reader who
 * cannot see them. So during a drag only the tail is rendered, through the
 * mechanism `--resume` already uses for the same reason (`paintTailBudget`).
 * Measured with a 120-row tail above: 2403 rows 43.3 → 2.4 ms, 5000 rows
 * 75.0 → 2.6 ms — about a 30× cut in event-loop blocking, with the frame's byte
 * count unchanged.
 *
 * The tail is not the truth for long: the first frame after the drag ends
 * clears the budget and repaints the whole transcript at the settled width
 * (one frame, once). While the pointer is moving, an older row's geometry is
 * worthless anyway — the next event invalidates it — and the reader is looking
 * at the bottom of the screen.
 */
const RESIZE_TAIL_MIN_ROWS = 120
/** Bytes already queued for the terminal before a frame is skipped instead. */
const STDOUT_BACKLOG_BYTES = 32 * 1024
/**
 * The most a drag frame may sit in the queue before the next one is skipped.
 *
 * The drag path's threshold is "one frame behind", computed from the frame it
 * just composed ({@link SshTui.resizeWireBehind}). This is only the floor under
 * that: frames of a few hundred bytes are *always* under it, and a drag whose
 * every event queued one would spend the burst painting geometries the queue
 * cannot deliver in time.
 */
const RESIZE_FRAME_QUEUE_FLOOR_BYTES = 2 * 1024
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
/**
 * How often to ask again while the footer still has no quota reading. A quota
 * API that was down at boot is usually up seconds later, and the widget shows
 * `?%` until then; once a reading lands, the normal step/idle cadence takes over.
 */
const QUOTA_RETRY_MS = 15_000

/**
 * The events `@deepseek-ai/dsh-user-questions` folds into its question projection.
 *
 * `request/header` decides whether the calls that follow are *timed* (only those
 * are tracked at all); `tool/call` opens one, `tool/result` settles it, and a late
 * reply to a continued question settles it as a `user/message`.
 */
/**
 * The wizard's nine steps, in the order it asks them.
 *
 * Declared here rather than derived from a counter so the step indicator and the
 * screen's own tests have one source: the *order* is the product decision (B2.6 §3
 * keeps it unchanged), and this is where it is written down.
 */
const SETUP_STEPS = ['provider', 'id', 'base-url', 'key', 'models', 'models-pick', 'model-default', 'context', 'confirm'] as const

/** The steps that show a text field (the others are pickers or the confirmation). */
const SETUP_FIELD_STEPS: ReadonlySet<string> = new Set(['provider', 'id', 'base-url', 'key', 'models', 'context'])

/**
 * The durable event types the plan projection reads (B2.5).
 *
 * `tool/call`/`tool/result` are here for the `exit_plan_mode` review; the recorder
 * filters those to the one tool, so an ordinary tool call never enters the plan log.
 */
const PLAN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'plan/mode',
  'todo/write',
  'command/run',
  'command/done',
  'tool/call',
  'tool/result',
])

const QUESTION_FOLD_EVENTS: ReadonlySet<string> = new Set([
  'request/header',
  'tool/call',
  'tool/result',
  'user/message',
])

const RESERVED_BOTTOM_LINES = 3 // input line + stats line + status line

/**
 * Transcript rows the live region leaves alone.
 *
 * The live region takes rows of its own (see `paint`), and a turn can produce
 * more of them than the screen has: a long streamed reply, an expanded thinking
 * body, a wait card with details. Without a floor the region would eat the whole
 * content area and the reader would lose the history they were reading, so it is
 * capped here and clipped from its own front instead.
 */
const MIN_TRANSCRIPT_ROWS = 3

/**
 * The composer's shape as a Screen sees it: there is no composer.
 *
 * `footerFacts` takes the input view because the *footer* text depends on whether
 * the field is folded or multi-line; a Screen's strip does not read those fields at
 * all, and passing the real composer's shape would claim a Screen shows a composer
 * it does not have.
 */
const SCREEN_INPUT: InputView = { text: '', cursorOffset: 0, folded: false }

/**
 * A plain printable key: what a reader types when they think there is a composer.
 *
 * Escapes and control bytes are excluded on purpose — those are the Screen's own keys
 * (scroll, close, copy), and the copy key arrives as a CSI sequence.
 */
const PRINTABLE = /^[^\u0000-\u001f\u007f\u001b]+$/u

/**
 * The activity kinds that already *are* a wait.
 *
 * The Screen strip's first group is the activity row, which names a wait the
 * session is in; the second group is the work waiting behind the Screen. When the
 * first already says `等待回答`, repeating it in the second says nothing and spends
 * the widest group on a duplicate — so the second group is skipped instead.
 */
const WAIT_ACTIVITY_KINDS: ReadonlySet<string> = new Set(['waiting', 'approval', 'plan-review'])

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
  return displayHomePath(dshHomeDir(), file)
}

const DSH_ENV_FILE = join(dshHomeDir(), envFileName())

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

/**
 * What marks the row the card cursor is on.
 *
 * The card headers spell `▶ ` themselves; a reply is drawn by the markdown
 * renderer, so its marker is prepended and its width is measured from this
 * string (three cells, or two once the ASCII fallback has rewritten it).
 */
const REPLY_FOCUS_MARKER = '▶ '

/**
 * The text an inspect overlay hands to the copy key: what the overlay shows.
 *
 * The overlays are the one place the copy key can be pressed without leaving
 * them (a dialog covers the input line), so the body on screen is what "copy"
 * means there — not the card row that opened it, which for a changes card is a
 * file list and for a tool card a summary the reader has already scrolled past.
 */
function inspectCopyText(lines: readonly DiffDisplayLine[]): string {
  return lines.map(line => line.text).join('\n').replace(/\s+$/u, '')
}

/**
 * One row the card cursor can land on.
 *
 * Every collapsible card, plus the model replies. A reply has nothing to expand,
 * which is why it used to be left out of the ring — and that is exactly what
 * made `/copy` unreachable for it: `/copy` takes the focused row, so as soon as
 * the reader selected any card the reply stopped being a copy target, and the
 * newest reply survived only as the no-focus fallback.
 */
export type FocusTarget = Row | CollapsibleBlock

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

/**
 * The `reasoningEfforts` map `/setup` writes for a hand-declared
 * OpenAI-compatible route.
 *
 * Such a route is absent from pi-ai's catalog, so `defaultReasoningEffort`
 * resolves nothing before the profile is saved and the model would land as a
 * bare `{ id }` entry. The Harness then reports that model as non-reasoning
 * (`levels [off]`) and refuses every effort the TUI itself offers for an
 * undeclared model. Declaring the offered vocabulary up front keeps the model
 * dispatchable; no parameter is sent until an effort is selected.
 * @returns the level-to-wire map, with `off` meaning "send no parameter".
 */
export function handDeclaredReasoningEfforts(): Record<string, string | null> {
  return {
    off: null,
    ...Object.fromEntries(UNDECLARED_EFFORT_IDS.filter(id => id !== 'off').map(id => [id, id])),
  }
}

/**
 * Whether a wizard template speaks the OpenAI completions dialect whose
 * `reasoning_effort` the TUI may declare without a catalog.
 *
 * The Responses dialect maps levels too, but its unset state materializes as
 * `reasoning: { effort: "none" }`, which a custom gateway need not accept, so
 * it keeps the existing undeclared behavior until an endpoint verifies it.
 * @param providerType - the wizard template under test.
 */
function declaresOfferedReasoning(providerType: string): boolean {
  return providerType === 'openai-completions' || providerType === 'command-code'
}

/**
 * The `reasoningEfforts` map `/setup` persists for one model entry.
 *
 * A hand-declared OpenAI-compatible completions route always receives the
 * offered vocabulary; a catalog-backed route keeps whatever live model info
 * resolved, preserving the existing behavior of redeclaring only the chosen
 * default.
 * @param providerType - the wizard template that produced the route.
 * @param defaultEffort - the level resolved from live model info, if any.
 * @returns the level-to-wire map, or `undefined` to declare nothing.
 */
export function onboardingReasoningEfforts(
  providerType: string,
  defaultEffort: string | undefined,
): Record<string, string | null> | undefined {
  if (declaresOfferedReasoning(providerType)) {
    return handDeclaredReasoningEfforts()
  }
  return defaultEffort === undefined ? undefined : { off: null, [defaultEffort]: defaultEffort }
}

/** The id of one configured llm-pi-ai models entry, in either stored form. */
function modelEntryId(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string') {
    return (raw as { id: string }).id
  }
  return undefined
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

/** One line naming the route a resumed session came back on. */
function sessionRouteNotice(route: SessionRoute): string {
  const effort = route.reasoningEffort === undefined || route.reasoningEffort === ''
    ? ''
    : ` (${route.reasoningEffort})`
  const subagent = route.subagent
  const sub = subagent === undefined
    ? ''
    : t('session.routeSubagent', {
        route: `${subagent.provider === undefined ? '' : `${subagent.provider}/`}${subagent.model}`
          + (subagent.reasoningEffort === undefined || subagent.reasoningEffort === ''
            ? ''
            : `(${subagent.reasoningEffort})`),
      })
  return t('session.routeRestored', { route: `${route.provider}/${route.model}${effort}`, sub })
}

/** Owns one interactive terminal channel and its agent event wiring. */
export class SshTui {
  private readonly rows: Row[] = []
  private streaming: { text: string; reasoning: string } | undefined
  private autoApprovalMode: AutoApprovalMode = 'off'
  private autoAllowedCount = 0
  private autoDeniedCount = 0
  private aiReviewCount = 0
  private cacheHitCount = 0
  /** Verdicts this TUI already reviewed, reusable for a bounded time. */
  private readonly approvalCache = new ApprovalVerdictCache()
  /** Host knobs folded from the session log: auto mode needs approval=ask to see requests. */
  private hostSandboxMode: string | undefined
  private hostApprovalPolicy: string | undefined
  private approvalMismatchWarned = false
  /** Web-aligned provider presets from the host's pi-ai catalog (undefined until loaded / when unreachable). */
  private catalogPresets: CatalogPreset[] | undefined
  private catalogLoad: Promise<CatalogPreset[] | undefined> | undefined
  /** Memoized id→window index over {@link catalogPresets}. */
  private catalogWindows: Map<string, number> | undefined
  /** Wizard drafts whose models step is already asking the gateway, so a
   *  second Enter cannot start a duplicate listing. */
  private readonly finishingModels = new WeakSet<OnboardingState>()
  /** `<base>\0<model>` → the family row last seen serving that model. */
  /**
   * `<base>\0<model>` → the family row last seen serving that model.
   *
   * Bounded: a gateway can publish hundreds of models and their rows are
   * re-learned on every listing, so the oldest entries are dropped once the map
   * passes FAMILY_OWNER_CACHE_MAX rather than growing for the life of the
   * session. Losing an entry only costs one future "which row?" lookup.
   */
  private readonly familyModelOwner = new Map<string, string>()
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
  /**
   * What the open dialog *means*, which its shape cannot say: `/model` and
   * `ask_user_question` are both `questions` dialogs, and only one of them means
   * the agent is waiting for a person. Declared by whoever opens the dialog.
   */
  private dialogRole: SurfaceRole = PICKER_ROLE
  private readonly dialogQueue: { dialog: Dialog; role: SurfaceRole }[] = []
  private onboardingCompletion: Promise<boolean> | undefined
  private dirty = true
  private disposed = false
  private exiting = false
  private hangingUp = false
  /** How long the last frame took to compose, for the resize pacing below. */
  private lastPaintCostMs = 0
  private resizeLastEventAt = 0
  private resizeLastPaintAt = 0
  private resizePaintTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Whether a resize frame is currently rendering only the transcript's tail
   * (see {@link narrowToResizeTail}), so the drag's last geometry can be painted
   * whole.
   */
  private resizeTailNarrowed = false

  /**
   * A resize arrived: paint the size the window is *at*, not every size it
   * passed through.
   *
   * Dragging an edge emits an event every few milliseconds, and each one used to
   * get a synchronous full repaint — on a long transcript that is ~100 ms of
   * rendering per event, so a drag queued seconds of work and the screen trailed
   * the pointer. Nothing about an intermediate geometry is worth a frame: the
   * reader cannot use it and the next event invalidates it. Painting the *first*
   * event of a burst is no better, because that geometry is stale by the time the
   * frame is composed and it costs the frame that is actually wanted.
   *
   * So the frame has a deadline, recomputed on every event:
   *
   * - {@link RESIZE_SETTLE_MS} after the newest event (the size has stopped
   *   moving, so this is the geometry the user is looking at), and
   * - at the latest one {@link resizeBudgetMs} after the last frame, so a drag
   *   that never pauses still shows the chrome following the pointer.
   *
   * Whichever comes first wins, and the frame is composed from the terminal's
   * size at the moment it runs — so a newer geometry can never be painted after
   * an older one; the older one is simply never painted.
   */
  private requestResizePaint(now = Date.now()): void {
    if (this.resizeLastEventAt === 0) this.resizeLastPaintAt = now
    this.resizeLastEventAt = now
    // The geometry is read from the terminal at paint time (`screenColumns`), so
    // marking the frame dirty is what carries it; nothing here remembers a size.
    this.forceFullPaint = true
    this.dirty = true
    this.narrowToResizeTail()
    // The pointer follows the window edge, and the terminal reflows its own grid
    // the instant it moves: anything this row does later than that reads as lag.
    // So the answer to an intermediate geometry is a frame, not a wait — unless the
    // previous frame is still on the wire, which is the one case where composing
    // another would only queue a stale one behind it. The wait that remains is
    // then a *drain* deadline, and it is short because it is measuring the wire
    // rather than guessing the link.
    if (!this.resizeWireBehind() && now - this.resizeLastPaintAt >= RESIZE_MIN_INTERVAL_MS) {
      this.resizeLastPaintAt = now
      this.render()
      // A deferred frame (an unattached display, a stall) is still owed.
      if (this.dirty) this.armResizePaint(RESIZE_SETTLE_MS)
      return
    }
    const deadline = Math.min(
      this.resizeLastEventAt + RESIZE_SETTLE_MS,
      this.resizeLastPaintAt + this.resizeBudgetMs(),
    )
    this.armResizePaint(deadline - now)
  }

  /**
   * Whether the previous *drag* frame is still on its way to the terminal.
   *
   * A drag frame is not a token batch: the reader is moving the edge and watching
   * for the screen to agree with it, so a frame composed now would be superseded
   * before it landed. What matters is the *queue*, not the pipe's absolute
   * capacity — measured on a byte-rate-limited consumer, a drag toward a wider
   * window is the case that hurts, because a frame's size is proportional to the
   * width: every frame is bigger than the last while the terminal drains at a
   * fixed rate, the backlog compounds, and the screen keeps moving for tens of
   * milliseconds after the pointer has stopped (30–44 ms measured, against 0–10 ms
   * for the shrinking direction).
   *
   * So the threshold is one frame, not a fixed 32 KB. That constant is right for
   * the cadence path, where the question is "is this link slow"; here the question
   * is "would this frame be a stale geometry queued behind a live one", and the
   * answer is yes as soon as the last one has not been accepted — however small
   * both frames are. The named constant stays as the floor, so a long session's
   * frames can queue a little rather than starving the drag of feedback.
   */
  private resizeWireBehind(): boolean {
    const pending = this.pendingBytes()
    if (pending === undefined) return false
    return pending > Math.max(RESIZE_FRAME_QUEUE_FLOOR_BYTES, this.lastFrameBytes)
  }

  /** Bytes the last frame carried, whoever owns the wire (see above). */
  private lastFrameBytes = 0

  private pendingBytes(): number | undefined {
    const relayed = this.displayHost?.pendingBytes?.()
    if (relayed !== undefined) return relayed
    if (this.displayHost?.attached === true || this.displayDetached) return undefined
    try {
      return process.stdout.writableLength
    } catch {
      return undefined
    }
  }

  /**
   * Cap what a resize frame re-renders, and remember that the frame is a
   * compromise so the drag's last geometry can be painted whole.
   *
   * Both matters, and they are different matters: the cap is what keeps the
   * event loop free while the pointer moves (see
   * {@link RESIZE_TAIL_MIN_ROWS}), and the remembered flag is what stops the
   * compromise from *becoming* the screen — the moment the drag pauses, the
   * transcript is painted in full again at the settled width.
   *
   * A scroll position is left alone: a reader who has scrolled back is looking
   * at rows the tail does not contain, and moving the view under them would be a
   * bigger lie than a slower frame. `paintTailBudget` already refuses to fold
   * anything while `scrollOffset > 0` for the same reason.
   */
  private narrowToResizeTail(): void {
    // A scrolled-back reader is looking at rows the tail does not contain.
    if (this.scrollOffset > 0) return
    if (this.paintTailBudget > 0) {
      this.resizeTailNarrowed = true
      return
    }
    const rows = Math.max(RESIZE_TAIL_MIN_ROWS, this.screenRows() * 3)
    if (this.rows.length <= rows + 8) return
    this.paintTailBudget = rows
    this.resizeTailNarrowed = true
  }

  /**
   * Undo {@link narrowToResizeTail}: the drag has settled, so the frame that is
   * about to be painted must be the whole transcript at the final width.
   */
  private widenPastResizeTail(now = Date.now()): boolean {
    if (!this.resizeTailNarrowed) return true
    if (now - this.resizeLastEventAt < RESIZE_SETTLE_MS) return false
    this.resizeTailNarrowed = false
    if (this.paintTailBudget === 0) return true
    this.paintTailBudget = 0
    this.forceFullPaint = true
    this.dirty = true
    return true
  }

  /**
   * The longest a resize frame may wait when the wire cannot take another one yet.
   *
   * This is a *ceiling*, not a rate: the normal case paints at once (see
   * {@link requestResizePaint}), and this only decides how often a link that is
   * genuinely behind is asked again — the previous frame has not drained, so the
   * next one would be a stale geometry queued behind a live one. Two costs feed it:
   *
   * - **composing** a frame — measured (`lastPaintCostMs`): a short transcript is a
   *   few milliseconds and a long one is a hundred, and repainting faster than that
   *   starves the event loop that has to receive the next resize;
   * - **delivering** one on a link whose speed is unknown (see
   *   {@link linkRedrawBudgetMs}: only an unprobed link falls back to a slow
   *   budget, because there the interval in force is a number nobody measured).
   *
   * A probed link does not need the second term: the backlog check above already
   * says whether it is keeping up, and pacing it from the round trip as well would
   * put the artificial delay back that this function exists to avoid.
   */
  private resizeBudgetMs(): number {
    const unknownLink = this.paintLink === 'ssh' && this.paintCadence === 'unprobed'
    return Math.min(RESIZE_MAX_WAIT_MS, Math.max(
      RESIZE_SETTLE_MS,
      this.lastPaintCostMs * 2,
      unknownLink ? linkRedrawBudgetMs(this.paintLink, this.paintCadence, this.paintIntervalMs) : 0,
    ))
  }

  /**
   * Whether a resize is holding the frame.
   *
   * While a deadline is armed the burst is collapsing, and the cadence timer must
   * not paint on its own: it fires on the paint interval, which is *shorter* than
   * the budget a heavy session needs, so leaving both flushers live put the frame
   * count back near one per event — the cost this exists to remove. Content that
   * changes mid-drag waits at most one budget.
   */
  private resizeBurstOpen(): boolean {
    return this.resizePaintTimer !== undefined
  }

  /** (Re)arm the frame's deadline. Every event pushes it out. */
  private armResizePaint(delayMs: number): void {
    if (this.resizePaintTimer !== undefined) clearTimeout(this.resizePaintTimer)
    this.resizePaintTimer = setTimeout(() => {
      this.resizePaintTimer = undefined
      if (this.exiting) return
      // A pause in the drag is the one moment the whole transcript is worth
      // rendering: the width has stopped moving, so the rows being folded away
      // are about to become what the reader is looking at again.
      const quiet = this.widenPastResizeTail()
      this.forceFullPaint = true
      this.dirty = true
      this.resizeLastPaintAt = Date.now()
      this.render()
      if (this.dirty) {
        // Deferred (a backlogged stdout, an unattached display): the frame is
        // still owed, and only this timer is holding it.
        this.armResizePaint(RESIZE_SETTLE_MS)
        return
      }
      // A drag that is still moving fires this deadline *before* it is quiet —
      // the deadline is `min(lastEvent + settle, lastPaint + budget)` — and the
      // fold has to be lifted once the pointer really stops, not at whatever
      // moment the last frame happened to be due. Nothing else is watching: the
      // cadence timer stands down while a burst is open (`resizeBurstOpen`), so
      // without this the transcript would stay folded with no event left to
      // notice it.
      if (this.resizeTailNarrowed && !quiet) {
        this.armResizePaint(RESIZE_SETTLE_MS)
      }
    }, Math.max(0, delayMs))
    this.resizePaintTimer.unref?.()
  }

  private readonly onDirectResize = (): void => {
    this.requestResizePaint()
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
  private readonly onDetach: (() => void | Promise<void>) | undefined
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
  private readonly onSelectionChanged: ((selection: ModelSelection) => void) | undefined
  private readonly onRouteSettled: ((route: Omit<SessionRoute, 'updatedAt'>) => void) | undefined
  private readonly disposers: (() => void)[] = []
  private userQuestionDisposer: (() => void) | undefined
  private presetId = 'standard'
  private presetName = t('mode.preset.standard')
  /** Last route reported to the launcher; a repaint must not report it again. */
  private lastSessionRoute: SessionRoute | undefined
  private readonly useAlternateScreen: boolean
  /**
   * What the terminal in front of us can do. Read from the environment at
   * construction (see `terminal-caps.ts`): the mouse, bracketed paste and the
   * alternate screen are only claimed where the terminal has them.
   */
  private readonly terminalCaps: TerminalCapabilities
  /** The OSC 52 caveat is worth saying once, not after every copy. */
  private osc52HintShown = false
  private agentGone = false
  private onboarding: OnboardingState | undefined
  private commandSuggestions: { name: string; description: string; local: boolean }[] = []
  private suggestionIndex = 0
  private focusedRow: FocusTarget | null = null
  /**
   * The active palette. Roles resolve through `theme.ts`, so switching themes is
   * a repaint, not a re-render — no row holds a colour of its own.
   */
  private theme: Theme = resolveTheme(undefined)

  /**
   * Rendered display lines per row, keyed by the row object.
   *
   * Every frame used to re-render the whole transcript — markdown parsing, card
   * layout, wrapping and clipping for thousands of rows — to show the twenty on
   * screen. Measured on a 5000-row session that was ~550 ms per frame, which is
   * what "rendering feels slower the longer the session runs" was: a keystroke
   * costs the same as a full repaint because both redo all of it.
   *
   * The cache is `WeakMap`-keyed on the row object, so a replaced row starts a new
   * entry and an unreferenced one is collected. What each entry stores is a
   * *fingerprint* of every input the row's rendering depends on plus the lines it
   * produced; a row whose fingerprint is unchanged replays instead of re-rendering,
   * which is the common case — during a turn only the streaming row changes.
   */
  private displayRowCache = new WeakMap<Row, { key: string; lines: string[]; refs: unknown[]; gutters: number[] }>()


  /** Fingerprint of the state that affects *every* row's rendering. */
  private displayBaseKey(width: number): string {
    return [
      width,
      String(this.isCompactView()),
      this.showReasoning === true ? 'r' : '-',
      this.searchIndex,
      this.searchHits.length,
      this.theme.name,
      this.colorDepth,
      // Which card is focused, not which *kind* of card: two tool cards in a row are
      // the common case, and a kind-only key replayed the old card's cached lines —
      // including its selection highlight — so the highlight stayed on the card the
      // reader had just left and never reached the one they moved to. The focused
      // row's position is the identity here (the synthetic live block is not a row,
      // so it gets its own token), and a shift in that position only makes the cache
      // more conservative.
      this.focusedRow === null
        ? ''
        : String(this.rows.indexOf(this.focusedRow as Row)) === '-1'
          ? 'block'
          : String(this.rows.indexOf(this.focusedRow as Row)),
      String(this.paintTailBudget),
      this.pendingReveal === undefined ? '' : String(this.pendingReveal),
      asciiFallbackEnabled() ? 'ascii' : 'utf8',
    ].join('|')
  }

  /**
   * Fingerprint of one tool burst.
   *
   * A burst is a *group of tool rows drawn inside the reply above them*, so the
   * reply's cached lines contain cards belonging to rows the reply's own
   * fingerprint never sees. Without this, the reply kept replaying its cached
   * burst: a finished tool went on saying "processing" and the stale card stayed
   * on screen beside the live one — the residue a reader reported twice.
   */
  private static burstKey(groups: { edits: Row[]; calls: Row[] }): string {
    const one = (rows: Row[]): string =>
      rows.map(row => {
        const loose = row as unknown as Record<string, unknown>
        const output = typeof loose.output === 'string' ? loose.output.length : 0
        return `${String(loose.callId ?? '')}/${String(loose.status ?? '')}/${output}`
      }).join(',')
    return `${one(groups.edits)}#${one(groups.calls)}`
  }

  /**
   * Whether a row's rendering depends on the clock.
   *
   * A running card draws a spinner and an elapsed time, and a streaming row is
   * being appended to: their *fields* may not change between two frames while
   * their lines must. Such a row gets a tick in its cache key, so it re-renders
   * every frame and becomes cacheable again once it settles. A frozen spinner was
   * the alternative — and, once the same card was also drawn live elsewhere, the
   * duplicate a reader actually reported.
   */
  private static isLiveRow(row: Row): boolean {
    const loose = row as unknown as Record<string, unknown>
    if (String(loose.kind ?? '').startsWith('streaming')) return true
    if (loose.status === 'running') return true
    if (loose.endedAt === undefined && loose.startedAt !== undefined) return true
    const flipUntil = loose.flipUntil
    return typeof flipUntil === 'number' && flipUntil > Date.now()
  }

  /**
   * Fingerprint of everything one row's rendering reads.
   *
   * Written by hand rather than hashing the object: the rendering reads a known
   * set of fields, and a generic walk would cost more per frame than the render
   * it is meant to avoid. Scalar fields are compared by value; nested arrays the
   * rendering walks (todos, sources, intent) get a shallow signature of their own
   * scalars, because those are updated in place.
   *
   * The list is a contract: a field the rendering starts reading must be added
   * here, or a frame replays stale lines. A test mutates one field in place and
   * asserts the next frame notices, which is the pattern to copy for a new field.
   */
  private static rowKey(row: Row): string {
    const loose = row as unknown as Record<string, unknown>
    let key = ''
    for (const field of SCALAR_KEY_FIELDS) {
      const value = loose[field]
      key += typeof value === 'string' ? `${value.length}:${value.charCodeAt(0)}:${value.charCodeAt(value.length - 1)};`
        : value === undefined ? '-;'
          : `${String(value)};`
    }
    for (const field of NESTED_KEY_FIELDS) {
      const value = loose[field]
      if (value === undefined) {
        key += '-;'
        continue
      }
      if (!Array.isArray(value)) {
        key += `o${Object.keys(value as object).length};`
        continue
      }
      key += `a${value.length}:`
      // Bounded: a list longer than this changes its length when it changes, and
      // walking hundreds of items per frame would defeat the cache.
      for (const item of value.slice(0, 24)) {
        if (item === null || typeof item !== 'object') {
          key += String(item) + ','
          continue
        }
        for (const [name, inner] of Object.entries(item as Record<string, unknown>)) {
          key += name + '=' + (typeof inner === 'string' ? inner.length : String(inner)) + ','
        }
        key += '|'
      }
      key += ';'
    }
    return key
  }

  private static rowRendersEqual(
    row: Row,
    entry: { key: string; lines: string[]; refs: unknown[]; gutters: number[] } | undefined,
    key: string,
  ): entry is { key: string; lines: string[]; refs: unknown[]; gutters: number[] } {
    return entry !== undefined && entry.key === key
  }
  /**
   * The text of the last prompt the user sent, kept so an opted-in retry can
   * send the same thing again after a provider-side auth failure. Cleared when
   * the retry fires, which is what bounds it to one attempt per user message.
   */
  /**
   * Whether this session ever saw the reader's input.
   *
   * A fresh launch creates a session before anything is typed; quitting straight
   * away leaves an artifact the TUI hides but other profiles' menus list. On the
   * way out, a session that never saw input is deleted (see `session-blank.ts`).
   */
  private sawUserInput = false
  private lastUserText = ''
  /** Set on every turn/start; a retry consumes it. */
  private authRetryArmed = false
  private pendingMessages = new Map<string, string>()
  private lastActivity = Date.now()
  private lastIdleCtrlCAt = 0
  private stalledWarningShown = false
  private lastPaintAt = 0
  private commandAbort: AbortController | undefined
  private readonly seenCommandDoneIds = new Set<string>()
  private activeSubagents = new Map<string, { id: string; provider: string; startedAt: number }>()
  private subagentSessions = new Set<string>()
  /** Parent `subagent` tool descriptions waiting for the matching child card. */
  private pendingSubagentTasks: { task: string; callId: string }[] = []
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
  /**
   * True while the durable log is still being read into the transcript.
   *
   * Frames are not composed during it (see `paint`): a window anchored to a session
   * that is still growing is the rolling resume this flag exists to prevent.
   */
  private loadingHistory = false
  /**
   * A relay attached while the log was still being read, so the screen entry it
   * asks for has not been written yet (see `attachRelayDisplay` and `paint`).
   */
  private screenEntryPending = false
  /** A relay claimed the display while a hangup was still cancelling/flushing. */
  private reattachedDuringHangup = false
  private scrollOffset = 0
  /**
   * How many rows `/clear` hid, as a count from the front of `rows`.
   *
   * A *view* boundary, not a deletion (AD-4): the rows stay, the session log is
   * untouched, and a resume shows everything again because this number is Host-local
   * and never written anywhere. A count is the stable expression here — every new row
   * is appended at the end, and an update to an old row mutates it in place, so a row
   * cannot cross the boundary by being updated. When the transcript trims its oldest
   * rows the count is decremented with them, which keeps the boundary on the same
   * semantic row.
   */
  private clearedRows = 0
  private readonly clickableRows = new Map<number, CollapsibleBlock>()
  /**
   * The transcript as painted, for free-form selection. Only the lines that came
   * from a model reply are copyable: the mouse belongs to the TUI, so dragging
   * cannot reach the terminal's own selection, and this is what replaces it.
   */
  private selectableLines: {
    raw: string
    copyable: boolean
    ref?: Row | CollapsibleBlock
    /** Leading cells of chrome (the focus marker on a selected reply's first line). */
    gutter?: number
  }[] = []
  /** Screen row (1-based) of the first transcript line in the last frame. */
  private transcriptTopScreenY = 1
  /**
   * The footer echo: the last thing this Host confirmed to the reader.
   *
   * Host-local and deliberately not history (AD-13): "theme switched" is an
   * acknowledgement, not a fact about the session. It lives in the footer's own row
   * as the lowest-priority chip, is replaced by the next echo, and leaves the row
   * again when the reader submits — or after `feedbackTtlMs`, whichever comes first.
   * A detach keeps it (the Host never died); a resume does not restore it (it was
   * never in the log).
   */
  private footerEcho: { text: string; at: number } | undefined
  /**
   * The ephemeral notice: feedback that needs reading now, and is not history.
   *
   * A failed command, an operational warning — messages with too much in them for a
   * footer chip. It takes the telemetry row for its lifetime: no geometry change, no
   * content hidden, always visible. It does not steal input, and the next notice
   * replaces it while the next submit (or its own expiry) clears it. No NotificationManager: one field,
   * one row.
   */
  private notice: { text: string; at: number; holds?: 'queue' } | undefined

  /**
   * The Screen that is up, if any. At most one, and never a dialog.
   *
   * A Screen replaces the workspace rather than borrowing rows from it, so it is
   * deliberately *not* part of `dialog`/`dialogQueue`: a queued question cannot
   * open behind a report, and a report cannot swallow a question. Nothing else in
   * this class needs to know which Screen it is — `paintScreen` renders whatever
   * state is here, and every key gate reads this one field (B2.1).
   */
  private screen: ScreenState | undefined
  /**
   * A Screen's own action Surface (the doctor confirmation).
   *
   * It exists so the channel stays separated in both directions: while a Screen is
   * up, a confirmation it needs must not enter the workspace queue, and a
   * workspace Surface that arrives meanwhile must not be consumed by the Screen
   * (AD-3). At most one, resolved by the Screen that opened it.
   */
  private screenSurface: ConfirmDialog | undefined
  /** Resolver for `screenSurface`, so closing it always settles its promise. */
  private screenSurfaceResolve: ((value: 'y' | 'n' | 'cancel') => void) | undefined
  /**
   * Whether the next Screen frame must establish the whole picture.
   *
   * True when a Screen opens and after a reattach: the terminal is empty or holds
   * an unrelated frame, and one full paint is both cheaper and less surprising than
   * a partial one against unknown contents. Every later frame is incremental.
   */
  private screenNeedsFullPaint = true
  /** The strip's last painted text, so an unchanged strip is not re-sent. */
  private lastScreenStrip = ''

  /**
   * The rows the transient layer covers, 1-based and inclusive of `top`..`top+rows-1`.
   *
   * The layer is drawn over the transcript, so anything the frame registers as
   * clickable or selectable below this line is a target the reader cannot see.
   * The mouse handlers already refuse to start while a surface owns the keyboard;
   * this makes the maps themselves honest, so a later change cannot introduce
   * click-through by forgetting that gate. B1.2 widened what the layer carries —
   * a question and a control-plane picker both land here — but not what it means:
   * covered rows are hidden, never re-defined, and the composer's boundary is
   * always below the last of them.
   */
  private interactionRegion: { top: number; rows: number } | undefined
  /**
   * The rows the live tail covers, 1-based, same convention as the layer above.
   *
   * The tail is a *projection* of runtime state (streaming text, the wait card),
   * not history: it is drawn over the bottom of the window and owns no source row.
   * Rows under it are hidden, so — exactly like the interaction layer — nothing
   * behind them may stay a click, drop or link target.
   */
  private liveTailRegion: { top: number; rows: number } | undefined
  /**
   * The interaction row that must stay visible when the layer has to window
   * itself (the highlighted option): on a short terminal the list is scrolled to
   * the selection instead of being clipped at the bottom.
   */
  private dialogFocusLine: number | undefined
  /** Where a drag started; the run it belongs to decides what can be selected. */
  private mouseAnchor: SelectionPoint | undefined
  /**
   * What the drag grabbed, so a transcript that scrolls mid-drag cannot slide
   * the selection onto a different row: the source row and the line's text.
   */
  private mouseAnchorRef: Row | CollapsibleBlock | undefined
  private mouseAnchorText = ''
  /** The drag being painted in reverse video right now. */
  private mouseSelection: ScreenSelection | undefined
  /** A press that has not moved yet: a release without motion is still a click. */
  private pendingMouseClick: { y: number; x: number } | undefined
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
  /**
   * The reader's expansion choice for the live thinking card, for this turn.
   *
   * A turn thinks in phases: think, call a tool, think again. Each phase used to
   * start a fresh collapsed card, so a reader who had just expanded the card being
   * written watched it fold itself shut at the next phase — "the thinking card
   * cannot be expanded" as the reader experiences it, even though each individual
   * card could be. The choice is the reader's, it belongs to the turn, and
   * `turn/start` is the only thing that resets it.
   */
  private reasoningExpandedChoice: boolean | undefined
  private escapeBuffer = ''
  private escapeTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * How long an acknowledgement or a warning stays on the chrome.
   *
   * B2.3b kept them until the next submit, with no timer, so a reader who came back
   * after a while still saw what happened. Measured against the actual use — a
   * "copied 412 characters" chip and a "applies at the next step" notice — that is
   * the wrong trade: the reader has read them within seconds, and until they type
   * something the row is occupied by a sentence about the past instead of the
   * telemetry it replaced. They now expire on their own (and a submit still clears
   * them at once).
   */
  private feedbackTtlMs = resolveFeedbackTtlMs(process.env)
  private feedbackTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Cursor-position replies removed from the relay's stdin stream. A launcher
   * from an older release (or a reply that raced its own probe) would otherwise
   * type `[17;1R` into the prompt or cancel a dialog with a bare ESC.
   */
  private readonly inputGuard = new TerminalInputGuard(text => this.handleInputText(text))
  private thinkingStartedAt: number | undefined
  private waitStartedAt: number | undefined
  /**
   * Whether the running turn produced anything a person can read: reply text or
   * a tool card. A turn that ends with thinking only is the upstream returning
   * an empty stop, and painting 完成 for it reads as a finished answer — see
   * the hint at `turn/end`.
   */
  private turnSawOutput = false
  /** Whether the turn produced thinking, which the empty-stop hint names. */
  private turnSawReasoning = false
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
  /** Highest row the last budgeted frame could not paint, resumed next tick. */
  private paintResume: number | undefined
  /** How many times a display has come back after a drop in this Host's life. */
  private displayDrops = 0
  /** When the display went away, so the reconnect can say how long it was gone. */
  private detachedAt: number | undefined
  /**
   * Whether the agent-preset roster service is mounted. Read once at boot and
   * after a repair — never per frame: answering it from the composition would
   * mean touching the filesystem on every repaint.
   */
  private rosterMissing = false
  /**
   * Screen row of the install warning, for click-to-doctor.
   *
   * It is a chip on the status row like any other — that row is the last line of
   * the frame, so its index is the frame's last row — and clicking anywhere on it
   * opens the report that explains it.
   */
  private healthChipRow: number | undefined
  /** How much colour this terminal can take (see `color-depth`). */
  private readonly colorDepth: ColorDepth
  /** Append events as plain lines instead of painting a framed screen. */
  private readonly lineMode: boolean
  /** Rebindable actions (see `keymap`); defaults are only replaced on request. */
  private readonly keymap: ResolvedKeymap
  /**
   * Lines produced before a display attached.
   *
   * The Host boots, pushes its banner, and only then does the launcher's relay
   * arrive — and a Host's stdout is a discarded pipe, so anything written in
   * that window is gone. Without this buffer line mode loses the beginning of
   * the session, which is the one thing a log must not do.
   */
  private lineModePending: string[] = []
  /** The counters as they stood when the display went away, for the summary. */
  private awaySnapshot: { allowed: number; denied: number; detached: number } | undefined
  /** Approvals refused because nobody could confirm them (a subset of denials). */
  private detachedDeniedCount = 0
  /** Questions waiting for a display right now — their cards do not exist yet. */
  /**
   * The questions each `ask_user_question` call recorded, and the cards drawn for
   * them.
   *
   * Keyed by call *and* question id: one call carries a batch, and two calls may
   * reuse a question id. The card is the presentation only — the Session's
   * projection is what says whether a question is still answerable and what it was
   * answered with, so a replayed session draws the same card a lived one did.
   */
  private readonly askedByCall = new Map<string, readonly AskUserQuestionItem[]>()
  private readonly questionCards = new Map<string, Extract<Row, { kind: 'question' }>>()
  /**
   * Every plan-relevant durable event of this session, in order (B2.5).
   *
   * The plan artifact is a *projection* of these, so nothing here is plan state: the
   * fold decides, and the transcript row, the dock and the review Surface all read
   * the result. `live` marks the events that arrived from the running Host, because
   * only they can carry an unanswered review (a resumed process never finishes one).
   */
  private planEvents: PlanEvent[] = []
  /** The folded artifacts. Recomputed whenever `planEvents` grows. */
  private planArtifacts: PlanArtifact[] = []
  /** The state last *said* in the transcript per artifact, so a transition is one row. */
  private readonly planAnnounced = new Map<string, PlanState>()
  /**
   * The approvals the Session log has recorded, by the Harness's own `id`.
   *
   * `approval/asked` states the request (and the tool call it guards),
   * `approval/decided` states the outcome, and the two are joined here so a
   * decision that arrives before its row exists — or a row that arrives after both
   * — still lands on the same card. Nothing is written back: the log is the
   * Harness's, and this plugin keeps no approval history of its own (B2.4).
   */
  private readonly approvalAsked = new Map<string, { callId?: string; toolName: string; reason?: string }>()
  /** Approvals resolved before their tool card existed, waiting for it. */
  private readonly pendingApprovalByCall = new Map<string, ToolApproval>()
  /** Cards that exist only because a live request opened them (no durable call id). */
  private liveQuestionSeq = 0
  private queuedQuestions = 0
  /** When the current detached wait began, so the reconnect can say how long. */
  private questionWaitSince: number | undefined
  private paintIntervalMs: number
  private paintLink: PaintLinkKind = 'local'
  /**
   * Whether this process runs inside an SSH session, from the sshd environment.
   *
   * Distinct from `paintLink`, which `applyProbedRtt` pins to `'ssh'` for any
   * relayed frame — a local window included. Only this flag says the capability
   * table described a remote tty rather than the terminal the bytes reach.
   */
  private sshSession = false
  private paintProbed = false
  /**
   * Where {@link paintIntervalMs} came from: a measured round trip, an explicit
   * `DSH_TUI_PAINT_MS`, or a local TTY's constant. Only the *unprobed SSH* case is
   * an unknown link, and only that case falls back to
   * {@link RESIZE_UNKNOWN_LINK_BUDGET_MS}.
   */
  private paintCadence: PaintCadenceSource = 'unprobed'
  private paintRttMs: number | undefined
  /** The last few measured round-trips; the chip and the budget use their median. */
  private paintRttHistory: number[] = []
  private sessionTitle = ''
  private llmRetry: { retry: number; maxRetries: number; delayMs: number; message: string } | undefined
  private quotaSnapshot: QuotaSnapshot | undefined
  private balanceSnapshot: AccountBalanceSnapshot | undefined
  private quotaAlerted = new Set<string>()
  private quotaStepsSinceRefresh = 0
  private quotaRefreshInFlight = false
  /**
   * While the first reading is missing, ask again on this cadence instead of
   * waiting for the next step: a quota API that was down at boot is usually up a
   * few seconds later, and until then the footer shows `?%`.
   */
  private quotaRetryMs = QUOTA_RETRY_MS
  private quotaRetryTimer: ReturnType<typeof setTimeout> | undefined
  private contextPressure: ContextPressureView | undefined
  private contextAlertLevel: ContextPressureView['level'] | undefined
  private idleCompactInFlight = false
  private lastIdleCompactAt = 0
  private searchHits: Row[] = []
  private searchIndex = -1
  private searchQuery = ''
  /** The plain text the user searched for, which is what gets highlighted. */
  private searchNeedle = ''
  private planNudgePending = false
  private pendingReveal: Row | CollapsibleBlock | undefined

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    config: TuiConfig,
  ) {
    // The palette the terminal can take, decided once: a truecolor pair on an
    // 8-colour terminal is not a cosmetic loss, it is the wrong colour.
    this.colorDepth = config.color === false ? 'none' : colorDepth(process.env)
    // The theme is a live setting: `DSH_TUI_THEME` wins for one launch, the
    // `ssh-tui` settings section remembers the user's choice across them.
    // Publish as well as store: the footer, plan dock, tool cards and markdown
    // renderers have no session handle and read the active palette.
    this.theme = setActiveTheme(process.env.DSH_TUI_THEME ?? this.readThemeName())
    this.color = this.colorDepth !== 'none'
    this.lastSessionRoute = config.restoredRoute
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
    this.onSelectionChanged = config.onSelectionChanged
    this.onRouteSettled = config.onRouteSettled
    this.onHangup = config.onHangup
    this.onReattach = config.onReattach
    this.onDetach = config.onDetach
    this.headlessDisplay = config.headlessDisplay === true
    // Line mode: no frames at all, one appended line per event. The alternate
    // screen is what makes a screen reader and a `tee` lose events, so it stays
    // off too.
    this.lineMode = config.lineMode === true || lineModeEnabled(process.env)
    this.keymap = resolveKeymap(config.keys ?? readConfiguredKeys(this.ctx))
    this.disconnectPolicy = config.disconnectPolicy ?? this.readDisconnectPolicy()
    this.presetId = config.presetId ?? 'standard'
    this.presetName = presetLabel(this.presetId, config.presetName, config.presetTrust)
    this.terminalCaps = config.terminalCaps ?? terminalCapabilities()
    this.useAlternateScreen = !this.lineMode && this.terminalCaps.alternateScreen
    // Whether this process is inside an SSH session, kept apart from
    // `paintLink`: that one also becomes `'ssh'` whenever the launcher relayed
    // the frame (see `applyProbedRtt`), which is true for a purely local window
    // too. This field answers the narrower question the clipboard caveat needs —
    // "is the terminal the capability table described the one the bytes reach".
    this.sshSession = detectSshSession()
    this.paintLink = this.sshSession ? 'ssh' : 'local'
    this.paintIntervalMs = resolvePaintIntervalMs(config.paintIntervalMs, process.env, {
      ssh: this.paintLink === 'ssh',
    })
    this.pushRow(represent('boot', { kind: 'brand-logo' }))
    this.pushRow(represent('boot', { kind: 'system', text: t('boot.banner') }))
    this.pushRow(represent('boot', { kind: 'system', text: t('boot.help') }))
    // The roster is a profile-layer row, so an install that predates it (or an
    // in-app update, which only runs `dsh plugin add`) boots without one. Say
    // so at boot: the banner's localized default hides the missing service, and
    // the loss is not only `/mode` — the preset-owned tools are absent too.
    const keyReport = keymapReport(this.keymap)
    if (keyReport !== undefined) {
      this.pushRow(represent('boot', { kind: 'system', text: t('keys.report', { report: keyReport }) }))
    }
    this.refreshRosterHealth()
    if (this.rosterMissing) {
      // The missing thing differs by host line: a roster the profile can mount,
      // or the agent-plane rows a 0.1.7 terminal profile owns. The advice has to
      // match what `/mode fix` will actually write.
      this.pushRow(represent('boot', {
        kind: 'system',
        text: t(this.settingsGeneration === 'forms' ? 'mode.bootFormsMissing' : 'mode.bootMissing'),
      }))
    }
    if (config.cwdNotice !== undefined && config.cwdNotice !== '') {
      this.pushRow(represent('boot', { kind: /进入|Entered/u.test(config.cwdNotice) ? 'system' : 'error', text: config.cwdNotice }))
    }
    if (config.restoredRoute !== undefined) {
      this.pushRow(represent('session-route', { kind: 'system', text: sessionRouteNotice(config.restoredRoute) }))
    }
    // Windows only, and only on the fallback path: with no PowerShell there is
    // no hidden console, so the Host is a direct child and closing the window
    // ends the session's compute. Say it at boot rather than let the user find
    // out by closing the window mid-turn. A bootstrapped Windows Host and every
    // POSIX Host keep running, so neither says anything.
    if (isTuiHostProcess() && !hostHasOwnConsole()) {
      this.pushRow(represent('boot', { kind: 'system', text: t('boot.directHost') }))
    }
    for (const notice of config.launchNotices ?? []) {
      this.pushRow(represent('boot', { kind: notice.kind, text: notice.text }))
    }
  }

  /** Enter raw mode, switch to the alternate screen, and start listening. */
  start(): void {
    detachFromSshSession()
    captureHangupSignals(this.handleHangupSignal)
    this.bindAgentEvents()
    void this.ensureDisplayHost().catch((error: unknown) => {
      if (this.disposed) return
      this.pushRow(represent('boot', { kind: 'error', text: t('boot.displayFailed', { error: errorChain(error) }) }))
      this.markDirty()
    })
    if (this.headlessDisplay) {
      this.displayDetached = true
      // Line mode has no frames and no window title. The Host still listens on
      // the display socket; typing arrives as FRAME_STDIN, not process.stdin.
      // Starting the paint timer here is what leaked OSC titles into the log
      // (`\x1b]0;dsh …\x07`) the moment a turn began.
      if (!this.lineMode) this.startRenderTimer()
      this.bootBackgroundTasks()
      return
    }
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdout.on('resize', this.onDirectResize)
    if (usesSigwinch()) {
      process.on('SIGWINCH', this.onDirectResize)
    }
    process.stdin.prependListener('end', this.handleHangupStream)
    process.stdin.prependListener('close', this.handleHangupStream)
    process.stdout.on('error', this.handleIoError)
    process.stdin.on('error', this.handleIoError)

    if (this.lineMode) {
      // Direct (non-Host) line mode: typing still works, but there is no
      // screen to paint and no animation to run.
      process.stdin.on('data', this.handleData)
      this.bootBackgroundTasks()
      return
    }
    this.write(this.enterScreenSequence())
    this.render()
    this.updateTerminalTitle()
    void this.calibratePaintInterval().finally(() => {
      if (this.disposed) return
      process.stdin.on('data', this.handleData)
      this.startRenderTimer()
    })
    this.bootBackgroundTasks()
  }

  /**
   * Take over the screen: alternate screen where it is safe, then the input
   * modes the terminal actually supports, then hide the cursor.
   *
   * Joining the parts here (rather than at each call site) is what keeps
   * `start`, a reattach and a teardown from drifting apart — the reattach path
   * used to duplicate this string verbatim.
   */
  private enterScreenSequence(): string {
    return `${this.useAlternateScreen ? '\x1b[?1049h' : ''}${mouseEnableSequence(this.terminalCaps)}${bracketedPasteSequence(this.terminalCaps, true)}\x1b[?25l`
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
      this.userQuestionDisposer = installUserQuestionAnswerer(this.ctx, this.handleUserQuestions)
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
      this.pushRow(represent('boot', { kind: 'error', text: t('onboard.checkFailed', { error: errorChain(error) }) }))
      this.markDirty()
    })
    void this.syncSubagentToProvider(this.currentProviderId()).catch((error: unknown) => {
      if (this.disposed) return
      this.pushRow(represent('boot', { kind: 'error', text: t('onboard.syncSubFailed', { error: errorChain(error) }) }))
      this.markDirty()
    })
    void this.refreshQuota({ reason: 'start', announce: false }).catch(() => {
      // Start-up quota is silent; /usage and threshold alerts still report. The
      // retry keeps asking, so the footer's `?%` turns into a reading by itself.
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
        this.pushRow(represent('update-feedback', { kind: 'system', text: t('update.skipDesc', { latest: info.latest }) }))
        this.markDirty()
        return
      }
      if (picked !== t('update.now')) return
      this.pushRow(represent('update-feedback', { kind: 'system', text: t('update.installing', { latest: info.latest }) }))
      this.markDirty()
      const result = await installPluginLatest(info.profile, info.latest)
      if (this.disposed) return
      if (result.ok) {
        this.pushRow(represent('update-feedback', { kind: 'system', text: t('update.installed', { latest: info.latest, profile: info.profile }) }))
      } else {
        this.pushRow(represent('update-error', { kind: 'error', text: t('update.failed', { error: result.output === '' ? info.command : result.output }) }))
        this.pushRow(represent('update-feedback', { kind: 'system', text: t('update.manual', { command: info.command }) }))
      }
      this.markDirty()
    } catch {
      if (this.disposed) return
      this.pushRow(represent('update-feedback', { kind: 'system', text: info.notice }))
      this.markDirty()
    }
  }

  private readSkippedUpdate(): string | undefined {
    const raw = readSettingsSection(this.ctx, UI_LOCALE_NAMESPACE)
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
    notify?: string
    notifySmtpUser?: string
    notifySmtpPassword?: string
    retryProviderAuth?: boolean
    theme?: string
  }): Promise<void> {
    const settings = this.ctx.get('settings')
    if (settings === undefined) return
    const raw = readSettingsSection(this.ctx, UI_LOCALE_NAMESPACE)
    const previous = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as {
        language?: string
        skipUpdate?: string
        view?: string
        disconnect?: string
        autoApproval?: string
        notify?: string
        notifySmtpUser?: string
        notifySmtpPassword?: string
        retryProviderAuth?: boolean
        theme?: string
      }
      : {}
    await settings.replace(UI_LOCALE_NAMESPACE, { ...previous, ...patch })
  }

  private readWorkspaceView(): WorkspaceView {
    const raw = readSettingsSection(this.ctx, UI_LOCALE_NAMESPACE)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'detailed'
    return parseWorkspaceView(String((raw as { view?: unknown }).view ?? '')) ?? 'detailed'
  }

  private readDisconnectPolicy(): DisconnectPolicyName {
    const env = parseDisconnectPolicy(process.env.DSH_TUI_DISCONNECT ?? '')
    if (env !== undefined) return env
    const raw = readSettingsSection(this.ctx, UI_LOCALE_NAMESPACE)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'pause'
    return parseDisconnectPolicy(String((raw as { disconnect?: unknown }).disconnect ?? '')) ?? 'pause'
  }

  private readAutoApprovalMode(): AutoApprovalMode {
    const env = parseAutoApprovalMode(process.env.DSH_TUI_AUTO_APPROVAL ?? '')
    if (env !== undefined) return env
    const raw = readSettingsSection(this.ctx, UI_LOCALE_NAMESPACE)
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
    const saved = readSettingsSection(this.ctx, UI_LOCALE_NAMESPACE)
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
        : paintSegmentedLine(collapsed, 0, collapsed.length, headerSegments, this.colorDepth)
      addDisplay(this.selectLine(styled, this.focusedRow === anchor), anchor)
      // A collapsed burst is all the reader sees, so the two things that decide
      // whether to expand belong on it: which files moved, and what failed.
      // The breakdown is for a burst that touched *several* files: with one
      // file the header below already carries its path and its diffstat, and
      // repeating them printed the same line twice.
      if (kind === 'edits' && groups.edits.length > 1) {
        const stats = compactFileStats(groups.edits)
        const shown = stats.slice(0, MAX_COMPACT_FILE_STATS)
        const parts = shown.map(stat => `${stat.path} ${diffStatToken(stat.add, stat.del)}`.trim())
        if (stats.length > shown.length) {
          parts.push(t('compact.filesMore', { count: stats.length - shown.length }))
        }
        if (parts.length > 0) {
          addDisplay(this.styleLine('tool-result', truncateToWidth(`    ${parts.join(' · ')}`, width)), anchor)
        }
      }
      for (const line of compactFailureLines(items)) {
        // Same grammar as the header: the state ball is what marks a line as a
        // tool's, and a failure that is only red text loses that reading.
        addDisplay(this.styleLine('error', truncateToWidth(`    ● ${line}`, width)), anchor)
      }
      return
    }
    const expandedHeaderLines = headerSegments.length === 0
      ? wrap(header.plain, width).map(line => this.styleLine('tool', line))
      : wrapSegmented(header.plain, Math.max(1, width), headerSegments, this.colorDepth)
    for (const wrapped of expandedHeaderLines) {
      addDisplay(this.selectLine(wrapped, this.focusedRow === anchor), anchor)
    }
    for (const item of items) {
      if (kind === 'edits') {
        const stat = countDiffAddDel(item.diff)
        const token = diffStatToken(stat.add, stat.del)
        const extra = token === ''
          ? t('compact.lines', { count: countDiffLines(item.diff) || 1 })
          : token
        addDisplay(this.styleLine('tool-result', truncateToWidth(`    ${item.title}  ${extra}`, width)), item)
        for (const line of toolBodyLines(item, Number.MAX_SAFE_INTEGER, width)) {
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
          || (row.kind === 'compaction' && this.compactionRunning()))
      if (animating && now - this.lastPaintAt >= Math.max(this.paintIntervalMs, 200)) {
        this.dirty = true
      }
      const idleWaiting = this.agent.status === 'running' && !this.dirty
      if (idleWaiting && now - this.lastPaintAt < 1000) return
      if (this.agent.status === 'running' && !this.dirty && now - this.lastPaintAt >= 1000) {
        this.dirty = true
      }
      // A collapsing resize burst paints from its own schedule (see
      // `requestResizePaint`); the cadence timer picking the frame up as well
      // would undo the collapse.
      if (this.dirty && this.resizeBurstOpen()) return
      this.widenPastResizeTail(now)
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
      this.paintCadence = 'configured'
      this.markDirty()
      return
    }
    if (this.paintLink !== 'ssh') {
      this.paintCadence = 'local'
      this.markDirty()
      return
    }
    const rtt = await probeTerminalRttMs()
    if (this.disposed) return
    this.paintProbed = rtt !== undefined
    this.paintCadence = rtt === undefined ? 'unprobed' : 'measured'
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
    this.loadingHistory = true
    try {
      await forEachSessionEventAsync(this.agent.session, (event) => {
        this.applySessionEvent(this.agent.session, event)
      }, REPLAY_YIELD_EVERY, () => this.disposed)
    } finally {
      this.replaying = false
      this.loadingHistory = false
      this.replayQueue = undefined
      // Replay synthesizes chips from parent spawn tools; it never sees
      // `subagent/start`, so those descriptions must not sit in the live queue
      // and become the next child's courtesy name after --resume.
      this.pendingSubagentTasks = []
      this.settleUnfinishedReplayChips()
      // A compaction whose start has no end anywhere in the durable log was
      // abandoned by the Host; nothing more can arrive for it.
      this.settleUnfinishedCompactions()
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

  /**
   * Close the chips replay could not settle.
   *
   * A spawn `tool/call` with no `tool/result` in the log means the wrapper was
   * still in flight when the log was last written. Replay only runs in a Host
   * that has just started, and the child lived in the Host running back then,
   * so that child is gone and no `subagent/end` will ever arrive for it.
   * Leaving the chip "running" made every resume of an interrupted turn show a
   * child counting up forever while `/status` reported none.
   *
   * `stopReason: 'unknown'` is also what lets a late live end adopt this row
   * instead of adding a twin beside it.
   */
  private settleUnfinishedReplayChips(): void {
    if (this.disposed) return
    for (const row of this.rows) {
      if (row.kind !== 'subagent') continue
      if (row.status !== 'running' || row.childSessionId !== undefined) continue
      row.status = 'aborted'
      row.endedAt = row.startedAt
      row.stopReason = 'unknown'
      const text = t('sub.endedMissing')
      row.lastActivity = text
      appendSubagentLog(row, { kind: 'system', text })
      this.refreshOpenSubagentInspect(row)
    }
  }

  /** Show the first-launch provider/API-key onboarding when nothing is configured. */
  private async maybeRunOnboarding(): Promise<void> {
    const credentials = this.ctx.get('credentials')
    const provider = this.currentProviderId()
    if (providerUsesLocalOAuth(provider)) {
      // Workspace feedback *about* setup — not the wizard's own surface, which is the
      // setup Screen (B2.6 §12). These rows are the command plane's.
      this.pushRow(represent('command-status', {
        kind: 'system',
        text: t('onboard.oauthHint', { kind: describeProviderRoute(provider).kind, provider }),
      }))
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
        this.pushRow(represent('command-status', {
          kind: 'system',
          text: t('onboard.envInUse', { env: envRef }),
        }))
        this.markDirty()
        return
      }
      this.pushRow(represent('runtime-warning', {
        kind: 'system',
        text: t('onboard.envStale', { env: envRef }),
      }))
      await this.runOnboarding()
      return
    }
    // Nothing is configured and no key is in the environment: this is a first run,
    // and the wizard is the only thing that can make the session usable at all.
    //
    // `this.resume` used to be part of this test, meaning "a resumed session was set
    // up before". It never means that: the frontend spawns the Host — and the Host is
    // the only process that paints this — with `--resume=<id>` even for an id it
    // minted a second earlier (`hostArgvForSession`), so the flag is true on *every*
    // boot and this guard returned before the wizard could ever open. A fresh install
    // got an empty workspace, a provider that cannot answer, and no hint that
    // `/setup` exists. The launch flag is not evidence of configuration; the
    // credential store is, and that is what `stored` reads.
    if (stored) return
    this.pushRow(represent('command-status', { kind: 'system', text: t('onboard.needSetup') }))
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
        modelCandidates: [],
        modelChecked: new Set<number>(),
        modelCursor: 0,
        modelCapacity: new Map(),
        catalogPresets: undefined,
        catalog: undefined,
        providerCursor: 0,
        saving: false,
        field: '',
        fieldCursor: 0,
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
      // A Screen, not a dialog: it replaces the workspace instead of squeezing rows
      // out of it, it never enters the dialog queue, and nothing about it is painted
      // into the transcript (B2.6 §1/§2).
      this.openScreen({ kind: 'setup', title: t('onboard.title'), lines: [], offset: 0 })
      this.markDirty()
    })
    return this.onboardingCompletion
  }

  private cancelOnboarding(): void {
    const state = this.onboarding
    if (state === undefined || state.saving) return
    this.onboarding = undefined
    if (this.screen?.kind === 'setup') this.closeScreen()
    // The composer is the workspace's: the wizard never wrote to it, so there is
    // nothing to clear (B2.6 §5 — this used to wipe the reader's draft).
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
    if (this.feedbackTimer !== undefined) clearTimeout(this.feedbackTimer)
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
    // Line mode never entered the alternate screen or hid the cursor; writing
    // the restore sequence here would dump CSI into a `tee` the moment SSH
    // dropped. The Host's stdout is usually a discarded pipe, but the same
    // path is shared with a direct (non-Host) line-mode process.
    if (!this.lineMode) {
      try {
        process.stdout.write('\x1b]0;\x07')
        process.stdout.write('\x1b[0m\x1b[2J\x1b[3J\x1b[H')
        // Leave the alternate screen unconditionally, the way every mouse mode is
        // disabled: `?1049l` on a terminal that never entered is ignored, while
        // *skipping* it after a reattach whose relay classified the terminal
        // differently leaves the user stuck in a screen they cannot scroll.
        process.stdout.write(`${mouseDisableSequence()}${bracketedPasteSequence(this.terminalCaps, false)}\x1b[?25h\x1b[?1049l`)
      } catch (error) {
        if (!isHangupErrno(error)) {
          try {
            process.stderr.write(`dsh-ssh-tui: failed to restore terminal: ${errorChain(error)}\n`)
          } catch {
            // both pipes gone
          }
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
    this.clearQuotaRetry()
    const dialog = this.dialog
    const queued = this.dialogQueue.splice(0)
    this.dialog = undefined
    this.dialogRole = PICKER_ROLE
    this.releaseBorrowedText()
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
      if (pending.dialog.kind === 'confirm') {
        pending.dialog.resolve('cancel')
      } else if (pending.dialog.kind === 'questions') {
        pending.dialog.reject(new UserQuestionError('TUI closed before the question was answered', 'ASK_ABORTED'))
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
      // The depth this process actually paints with, plus the hints behind it:
      // on Windows TERM is normally unset, which used to read as "no colour".
      color: {
        depth: this.colorDepth,
        ...((process.env.TERM ?? '') === '' ? {} : { term: process.env.TERM }),
        ...((process.env.COLORTERM ?? '') === '' ? {} : { colorTerm: process.env.COLORTERM }),
        windowsTerminal: (process.env.WT_SESSION ?? '') !== '',
      },
    })
    this.openReport('diag', formatDiag(snapshot))
    this.markDirty()
  }

  /**
   * Whether a host service is registered.
   *
   * The typed `ctx.get` knows only the services this plugin depends on;
   * `/doctor` also probes `codeRuntime`, which the PTC preset mounts and this
   * plugin deliberately does not depend on, so the lookup is untyped here.
   */
  private hasHostService(name: string): boolean {
    const get = (this.ctx as unknown as { get?: (service: string) => unknown }).get
    return typeof get === 'function' && get.call(this.ctx, name) !== undefined
  }

  /** Routing facts for the doctor's self-consistency check. */
  private doctorRouting(): DoctorRouting | undefined {
    const section = readSettingsSection(this.ctx, settingsNamespace('llm-pi-ai')) as LlmPiAiSection | undefined
    const providers = section?.providers ?? {}
    const provider = this.currentProvider()
    const models = Array.isArray(providers[provider]?.models) ? providers[provider]?.models ?? [] : []
    const model = this.agent.options.model ?? this.selectionRef?.current?.model
    const sub = this.subagentSelection.current
    return {
      provider,
      ...(model === undefined ? {} : { model }),
      routes: Object.keys(providers),
      routeModels: models.map(modelEntryId).filter((id): id is string => id !== undefined),
      ...(sub.provider === undefined ? {} : { subProvider: this.displayProviderId(sub.provider) }),
      ...(sub.model === undefined ? {} : { subModel: sub.model }),
    }
  }

  /** One collected `/doctor` snapshot, from this process's own services. */
  private async collectDoctorFacts(profile: string): Promise<DoctorFacts> {
    const routing = this.doctorRouting()
    return collectDoctor({
      profile,
      dshHome: resolveDshHome(),
      hostVersion: hostDshVersion(),
      services: {
        roster: this.ctx.get('agentPresets') !== undefined,
        codeRuntime: this.hasHostService('codeRuntime'),
      },
      generation: hostSettingsGeneration(this.ctx),
      anchors: [process.argv[1], (this.ctx as { baseUrl?: string }).baseUrl],
      ...(routing === undefined ? {} : { routing }),
    })
  }

  /**
   * `/doctor`: the deployment checkup. `/doctor --fix` then repairs whatever
   * the report marked fixable, after one confirmation.
   */
  private async runDoctorCommand(arg: string, fixRequested: boolean): Promise<void> {
    const profile = profileFromArgv()
    const facts = await this.collectDoctorFacts(profile)
    // The report is the Screen; `--fix` then runs *inside* it, so the reader keeps
    // the checks in front of them while answering the confirmation (AD-3, §4 of the
    // B2.1 brief). The repair result replaces the hint row rather than pushing a row
    // behind the Screen: the reader is looking at this screen, and an action nobody
    // can see the outcome of is the one thing worse than no action.
    this.openReport('doctor', formatDoctorReport(facts, doctorChecks(facts)))
    if (!fixRequested) return
    await this.repairProfilePatch(rowsToRepair(facts), facts)
  }

  /** `/fix <row>`: repair one named roster row of the profile patch. */
  private async runFixCommand(arg: string): Promise<void> {
    const name = arg.trim().toLowerCase()
    const row = ALL_ROSTER_ROWS.find(candidate =>
      candidate.id === name || (candidate.name ?? '').toLowerCase() === name)
    if (row === undefined) {
      this.pushRow(represent('command-misuse', {
        kind: 'error',
        text: t('doctor.fix.unknownRow', { row: arg.trim(), rows: ALL_ROSTER_ROWS.map(candidate => candidate.id).join(', ') }),
      }))
      this.markDirty()
      return
    }
    await this.repairProfilePatch([row], await this.collectDoctorFacts(profileFromArgv()))
  }

  /**
   * Write the planned repairs into the profile patch after one confirmation.
   *
   * Only two things are ever changed: rows that are missing get mounted, and an
   * insert that repeats an earlier one is removed. An override or disable the
   * user wrote is never touched, and the previous file is kept as a backup.
   */
  private async repairProfilePatch(rows: readonly RosterRow[], facts: DoctorFacts): Promise<void> {
    let text = facts.patch.text
    const duplicates = facts.patch.readable ? planDuplicateRepair(text) : undefined
    if (duplicates !== undefined) text = duplicates.text
    const roster = planRosterRepair(text, rows, facts.generation ?? 'legacy')
    if (roster !== undefined) text = roster.text
    const added = roster?.added ?? []
    const removed = duplicates?.removed ?? []
    if (added.length === 0 && removed.length === 0) {
      this.pushRow(represent('doctor-result', { kind: 'system', text: t('doctor.fix.none') }))
      this.markDirty()
      return
    }
    const changes = [
      ...added.map(id => `+${id}`),
      ...removed.map(entry => `-${entry.id} (line ${entry.line})`),
    ].join(' ')
    const prompt = t('doctor.fix.confirm', { changes })
    const hint = t('doctor.fix.confirmHint', { path: facts.patchPath })
    // Whichever channel owns the screen answers this: inside the doctor Screen it
    // is the Screen's own Surface (never the workspace queue), and `/fix` outside a
    // Screen keeps the ordinary confirmation it always had.
    const answer = await (this.askScreenConfirm(prompt, hint)
      ?? new Promise<'y' | 'n' | 'cancel'>(resolve => { this.openConfirm(prompt, hint, resolve) }))
    if (answer !== 'y') {
      this.reportActionResult('doctor', t('doctor.fix.cancelled'))
      return
    }
    try {
      // A patch that does not exist yet needs no backup: the write creates it
      // from the template, exactly as the installer would.
      let backup: string | undefined
      if (facts.patch.readable) {
        backup = await writePatchWithBackup(facts.patchPath, text)
      } else {
        await ensureRosterRows(facts.dshHome, facts.profile, rows)
      }
      const done = [
        t('doctor.fix.applied', {
          added: added.join(', ') || '—',
          removed: removed.map(entry => entry.id).join(', ') || '—',
          path: facts.patchPath,
        }),
        ...(backup === undefined ? [] : [t('doctor.fix.backup', { path: backup })]),
        t('doctor.fix.restart', { profile: facts.profile }),
      ]
      // The result replaces the Screen's hint row and is appended to its body, so
      // the reader sees what changed on the screen they were reading. One row is
      // still written to the transcript: a repair edits the user's install, and
      // that is a durable fact about the session, not a report.
      const { screen } = this.resultChannel()
      if (screen !== undefined) {
        screen.lines = [...screen.lines, ...done.map(text => ({ kind: 'system' as const, text }))]
        screen.notice = done[0] ?? t('doctor.fix.applied', { added: '', removed: '', path: facts.patchPath })
      }
      this.pushRow(represent('doctor-result', { kind: 'system', text: done.join('\n') }))
    } catch (error) {
      this.pushRow(represent('doctor-result', { kind: 'error', text: t('doctor.fix.failed', { error: errorChain(error) }) }))
    }
    this.markDirty()
  }

  /**
   * Where an action's outcome is reported: the Screen that asked, or a row.
   *
   * A Screen's own action is answered *on the Screen* — the reader is looking at it,
   * and the row it would otherwise push lands behind their own view. With no Screen
   * up (the same code path serves `/fix`), the answer is an ordinary row.
   */
  private resultChannel(): { screen: ScreenState | undefined; push: (text: string) => void } {
    return {
      screen: this.screen,
      push: (text: string) => {
        this.pushRow(represent('doctor-result', { kind: 'system', text }))
        this.markDirty()
      },
    }
  }

  /** Report a Screen action's outcome, or fall back to a row. */
  private reportActionResult(_report: ReportKind, text: string): void {
    const { screen, push } = this.resultChannel()
    if (screen !== undefined) {
      screen.notice = text
      this.markDirty()
      return
    }
    push(text)
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
    if (this.compactionRunning()) return true
    // A question queued for an answer that has not come. The turn itself has
    // settled, so nothing else here counts it, and the idle exit would otherwise
    // kill the Host while it is the only thing still holding that question.
    if (this.queuedQuestions > 0) return true
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
    // The one place a real detach starts from, so the reconnect notice can say
    // how long the user was away. A boot attach never sets it.
    this.detachedAt ??= Date.now()
    this.awaySnapshot ??= {
      allowed: this.autoAllowedCount,
      denied: this.autoDeniedCount,
      detached: this.detachedDeniedCount,
    }
    this.reattachedDuringHangup = false
    ignoreFurtherHangupSignals()
    this.detachDisplay()
    // Say "no display" now rather than after the cancel/flush below. The lock's
    // `attached` is what a resume reads to decide that another window is on this
    // session, and for the whole cancel window it was still set while the window
    // was already gone — so a reconnect inside that window was refused as
    // "already attached". A reattach during this hangup patches it back (and the
    // writes are serialized launcher-side, so the last one wins).
    await this.onDetach?.()
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
    if (!keepHost) {
      // The Host is about to exit, and a marker left behind would keep saying a
      // question is waiting after the process that held it is gone.
      void clearWaitingMarker(String(this.agent.id))
    }
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
        if (changed) this.requestResizePaint()
      },
      onRtt: (rttMs) => {
        this.applyProbedRtt(rttMs)
      },
      onMetrics: metrics => {
        // The relay measured the terminal this session is displayed on. Adopt it
        // and repaint from scratch: every cached line was measured with the old
        // table, so a diff against them would compare different widths.
        setAmbiguousWidthMeasured(metrics.wide)
        setAmbiguousWidthReserve(metrics.reserve)
        this.forceFullPaint = true
        this.markDirty()
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

  /**
   * One row for what happened while nobody was watching.
   *
   * Only the parts that actually happened are listed, so a plain link blip stays
   * one line. The counts are deltas against the snapshot taken at the drop: the
   * totals belong to the session, this belongs to the gap.
   */
  private pushAwaySummary(awayMs: number): void {
    const before = this.awaySnapshot
    this.awaySnapshot = undefined
    if (before === undefined) return
    const allowed = this.autoAllowedCount - before.allowed
    const denied = this.autoDeniedCount - before.denied
    const detached = this.detachedDeniedCount - before.detached
    const waiting = this.queuedQuestions
    const parts: string[] = []
    if (allowed + denied > 0) {
      parts.push(t('attach.awayApprovals', { allowed, denied }))
    }
    if (detached > 0) parts.push(t('attach.awayDetached', { count: detached }))
    if (waiting > 0) parts.push(t('attach.awayWaiting', { count: waiting }))
    if (waiting > 0 && this.questionWaitSince !== undefined) {
      parts.push(t('attach.questionWaited', { waited: formatShortDuration(Date.now() - this.questionWaitSince) }))
    }
    if (parts.length === 0) return
    this.pushRow(represent('away-summary', {
      kind: 'system',
      text: t('attach.awaySummary', { away: formatShortDuration(awayMs), parts: parts.join(' · ') }),
    }))
  }

  /** Say the user was away, and what happened while they were. */
  private pushReconnectNotice(): void {
    if (this.detachedAt === undefined) return
    this.displayDrops += 1
    const away = Date.now() - this.detachedAt
    this.detachedAt = undefined
    this.pushRow(represent('attach-notice', {
      kind: 'system',
      text: t('attach.reconnected', { count: this.displayDrops, away: formatShortDuration(away) }),
    }))
    this.pushAwaySummary(away)
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
    if (this.lineMode) {
      // No DECSET at all in line mode: no mouse reporting, no hidden cursor, no
      // alternate screen. The held lines are the whole point of the handover.
      this.flushLineMode()
      // The user is back, and the notice belongs in the log like any event.
      this.pushReconnectNotice()
      void this.onReattach?.()
      return
    }
    // `?1049h` does not only switch buffers: a terminal that is already in the
    // alternate screen clears it on the way in, and the launcher's splash is
    // sitting in that screen. That is free when a frame follows in the same tick
    // and expensive when none may: a relay attaches *before* `replayHistory` has
    // read the log, and no frame is composed until it has, so entering here wipes
    // "正在载入历史会话…" and leaves a black window for as long as the rebuild
    // takes (measured on a 20k-event session: the entry at 9.1 s, the first frame
    // at 12.6 s, the splash gone in between). The entry rides the first frame
    // instead — `paint` writes it there, in the same tick as the content it
    // belongs to.
    if (this.loadingHistory) this.screenEntryPending = true
    else {
      // An entry a previous attach left pending is superseded, not repeated:
      // two entries would clear the screen twice.
      this.screenEntryPending = false
      this.write(this.enterScreenSequence())
    }
    this.forceFullPaint = true
    this.dirty = true
    // The user is back: say so, with how many times this Host has been
    // reconnected and how long this gap lasted. Pushed before the paint so the
    // frame that follows carries it.
    this.pushReconnectNotice()
    this.paint()
    this.startRenderTimer()
    void this.onReattach?.()
  }

  currentDisconnectPolicy(): DisconnectPolicyName {
    return this.disconnectPolicy
  }

  /** The paint cadence in force right now: the link tier the footer shows. */
  currentPaintIntervalMs(): number {
    return this.paintIntervalMs
  }

  applyProbedRtt(rttMs: number | undefined): void {
    const envOverride = Number.parseInt(process.env.DSH_TUI_PAINT_MS ?? '', 10)
    this.paintLink = 'ssh'
    if (rttMs !== undefined) {
      // The relay re-measures the link on its own cadence, so this is called
      // again and again over one session. The reported round-trip is the median
      // of the last few measurements: a single burst that reads like a
      // 2-second link must not pin the footer chip — and with it the paint
      // cadence and the per-frame byte budget — while two measurements that
      // agree move it at once. That is the fix for a link that was red from the
      // first second to the last: the first measurement is taken while the
      // session is still booting, and it used to be the only one ever taken.
      this.paintRttHistory.push(rttMs)
      if (this.paintRttHistory.length > RTT_HISTORY) this.paintRttHistory.shift()
      this.paintProbed = true
      this.paintRttMs = medianRtt(this.paintRttHistory)
    } else if (!this.paintProbed) {
      // A probe that missed its window reports "unknown". A link that was never
      // measured (a pipe, a terminal that does not answer DSR) stays unknown and
      // keeps the unprobed wording; one that has a measurement keeps its number
      // rather than blanking the chip to four hollow circles after every
      // auto-reconnect.
      this.paintRttMs = undefined
    }
    if (!(Number.isFinite(envOverride) && envOverride > 0)) {
      this.paintIntervalMs = resolvePaintIntervalMs(undefined, {}, { ssh: true, rttMs: this.paintRttMs })
      if (!this.lineMode) this.startRenderTimer()
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

  /**
   * The approval state of one tool call (B2.4).
   *
   * Approval has no row of its own: it is a field of the card for the call it
   * guarded. A decision can arrive before the card does (a `tool/result`-only
   * fragment, a resumed log read out of order), so an unresolved call id is kept
   * until its row appears rather than dropped.
   * @param callId - the tool call the approval belongs to.
   * @param next - the fact being applied, or undefined to read it back.
   * @returns the field after the merge.
   */
  private setToolApproval(callId: string, next: ToolApproval): ToolApproval {
    const row = this.findToolRowByCallId(callId)
    if (row === undefined) {
      const merged = mergeApproval(this.pendingApprovalByCall.get(callId), next)
      this.pendingApprovalByCall.set(callId, merged)
      return merged
    }
    const merged = mergeApproval(row.approval, next)
    if (!sameApproval(row.approval, merged)) {
      row.approval = merged
      this.markDirty()
    }
    return merged
  }

  /**
   * The weakest approval reading there is, and the only one allowed to be weak.
   *
   * A log from before the Harness recorded its audit pair still says *something*
   * about a refused tool: the tool never ran, and the reason is the Harness's own
   * sentence for an approval that came back rejected or cancelled. That is a
   * reading, not a decision, so it is filed as `inferred` — and it can only ever
   * produce `rejected`/`unknown`, never `approved`: a tool that ran proves nothing,
   * because a tool nobody had to approve runs too.
   *
   * Anything already known from a stronger source wins, which is also what keeps a
   * live decision from being rewritten by the sentence it produced.
   * @param row - the card that just settled.
   * @param message - the tool result's message.
   * @param error - the result's error, when it has one.
   */
  private inferApprovalFromResult(
    row: Extract<Row, { kind: 'tool' }>,
    message: { content?: readonly { type: string; text?: string }[]; isError?: boolean },
  ): void {
    if (row.approval !== undefined) return
    const state = inferredApprovalFromResult(collectText(message.content ?? []))
    if (state === undefined) return
    // A refusal the audit pair can *prove* was an approval is read from the pair
    // instead; this branch exists only for the logs that predate it.
    if ([...this.approvalAsked.values()].some(asked => asked.callId === row.callId)) return
    this.setToolApproval(row.callId, { state, provenance: 'inferred' })
  }

  /** Hand a card the approval that was resolved before the card existed. */
  private adoptPendingApproval(row: Extract<Row, { kind: 'tool' }>): void {
    const pending = this.pendingApprovalByCall.get(row.callId)
    if (pending === undefined || row.approval !== undefined) return
    row.approval = pending
  }

  private findMergeableToolRow(next: { name: string; args: string }): Extract<Row, { kind: 'tool' }> | undefined {
    return findMergeableToolRow(this.rows, next)
  }

  /** Append one transcript row, bounding memory on long sessions. */
  /**
   * The only way a line enters the transcript.
   *
   * It takes a `Representation` — a row *plus* the policy that produced it — and not
   * a `Row`, so a creation site cannot skip the classification: a bare row is a type
   * error, and a source id with no policy is one too (`RepresentationSource` is the
   * policy table's keys). The policy is copied onto the row here, which is what makes
   * a real transcript auditable afterwards: `auditRepresentations(this.rows)` can
   * then answer how many lines are history and how many are the Host's own voice.
   *
   * A JavaScript caller (a test fixture, an embedder) can still hand over something
   * that is not a representation. That case is *recorded*, not defaulted: the row is
   * pushed with no metadata and `unclassifiedRepresentations` counts it, so the audit
   * fails loudly instead of quietly calling an unknown line durable.
   */
  private pushRow(representation: Representation): void {
    const classified = isRepresentation(representation)
    // Routing, not classification (B2.3b): the policy says where this representation
    // is shown, so a control-plane confirmation cannot be a transcript row at one
    // call site and a footer echo at the next. Only `transcript` reaches the log's
    // view; the other two are Host-local and never touch the rows at all.
    if (classified && representation.meta.destination !== 'transcript') {
      const text = lineModeLines(representation.row).join(' · ')
      if (this.lineMode) {
        // Line mode has no footer and no covered row: its feedback has always been
        // text, and losing it would be a regression in the mode that has the least
        // chrome to spare.
        this.appendRow(representation)
        return
      }
      const at = Date.now()
      if (representation.meta.destination === 'echo') this.footerEcho = { text, at }
      else this.notice = { text, at }
      this.armFeedbackExpiry()
      this.markDirty()
      return
    }
    this.appendRow(representation)
  }

  /** Append one classified row to the transcript (the `transcript` destination). */
  private appendRow(representation: Representation): void {
    const classified = isRepresentation(representation)
    const row = classified ? representation.row : (representation as unknown as Row)
    if (classified) {
      ;(row as Row & { representation?: RepresentationMeta }).representation = representation.meta
    }
    // A row that arrived without a policy keeps no metadata: the audit reads the
    // rows back, so it shows up as `unclassified` there rather than being counted
    // twice or quietly defaulted.
    this.rows.push(row)
    if (this.lineMode) {
      // Appended here rather than from the render timer: a timer can coalesce
      // two events into one tick, and an event that is coalesced away is an
      // event the log lost.
      const appended = appendRow(lineModeLines(row))
      if (appended !== '') this.writeLineMode(appended)
    }
    // Locate the focused card before trimming: after the splice every surviving
    // index shifts down and a stale index would clear the focus by accident.
    const focusedIndex = this.focusedRow === null || this.focusedRow.kind === 'streaming-reasoning'
      ? undefined
      : this.rows.indexOf(this.focusedRow)
    const removed = boundTranscriptRows(this.rows)
    if (removed === 0) return
    // The cutoff is a distance from the front, so it moves with the front.
    this.clearedRows = Math.max(0, this.clearedRows - removed)
    if (focusedIndex !== undefined && focusedIndex < removed) this.focusedRow = null
  }

  /** Append one event, holding it until a display can carry it. */
  private writeLineMode(chunk: string): void {
    if (this.displayHost?.attached === true && !this.displayDetached) {
      this.write(chunk)
      return
    }
    this.lineModePending.push(chunk)
  }

  /** Hand the held lines to the display that just attached. */
  private flushLineMode(): void {
    if (this.lineModePending.length === 0) return
    const pending = this.lineModePending.splice(0)
    this.write(pending.join(''))
  }

  /** The transcript rows that support per-row expand/collapse. */
  private collapsibleRows(): CollapsibleBlock[] {
    const compact = this.isCompactView()
    if (compact) {
      const rows: CollapsibleBlock[] = this.visibleRows().filter(
        (row): row is Extract<Row, { kind: 'subagent' } | { kind: 'plan' } | { kind: 'question' } | { kind: 'goal' } | { kind: 'compaction' } | { kind: 'changes' }> =>
          row.kind === 'subagent'
          || row.kind === 'plan'
          || row.kind === 'question'
          || row.kind === 'goal'
          || row.kind === 'compaction'
          || row.kind === 'changes')
      for (const burst of compactToolBursts(this.visibleRows())) {
        const callAnchor = burst.groups.calls.at(-1)
        const editAnchor = burst.groups.edits.at(-1)
        if (callAnchor !== undefined) rows.push(callAnchor)
        if (editAnchor !== undefined) rows.push(editAnchor)
      }
      return rows
    }
    const rows: CollapsibleBlock[] = this.visibleRows().filter(
      (row): row is Extract<Row, { kind: 'reasoning' } | { kind: 'tool' } | { kind: 'subagent' } | { kind: 'plan' } | { kind: 'question' } | { kind: 'goal' } | { kind: 'compaction' } | { kind: 'prompt' } | { kind: 'changes' }> =>
        row.kind === 'reasoning'
        || row.kind === 'tool'
        || row.kind === 'subagent'
        || row.kind === 'plan'
        || row.kind === 'question'
        || row.kind === 'goal'
        || row.kind === 'compaction'
        || row.kind === 'prompt'
        || row.kind === 'changes')
    if (this.streaming !== undefined && this.streaming.reasoning !== '') {
      rows.push(this.liveThinkingBlock())
    }
    return rows
  }

  /**
   * Everything the card cursor walks, in transcript order: the collapsible
   * cards plus the model replies.
   *
   * Built from the two lists rather than from the rows alone, because one of the
   * collapsible entries is synthetic: the live thinking block exists only while a
   * turn streams and is never a member of `this.rows`. Filtering the rows (the
   * first version of this) silently dropped it out of the cursor walk — ↑ on a
   * turn that had only streamed thinking did nothing, and Enter could no longer
   * expand the card being written. It belongs at the end, which is where it is
   * painted, so anything not in the rows is appended.
   */
  private focusRing(): FocusTarget[] {
    const collapsible = this.collapsibleRows()
    const ring: FocusTarget[] = this.rows.filter(row =>
      row.kind === 'assistant' || collapsible.includes(row as CollapsibleBlock))
    const known = new Set<FocusTarget>(this.rows)
    for (const row of collapsible) if (!known.has(row)) ring.push(row)
    return ring
  }

  /**
   * The live thinking block, created on first use.
   *
   * Expanded or not is the reader's choice for the turn, not this frame's: see
   * `reasoningExpandedChoice`.
   */
  private liveThinkingBlock(): { kind: 'streaming-reasoning'; expanded: boolean } {
    return this.streamingReasoning ??= {
      kind: 'streaming-reasoning',
      expanded: this.reasoningExpandedChoice === true,
    }
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
    if (this.compactionRunning()) return false
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
        : { toolTitle: subagentDisplayName(liveSub), toolSummary: subagentChipSummary(liveSub) }),
      ...(this.streaming?.reasoning ? { reasoning: this.streaming.reasoning } : {}),
    }
  }

  private findSubagentRow(sessionId: string): Extract<Row, { kind: 'subagent' }> | undefined {
    return this.rows.findLast((row): row is Extract<Row, { kind: 'subagent' }> =>
      row.kind === 'subagent' && (row.sessionId === sessionId || row.childSessionId === sessionId))
  }

  private subagentInspectId(row: Extract<Row, { kind: 'subagent' }>): string {
    return row.childSessionId ?? row.sessionId
  }

  /** Courtesy name for a child session; never the raw session hash. */
  private subagentNameFor(sessionId: string | undefined): string {
    const id = sessionId === undefined ? '' : String(sessionId)
    if (id === '' || id === String(this.agent.id)) return t('approval.thisSession')
    const row = this.findSubagentRow(id)
    if (row !== undefined) return subagentDisplayName(row)
    return subagentCourtesyName({ sessionId: id, fallback: t('card.subagent') })
  }

  private findLivePlanRow(): Extract<Row, { kind: 'plan' }> | undefined {
    return livePlanArtifact(this.planArtifacts) === undefined ? undefined : this.dockedPlanRow()
  }

  /**
   * Keep the plan log, and re-fold when it grew.
   *
   * Only the events the fold reads are kept (B2.5). They are rare — a plan mode
   * switch, a todo snapshot, a review — so a whole re-fold per plan event stays
   * trivial, and it keeps the projection a *pure function of the log* rather than a
   * running tally that could drift from one.
   */
  private recordPlanEvent(event: SessionEvent): void {
    if (!PLAN_EVENT_TYPES.has(String(event.type))) return
    const seq = typeof event.seq === 'number' ? event.seq : undefined
    const data = event.data as PlanEvent['data']
    if (String(event.type) === 'tool/call' && String(data?.name ?? '') !== 'exit_plan_mode') return
    this.planEvents.push({
      type: String(event.type),
      ...(seq === undefined ? {} : { seq }),
      ...(data === undefined ? {} : { data }),
      live: !this.replaying,
    })
    this.syncPlanArtifacts()
  }

  /**
   * The projection, onto the rows three readers share.
   *
   * One artifact, one row: the row is the artifact's *reference* in the transcript
   * (its lifecycle summary and, when expanded, its steps), the dock paints the live
   * one, and the review Surface is the dialog. None of the three keeps plan state of
   * its own (AD-15): they all read what this fold decided.
   */
  private syncPlanArtifacts(): void {
    this.planArtifacts = foldPlanArtifacts(this.planEvents)
    for (const artifact of this.planArtifacts) {
      const row = this.planRowFor(artifact.id) ?? this.createPlanRow(artifact)
      const live = artifactIsLive(artifact)
      row.active = artifact.active
      row.pending = artifact.pending
      row.todos = [...artifact.steps]
      row.state = artifact.state
      row.provenance = artifact.provenance
      if (artifact.body !== undefined) row.planMarkdown = artifact.body
      row.reviewFeedback = artifact.review?.feedback
      // The nudge's two display flags follow the *revision*, exactly as they used to
      // follow a todo patch: a new snapshot re-opens the question, and only a list
      // that is fully closed lets a later one ask again.
      const revisionId = artifact.revisions.at(-1)?.id
      if (revisionId !== undefined && row.lastRevisionId !== revisionId) {
        const previous = new Map((artifact.revisions.at(-2)?.steps ?? []).map(step => [step.content, step.status]))
        row.lastRevisionId = revisionId
        row.turnLeftOpen = false
        if (artifact.steps.length > 0 && artifact.steps.every(step => step.status === 'completed')) {
          row.nudged = false
          this.planNudgePending = false
        }
        if (this.lineMode) {
          // Line mode is an append-only log: a row that is *updated* in place would
          // never reach it, so each revision prints what it changed. The tool replaces
          // the whole list, which is why this prints the difference rather than the
          // list (a long plan would otherwise fill the log on every status flip).
          const changed = artifact.steps.filter(step => previous.get(step.content) !== step.status)
          if (changed.length > 0) {
            const appended = appendRow(changed.map(step => `[${step.status}] ${step.content}`))
            if (appended !== '') this.writeLineMode(appended)
          }
        }
      }
      row.archived = !live
      if (!live) row.expanded = false
      else if (row.expanded === false && planShouldDefaultExpand({ active: artifact.active, pending: artifact.pending, todos: artifact.steps })) {
        row.expanded = true
      }
      this.announcePlanTransition(artifact)
    }
  }

  /** The row that stands for one artifact, if it has been drawn yet. */
  private planRowFor(id: string): Extract<Row, { kind: 'plan' }> | undefined {
    return this.rows.findLast((row): row is Extract<Row, { kind: 'plan' }> => row.kind === 'plan' && row.artifactId === id)
  }

  /** The artifact a docked row belongs to, when the workspace should show one. */
  private dockedPlanRow(): Extract<Row, { kind: 'plan' }> | undefined {
    const artifact = livePlanArtifact(this.planArtifacts)
    return artifact === undefined ? undefined : this.planRowFor(artifact.id)
  }

  private createPlanRow(artifact: PlanArtifact): Extract<Row, { kind: 'plan' }> {
    const row: Extract<Row, { kind: 'plan' }> = {
      kind: 'plan',
      artifactId: artifact.id,
      active: artifact.active,
      pending: artifact.pending,
      todos: [...artifact.steps],
      state: artifact.state,
      provenance: artifact.provenance,
      expanded: planShouldDefaultExpand({ active: artifact.active, pending: artifact.pending, todos: artifact.steps }),
      archived: false,
    }
    this.pushRow(represent('plan-row', row))
    return row
  }

  /**
   * Say one lifecycle transition, once.
   *
   * The transcript keeps the artifact's *lifecycle*: entering plan mode, a review's
   * answer, leaving the mode. It does not keep a second copy of the plan body — that
   * is the artifact's (the dock while it is live, the review Surface while it is under
   * review, this row's overlay afterwards) — and a transition is never announced
   * twice, which is what makes the fold idempotent under a re-`sync`.
   */
  private announcePlanTransition(artifact: PlanArtifact): void {
    const said = this.planAnnounced.get(artifact.id)
    if (said === artifact.state) return
    this.planAnnounced.set(artifact.id, artifact.state)
    if (said === undefined) {
      // The first sight of an artifact: entering plan mode is worth one line, a bare
      // todo list is not (the model writes one during ordinary work).
      if (artifact.openedBy === 'plan-mode') this.pushRow(represent('plan-lifecycle', { kind: 'system', text: t('plan.entered') }))
      return
    }
    if (artifact.state === 'rejected' && artifact.review?.outcome === 'rejected') {
      this.pushRow(represent('plan-lifecycle', {
        kind: 'system',
        text: artifact.review.feedback === undefined
          ? t('plan.reviewRejected')
          : t('plan.reviewRejectedFeedback', { feedback: artifact.review.feedback }),
      }))
      return
    }
    if (artifact.state === 'rejected' && artifact.review?.outcome === 'dismissed') {
      this.pushRow(represent('plan-lifecycle', { kind: 'system', text: t('plan.reviewDismissed') }))
      return
    }
    if (artifact.state === 'approved' || artifact.state === 'executing') {
      // `approved` and `executing` are two states of *one* transition — the review came
      // back and the mode then left — so only the first of them is announced. (This
      // pushed the line twice: the second state found the same review outcome.)
      if (artifact.review?.outcome === 'approved' && said !== 'approved' && said !== 'executing') {
        this.pushRow(represent('plan-lifecycle', { kind: 'system', text: t('plan.reviewApproved') }))
      }
      return
    }
    // `unknown` is deliberately silent: a live review is `reviewing` while a replay of
    // the same unfinished call is `unknown`, and announcing the two differently made a
    // resumed session print a line the lived one never had. The artifact's own row says
    // what is known; the transcript only announces what the session settled.
    if (artifact.state === 'abandoned') {
      this.pushRow(represent('plan-lifecycle', { kind: 'system', text: t('plan.exited') }))
    }
  }

  /** Older / finished plans stay in the scrolling transcript. */
  private archiveStalePlans(keep?: Extract<Row, { kind: 'plan' }>): void {
    archiveStalePlans(this.rows, keep)
  }

  /**
   * There used to be a second plan-row writer here (`upsertPlanRow`).
   *
   * B2.5 moved every plan row onto the artifact fold — one artifact, one row, and
   * `syncPlanArtifacts` is the only place a plan row is created — which left this
   * one with no caller. The B2 final audit removed it rather than leave a second
   * truth in the file for someone to find and call.
   */

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
    // One reminder per open list. The answer to a reminder is a `todo_write`,
    // and a patch that leaves an item open used to re-arm this — so every turn
    // end produced another reminder and another model turn, forever.
    if (plan.nudged === true) return
    plan.nudged = true
    this.planNudgePending = true
    const text = planCloseNudgeText(plan)
    const queued = t('plan.nudgeQueued')
    this.pushRow(represent('plan-notice', { kind: 'system', text: queued }))
    // Plugin notice, not a user turn: the model still sees the follow-up, but
    // the workspace only shows the one-line queued hint — not the todo_write
    // instruction that used to paint as `❯ …`.
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: TUI_SOURCE_KIND, form: 'notice', summary: queued },
    })
    try {
      this.agent.followup(message)
    } catch (error: unknown) {
      // The reminder never reached the model: drop the queued notice that
      // announced it (it would otherwise read as "already asked", here and in a
      // resumed transcript) and let a later turn end try again.
      this.planNudgePending = false
      plan.nudged = false
      const queuedAt = this.rows.findLastIndex(row => row.kind === 'system' && row.text === queued)
      if (queuedAt >= 0) this.rows.splice(queuedAt, 1)
      this.pushRow(represent('plan-notice', { kind: 'error', text: t('plan.nudgeFailed', { error: errorChain(error) }) }))
    }
  }

  /** Compact web-style plan strip pinned above the input, not in the transcript. */
  /**
   * The live region's runtime lines: the thinking card, the streamed text, the
   * wait card — in that order.
   *
   * Built before the window is computed, because the region *reserves* rows now:
   * `paint` needs its height before it can size the transcript. `waitStart` is
   * where the wait card begins, which is where the compact view splices the
   * running burst (that is where the transcript paints it for a settled reply).
   * `thinkingRows` is how many lines the live thinking card owns, so a click on
   * them reaches the card.
   */
  private runtimeTailLines(width: number): { lines: string[]; waitStart: number; thinkingRows: number } {
    const lines: string[] = []
    let thinkingRows = 0
    if (this.streaming !== undefined) {
      if (!this.isCompactView() && this.showReasoning && this.streaming.reasoning !== '') {
        const block = this.liveThinkingBlock()
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
        lines.push(this.selectLine(styled, focused))
        thinkingRows = 1
        if (block.expanded) {
          for (const wrapped of wrap(this.streaming.reasoning, width)) {
            lines.push(this.styleLine('reasoning', wrapped))
            thinkingRows += 1
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
          lines.push(this.styleLine('assistant', line))
        }
      }
    }
    const waitStart = lines.length
    if (this.waitCardVisible()) {
      const copy = waitCardCopy(this.waitCardSource())
      const started = this.waitStartedAt ?? Date.now()
      const elapsed = fmtElapsedCompact((Date.now() - started) / 1000)
      const hint = t('wait.interrupt', { elapsed })
      const spinner = this.spinnerFrame()
      const header = this.color
        ? `${spinner} ${shimmerText(copy.header, Date.now(), true)}  ${this.styleLine('system', hint)}`
        : `${spinner} ${copy.header}  ${hint}`
      lines.push(header)
      for (const line of wrapWaitDetails(copy.detail ?? '', width)) {
        lines.push(this.styleLine('system', line))
      }
    }
    return { lines, waitStart, thinkingRows }
  }

  private paintPlanDock(width: number, yieldBottom: boolean, maxLines = Number.POSITIVE_INFINITY): string[] {
    const plan = this.dockedPlanRow()
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
      const markdown = renderMarkdownLines(plan.planMarkdown, inner, this.color, this.terminalCaps.osc8)
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
    const budget = Math.max(1, Math.floor(maxLines))
    // Under height pressure the dock loses density, never existence (B2.5 §10): the
    // reader must always be able to see that an active plan exists and where it is.
    // FULL is the ordinary card; COMPACT is one line with the current step; MINIMAL
    // is the mode and the progress and nothing else.
    if (budget < 5) return [this.styleLine('plan-dock', padToWidth(this.planDockCompactLine(plan, budget < 3), width))]
    if (lines.length <= budget) return lines
    // The dock's own header survives the clip, for the same reason the live
    // region's does: a card that is only a tail of its own body does not say what
    // it is. What follows it is either the next lines or, in the last row, how many
    // were left out — a card cut off with no marker reads as a card that ends
    // there.
    if (budget === 1) return lines.slice(0, 1)
    const dropped = lines.length - budget + 1
    return [
      lines[0] ?? '',
      ...lines.slice(1, budget - 1),
      this.styleLine('plan-dock', padToWidth(t('plan.moreLines', { count: dropped }), width)),
    ]
  }

  /**
   * One diff line with its changed characters in reverse video.
   *
   * The line is split at the spans and each piece is styled on its own. Reverse
   * is an attribute rather than a colour, so the emphasis survives every palette,
   * including a monochrome terminal.
   */
  private styleEmphasisedLine(line: DiffDisplayLine, width: number): string[] {
    const inner = Math.max(1, width - 2)
    const spans = [...(line.spans ?? [])].sort((left, right) => left.start - right.start)
    const pieces: Array<{ text: string; emphasis: boolean }> = []
    let cursor = 0
    for (const span of spans) {
      const from = Math.max(cursor, Math.min(line.text.length, span.start))
      const to = Math.max(from, Math.min(line.text.length, span.end))
      if (from > cursor) pieces.push({ text: line.text.slice(cursor, from), emphasis: false })
      if (to > from) pieces.push({ text: line.text.slice(from, to), emphasis: true })
      cursor = to
    }
    if (cursor < line.text.length) pieces.push({ text: line.text.slice(cursor), emphasis: false })
    const flat = pieces.length === 0 ? [{ text: line.text, emphasis: false }] : pieces
    const rows: string[] = []
    let buffer: Array<{ text: string; emphasis: boolean }> = []
    let used = 0
    const flush = (): void => {
      if (buffer.length === 0) return
      const body = buffer
        .map(piece => (piece.emphasis
          ? this.styleEmphasisedPiece(line.kind, piece.text)
          : this.styleLine(line.kind, piece.text)))
        .join('')
      rows.push(`  ${body}`)
      buffer = []
      used = 0
    }
    for (const piece of flat) {
      let rest = piece.text
      while (rest !== '') {
        const room = Math.max(1, inner - used)
        const wrapped = wrap(rest, room)[0] ?? rest
        buffer.push({ text: wrapped, emphasis: piece.emphasis })
        used += displayWidth(wrapped)
        rest = rest.slice(wrapped.length)
        if (used >= inner && rest !== '') flush()
      }
    }
    flush()
    return rows.length === 0 ? [this.styleLine(line.kind, '')] : rows
  }

  /**
   * A body row whose parts carry different roles: the two columns of a
   * side-by-side diff.
   *
   * No single kind fits such a row — the left column is a removal, the right an
   * addition — so each part is painted with its own style, the gutter keeps the
   * row's own (neutral) one, and a word emphasis rides inside whichever column
   * it belongs to. The first column takes the leading indent and the last one
   * runs to the end of the row, so both bars are flush.
   */
  private styleColumnedLine(line: DiffDisplayLine, width: number): string[] {
    const indent = 2
    const padded = padToWidth(`  ${line.text}`, Math.max(1, width))
    const cut = (at: number): number => Math.max(0, Math.min(padded.length, at + indent))
    const columns = (line.columns ?? []).map((column, index, all) => ({
      start: index === 0 ? 0 : cut(column.start),
      end: index === all.length - 1 ? padded.length : cut(column.end),
      kind: column.kind,
    }))
    const cuts = new Set<number>([0, padded.length])
    for (const span of line.spans ?? []) {
      cuts.add(cut(span.start))
      cuts.add(cut(span.end))
    }
    for (const column of line.columns ?? []) {
      cuts.add(cut(column.start))
      cuts.add(cut(column.end))
    }
    const ordered = [...cuts].sort((left, right) => left - right)
    const pieces: string[] = []
    for (let at = 0; at + 1 < ordered.length; at += 1) {
      const from = ordered[at] ?? 0
      const to = ordered[at + 1] ?? from
      if (to <= from) continue
      const column = columns.find(item => item.start <= from && item.end >= to)
      const emphasis = (line.spans ?? []).some(span => cut(span.start) <= from && cut(span.end) >= to)
      const text = padded.slice(from, to)
      const kind = column?.kind ?? line.kind
      pieces.push(emphasis ? this.styleEmphasisedPiece(kind, text) : this.styleLine(kind, text))
    }
    return pieces.length === 0 ? [this.styleLine(line.kind, '')] : [pieces.join('')]
  }

  private paintToolBodyLine(
    addDisplay: (line: string, ref?: Row | CollapsibleBlock) => void,
    row: Row | CollapsibleBlock | undefined,
    line: DiffDisplayLine,
    width: number,
  ): void {
    const inner = Math.max(1, width - 2)
    const fillRow = line.kind === 'diff-add' || line.kind === 'diff-del'
    // A line that holds two roles (the columns of a side-by-side diff) is
    // painted part by part; its emphasis rides inside whichever part it is in.
    if (line.columns !== undefined && line.columns.length > 0) {
      for (const painted of this.styleColumnedLine(line, width)) addDisplay(painted, row)
      return
    }
    // An emphasised line is styled in parts: the escapes wrap *styled* pieces,
    // because the painter's sanitiser strips any escape that reaches it inside
    // the text — which is how a literal `[7m` once appeared on screen.
    if (line.spans !== undefined && line.spans.length > 0) {
      for (const painted of this.styleEmphasisedLine(line, width)) addDisplay(painted, row)
      return
    }
    for (const wrapped of wrap(line.text, inner)) {
      const body = fillRow ? padToWidth(`  ${wrapped}`, width) : `  ${wrapped}`
      const kind = line.kind
      const style = kind === 'diff-add' || kind === 'diff-del' || kind === 'diff-path'
        ? this.styleLine(kind, body)
        : kind === 'todo-done' || kind === 'todo-active' || kind === 'todo-pending'
          || kind === 'todo-failed' || kind === 'todo-skipped'
          ? this.styleLine(kind, body)
          : kind === 'error'
            ? this.styleLine('error', body)
            : kind === 'assistant'
              ? this.styleLine('assistant', body)
              : this.styleLine('tool-result', body)
      addDisplay(style, row)
    }
  }

  /**
   * The representations this transcript is made of (B2.3a's audit artifact).
   *
   * Reads the policy off the rows themselves, so it reports what is really in the
   * transcript rather than what the table says should be — including anything that
   * arrived unclassified.
   */
  representationAudit(): RepresentationAudit {
    return auditRepresentations(this.rows)
  }

  /**
   * The ask-user half of the audit: one semantic question, one primary row.
   *
   * Read off the real transcript rather than declared, because the invariant is
   * about what a reader can see: a call with both a question card and a generic
   * tool card is two primaries for one event, and the count is what catches a
   * regression (B2.4).
   */
  questionPrimaryAudit(): ReturnType<typeof auditQuestionPrimaries> {
    return auditQuestionPrimaries(this.rows)
  }

  /**
   * Drop an acknowledgement or a warning whose time is up.
   *
   * Called before a frame is built and by the expiry timer, so every reader — the
   * footer, the Screen strip, `/diag` and the tests — sees the same thing at the same
   * moment: the row is the session's again once the sentence has been readable.
   */
  private expireFeedback(now: number = Date.now()): void {
    if (this.feedbackTtlMs <= 0) return
    const stale = (feedback: { at: number; holds?: 'queue' } | undefined): boolean =>
      feedback !== undefined && feedback.holds === undefined && now - feedback.at >= this.feedbackTtlMs
    if (stale(this.footerEcho)) this.footerEcho = undefined
    if (stale(this.notice)) this.notice = undefined
  }

  /**
   * Repaint when the newest feedback expires, so the row goes back by itself.
   *
   * Unref'd: this timer exists to refresh a UI that is already running, and a Host
   * with nothing else pending (no window attached, no turn) may exit instead — the
   * expiry is evaluated against the timestamp on the next frame anyway, so nothing
   * depends on the callback being reached.
   */
  private armFeedbackExpiry(): void {
    if (this.feedbackTimer !== undefined) clearTimeout(this.feedbackTimer)
    // `0` means "no clock": nothing to arm, and a 0 ms timer would expire it at once.
    if (this.feedbackTtlMs <= 0) return
    if (this.notice?.holds === 'queue' && this.footerEcho === undefined) return
    this.feedbackTimer = setTimeout(() => {
      this.feedbackTimer = undefined
      this.expireFeedback()
      this.markDirty()
    }, this.feedbackTtlMs)
    this.feedbackTimer.unref?.()
  }

  /** The footer echo the reader can see right now, if any (a test/`/diag` seam). */
  currentFooterEcho(): string | undefined {
    this.expireFeedback()
    return this.footerEcho?.text
  }

  /** The ephemeral notice the reader can see right now, if any. */
  currentNotice(): string | undefined {
    this.expireFeedback()
    return this.notice?.text
  }

  /** The audit as text, for the dev script and for `/diag`-style reporting. */
  formatRepresentationAudit(): string {
    return formatRepresentationAudit(this.representationAudit())
  }

  /** The rows the reader can see: everything after the `/clear` cutoff. */
  private visibleRows(): readonly Row[] {
    return this.clearedRows === 0 ? this.rows : this.rows.slice(this.clearedRows)
  }

  private workspaceRowsFor(_width: number, height: number): number {
    const header = 2
    const chrome = RESERVED_BOTTOM_LINES + 1
    return Math.max(1, height - header - chrome)
  }

  /**
   * Open one report as a Screen.
   *
   * A report is not narrative: it cannot be rebuilt from the session log (it is not
   * a session event), so leaving it in the transcript meant the reader scrolled
   * through something that would vanish on the next resume, pushed the real history
   * out of the window (`/help` moved the anchor 53 rows, measured) and cost a full
   * clear per invocation. It is ephemeral by design: a Screen, gone when dismissed,
   * never written to the log (AD-7).
   *
   * Only the *successful* path comes here. A command that fails still writes an
   * `error` row: a failure is part of the session's story and has to outlive the
   * visit.
   */
  private openReport(report: ReportKind, lines: readonly string[], notice?: string): void {
    // Line mode has no frame at all, so a report there keeps the textual path it
    // always had — the same rule the inspect bodies follow (`echoInspectToLog`).
    // `no-TTY` and desktop hosts render the workspace frame, so they do get Screens.
    if (this.lineMode) {
      this.pushRow(represent('report-echo', { kind: reportRowKind(report), text: lines.join('\n') }))
      this.markDirty()
      return
    }
    this.openScreen({
      kind: 'report',
      report,
      title: t(`screen.title.${report}`),
      lines: lines.map(text => ({ kind: 'system' as const, text })),
      offset: 0,
      copyText: lines.join('\n'),
      ...(notice === undefined || notice === '' ? {} : { notice }),
    })
  }

  /**
   * Open a Screen: it replaces the workspace for as long as it is up.
   *
   * The workspace's own state — the transcript window, `scrollOffset`, the focused
   * card, `/find` hits, the composer draft, and whatever Surface is queued behind
   * it — is neither touched here nor rebuilt on the way out. A Screen is a visit,
   * not a second workspace.
   */
  private openScreen(screen: ScreenState): void {
    this.screen = screen
    this.screenSurface = undefined
    this.screenSurfaceResolve = undefined
    this.screenNeedsFullPaint = true
    this.markDirty()
  }

  /** Leave the Screen and hand the pixels back to the workspace, as they were. */
  closeScreen(): void {
    if (this.screen === undefined) return
    this.screen = undefined
    this.screenSurface = undefined
    this.screenSurfaceResolve = undefined
    // One full repaint when a Screen closes, and it is deliberate: the transcript
    // may have grown (or been compacted) while the reader was away, so the frame
    // that returns has to be rebuilt anyway. It is measured in the Screen contract
    // tests; what must never happen is a full repaint per *keypress inside* a Screen.
    this.forceFullPaint = true
    // A Surface that arrived while this Screen was up has been waiting in the
    // workspace queue: leaving the Screen is what opens it. Nothing was lost and
    // nothing was answered on a screen the reader could not see.
    this.showNextDialog()
    this.markDirty()
  }

  /**
   * Ask a confirmation in whichever channel owns the screen.
   *
   * A Screen's own action (the doctor repair) needs a human decision, and while a
   * Screen is up that question belongs to it: it is painted on the Screen's hint
   * row and settled by the Screen's key handler, so it never enters the workspace
   * `dialogQueue` and a workspace question waiting there is left untouched (AD-3).
   * Returns `undefined` when no Screen is up, so the caller uses the ordinary path.
   */
  private askScreenConfirm(prompt: string, hint: string): Promise<'y' | 'n' | 'cancel'> | undefined {
    if (this.screen === undefined) return undefined
    this.screenSurfaceResolve?.('cancel')
    return new Promise<'y' | 'n' | 'cancel'>(resolve => {
      this.screenSurface = { kind: 'confirm', prompt, hint, resolve: () => {} }
      this.screenSurfaceResolve = resolve
      this.markDirty()
    })
  }

  /** Settle the Screen's own confirmation, if one is up. */
  private settleScreenConfirm(value: 'y' | 'n' | 'cancel'): void {
    const resolve = this.screenSurfaceResolve
    this.screenSurface = undefined
    this.screenSurfaceResolve = undefined
    if (resolve !== undefined) resolve(value)
    this.markDirty()
  }

  /**
   * Paint the Screen that is up: it replaces the workspace entirely.
   *
   * A Screen is state (`ScreenState`) plus this renderer, and nothing else: the
   * same state redraws the same picture, which is what makes a reattach after an
   * SSH drop ordinary rather than special. Only the *first* frame of a Screen —
   * opening, a resize, a reattach — clears the screen; scrolling a report repaints
   * the body rows that actually changed and leaves the title, hint and strip alone.
   * The previous implementation passed `sizeChanged: true` on every frame, so every
   * arrow key cost a full clear and a full frame (measured: 2.7 KB per keypress at
   * 100×20).
   */
  private paintScreen(width: number, height: number): void {
    const screen = this.screen
    if (screen === undefined) return
    const layout = screenLayout(height)
    // One derivation for the strip and the footer: `footerFacts` is the same call
    // the workspace frame makes, so a Screen cannot disagree with the footer about
    // whether the agent is running. A Screen has no composer, so the input shape it
    // passes says exactly that.
    const facts = this.footerFacts(SCREEN_INPUT, 1)
    const body = this.renderScreenBody(screen, width)
    // `/find` reported a hit inside this body, so put it on screen: the Screen used
    // to open at the top and leave the reader scrolling for it. Done once, so PgDn
    // afterwards keeps the reader's own position.
    if (screen.searchRevealed !== true && this.searchNeedle !== '') {
      const at = body.findIndex(row => searchContains(stripAnsi(row), this.searchNeedle))
      if (at >= 0) screen.offset = Math.max(0, at - 1)
      screen.searchRevealed = true
    }
    const offset = clampScreenOffset(screen.offset, body.length, layout.bodyRows)
    screen.offset = offset
    const slice = body.slice(offset, offset + layout.bodyRows)
    while (slice.length < layout.bodyRows) slice.push('')

    const paintRows: string[] = []
    if (layout.titleRows > 0) {
      paintRows.push(this.styleLine('system', truncateToWidth(screen.title, width)))
    }
    if (layout.dividerRows > 0) paintRows.push(this.styleLine('system', repeatToWidth('─', width)))
    paintRows.push(...slice)
    if (layout.hintRows > 0) {
      paintRows.push(this.styleLine('system', truncateToWidth(this.screenHintLine(screen, layout, body.length), width)))
    }
    if (layout.stripRows > 0) {
      const strip = screenRuntimeStrip({
        activity: facts.activity,
        // What is waiting *behind* this Screen: an interaction the workspace queued
        // (it could not open while a Screen owned the screen) or a question the
        // Session still holds. The activity row already names a wait the session
        // itself is in — a Screen is never that — so this group is only added when
        // the activity is not already saying it.
        waiting: this.screenWaitingWork() && !WAIT_ACTIVITY_KINDS.has(facts.activity.kind),
        queued: this.pendingMessages.size,
        queuedQuestions: this.queuedQuestions,
        link: {
          kind: this.paintLink,
          intervalMs: this.paintIntervalMs,
          probed: this.paintProbed,
          ...(this.paintRttMs === undefined ? {} : { rttMs: this.paintRttMs }),
        },
        ...(this.contextPressure === undefined ? {} : { context: this.contextPressure }),
        ...(facts.quotaWindow === undefined || this.quotaSnapshot === undefined
          || this.quotaSnapshot.provider !== facts.provider
          ? {}
          : { quota: { remainingPercent: facts.quotaWindow.remainingPercent, period: facts.quotaWindow.period } }),
        depth: this.colorDepth,
        color: this.color,
      }, Math.max(1, width), this.mutedSeparator(), this.spinnerFrame())
      paintRows.push(`${this.muteFooterLine(strip)}\x1b[0m`)
    }
    if (layout.stripRows > 0 && paintRows.length > 0 && layout.stripTop !== paintRows.length - 1) {
      // The layout owns the geometry; a mismatch means one of the two counted the
      // rows differently, and painting anyway would shift the strip onto a body row.
      paintRows.length = layout.stripTop + 1
    }
    while (paintRows.length < height) paintRows.push('')

    const stripText = paintRows[layout.stripTop] ?? ''
    const stripChanged = stripText !== this.lastScreenStrip
    this.lastScreenStrip = stripText
    const sizeChanged = this.screenNeedsFullPaint
      || this.forceFullPaint
      || width !== this.lastPaintWidth
      || height !== this.lastPaintHeight
    this.screenNeedsFullPaint = false
    this.forceFullPaint = false
    const frame = composePaintFrame({
      width,
      height,
      paintRows,
      previousRows: this.lastPaintRows,
      sizeChanged,
      // The strip is the only chrome a Screen has; when it changes (the spinner
      // turns, the link tier moves) every row from it down is repainted, and when
      // it does not, the body rows that changed are the only ones addressed.
      chromeChanged: stripChanged,
      chromeStart: Math.max(0, layout.stripTop),
      previousChromeStart: this.lastChromeStart,
      cursorRow: 1,
      cursorColumn: 1,
      hideCursor: true,
      // A size change opens with a full clear, so splitting it across frames would
      // show a half-empty screen; everything incremental is budgeted like the
      // workspace frame, and rows that do not fit stay dirty for the next tick.
      maxBytes: sizeChanged ? undefined : frameByteBudget(linkQualityOf(this.paintLink, this.paintRttMs)),
      ...(this.paintResume === undefined ? {} : { from: this.paintResume }),
    })
    this.paintResume = frame.resume
    this.lastFrameBytes = Buffer.byteLength(frame.output, 'utf8')
    this.write(frame.output)
    this.lastPaintCursorRow = 1
    this.lastPaintCursorColumn = 1
    const snapshot = paintRows.length > height ? paintRows.slice(0, height) : paintRows
    this.lastPaintRows = frame.deferred.length === 0
      ? snapshot
      : advancePaintedRows(this.lastPaintRows, snapshot, frame.painted)
    this.lastChromeKey = `screen:${screen.kind}:${offset}:${width}x${height}`
    this.lastPaintWidth = width
    this.lastPaintHeight = height
    this.lastChromeStart = Math.max(0, layout.stripTop)
    // The transcript is not on screen, so the next workspace frame — the one that
    // closes this Screen — must not trust the row bookkeeping it left here.
    this.lastTranscriptStart = -1
  }

  /**
   * The Screen's bottom hint row: how to leave, where the reader is, how to move.
   *
   * Composed in that order so truncation takes the least load-bearing part first:
   * a reader on a 48-column terminal still sees `全文 12–16/80 · Esc 返回`, while a
   * wide one also gets the navigation keys. A confirmation owned by the Screen, and
   * a notice from an action it performed, take the row outright — both are answers
   * to something the reader just did, and both belong to *this* Screen rather than
   * to the workspace's dialog queue (AD-3).
   */
  private screenHintLine(screen: ScreenState, layout: ReturnType<typeof screenLayout>, lineCount: number): string {
    const surface = this.screenSurface
    if (surface !== undefined && surface.kind === 'confirm') return `${surface.prompt}  ${surface.hint}`
    if (screen.notice !== undefined && screen.notice !== '') return screen.notice
    const pos = screenPositionText(screen.offset, lineCount, layout.bodyRows)
    const base = t('screen.footer', { pos })
    const navigation = t('screen.hint')
    // A *plain* separator, because this string is styled as a whole by the caller
    // (`styleLine` sanitises, and the sanitiser removes the ESC byte and keeps the
    // rest of the sequence). The styled separator belongs to `runtimeStrip`, whose
    // result is written to the terminal as-is; splicing it in here printed the
    // literal `[90m` after `Esc 返回` — the artifact a reader captured on the quota
    // report's bottom row.
    const spacer = ' │ '
    return visibleWidth(`${base}${spacer}${navigation}`) <= Math.max(1, this.screenColumns())
      ? `${base}${spacer}${navigation}`
      : base
  }

  /**
   * The setup Screen's rows, built from the wizard's state every frame.
   *
   * The order is the contract (B2.6 §8): what this step *is*, then its prose, then the
   * control the reader acts on, then validation, then the keys. The layout keeps the
   * last two whatever the height — prose is what gets cut, never the field — and the
   * secret step renders the key masked, because a Screen is a place other people can
   * see (B2.6 §4/§8).
   */
  private renderSetupBody(width: number): string[] {
    const state = this.onboarding
    if (state === undefined) return [this.styleLine('system', t('onboard.needSetup'))]
    const inner = Math.max(1, width - 2)
    const rows: string[] = []
    const push = (kind: DisplayKind, text: string): void => {
      for (const wrapped of wrap(text, inner)) rows.push(this.styleLine(kind, `  ${wrapped}`))
    }
    const prose: string[] = []
    const addProse = (kind: DisplayKind, text: string): void => {
      for (const wrapped of wrap(text, inner)) prose.push(this.styleLine(kind, `  ${wrapped}`))
    }
    const template = onboardTemplate(state)
    const providerLabel = `${template.label}${template.defaultBaseUrl === '' ? '' : `（${template.defaultBaseUrl}）`}`
    const indicator = t('setup.stepIndicator', {
      index: SETUP_STEPS.indexOf(state.step) + 1,
      total: SETUP_STEPS.length,
      name: t(`onboard.step.${state.step}`),
    })
    push('setup-step', indicator)
    switch (state.step) {
      case 'provider': {
        const options = this.mergedProviderEntries(state)
        if (options.length === 0) {
          addProse('system', t('onboard.catalogEmpty'))
          break
        }
        const start = pickerWindowStart(state.providerCursor, options.length)
        const end = Math.min(options.length, start + PICKER_WINDOW)
        if (start > 0) addProse('system', `  ${t('picker.moreAbove', { count: start })}`)
        for (let index = start; index < end; index += 1) {
          const option = options[index]
          if (option === undefined) continue
          const focused = index === state.providerCursor ? '›' : ' '
          addProse(index === state.providerCursor ? 'setup-choice' : 'system',
            ` ${focused} ○ ${option.label}${option.detail === '' ? '' : ` — ${option.detail}`}`)
        }
        if (end < options.length) addProse('system', `  ${t('picker.moreBelow', { count: options.length - end })}`)
        if (state.field.trim() !== '') addProse('system', t('onboard.catalogHint', { count: options.length }))
        addProse('system', t('onboard.pickHint'))
        break
      }
      case 'id':
        addProse('system', t('onboard.providerLine', { label: providerLabel }))
        addProse('system', t('onboard.idPrompt'))
        addProse('system', t('onboard.default', { value: template.defaultId }))
        break
      case 'key':
        addProse('system', t('onboard.providerLine', { label: providerLabel }))
        addProse('system', t('onboard.keyPrompt'))
        if (state.providerType === 'catalog') addProse('system', t('onboard.keyCatalogHint'))
        break
      case 'base-url':
        addProse('system', t('onboard.providerLine', { label: providerLabel }))
        addProse('system', t('onboard.basePrompt', {
          fallback: template.defaultBaseUrl !== ''
            ? template.defaultBaseUrl
            : state.providerType === 'catalog' ? t('onboard.baseFallbackCatalog') : t('onboard.baseFallback'),
        }))
        break
      case 'models':
        addProse('system', t('onboard.providerLine', { label: providerLabel }))
        addProse('system', t('onboard.modelsPrompt'))
        addProse('system', state.models.length > 0
          ? t('onboard.modelsFetched', { count: state.models.length, list: formatModelList(state.models, 6) })
          : t('onboard.default', { value: template.defaultModels.join(', ') }))
        if (template.api !== undefined) addProse('system', t('onboard.ctrlF'))
        if (state.providerType === 'catalog') addProse('system', t('onboard.modelsCatalogHint'))
        addProse('system', t('onboard.modelsPickHint'))
        break
      case 'models-pick': {
        const candidates = state.modelCandidates ?? []
        addProse('system', t('onboard.providerLine', { label: providerLabel }))
        addProse('system', t('onboard.modelsPick', { count: candidates.length }))
        const start = pickerWindowStart(state.modelCursor ?? 0, candidates.length)
        const end = Math.min(candidates.length, start + PICKER_WINDOW)
        if (start > 0) addProse('system', `  ${t('picker.moreAbove', { count: start })}`)
        for (let index = start; index < end; index += 1) {
          const id = candidates[index]
          if (id === undefined) continue
          const focused = index === (state.modelCursor ?? 0) ? '›' : ' '
          const mark = (state.modelChecked ?? new Set<number>()).has(index) ? '◉' : '○'
          addProse(index === (state.modelCursor ?? 0) ? 'setup-choice' : 'system', ` ${focused} ${mark} ${id}`)
        }
        if (end < candidates.length) addProse('system', `  ${t('picker.moreBelow', { count: candidates.length - end })}`)
        addProse('system', t('onboard.modelsCheckHint'))
        break
      }
      case 'model-default': {
        const checked = this.checkedOnboardingModels(state)
        addProse('system', t('onboard.providerLine', { label: providerLabel }))
        addProse('system', t('onboard.defaultModelPick'))
        const start = pickerWindowStart(state.modelCursor ?? 0, checked.length)
        const end = Math.min(checked.length, start + PICKER_WINDOW)
        if (start > 0) addProse('system', `  ${t('picker.moreAbove', { count: start })}`)
        for (let index = start; index < end; index += 1) {
          const id = checked[index]
          if (id === undefined) continue
          const focused = index === (state.modelCursor ?? 0) ? '›' : ' '
          addProse(index === (state.modelCursor ?? 0) ? 'setup-choice' : 'system', ` ${focused} ○ ${id}`)
        }
        if (end < checked.length) addProse('system', `  ${t('picker.moreBelow', { count: checked.length - end })}`)
        addProse('system', t('onboard.pickHint'))
        break
      }
      case 'context':
        addProse('system', t('onboard.providerLine', { label: providerLabel }))
        addProse('system', t('onboard.contextPrompt'))
        addProse('system', t('onboard.contextValue', {
          value: String(state.routeContextWindow ?? HARNESS_DEFAULT_CONTEXT_WINDOW),
        }))
        addProse('system', t('onboard.contextHint'))
        break
      case 'confirm':
        addProse('system', t('onboard.confirmTitle'))
        addProse('system', t('onboard.confirmProvider', { label: providerLabel }))
        addProse('system', `  Provider ID: ${state.providerId}`)
        addProse('system', t('onboard.confirmBase', { url: state.baseUrl === '' ? (template.defaultBaseUrl || t('onboard.defaultParen')) : state.baseUrl }))
        addProse('system', t('onboard.confirmApi', {
          api: template.api ?? (state.providerType === 'catalog' ? t('onboard.apiCatalog') : 'deepseek-official'),
        }))
        addProse('system', t('onboard.confirmModels', { list: formatModelList(state.models, 8) }))
        if (state.defaultModel !== undefined) addProse('system', t('onboard.confirmDefaultModel', { model: state.defaultModel }))
        if (state.routeContextWindow !== undefined) addProse('system', t('onboard.confirmContext', { value: String(state.routeContextWindow) }))
        addProse('system', t('onboard.confirmKey', {
          head: sliceCodePoints(state.key, 6),
          tail: lastCodePoints(state.key, 4),
          length: state.key.length,
        }))
        break
    }
    // The controls: the field (masked for a secret), the notice, and the keys.
    const controls: string[] = []
    if (SETUP_FIELD_STEPS.has(state.step)) {
      const masked = state.step === 'key'
      const shown = masked ? '•'.repeat(Array.from(state.field).length) : state.field
      const caret = state.fieldCursor >= state.field.length ? '' : sliceCodePoints(state.field.slice(state.fieldCursor), 1)
      const text = `${shown.slice(0, state.fieldCursor)}${caret}${shown.slice(state.fieldCursor + caret.length)}`
      controls.push(this.styleLine('setup-field', `› ${text}${this.color ? '' : '_'}`))
    }
    if (state.saving) controls.push(this.styleLine('system', `  ${t('setup.working')}`))
    if (state.notice !== undefined) {
      controls.push(this.styleLine(state.notice.kind === 'error' ? 'error' : 'system', `  ${state.notice.text}`))
    }
    if (state.step === 'confirm') {
      controls.push(this.styleLine('system', `  ${t('onboard.confirmHint')}`))
    } else {
      controls.push(this.styleLine('system', `  ${t('onboard.enterEsc')}`))
    }
    return [...rows, ...this.windowSetupBody(prose, controls)]
  }

  /**
   * Fit prose and controls into whatever rows are left.
   *
   * Under height pressure the *prose* is what goes: the field, the notice and the key
   * hints are how the reader continues, and a setup screen whose only control was cut
   * away is a dead end (B2.6 §8).
   */
  private windowSetupBody(prose: string[], controls: string[]): string[] {
    const budget = Math.max(1, this.setupBodyBudget())
    if (prose.length + controls.length <= budget) return [...prose, ...controls]
    const keepControls = Math.min(controls.length, budget)
    const keepProse = Math.max(0, budget - keepControls)
    return [...prose.slice(0, keepProse), ...controls.slice(controls.length - keepControls)]
  }

  /** Rows the setup body may use: the Screen's own layout, minus the step indicator. */
  private setupBodyBudget(): number {
    const layout = screenLayout(Math.max(0, this.screenRows()))
    return Math.max(1, layout.bodyRows - 1)
  }

  /** A Screen's body, wrapped for the width it will be shown at. */
  private renderScreenBody(screen: ScreenState, width: number): string[] {
    if (screen.kind === 'setup') return this.renderSetupBody(width)
    const rendered: string[] = []
    for (const line of screen.lines) {
      const inner = Math.max(1, width - 2)
      const fillRow = line.kind === 'diff-add' || line.kind === 'diff-del'
      for (const wrapped of wrap(line.text, inner)) {
        const body = fillRow ? padToWidth(`  ${wrapped}`, width) : `  ${wrapped}`
        const kind = line.kind
        const styled = this.styleLine(kind === 'subagent' ? 'subagent-header' : kind, body)
        rendered.push(this.markSearchRow(styled, wrapped))
      }
    }
    return rendered
  }

  /**
   * Reverse-video (or a `»` in monochrome) on the overlay row that holds the
   * current `/find` needle, matching what the transcript does for the same hit.
   */
  private markSearchRow(styled: string, plain: string): string {
    const needle = this.searchNeedle
    if (needle === '' || !searchContains(plain, needle)) return styled
    return this.color ? highlightAnsiNeedle(styled, needle) : `» ${styled}`
  }

  private openToolInspect(row: Extract<Row, { kind: 'tool' }>): void {
    const lines = toolBodyLines(row, Number.MAX_SAFE_INTEGER)
    const title = t('tool.inspectTitle', { title: `${row.title}${row.summary === '' ? '' : `  ${row.summary}`}` })
    if (this.echoInspectToLog(title, lines)) return
    this.openScreen({ kind: 'inspect', title, lines, offset: 0, copyText: inspectCopyText(lines) })
  }

  private openSubagentInspect(row: Extract<Row, { kind: 'subagent' }>): void {
    const open = this.screen
    if (open !== undefined && open.kind === 'inspect' && open.subagentSessionId === this.subagentInspectId(row)) {
      open.title = t('sub.inspectTitle', { title: subagentDisplayName(row) })
      open.lines = subagentInspectLines(row)
      open.copyText = inspectCopyText(open.lines)
      open.notice = undefined
      this.markDirty()
      return
    }
    const title = t('sub.inspectTitle', { title: subagentDisplayName(row) })
    const lines = subagentInspectLines(row)
    if (this.echoInspectToLog(title, lines)) return
    this.openScreen({
      kind: 'inspect',
      title,
      lines,
      offset: 0,
      subagentSessionId: this.subagentInspectId(row),
      copyText: inspectCopyText(lines),
    })
  }

  /**
   * Read one reply full-screen.
   *
   * What Enter does on a selected reply: a reply has no body to fold away, and
   * the transcript wraps it to the window — which for a long answer with tables
   * or code blocks is not how it reads. The overlay is the same surface the tool
   * cards use, and the copy key works inside it, so "read it, then copy it"
   * needs no trip back through the timeline.
   */
  private openReplyInspect(row: Extract<Row, { kind: 'assistant' }>): void {
    // Line mode has no scroller, and `echoInspectToLog` would append the reply
    // to the log a second time — it is already there, in full. Nothing to open.
    if (this.lineMode) return
    // `- 2`, matching `paintInspectOverlay`, which re-wraps every body line at
    // `width - 2` inside a two-space indent: rendered wider, long table and code
    // rows were re-wrapped mid-cell at narrow widths.
    const width = Math.max(20, this.screenColumns() - 2)
    // Plain: `styleLine` strips escapes, so a coloured render would lose its
    // styling anyway — and the overlay's own frame supplies the base style.
    const lines: DiffDisplayLine[] = renderMarkdownLines(row.text, width, false, false)
      .map(line => ({ kind: 'assistant' as const, text: line }))
    const title = t('reply.inspectTitle', { lines: lines.length })
    if (this.echoInspectToLog(title, lines)) return
    this.openScreen({ kind: 'inspect', title, lines, offset: 0, copyText: row.text })
  }

  /**
   * Line mode has no framed scroller, so an inspect body goes into the log.
   *
   * Opening the modal there printed nothing and then swallowed the next Enter:
   * an invisible dialog. The log is the only detail surface line mode has, and
   * writing it keeps the input free.
   */
  private echoInspectToLog(title: string, lines: readonly DiffDisplayLine[]): boolean {
    if (!this.lineMode) return false
    const shown = lines.slice(0, LINE_MODE_INSPECT_LINES)
    const body = [title, ...shown.map(line => line.text)]
    if (lines.length > shown.length) {
      body.push(t('tool.bodyMoreLines', { count: lines.length - shown.length }))
    }
    this.pushRow(represent('surface-echo', { kind: 'system', text: body.join('\n') }))
    this.markDirty()
    return true
  }

  closeInspect(): void {
    this.closeScreen()
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
      addDisplay(this.selectLine(styled, focused), row)
      return
    }
    for (const wrapped of wrap(plain, width)) {
      const styled = paint(wrapped)
      addDisplay(this.selectLine(styled, focused), row)
    }
  }

  /**
   * Which file line of an expanded changes card the screen cursor is on.
   *
   * The card paints its header, then one row per file, and `selectableLines`
   * holds exactly the viewport. The cursor sits on the input row unless the
   * reader scrolled, so the file is how many painted rows above the cursor the
   * card's header is. A cursor on the header, the remainder line, or the prompt
   * falls back to the first file, which is the only defensible guess.
   */
  private changesFileIndex(row: Extract<Row, { kind: 'changes' }>): number {
    const painted = this.selectableLines.findIndex(line => line.ref === row)
    if (painted < 0) return 0
    const index = this.lastPaintCursorRow - 1 - (this.lastTranscriptStart + painted)
    if (index < 1 || index > row.files.length) return 0
    return index - 1
  }

  /** Move the card cursor among the cards and the replies. */
  private moveFocus(delta: number): void {
    const rows = this.focusRing()
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
    const focused = this.focusedRow
    // A reply has no body to fold away, so Enter reads it full-screen instead.
    // Falling through to the lookup below would be worse than doing nothing:
    // a reply is not in `collapsibleRows()`, and the fallback is "the newest
    // card" — Enter on a selected reply would expand a card the reader never
    // picked.
    if (focused !== null && focused.kind === 'assistant') {
      this.openReplyInspect(focused)
      return
    }
    const rows = this.collapsibleRows()
    if (rows.length === 0) return
    const inRing = focused !== null && rows.includes(focused as CollapsibleBlock)
      ? focused as CollapsibleBlock
      : undefined
    const target = inRing ?? rows[rows.length - 1]
    if (target === undefined) return
    this.toggleCard(target)
  }

  /**
   * Whether an inline tool body would be cut short.
   *
   * Two things stop a body short: it cannot fit the workspace, or the measured
   * link is slow enough that the paint budget trims it. Both leave the reader
   * looking at part of a diff under a header that counts all of it, and both
   * are what the overlay is for — so both answers are the overlay, and the
   * card's own `Enter 全览` hint stays true.
   */
  private toolBodyTruncated(target: Extract<Row, { kind: 'tool' }>, width: number, height: number): boolean {
    const body = toolBodyLines(target, Number.MAX_SAFE_INTEGER)
    if (body.length > toolBodyLineLimit(linkQualityOf(this.paintLink, this.paintRttMs))) return true
    return !toolBodyFitsWorkspace(
      wrappedToolBodyLineCount(body, width),
      this.workspaceRowsFor(width, height),
    )
  }

  toggleCard(target: CollapsibleBlock): void {
    // A changes card opens its file list first; the next Enter reads the file
    // the cursor is on. With one file there is nothing to choose, so that Enter
    // opens it directly.
    if (target.kind === 'changes' && target.expanded && target.files.length > 0) {
      this.focusedRow = target
      this.openChangesInspect(target, target.files.length === 1 ? 0 : this.changesFileIndex(target))
      return
    }
    if (target.kind === 'subagent') {
      this.focusedRow = target
      this.openSubagentInspect(target)
      return
    }
    if (target.kind === 'tool') {
      const width = Math.max(10, this.screenColumns())
      const height = Math.max(6, this.screenRows())
      if (this.toolBodyTruncated(target, width, height)) {
        this.focusedRow = target
        this.openToolInspect(target)
        return
      }
    }
    target.expanded = !target.expanded
    this.focusedRow = target
    // The live thinking card's choice outlives the card itself (the phase settles
    // into a row and the next phase starts a new one), so it is recorded for the
    // turn rather than left on an object that is about to be dropped.
    if (target.kind === 'streaming-reasoning') this.reasoningExpandedChoice = target.expanded
    this.forceFullPaint = true
    this.markDirty()
  }

  /** Expand all collapsible blocks, or collapse them again when all are open. */
  toggleAllCollapsible(): void {
    const rows = this.collapsibleRows()
    if (rows.length === 0) return
    // Ctrl+R acts on the cards; a selected reply is not one, and it must survive
    // the sweep either way (it was not collapsed, so it must not be deselected).
    const selected = this.focusedRow?.kind === 'assistant' ? this.focusedRow : undefined
    const allExpanded = rows.every(row => row.expanded)
    if (allExpanded) {
      for (const row of rows) row.expanded = false
      this.focusedRow = selected ?? null
    } else {
      const width = Math.max(10, this.screenColumns())
      const height = Math.max(6, this.screenRows())
      const workspace = this.workspaceRowsFor(width, height)
      for (const row of rows) {
        if (row.kind === 'subagent') continue
        if (row.kind === 'tool') {
          const bodyRows = wrappedToolBodyLineCount(toolBodyLines(row, Number.MAX_SAFE_INTEGER), width)
          if (!toolBodyFitsWorkspace(bodyRows, workspace)) continue
        }
        row.expanded = true
      }
      this.focusedRow = selected ?? rows[rows.length - 1] ?? null
    }
    this.forceFullPaint = true
    this.markDirty()
  }

  /**
   * Mark the search hit across the lines that are actually on screen.
   *
   * Only the lines that show the match are marked — highlighting the whole card
   * made a hit look like a selected card, and on a narrow screen the reader
   * could not tell which word had matched. When the wrap split the needle so no
   * single line contains it, the row's first line is marked instead: `/find`
   * reported a hit, so the reader has to see where it is.
   */
  private highlightSearchLines(
    visible: readonly string[],
    refs: readonly (Row | CollapsibleBlock | undefined)[],
  ): string[] {
    const hit = this.searchHits[this.searchIndex]
    const needle = this.searchNeedle
    if (hit === undefined || needle === '') return [...visible]
    const hitLines: number[] = []
    for (let index = 0; index < visible.length; index += 1) {
      if (refs[index] === hit) hitLines.push(index)
    }
    if (hitLines.length === 0) return [...visible]
    const inlineHit = hitLines.some(index => searchContains(stripAnsi(visible[index] ?? ''), needle))
    const lines = [...visible]
    for (const index of hitLines) {
      const line = lines[index] ?? ''
      if (line.includes('\x1b[7m')) continue
      if (searchContains(stripAnsi(line), needle)) {
        lines[index] = this.color ? highlightAnsiNeedle(line, needle) : `» ${line}`
        continue
      }
      if (!inlineHit && index === hitLines[0]) {
        lines[index] = this.color ? `\x1b[7m${line}\x1b[27m` : `» ${line}`
      }
    }
    return lines
  }

  private revealRow(row: Row | CollapsibleBlock | undefined): void {
    if (row === undefined) return
    if (row.kind === 'subagent') {
      this.focusedRow = row
      this.openSubagentInspect(row)
      return
    }
    if (row.kind === 'tool') {
      const width = Math.max(10, this.screenColumns())
      const height = Math.max(6, this.screenRows())
      if (this.toolBodyTruncated(row, width, height)) {
        this.focusedRow = row
        this.openToolInspect(row)
        return
      }
    }
    if (row.kind !== 'assistant' && 'expanded' in row) {
      row.expanded = true
      this.focusedRow = row as CollapsibleBlock
      this.forceFullPaint = true
    } else if (row.kind === 'assistant') {
      // A reply has nothing to expand, but revealing it must leave it selected:
      // Alt+4 and `/find 回复` land here, and clearing the focus (which is what
      // this branch used to do) meant `/copy` afterwards only worked by falling
      // back to "the latest reply" — silently, and only when it happened to be
      // the same row.
      this.focusedRow = row
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
        this.pushRow(represent('find-feedback', { kind: 'system', text: t('jump.planDock', { category: cardCategoryLabel(category) }) }))
        this.revealRow(live)
        return
      }
    }
    const target = this.rows.findLast(row => cardCategoryOf(row) === category)
    if (target === undefined) {
      this.pushRow(represent('find-feedback', { kind: 'system', text: t('jump.missing', { category: cardCategoryLabel(category) }) }))
      this.markDirty()
      return
    }
    this.pushRow(represent('find-feedback', { kind: 'system', text: t('jump.latest', { category: cardCategoryLabel(category) }) }))
    this.revealRow(target)
  }

  private applySearchHits(query: string, hits: Row[]): void {
    this.searchQuery = query
    this.searchHits = hits
    if (hits.length === 0) {
      // A miss while the view is cut off is the moment the boundary matters: the text
      // may well be in the session log, and the reader has to know local `/find` is not
      // looking there (AD-9). Said where it is asked, and it replaces the miss notice
      // rather than piling up beside it.
      if (this.clearedRows > 0) { this.notice = { text: t('find.scopeHint'), at: Date.now() }; this.armFeedbackExpiry() }
      this.searchIndex = -1
      this.pushRow(represent('find-feedback', {
        kind: 'system',
        text: query === '' ? t('find.none') : t('find.noMatch', { query }),
      }))
      this.markDirty()
      return
    }
    this.searchIndex = hits.length - 1
    const hit = hits[this.searchIndex]
    const where = hit === undefined ? '' : cardCategoryLabel(cardCategoryOf(hit) ?? 'reply')
    this.pushRow(represent('find-feedback', {
      kind: 'system',
      text: t('find.hits', {
        count: hits.length,
        query: query === '' ? '' : `「${query}」`,
        where,
      }),
    }))
    this.revealRow(hit)
  }

  private runFindCommand(arg: string): void {
    const parsed = parseFindQuery(arg)
    const label = parsed.category === undefined ? '' : `${cardCategoryLabel(parsed.category)} `
    // Local `/find` is a workspace search: it looks at what is in the view, which is
    // what a reader means by "find it here". Content `/clear` hid is not part of it —
    // searching the durable log is the historical-search Screen's job (AD-9), which
    // this round does not build.
    const hits = matchTranscriptRows([...this.visibleRows()], arg)
    // The step message says "回复 deploy"; the highlight must look for "deploy".
    this.searchNeedle = parsed.category === undefined ? arg.trim() : parsed.query
    this.applySearchHits(`${label}${parsed.query}`.trim(), hits)
  }

  private stepSearch(delta: number): void {
    if (this.searchHits.length === 0) {
      this.pushRow(represent('find-feedback', { kind: 'system', text: t('find.empty') }))
      this.markDirty()
      return
    }
    const count = this.searchHits.length
    this.searchIndex = (this.searchIndex + delta + count) % count
    const hit = this.searchHits[this.searchIndex]
    const where = hit === undefined ? '' : cardCategoryLabel(cardCategoryOf(hit) ?? 'reply')
    this.pushRow(represent('find-feedback', {
      kind: 'system',
      text: t('find.step', {
        query: this.searchQuery,
        index: this.searchIndex + 1,
        total: count,
        where,
      }),
    }))
    this.revealRow(hit)
  }

  private paint = (): void => {
    if (this.exiting || this.lineMode) return
    // Nothing is drawn while the durable log is still being read (B2.4).
    //
    // Replay is chunked and yields, so the cadence timer can compose frames
    // *between* chunks — each one anchored to a session that is still growing. The
    // reader then watches the transcript roll from wherever the first frame landed
    // down to the bottom: measured on a 20k-event log at a local cadence, 51 frames
    // over 1.2 s, the window creeping `回答 3775 → … → 19976`. "A resume starts
    // somewhere in the middle and scrolls to the end" is that, and the fix is to
    // compose nothing until there is a whole session to compose: `replayHistory`
    // ends with `dirty = true`, so the first frame after it is the landing.
    //
    // The flag is the *load*, not `replaying`: that one also means "this event came
    // from the log rather than from the live host", and it stays true for events a
    // resumed process interacts with afterwards — a frame must still be paintable
    // then.
    if (this.loadingHistory) return
    // The screen entry a relay asked for while the log was still being read
    // (`attachRelayDisplay`). Written here, immediately before the frame, so the
    // alternate screen is cleared and repainted in one tick: the reader never
    // sees the splash's line disappear into an empty window.
    if (this.screenEntryPending) {
      this.screenEntryPending = false
      this.write(this.enterScreenSequence())
    }
    const width = Math.max(10, this.screenColumns())
    const height = Math.max(6, this.screenRows())
    // One clock reading per frame, kept because the resize pacing is the only
    // thing that has to know how expensive a frame is on *this* session: a short
    // transcript repaints in a few milliseconds and a long one in a hundred, and
    // a fixed rate would either throttle the first or starve the loop on the
    // second.
    const startedAt = Date.now()
    try {
      this.paintFrame(width, height)
    } finally {
      this.lastPaintCostMs = Date.now() - startedAt
    }
  }

  /**
   * The dock line for a terminal with no room for the card.
   *
   * `compact` keeps the current step (the one thing a reader acts on) and `minimal`
   * keeps only the mode and the progress. Both stay one row: the dock is under height
   * pressure precisely because the workspace is small, and a second row would come out
   * of the transcript.
   */
  private planDockCompactLine(plan: Extract<Row, { kind: 'plan' }>, minimal: boolean): string {
    const counts = todoProgressLabel(plan.todos)
    const mode = plan.pending ? t('plan.switching')
      : plan.active ? t('footer.planMode')
      : t('card.plan')
    // Every level of the dock leads with the same marker, so "the dock is on screen"
    // is one shape to look for however small the terminal is.
    const head = `▾ ${mode}`
    if (minimal) return `${head} · ${counts === '' ? t('plan.noTasks') : counts}`
    const current = plan.todos.find(item => item.status === 'in_progress')?.content
      ?? plan.todos.find(item => item.status !== 'completed')?.content
    const progress = counts === '' ? t('plan.noTasks') : counts
    return current === undefined
      ? `${head} · ${progress}`
      : `${head} · ${progress} · › ${current.replace(/\s+/gu, ' ').trim()}`
  }

  /**
   * The runtime facts the footer and a Screen's compact strip both report.
   *
   * One derivation, two readers. The Screen strip could have read `this.*` for
   * itself, but then a new activity kind would have to be taught to two assemblers
   * and the two surfaces could disagree about whether the agent is running — the
   * second truth source the decision record forbids (AD-8). The two parameters are
   * the composer's *shape*, the one input that is a property of the frame rather
   * than of the session; the strip does not read them.
   */
  private footerFacts(inputView: InputView, inputRows: number): {
    input: FooterStatusInput
    activity: { kind: FooterActivityKind; text: string }
    activityStartedAt: number | undefined
    provider: string
    quotaWindow: QuotaWindow | undefined
  } {
    const idleMs = Date.now() - this.lastActivity
    const livePlan = this.findLivePlanRow()
    const liveGoal = this.rows.findLast((row): row is Extract<Row, { kind: 'goal' }> => row.kind === 'goal')
    const current = this.selectionRef?.current
    const provider = this.currentProviderId()
    // The footer shows the finest window the provider reports (5-hour first),
    // not the tightest percent: that is the number a working session hits first.
    const quotaWindow = this.quotaSnapshot === undefined ? undefined : preferredQuotaWindow(this.quotaSnapshot)
    const balanceText = this.balanceSnapshot !== undefined && this.balanceSnapshot.provider === provider
      ? formatFooterBalance(this.balanceSnapshot)
      : undefined
    const planBadge = planRouteBadge(
      provider,
      this.quotaSnapshot?.provider === provider ? this.quotaSnapshot : undefined,
    )
    // The status row reads what the *keyboard owner* means, not what shape it has:
    // `/model` and `ask_user_question` are both `questions` dialogs, and reading the
    // shape made a picker claim the agent was waiting while an approval — a
    // `confirm` — read as idle. A question the Session still holds but nobody is
    // blocked on (a `continued` one) is a record, not a wait.
    const ask = this.dialogRole.kind === 'interaction' ? this.dialogRole.ask : undefined
    const waitingQuestion = ask === 'question' || this.queuedQuestions > 0
    const planReview = ask === 'plan-review'
    const waitingApproval = ask === 'approval'
    const compacting = this.compactionRunning()
    const parentModel = current?.model ?? this.agent.options.model ?? ''
    const activityToolLabel = this.activityToolLabel()
    const sub = this.subagentSelection.current
    const activityStartedAt = this.footerActivityStartedAt({
      compacting,
      waitingQuestions: waitingQuestion || planReview,
      streaming: this.streaming !== undefined,
    })
    const footer = {
      running: this.agent.status === 'running',
      planReview,
      waitingQuestion,
      waitingApproval,
      compacting,
      ...(this.llmRetry === undefined ? {} : { retry: this.llmRetry }),
      subagents: this.activeSubagents.size,
      tools: this.openToolCalls.size,
      ...(activityToolLabel === undefined ? {} : { toolLabel: activityToolLabel }),
      planLeftOpen: livePlan?.turnLeftOpen === true,
      planPending: livePlan?.pending === true,
      planActive: livePlan?.active === true,
      ...(liveGoal?.phase === 'active' || liveGoal?.phase === 'paused' || liveGoal?.phase === 'blocked'
        ? { goalPhase: liveGoal.phase }
        : {}),
      idleMs,
      ...(this.streaming === undefined
        ? {}
        : {
          streamingReasoning: this.streaming.reasoning !== '',
          streamingText: this.streaming.text !== '',
        }),
      ...(activityStartedAt === undefined ? {} : { activityStartedAt }),
      model: parentModel,
      preset: this.presetName,
      ...(current?.reasoningEffort === undefined ? {} : { effort: current.reasoningEffort }),
      provider,
      parentModel,
      subModel: sub.model,
      ...(sub.provider === undefined ? {} : { subProvider: this.displayProviderId(sub.provider) }),
      ...(sub.reasoningEffort === undefined ? {} : { subEffort: String(sub.reasoningEffort) }),
      // Quota and context pressure stay on the identity line, where they have
      // always been: B-1 moved them one row up into the strip, and a user
      // looking at a wide terminal read that as "额度条没了". The strip keeps
      // the loss order for the groups it does own.
      ...(quotaWindow === undefined || this.quotaSnapshot === undefined || this.quotaSnapshot.provider !== provider
        // No reading for this provider: show the empty bar with a `?` rather
        // than a number nobody measured. A balance-only provider (DeepSeek)
        // shows nothing here; its balance line is the reading.
        ? (this.hasQuotaSurface(provider) ? { quotaUnknown: true } : {})
        : {
          quotaCode: shortQuotaPlanName(this.quotaSnapshot),
          quotaPercent: quotaWindow.remainingPercent,
          quotaPeriod: quotaWindow.period,
        }),
      ...(this.contextPressure === undefined
        ? {}
        : { contextChip: formatContextPressureChip(this.contextPressure, false) }),

      ...(balanceText === undefined ? {} : { balanceText }),
      // The subscription badge is about the *route*, not about a reading: it is
      // there from the first frame, and the tier sharpens once billing answers.
      ...(planBadge === undefined ? {} : { planBadge }),
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
    return { input: footer, activity, activityStartedAt, provider, quotaWindow }
  }

  private paintFrame(width: number, height: number): void {
    // One gate for the whole channel: a Screen replaces the workspace, so the
    // frame below is not composed at all while one is up. It used to be spelled
    // `dialog?.kind === 'inspect'` and appeared in ten places.
    if (this.screen !== undefined) {
      this.paintScreen(width, height)
      return
    }

    const display: string[] = []
    const displayRefs: (Row | CollapsibleBlock | undefined)[] = []
    // Cells at the start of each painted line that are chrome rather than text.
    // Only the focus marker has any, and the drag-selection needs to know how
    // many so a copy off the selected row does not paste the marker.
    const displayGutters: number[] = []
    const searchHit = this.searchHits[this.searchIndex]
    const addDisplay = (
      line: string,
      ref?: Row | CollapsibleBlock,
      gutter = 0,
    ): void => {
      display.push(clipAnsiToWidth(line, width))
      displayRefs.push(ref)
      displayGutters.push(gutter)
    }
    const pushRow = (kind: DisplayKind, text: string, ref?: Row): void => {
      if (kind === 'assistant') {
        const focused = ref !== undefined && this.focusedRow === ref
        // The same string the card headers use, so the ASCII fallback rewrites
        // both alike, and the width comes from it rather than from a constant
        // (in ASCII `▶` becomes `> `, and the marker is still three cells).
        const marker = sanitizeTerminalText(REPLY_FOCUS_MARKER)
        const gutter = displayWidth(marker)
        // A focused reply is rendered three cells narrower so the marker cannot
        // eat its last characters: painted at full width and then prefixed, the
        // tail of every one of its lines was clipped away silently (the card
        // headers avoid this by truncating to the same kind of margin).
        const inner = focused ? Math.max(1, width - gutter) : width
        let placed = false
        for (const line of renderMarkdownLines(text, inner, this.color, this.terminalCaps.osc8)) {
          // The marker goes on the first line that has something on it: a reply
          // starting with a blank line would otherwise carry a marker all by
          // itself, with the reader's selection nowhere near its text.
          if (focused && !placed && stripAnsi(line).trim() !== '') {
            addDisplay(`${marker}${line}`, ref, gutter)
            placed = true
            continue
          }
          addDisplay(line, ref)
        }
        return
      }
      for (const line of wrap(text, width)) {
        addDisplay(this.styleLine(kind, line), ref)
      }
    }

    const compact = this.isCompactView()
    // Everything below reads the *visible* rows: a row `/clear` hid is not part of the
    // view, and letting one leak back in through a helper that walks `this.rows` would
    // be the same bug in a new place.
    const visibleRowList = this.visibleRows()
    const compactBursts = compact ? compactToolBursts(visibleRowList) : []
    const compactBurstByReply = new Map<Extract<Row, { kind: 'assistant' }>, (typeof compactBursts)[number]>()
    for (const burst of compactBursts) {
      if (burst.after !== undefined) compactBurstByReply.set(burst.after, burst)
    }

    const skipMiddle = this.paintTailBudget > 0 && this.scrollOffset === 0 && this.pendingReveal === undefined
      && this.rows.length > this.paintTailBudget + 8
    const historyStart = skipMiddle ? Math.max(0, this.rows.length - this.paintTailBudget) : 0
    let paintedLeadingCompact = skipMiddle
    // Per-row render cache. A row whose fingerprint is unchanged replays its
    // lines instead of re-rendering them, which is what turns a frame from
    // "parse every markdown block in the transcript" into "parse the one that
    // changed". The base key covers the state every row reads (width, view mode,
    // focus, search, theme, ascii fallback); the row key covers its own fields.
    const displayBase = this.displayBaseKey(width)
    // The row body has several `continue`s, so its cache entry is written when the
    // *next* row starts (and once after the loop) rather than at every exit.
    let pendingFinish: (() => void) | undefined
    const flushPending = (): void => {
      const finish = pendingFinish
      pendingFinish = undefined
      finish?.()
    }
    // Two of the row body's inputs come from *other* rows: whether this is still
    // in the "leading" stretch of a compact view (which flips once an assistant
    // or user row has been painted) and whether the row is folded into a tool
    // burst rendered by the reply above it. Leaving them out of the cache key is
    // what put a second copy of a running card on screen — the stale entry
    // replayed lines for a row that now renders inside its reply's burst.
    let leadingPhase = skipMiddle
    // One tick per frame, shared by every live row: coarse enough not to churn a
    // key mid-frame, fine enough that a spinner or an elapsed time moves.
    const liveTick = Math.floor(Date.now() / 200)
    for (let rowIndex = 0; rowIndex < visibleRowList.length; rowIndex += 1) {
      flushPending()
      const cachedRow = visibleRowList[rowIndex]
      const inBurst = compact && cachedRow !== undefined && compactBurstByReply.has(cachedRow as Extract<Row, { kind: 'assistant' }>)
      let cacheKey: string | undefined
      if (cachedRow !== undefined && !skipMiddle) {
        const live = SshTui.isLiveRow(cachedRow)
        // The burst belongs to this row's rendering even though its rows are
        // elsewhere in the transcript, so its content is part of the key.
        const burst = inBurst ? compactBurstByReply.get(cachedRow as Extract<Row, { kind: 'assistant' }>) : undefined
        const leadingBurst = compact && !leadingPhase && (cachedRow.kind === 'assistant' || cachedRow.kind === 'user')
          ? compactBursts.find(candidate => candidate.after === undefined)
          : undefined
        const burstKey = burst === undefined && leadingBurst === undefined
          ? '-'
          : `${burst === undefined ? '' : SshTui.burstKey(burst.groups)}|${leadingBurst === undefined ? '' : SshTui.burstKey(leadingBurst.groups)}`
        cacheKey = `${displayBase}|${rowIndex === 4 ? 'fold' : ''}|${leadingPhase ? 'lead' : '-'}|${live ? `t${liveTick}` : 'settled'}|${burstKey}|${SshTui.rowKey(cachedRow)}`
        const entry = this.displayRowCache.get(cachedRow)
        if (SshTui.rowRendersEqual(cachedRow, entry, cacheKey)) {
          for (const line of entry.lines) display.push(line)
          for (const ref of entry.refs) displayRefs.push(ref as Row | CollapsibleBlock | undefined)
          for (const gutter of entry.gutters) displayGutters.push(gutter)
          // The body flips this flag when it paints an assistant/user row; the
          // replay has to do the same or the next row's key would lie.
          if (compact && (cachedRow.kind === 'assistant' || cachedRow.kind === 'user')) leadingPhase = true
          continue
        }
      }
      const markStart = { line: display.length, ref: displayRefs.length, gutter: displayGutters.length }
      const finishRow = (): void => {
        if (cacheKey === undefined || cachedRow === undefined) return
        this.displayRowCache.set(cachedRow, {
          key: cacheKey,
          lines: display.slice(markStart.line),
          refs: displayRefs.slice(markStart.ref),
          gutters: displayGutters.slice(markStart.gutter),
        })
      }
      pendingFinish = finishRow
      if (skipMiddle && rowIndex >= 4 && rowIndex < historyStart) {
        if (rowIndex === 4) addDisplay(this.styleLine('system', t('history.folded')))
        continue
      }
      const row = visibleRowList[rowIndex]
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
        addDisplay(this.selectLine(styled, focused), row)
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
          ...(row.approval === undefined ? {} : { approval: row.approval }),
          ...(row.diff !== undefined && row.diff.length > 0
            ? { diffStat: countDiffAddDel(row.diff) }
            : {}),
        })
        const headerSegments = this.color ? header.segments : []
        if (!row.expanded) {
          const collapsed = truncateToWidth(header.plain, Math.max(1, width - 2))
          const styled = headerSegments.length === 0
            ? collapsed
            : paintSegmentedLine(collapsed, 0, collapsed.length, headerSegments, this.colorDepth)
          addDisplay(this.selectLine(styled, focused), row)
          continue
        }
        const expandedHeaderLines = headerSegments.length === 0
          ? wrap(header.plain, width)
          : wrapSegmented(header.plain, Math.max(1, width), headerSegments, this.colorDepth)
        for (const wrapped of expandedHeaderLines) {
          // An expanded card is still the card the reader has selected, and it used
          // to be the one state where the highlight vanished: the marker stayed while
          // the row stopped reading as selected, which made the *next* card look like
          // the focused one. The highlight belongs to the card, not to its state.
          addDisplay(this.selectLine(wrapped, focused), row)
        }
        // An expanded card spells the approval out: the chip says the state, and
        // this says how it is known and why. It is the only place a reason a
        // *resume* could not recover is not silently lost.
        if (row.approval !== undefined) {
          addDisplay(this.styleLine('system', `  ${approvalDetailText(row.approval)}`), row)
        }
        // On a measured slow link an expanded body is capped and points at the
        // overlay instead; every other link shows it in full, exactly as it has
        // since the 0.3.9 card pass.
        const bodyLimit = toolBodyLineLimit(linkQualityOf(this.paintLink, this.paintRttMs))
        const body = toolBodyLines(row, Number.MAX_SAFE_INTEGER, width)
        for (const line of body.slice(0, bodyLimit)) {
          this.paintToolBodyLine(addDisplay, row, line, width)
        }
        if (body.length > bodyLimit) {
          addDisplay(this.styleLine('tool-result', truncateToWidth(
            t('tool.bodyMoreLines', { count: body.length - bodyLimit }),
            width,
          )), row)
        }
        continue
      }
      if (row.kind === 'subagent') {
        const running = row.status === 'running'
        const elapsed = Math.max(0, Math.floor(((row.endedAt ?? Date.now()) - row.startedAt) / 1000))
        const elapsedLabel = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`
        const header = buildSubagentHeader({
          focused: this.focusedRow === row,
          title: subagentDisplayName(row),
          status: row.status,
          elapsedLabel,
          summary: subagentChipSummary(row),
          spinner: running ? ` ${this.spinnerFrame()}` : '',
          inspectHint: t('card.inspect'),
          foreign: subagentProviderDiffers(this.currentProviderId(), row.modelProvider),
        })
        const headerSegments = this.color ? header.segments : []
        const collapsed = truncateToWidth(header.plain, Math.max(1, width - 2))
        const styled = headerSegments.length === 0
          ? this.styleLine('subagent-header', collapsed)
          : paintSegmentedLine(collapsed, 0, collapsed.length, headerSegments, this.colorDepth)
        addDisplay(this.selectLine(styled, this.focusedRow === row), row)
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
            for (const line of renderMarkdownLines(row.planMarkdown, Math.max(1, width - 2), this.color, this.terminalCaps.osc8).slice(0, 8)) {
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
        // A settled card carries both halves of the exchange, and the collapsed
        // line is the only one most readers see: the question used to be replaced
        // by its answer the moment it settled, so the card said `预发` and nothing
        // about what was being chosen (B2.4, §4).
        const headline = waiting && row.continued !== true
          ? row.summary
          : `${row.title}${row.status === 'answered' ? ' → ' : ' · '}${row.summary}`
        const header = `● ${title}${spinner} · ${state} · ${headline}${row.expanded ? '' : t('card.expand')}`
        this.paintCollapsibleHeader(addDisplay, row, waiting ? 'tool' : 'system', header, width)
        if (row.expanded) {
          if (row.header !== undefined) addDisplay(this.styleLine('system', `  ${row.header}`), row)
          for (const wrapped of wrap(row.title, Math.max(1, width - 2))) {
            addDisplay(this.styleLine('assistant', `  ${wrapped}`), row)
          }
          if (row.detail !== undefined && row.detail !== '') {
            if (row.intent === 'plan-review') {
              for (const line of renderMarkdownLines(row.detail, Math.max(1, width - 2), this.color, this.terminalCaps.osc8)) {
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
      if (row.kind === 'changes') {
        const header = `${row.header}${row.expanded ? '' : t('card.expand')}`
        this.paintCollapsibleHeader(addDisplay, row, 'tool', header, width)
        if (row.expanded) {
          for (const file of row.files) {
            addDisplay(this.styleLine('tool-result', `    ${file}`), row)
          }
          if (row.more !== undefined) addDisplay(this.styleLine('system', `    ${row.more}`), row)
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
    // Close the last row's cache entry here, and only here: everything below
    // belongs to no row. Flushing after the live tail instead stored the tail in
    // the last row's entry, so every later frame replayed a copy of the wait card
    // at the elapsed time of the frame that stored it — a "processing" line
    // frozen at 0s next to the live one, and a new copy each time another row
    // became the last one.
    flushPending()

    // The live tail: a projection of runtime state, kept **out of the transcript's
    // source lines** on purpose (B2.2, AD-12). It used to be appended to `display`,
    // which made every tick a transcript append: one more source line, a window that
    // started one line later, and `sizeChanged` behind it — a full clear per tick.
    // Measured before this change: 20 rows / ~2.9-3.2 KB **per streaming tick**, the
    // screen cleared each time. These lines paint over the bottom of the window
    // instead, so the anchor, `scrollOffset` and the row cache never see them.
    const runtimeTail = this.runtimeTailLines(width)
    // The compact view folds a turn's tool cards into the running burst, which
    // belongs between the streamed text and the wait card (where the transcript
    // paints it for a settled reply). Spliced rather than rebuilt here, because
    // the burst reads state (`paintedLeadingCompact`) the row loop above decides.
    const compactTail: string[] = []
    if (compact) {
      const lastAssistant = this.rows.findLast((row): row is Extract<Row, { kind: 'assistant' }> => row.kind === 'assistant')
      if (this.streaming !== undefined) {
        const openBurst = compactBursts.find(burst => burst.after === lastAssistant)
        if (openBurst !== undefined) this.paintCompactBurst((line) => { compactTail.push(line) }, openBurst.groups, width)
      }
      const leading = compactBursts.find(burst => burst.after === undefined)
      if (leading !== undefined && !paintedLeadingCompact) {
        this.paintCompactBurst(addDisplay, leading.groups, width)
      }
    }
    const liveTail = [
      ...runtimeTail.lines.slice(0, runtimeTail.waitStart),
      ...compactTail,
      ...runtimeTail.lines.slice(runtimeTail.waitStart),
    ]

    const dialogLines: string[] = []
    // Recomputed every frame: the anchor is a property of this frame's drawing,
    // not of the dialog's life. A confirmation has no list, so its own prompt is
    // the row that stays visible.
    this.dialogFocusLine = undefined
    const addDialog = (text: string): void => {
      for (const wrapped of wrap(text, Math.max(1, width))) {
        dialogLines.push(this.styleLine('system', wrapped))
      }
    }
    if (this.dialog !== undefined) {
      if (this.dialog.kind === 'confirm') {
        this.dialogFocusLine = dialogLines.length
        addDialog(this.dialog.prompt)
        addDialog(`  ${this.dialog.hint}`)
      } else if (this.dialog.kind === 'questions') {
        // The `inspect` case can no longer reach here (it is a Screen, and the
        // frame returned above), so the branch states what it needs instead of
        // relying on a gate three hundred lines away to have narrowed it.
        const d = this.dialog
        const review = planReviewOf(d.question)
        if (review) {
          addDialog(t('dialog.planReview', { index: d.index + 1, total: d.total }) + (d.question.header === undefined ? '' : ` · ${d.question.header}`))
          addDialog(d.question.question)
          if (d.question.detail !== undefined && d.question.detail !== '') {
            for (const line of renderMarkdownLines(d.question.detail, Math.max(1, width - 2), this.color, this.terminalCaps.osc8).slice(0, 16)) {
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
        if (d.filtering === true || (d.filter ?? '') !== '') {
          addDialog(`  ${t('dialog.filterLabel', { query: d.filter ?? '' })}`)
        }
        // Only the options the filter left are listed. The hotkey stays the
        // option's own number in the full list, so it does not move under the
        // user's fingers as the filter narrows.
        const visibleIndexes = visibleQuestionIndexes(d)
        const cursorAt = Math.max(0, visibleIndexes.indexOf(d.cursor))
        const start = pickerWindowStart(cursorAt, visibleIndexes.length)
        const end = Math.min(visibleIndexes.length, start + PICKER_WINDOW)
        if (start > 0) addDialog(`  ${t('picker.moreAbove', { count: start })}`)
        for (let at = start; at < end; at += 1) {
          const index = visibleIndexes[at]
          if (index === undefined) continue
          const option = options[index]
          if (option === undefined) continue
          // `●` follows the cursor: it is the row Enter submits. Ticked rows in a
          // multi-select list show `✓` so both facts stay visible at once.
          const marker = questionOptionMarker(d, index)
          const key = QUESTION_OPTION_KEYS[index] ?? '↕'
          const focused = index === d.cursor ? '›' : ' '
          const recommended = option.label === approve ? t('dialog.recommended') : ''
          const extra = option.description === undefined ? '' : ` — ${option.description}`
          // Where the highlighted row lands: the interaction layer windows itself
          // around this line when the terminal cannot show the whole list, so the
          // option Enter would submit is always one of the visible ones.
          if (index === d.cursor) this.dialogFocusLine = dialogLines.length
          addDialog(` ${focused}${key} ${marker} ${option.label}${recommended}${extra}`)
        }
        if (end < visibleIndexes.length) {
          addDialog(`  ${t('picker.moreBelow', { count: visibleIndexes.length - end })}`)
        }
        if (options.length === 0) {
          addDialog(t('dialog.freeform'))
        }
        if (d.filtering === true) {
          addDialog(t('dialog.filterHint'))
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
      suggestionLines.push(index === this.suggestionIndex
        ? this.selectLine(fitLine(line), true)
        : this.styleLine('system', fitLine(line)))
    }
    if (suggestionEnd < this.commandSuggestions.length) {
      suggestionLines.push(this.styleLine(
        'system',
        fitLine(`  ${t('suggest.moreBelow', { count: this.commandSuggestions.length - suggestionEnd })}`),
      ))
    }

    const promptPlain = this.color ? '❯ ' : '> '
    const prompt = this.color
      ? `\x1b[${themeExtraToken(this.theme, 'accent')}m${promptPlain.trimEnd()}\x1b[0m `
      : promptPlain
    const promptWidth = displayWidth(promptPlain)
    // The workspace composer is never masked: the wizard's secret field is the setup
    // Screen's own row, and it masks there (B2.6 §4).
    const masked = false
    const inputTextWidth = Math.max(1, width - promptWidth)
    // The row draws whichever field owns the keyboard: a surface that borrowed
    // text shows its own (so the caret and the content stay that surface's), and
    // otherwise it is the composer's draft. The geometry is the same row either
    // way — this is ownership, not layout.
    const fieldText = this.fieldText()
    const fieldCursor = this.fieldCursor()
    const fieldFolded = this.borrowedText === undefined && this.inputFolded
    const inputView: InputView = masked
      ? { text: '•'.repeat(fieldText.length), cursorOffset: displayWidth('•'.repeat(fieldCursor)), folded: false }
      : fieldFolded
        ? foldInputView(fieldText, fieldCursor, inputTextWidth)
        : { text: fieldText, cursorOffset: displayWidth(fieldText.slice(0, fieldCursor)), folded: false }
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

    // Time-based feedback is judged here, once per frame, so the footer and the strip
    // cannot disagree about whether it is still current.
    this.expireFeedback()
    const yieldPlanDock = this.dialog !== undefined || suggestionLines.length > 0
    // The workspace: every row between the header and the composer's boundary. The
    // three things that compete for it, in the order they win: the interaction
    // surface (painted over the transcript, never over the other two), the active
    // plan dock (reserved, above the composer), and the live region. History gets
    // what is left, and never less than `MIN_TRANSCRIPT_ROWS`.
    const space = Math.max(0, height - headerLines.length - RESERVED_BOTTOM_LINES - (inputRows - 1) - suggestionLines.length - 1)
    // The dock yields first when the terminal is short — it is the card the reader
    // opened, but a plan that eats the workspace hides the history it is about —
    // and it is capped by half of it. An uncapped dock was worse than crowded: it
    // pushed the input box, the footer *and the caret* off the bottom of the screen,
    // and the caret is where a terminal draws an IME's pre-edit, so a reader typing
    // Chinese watched the composing text land on the plan card's own first line.
    const dockBudget = Math.max(1, Math.floor(space / 2))
    const planDockLines = this.shouldDockPlan()
      ? this.paintPlanDock(width, yieldPlanDock, dockBudget)
      : []
    // The composer's own top edge, and the only row that says where the reader's
    // history ends and the keyboard begins. It is drawn as the input box's corner
    // rather than as one more full-width rule, so it cannot be mistaken for the
    // banner's separator — and every transient surface stops above it (B1.2).
    const inputBoundary = this.styleLine('system', `╭${repeatToWidth('─', Math.max(0, width - 1))}`)
    // A transient surface is composed *over* the transcript, not into its budget:
    // it may cover rows the reader can see, but it must not change which rows the
    // window holds. That is true of a task interaction and of a control-plane
    // picker alike (B1.2) — they differ in what they mean, not in what they own.
    // A Surface is composed *over* the workspace, never into its budget (B1.2).
    // The old `dedicated` rank (an inspect overlay, the onboarding wizard) took its
    // rows *out* of the window instead; B2.6 gave both a Screen, so there is no
    // third case left here and every composed surface is a layer.
    const layerLines = dialogLines
    const contentBudget = Math.max(0, space - planDockLines.length)
    // The live region is a *region*, not an overlay (B2.2's tail, corrected): it
    // takes rows of its own between the transcript and the plan dock instead of
    // painting over whatever happened to be at the bottom of the window. Painting
    // over split a card mid-body with no boundary, which is what "the tool card's
    // content is inside the processing card" was: the reader saw a card's last
    // lines run straight into the thinking/wait lines below them, and a click on a
    // row the tail covered was refused because the ref map was cleared for it. A
    // reader who is scrolled back keeps their history and sees no tail at all.
    const tailRows = this.scrollOffset === 0 && liveTail.length > 0 && contentBudget > 0
      // One row is the floor even on a terminal with no room to spare: the live
      // region is what says the session is working, and a terminal that can show
      // one transcript row can show that too. It is still clipped from its front.
      ? Math.min(liveTail.length, Math.max(1, contentBudget - MIN_TRANSCRIPT_ROWS))
      : 0
    const available = Math.max(0, contentBudget - tailRows)
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
    // `padding` blank rows are unshifted when the transcript is shorter than the
    // window, so the gutter of a visible line is read off the same offset the
    // window itself used (negative before the transcript starts → 0).
    const visibleGutters = visible.map((_, index) => displayGutters[start + index - window.padding] ?? 0)
    this.clickableRows.clear()
    this.paintedLinkHitsByRow.clear()
    this.transcriptTopScreenY = headerLines.length + 1
    // Kept as painted and stripped only when a drag actually happens: this
    // runs on every frame, and a mouse event is rare next to a repaint.
    this.selectableLines = visible.map((line, index) => ({
      raw: line,
      ref: visibleRefs[index],
      // Only a model reply is freely copyable; a tool card, a notice or the
      // chrome keeps its click behavior instead.
      copyable: (visibleRefs[index] as { kind?: string } | undefined)?.kind === 'assistant',
      gutter: visibleGutters[index] ?? 0,
    }))
    for (let index = 0; index < visibleRefs.length; index++) {
      const ref = visibleRefs[index]
      const screenY = headerLines.length + index + 1
      if (ref !== undefined && 'expanded' in ref) this.clickableRows.set(screenY, ref)
      const hits = paintedLinkHits(visible[index] ?? '')
      if (hits.length > 0) this.paintedLinkHitsByRow.set(screenY, hits)
    }
    const visibleWithSearch = this.highlightSearchLines(visible, visibleRefs)
    const visibleWithSelection = this.mouseSelection === undefined
      ? visibleWithSearch
      : this.highlightSelection(visibleWithSearch)
    const dockPlan = this.findLivePlanRow()
    if (dockPlan !== undefined && planDockLines.length > 0) {
      const dockTop = headerLines.length + visible.length + 1
      this.clickableRows.set(dockTop, dockPlan)
    }

    const facts = this.footerFacts(inputView, inputRows)
    const footer = facts.input
    const activity = facts.activity
    const activityStartedAt = facts.activityStartedAt
    const provider = facts.provider
    const quotaWindow = facts.quotaWindow
    // The second row is workspace/runtime metadata only. The activity and its
    // clock are row one's job now (and repeating them here was the first thing
    // the new layout showed), the provider/model/effort are painted permanently
    // in the header, and `sub:` stays because a child route is a *different*
    // identity from the parent's.
    const identity = footerIdentityParts(footer, { omitModel: true })
    // The ephemeral notice (a failed command, an operational warning) takes the
    // identity row for as long as it lives. That row is always on screen, costs no
    // geometry, and — unlike covering a transcript row — hides nothing the reader was
    // reading: a notice must not be the reason a reply is invisible. The telemetry row
    // above keeps the echo chip, so an acknowledgement is never hidden by a warning.

    // The default row: link health, what is happening, tokens per second, quota
    // and context capacity, session total — in that order, losing the least
    // load-bearing cell first as the terminal narrows. The install health chip
    // (⚠) still leads the row when the profile is missing rows: it is the only
    // group that reports a broken install, and its priority predates this pass.
    const health = footerHealthChip(this.rosterMissing, this.color, this.settingsGeneration === 'forms' ? 'agent-plane' : 'roster')
    const total = sessionTokenTotal(this.statsTracker.snapshot().usage)
    // The chip is painted only for a total the harness itself published. A total
    // this plugin had to assemble from the billed parts is a *different*
    // accounting — provider by provider, `inputTokens` may or may not already
    // include the cache counters — and two numbers that mean different things must
    // not look alike. `/status` prints both, labelled.
    const sessionTotal = total?.basis === 'harness' ? total.tokens : undefined
    const stripInput: FooterStripInput = {
      link: {
        kind: this.paintLink,
        intervalMs: this.paintIntervalMs,
        probed: this.paintProbed,
        ...(this.paintRttMs === undefined ? {} : { rttMs: this.paintRttMs }),
      },
      activity: {
        kind: activity.kind,
        text: activity.text,
        ...(activityStartedAt === undefined ? {} : { startedAt: activityStartedAt }),
        now: Date.now(),
      },
      throughput: this.statsTracker.throughput(),
      running: this.agent.status === 'running',
      ...(quotaWindow === undefined || this.quotaSnapshot === undefined || this.quotaSnapshot.provider !== provider
        // No reading for this provider: the empty bar with `?` rather than a
        // number nobody measured. A balance-only provider (DeepSeek) shows
        // nothing here; its balance line is the reading.
        ? (this.hasQuotaSurface(provider) ? { quota: {} } : {})
        : { quota: { remainingPercent: quotaWindow.remainingPercent, period: quotaWindow.period } }),
      ...(this.contextPressure === undefined ? {} : { context: this.contextPressure }),
      ...(sessionTotal === undefined ? {} : { totalTokens: sessionTotal }),
      // The install warning is a chip on this row, not a strip fitted around it:
      // one width convergence path for the whole line (see the budget module).
      ...(health === undefined ? {} : { warning: { long: health.long, short: health.short } }),
      depth: this.colorDepth,
      color: this.color,
      ...(this.footerEcho === undefined ? {} : { echo: this.footerEcho.text }),
    }
    const stripText = runtimeStrip(stripInput, Math.max(1, width), this.mutedSeparator(), this.spinnerFrame())
    // The acknowledgement the strip could not fit.
    //
    // The echo chip is the lowest-priority group on the stats row, which is exactly
    // the state a working session is in — so a command's confirmation was dropped
    // entirely and the reader saw *no* feedback at all (B2.5, reported). The chip is
    // still where it goes first; when it did not survive, the row that always fits
    // says it instead. One message, one place, no extra rows.
    const missingEcho = this.notice === undefined
      && this.footerEcho !== undefined
      && !stripText.includes(this.footerEcho.text)
      ? this.footerEcho.text
      : undefined
    // The row is one muted run with the accents spliced in at higher intensity;
    // `muteFooterLine` reopens the mute after every reset so the (already
    // coloured) pips and meters cannot bleed into the text around them.
    const statsLine = clipAnsiToWidth(this.muteFooterLine(stripText), Math.max(1, width))
    this.healthChipRow = undefined

    // The identity row is composed *after* the strip, because whether it needs to
    // carry the echo depends on what the strip managed to fit (see below).
    const statusText = this.notice !== undefined
      ? truncateToWidth(this.notice.text, Math.max(1, width))
      : missingEcho === undefined
        ? fitFooterStatusLine('', identity, Math.max(1, width))
        : truncateToWidth(missingEcho, Math.max(1, width))
    // Accents on an otherwise muted line: the `sub:` chip. Each reset reopens
    // mute, the same way the pre-strip footer did. `styleLine` sanitises first,
    // so the accent is spliced in after.
    let statusLine = this.styleLine('system', statusText)
    if (this.color && this.notice === undefined) {
      // The chip is only accented when it survived the fit: a `sub:` route the
      // row could not afford is not on the line, and `paintFooterSubagentChip`
      // returns the line unchanged when it cannot find its text.
      const chip = identity.find(text => text.startsWith('sub:')) ?? ''
      statusLine = paintFooterSubagentChip(
        statusLine,
        chip,
        footerSubagentForeign(footer),
        this.mutedSgr() || themeToken(this.theme, 'system'),
        this.colorDepth,
      )
    }

    // The live region is clipped from its own front when it is taller than the
    // room it has: a reply being written is read from its end. Its first line is
    // the live thinking card's header, which survives the clip — without it the
    // region has nothing that says what it is, and a reader who expanded that card
    // could not see the marker that says so.
    const tailStart = liveTail.length - tailRows
    const visibleTail = tailRows === 0 ? [] : liveTail.slice(tailStart)
    if (tailRows > 0 && tailStart > 0 && runtimeTail.thinkingRows > 0) visibleTail[0] = liveTail[0] ?? ''
    const tailTop = tailRows === 0 ? undefined : headerLines.length + visible.length
    const tailRefs: (CollapsibleBlock | undefined)[] = visibleTail.map((_, index) => {
      const block = this.streamingReasoning
      if (runtimeTail.thinkingRows === 0 || block === undefined) return undefined
      if (index === 0 && tailStart > 0) return block
      return tailStart + index < runtimeTail.thinkingRows ? block : undefined
    })
    const paintRows: string[] = [
      ...headerLines,
      ...visibleWithSelection,
      ...visibleTail,
      ...planDockLines,
      inputBoundary,
      ...suggestionLines,
      ...inputDisplayLines,
      `${statsLine}\x1b[0m`,
      `${statusLine}\x1b[0m`,
    ]

    this.liveTailRegion = tailTop === undefined ? undefined : { top: tailTop + 1, rows: tailRows }

    // The layer takes the rows immediately above the composer's boundary and
    // *replaces* whatever the base frame put there. The transcript window above it
    // is untouched: the window was computed without knowing the surface exists, so
    // its anchor, its scroll offset and its source rows are the same with or
    // without it — for a picker exactly as for a question.
    const dividerIndex = headerLines.length + visibleWithSelection.length + tailRows + planDockLines.length
    const interactionCap = layerLines.length === 0 ? 0 : dividerIndex
    const interaction = windowInteractionLines(layerLines, interactionCap, this.dialogFocusLine)
    const interactionTop = interaction.lines.length === 0 ? undefined : dividerIndex - interaction.lines.length
    if (interactionTop !== undefined) {
      for (const [offset, line] of interaction.lines.entries()) {
        paintRows[interactionTop + offset] = line
      }
    }
    this.interactionRegion = interactionTop === undefined
      ? undefined
      : { top: interactionTop + 1, rows: interaction.lines.length }

    // Whatever covers rows — the live tail, the transient layer, or both — makes
    // those rows non-targets: nothing behind them may stay clickable or hold a
    // painted link, or a click would open a card nobody can see. The mouse handlers
    // already stand down while a surface owns the keyboard; clearing the maps keeps
    // the *data* honest too, which is what stops a later change from reintroducing
    // click-through by forgetting.
    const coveredFrom = Math.min(
      interactionTop === undefined ? Number.POSITIVE_INFINITY : interactionTop + 1,
      tailTop === undefined ? Number.POSITIVE_INFINITY : tailTop + 1,
    )
    if (Number.isFinite(coveredFrom)) {
      for (const key of [...this.clickableRows.keys()]) {
        if (key >= coveredFrom) this.clickableRows.delete(key)
      }
      for (const key of [...this.paintedLinkHitsByRow.keys()]) {
        if (key >= coveredFrom) this.paintedLinkHitsByRow.delete(key)
      }
    }
    // Registered *after* that sweep, because the live region is exactly where the
    // sweep stops. The live thinking card is a card like any other: the reader
    // expands and folds it with a click, which is how they reach a card at all —
    // the keyboard paths (empty-input ↑ then Enter, Ctrl+R) were the only ones that
    // worked, which is why "the thinking card cannot be expanded" survived the
    // state fix: the card was clickable nowhere.
    if (tailTop !== undefined) {
      for (const [index, ref] of tailRefs.entries()) {
        if (ref !== undefined) this.clickableRows.set(tailTop + index + 1, ref)
      }
    }

    if (health !== undefined) this.healthChipRow = paintRows.length - 1
    // Bottom chrome is force-repainted whenever its state changes while the
    // agent is working; this clears any stale cell left behind by a previous
    // frame even when the row strings happen to be identical. The interaction
    // belongs to that chrome: a selection move repaints from the interaction's
    // own top, not from the top of the frame.
    const baseChromeStart = Math.max(0, paintRows.length - inputRows - suggestionLines.length - planDockLines.length - 3)
    // The live region is *not* part of the force-repainted chrome, even though it
    // changes on every tick: its rows are compared against the rows that were
    // actually painted last frame, and a row whose string is unchanged is already
    // correct on screen. Forcing them made every streaming tick rewrite the whole
    // region (measured: ~1.3 KB a tick at 100×20) for rows that had not moved.
    //
    // The composer rows are excluded for a different reason, and it is not about
    // bytes: the caret lives there, and a terminal draws an IME's composition *at
    // the caret* rather than into the buffer. Rewriting the row erases whatever is
    // being composed — Windows Terminal redraws it immediately, which is the
    // pre-edit characters flickering over the row above the composer while a turn
    // runs. The forced repaint therefore starts *below* the input block: the
    // footer rows keep the stale-cell protection it exists for (a wide glyph the
    // width table under-counted), and a composer row is written only when its own
    // text changed.
    const composerEnd = headerLines.length + visible.length + tailRows + planDockLines.length
      + 1 + suggestionLines.length + inputRows
    const chromeStart = Math.max(
      Math.min(
        baseChromeStart,
        interactionTop === undefined ? Number.POSITIVE_INFINITY : interactionTop,
      ),
      composerEnd,
    )
    const chromeKey = [
      this.status,
      this.agent.status,
      this.scrollOffset,
      statsLine,
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
      this.dialog !== undefined && this.dialog.kind === 'questions' ? String(this.dialog.cursor) : '',
      interaction.lines.join('\n'),
      liveTail.join('\n'),
      this.notice?.text ?? '',
      this.dialogRole.kind,
      planDockLines.join('\n'),
      String(chromeStart),
    ].join('\x1f')
    const chromeChanged = chromeKey !== this.lastChromeKey || chromeStart !== this.lastChromeStart
    const transcriptScrolled = start !== this.lastTranscriptStart
    // A window that moved is not a terminal that changed size. Both dirty every
    // row, but only the size change needs `ESC[2J`: the terminal reflowed its own
    // content there, while a scroll shift is this frame's own doing and the rows
    // it repaints cover it. The live region's height moves the window (it takes
    // rows of its own now), so a clear here would be a full repaint every time a
    // streamed line lands — the cost B2.2 removed from the *source* and which
    // would otherwise come straight back through the geometry.
    const sizeChanged = this.forceFullPaint
      || width !== this.lastPaintWidth
      || height !== this.lastPaintHeight
    this.forceFullPaint = false

    // One stdout write per frame: dirty rows only, so jump-host SSH sees a
    // single packet instead of one write per line. Clip/pad so leftover
    // wide glyphs cannot wrap into the input box. The frame is bounded by the
    // link's byte budget: the tail goes first and rows that do not fit stay
    // dirty for the next tick (tracked through `paintResume`), so a big repaint
    // arrives in a few ordered pieces instead of one long freeze.
    const inputTopRow = visible.length + tailRows + planDockLines.length + suggestionLines.length + headerLines.length + 2
    const row = Math.min(height, inputTopRow + cursorRowOffset)
    // A frame in the middle of a drag: the reader folded the transcript already
    // (`resizeTailNarrowed`), so this frame only has to bring the chrome to the
    // new width. The terminal reflows what it holds, and the frame that closes the
    // drag repaints everything (see `widenPastResizeTail`).
    const chromeOnly = this.resizeTailNarrowed
    const frame = composePaintFrame({
      width,
      height,
      paintRows,
      previousRows: transcriptScrolled && !sizeChanged ? [] : this.lastPaintRows,
      sizeChanged: sizeChanged && !chromeOnly,
      chromeChanged,
      chromeStart,
      previousChromeStart: this.lastChromeStart,
      cursorRow: row,
      cursorColumn: column,
      // A size change starts with a full clear, so splitting it would leave the
      // user looking at a half-empty screen for a frame or two; that one frame
      // stays whole. Everything incremental is budgeted. A chrome-only frame is
      // atomic for the same reason as a size change: a half-drawn input box is
      // worse than a late one.
      maxBytes: sizeChanged || chromeOnly ? undefined : frameByteBudget(linkQualityOf(this.paintLink, this.paintRttMs)),
      ...(chromeOnly ? { dirtyFrom: chromeStart } : {}),
      ...(this.paintResume === undefined ? {} : { from: this.paintResume }),
    })
    this.paintResume = frame.resume
    // What the drag pacing compares the queue against (`resizeWireBehind`): the
    // wire counts bytes, so a character count would under-report a CJK frame by
    // roughly 3× and let the queue build up exactly where it hurts.
    this.lastFrameBytes = Buffer.byteLength(frame.output, 'utf8')
    this.write(frame.output)
    this.lastPaintCursorRow = row
    this.lastPaintCursorColumn = Math.min(width, Math.max(1, column))
    const snapshot = paintRows.length > height ? paintRows.slice(0, height) : paintRows
    // Only the rows this frame wrote are up to date; a deferred row keeps its
    // old entry so the next frame still sees it as changed. A chrome-only frame is
    // the same rule for a different reason: claiming the transcript rows it left
    // alone would let the next frame compare them equal to themselves and never
    // paint them at all.
    this.lastPaintRows = frame.deferred.length === 0 && !chromeOnly
      ? snapshot
      : advancePaintedRows(this.lastPaintRows, snapshot, frame.painted)
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
    this.pushRow(represent('command-feedback', { kind: 'system', text: t('cwd.full', { cwd }) }))
    this.markDirty()
  }

  private buildSuggestions(): CommandSuggestion[] {
    // Called on every paint: leave the host command service alone unless the
    // line is actually a slash command.
    if (!this.input.startsWith('/')) return []
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
    const provider = this.displayProviderId(this.currentProviderId())
    const model = current?.model ?? this.agent.options.model ?? 'unknown'
    const effort = current?.reasoningEffort
    const kind = describeProviderRoute(provider).short
    return `${provider}/${model}${effort === undefined ? '' : ` (${effort})`} · ${kind}`
  }

  /**
   * The session's own telemetry, in the shapes the old status line used.
   *
   * Kept because the footer is not the only reader: the numbers a user files a
   * bug report with (turns, steps, model time, tool time, cache hit, and the
   * exact per-step decode rate) are still part of the session's public surface,
   * and this is the accessor `/status` and the tests reach for. The default row
   * itself no longer shows any of it.
   */
  statsText(): string {
    return footerStatsGroups(statsRowOf(this.statsTracker.snapshot())).join(' │ ')
  }

  /**
   * When the activity the status row is reporting began.
   *
   * Each state has its own natural clock, and the row shows whichever one
   * belongs to the state it is painting: a tool shows how long that tool has
   * run, a subagent the age of the oldest child, a compaction its card, and a
   * streaming step the time since its first delta. A state with no honest clock
   * — plan mode, a goal, a question nobody has answered yet — gets none, so the
   * chip shows the verb alone rather than borrowing a number that measures
   * something else.
   */
  private footerActivityStartedAt(input: {
    compacting: boolean
    waitingQuestions: boolean
    streaming: boolean
  }): number | undefined {
    if (input.waitingQuestions) return this.waitStartedAt
    if (input.compacting) {
      return this.runningCompactions()[0]?.startedAt
    }
    if (this.activeSubagents.size > 0) {
      let oldest: number | undefined
      for (const subagent of this.activeSubagents.values()) {
        if (oldest === undefined || subagent.startedAt < oldest) oldest = subagent.startedAt
      }
      return oldest
    }
    // The oldest open tool call, so the chip counts the one holding the turn up
    // rather than the one that just started.
    let oldestTool: number | undefined
    for (const callId of this.openToolCalls.keys()) {
      const startedAt = this.statsTracker.toolStartedAt(callId)
      if (startedAt === undefined) continue
      oldestTool = Math.min(oldestTool ?? startedAt, startedAt)
    }
    if (oldestTool !== undefined) return oldestTool
    if (input.streaming) {
      const clocks = this.statsTracker.stepClocks()
      return clocks.firstTokenAt ?? clocks.startedAt
    }
    return undefined
  }

  /**
   * What the open tool calls are, as one word for the activity chip.
   *
   * One call names itself through the transcript's own tool vocabulary
   * (`toolTitle`, the same table the cards use, so `bash` reads `terminal` in
   * both places). Several at once get the count instead, because "which one" has
   * no single answer and a comma-separated list is not a status chip.
   */
  private activityToolLabel(): string | undefined {
    if (!this.agentStatusRunning()) return undefined
    const names = [...this.openToolCalls.values()].filter(name => !HIDDEN_TOOL_NAMES.has(name))
    if (names.length === 0) return undefined
    if (names.length > 1) return t('footer.tools', { count: names.length })
    return toolTitle(names[0] ?? '')
  }

  private agentStatusRunning(): boolean {
    return this.agent.status === 'running'
  }

  /** Refresh the terminal window title (throttled while running). */
  private updateTerminalTitle(): void {
    if (this.exiting || this.lineMode) return
    // A console that has no title to set (the Linux virtual console) would take
    // the escape as noise; the matrix says so, so honour it.
    if (!this.terminalCaps.title) return
    const now = Date.now()
    // Completion wins over a still-running agent status: the turn/end event
    // lands before agent/status flips to idle, and the title must not stay
    // on the running spinner until the next repaint trigger.
    const titleSuffix = this.sessionTitle === '' ? '' : ` · ${this.sessionTitle}`
    if (this.completedAt !== 0 && now - this.completedAt < 5000) {
      this.write(t('title.done', { suffix: titleSuffix }))
      return
    }
    // A compaction is work in progress even when it runs between turns (the
    // idle auto-compact), so it keeps the spinner title the way a running turn
    // does — the same rule the footer's activity chip follows.
    const compacting = this.compactionRunning()
    if (this.agent.status === 'running' || compacting) {
      if (now - this.lastTitleUpdateAt < 800) return
      this.lastTitleUpdateAt = now
      const spinner = SPINNER[Math.floor(now / 800) % SPINNER.length]
      let detail = compacting ? t('title.compacting') : t('title.running')
      if (this.dialog?.kind === 'questions') {
        detail = planReviewOf(this.dialog.question) ? t('question.planTitle') : t('title.waitAnswer')
      } else if (compacting) {
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
    if (this.lineMode) return
    const disabled = process.env.DSH_TUI_NO_BELL === '1' || process.env.DSH_TUI_NO_BELL === 'true'
    if (disabled) return
    this.write('\x07')
  }

  private render = (): void => {
    if (!this.dirty || this.exiting) return
    if ((this.displayDetached || this.headlessDisplay) && this.displayHost?.attached !== true) return
    // Burst merging on a slow link: the previous frames have not drained yet,
    // so another one would only queue behind them and delay the newest state.
    // The paint is skipped, not lost — `dirty` stays set and the next tick
    // draws what is current. The bound keeps a genuinely stuck pipe from
    // freezing the screen forever: after four cadences we paint regardless.
    if (this.stdoutBacklogged() && Date.now() - this.lastPaintAt < 4 * this.paintIntervalMs) return
    if (
      this.agent.status === 'running'
      && Date.now() - this.lastActivity > STALL_WARNING_MS
      && !this.stalledWarningShown
      && this.openToolCalls.size === 0
      && this.activeSubagents.size === 0
    ) {
      this.stalledWarningShown = true
      this.pushRow(represent('runtime-warning', { kind: 'error', text: t('stall.warning') }))
      this.markDirty()
      return
    }
    this.dirty = false
    this.paint()
  }

  /** Whether the previous frames have not drained yet (slow link, big burst). */
  /**
   * Whether the last frame is still on its way to the terminal.
   *
   * Two wires, one question. A direct TTY is `stdout`; a relayed session writes
   * into the display socket, and that socket is the one that knows how much has
   * not left yet. The relay path used to answer "no, never backlogged", which left
   * the Host with no way to tell a link that is keeping up from one that is not —
   * so it paced itself from the measured round trip alone, and a drag on a fast
   * link waited for a cadence nobody needed.
   */
  private outputBacklogged(): boolean {
    // `?.()` on the method as well as the object: a display host is a class in
    // production, but the field is also stubbed by tests and by embedders, and a
    // host that cannot answer the question must not take the paint path down with
    // it — it falls through to the stdout branch instead.
    const pending = this.pendingBytes()
    if (pending !== undefined) return pending > STDOUT_BACKLOG_BYTES
    if (this.displayHost?.attached === true || this.displayDetached) return false
    try {
      return process.stdout.writableLength > STDOUT_BACKLOG_BYTES
    } catch {
      return false
    }
  }

  /** The name the paint path has always used for this question. */
  private stdoutBacklogged(): boolean {
    return this.outputBacklogged()
  }

  /**
   * `/preset`: list, inspect, copy, rename, describe, and delete agent presets.
   *
   * The four operations the web client drives over the remote surface (list,
   * read, copy, delete) plus display-metadata edits, which upstream has no
   * method for and this command writes itself. Every write is either an
   * upstream service call — which validates the id, the trust level, and the
   * writable root — or a `preset.yml` written beside a backup. Nothing here
   * throws: refusals and host errors become rows.
   */
  private async runPresetCommand(arg: string): Promise<void> {
    const service = this.presetService()
    if (service === undefined) {
      this.pushRow(represent('preset-error', {
        kind: 'error',
        text: this.missingPresetService(t('preset.missingService')),
      }))
      this.markDirty()
      return
    }
    const parts = arg.trim().split(/\s+/u).filter(part => part !== '')
    // No argument opens the wizard: pick a preset, then pick what to do with
    // it. Every action it offers calls the same handler the line command does,
    // so both paths share one set of plans, refusals, and confirmations.
    if (parts.length === 0) return this.presetWizard(service)
    const sub = parts[0] ?? 'list'
    const rest = parts.slice(1)
    if (sub === 'list') return this.presetList(service)
    if (sub === 'show') return this.presetShow(service, rest[0])
    if (sub === 'copy') return this.presetCopy(service, rest[0], rest[1], rest.slice(2).join(' '))
    if (sub === 'rename') return this.presetWriteMetadata(service, rest[0], { name: rest.slice(1).join(' ') })
    if (sub === 'describe') return this.presetWriteMetadata(service, rest[0], { description: rest.slice(1).join(' ') })
    if (sub === 'delete') return this.presetDelete(service, rest[0])
    this.pushRow(represent('preset-error', { kind: 'error', text: t('preset.unknownSub', { sub }) }))
    this.markDirty()
  }

  /** The preset service, or undefined on a profile without the roster. */
  private presetService(): PresetService | undefined {
    return this.ctx.get('agentPresets') as unknown as PresetService | undefined
  }

  /**
   * The interactive path: pick a preset, then pick what to do with it.
   *
   * Built only on the dialogs the rest of the TUI already uses — a list with a
   * preselected current entry, and a question with no options for typed input —
   * and it hands every action to the same handler the line command calls, so a
   * wizard write can never take a shortcut past a plan, a refusal, or the
   * delete confirmation.
   */
  private async presetWizard(service: PresetService): Promise<void> {
    try {
      const presets = await service.list()
      if (presets.length === 0) {
        this.pushRow(represent('preset-error', { kind: 'error', text: t('preset.none') }))
        this.markDirty()
        return
      }
      const labelOf = (preset: AgentPreset): string => `${preset.id} · ${preset.name ?? preset.id}`
      const currentIndex = presets.findIndex(preset => preset.id === this.presetId)
      const pickedAnswer = await this.askQuestion({
        id: 'preset-pick',
        question: t('preset.wizardPick', { count: presets.length }),
        options: presets.map(preset => ({
          label: labelOf(preset),
          description: [
            preset.trust === 'user' ? t('preset.trustUser') : t('preset.trustSystem'),
            ...(preset.id === service.defaultId ? [t('preset.isDefault')] : []),
            ...(preset.id === this.presetId ? [t('preset.isCurrent')] : []),
            ...(preset.broken === undefined ? [] : [t('preset.wizardBroken')]),
          ].join(' · '),
        })),
      }, 0, 1, currentIndex >= 0 ? currentIndex : 0)
      const picked = presets.find(preset => labelOf(preset) === pickedAnswer.selected[0])
      if (picked === undefined) return
      const authorable = service.authorable === true
      const userOwned = picked.trust === 'user'
      const actions = [
        { id: 'show', label: t('preset.actionShow') },
        // A copy may start from any preset — the destination is the user root.
        ...(authorable ? [{ id: 'copy', label: t('preset.actionCopy') }] : []),
        ...(authorable && userOwned ? [
          { id: 'rename', label: t('preset.actionRename') },
          { id: 'describe', label: t('preset.actionDescribe') },
          { id: 'delete', label: t('preset.actionDelete') },
        ] : []),
      ]
      const actionAnswer = await this.askQuestion({
        id: 'preset-action',
        question: t('preset.wizardAction', { id: picked.id, name: picked.name ?? picked.id }),
        options: actions.map(action => ({ label: action.label })),
      })
      const action = actions.find(candidate => candidate.label === actionAnswer.selected[0])?.id
      if (action === undefined) return
      if (action === 'show') {
        await this.presetShow(service, picked.id)
        return
      }
      if (action === 'copy') {
        const id = await this.askPresetInput(t('preset.wizardNewId', { from: picked.id }))
        if (id === undefined) return this.presetCancelled()
        const name = await this.askPresetInput(t('preset.wizardNewName'))
        if (name === undefined) return this.presetCancelled()
        await this.presetCopy(service, picked.id, id.trim(), name.trim())
        return
      }
      if (action === 'rename') {
        const name = await this.askPresetInput(t('preset.wizardRename', { id: picked.id }))
        if (name === undefined) return this.presetCancelled()
        await this.presetWriteMetadata(service, picked.id, { name })
        return
      }
      if (action === 'describe') {
        const description = await this.askPresetInput(t('preset.wizardDescribe', { id: picked.id }))
        if (description === undefined) return this.presetCancelled()
        await this.presetWriteMetadata(service, picked.id, { description })
        return
      }
      await this.presetDelete(service, picked.id)
    } catch (error) {
      if (error instanceof UserQuestionError) {
        this.presetCancelled()
        return
      }
      throw error
    }
  }

  /** One free-form answer; `undefined` when the user cancels with Esc. */
  private async askPresetInput(question: string): Promise<string | undefined> {
    try {
      const answer = await this.askQuestion({ id: 'preset-input', question, options: [] })
      return answer.custom ?? answer.selected[0] ?? ''
    } catch (error) {
      if (error instanceof UserQuestionError) return undefined
      throw error
    }
  }

  /** A wizard step the user backed out of: nothing was written. */
  private presetCancelled(): void {
    this.pushRow(represent('preset-feedback', { kind: 'system', text: t('preset.cancelled') }))
    this.markDirty()
  }

  /** One row per preset: id, display name, trust, and what it is missing. */
  private async presetList(service: PresetService): Promise<void> {
    const presets = await service.list()
    const authorable = service.authorable === true
    const lines = [t('preset.listTitle', { count: presets.length, default: service.defaultId })]
    for (const preset of presets) {
      const flags = [
        preset.trust === 'user' ? t('preset.trustUser') : t('preset.trustSystem'),
        ...(preset.id === service.defaultId ? [t('preset.isDefault')] : []),
        ...(preset.id === this.presetId ? [t('preset.isCurrent')] : []),
      ].join(' · ')
      lines.push(t('preset.listRow', { id: preset.id, name: preset.name ?? preset.id, flags }))
      if (preset.broken !== undefined) lines.push(t('preset.listBroken', { reason: preset.broken }))
    }
    lines.push(authorable
      ? t('preset.listWritable', { root: service.roots?.find(root => root.trust === 'user')?.path ?? '' })
      : t('preset.listReadOnly'))
    this.pushRow(represent('preset-feedback', { kind: 'system', text: lines.join('\n') }))
    this.markDirty()
  }

  /** One preset's metadata and the rows its composition mounts. */
  private async presetShow(service: PresetService, id: string | undefined): Promise<void> {
    const presets = await service.list()
    const ids = presets.map(preset => preset.id).join(', ')
    if (id === undefined || id === '') {
      this.pushRow(represent('preset-error', { kind: 'error', text: t('preset.needId', { ids }) }))
      this.markDirty()
      return
    }
    const preset = presets.find(candidate => candidate.id === id)
    if (preset === undefined) {
      this.pushRow(represent('preset-error', { kind: 'error', text: t('preset.unknownId', { id, ids }) }))
      this.markDirty()
      return
    }
    const lines = [t('preset.showTitle', { id: preset.id, name: preset.name ?? preset.id })]
    lines.push(t('preset.showMeta', {
      trust: preset.trust === 'user'
        ? t('preset.trustUser')
        : preset.trust === undefined ? t('preset.trustManaged') : t('preset.trustSystem'),
      order: preset.order === undefined ? '—' : String(preset.order),
      directory: presetDirectory(preset) ?? t('preset.directoryManaged'),
    }))
    if (preset.description !== undefined) lines.push(t('preset.showDescription', { description: preset.description }))
    if (preset.broken !== undefined) {
      lines.push(t('preset.showBroken', { reason: preset.broken }))
    } else if (typeof service.compositionInventory === 'function') {
      const composition = (await service.compositionInventory()).find(entry => entry.id === preset.id)
      if (composition === undefined) {
        lines.push(t('preset.showNoRows'))
      } else {
        for (const row of composition.rows) {
          lines.push(t('preset.showRow', {
            module: row.moduleName,
            entry: row.entryId === null ? '' : t('preset.showRowId', { id: row.entryId }),
            state: row.enabled === true
              ? ''
              : row.enabled === false
                ? t('preset.rowDisabled')
                : t('preset.rowConditional', { condition: row.condition ?? '' }),
          }))
        }
      }
    } else if (typeof service.read === 'function') {
      // A host older than the inventory API still hands over the document.
      const document = await service.read(preset.id)
      lines.push(t('preset.showRawHint'))
      for (const line of document.split('\n').slice(0, 40)) lines.push(`  ${line}`)
    } else {
      lines.push(t('preset.unsupported', { feature: 'read' }))
    }
    this.pushRow(represent('preset-feedback', { kind: 'system', text: lines.join('\n') }))
    this.markDirty()
  }

  /** Copy an existing preset (upstream's only creation path). */
  private async presetCopy(
    service: PresetService,
    from: string | undefined,
    id: string | undefined,
    name: string,
  ): Promise<void> {
    if (typeof service.copy !== 'function') {
      this.pushRow(represent('preset-error', { kind: 'error', text: t('preset.unsupported', { feature: 'copy' }) }))
      this.markDirty()
      return
    }
    const presets = await service.list()
    const plan = planCopy({
      presets,
      authorable: service.authorable === true,
      from: from ?? '',
      id: id ?? '',
      name: name === '' ? undefined : name,
    })
    if (isRefusal(plan)) {
      this.pushPresetRefusal(plan)
      return
    }
    const copy = service.copy.bind(service)
    await this.presetWrite(async () => {
      await copy(plan.from, plan.id, plan.name)
      return t('preset.copyDone', {
        from: plan.from,
        id: plan.id,
        name: plan.name === undefined ? '' : ` · ${plan.name}`,
        directory: presetDirectory(presets.find(candidate => candidate.id === plan.id) ?? presets[0]!) ?? '',
      })
    })
  }

  /** Edit the display name or description: a `preset.yml` written beside a backup. */
  private async presetWriteMetadata(
    service: PresetService,
    id: string | undefined,
    patch: { name?: string; description?: string },
  ): Promise<void> {
    const presets = await service.list()
    const preset = presets.find(candidate => candidate.id === id)
    if (preset === undefined) {
      this.pushRow(represent('preset-error', {
        kind: 'error',
        text: t('preset.unknownId', { id: id ?? '', ids: presets.map(candidate => candidate.id).join(', ') }),
      }))
      this.markDirty()
      return
    }
    if ((patch.name ?? patch.description ?? '').trim() === '') {
      this.pushRow(represent('preset-error', { kind: 'error', text: t('preset.needValue', { id: preset.id }) }))
      this.markDirty()
      return
    }
    // Merge with what the preset publishes now, so editing one field never
    // drops the other and `order` survives.
    const directory = presetDirectory(preset)
    const current = directory === undefined ? {} : await readPresetMetadata(directory)
    const plan = planMetadata({ preset, current, patch })
    if (isRefusal(plan)) {
      this.pushPresetRefusal(plan)
      return
    }
    const path = join(plan.directory, METADATA_FILE)
    const field = patch.name === undefined ? t('preset.fieldDescription') : t('preset.fieldName')
    await this.presetWrite(async () => {
      const backup = await writePatchWithBackup(path, plan.text)
      return [
        t('preset.metadataDone', { id: plan.id, field }),
        ...(backup === undefined ? [] : [t('preset.backupLine', { path: backup })]),
      ].join('\n')
    })
  }

  /** Delete a user preset after one confirmation. */
  private async presetDelete(service: PresetService, id: string | undefined): Promise<void> {
    if (typeof service.remove !== 'function') {
      this.pushRow(represent('preset-error', { kind: 'error', text: t('preset.unsupported', { feature: 'delete' }) }))
      this.markDirty()
      return
    }
    const presets = await service.list()
    const preset = presets.find(candidate => candidate.id === id)
    if (preset === undefined) {
      this.pushRow(represent('preset-error', {
        kind: 'error',
        text: t('preset.unknownId', { id: id ?? '', ids: presets.map(candidate => candidate.id).join(', ') }),
      }))
      this.markDirty()
      return
    }
    const plan = planDelete({
      preset,
      authorable: service.authorable === true,
      current: preset.id === this.presetId,
    })
    if (isRefusal(plan)) {
      this.pushPresetRefusal(plan)
      return
    }
    const answer = await new Promise<'y' | 'n' | 'cancel'>(resolve => {
      this.openConfirm(
        t('preset.deleteConfirm', { id: plan.id }),
        t('preset.deleteHint', { directory: presetDirectory(preset) ?? t('preset.directoryManaged') }),
        resolve,
      )
    })
    if (answer !== 'y') {
      this.pushRow(represent('preset-feedback', { kind: 'system', text: t('preset.deleteCancelled') }))
      this.markDirty()
      return
    }
    const remove = service.remove.bind(service)
    await this.presetWrite(async () => {
      await remove(plan.id)
      return t('preset.deleteDone', { id: plan.id })
    })
  }

  /**
   * Run one authoring call and report it.
   *
   * The service validates more than this command can (the writable root, an
   * occupied id, the trust recorded on disk), so its message is what the user
   * sees when it refuses.
   */
  private async presetWrite(call: () => Promise<string>): Promise<void> {
    try {
      this.pushRow(represent('preset-feedback', { kind: 'system', text: await call() }))
    } catch (error) {
      this.pushRow(represent('preset-error', { kind: 'error', text: t('preset.failed', { error: errorChain(error) }) }))
    }
    this.markDirty()
  }

  /** One refusal, in the user's language. */
  private pushPresetRefusal(refusal: PresetRefusal): void {
    this.pushRow(represent('preset-error', {
      kind: 'error',
      text: t(`preset.refused.${refusal.error}`, {
        id: refusal.id ?? '',
        name: refusal.name ?? refusal.id ?? '',
        root: this.presetService()?.roots?.find(root => root.trust === 'user')?.path ?? '',
      }, refusal.error),
    }))
    this.markDirty()
  }

  /**
   * Apply the footer's muted style around a strip that carries its own accents
   * (the link pips, the ⚠). {@link styleLine} cannot do this: it sanitises its
   * input, which strips an accent's `ESC` and leaves the `[32m` body on the grid
   * as four literal characters — the garbled footer B-1 shipped. Every inner
   * reset re-opens the muted style, so the text between two accents stays muted.
   */
  private muteFooterLine(text: string): string {
    if (text === '') return ''
    const code = this.mutedSgr()
    if (code === '') return text
    const open = `\x1b[${code}m`
    return `${open}${text.replaceAll('\x1b[0m', `\x1b[0m${open}`)}\x1b[0m`
  }

  /** The muted strip separator, so the groups between the accents stay dim. */
  private mutedSeparator(): string {
    const code = this.mutedSgr()
    return code === '' ? ' │ ' : `\x1b[${code}m │ `
  }

  private mutedSgr(): string {
    return this.color ? downgradeSgr(themeToken(this.theme, 'system'), this.colorDepth) : ''
  }

  private styleLine(kind: DisplayKind, text: string): string {
    const safe = sanitizeTerminalText(text)
    if (!this.color) return safe
    // Roles, not colours: `theme.ts` owns the palette, this method owns the
    // escaping. Primary text and tool output carry an empty token on purpose —
    // they take the terminal's own foreground, which is the only choice that is
    // readable on both light and dark terminals.
    const requested = themeToken(this.theme, kind)
    const code = downgradeSgr(requested, this.colorDepth)
    // Nothing left to paint: the text stands on its own.
    if (code === '') return safe
    return `\x1b[${code}m${safe}\x1b[0m`
  }

  /**
   * One emphasised piece of a body line — the words a diff changed.
   *
   * Inside a filled diff row the mark is a lighter shade of that same fill.
   * Inverse video was there first, and it inverted the *fill*: a line replaced
   * wholesale is emphasised from end to end, so it came out a bright block
   * beside rows that kept the muted tone — visibly from another palette. On a
   * terminal with no colour left to shift, the attribute is what survives, so
   * the inverse video stays for that case.
   */
  private styleEmphasisedPiece(kind: DisplayKind, text: string): string {
    const requested = themeEmphasisToken(this.theme, kind)
    if (requested !== undefined && this.color) {
      const code = downgradeSgr(requested, this.colorDepth)
      if (code !== '') return `\x1b[${code}m${sanitizeTerminalText(text)}\x1b[0m`
    }
    return `\x1b[7m${this.styleLine(kind, text)}\x1b[27m`
  }

  /**
   * Paint a row the reader has selected.
   *
   * The obvious `7`…`27` wrap only reaches the part before the line's first
   * reset, and every painted segment ends with one: a focused card kept its
   * marker and status dot highlighted while the title, the state word and the
   * summary stayed plain, so ↑/↓ gave no visible clue which card was picked —
   * on exactly the rows that carry a segmented header. Re-opening the attribute
   * after every reset covers the whole row, whatever colours sit on top of it.
   */
  private selectLine(styled: string, selected: boolean): string {
    if (!selected || !this.color) return styled
    return `\x1b[7m${styled.replaceAll('\x1b[0m', '\x1b[0m\x1b[7m')}\x1b[27m`
  }

  /**
   * Fold one live stream chunk into the in-progress assistant row. Hosts from
   * 0.1.5 on emit the chunk on `agent/assistant-stream` and never write it to
   * the log.
   */
  private applyStreamChunk(streamed: {
    chunk: StreamChunkLike
    turn: number
    step: number
    time: number
    stepKnown: boolean
  }): void {
    const { chunk } = streamed
    if (isTokenDeltaChunk(chunk)) {
      this.statsTracker.noteFirstToken(streamed.turn, streamed.step, streamed.time)
    }
    if (chunk.type === 'usage' && chunk.usage !== undefined && streamed.stepKnown) {
      this.statsTracker.recordUsage(streamed.turn, streamed.step, chunk.usage as TokenUsage)
    }
    if (chunk.type === 'text-delta') {
      this.streaming ??= { text: '', reasoning: '' }
      const text = chunk.text ?? ''
      this.streaming.text += text
      // The status row's live rate is measured from *characters*, because the
      // harness reports no per-token count until the step settles. Reasoning
      // counts too: a thinking model is decoding either way, and a rate that
      // only started at the visible answer would read as zero for a minute.
      this.statsTracker.noteDelta(text, streamed.time || Date.now())
      this.markDirty()
    } else if (chunk.type === 'reasoning-delta') {
      this.streaming ??= { text: '', reasoning: '' }
      const text = chunk.text ?? ''
      if (this.streaming.reasoning === '' && text !== '') {
        this.thinkingStartedAt = Date.now()
        // The block is reused across the steps of one turn: a model that thinks,
        // answers, and thinks again used to get a fresh, collapsed block at every
        // phase, so expanding it while the answer streamed looked like it did
        // nothing. `turn/start` is what resets it, because that is a new turn.
        this.liveThinkingBlock()
      }
      this.streaming.reasoning += text
      this.statsTracker.noteDelta(text, streamed.time || Date.now())
      this.markDirty()
    }
  }

  /**
   * 0.1.5 and 0.1.7 live tokens arrive as process-local
   * `agent/assistant-stream` frames (start / chunk / end). Chunk frames carry
   * the same `StreamChunk` the settled `assistant/message` embeds in `stream`.
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
   *
   * Effort is not inherited from the parent. `next()` copies the live parent
   * config, so a grok-4.6 `xhigh` parent would otherwise send `xhigh` with
   * the light grok-4.5 child and fail with UNSUPPORTED_REASONING_EFFORT
   * before the child writes a closing message. An explicit `/subeffort`
   * still wins; otherwise the child's own adapter default is used.
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
    // A pinned provider keeps the stored model even when it is a different
    // family from the parent. Only an inherited (follow-parent) route is
    // rewritten onto a same-family default.
    const model = selection.provider !== undefined || subagentModelMatchesProvider(provider, selection.model)
      ? selection.model
      : defaultSubagentModelForProvider(provider, [], this.selectionRef?.current?.model)
    const { reasoningEffort: parentEffort, ...withoutParentEffort } = resolved
    // `/subeffort` wins. Otherwise keep the parent effort only when the child
    // is still on that same model — grok-4.6 xhigh is legal on grok-4.6 and
    // rejected on grok-4.5.
    const effort = selection.reasoningEffort
      ?? (model === resolved.model ? parentEffort : undefined)
    return {
      ...withoutParentEffort,
      provider,
      model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
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
    if (!this.replaying) this.refreshContextPressure()
    this.recordPlanEvent(event)
    // Before the switch, and by string: `workspace/changes` is not a key of the
    // 0.1.5 `SessionEventMap`, so a `case` for it fails strict compilation on
    // that tree. A Host without the service records nothing and this returns.
    if (String(event.type) === 'workspace/changes') {
      this.noteWorkspaceChanges(session.id, event.seq)
      return
    }
    switch (event.type) {
      case 'user/message': {
        const text = event.data.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
        // The authoritative source for "was anything typed into this session": the
        // log itself. It used to be set only by the composer's submit path, and a
        // second, unreachable `case 'user/message'` further down tried to derive it
        // (dead code — a duplicate case label is never reached). A resume replays
        // these events, so the flag now survives it.
        this.sawUserInput = true
        if (text !== '') {
          const source = event.data.source as { kind?: string; plugin?: string; form?: string; summary?: string }
          const sourceKind = source.kind ?? ''
          if (sourceKind === 'user') {
            this.pushRow(represent('user-message', { kind: 'user', text: `❯ ${text}` }))
            if (!this.replaying) this.beginWait()
          } else if (source.form === 'notice') {
            const summary = source.summary?.trim() ?? ''
            // Body stays off the workspace (the model still received it).
            const last = this.rows.at(-1)
            const alreadyShown = last?.kind === 'system' && last.text === summary
            if (summary !== '' && !alreadyShown) this.pushRow(represent('session-notice', { kind: 'system', text: summary }))
            // Replaying a resumed session: the reminder in the log belongs to
            // the open list that is being rebuilt, so mark it as spent.
            if (summary === t('plan.nudgeQueued')) {
              const resumed = this.findLivePlanRow()
              if (resumed !== undefined) resumed.nudged = true
            }
            if (!this.replaying) this.beginWait()
          } else if (source.form === 'snapshot') {
            // `form` is the ContextFormed discriminator every producer shares,
            // while `kind` is now per-producer (0.1.7 has no catch-all), so the
            // two content branches above key on the form: keying them on the
            // released `plugin` kind dropped a `time-context` snapshot — and
            // this plugin's own notices — into the raw-context row below.
            this.pushRow(represent('session-notice', { kind: 'system', text: text }))
          } else if (isPromptInjectionMessage(sourceKind, text, source.plugin)) {
            this.pushPromptInjection(text, source.plugin)
          } else {
            this.pushRow(represent('session-notice', { kind: 'system', text: t('prompt.contextPrefix', { text }) }))
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
        // both attempts reported a rate ~20x off.
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
          this.pushRow(represent('reasoning-message', { kind: 'reasoning', text: `${reasoning}${interruptedMark}`, expanded: reasoningExpanded }))
        }
        if (reasoning !== '') this.turnSawReasoning = true
        if (text !== '') {
          this.turnSawOutput = true
          this.pushRow(represent('assistant-message', { kind: 'assistant', text: `${text}${interruptedMark}` }))
        } else if (interrupted && reasoning === '') {
          this.pushRow(represent('session-notice', { kind: 'system', text: t('stream.interruptedEmpty') }))
        }
        this.markDirty()
        break
      }
      case 'tool/call': {
        this.turnSawOutput = true
        this.openToolCalls.set(String(event.data.callId), event.data.name)
        // The durable fold needs the questions, and the *settled* half of the
        // Session's projection names only the call and its answers — so the batch
        // is remembered here, where the log states it, for a replay to reuse.
        if (event.data.name === 'ask_user_question') {
          const asked = askQuestions(event.data.arguments)
          if (asked.length > 0) this.askedByCall.set(String(event.data.callId), asked)
        }
        this.toolCallNames.set(String(event.data.callId), event.data.name)
        this.statsTracker.noteToolStart(String(event.data.callId), event.time)
        // `ask_user_question` is represented by the question it asked, not by a
        // generic tool card (B2.4): one semantic question gets exactly one primary
        // transcript representation. The card is created from the call's own
        // arguments right here, so the live path, the replay path and a log whose
        // projection never folded the call all draw the same thing — the projection
        // only ever *updates* the card's state.
        if (event.data.name === 'ask_user_question') {
          const asked = this.askedByCall.get(String(event.data.callId)) ?? []
          for (const question of asked) this.ensureQuestionCard(String(event.data.callId), question)
        }
        if (
          !HIDDEN_TOOL_NAMES.has(event.data.name)
          && !QUESTION_TOOL_NAMES.has(event.data.name)
          && !PLAN_TOOL_NAMES.has(event.data.name)
        ) {
          const present = presentToolCall(event.data.name, event.data.arguments)
          if (SUBAGENT_TOOL_NAMES.has(event.data.name)) {
            const task = present.summary.trim()
            const callId = String(event.data.callId)
            // Replay never gets `subagent/start` to drain this queue, so only a
            // live spawn waits for its child card. The pair is dropped again at
            // `tool/result` when the spawn never started a child (denied,
            // cancelled): a description left behind would name the next child.
            if (task !== '' && !this.replaying) this.pendingSubagentTasks.push({ task, callId })
            if (this.replaying && !this.rows.some(candidate =>
              candidate.kind === 'subagent' && candidate.runId === callId)) {
              // Live `subagent/start` is not in the parent log. Resume still
              // needs a courtesy chip; a live Host already has the real card.
              this.pushRow(represent('subagent-card', subagentRowFromSpawnTool({
                callId,
                task,
                modelProvider: this.currentProviderId(),
                status: 'running',
                startedAt: typeof event.time === 'number' ? event.time : Date.now(),
              })))
            }
            this.streaming = undefined
            this.markDirty()
            break
          }
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
            this.adoptPendingApproval(row)
            this.pushRow(represent('tool-call', row))
          }
        }
        if (event.data.name === 'exit_plan_mode') {
          const markdown = planMarkdownFromArgs(event.data.arguments)
          void markdown
          // …and the body is the artifact's, folded from this very call.
        }
        this.streaming = undefined
        this.markDirty()
        break
      }
      case 'tool/result': {
        this.openToolCalls.delete(String(event.data.message.source.callId))
        this.statsTracker.noteToolEnd(String(event.data.message.source.callId), event.time)
        const callId = String(event.data.message.source.callId)
        // A spawn whose wrapper came back without starting a child (approval
        // denied, provider refused, turn cancelled) must not leave its
        // description queued: the next child would inherit that name.
        this.pendingSubagentTasks = this.pendingSubagentTasks.filter(entry => entry.callId !== callId)
        const spawnCard = this.rows.findLast((candidate): candidate is Extract<Row, { kind: 'subagent' }> =>
          candidate.kind === 'subagent' && (candidate.runId === callId || candidate.spawnCallId === callId))
        const output = collectText(event.data.message.content)
        if (spawnCard !== undefined) {
          // A live child already owns this spawn: the parent tool/result is
          // just the wrapper settling. Do not stamp a 0s twin chip complete.
          if (spawnCard.childSessionId !== undefined) {
            this.markDirty()
            break
          }
          const failed = event.data.error !== undefined || toolResultFailed(event.data.message)
          spawnCard.status = failed ? 'error' : 'ok'
          spawnCard.endedAt = typeof event.time === 'number' ? event.time : Date.now()
          if (output !== '') {
            spawnCard.lastActivity = clipSubagentActivity(output, 80)
            appendSubagentLog(spawnCard, { kind: failed ? 'result' : 'assistant', text: clipSubagentActivity(output, 80) })
          }
          this.markDirty()
          break
        }
        const row = this.findToolRowByCallId(callId)
        if (row !== undefined) {
          this.adoptPendingApproval(row)
          this.inferApprovalFromResult(row, event.data.message)
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
            || toolResultFailed(event.data.message)
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
          // The question tool's result is the *answer*, and the question card
          // carries it — a second card for the same call is the duplicate B2.4
          // removes.
          if (recordedName !== '' && QUESTION_TOOL_NAMES.has(recordedName)) break
          // The plan tool's representation is the plan artifact (its review, its body
          // and the lifecycle lines) — a generic card beside it was the third copy of
          // the same event (B2.5 §15).
          if (recordedName !== '' && PLAN_TOOL_NAMES.has(recordedName)) break
          // A spawn is drawn as the child's chip, never as a `subagent` tool
          // card: without a start there is still no card to settle, and a
          // second card beside the chip is exactly the duplicate to avoid.
          if (SUBAGENT_TOOL_NAMES.has(recordedName)) break
          // Never title a card with the call id (`call-<uuid>`). Prefer the
          // recorded tool name; fall back to a generic tool card.
          const toolName = displayToolName(recordedName)
          const present = presentToolCall(toolName, '')
          this.pushRow(represent('tool-call', {
            kind: 'tool',
            callId,
            name: toolName,
            args: '',
            status: event.data.error === undefined ? 'ok' : 'error',
            output,
            title: present.title,
            summary: present.summary,
            expanded: false,
          }))
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
      case 'approval/asked': {
        // The Harness's own audit pair: this is what "an approval was required"
        // means durably, and it names the tool call it guards. Read, never written
        // — the plugin keeps no approval store (B2.4).
        const id = String((event.data as { id?: unknown }).id ?? '')
        const toolName = String((event.data as { toolName?: unknown }).toolName ?? '')
        const rawCallId = (event.data as { callId?: unknown }).callId
        const reason = (event.data as { reason?: unknown }).reason
        if (id === '') break
        this.approvalAsked.set(id, {
          toolName,
          ...(rawCallId === undefined ? {} : { callId: String(rawCallId) }),
          ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
        })
        if (rawCallId !== undefined) {
          // While a *live* Host is asking, the state is genuinely `waiting`; a
          // replay reaches the same event with nobody waiting, so the ask alone
          // never claims more than "it was asked" — see `approval/decided`.
          this.setToolApproval(String(rawCallId), {
            state: this.replaying ? 'unknown' : 'waiting',
            provenance: 'durable',
          })
        }
        break
      }
      case 'approval/decided': {
        const id = String((event.data as { id?: unknown }).id ?? '')
        const asked = this.approvalAsked.get(id)
        const state = approvalStateFromOutcome(String((event.data as { outcome?: unknown }).outcome ?? ''))
        if (asked?.callId !== undefined) {
          this.setToolApproval(asked.callId, {
            state,
            provenance: 'durable',
            ...(asked.reason === undefined ? {} : { reason: asked.reason }),
          })
        }
        break
      }
      case 'approval/policy':
        this.hostApprovalPolicy = String((event.data as { policy?: unknown }).policy ?? '')
        if (this.hostApprovalPolicy === 'never') this.warnApprovalMismatch()
        break
      case 'turn/start':
        // A new turn is new thinking: the live reasoning block starts collapsed
        // again, and with its clock reset. The reader's expansion choice belongs to
        // the turn that was on screen when they made it, so it goes with the block:
        // one card left open must not make every later turn open silently.
        this.streamingReasoning = undefined
        this.reasoningExpandedChoice = undefined
        this.thinkingStartedAt = undefined
        this.stalledWarningShown = false
        this.turnSawOutput = false
        this.turnSawReasoning = false
        this.llmRetry = undefined
        // One automatic retry per user message, and only for the failure class
        // that is worth retrying (see `auth-failure.ts`).
        this.authRetryArmed = true
        this.status = `turn ${event.data.turn} running`
        // A turn is about to spend on this route: make sure the session's record
        // names it, whatever changed it (a preset, a settings edit, a resume).
        this.noteSessionRoute()
        this.markDirty()
        break
      case 'turn/end': {
        const reason = event.data.reason
        this.openToolCalls.clear()
        this.toolCallNames.clear()
        this.statsTracker.noteTurnEnd()
        this.stalledWarningShown = false
        // A retry belongs to the turn that scheduled it: once the turn closes,
        // the chip must not outlive it (a failed retry would otherwise leave
        // "重试 n/m" on an idle footer until the next turn).
        this.llmRetry = undefined
        this.pendingMessages.clear()
        // The queue is gone with the turn, so the notice that spoke for it is too.
        if (this.notice?.holds === 'queue') {
          this.notice = undefined
          if (this.feedbackTimer !== undefined) {
            clearTimeout(this.feedbackTimer)
            this.feedbackTimer = undefined
          }
        }
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
          this.pushRow(represent('turn-error', { kind: 'error', text: t('turn.failed', { turn: event.data.turn, error: reason.error.message }) }))
          this.reportAuthFailure(String(reason.error.message ?? ''))
        }
        if (reason.kind === 'completed' && !this.replaying && !this.turnSawOutput) {
          // The provider ended the turn without an answer. Some gateways map a
          // Gemini/Claude reply that only contains a thought part onto
          // `reasoning_content` and then finish with stop and no content, so the
          // turn looks completed while nothing was said and the user is left to
          // guess that another Enter is what continues it. Say so instead.
          this.pushRow(represent('session-notice', {
            kind: 'system',
            text: t(this.turnSawReasoning ? 'turn.emptyThinkingOnly' : 'turn.emptyReply'),
          }))
        }
        const livePlan = this.findLivePlanRow()
        if (livePlan !== undefined && reason.kind === 'completed') {
          applyTurnEndToPlan(livePlan)
          if (livePlan.turnLeftOpen === true) {
            // A *notice*, not a plan row (B2 final audit). It was classified
            // `plan-row` while carrying a plain system row, which is the one thing a
            // representation may not be: a plan row is the artifact's reference in the
            // transcript and has steps — this is one sentence about the turn, and
            // classifying it as the artifact made the audit's `plan-row` count
            // disagree with the artifacts it names.
            this.pushRow(represent('plan-notice', {
              kind: 'system',
              text: planDockNote(livePlan),
            }))
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
    // Question state is derived from the Session, not from the request that opened
    // a dialog, so both a lived and a replayed session draw the same cards. The
    // set is small on purpose: these are the events the projection folds.
    if (QUESTION_FOLD_EVENTS.has(String(event.type))) this.syncQuestionRows()
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
    this.pushRow(represent('error-surface', { kind: 'error', text: errorChain(error) }))
    this.markDirty()
  }

  private readonly handleInboxClaimed = ({ agent, message }: { agent: Agent; message: { id: string } }): void => {
    if (agent !== this.agent) return
    if (this.pendingMessages.delete(message.id)) this.noteQueueDrained()
  }

  private readonly handleInboxDiscarded = ({ agent, message }: { agent: Agent; message: { id: string } }): void => {
    if (agent !== this.agent) return
    if (this.pendingMessages.delete(message.id)) this.noteQueueDrained()
  }

  /**
   * Say that a message is queued, and hold the notice until it is really submitted.
   *
   * The one notice that must outlive its clock: it is the only sign the reader has that
   * something is waiting, and it stays true until the step claims it — so it lives as
   * long as the queue does (`noteQueueDrained` clears it), not as long as a timer says.
   */
  private showQueuedNotice(text: string): void {
    this.pushRow(represent('steer-notice', { kind: 'system', text }))
    const notice = this.notice as { text: string; at: number; holds?: 'queue' } | undefined
    if (notice !== undefined) notice.holds = 'queue'
  }

  /**
   * The last queued message was claimed (or dropped): the acknowledgement goes with it.
   *
   * This is what "until it is really submitted" means — the notice is not about the
   * keystroke that queued the message, it is about the message still waiting, so it
   * ends where the waiting does.
   */
  private noteQueueDrained(): void {
    if (this.pendingMessages.size > 0) return
    if (this.notice?.holds !== 'queue') {
      this.markDirty()
      return
    }
    this.notice = undefined
    if (this.feedbackTimer !== undefined) {
      clearTimeout(this.feedbackTimer)
      this.feedbackTimer = undefined
    }
    this.markDirty()
  }

  private readonly handleDisposed = ({ agent }: { agent: Agent }): void => {
    if (agent !== this.agent) return
    this.agentGone = true
    this.pushRow(represent('command-error', { kind: 'error', text: t('agent.disposed') }))
    this.status = 'disposed'
    this.markDirty()
  }

  /**
   * One `workspace/changes` event: the files a turn changed.
   *
   * The event carries only the turn number; the summary stays on the Host and
   * is served by `workspaceChanges` for this event's own sequence, and only
   * while the Session lives. A missing service (every 0.1.5 Host) or a summary
   * that can no longer be opened (a log replayed after a restart) shows
   * nothing — upstream's rule, so a card that cannot be read is never drawn.
   * A later event for the same turn replaces the earlier summary in place.
   */
  private noteWorkspaceChanges(sessionId: SessionId, seq: number | undefined): void {
    if (typeof seq !== 'number') return
    const service = workspaceChangesOf(this.ctx as unknown as { get?(name: string): unknown })
    if (service === undefined) return
    const summary = service.summary(String(sessionId), seq)
    if (summary === undefined || !changesSummaryVisible(summary)) return
    const existing = this.rows.findLast((row): row is Extract<Row, { kind: 'changes' }> =>
      row.kind === 'changes' && row.turn === summary.turn && row.sessionId === String(sessionId))
    if (existing !== undefined) {
      this.fillChangesCard(existing, summary, seq)
    } else {
      const row: Extract<Row, { kind: 'changes' }> = {
        kind: 'changes',
        turn: summary.turn,
        seq,
        sessionId: String(sessionId),
        header: '',
        files: [],
        expanded: false,
      }
      this.fillChangesCard(row, summary, seq)
      this.pushRow(represent('changes-card', row))
    }
    this.markDirty()
  }

  /** Copy one summary onto its card. Shared by the first event and its replacements. */
  private fillChangesCard(
    row: Extract<Row, { kind: 'changes' }>,
    summary: ChangesSummary,
    seq: number,
  ): void {
    row.seq = seq
    row.header = changesHeader(summary)
    row.files = summary.files.map(changesFileLine)
    const more = changesRemainderLine(summary)
    if (more === undefined) delete row.more
    else row.more = more
  }

  /**
   * Full view of one file on a changes card: its comparison, as the service
   * computed it. Binary and oversized files have no lines, so the overlay
   * carries the one-line explanation instead of an empty body.
   */
  private openChangesInspect(row: Extract<Row, { kind: 'changes' }>, index: number): void {
    const service = workspaceChangesOf(this.ctx as unknown as { get?(name: string): unknown })
    const label = row.files[index] ?? row.header
    const title = t('changes.inspectTitle', { file: label })
    if (service === undefined) {
      this.openChangesInspectLines(title, [{ kind: 'tool-result', text: t('changes.unavailable') }])
      return
    }
    const controller = new AbortController()
    void service.diff(row.sessionId, row.seq, index, controller.signal)
      .then(diff => {
        const lines = renderChangesDiff(diff)
        this.openChangesInspectLines(title, lines.length > 0
          ? lines
          : [{ kind: 'tool-result', text: t('changes.unavailable') }])
      })
      .catch(() => {
        this.openChangesInspectLines(title, [{ kind: 'tool-result', text: t('changes.unavailable') }])
      })
  }

  /** Open (or replace) the changes overlay, or echo it to the log in line mode. */
  private openChangesInspectLines(title: string, lines: DiffDisplayLine[]): void {
    if (this.echoInspectToLog(title, lines)) return
    const open = this.screen
    if (open !== undefined && open.kind === 'inspect') {
      open.title = title
      open.lines = lines
      open.offset = 0
      // The Screen may be a leftover from another body, and this path is
      // asynchronous: a reply opened while the diff was being read would keep its
      // `copyText`, so the copy key would hand back the reply under a diff.
      // Everything the previous body owned is replaced here.
      open.copyText = inspectCopyText(lines)
      open.notice = undefined
      this.markDirty()
      return
    }
    this.openScreen({ kind: 'inspect', title, lines, offset: 0, copyText: inspectCopyText(lines) })
  }

  /** Plan-mode / command / team events that plugins merge into SessionEventMap. */
  private handleExtensionEvent(event: SessionEvent): void {
    const type = String(event.type)
    const data = (event as SessionEvent & { data?: unknown }).data as { active?: unknown; name?: unknown; args?: unknown } | undefined
    if (type === 'plan/mode') {
      // The activation itself is the projection's (`recordPlanEvent` folded it before
      // this switch), and so is the lifecycle line it pushes: nothing here keeps plan
      // state, which is the point of B2.5.
      this.markDirty()
      return
    }
    if (type === 'todo/write') {
      // Same: the snapshot is a revision of the artifact, folded from the event.
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
      this.pushRow(represent('retry-notice', { kind: 'system', text: t('retry.generatingTitle') }))
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
      this.pushRow(represent('retry-notice', {
        kind: 'system',
        text: t('retry.progress', {
          ms: Math.round(delayMs),
          retry,
          max: maxRetries,
          message,
        }),
      }))
      this.markDirty()
      return
    }
    if (type === 'llm/retry-started') {
      if (this.llmRetry !== undefined) {
        this.pushRow(represent('retry-notice', { kind: 'system', text: t('retry.started', { retry: this.llmRetry.retry }) }))
      }
      // The backoff is over and the retried request is in flight: the footer
      // must go back to the ordinary running/waiting states instead of holding
      // "retry n/m" until the next turn starts (which could be minutes later,
      // or never — and a compaction ending in between fell back to this stale
      // chip rather than to 运行中).
      this.llmRetry = undefined
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
      this.pushRow(represent('subagent-card', { kind: 'system', text: t('team.event', { type }) }))
      this.markDirty()
    }
  }

  private findCompactionRow(id?: string): Extract<Row, { kind: 'compaction' }> | undefined {
    if (id !== undefined && id !== '') {
      const named = this.rows.findLast((row): row is Extract<Row, { kind: 'compaction' }> =>
        row.kind === 'compaction' && row.compactionId === id)
      if (named !== undefined) return named
    }
    // An event whose id matches no card still belongs to the compaction in
    // flight: the Host runs at most one at a time, so the newest running card is
    // the only candidate. Without this a mismatched (or absent) id left the row
    // running forever — the same stuck state an abandoned Host produces.
    return this.runningCompactions().at(-1)
  }

  /**
   * Compaction cards that can still be in flight: not finished, and within the
   * window a real compaction could take. A stale card is treated as not running
   * so it cannot hold the footer, the spinner, or `/compact` hostage.
   */
  private runningCompactions(now = Date.now()): Extract<Row, { kind: 'compaction' }>[] {
    return this.rows.filter((row): row is Extract<Row, { kind: 'compaction' }> =>
      row.kind === 'compaction'
      && row.status === 'running'
      && now - row.startedAt < COMPACTION_STALE_MS)
  }

  /** Whether a compaction is genuinely in flight right now. */
  private compactionRunning(): boolean {
    return this.runningCompactions().length > 0
  }

  /**
   * Close compaction cards whose Host is gone.
   *
   * `compaction/start` is written before the work and `compaction/end` after it,
   * so a Host that exits in between leaves an open start in the durable log.
   * Replaying that log faithfully used to recreate a card stuck on "running"
   * forever: the footer said 压缩中, the spinner kept animating, and every later
   * `/compact` was refused as "already compacting". After a full replay nothing
   * more can arrive for those starts, so they are settled here.
   *
   * `staleOnly` keeps the same sweep usable while the session is live, where a
   * compaction that is merely slow must not be closed under it.
   */
  private settleUnfinishedCompactions(options: { staleOnly?: boolean } = {}): void {
    const now = Date.now()
    let settled = false
    for (const row of this.rows) {
      if (row.kind !== 'compaction' || row.status !== 'running') continue
      if (options.staleOnly === true && now - row.startedAt < COMPACTION_STALE_MS) continue
      row.status = 'error'
      row.endedAt = row.startedAt === 0 ? now : row.startedAt
      row.error = t('compact.interrupted')
      settled = true
    }
    if (settled) this.markDirty()
  }

  private handleCompactionEvent(type: string, event: SessionEvent): void {
    const payload = (event as SessionEvent & { data?: unknown }).data
    const data = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const compactionId = typeof data.compactionId === 'string' ? data.compactionId : ''
    if (type === 'compaction/start') {
      this.pushRow(represent('compaction', {
        kind: 'compaction',
        compactionId,
        status: 'running',
        startedAt: event.time || Date.now(),
        pruneCount: 0,
        prunedTokens: 0,
        expanded: false,
      }))
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
        this.pushRow(represent('compaction', {
          kind: 'system',
          text: error === undefined ? t('compact.finished') : t('compact.failedNotice', { error }),
        }))
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
      this.pushRow(represent('runtime-warning', { kind: 'system', text: contextPressureAlertText(next) }))
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
    // A card left running by a Host that died would otherwise refuse /compact
    // for the rest of the session; its age decides whether it is still real.
    this.settleUnfinishedCompactions({ staleOnly: true })
    if (this.agent.status === 'running') return false
    if (this.idleCompactInFlight) return false
    if (this.compactionRunning()) return false
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
      if (reason === 'user') this.pushRow(represent('command-misuse', { kind: 'error', text: t('cmd.unknown', { command: 'compact' }) }))
      return
    }
    // A card left running by a Host that died is closed here rather than
    // refusing the user for the rest of the session: its age decides whether it
    // is still real. The footer already ignores a stale card, but the card
    // itself must stop rendering as running too.
    this.settleUnfinishedCompactions({ staleOnly: true })
    if (this.agent.status === 'running'
      || this.compactionRunning()) {
      if (reason === 'user') this.pushRow(represent('command-error', { kind: 'error', text: t('compact.busy') }))
      this.markDirty()
      return
    }
    this.idleCompactInFlight = true
    this.lastIdleCompactAt = Date.now()
    if (reason === 'idle') {
      const view = this.contextPressure
      this.pushRow(represent('command-feedback', {
        kind: 'system',
        text: view === undefined
          ? t('context.autoCompact')
          : t('context.autoCompactAt', {
            used: formatTokens(view.usedTokens),
            window: formatTokens(view.contextWindow),
            percent: view.percent.toFixed(0),
          }),
      }))
    }
    this.commandAbort?.abort()
    const controller = new AbortController()
    this.commandAbort = controller
    void commands.execute(this.agent, '/compact', [], controller.signal).then((execution) => {
      if (execution === undefined) {
        this.idleCompactInFlight = false
        if (reason === 'user') this.pushRow(represent('command-misuse', { kind: 'error', text: t('cmd.unknown', { command: 'compact' }) }))
        return
      }
      const compactionRunning = (): boolean =>
        this.compactionRunning()
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
        this.pushRow(represent('command-error', {
          kind: 'error',
          text: formatCompactCommandError(this.formatCommandText(String(execution.result.text ?? ''))),
        }))
      } else if (typeof execution.result?.text === 'string' && execution.result.text !== '') {
        this.pushRow(represent('command-feedback', { kind: 'system', text: this.formatCommandText(execution.result.text) }))
        releaseIfSettled()
      } else {
        releaseIfSettled()
      }
    }).catch((error: unknown) => {
      this.idleCompactInFlight = false
      this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command: 'compact', error: errorChain(error) }) }))
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
      this.pushRow(represent('command-event', {
        kind: 'system',
        text: wantsActive ? t('plan.requestOn') : t('plan.requestOff'),
      }))
      this.markDirty()
      return
    }
    if (name === 'compact') {
      this.status = t('compact.status')
      this.markDirty()
      return
    }
    if (name === '') return
    this.pushRow(represent('command-event', {
      kind: 'system',
      text: args === '' ? `/${name}` : `/${name} ${args}`,
    }))
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
      this.pushRow(represent('command-event', { kind: 'error', text: errText === '' ? t('command.failed') : errText }))
      if (this.status.startsWith(t('compact.short')) || this.status.startsWith('compact')) {
        this.status = this.agent.status === 'running' ? 'running' : 'idle'
      }
      if (!this.compactionRunning()) {
        this.idleCompactInFlight = false
      }
      this.markDirty()
      return
    }
    if (text !== '') {
      this.pushRow(represent('command-event', { kind: 'system', text: this.formatCommandText(text) }))
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
        this.pushRow(represent('goal', { kind: 'goal', objective: t('goal.clearedLabel'), phase: 'cleared', expanded: false }))
      }
      this.pushRow(represent('goal', { kind: 'system', text: t('goal.clearedNotice') }))
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
      this.pushRow(represent('goal', {
        kind: 'goal',
        objective,
        phase,
        ...(blockedReason === undefined ? {} : { blockedReason }),
        expanded: false,
      }))
    }
    const notice = phase === 'active' ? t('goal.set')
      : phase === 'paused' ? t('goal.pausedNotice')
      : phase === 'blocked' ? t('goal.blockedNotice')
      : t('goal.doneNotice')
    this.pushRow(represent('goal', { kind: 'system', text: `${notice}：${objective}` }))
    this.markDirty()
  }

  private pushPromptInjection(text: string, plugin?: string): void {
    const sources = promptInjectionSources(text, plugin)
    this.pushRow(represent('prompt-injection', {
      kind: 'prompt',
      sources,
      text,
      ...(plugin === undefined ? {} : { plugin }),
      expanded: false,
    }))
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
    switch (event.type) {
      case 'user/message': {
        const text = collectText(event.data.content)
        const source = (event.data as { source?: { kind?: unknown; plugin?: unknown } }).source
        const sourceKind = typeof source?.kind === 'string' ? source.kind : 'user'
        const plugin = typeof source?.plugin === 'string' ? source.plugin : undefined
        foldSubagentUserLog(row, text, sourceKind, plugin)
        break
      }
      case 'assistant/message': {
        const text = collectText(event.data.message.content)
        // Long enough to be worth opening the overlay for; the collapsed chip
        // reads `lastActivity`, not this entry.
        if (text !== '') appendSubagentLog(row, { kind: 'assistant', text: clipSubagentActivity(text, 200) })
        break
      }
      case 'tool/call': {
        if (HIDDEN_TOOL_NAMES.has(event.data.name)) break
        this.toolCallNames.set(String(event.data.callId), event.data.name)
        const present = presentToolCall(event.data.name, event.data.arguments)
        appendSubagentLog(row, {
          kind: 'tool',
          text: `▶ ${present.title} ${clipSubagentActivity(present.summary, 48)}`.trimEnd(),
          callId: String(event.data.callId),
        })
        break
      }
      case 'tool/result': {
        const ok = event.data.error === undefined && !toolResultFailed(event.data.message)
        const callId = String(event.data.message.source.callId)
        const sourceName = (event.data.message.source as { name?: unknown }).name
        const recorded = this.toolCallNames.get(callId)
          ?? (typeof sourceName === 'string' ? sourceName : '')
        const title = toolTitle(displayToolName(recorded))
        // The overlay is the only place a child's tool output can be read, so
        // keep a few lines of it — the call line itself carries the title.
        const output = truncate(collectText(event.data.message.content), 3).trim()
        appendSubagentLog(row, {
          kind: 'result',
          text: `${ok ? '✓' : '✗'} ${title}`,
          ...(output === '' ? {} : { detail: output }),
          callId,
        })
        break
      }
      case 'turn/end': {
        const reason = event.data.reason
        const error = reason.kind === 'error'
          ? String((reason as { error?: { message?: unknown } }).error?.message ?? '')
          : ''
        const explained = describeSubagentFailure({
          stopReason: reason.kind,
          message: error,
          provider: row.modelProvider ?? this.currentProviderId(),
        })
        if (explained !== undefined) row.failHint = explained.hint
        appendSubagentLog(row, {
          kind: error === '' ? 'turn' : 'result',
          text: explained === undefined
            ? (error === ''
              ? t('sub.turnEnd', { reason: reason.kind })
              : t('sub.turnEndError', { reason: reason.kind, error }))
            : explained.hint,
        })
        break
      }
      case 'approval/asked':
        appendSubagentLog(row, { kind: 'approval', text: t('sub.approval', { tool: event.data.toolName }) })
        break
      default:
        this.handleSubagentExtensionEvent(row, event)
        break
    }
    this.lastActivity = Date.now()
    this.refreshOpenSubagentInspect(row)
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
    // The spawn description is a FIFO pair (task + parent call id). A card that
    // is already linked to a spawn keeps it: only a fresh child may take the
    // oldest waiting description, or two parallel spawns swap names.
    const existing = this.findSubagentRow(sessionId)
    const pending = existing?.spawnCallId === undefined ? this.pendingSubagentTasks.shift() : undefined
    const task = pending?.task
    const modelProvider = this.subagentSelection.current.provider ?? this.currentProviderId()
    const startedText = t('sub.startedDetail', {
      provider: modelProvider,
      external: info.local ? '' : t('sub.external'),
    })
    if (existing !== undefined) {
      existing.childSessionId = sessionId
      existing.runId = String(info.runId)
      existing.provider = info.provider
      existing.modelProvider = modelProvider
      existing.local = info.local
      existing.status = 'running'
      existing.startedAt = Date.now()
      existing.endedAt = undefined
      existing.stopReason = undefined
      delete existing.failHint
      existing.lastActivity = t('sub.started')
      existing.expanded = false
      if (pending !== undefined) existing.spawnCallId = pending.callId
      if (task !== undefined) existing.task = task
      appendSubagentLog(existing, { kind: 'system', text: startedText })
      this.refreshOpenSubagentInspect(existing)
    } else {
      this.pushRow(represent('subagent-notice', {
        kind: 'subagent',
        sessionId,
        childSessionId: sessionId,
        ...(pending === undefined ? {} : { spawnCallId: pending.callId }),
        runId: String(info.runId),
        provider: info.provider,
        modelProvider,
        local: info.local,
        label: t('sub.label', { provider: info.provider }),
        ...(task === undefined ? {} : { task }),
        status: 'running',
        startedAt: Date.now(),
        lastActivity: t('sub.started'),
        logs: [{ kind: 'system', text: startedText }],
        expanded: false,
      }))
    }
    this.markDirty()
  }

  readonly handleSubagentEnd = (info: SubagentRunEndInfo): void => {
    this.activeSubagents.delete(String(info.runId))
    this.subagentSessions.delete(String(info.id))
    this.lastActivity = Date.now()
    const output = info.lastAssistantMessage === undefined
      ? ''
      : clipSubagentActivity(collectText(info.lastAssistantMessage), 80)
    const row = this.findSubagentRow(String(info.id))
      ?? this.rows.findLast((candidate): candidate is Extract<Row, { kind: 'subagent' }> =>
        candidate.kind === 'subagent' && candidate.runId === String(info.runId))
      // A chip rebuilt from the parent spawn tool has no child id yet: adopt the
      // oldest one so an end event settles it instead of adding a twin. A chip
      // replay already closed as `unknown` is adopted too, and corrected.
      ?? this.rows.find((candidate): candidate is Extract<Row, { kind: 'subagent' }> =>
        candidate.kind === 'subagent'
        && (candidate.status === 'running' || candidate.stopReason === 'unknown')
        && candidate.childSessionId === undefined)
    const failed = info.stopReason !== 'completed'
    const modelProvider = row?.modelProvider
      ?? this.subagentSelection.current.provider
      ?? this.currentProviderId()
    const explained = failed
      ? describeSubagentFailure({
        stopReason: info.stopReason,
        message: output,
        provider: modelProvider,
      })
      : undefined
    // A healthy end clears any hint an earlier failed attempt left on the row.
    const hint = explained?.hint
    const endText = hint === undefined
      ? t('sub.ended', { reason: info.stopReason }) + (output === '' ? '' : ` · ${output}`)
      : hint
    if (row !== undefined) {
      row.status = info.stopReason === 'aborted' ? 'aborted' : failed ? 'error' : 'ok'
      row.endedAt = Date.now()
      row.stopReason = info.stopReason
      row.childSessionId = String(info.id)
      row.modelProvider = modelProvider
      if (hint === undefined) delete row.failHint
      else row.failHint = hint
      appendSubagentLog(row, {
        kind: failed ? 'result' : 'assistant',
        text: endText,
      })
      this.refreshOpenSubagentInspect(row)
    } else {
      this.pushRow(represent('subagent-notice', {
        kind: 'subagent',
        sessionId: String(info.id),
        childSessionId: String(info.id),
        runId: String(info.runId),
        provider: info.provider,
        modelProvider,
        local: info.local,
        label: t('sub.label', { provider: info.provider }),
        status: info.stopReason === 'aborted' ? 'aborted' : failed ? 'error' : 'ok',
        startedAt: Date.now(),
        endedAt: Date.now(),
        stopReason: info.stopReason,
        ...(explained === undefined ? {} : { failHint: explained.hint }),
        lastActivity: endText,
        logs: [{ kind: failed ? 'result' : 'system', text: endText }],
        expanded: false,
      }))
    }
    this.markDirty()
  }

  /** Keep an open inspect overlay in sync with the live child log. */
  private refreshOpenSubagentInspect(row: Extract<Row, { kind: 'subagent' }>): void {
    const screen = this.screen
    if (screen === undefined || screen.kind !== 'inspect') return
    if (screen.subagentSessionId !== this.subagentInspectId(row)) return
    screen.title = t('sub.inspectTitle', { title: subagentDisplayName(row) })
    screen.lines = subagentInspectLines(row)
    // The body grows while the child runs, and the copy text is that body: it
    // has to move with it or the key hands back the log as it stood when the
    // Screen opened.
    screen.copyText = inspectCopyText(screen.lines)
  }

  // ── approval and questions ──────────────────────────────────────────────

  private hasLiveDisplay(): boolean {
    if (this.disposed || this.exiting) return false
    if (this.headlessDisplay || this.displayDetached) return this.displayHost?.attached === true
    return true
  }

  /**
   * Tell the absent user that a question is waiting.
   *
   * The marker file is the part that needs no configuration: it sits next to the
   * session's stderr log, so logging back into the jump host shows it before the
   * TUI is open. The command is whatever the user pointed `ssh-tui.notify` at,
   * run once; it never blocks the wait and never reports its own failure.
   */
  private announceWaitingQuestion(request: AskUserQuestionRequest): void {
    const sessionId = String(this.agent.id)
    const question = request.questions
      .map(item => item.question.trim())
      .filter(text => text !== '')
      .join(' / ')
      .slice(0, 200)
    const since = this.questionWaitSince ?? Date.now()
    void writeWaitingMarker({
      sessionId,
      count: this.queuedQuestions,
      question,
      since,
    })
    const command = this.readNotifyCommand()
    if (command === undefined) return
    const smtp = this.readNotifySmtp()
    const context: NotifyContext = {
      sessionId,
      count: this.queuedQuestions,
      question,
      waitedMs: Date.now() - since,
      resumeCommand: `dsh --profile ${profileFromArgv()} --resume ${sessionId}`,
      ...(smtp.user === undefined ? {} : { smtpUser: smtp.user }),
      ...(smtp.password === undefined ? {} : { smtpPassword: smtp.password }),
    }
    void runNotify(command, context)
  }

  /** The SMTP account `/notify smtp` saved, when the target is authenticated. */
  private readNotifySmtp(): { user?: string; password?: string } {
    const raw = readSettingsSection(this.ctx, UI_LOCALE_NAMESPACE)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const saved = raw as { notifySmtpUser?: unknown; notifySmtpPassword?: unknown }
    const user = typeof saved.notifySmtpUser === 'string' ? saved.notifySmtpUser : undefined
    const password = typeof saved.notifySmtpPassword === 'string' ? saved.notifySmtpPassword : undefined
    return {
      ...(user === undefined || user === '' ? {} : { user }),
      ...(password === undefined || password === '' ? {} : { password }),
    }
  }

  /** `DSH_TUI_NOTIFY`, else the saved `ssh-tui.notify`. Empty means off. */
  private readNotifyCommand(): string | undefined {
    const raw = readSettingsSection(this.ctx, UI_LOCALE_NAMESPACE)
    const saved = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { notify?: unknown }).notify
      : undefined
    return notifyCommand(process.env, typeof saved === 'string' ? saved : undefined)
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
    this.pushRow(represent('approval-warning', { kind: 'system', text: t('approval.mismatchNever') }))
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

  /**
   * The route the AI approval reviewer runs on: the subagent selection when it
   * matches the parent provider, else that provider's light model. Shared with
   * the verdict cache, whose key has to name the reviewer that produced a
   * verdict — a different model may decide differently.
   */
  private reviewerRoute(): { provider: string; model: string } {
    const selection = this.subagentSelection.current
    const parentProvider = this.selectionRef?.current?.provider ?? this.agent.options.provider ?? this.providerName
    const provider = selection.provider ?? parentProvider
    const model = selection.provider !== undefined || subagentModelMatchesProvider(provider, selection.model)
      ? selection.model
      : defaultSubagentModelForProvider(provider, [], this.selectionRef?.current?.model)
    return { provider, model }
  }

  /**
   * The cache key for one `ask`-shaped request, or `undefined` when the shape
   * must not be remembered (no command, or an opaque interpreter payload).
   */
  private approvalCacheKey(
    request: ApprovalRequest,
    command: string | undefined,
    args: string | undefined,
  ): string | undefined {
    if (command === undefined) return undefined
    const input: VerdictKeyInput = {
      toolName: request.toolName,
      command,
      args,
      reason: request.reason,
      sandboxMode: this.hostSandboxMode,
      agentId: String(request.agent.id),
      workspaceCwd: this.workspaceCwd(),
      locale: getLocale(),
      reviewer: this.reviewerRoute(),
      authorization: this.latestUserAuthorizationText(request.agent),
    }
    return cacheableShape(input) ? verdictKey(input) : undefined
  }

  private async reviewUnknownWithModel(
    request: ApprovalRequest,
    command: string | undefined,
    args: string | undefined,
  ): Promise<ReviewVerdict | undefined> {
    const llm = this.ctx.get('llm')
    if (llm === undefined) return undefined
    const { provider, model } = this.reviewerRoute()
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
        source: { kind: TUI_SOURCE_KIND },
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
      this.pushRow(represent('approval-warning', {
        kind: 'system',
        text: t('approval.reviewFailed', { error: errorChain(error) }),
      }))
      this.markDirty()
      return undefined
    }
    const verdict = parseReviewOutput(text)
    if (verdict === undefined) {
      const preview = text.trim() === '' ? t('approval.reviewNoReply') : text.trim()
      this.pushRow(represent('approval-warning', {
        kind: 'system',
        text: t('approval.reviewUnparsed', { output: preview.slice(0, 160) }),
      }))
      this.markDirty()
      return undefined
    }
    this.pushRow(represent('approval-warning', {
      kind: 'system',
      text: t('approval.reviewRow', {
        verdict: verdict.approved ? t('approval.reviewApproved') : t('approval.reviewRejected'),
        risk: verdict.risk,
        authorization: verdict.authorization,
        reason: verdict.reason,
      }),
    }))
    this.markDirty()
    return verdict
  }

  private recordAutoApproval(
    decision: 'allow' | 'deny',
    risk: 'low' | 'medium' | 'high',
    toolName: string,
    command: string | undefined,
    reason: string,
    fromCache?: { fromCache: true; ageMs: number },
  ): void {
    if (decision === 'allow') this.autoAllowedCount += 1
    else this.autoDeniedCount += 1
    const subject = (command ?? '').trim() !== ''
      ? command!.replace(/\s+/gu, ' ').trim()
      : toolName
    const clipped = Array.from(subject).length > 160
      ? `${Array.from(subject).slice(0, 160).join('')}…`
      : subject
    const rowText = fromCache === undefined
      ? t('approval.decisionRow', {
          verdict: decision === 'allow' ? t('approval.reviewApproved') : t('approval.reviewRejected'),
          command: clipped,
          risk,
          reason,
        })
      : t('approval.cacheHitRow', {
          age: formatShortDuration(fromCache.ageMs),
          verdict: decision === 'allow' ? t('approval.reviewApproved') : t('approval.reviewRejected'),
          command: clipped,
          risk,
          reason,
        })
    // A grant is an acknowledgement (footer chip); a refusal is the one the reader
    // must not miss (notice row). Neither is a transcript row: the decision's
    // durable home is the tool card it guarded, rebuilt from the Harness's audit
    // pair, so a permanent sentence here would be a second representation of the
    // same event — and one nothing can rebuild (B2.4).
    this.pushRow(represent(decision === 'allow' ? 'approval-allowance' : 'approval-notice', { kind: 'system', text: rowText }))
    this.markDirty()
    if (decision === 'deny') this.tellModelApprovalDenied(clipped, reason, rowText)
  }

  /**
   * Host ApprovalOutcome cannot carry a reason, so the model only sees
   * `the user rejected tool "bash"`. Steer a plugin notice with the real
   * classifier/reviewer reason. Summary matches the workspace decision row
   * so the handler does not paint the body twice.
   *
   * This notice is committed to the session, so it is exactly the injection a
   * V4 log refuses when it wears the released `plugin` wrapper — see
   * {@link TUI_SOURCE_KIND}.
   */
  private tellModelApprovalDenied(command: string, reason: string, summary: string): void {
    if (this.replaying || this.agentGone) return
    const text = t('approval.modelDenied', { command, reason })
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: TUI_SOURCE_KIND, form: 'notice', summary },
    })
    try {
      if (this.agent.status === 'running') this.agent.steer(message)
      else this.agent.followup(message)
    } catch {
      // Outcome already settled; a missing notice only loses the extra hint.
    }
  }

  /**
   * The card an approval request guards, marked as *being asked*.
   *
   * Waiting is a live-only state: it is true while a Host is holding the request
   * open, and a replay can never claim it (see `approval/asked`). Set here rather
   * than in the auto path so a manual prompt and an automatic decision both show
   * the same thing on the card while the decision is being made.
   * @param request - the pending approval.
   * @param provenance - who is deciding: a person (`live`) or this plugin (`policy`).
   */
  private markApprovalWaiting(request: ApprovalRequest, provenance: 'live' | 'policy'): void {
    if (request.callId === undefined) return
    this.setToolApproval(String(request.callId), {
      state: 'waiting',
      provenance,
      ...(provenance === 'policy' ? { auto: true } : {}),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    })
  }

  /**
   * Record the decision on the card it guarded.
   *
   * `provenance` is the strongest source that produced it: `policy` for a rule, a
   * cached verdict or a reviewer, `live` for the person at the keyboard. The
   * Harness's own `approval/decided` event follows this on the same turn and says
   * strictly less, so `mergeApproval` lets this win (B2.4).
   */
  private settleToolApproval(
    request: ApprovalRequest,
    outcome: ApprovalOutcome,
    provenance: 'live' | 'policy',
  ): void {
    if (request.callId === undefined) return
    const state = outcome === 'allowed-once' ? 'approved' : outcome === 'rejected' ? 'rejected' : 'unknown'
    this.setToolApproval(String(request.callId), {
      state,
      provenance,
      ...(provenance === 'policy' ? { auto: true } : {}),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    })
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
      this.markApprovalWaiting(request, 'policy')
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
        this.settleToolApproval(request, 'allowed-once', 'policy')
        return 'allowed-once'
      }
      if (classified.decision === 'deny') {
        this.recordAutoApproval('deny', classified.risk, request.toolName, command, ruleReason)
        this.settleToolApproval(request, 'rejected', 'policy')
        return 'rejected'
      }
      // Unknown shape: the rule table cannot judge it — hand it to the
      // subagent-configured model with compact context (AI review). A verdict
      // this TUI already produced for the exact same request (tool, command,
      // arguments, workspace, reviewer, and the user message that authorized
      // it) is reused inside its TTL instead of paying for the review again.
      const cacheKey = this.approvalCacheKey(request, command, row?.args)
      const cached = cacheKey === undefined ? undefined : this.approvalCache.lookup(cacheKey)
      if (cached !== undefined) {
        this.cacheHitCount += 1
        this.recordAutoApproval(
          cached.verdict.approved ? 'allow' : 'deny',
          cached.verdict.risk,
          request.toolName,
          command,
          cached.verdict.reason === ''
            ? cached.verdict.approved ? t('approval.reviewApproved') : t('approval.reviewRejected')
            : cached.verdict.reason,
          { fromCache: true, ageMs: cached.ageMs },
        )
        const cachedOutcome: ApprovalOutcome = cached.verdict.approved ? 'allowed-once' : 'rejected'
        this.settleToolApproval(request, cachedOutcome, 'policy')
        return cachedOutcome
      }
      const reviewed = await this.reviewUnknownWithModel(request, command, row?.args)
      if (reviewed !== undefined && cacheKey !== undefined) this.approvalCache.store(cacheKey, reviewed)
      if (reviewed?.approved === true) {
        this.recordAutoApproval(
          'allow',
          reviewed.risk,
          request.toolName,
          command,
          reviewed.reason === '' ? t('approval.reviewApproved') : reviewed.reason,
        )
        this.settleToolApproval(request, 'allowed-once', 'policy')
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
        this.settleToolApproval(request, 'rejected', 'policy')
        return 'rejected'
      }
      if (!this.hasLiveDisplay()) {
        this.detachedDeniedCount += 1
        this.recordAutoApproval('deny', 'medium', request.toolName, command, t('approval.ruleDetached'))
        this.settleToolApproval(request, 'rejected', 'policy')
        return 'rejected'
      }
    }
    if (!this.hasLiveDisplay()) {
      try {
        await this.waitForLiveDisplay(request.signal)
      } catch {
        this.settleToolApproval(request, 'cancelled', 'live')
        return 'cancelled'
      }
    }
    const agentLabel = t('sub.agentLabel', { name: this.subagentNameFor(String(request.agent.id)) })
    return new Promise<ApprovalOutcome>((resolve) => {
      if (request.signal?.aborted === true) {
        // Asked and abandoned: the card says so rather than guessing a verdict.
        this.settleToolApproval(request, 'cancelled', 'live')
        resolve('cancelled')
        return
      }
      let dialog: ConfirmDialog | undefined
      const onAbort = (): void => {
        request.signal?.removeEventListener('abort', onAbort)
        if (dialog !== undefined) {
          this.settleToolApproval(request, 'cancelled', 'live')
          this.abortConfirm(dialog)
        }
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      this.markApprovalWaiting(request, 'live')
      dialog = this.openConfirm(
        t('approval.prompt', {
          tool: request.toolName,
          agent: agentLabel,
          reason: request.reason === undefined ? '' : `\n${request.reason}`,
        }),
        t('approval.hint'),
        (answer) => {
          request.signal?.removeEventListener('abort', onAbort)
          const outcome: ApprovalOutcome = answer === 'y' ? 'allowed-once' : answer === 'n' ? 'rejected' : 'cancelled'
          // The reader's own decision, said by the reader — the strongest source
          // there is, so it is never relabelled by the event that records it.
          this.settleToolApproval(request, outcome, 'live')
          resolve(outcome)
        },
        'approval',
      )
    })
  }

  /**
   * Answer a question whose window closed but whose call the Session still holds.
   *
   * `ctx.userQuestions.answer(agent, callId, batch)` is the Harness's own channel
   * for this: it steers a `user-question-reply` message into the agent, and that
   * message is what closes the question in the projection. Two preconditions come
   * from the service, not from us — the agent must be the session's live runtime
   * root, and the question must still be `continued` — so a refusal here is
   * reported rather than retried.
   * @param row - the focused question card.
   * @returns true when the card consumed the key.
   */
  private answerContinuedQuestion(row: Extract<Row, { kind: 'question' }>): boolean {
    if (row.continued !== true || row.status !== 'waiting' || row.callId === undefined) return false
    const service = this.ctx.get('userQuestions') as unknown as
      | {
        answer?: (
          agent: unknown,
          callId: string,
          answer: { answers: { id: string; selected: string[]; custom?: string }[] },
        ) => boolean
      }
      | undefined
    if (service?.answer === undefined) {
      this.pushRow(represent('question-notice', { kind: 'error', text: t('question.continuedUnavailable') }))
      this.markDirty()
      return true
    }
    const callId = row.callId
    // Not `askQuestion`: that one is the control-plane helper. Answering a
    // question the task is still holding is the task waiting for a person.
    void this.openQuestionAs(
      {
        id: row.questionId,
        question: row.title,
        ...(row.header === undefined ? {} : { header: row.header }),
        ...(row.detail === undefined ? {} : { detail: row.detail }),
        // The original choices: the answer has to keep the call's own shape, and a
        // question re-opened without them would be answered as free text.
        ...(row.options === undefined ? {} : { options: row.options }),
        ...(row.multiSelect === true ? { multiSelect: true } : {}),
      },
      interactionRole('question'),
    ).then(answer => {
      const batch = {
        answers: [{
          id: row.questionId,
          selected: answer.selected,
          ...(answer.custom === undefined ? {} : { custom: answer.custom }),
        }],
      }
      let accepted = false
      try {
        accepted = service.answer?.(this.agent, callId, batch) === true
      } catch (error) {
        this.pushRow(represent('question-notice', { kind: 'error', text: t('question.continuedFailed', { error: errorChain(error) }) }))
        this.markDirty()
        return
      }
      if (!accepted) {
        this.pushRow(represent('question-notice', { kind: 'error', text: t('question.continuedGone') }))
        this.markDirty()
      }
    }).catch(() => undefined)
    return true
  }

  /**
   * The text field a surface borrowed, when the surface needs typed input.
   *
   * The composer's draft used to *be* every dialog's text field: a free-text
   * answer, a setup field and a picker's search all wrote `this.input`. That made
   * "what does this string mean" depend on which mode happened to be active, and
   * a paste or a cancelled answer could overwrite the message the reader was
   * writing. A surface that needs text now gets its own field; the composer keeps
   * its draft until the composer is the thing being typed into.
   */
  private borrowedText: { text: string; cursor: number } | undefined

  /** Whether this dialog types into a field of its own rather than the composer. */
  private dialogNeedsText(dialog: Dialog): boolean {
    // A list answers with its highlight and its hotkeys; only a question with no
    // options is answered by typing.
    if (dialog.kind === 'questions') return (dialog.question.options?.length ?? 0) === 0
    return false
  }

  /** Give a text-needing dialog its own field. The composer draft stays put. */
  private borrowTextFor(dialog: Dialog): void {
    if (this.dialogNeedsText(dialog)) this.borrowedText ??= { text: '', cursor: 0 }
    else this.releaseBorrowedText()
  }

  private releaseBorrowedText(): void {
    this.borrowedText = undefined
  }

  /** The text the keyboard is editing: a borrowed field, or the composer draft. */
  private fieldText(): string {
    return this.borrowedText?.text ?? this.input
  }

  private fieldCursor(): number {
    return this.borrowedText?.cursor ?? this.cursor
  }

  /** Write the field the keyboard is editing, wherever it lives. */
  private setField(text: string, cursor: number): void {
    if (this.borrowedText === undefined) {
      this.input = text
      this.cursor = cursor
      return
    }
    this.borrowedText.text = text
    this.borrowedText.cursor = cursor
  }

  /** Insert at the caret of whichever field owns the keyboard. */
  private insertIntoField(text: string): void {
    const current = this.fieldText()
    const at = this.fieldCursor()
    this.setField(`${current.slice(0, at)}${text}${current.slice(at)}`, at + text.length)
  }

  /** One card's key: a call's batch can repeat a question id across calls. */
  private questionCardKey(callId: string | undefined, questionId: string): string {
    return `${callId ?? `live:${this.liveQuestionSeq}`}\u0000${questionId}`
  }

  /**
   * The Session's durable question view, when the projection is registered.
   *
   * `ctx.sessionProjections` is driven by `@deepseek-ai/dsh-user-questions`, which
   * folds `tool/call` + `tool/result` (and late replies) into
   * `{ active, settled }`. Absent in a bare Context — a test, an embedder without
   * the projection package — which is why every caller here has a live fallback.
   */
  private questionProjection(): QuestionView | undefined {
    const registry = this.ctx.get('sessionProjections') as unknown as
      | { stateOf?: (session: unknown, key: string) => unknown }
      | undefined
    if (registry?.stateOf === undefined) return undefined
    try {
      return questionViewOf(registry.stateOf(this.agent.session, 'userQuestions'))
    } catch {
      return undefined
    }
  }

  /**
   * Draw the cards the Session log can account for.
   *
   * Called for the events that can change question state, live and replayed alike,
   * so the two paths produce the same transcript. It never removes a card: a card
   * is history once it is drawn, and a call the projection cannot see (the legacy
   * blocking schema, or no projection at all) is the live path's to own.
   */
  private syncQuestionRows(): void {
    const view = this.questionProjection()
    if (view === undefined) return
    for (const record of durableQuestionRecords(view, callId => this.askedByCall.get(callId))) {
      this.applyQuestionRecord(record)
    }
  }

  /** One durable record onto its card, creating the card the first time. */
  private applyQuestionRecord(record: DurableQuestionRecord): void {
    const card = this.ensureQuestionCard(record.callId, record.question)
    if (card === undefined) return
    card.durable = true
    const answered = record.state === 'answered' || record.state === 'cancelled'
    card.status = record.state === 'answered'
      ? 'answered'
      : record.state === 'cancelled' ? 'cancelled' : 'waiting'
    if (record.state === 'continued') {
      card.continued = true
      card.summary = t('question.continued')
    } else if (answered) {
      card.continued = false
      card.summary = answerSummaryText(record.answers)
    } else {
      card.continued = false
      card.summary = record.question.question
    }
    this.markDirty()
  }

  /**
   * The card for one call's question, created from its structured form if new.
   *
   * A **plan review** gets none (B2.5 §7): it is the plan artifact's interaction, not
   * an ordinary ask, and the artifact already has a row — the same review drawn as
   * both a question summary and a plan state is the duplicate this round removes. The
   * Surface (the dialog) is unchanged, and `dsh-plan-mode` identifies the review by the
   * `exit_plan_mode` call it belongs to, which the projection reads.
   * @returns the card, or undefined when the question belongs to another artifact.
   */
  private ensureQuestionCard(
    callId: string | undefined,
    question: AskUserQuestionItem,
  ): Extract<Row, { kind: 'question' }> | undefined {
    if (planReviewOf(question)) return undefined
    const key = this.questionCardKey(callId, question.id)
    const existing = this.questionCards.get(key)
    if (existing !== undefined) return existing
    // A live request that carries no call id — the legacy blocking schema, or a
    // host line whose answerer is not handed one — still belongs to a call the
    // Session may already have recorded. Reusing that card is what keeps the
    // question from being drawn twice, and the second copy is not only noise: it
    // appends a row, which moves the transcript window the reader is looking at.
    if (callId === undefined) {
      for (const [otherKey, other] of this.questionCards) {
        if (other.durable === true && otherKey.endsWith(`\u0000${question.id}`)) return other
      }
    }
    const card: Extract<Row, { kind: 'question' }> = {
      kind: 'question',
      questionId: question.id,
      ...(callId === undefined ? {} : { callId }),
      title: question.question,
      ...(question.header === undefined ? {} : { header: question.header }),
      ...(question.detail === undefined ? {} : { detail: question.detail }),
      intent: planReviewOf(question) ? 'plan-review' : 'ask',
      ...(question.options === undefined ? {} : { options: question.options }),
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
      status: 'waiting',
      summary: question.question,
      expanded: false,
    }
    this.questionCards.set(key, card)
    this.pushRow(represent('question-card', card))
    return card
  }

  readonly handleUserQuestions = async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
    if (!this.hasLiveDisplay()) {
      // Counted here, not read off the rows: the card is built only after the
      // wait resolves, so at reattach time a queued question has no row yet.
      this.queuedQuestions += 1
      this.questionWaitSince ??= Date.now()
      // The user learns about the wait from a marker file and, when they
      // configured one, a command. Both run after the counter moves, so a
      // reconnect during either still sees the question as queued.
      this.announceWaitingQuestion(request)
      try {
        await this.waitForLiveDisplay(request.signal)
      } finally {
        this.queuedQuestions -= 1
        if (this.queuedQuestions === 0) {
          this.questionWaitSince = undefined
          void clearWaitingMarker(String(this.agent.id))
        }
      }
    }
    const answers: AskUserQuestionAnswer['answers'] = []
    const agentLabel = request.agent === undefined || request.agent.id === this.agent.id
      ? undefined
      : t('sub.agentLabel', { name: this.subagentNameFor(String(request.agent.id)) })
    // The request carries the call for a timed question, which is what the Session
    // records; a legacy blocking call has none, and its card is the live path's.
    // `wait` is how a *timed* question names its call, and it exists from
    // 0.2.0-rc.2 on: the older lines type `AskUserQuestionRequest` without it (and
    // never set it, which is why a legacy blocking call's card is the live path's).
    // Read structurally so the same source compiles against every declared line.
    const wait = (request as { wait?: { callId?: unknown } }).wait
    const callId = wait?.callId === undefined ? undefined : String(wait.callId)
    if (callId !== undefined) this.askedByCall.set(callId, request.questions)
    const cards = request.questions
      .map(question => this.ensureQuestionCard(callId, question))
      .filter((card): card is Extract<Row, { kind: 'question' }> => card !== undefined)
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
          dialog = this.openQuestion(
            labeled,
            index,
            request.questions.length,
            (selection) => {
              request.signal?.removeEventListener('abort', onAbort)
              resolve(selection)
            },
            fail,
            undefined,
            undefined,
            undefined,
            interactionRole(planReviewOf(question) ? 'plan-review' : 'question'),
          )
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

  /**
   * Queue one dialog behind an already-open one instead of overwriting it.
   *
   * The active surface is never replaced: whoever owns the keyboard keeps it until
   * it is answered or cancelled, so a picker can never cover a question (and a
   * question can never silently discard a half-made choice). What priority decides
   * is the *line*: a task interaction takes the keyboard ahead of a picker that was
   * already waiting, because someone is blocked on it. Ranks are compared, not
   * stacked — equal ranks keep arrival order.
   */
  private openDialog(dialog: Dialog | InspectDialog, role: SurfaceRole): void {
    // The single judgement (B2.1). A Screen is not a dialog, so it must not enter
    // this queue: a report and a queued question can then never be flushed in the
    // same frame, and a Surface can never be replaced by a Screen. Nothing in this
    // file opens one this way any more — the door is closed so that a future call
    // site cannot open it by accident.
    if (dialog.kind === 'inspect') {
      const asScreen = screenFromDialog(dialog)
      if (asScreen !== undefined) this.openScreen(asScreen)
      return
    }
    if (this.dialog === undefined && this.screen === undefined) {
      this.dialog = dialog
      this.dialogRole = role
      this.borrowTextFor(dialog)
      this.echoLineModeDialog(dialog)
    } else {
      const rank = surfacePriority(role)
      const at = this.dialogQueue.findIndex(entry => surfacePriority(entry.role) < rank)
      if (at === -1) this.dialogQueue.push({ dialog, role })
      else this.dialogQueue.splice(at, 0, { dialog, role })
    }
    this.markDirty()
  }

  private showNextDialog(): void {
    if (this.dialog !== undefined) return
    const next = this.dialogQueue.shift()
    if (next !== undefined) {
      this.dialog = next.dialog
      this.dialogRole = next.role
      this.borrowTextFor(next.dialog)
      this.echoLineModeDialog(next.dialog)
      this.markDirty()
    }
  }

  /**
   * Line mode has no framed dialog. Write the prompt (and its keys) into the
   * log once when it becomes active, so a `tee` or a screen reader can answer
   * it. Options stay on the framed path; the log only needs the question.
   */
  private echoLineModeDialog(dialog: Dialog): void {
    if (!this.lineMode) return
    if (dialog.kind === 'confirm') {
      this.pushRow(represent('surface-echo', { kind: 'system', text: dialog.prompt }))
      this.pushRow(represent('surface-echo', { kind: 'system', text: dialog.hint }))
      return
    }
    if (dialog.kind === 'questions') {
      const header = t('dialog.ask', {
        index: dialog.index + 1,
        total: dialog.total,
        question: dialog.question.question,
      })
      this.pushRow(represent('surface-echo', { kind: 'system', text: header }))
      if (dialog.question.header !== undefined && dialog.question.header !== '') {
        this.pushRow(represent('surface-echo', { kind: 'system', text: dialog.question.header }))
      }
      const options = dialog.question.options ?? []
      for (const [index, option] of options.entries()) {
        if (option === undefined) continue
        const key = QUESTION_OPTION_KEYS[index] ?? String(index + 1)
        const extra = option.description === undefined ? '' : ` — ${option.description}`
        this.pushRow(represent('surface-echo', { kind: 'system', text: `  ${key} ${option.label}${extra}` }))
      }
      this.pushRow(represent('surface-echo', {
        kind: 'system',
        text: options.length === 0
          ? t('dialog.freeform')
          : dialog.question.multiSelect === true ? t('dialog.multiHint') : t('dialog.singleHint'),
      }))
      return
    }
  }

  private removeQueuedDialog(dialog: Dialog): void {
    const index = this.dialogQueue.findIndex(entry => entry.dialog === dialog)
    if (index !== -1) this.dialogQueue.splice(index, 1)
  }

  private settleQuestion(dialog: QuestionDialog, finish: () => void): void {
    if (this.dialog === dialog) {
      this.dialog = undefined
      this.dialogRole = PICKER_ROLE
      this.releaseBorrowedText()
    } else {
      this.removeQueuedDialog(dialog)
    }
    finish()
    this.showNextDialog()
    this.markDirty()
  }

  private openConfirm(
    prompt: string,
    hint: string,
    resolve: (value: 'y' | 'n' | 'cancel') => void,
    ask: InteractionKind = 'confirm',
  ): ConfirmDialog {
    const dialog: ConfirmDialog = { kind: 'confirm', prompt, hint, resolve }
    this.openDialog(dialog, interactionRole(ask))
    return dialog
  }

  private closeConfirm(value: 'y' | 'n' | 'cancel'): void {
    const dialog = this.dialog
    if (dialog === undefined || dialog.kind !== 'confirm') return
    this.dialog = undefined
    this.dialogRole = PICKER_ROLE
    this.releaseBorrowedText()
    dialog.resolve(value)
    this.showNextDialog()
    this.markDirty()
  }

  /** Resolve one queued or active confirm from its abort signal. */
  private abortConfirm(dialog: ConfirmDialog): void {
    if (this.dialog === dialog) {
      this.dialog = undefined
      this.dialogRole = PICKER_ROLE
      this.releaseBorrowedText()
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
    matchKeys?: readonly string[],
    onCursor?: (cursor: number) => void,
    role: SurfaceRole = PICKER_ROLE,
  ): QuestionDialog {
    // A list opens with its first option already chosen: Enter then answers that
    // default for a single- and a multi-select question alike, instead of
    // coming back with an empty selection. Esc stays the explicit cancel, and a
    // question with no options still answers with the typed text.
    const optionCount = question.options?.length ?? 0
    const initial = preselected !== undefined && preselected >= 0 && preselected < optionCount
      ? preselected
      : optionCount > 0 ? 0 : -1
    // A single-select list opens with its first option chosen, so Enter answers
    // that default (and moving the highlight moves the `●`).
    //
    // A **multi-select** list must open with nothing chosen. It used to inherit
    // the same default, and the result was the worst kind of mis-answer: the
    // reader moved the highlight to the row they wanted, pressed Enter, and got
    // the first row — because `●` still sat on it. `questionSubmit` already
    // falls back to the highlighted row when nothing is marked, which is exactly
    // the "this one" the reader meant; the inherited selection was what kept that
    // fallback from firing. The caller can still pass an explicit preselection.
    const initialSelection = initialQuestionSelection(question, preselected)
    const dialog: QuestionDialog = {
      kind: 'questions',
      question,
      index,
      total,
      selected: new Set(initialSelection),
      cursor: initial >= 0 ? initial : 0,
      ...(matchKeys === undefined ? {} : { matchKeys }),
      ...(onCursor === undefined ? {} : { onCursor }),
      resolve: (selection) => {
        this.settleQuestion(dialog, () => resolve(selection))
      },
      reject: (error) => {
        this.settleQuestion(dialog, () => reject(error))
      },
    }
    this.openDialog(dialog, role)
    return dialog
  }

  /**
   * Open one control-plane question and await its answer (cancellation rejects).
   *
   * Every `/model`-style menu goes through here, which is why the role is
   * `picker`: the agent is neither waiting nor interrupted by a menu that only
   * changes the environment.
   */
  private askQuestion(
    question: AskUserQuestionItem,
    index = 0,
    total = 1,
    preselected?: number,
    matchKeys?: readonly string[],
    onCursor?: (cursor: number) => void,
  ): Promise<DialogAnswer> {
    return new Promise<DialogAnswer>((resolve, reject) => {
      this.openQuestion(question, index, total, resolve, reject, preselected, matchKeys, onCursor, PICKER_ROLE)
    })
  }

  /** One question dialog with an explicit role, awaited by the caller. */
  private openQuestionAs(question: AskUserQuestionItem, role: SurfaceRole): Promise<DialogAnswer> {
    return new Promise<DialogAnswer>((resolve, reject) => {
      this.openQuestion(question, 0, 1, resolve, reject, undefined, undefined, undefined, role)
    })
  }

  /** The stored llm-pi-ai profile for one provider route, when settings provide one. */
  private piAiProviderProfile(provider: string): LlmPiAiProviderProfile | undefined {
    if (provider === 'deepseek-official') return undefined
    const section = readSettingsSection(this.ctx, settingsNamespace('llm-pi-ai')) as LlmPiAiSection | null | undefined
    return section?.providers?.[provider]
  }

  /**
   * Every settings-backed row one gateway family occupies, base first.
   *
   * `llm-pi-ai` puts the wire protocol on the provider entry, so a gateway
   * whose catalogue spans protocols (Command Code, OpenCode Go) is stored as
   * sibling rows. To the user they are one supplier: the TUI lists, picks and
   * remembers them under the family's base id, and files each picked model on
   * the row that actually serves it.
   *
   * The `-responses` / `-completions` / `-messages` suffix is only a naming
   * convention, so a row is adopted into the family only when it corroborates:
   * it must speak the protocol its suffix names, point at the same endpoint,
   * and (when both name one) carry the same display name. A provider someone
   * legitimately called `foo-messages` on another host therefore stays its own
   * supplier instead of vanishing from `/provider` behind `foo`. A family of
   * one — the ordinary case, and a sibling whose base row is missing — stays
   * exactly as configured.
   */
  private providerFamilyRows(provider: string): string[] {
    if (provider === '') return []
    const base = baseProviderIdOf(provider)
    const baseRow = this.piAiProviderProfile(base)
    const rows = [base]
    for (const protocol of GATEWAY_PROTOCOL_PREFERENCE) {
      const sibling = siblingProviderId(base, protocol)
      if (sibling === provider || rows.includes(sibling)) {
        if (this.isFamilyRow(baseRow, sibling, protocol)) rows.push(sibling)
        continue
      }
      if (this.isFamilyRow(baseRow, sibling, protocol)) rows.push(sibling)
    }
    const present = rows.filter(row => this.piAiProviderProfile(row) !== undefined)
    if (present.length <= 1) {
      // A lone sibling is not a family — it is just this provider.
      return baseRow !== undefined || present.includes(provider) ? present : [provider]
    }
    return present
  }

  /**
   * Whether `sibling` is genuinely the same gateway as `base`, on another
   * protocol: its `api` matches its suffix, its endpoint matches the base row's,
   * and the two labels agree when both are set.
   */
  private isFamilyRow(
    baseRow: LlmPiAiProviderProfile | undefined,
    sibling: string,
    protocol: GatewayProtocol,
  ): boolean {
    if (baseRow === undefined) return false
    const profile = this.piAiProviderProfile(sibling)
    if (profile === undefined) return false
    const endpoint = (value: unknown): string =>
      typeof value === 'string' ? value.replace(/\/+$/u, '').toLowerCase() : ''
    const api = declaredProtocol(profile.api)
    if (api !== undefined && api !== protocol) return false
    const baseUrl = endpoint(baseRow.baseURL)
    const siblingUrl = endpoint(profile.baseURL)
    if (baseUrl !== '' && siblingUrl !== '' && baseUrl !== siblingUrl) return false
    const baseLabel = typeof baseRow.displayName === 'string' ? baseRow.displayName.trim() : ''
    const siblingLabel = typeof profile.displayName === 'string' ? profile.displayName.trim() : ''
    if (baseLabel !== '' && siblingLabel !== '' && baseLabel !== siblingLabel) return false
    return true
  }

  /** The id the TUI shows for a route: its family's base when it is spread. */
  private displayProviderId(provider: string): string {
    const rows = this.providerFamilyRows(provider)
    return rows.length > 1 ? (rows[0] ?? provider) : provider
  }

  /** The models one row configures, as ids with the labels settings carry. */
  private configuredModelsOf(row: string): { id: string; label?: string }[] {
    const models = this.piAiProviderProfile(row)?.models
    if (!Array.isArray(models)) return []
    const out: { id: string; label?: string }[] = []
    for (const raw of models) {
      if (typeof raw === 'string') {
        if (raw !== '') out.push({ id: raw })
        continue
      }
      if (raw === null || typeof raw !== 'object') continue
      const entry = raw as { id?: unknown; name?: unknown }
      if (typeof entry.id !== 'string' || entry.id === '') continue
      out.push({
        id: entry.id,
        ...(typeof entry.name === 'string' && entry.name !== '' ? { label: entry.name } : {}),
      })
    }
    return out
  }

  /**
   * The protocols the gateway publishes for one model, best-effort.
   *
   * Used when a model is being filed but no picker listed it yet (`/model <id>`
   * on a new id, a `--model` override, a `/submodel` pin): the gateway's own
   * answer is the only thing that can put it on a route that can send it.
   * Any failure is "no opinion", never a blocked selection.
   */
  private async advertisedFor(family: string, model: string): Promise<GatewayProtocol[]> {
    const rows = this.providerFamilyRows(family)
    if (rows.length <= 1) return []
    // A model the last listing already filed needs no second opinion, and that
    // is the common case: `/model` re-picking a listed model must never wait on
    // the gateway again. Only an unlisted id (a hand-typed one, a `--model`
    // override) asks, and even then the wait is bounded — an unreachable gateway
    // must not stall a selection for the endpoint's full timeout.
    if (this.familyModelOwner.has(`${family}\u0000${model}`)) return []
    if (this.configuredModelsOf(rows[0] ?? family).some(entry => entry.id === model)) return []
    try {
      const listing = await this.discoverGatewayListing(rows[0] ?? family, AbortSignal.timeout(5_000))
      return advertisedProtocols(listing.endpoints, model)
    } catch {
      return []
    }
  }

  /**
   * The row of a gateway family that serves `model`: the one learned from the
   * last listing, else the one that already configures it, else the base —
   * where a brand-new model lands and is re-filed from.
   */
  /**
   * Record which row a family's model belongs to, keeping the map bounded.
   *
   * Re-inserting keeps a key fresh, and the oldest half is dropped once the cap
   * is crossed, so a gateway whose catalogue is re-listed on every `/model`
   * does not accumulate a second copy of itself each time.
   */
  private rememberFamilyOwner(base: string, model: string, row: string): void {
    const key = `${base}\u0000${model}`
    this.familyModelOwner.delete(key)
    this.familyModelOwner.set(key, row)
    if (this.familyModelOwner.size <= FAMILY_OWNER_CACHE_MAX) return
    let remaining = Math.floor(FAMILY_OWNER_CACHE_MAX / 2)
    for (const oldest of this.familyModelOwner.keys()) {
      if (remaining <= 0) break
      this.familyModelOwner.delete(oldest)
      remaining -= 1
    }
  }

  private familyOwnerRow(base: string, model: string, advertised?: readonly GatewayProtocol[]): string {
    const rows = this.providerFamilyRows(base)
    if (rows.length <= 1) return base
    // What the gateway itself says comes first: a model no row configures and
    // no picker listed (`/model <id>` on a new id, a `--model` override) still
    // has a protocol, and filing it anywhere else makes the guard below refuse
    // a model the gateway is happy to serve.
    for (const protocol of advertised ?? []) {
      const row = rows.find(candidate => declaredProtocol(this.piAiProviderProfile(candidate)?.api) === protocol)
      if (row !== undefined) return row
    }
    // The row that actually served the model in the last listing is evidence,
    // not a hint: it is the row the gateway said could send it. A row that
    // merely has the model configured used to win here, which sent an explicit
    // `/model <id>` back to the protocol the listing had just ruled out (the
    // completions row is still listed first for a stale responses entry).
    const learned = this.familyModelOwner.get(`${base}\u0000${model}`)
    if (learned !== undefined && rows.includes(learned)) return learned
    // No listing this run (a direct `/model <id>`, or an unreachable gateway):
    // keep the placement that is already configured. A model on two rows takes
    // the first, which is the family's own preference order — the same order
    // the wizard would file it under.
    for (const row of rows) {
      if (this.configuredModelsOf(row).some(entry => entry.id === model)) return row
    }
    return rows[0] ?? base
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
   *
   * A row speaks exactly one protocol (`api` on the provider entry), so with a
   * gateway that publishes `supported_endpoints` the list is narrowed to the
   * models that row can actually serve — otherwise `/model` on
   * `command-code-messages` would offer, and then persist, a model that only
   * answers `/responses`.
   */
  private async discoverEndpointModels(provider: string): Promise<{ id: string; label: string }[]> {
    const protocol = declaredProtocol(this.piAiProviderProfile(provider)?.api)
    // Interactive callers get a shorter budget than the wizard's: `/model`
    // falling back to the configured list after a few seconds reads as "this
    // gateway is unreachable", while 15s reads as "the TUI hung".
    const { models, endpoints } = await this.discoverGatewayListing(provider, AbortSignal.timeout(6_000))
    return models.filter(model => gatewayServesModel(endpoints, model.id, protocol))
  }

  /**
   * One gateway's own model listing: every model the endpoint returns plus the
   * route table it publishes. The caller narrows it to a protocol; a gateway
   * spread over rows asks once and files the answer per row, so opening a
   * picker costs one listing instead of one per sibling.
   */
  private async discoverGatewayListing(provider: string, signal?: AbortSignal): Promise<{
    models: { id: string; label: string }[]
    endpoints: ReadonlyMap<string, readonly string[]> | undefined
  }> {
    const llmPiAi = readSettingsSection(this.ctx, settingsNamespace('llm-pi-ai'))
    const profile = this.piAiProviderProfile(provider)
    const source = openCodeSourceFor(provider, llmPiAi)
    const baseURL = typeof profile?.baseURL === 'string' && profile.baseURL.trim() !== ''
      ? profile.baseURL.trim()
      : this.openCodeListingBaseURL(provider)
    if (baseURL === undefined) return { models: [], endpoints: undefined }
    const api = typeof profile?.api === 'string' && profile.api.trim() !== '' ? profile.api.trim() : undefined
    const apiKeyEnv = typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv.trim() !== ''
      ? profile.apiKeyEnv.trim()
      : source?.apiKeyEnv
    const apiKey = apiKeyEnv === undefined ? undefined : await this.resolveCredential(apiKeyEnv)
    const llm = this.ctx.get('llm')
    if (llm === undefined) return { models: [], endpoints: undefined }
    const [discovered, endpoints] = await Promise.all([
      discoverProviderModels(llm, {
        baseURL,
        ...(api === undefined ? {} : { api }),
        ...(apiKey === undefined ? {} : { apiKey }),
      }, signal ?? AbortSignal.timeout(15_000)).catch(() => [] as DiscoveredModel[]),
      apiKey === undefined ? Promise.resolve(undefined) : fetchModelEndpoints(baseURL, apiKey, signal),
    ])
    // The route table is the point of asking a gateway that publishes one: it is
    // what files each model on the protocol that can actually send it, and the
    // discovered list alone cannot. A gateway whose listing answered from the
    // installed catalog still gets its endpoints read here, and a gateway that
    // publishes no table keeps the discovered list as-is.
    const named = new Map(discovered.map(model => [model.id, model.name || model.id]))
    const models = endpoints === undefined
      ? discovered.map(model => ({ id: model.id, label: model.name || model.id }))
      : [...endpoints.keys()].map(id => ({ id, label: named.get(id) ?? id }))
    return { models, endpoints }
  }

  /**
   * The row of the same gateway that the gateway itself says serves `model`,
   * when that is not the row the caller is on. `undefined` when the gateway has
   * no opinion, when the current row already serves it, or when the model would
   * need a row that does not exist yet.
   */
  private rowServingModel(
    provider: string,
    modelId: string,
    endpoints: ReadonlyMap<string, readonly string[]> | undefined,
  ): string | undefined {
    const protocol = declaredProtocol(this.piAiProviderProfile(provider)?.api)
    if (gatewayServesModel(endpoints, modelId, protocol)) return undefined
    const wanted = advertisedProtocols(endpoints, modelId)[0]
    if (wanted === undefined) return undefined
    // The base id is a row of its own: use it when it already speaks `wanted`,
    // otherwise the sibling that does.
    const base = baseProviderIdOf(provider)
    const rows = declaredProtocol(this.piAiProviderProfile(base)?.api) === wanted
      ? [base, siblingProviderId(base, wanted)]
      : [siblingProviderId(base, wanted)]
    for (const row of rows) {
      if (row !== provider && this.piAiProviderProfile(row) !== undefined) return row
    }
    return undefined
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
    // Reached by a direct `/model <id>` too, where the picker's own filter never
    // ran: refuse to store a model this row's protocol cannot serve, and say
    // which sibling row can.
    const protocol = declaredProtocol(profile.api)
    const baseURL = typeof profile.baseURL === 'string' && profile.baseURL.trim() !== ''
      ? profile.baseURL.trim()
      : this.openCodeListingBaseURL(provider)
    if (protocol !== undefined && baseURL !== undefined) {
      const apiKeyEnv = typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.trim() !== '' ? profile.apiKeyEnv.trim() : undefined
      const apiKey = apiKeyEnv === undefined ? undefined : await this.resolveCredential(apiKeyEnv)
      const endpoints = apiKey === undefined ? undefined : await fetchModelEndpoints(baseURL, apiKey)
      if (!gatewayServesModel(endpoints, modelId, protocol)) {
        const target = this.rowServingModel(provider, modelId, endpoints)
        // Report both names: the family is what `/provider` offers, the row is
        // what the settings file calls it. Sending the user to a hidden row was
        // a dead end — `/provider` lists families, so the hint names the family
        // and `/model` (which files the pick on the right row itself).
        const family = this.displayProviderId(provider)
        this.pushRow(represent('command-error', {
          kind: 'error',
          text: t('model.wrongRoute', {
            model: modelId,
            provider: family === provider ? provider : `${family}（${provider}）`,
            endpoint: GATEWAY_PROTOCOL_ENDPOINT[protocol],
            hint: target === undefined
              ? t('model.wrongRouteSetup')
              : t('model.wrongRouteTarget', { provider: family }),
          }),
        }))
        this.markDirty()
        return false
      }
    }
    const modelEntry: Record<string, unknown> = { id: modelId }
    // A model added here skips the wizard, so size it from the installed
    // catalog the same way `/setup` does; the route default covers a miss.
    const catalogWindows = this.catalogWindowIndexSource()
    if (catalogWindows.size > 0) {
      const contextWindow = catalogContextWindow(modelId, catalogWindows)
      if (contextWindow !== undefined) modelEntry.contextWindow = contextWindow
    }
    // Same rule `/setup` follows: a route whose dialect the installed catalog
    // does not describe must still declare its offered levels, or the Harness
    // reads the model as non-reasoning and refuses every effort the TUI offers.
    const reasoningEfforts = reasoningEffortsForDefault(profile.reasoning)
      ?? (declaresOfferedReasoning(typeof profile.api === 'string' ? profile.api : '') ? handDeclaredReasoningEfforts() : undefined)
    if (reasoningEfforts !== undefined) modelEntry.reasoningEfforts = reasoningEfforts
    try {
      await settings.mutate(settingsNamespace('llm-pi-ai'), [
        { op: 'set', path: ['providers', provider, 'models'], value: [...models, modelEntry] },
      ])
      this.pushRow(represent('command-status', { kind: 'system', text: t('model.added', { model: modelId, provider: this.displayProviderId(provider) }) }))
      this.markDirty()
      return true
    } catch (error) {
      this.pushRow(represent('command-error', { kind: 'error', text: t('model.addFailed', { model: modelId, error: errorChain(error) }) }))
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
    const current = this.displayProviderId(this.currentProviderId())
    const seen = new Set<string>()
    const out: { id: string; label: string }[] = []
    const add = (id: string, name?: string): void => {
      if (id === '') return
      // A gateway spread over protocol rows is one choice here: the rows are an
      // implementation detail of `llm-pi-ai` (one wire protocol per entry), not
      // something the user should have to pick between.
      const row = this.displayProviderId(id)
      if (row === '' || seen.has(row)) return
      seen.add(row)
      const kind = describeProviderRoute(row)
      const display = name !== undefined && name !== '' && name !== row ? name : kind.short
      out.push({ id: row, label: `${display} · ${row}` })
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
    const family = this.providerFamilyRows(provider)
    if (family.length > 1) return this.loadFamilyModelOptions(family[0] ?? provider, family)
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

  /**
   * The model list of a gateway spread over protocol rows.
   *
   * Every row is asked what it serves and the answers are merged under the
   * family's base id, so the user picks from one list. Each model remembers the
   * row that offered it, which is what routes the pick back to the protocol
   * that can actually send it — the split stays invisible end to end.
   */
  private async loadFamilyModelOptions(
    base: string,
    family: readonly string[],
  ): Promise<{ options: { id: string; label: string }[]; source: string }> {
    const llm = this.ctx.get('llm')
    const options: { id: string; label: string }[] = []
    const seen = new Set<string>()
    const add = (row: string, id: string, label?: string): void => {
      if (id === '' || seen.has(id)) return
      seen.add(id)
      this.rememberFamilyOwner(base, id, row)
      options.push({ id, label: label !== undefined && label !== '' ? label : id })
    }
    const previousStatus = this.status
    this.status = t('model.fetching', { provider: base })
    this.markDirty()
    try {
      // The gateway's own listing is what decides which row serves what, so it
      // is answered first and `add` keeps the first row that claims an id. Doing
      // the configured rows first would let a leftover entry on the base row
      // shadow the sibling the gateway actually files the model under — the
      // picker would then show a model under a protocol that cannot send it,
      // and `/model` would write it back onto that row.
      const listings = await this.discoverGatewayListing(base, AbortSignal.timeout(6_000)).catch(() => undefined)
      if (listings !== undefined) {
        for (const row of family) {
          const protocol = declaredProtocol(this.piAiProviderProfile(row)?.api)
          for (const model of listings.models) {
            if (gatewayServesModel(listings.endpoints, model.id, protocol)) add(row, model.id, model.label)
          }
        }
      }
      // Whatever the endpoint did not answer: the rows that already configure a
      // model keep it (so a gateway that is down still offers its own list).
      for (const row of family) {
        for (const model of this.configuredModelsOf(row)) add(row, model.id, model.label)
      }
      // Models the installed catalog knows but neither source listed.
      for (const row of family) {
        try {
          for (const model of (await llm?.listModels(row)) ?? []) add(row, model.id, model.name || model.id)
        } catch {
          // The endpoint listing stands alone when the catalog cannot be read.
        }
      }
    } finally {
      this.status = previousStatus
      this.markDirty()
    }
    if (options.length === 0) {
      const remembered = this.rememberedRoute(base)?.model
      if (remembered !== undefined) options.push({ id: remembered, label: remembered })
    }
    return { options, source: options.length > 0 ? t('model.live') : t('model.configured') }
  }

  /** /model: models and effort for the current provider only. */
  private async runModelCommand(): Promise<void> {
    const provider = this.currentProviderId()
    // The list is the whole family's; the question names the gateway, not the
    // protocol row the current request happens to use.
    const display = this.displayProviderId(provider)
    const current = this.selectionRef?.current
    const loaded = await this.loadModelOptions(provider)
    let modelOptions = loaded.options
    if (current?.model !== undefined && !modelOptions.some(option => option.id === current.model)) {
      modelOptions = [{ id: current.model, label: current.model }, ...modelOptions]
    }
    const selected = await this.pickModelOption(modelOptions, display, loaded.source, current?.model)
    if (selected === undefined) return
    await this.applyModelSelection(provider, selected.id, modelOptions.map(option => option.id))
  }

  /** /provider: pick a provider, then its model (remembered route pre-filled). */
  private async runProviderCommand(): Promise<void> {
    const providers = this.listSelectableProviders()
    // The list holds family ids, so the highlight must be asked for in the same
    // vocabulary: a session on `command-code-messages` otherwise matched no row
    // and fell back to index 0, pre-selecting the wrong supplier.
    const current = this.displayProviderId(this.currentProviderId())
    if (providers.length === 0) {
      this.pushRow(represent('command-misuse', { kind: 'error', text: t('provider.none') }))
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
    const section = readSettingsSection(this.ctx, ROUTE_MEMORY_NS)
    const memory = section !== null && typeof section === 'object' && !Array.isArray(section)
      ? parseRouteMemory((section as Record<string, unknown>).providers)
      : {}
    return rememberedRouteFor(memory, provider)
  }

  /** The route this session is running right now, record-shaped. */
  private sessionRouteRecord(): Omit<SessionRoute, 'updatedAt'> | undefined {
    const current = this.selectionRef?.current
    const subagent = this.subagentSelection.current
    // Shaped by the launcher's own builder, so what the TUI reports and what the
    // launcher writes cannot drift apart.
    return sessionRouteInput({
      provider: current?.provider ?? this.currentProviderId(),
      model: current?.model ?? this.agent.options.model ?? '',
      ...(current?.reasoningEffort === undefined ? {} : { reasoningEffort: String(current.reasoningEffort) }),
      subagent: {
        ...(subagent.provider === undefined ? {} : { provider: subagent.provider }),
        model: subagent.model,
        ...(subagent.reasoningEffort === undefined ? {} : { reasoningEffort: String(subagent.reasoningEffort) }),
      },
    })
  }

  /**
   * Tell the launcher which route this session has settled on, so resuming it
   * comes back on the same supplier — the subagent route included, which is what
   * makes a resumed cross-provider conversation reproducible.
   *
   * Reported when a route settles (`/model`, `/submodel`, `/setup`) and at the
   * start of every turn, which catches a preset or a settings edit moving the
   * route behind the TUI's back. The launcher owns the file; the TUI only says
   * what changed, and says nothing when nothing did.
   */
  private noteSessionRoute(): void {
    const route = this.sessionRouteRecord()
    if (route === undefined) return
    if (sameSessionRoute(this.lastSessionRoute, route)) return
    this.lastSessionRoute = { ...route, updatedAt: Date.now() }
    this.onRouteSettled?.(route)
  }

  private async rememberRoute(selection: ModelSelection): Promise<void> {
    // The session's record is kept even when the settings service is missing:
    // coming back to this conversation on the same supplier is the point of it.
    this.noteSessionRoute()
    const settings = this.ctx.get('settings')
    if (settings === undefined) return
    const section = readSettingsSection(this.ctx, ROUTE_MEMORY_NS)
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
    // One gateway, one choice: the picker offers the family's merged list, and
    // the row that actually serves the model is resolved here so the selection
    // lands on a route whose protocol can send it. The family base id is what
    // the user sees and what the route memory remembers.
    const display = this.displayProviderId(provider)
    const target = this.familyOwnerRow(display, modelId, await this.advertisedFor(display, modelId))
    if (!(await this.ensureProviderModelConfigured(target, modelId))) return
    const llm = this.ctx.get('llm')
    const current = this.selectionRef?.current
    let effortOptions: { id: string; label: string }[] = []
    try {
      const info = await llm?.resolveModelInfo(target, modelId)
      effortOptions = (info?.reasoning?.efforts ?? []).map(effort => ({ id: String(effort.id), label: effort.name }))
    } catch {
      effortOptions = []
    }
    if (effortOptions.length === 0 && providerUsesLocalOAuth(target)) {
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

    const rememberedEffort = this.rememberedRoute(display)?.reasoningEffort ?? preferredEffort ?? ''
    const currentEffort = current?.provider === target
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
    if (isUndeclared && effort !== undefined) await this.declareReasoningEffort(target, modelId, effort)

    const next: ModelSelection = {
      provider: target,
      model: modelId,
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
    }
    if (this.selectionRef !== undefined) this.selectionRef.current = next
    this.onSelectionChanged?.(next)
    await this.persistDefaultSelection(next)
    await this.rememberRoute({ ...next, provider: display })
    const kind = describeProviderRoute(display)
    const effortText = effort ?? t('effort.defaultShort')
    const note = isUndeclared && effort !== undefined ? t('effort.manualNote') : ''
    this.pushRow(represent('command-feedback', {
      kind: 'system',
      text: t('effort.switchedModel', { kind: kind.kind, provider: display, model: modelId, effort: effortText, note }),
    }))
    const listedIds = listed.filter(id => id !== '__switch_provider__' && id !== '')
    const previousProvider = current?.provider ?? this.agent.options.provider ?? this.providerName
    if (this.displayProviderId(previousProvider) !== display) {
      await this.syncSubagentToProvider(display, listedIds, true)
      this.clearQuotaForProvider(target)
      void this.refreshQuota({ reason: 'command', announce: false }).catch(() => {})
    } else {
      await this.syncSubagentToProvider(display, listedIds)
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
        await settings.replace(AGENT_DEFAULT_MODEL_NS, {
          provider: next.provider,
          model: next.model,
          ...(next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) }),
        })
        return true
      } catch (error: unknown) {
        this.pushRow(represent('command-error', {
          kind: 'error',
          text: t('model.persistFailSettings', { error: errorChain(error) }),
        }))
        this.markDirty()
        return false
      }
    }
    this.pushRow(represent('command-error', { kind: 'error', text: t('model.persistFailNone') }))
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
   *
   * A `/submodel` pin is the user's explicit route, so a parent switch asks
   * before moving the children: dropping the pin silently spends on a route
   * they pinned away from, and keeping it silently leaves the children on the
   * old provider.
   */
  private async syncSubagentToProvider(
    provider: string,
    listed: readonly string[] = [],
    force = false,
  ): Promise<void> {
    // Children follow the family the user sees, not the protocol row the parent
    // request happens to use.
    provider = this.displayProviderId(provider)
    const current = this.subagentSelection.current
    if (current.provider !== undefined) {
      if (!force) return
      if (await this.confirmKeepSubagentPin(provider, current)) return
    }
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
    this.pushRow(represent('command-feedback', {
      kind: 'system',
      text: t('sub.followed', { provider, model: nextModel, sessionOnly: persisted ? '' : t('sub.sessionOnly') }),
    }))
  }

  /**
   * Ask whether a `/submodel` pin survives a parent provider change.
   *
   * Returns true when the pin should be kept. Cancelling the dialog keeps it
   * too: the pin is the user's explicit choice, so only an explicit answer
   * moves the children onto the new parent route.
   */
  private async confirmKeepSubagentPin(
    provider: string,
    current: SubagentSelection,
  ): Promise<boolean> {
    const pinned = this.displayProviderId(current.provider ?? '')
    const keepLabel = t('sub.followKeepLabel', { provider: pinned })
    const followLabel = t('sub.followSwitchLabel', { provider })
    const answer = await this.askQuestion({
      id: 'submodel-follow-pick',
      question: t('sub.followAsk', { pinned, provider, model: current.model }),
      options: [
        { label: keepLabel, description: t('sub.followKeepHint') },
        { label: followLabel, description: t('sub.followSwitchHint', { provider }) },
      ],
    }, 0, 1, 0)
    if (answer.selected[0] === followLabel) return false
    this.pushRow(represent('command-feedback', { kind: 'system', text: t('sub.pinKept', { pinned, parent: provider }) }))
    this.markDirty()
    return true
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
    // An explicit change makes the settings the source again: the next time
    // this session is resumed, the record — not a stale in-memory override —
    // decides, and the settings watcher may update the ref again.
    this.subagentSelection.source = 'settings'
    // The session record keeps the subagent route too, so a resumed
    // cross-provider conversation comes back on the same children.
    this.noteSessionRoute()
    const settings = this.ctx.get('settings')
    if (settings === undefined) {
      this.pushRow(represent('subagent-notice', { kind: 'error', text: t('sub.settingsMissing') }))
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
    const family = this.providerFamilyRows(provider)
    if (family.length > 1) return this.loadFamilyModelOptions(family[0] ?? provider, family)
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
    const current = this.subagentSelection.current
    const direct = arg.trim()
    if (direct.toLowerCase() === 'reset' || direct === '跟随' || direct === '默认') {
      const parentProvider = this.displayProviderId(this.currentProviderId())
      const nextModel = defaultSubagentModelForProvider(
        parentProvider,
        [],
        this.selectionRef?.current?.model ?? this.agent.options.model,
      )
      const persisted = await this.saveSubagentSelection({
        model: nextModel,
        reasoningEffort: undefined,
      })
      this.pushRow(represent('command-feedback', {
        kind: 'system',
        text: t('sub.followed', { provider: parentProvider, model: nextModel, sessionOnly: persisted ? '' : t('sub.sessionOnly') }),
      }))
      this.markDirty()
      return
    }

    const slash = direct.indexOf('/')
    if (slash > 0) {
      const providerId = direct.slice(0, slash).trim()
      const modelId = direct.slice(slash + 1).trim()
      if (providerId !== '' && modelId !== '') {
        await this.commitSubagentRoute(providerId, modelId, { pinProvider: true })
        return
      }
    }

    let provider = this.displayProviderId(this.effectiveSubagentProvider())
    let selectedId = direct

    if (selectedId === '') {
      const parentProvider = this.displayProviderId(this.currentProviderId())
      const providers = this.listSelectableProviders()
      const currentIndex = Math.max(0, providers.findIndex(option => option.id === provider))
      const pinnedProvider = this.displayProviderId(current.provider ?? '')
      const pickedAnswer = await this.askQuestion({
        id: 'submodel-provider-pick',
        question: t('sub.pickProvider'),
        options: providers.map(option => ({
          label: option.label,
          // The description says what picking the row does. Picking the parent's
          // provider follows it — that is the one explicit way to unpin without
          // `/submodel reset` — so the parent row must not read "currently
          // pinned" just because the pin happens to name it.
          description: option.id === parentProvider
            ? t('sub.providerFollowsParent')
            : option.id === pinnedProvider
              ? t('sub.providerPinned')
              : describeProviderRoute(option.id).kind,
        })),
      }, 0, 1, currentIndex)
      const pickedProvider = providers.find(option => option.label === pickedAnswer.selected[0])?.id
      if (pickedProvider === undefined) return
      provider = pickedProvider
      const { options, source } = await this.subagentModelOptions(provider)
      if (options.length === 0) {
        options.push({ id: current.model, label: current.model })
      }
      const selected = await this.pickModelOption(options, provider, source, current.model)
      if (selected === undefined) return
      selectedId = selected.id
    }
    await this.commitSubagentRoute(provider, selectedId, {
      pinProvider: provider !== this.displayProviderId(this.currentProviderId()),
    })
  }

  /** Persist one subagent provider/model pair and say whether it follows or is pinned. */
  private async commitSubagentRoute(
    provider: string,
    modelId: string,
    options: { pinProvider: boolean },
  ): Promise<void> {
    // The picker lists one row per gateway family; the model decides which
    // protocol row underneath actually serves it.
    const display = this.displayProviderId(provider)
    const target = this.familyOwnerRow(display, modelId, await this.advertisedFor(display, modelId))
    if (!(await this.ensureProviderModelConfigured(target, modelId))) return
    const effort = this.subagentSelection.current.reasoningEffort
    const next: SubagentSelection = {
      ...(options.pinProvider ? { provider: target } : {}),
      model: modelId,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }
    const persisted = await this.saveSubagentSelection(next)
    this.pushRow(represent('command-feedback', {
      kind: 'system',
      text: (options.pinProvider
        ? t('sub.modelPinned', { model: modelId, provider: display })
        : t('sub.modelFollow', { model: modelId, provider: display }))
        + (persisted ? '' : t('sub.sessionOnly')),
    }))
    this.markDirty()
  }

  /** /effort: pick or set the reasoning effort for the current model. */
  private async runEffortCommand(arg?: string): Promise<void> {
    const provider = this.currentProviderId()
    const display = this.displayProviderId(provider)
    const current = this.selectionRef?.current
    if (current === undefined || current.model === undefined) {
      this.pushRow(represent('command-misuse', { kind: 'error', text: t('effort.noModel') }))
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
        this.pushRow(represent('command-misuse', { kind: 'error', text: t('effort.unknown', { id: (arg ?? '').trim() }) }))
        this.markDirty()
        return
      }
      const allowed: readonly string[] = declaredOptions.length === 0
        ? UNDECLARED_EFFORT_IDS
        : declaredOptions.map(option => option.id)
      if (parsed.kind === 'id' && !allowed.includes(parsed.id)) {
        this.pushRow(represent('command-misuse', { kind: 'error', text: t('effort.unknown', { id: parsed.id }) }))
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
        ? t('effort.pickCurrentUndeclared', { provider: display, model: modelId })
        : t('effort.pickCurrent', { provider: display, model: modelId }),
      options: choices.map(c => ({
        label: c.label,
        description: c.id === currentEffort ? t('disconnect.current') : c.desc,
      })),
    }, 0, 1, currentIndex)

    const picked = choices.find(c => c.label === answer.selected[0])
    if (picked === undefined) return
    await this.setReasoningEffort(provider, modelId, picked.id, isUndeclared)
  }

  /**
   * Persist one explicitly chosen level as a model's `reasoningEfforts`.
   *
   * `/effort` offers `low`…`max` for a model whose route declares nothing, but
   * the selection alone cannot make the request legal: the Harness still
   * resolves the model as non-reasoning and refuses it. Writing the chosen
   * level — merged with whatever the entry already declares — keeps the
   * selection and the declaration consistent. Only a route that explicitly
   * speaks OpenAI Completions is amended: its dialect omits the parameter for
   * `off` and was verified against a gateway, while another protocol may
   * materialize an unset level as a value its endpoint refuses.
   * @returns whether the entry now declares the level.
   */
  private async declareReasoningEffort(provider: string, modelId: string, effort: string): Promise<boolean> {
    const settings = this.ctx.get('settings')
    const profile = this.piAiProviderProfile(provider)
    if (settings === undefined || profile === undefined) return false
    if (profile.api !== 'openai-completions') return false
    const models = Array.isArray(profile.models) ? [...profile.models] : []
    const index = models.findIndex(raw => modelEntryId(raw) === modelId)
    const existing: Record<string, unknown> = index >= 0 && typeof models[index] === 'object' && models[index] !== null
      ? { ...(models[index] as Record<string, unknown>) }
      : {}
    const declared = existing.reasoningEfforts
    const efforts: Record<string, unknown> = typeof declared === 'object' && declared !== null && !Array.isArray(declared)
      ? { ...(declared as Record<string, unknown>) }
      : {}
    if (efforts[effort] === effort && 'off' in efforts) return true
    const entry: Record<string, unknown> = {
      ...existing,
      id: modelId,
      reasoningEfforts: { ...efforts, off: null, [effort]: effort },
    }
    if (index >= 0) models[index] = entry
    else models.push(entry)
    try {
      await settings.mutate(settingsNamespace('llm-pi-ai'), [
        { op: 'set', path: ['providers', provider, 'models'], value: models },
      ])
      return true
    } catch (error) {
      this.pushRow(represent('command-error', { kind: 'error', text: t('effort.declareFailed', { provider, model: modelId, error: errorChain(error) }) }))
      this.markDirty()
      return false
    }
  }

  private async setReasoningEffort(
    provider: string,
    modelId: string,
    effort: string | undefined,
    isUndeclared: boolean,
  ): Promise<void> {
    if (isUndeclared && effort !== undefined) await this.declareReasoningEffort(provider, modelId, effort)
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
    this.pushRow(represent('command-feedback', {
      kind: 'system',
      text: t('effort.updated', { provider, model: modelId, effort: effortText, note }),
    }))
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
        this.pushRow(represent('command-misuse', { kind: 'error', text: t('effort.unknown', { id: (arg ?? '').trim() }) }))
        this.markDirty()
        return
      }
      const allowed: readonly string[] = effortOptions.length === 0
        ? UNDECLARED_EFFORT_IDS
        : effortOptions.map(option => option.id)
      if (parsed.kind === 'id' && !allowed.includes(parsed.id)) {
        this.pushRow(represent('command-misuse', { kind: 'error', text: t('effort.unknown', { id: parsed.id }) }))
        this.markDirty()
        return
      }
      const targetEffort = parsed.kind === 'default' ? undefined : parsed.id
      if (effortOptions.length === 0 && targetEffort !== undefined) {
        await this.declareReasoningEffort(provider, current.model, targetEffort)
      }
      const next: SubagentSelection = {
        ...current,
        ...(targetEffort === undefined ? { reasoningEffort: undefined } : { reasoningEffort: ReasoningEffortId(targetEffort) }),
      }
      const persisted = await this.saveSubagentSelection(next)
      this.pushRow(represent('command-feedback', {
        kind: 'system',
        text: `${targetEffort === undefined
          ? t('effort.subDefault')
          : t('effort.subSwitched', { effort: targetEffort })}${persisted ? '' : t('effort.sessionOnly')}`,
      }))
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
    if (effortOptions.length === 0 && picked.id !== undefined) {
      await this.declareReasoningEffort(provider, current.model, picked.id)
    }

    const next: SubagentSelection = {
      ...current,
      ...(picked.id === undefined
        ? { reasoningEffort: undefined }
        : { reasoningEffort: ReasoningEffortId(picked.id) }),
    }
    const persisted = await this.saveSubagentSelection(next)
    this.pushRow(represent('command-feedback', {
      kind: 'system',
      text: `${picked.id === undefined
        ? t('effort.subDefault')
        : t('effort.subSwitched', { effort: picked.id })}${persisted ? '' : t('effort.sessionOnly')}`,
    }))
    this.markDirty()
  }

  /** /language or /lang: persist zh/en and repaint chrome immediately. */
  private async runLanguageCommand(arg: string): Promise<void> {
    const direct = localeFromTag(arg)
    let next: Locale | undefined = direct
    if (next === undefined && arg.trim() !== '') {
      this.pushRow(represent('command-misuse', { kind: 'error', text: t('lang.unknown', { id: arg.trim() }) }))
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
      this.pushRow(represent('command-error', { kind: 'error', text: t('lang.settingsMissing') }))
    } else {
      await this.mergeUiSettings({ language: next })
      applySavedLocale({ language: next })
    }
    this.forceFullPaint = true
    this.pushRow(represent('command-feedback', { kind: 'system', text: t('lang.switched', { name: localeDisplayName(next) }) }))
    this.markDirty()
  }

  /** /view: detailed (see the work) vs compact (Codex-like summary). */
  private async runViewCommand(arg: string): Promise<void> {
    const direct = parseWorkspaceView(arg)
    let next: WorkspaceView | undefined = direct
    if (next === undefined && arg.trim() !== '') {
      this.pushRow(represent('command-misuse', { kind: 'error', text: t('view.unknown', { id: arg.trim() }) }))
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
    this.pushRow(represent('command-feedback', { kind: 'system', text: t('view.switched', { name: next === 'compact' ? t('view.compact') : t('view.detailed') }) }))
    this.markDirty()
  }

  /**
   * /notify: where a question waiting on an absent user is announced.
   *
   * No argument shows what is configured. `off` clears it. `mail`, `smtp` and
   * `local` store the command that target needs; the SMTP password is kept
   * beside it and handed to the command through the environment, so it is never
   * part of the command string.
   */
  private async runNotifyCommand(arg: string): Promise<void> {
    const target = parseNotifyTarget(arg)
    if (target === undefined) {
      this.pushRow(represent('command-usage', { kind: 'error', text: t('notify.usage') }))
      this.markDirty()
      return
    }
    if (target.kind === 'off' && arg.trim() === '') {
      const current = this.readNotifyCommand()
      this.pushRow(represent('command-status', {
        kind: 'system',
        text: current === undefined ? t('notify.statusOff') : t('notify.statusOn', { command: current }),
      }))
      this.markDirty()
      return
    }
    if (target.kind === 'off') {
      await this.mergeUiSettings({ notify: '', notifySmtpUser: '', notifySmtpPassword: '' })
      this.pushRow(represent('command-feedback', { kind: 'system', text: t('notify.cleared') }))
      this.markDirty()
      return
    }
    await this.mergeUiSettings({
      notify: notifyTargetCommand(target),
      notifySmtpUser: target.kind === 'smtp' ? target.user ?? '' : '',
      notifySmtpPassword: target.kind === 'smtp' ? target.password ?? '' : '',
    })
    this.pushRow(represent('command-feedback', { kind: 'system', text: t('notify.saved', { target: notifyTargetLabel(target) }) }))
    this.markDirty()
  }

  /** /disconnect: pause (default) or continue the turn after SSH drop. */
  /**
   * Say where an auth failure came from, and retry it if the user asked for that.
   *
   * `code: "AUTH"` collapses two opposite situations (see `auth-failure.ts`), and
   * the host does not retry either of them: a provider-side 401/403 that lasted
   * 45 seconds killed two turns in a row on 2026-09-29 while the same key, model
   * and route answered 200 straight afterwards. The hint costs nothing and the
   * retry is opt-in, because resending a long session re-sends its whole context.
   */
  private reportAuthFailure(message: string): void {
    if (this.replaying) return
    // The reasoning-replay 400 is an upstream bug with its own workarounds, so it
    // gets its own sentence rather than the auth advice.
    if (isReasoningReplayFailure(message)) {
      this.pushRow(represent('auth-notice', { kind: 'system', text: t('auth.reasoningReplay') }))
      this.markDirty()
      return
    }
    // The bare sibling: the gateway refused the request and said nothing else. It
    // gets its own sentence for the same reason, and deliberately no retry — see
    // `isRequestRejectedFailure` for the measurements behind that.
    if (isRequestRejectedFailure(message)) {
      this.pushRow(represent('auth-notice', { kind: 'system', text: t('auth.requestRejected') }))
      this.markDirty()
      return
    }
    const classified = classifyAuthFailure(message)
    if (classified === undefined) return
    void this.explainAuthFailure(classified)
  }

  private async explainAuthFailure(classified: AuthFailure): Promise<void> {
    const provider = this.currentProviderId()
    const envRef = provider === 'deepseek-official' ? 'DEEPSEEK_API_KEY' : envRefForId(provider)
    const configured = (await this.resolveCredential(envRef)) !== undefined
    if (classified.origin === 'provider' && configured) {
      this.pushRow(represent('auth-notice', {
        kind: 'system',
        text: t('auth.providerRejected', {
          env: envRef,
          status: classified.status === undefined ? '' : `HTTP ${classified.status}`,
        }),
      }))
    } else {
      this.pushRow(represent('auth-notice', { kind: 'system', text: t('auth.credentialMissing', { env: envRef }) }))
    }
    const retryable = classified.origin === 'provider' && configured
      && this.retryProviderAuthEnabled() && this.authRetryArmed
      && this.lastUserText !== '' && this.agent.status !== 'running'
    if (!retryable) {
      this.markDirty()
      return
    }
    this.authRetryArmed = false
    const text = this.lastUserText
    // Cleared first: the retry starts its own turn, and a second failure inside
    // it must not fire another attempt.
    this.lastUserText = ''
    this.pushRow(represent('auth-notice', { kind: 'system', text: t('auth.retryOnce') }))
    this.beginWait()
    this.agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    this.markDirty()
  }

  /** Whether the opt-in retry is on (`/retryauth`, the settings form, or the env). */
  private retryProviderAuthEnabled(): boolean {
    const raw = String(process.env.DSH_TUI_RETRY_PROVIDER_AUTH ?? '').trim().toLowerCase()
    if (['1', 'true', 'on', 'yes'].includes(raw)) return true
    if (['0', 'false', 'off', 'no'].includes(raw)) return false
    const saved = readSettingsSection(this.ctx, UI_LOCALE_NAMESPACE)
    if (saved !== null && typeof saved === 'object' && !Array.isArray(saved)) {
      const value = (saved as { retryProviderAuth?: unknown }).retryProviderAuth
      if (typeof value === 'boolean') return value
      const text = String(value ?? '').trim().toLowerCase()
      if (['1', 'true', 'on', 'yes'].includes(text)) return true
      if (['0', 'false', 'off', 'no'].includes(text)) return false
    }
    return false
  }

  /** Whether anything the reader typed reached this session (used on exit). */
  sessionHadUserInput(): boolean {
    return this.sawUserInput
  }

  /**
   * `/cleanup [--dry-run]` — delete sessions that never saw user input.
   *
   * Every fresh start creates a session, so quitting without typing leaves an
   * artifact behind. The picker hides those, but the web session list reads the
   * same files without that filter, which is how an unused session still shows
   * up in another profile's menu. This walks the whole history once and deletes
   * the blank ones (the listing prunes as it resolves, which is the same rule the
   * picker applies).
   */
  private async runCleanupCommand(arg: string): Promise<void> {
    const dryRun = arg.trim() === '--dry-run'
    if (arg.trim() !== '' && !dryRun) {
      this.pushRow(represent('command-usage', { kind: 'error', text: t('cleanup.usage') }))
      this.markDirty()
      return
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      this.pushRow(represent('command-error', { kind: 'error', text: t('cleanup.unavailable') }))
      this.markDirty()
      return
    }
    this.pushRow(represent('command-feedback', { kind: 'system', text: t(dryRun ? 'cleanup.scanning' : 'cleanup.working') }))
    this.markDirty()
    const result = await pruneBlankSessions(persistence, String(this.agent.session.id), { dryRun })
    this.pushRow(represent('command-feedback', {
      kind: 'system',
      text: t(dryRun ? 'cleanup.dryRun' : 'cleanup.done', {
        pruned: String(result.pruned),
        kept: String(result.kept),
        unreadable: String(result.unreadable),
      }),
    }))
    this.markDirty()
  }

  /** The theme saved in the `ssh-tui` settings section, if any. */
  private readThemeName(): string | undefined {
    const raw = readSettingsSection(this.ctx, UI_LOCALE_NAMESPACE)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const value = (raw as { theme?: unknown }).theme
    const name = String(value ?? '').trim()
    return name === '' ? undefined : name
  }

  /**
   * `/theme [name]` — list the palettes, or switch to one and remember it.
   *
   * Switching repaints from the row cache, so it costs one frame rather than a
   * re-render of the transcript; `mono` exists for terminals where colour is the
   * problem rather than the answer, and it keeps every difference as an
   * attribute instead of throwing the difference away.
   */
  private async runThemeCommand(arg: string): Promise<void> {
    const wanted = arg.trim().toLowerCase()
    if (wanted === '') {
      // A picker, not a list: ↑/↓ paints the candidate palette straight away, so
      // the reader judges it on their own transcript (and their own terminal)
      // before committing. Esc restores what they had — the same browse-preview-
      // revert flow Crush's theme picker offers, and the reason `onCursor` exists.
      const names = themeNames()
      const before = this.theme
      const apply = (name: string): void => {
        this.theme = setActiveTheme(name)
        // Every cached line carries a token from the old palette: repaint from
        // scratch rather than diffing against colours that no longer apply.
        this.forceFullPaint = true
        this.markDirty()
      }
      let picked: string | undefined
      try {
        const answer = await this.askQuestion({
          id: 'theme-pick',
          question: t('theme.pick'),
          options: names.map(name => ({ label: name, description: themeByName(name)?.name === before.name ? t('theme.currentTag') : '' })),
        }, 0, 1, Math.max(0, names.indexOf(before.name)), undefined, cursor => {
          const name = names[cursor]
          if (name !== undefined) apply(name)
        })
        picked = answer.selected[0]
      } catch {
        apply(before.name)
        this.pushRow(represent('command-feedback', { kind: 'system', text: t('theme.cancelled', { name: before.name }) }))
        this.markDirty()
        return
      }
      const next = themeByName(picked) ?? before
      apply(next.name)
      await this.mergeUiSettings({ theme: next.name })
      this.pushRow(represent('command-feedback', { kind: 'system', text: t('theme.switched', { name: next.name }) }))
      this.markDirty()
      return
    }
    const next = themeByName(wanted)
    if (next === undefined) {
      this.pushRow(represent('command-error', { kind: 'error', text: t('theme.unknown', { name: wanted, known: themeNames().join(', ') }) }))
      this.markDirty()
      return
    }
    this.theme = setActiveTheme(next.name)
    await this.mergeUiSettings({ theme: next.name })
    // A theme change touches every cached line, so the whole frame is stale.
    this.forceFullPaint = true
    this.pushRow(represent('command-feedback', { kind: 'system', text: t('theme.switched', { name: next.name }) }))
    this.markDirty()
  }

  /** `/retryauth [on|off]` — the setting that lets one provider 401/403 retry itself. */
  private async runRetryAuthCommand(arg: string): Promise<void> {
    const id = arg.trim().toLowerCase()
    if (id === '' || id === 'status') {
      this.pushRow(represent('command-status', {
        kind: 'system',
        text: t('retryauth.status', {
          state: this.retryProviderAuthEnabled() ? t('retryauth.on') : t('retryauth.off'),
        }),
      }))
      this.markDirty()
      return
    }
    if (!['on', 'off'].includes(id)) {
      this.pushRow(represent('command-usage', { kind: 'error', text: t('retryauth.usage') }))
      this.markDirty()
      return
    }
    const on = id === 'on'
    await this.mergeUiSettings({ retryProviderAuth: on })
    this.pushRow(represent('command-feedback', { kind: 'system', text: t('retryauth.switched', { state: on ? t('retryauth.on') : t('retryauth.off') }) }))
    this.markDirty()
  }

  private async runDisconnectCommand(arg: string): Promise<void> {
    const direct = parseDisconnectPolicy(arg)
    let next: DisconnectPolicyName | undefined = direct
    if (next === undefined && arg.trim() !== '') {
      this.pushRow(represent('command-misuse', { kind: 'error', text: t('disconnect.unknown', { id: arg.trim() }) }))
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
    this.pushRow(represent('command-feedback', {
      kind: 'system',
      text: t('disconnect.switched', { name: next === 'continue' ? t('disconnect.continue') : t('disconnect.pause') }),
    }))
    this.markDirty()
  }

  /** /mode: pick an agent preset (standard / minimal / ptc / cordis / routing-suite / ...). */
  private async runModeCommand(arg = ''): Promise<void> {
    const agentPresets = this.presetService()
    const direct = arg.trim().toLowerCase()
    if (direct === 'fix' || direct === 'repair') {
      await this.repairRoster()
      return
    }
    if (agentPresets === undefined) {
      // A terminal profile built on dsh-base composes no roster, and the
      // plugin's bundle patch may not mount one; only the profile's user layer
      // can. Report the exact row and offer the in-app repair: the install
      // scripts are the checkout path, while an npm install and the in-app
      // `dsh plugin add` update never run them.
      const profile = profileFromArgv()
      this.pushRow(represent('command-error', {
        kind: 'error',
        text: this.missingPresetService(t('mode.missingService')),
      }))
      this.markDirty()
      return
    }
    const presets = await agentPresets.list()
    if (presets.length === 0) {
      this.pushRow(represent('command-error', { kind: 'error', text: t('mode.none') }))
      this.markDirty()
      return
    }
    // Shipped presets first, then locally authored ones, each line naming its
    // group and position: the dialog is a flat list, so the grouping lives in
    // the order and the text.
    const options: PresetPickerOption[] = flattenGroups(groupPresets(presets, this.presetId))
    const matchesDirect = (option: (typeof options)[number]): boolean =>
      option.id.toLowerCase() === direct || option.label.toLowerCase() === direct
      // A published name still selects its preset even when the label resolves
      // through the dictionary instead.
      || optionMatches(option, direct)
    let index = direct === ''
      ? -1
      : options.findIndex(option => matchesDirect(option))
    if (index < 0 && direct !== '') {
      this.pushRow(represent('command-error', {
        kind: 'error',
        text: t('mode.unknown', { id: arg.trim(), available: options.map(option => option.id).join(', ') }),
      }))
      this.markDirty()
      return
    }
    if (index < 0 && direct === '') {
      // Like every other picker, the list opens on what is in effect now.
      const currentIndex = options.findIndex(option => option.id === this.presetId)
      const answer = await this.askQuestion({
        id: 'mode-pick',
        question: t('mode.pick'),
        options: options.map(option => ({ label: option.label, description: option.description })),
      }, 0, 1, currentIndex >= 0 ? currentIndex : undefined, options.map(option => option.id))
      const picked = answer.selected[0] ?? ''
      index = options.findIndex(option => option.label === picked)
    }
    if (index < 0) return
    const option = options[index]
    if (option === undefined) return
    const selected = presets.find(preset => preset.id === option.id)
    if (selected === undefined) return
    if (option.broken !== undefined) {
      this.pushRow(represent('command-error', {
        kind: 'error',
        text: t('mode.broken', { name: option.label, reason: option.broken }),
      }))
      this.markDirty()
      return
    }
    const selectedName = option.label
    const hasWork = sessionEvents(this.agent.session).some(event => event.type === 'turn/start')
    if (!hasWork) {
      // Feature-detected: a host whose registry predates `recompose` still
      // lists presets, and switching then needs a restarted session.
      if (typeof agentPresets.recompose !== 'function') {
        this.pushRow(represent('command-error', { kind: 'error', text: t('mode.noRecompose', { id: selected.id }) }))
        this.markDirty()
        return
      }
      await agentPresets.recompose(this.agent.ctx, selected.id)
      this.presetId = selected.id
      this.presetName = selectedName
      this.pushRow(represent('command-feedback', { kind: 'system', text: t('mode.switched', { name: selectedName }) }))
    } else {
      this.pushRow(represent('repair-result', {
        kind: 'system',
        text: t('mode.remembered', { name: selectedName }),
      }))
    }
    await this.ctx.get('settings')?.update(settingsNamespace('agent-presets'), { default: selected.id })
    this.markDirty()
  }

  /**
   * `/mode fix`: write the roster row into this profile's user patch layer.
   *
   * The write only takes effect on the next launch — the loader composes the
   * patch tree once at boot — so the report says so instead of pretending the
   * running session gained a roster.
   */
  /** Re-read the roster fact this process was composed with (cheap, no IO). */
  private refreshRosterHealth(): void {
    // 0.1.7 has no roster to be missing: what a terminal profile owns there is
    // the agent-plane rows, so the chip reports those instead.
    this.rosterMissing = this.settingsGeneration === 'forms'
      ? !formsRowsDeclared(resolveDshHome(), profileFromArgv())
      : this.ctx.get('agentPresets') === undefined
  }

  /** Which settings protocol this host speaks; decides what "missing" means. */
  private get settingsGeneration(): SettingsGeneration {
    return hostSettingsGeneration(this.ctx)
  }

  /**
   * The two lines `/mode` and `/preset` print when the preset service is absent.
   *
   * The reason differs by host line: 0.1.5 lost a roster the profile can mount,
   * while 0.1.7 composes the agent process-wide and has no terminal presets at
   * all — the repair there is the agent-plane rows, not a roster.
   */
  private missingPresetService(first: string): string {
    const profile = profileFromArgv()
    const patch = rosterPatchPath(resolveDshHome(), profile)
    return this.settingsGeneration === 'forms'
      ? [first, t('mode.formsHost'), t('mode.formsHint', { profile, patch })].join('\n')
      : [first, t('mode.missingServiceHint', { profile, patch })].join('\n')
  }

  private async repairRoster(): Promise<void> {
    const profile = profileFromArgv()
    const patch = rosterPatchPath(resolveDshHome(), profile)
    try {
      // Which rows are "the rows" is a host-line fact: 0.1.7 composes the agent
      // process-wide and owns the agent-plane rows instead of the roster. Both
      // the list and the header come from the same generation `/doctor` uses,
      // or this writes rows the running host cannot resolve.
      const generation = this.settingsGeneration
      const result = await ensureRosterRows(resolveDshHome(), profile, rosterRows(generation), generation)
      this.refreshRosterHealth()
      this.pushRow(represent('repair-result', {
        kind: 'system',
        text: result === 'present' ? t('mode.fixPresent', { patch }) : t('mode.fixWritten', { patch }),
      }))
    } catch (error) {
      this.pushRow(represent('command-error', { kind: 'error', text: t('mode.fixFailed', { patch, error: errorChain(error) }) }))
    }
    this.markDirty()
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

  /**
   * Command Code's quota: the rolling 5h/weekly windows and credit pool off
   * `/alpha/billing/credits`, enriched by the subscription period and spend.
   * Only the credits read is required; the two enrichment reads are
   * best-effort so one failing endpoint cannot hide the windows.
   * @param source - the recognized Command Code route.
   */
  private async fetchCommandCodeQuota(source: CommandCodeSource): Promise<QuotaSnapshot> {
    const apiKey = await this.resolveCredential(source.apiKeyEnv)
    if (apiKey === undefined) throw new Error(t('usage.noCred', { env: source.apiKeyEnv }))
    const headers = { authorization: `Bearer ${apiKey}`, accept: 'application/json' }
    const credits = await this.fetchJson(COMMAND_CODE_CREDITS_URL, headers, source.label)
    const subscription = await this.tryFetchJson(COMMAND_CODE_SUBSCRIPTIONS_URL, headers, source.label)
    const since = commandCodePeriodStart(subscription)
    const summaryUrl = since === undefined
      ? COMMAND_CODE_USAGE_URL
      : `${COMMAND_CODE_USAGE_URL}?since=${encodeURIComponent(since)}`
    const summary = await this.tryFetchJson(summaryUrl, headers, source.label)
    return parseCommandCodeQuota({ credits, subscription, summary }, source.provider)
  }

  /** Best-effort JSON read for quota enrichment; a failure leaves the field out. */
  private async tryFetchJson(url: string, headers: Record<string, string>, label: string): Promise<unknown> {
    try {
      return await this.fetchJson(url, headers, label)
    } catch {
      // Enrichment only: the required billing read already decided the outcome.
      return undefined
    }
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
      const quota = await this.refreshQuota({ reason: 'command', announce: false })
      if (quota !== undefined) {
        this.openReport('usage', formatQuotaSnapshot(quota).split('\n'))
        return
      }
      if (this.balanceSnapshot !== undefined) {
        this.openReport('usage', [formatAccountBalance(this.balanceSnapshot)])
        return
      }
      const provider = this.currentProviderId()
      const llmPiAi = readSettingsSection(this.ctx, settingsNamespace('llm-pi-ai'))
      const source = openCodeSourceFor(provider, llmPiAi)
      if (source?.flavor === 'zen') {
        this.openReport('usage', this.zenUsageText(source).split('\n'))
      } else {
        this.openReport('usage', [t('usage.none', { provider })])
      }
    } catch (error: unknown) {
      this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command: 'balance', error: errorChain(error) }) }))
    } finally {
      this.status = previousStatus
      this.markDirty()
    }
  }

  private applyQuotaSnapshot(snapshot: QuotaSnapshot, announce: boolean): void {
    const previous = this.quotaSnapshot === undefined ? undefined : tightestQuotaWindow(this.quotaSnapshot)
    this.quotaSnapshot = snapshot
    if (announce) this.pushRow(represent('quota-report', { kind: 'system', text: formatQuotaSnapshot(snapshot) }))
    const window = tightestQuotaWindow(snapshot)
    if (window !== undefined) {
      for (const threshold of crossedQuotaThresholds(previous?.remainingPercent, window.remainingPercent)) {
        const key = `${snapshot.provider}:${window.period}:${threshold}`
        if (this.quotaAlerted.has(key)) continue
        this.quotaAlerted.add(key)
        this.pushRow(represent('quota-report', { kind: 'system', text: quotaAlertText(snapshot, window) }))
      }
    }
    this.markDirty()
  }

  /** Stop the first-reading retry; the normal cadence owns the refresh now. */
  private clearQuotaRetry(): void {
    if (this.quotaRetryTimer !== undefined) clearTimeout(this.quotaRetryTimer)
    this.quotaRetryTimer = undefined
  }

  /** Ask again soon, but only while the footer still has nothing to show. */
  private armQuotaRetry(provider: string): void {
    if (this.disposed || this.quotaRetryTimer !== undefined) return
    if (!this.hasQuotaSurface(provider)) return
    if (this.quotaSnapshot !== undefined && this.quotaSnapshot.provider === provider) return
    this.quotaRetryTimer = setTimeout(() => {
      this.quotaRetryTimer = undefined
      void this.refreshQuota({ reason: 'start', announce: false }).catch(() => {})
    }, this.quotaRetryMs)
  }

  /**
   * Whether this provider has a quota surface at all. `false` means the footer
   * shows no quota widget — a balance line covers DeepSeek, and a provider with
   * neither gets nothing.
   */
  private hasQuotaSurface(provider: string): boolean {
    const llmPiAi = readSettingsSection(this.ctx, settingsNamespace('llm-pi-ai'))
    return providerHasQuotaSurface(provider, llmPiAi)
  }

  private async refreshQuota(options: { reason: 'start' | 'step' | 'command'; announce: boolean }): Promise<QuotaSnapshot | undefined> {
    if (this.quotaRefreshInFlight && options.reason !== 'command') return this.quotaSnapshot
    this.quotaRefreshInFlight = true
    const provider = this.currentProviderId()
    try {
      const snapshot = await this.fetchQuotaSnapshot(provider)
      if (snapshot !== undefined) {
        this.balanceSnapshot = undefined
        this.applyQuotaSnapshot(snapshot, options.announce)
        this.clearQuotaRetry()
        return snapshot
      }
      try {
        const balance = await this.fetchAccountBalance(provider)
        if (balance !== undefined) {
          this.balanceSnapshot = balance
          this.quotaSnapshot = undefined
          this.quotaAlerted.clear()
          if (options.announce) this.pushRow(represent('quota-report', { kind: 'system', text: formatAccountBalance(balance) }))
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
      // One place covers every outcome: a successful reading clears the retry
      // (and this check then sees a snapshot for the provider), while a throw,
      // an empty reply or another provider's snapshot keeps it asking.
      if (this.quotaSnapshot === undefined || this.quotaSnapshot.provider !== provider) this.armQuotaRetry(provider)
    }
  }

  private async fetchAccountBalance(provider: string): Promise<AccountBalanceSnapshot | undefined> {
    if (provider === 'deepseek-official' || provider === 'deepseek') {
      const apiKey = await this.resolveCredential('DEEPSEEK_API_KEY')
      if (apiKey === undefined) throw new Error(t('usage.noDeepseekKey'))
      const section = readSettingsSection(this.ctx, settingsNamespace('llm-deepseek')) as { baseURL?: unknown } | undefined
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
    const llmPiAi = readSettingsSection(this.ctx, settingsNamespace('llm-pi-ai'))
    const commandCode = commandCodeSourceFor(provider, llmPiAi)
    if (commandCode !== null) return this.fetchCommandCodeQuota(commandCode)
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

  /**
   * One key, handled by the Screen that is up.
   *
   * The Screen owns the keyboard completely, so this is also the place that keeps
   * the workspace's state out of reach: no arrow moves a card behind the Screen, no
   * page key scrolls the transcript, no print reaches the composer draft. Closing
   * keys come from `inspectClosesOn`, which is what the overlay always accepted —
   * plus `q`, which a full-screen report is expected to answer to.
   */
  private handleScreenInput(combined: string, moved: string | undefined): void {
    const screen = this.screen
    if (screen === undefined) return
    // The setup Screen owns its own field, its own navigation and its own keys: it
    // consumes everything while it is up, and nothing reaches the workspace's
    // composer, history or transcript (B2.6 §4).
    if (screen.kind === 'setup') {
      this.handleSetupKey(combined, moved)
      return
    }
    // The Screen's own confirmation owns the keys while it is up: it is a question
    // asked by this Screen, and answering it must not reach into the workspace.
    if (this.screenSurface !== undefined) {
      if (combined === '\x1b' || combined === '\x03') {
        this.settleScreenConfirm('cancel')
        return
      }
      const answer = confirmAnswer(combined)
      if (answer !== undefined) this.settleScreenConfirm(answer)
      return
    }
    if (moved === 'copy' && (screen.copyText ?? '') !== '') {
      this.copyFromScreen(screen)
      return
    }
    // Mouse reports arrive through this same path. A wheel scrolls the Screen (the
    // transcript behind it is not the reader's target and must not move); a click
    // does nothing at all, because nothing behind a Screen is a target either.
    const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/u.exec(combined)
    if (sgr !== null) {
      if (sgr[4] !== 'M') return
      const button = Number(sgr[1])
      if (button === 64) this.scrollScreen(3)
      else if (button === 65) this.scrollScreen(-3)
      return
    }
    const escape = /^\x1b\[([A-D])$/u
    const match = combined.match(escape)
    if (match !== null) {
      // Arrows and the page keys scroll the Screen, never the transcript behind it.
      if (match[1] === 'A') this.scrollScreen(1)
      else if (match[1] === 'B') this.scrollScreen(-1)
      else if (match[1] === 'C') this.scrollScreen(-1)
      else this.scrollScreen(1)
      return
    }
    // A printable key is not silently swallowed: a Screen has no composer (AD-8), and
    // a reader who starts typing a command here has to be told why nothing happens —
    // the alternative is a terminal that looks broken. It becomes the Screen's own
    // hint row, so repeated keys cannot pile up notices.
    if (PRINTABLE.test(combined)) {
      const hint = t('screen.typeHint')
      if (screen.notice !== hint) {
        screen.notice = hint
        this.markDirty()
      }
      return
    }
    if (combined === '\x1b[5~') this.scrollScreen(this.screenPage())
    else if (combined === '\x1b[6~') this.scrollScreen(-this.screenPage())
    else if (combined === '\x1b[H' || combined === '\x1b[1~') this.scrollScreenTo(0)
    else if (combined === '\x1b[F' || combined === '\x1b[4~') this.scrollScreenTo(Number.MAX_SAFE_INTEGER)
    else if (inspectClosesOn(combined)) this.closeScreen()
  }

  /**
   * Whether anything human is waiting behind the Screen that is up.
   *
   * A Surface cannot open while a Screen owns the screen (it stays in the workspace
   * queue), so without this the reader would have no way to know that an approval
   * or a question is waiting for them behind the report — the one thing a Screen
   * must never hide (AD-8). A question the Session still holds counts too: the agent
   * is not blocked, but the reader has something to answer.
   */
  private screenWaitingWork(): boolean {
    if (this.dialogQueue.some(entry => stallsTask(entry.role))) return true
    if (this.dialog !== undefined && stallsTask(this.dialogRole)) return true
    return this.queuedQuestions > 0
  }

  /** Rows one PageUp moves a Screen: the body, less one row of context. */
  private screenPage(): number {
    return Math.max(1, screenLayout(Math.max(6, this.screenRows())).bodyRows - 1)
  }

  /** Scroll a Screen by `up` rows toward the start of its body. */
  private scrollScreen(up: number): void {
    const screen = this.screen
    if (screen === undefined) return
    this.scrollScreenTo(screen.offset - up)
  }

  private scrollScreenTo(offset: number): void {
    const screen = this.screen
    if (screen === undefined) return
    const layout = screenLayout(Math.max(6, this.screenRows()))
    const next = clampScreenOffset(offset, screen.lines.length, layout.bodyRows)
    if (next === screen.offset) return
    screen.offset = next
    this.markDirty()
  }

  /** The copy key inside a Screen: what the Screen shows is what the reader means. */
  private copyFromScreen(screen: ScreenState): void {
    const text = screen.copyText ?? ''
    if (text.trim() === '') {
      screen.notice = t('copy.empty')
      this.markDirty()
      return
    }
    const notice = t('copy.ok', { chars: text.length, source: t('copy.sourceFull') })
    const alreadyWarned = this.osc52HintShown
    this.copyPlainText(text, notice)
    // Two rows the copy pushes land *behind* this Screen: the confirmation, and —
    // where the terminal cannot take an OSC 52 write — the caveat that says so. Both
    // are things the reader has to see at the moment they press the key, so the
    // Screen's own hint row carries them; the rows stay in the transcript for later.
    const caveat = !alreadyWarned && this.osc52HintShown
      ? t('copy.osc52Hint', { terminal: this.terminalCaps.label })
      : undefined
    // The caveat leads when it fires: it says the copy the reader just asked for may
    // not have landed, and a Screen has one row to say it in — with the confirmation
    // in front, the part that matters was clipped off the right edge.
    screen.notice = caveat ?? notice
    this.markDirty()
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

    // A key the user moved, and a key their move displaced. Consulted before any
    // routing so a plain control byte reaches it as readily as a CSI sequence;
    // everything else keeps the handling below, which is what makes the defaults
    // unchanged by construction.
    const moved = combined === '' ? undefined : this.keymap.sequences.get(combined)
    // A Screen replaces the workspace and owns every key outright. There is no
    // composer behind it, no transcript to fall through to and no Surface it could
    // share with: one gate, instead of the ten `dialog?.kind === 'inspect'` checks
    // this replaced (B2.1).
    if (this.screen !== undefined) {
      this.handleScreenInput(combined, moved)
      return
    }
    if (this.dialog === undefined && combined !== '') {
      if (moved !== undefined && this.keymap.overridden.has(moved)) {
        if (this.runKeyAction(moved)) return
      }
      if (this.dialog === undefined && this.keymap.suppressed.has(combined)) return
    }

    const escape = /^\x1b\[([A-D])$/u
    const match = combined.match(escape)
    if (match !== null) {
      switch (match[1]) {
        case 'A':
          if (this.moveQuestionCursor(-1)) {
            return
            return
            return
          } else if (this.dialog !== undefined) {
            // A surface owns the keyboard: an arrow it does not use is not the
            // transcript's. Falling through moved the selection behind the dialog,
            // and with a non-empty field it rewrote the field from history.
            return
          } else if (this.suggestionsVisible()) {
            this.suggestionIndex = Math.max(0, this.suggestionIndex - 1)
            this.markDirty()
          } else if (this.fieldText() === '' && this.collapsibleRows().length > 0) {
            this.moveFocus(-1)
          } else {
            this.historyBack()
          }
          return
        case 'B':
          if (this.moveQuestionCursor(1)) {
            return
            return
            return
          } else if (this.dialog !== undefined) {
            return
          } else if (this.suggestionsVisible()) {
            this.suggestionIndex = Math.min(this.commandSuggestions.length - 1, this.suggestionIndex + 1)
            this.markDirty()
          } else if (this.fieldText() === '' && this.collapsibleRows().length > 0) {
            this.moveFocus(1)
          } else {
            this.historyForward()
          }
          return
        case 'C': if (this.textIsEditable()) this.moveCursor(1); return
        case 'D': if (this.textIsEditable()) this.moveCursor(-1); return
      }
    }
    const sgrMouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/u.exec(combined)
    if (sgrMouse !== null) {
      const button = Number(sgrMouse[1])
      const x = Number(sgrMouse[2])
      const y = Number(sgrMouse[3])
      if (sgrMouse[4] === 'M') {
        if (button === 64) {
          this.scrollActiveSurface(3)
          return
        }
        if (button === 65) {
          this.scrollActiveSurface(-3)
          return
        }
        // 32 is "motion with the left button held": a drag over a reply. Shift
        // adds 4 to every button code, and a terminal that still forwards the
        // report while Shift is down (instead of keeping it for its own
        // selection) must drag exactly like an unshifted one — otherwise the
        // gesture the user was told to fall back on does nothing here.
        if (button === 32 || button === 36) {
          this.extendMouseSelection(y, x)
          return
        }
        if (button === 0 || button === 4) {
          this.beginMouseSelection(y, x)
          return
        }
        return
      }
      // A release ends either a drag (copy what it covered) or a plain click.
      if (button === 0 || button === 4) this.endMouseSelection(y, x)
      return
    }
    if (combined === '\x1b[5~') {
      this.scrollActiveSurface(Math.max(3, Math.floor(this.screenRows() / 2)))
      return
    }
    if (combined === '\x1b[6~') {
      this.scrollActiveSurface(-Math.max(3, Math.floor(this.screenRows() / 2)))
      return
    }
    if (parseCursorPositionReply(combined) !== undefined) return
    if (combined === '\x1b[H' || combined === '\x1b[1~') { this.cursor = 0; this.markDirty(); return }
    if (combined === '\x1b[F' || combined === '\x1b[4~') { this.cursor = this.input.length; this.markDirty(); return }
    if (combined === '\x1b[3~') { this.deleteAtCursor(); return }
    // kitty / CSI-u Ctrl+Shift+C (codepoint 99, mods 6 = Ctrl+Shift)
    if (combined === '\x1b[99;6u') {
      this.copyKey()
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

  /**
   * Insert pasted text into the field that owns the keyboard; CR/LF are literal
   * newlines.
   *
   * A paste is text input, so it goes through the same ownership question ordinary
   * typing does: into the composer's draft when the composer owns the keyboard, and
   * into a borrowed field when a surface that has one does. A surface without a
   * text field (a confirmation, the inspect overlay) takes no paste at all — the
   * alternative was writing the composer's hidden draft behind it, which is how a
   * paste into an approval dialog could silently rewrite the message being written.
   */
  private handlePasteText(text: string): void {
    const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
    if (normalized === '') return
    if (!this.textIsEditable()) return
    this.leaveHistoryBrowse()
    const current = this.fieldText()
    const at = this.fieldCursor()
    this.setField(`${current.slice(0, at)}${normalized}${current.slice(at)}`, at + normalized.length)
    if (this.borrowedText === undefined) {
      const cols = Math.max(10, this.screenColumns())
      const lineWidth = Math.max(1, cols - 2)
      if (normalized.includes('\n') || displayWidth(this.fieldText()) > lineWidth) this.inputFolded = true
    }
    this.markDirty()
  }

  /**
   * Whether the keys that edit text belong to a field right now.
   *
   * The composer always has one; an open surface only has one when it borrowed it
   * (a free-text answer, a setup field). Everything else — a confirmation, a menu,
   * the inspect overlay — owns the keyboard without owning text, and those keys
   * must do nothing rather than reach the draft behind the surface.
   */
  private textIsEditable(): boolean {
    return this.dialog === undefined || this.borrowedText !== undefined
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
    // A setup Screen owns every key, Enter included: it is the key that submits a
    // step, and the composer behind the screen must never receive one (B2.6 §4).
    // Ctrl+C is the exception — it is the terminal's own interrupt and keeps its
    // global meaning.
    if (this.screen?.kind === 'setup' && char !== '\x03') {
      this.handleScreenInput(char, this.keymap.sequences.get(char))
      return
    }
    switch (char) {
      case '\x1b': this.handleEscape(); return
      case '\r':
      case '\n': this.submit(); return
      case '\x7f': if (this.textIsEditable()) this.backspace(); return
      case '\x08': if (this.textIsEditable()) this.backspace(); return
      case '\x03': this.handleCtrlC(); return
      // Ctrl+D is the composer's exit key. A surface that owns the keyboard has no
      // exit semantics of its own, and falling through to the process exit left a
      // dialog on screen killing the session it was waiting for.
      case '\x04': if (this.dialog === undefined && this.screen === undefined) void this.requestExit(0); return
      case '\x0c':
        this.lastPaintRows = []
        this.lastChromeKey = ''
        this.lastPaintWidth = 0
        this.lastPaintHeight = 0
        this.dirty = true
        this.render()
        return
      case '\x01': if (this.textIsEditable()) this.setField(this.fieldText(), 0); this.markDirty(); return
      case '\x05': if (this.textIsEditable()) this.setField(this.fieldText(), this.fieldText().length); this.markDirty(); return
      case '\x15':
        if (!this.textIsEditable()) return
        this.leaveHistoryBrowse()
        this.setField('', 0)
        if (this.borrowedText === undefined) this.inputFolded = false
        this.markDirty()
        return
      case '\x0b':
        if (!this.textIsEditable()) return
        this.leaveHistoryBrowse()
        this.setField(this.fieldText().slice(0, this.fieldCursor()), this.fieldCursor())
        this.markDirty()
        return
      // A dialog owns the keyboard while it is up: moving the transcript cursor
      // under it changed what a later copy would take while the screen showed
      // nothing of the sort.
      case '\x0e':
        if (this.dialog === undefined && this.screen === undefined) this.moveFocus(1)
        return
      case '\x10':
        if (this.dialog === undefined && this.screen === undefined) this.moveFocus(-1)
        return
      case '\x12':
        if (this.dialog !== undefined) return
        if (this.focusedRow === null) this.toggleCollapsible()
        else this.toggleAllCollapsible()
        return
      case '\x14': if (this.dialog === undefined) this.inputFolded = !this.inputFolded; this.markDirty(); return
    }
    // A Screen owns the keyboard here too. This is the path a plain character
    // takes (`handleChar`), and the Screen branch must come first or a `y` typed at
    // a Screen's confirmation would fall through to the composer behind it.
    if (this.screen !== undefined) {
      this.handleScreenInput(char, this.keymap.sequences.get(char))
      return
    }
    if (this.dialog !== undefined) {
      this.handleDialogChar(char)
      return
    }
    if (char === '\x07') {
      if (this.dialog === undefined) this.stepSearch(1)
      return
    }
    if (char === '\x1f') {
      if (this.dialog !== undefined) return
      this.input = '/find '
      this.cursor = this.input.length
      this.markDirty()
      return
    }
    if (char === '\t') {
      if (this.dialog !== undefined) return
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
      if (!this.textIsEditable()) return
      this.leaveHistoryBrowse()
      this.insertIntoField(char)
      this.markDirty()
    }
  }

  /**
   * Run one rebindable action.
   * @param action - the action the pressed key was moved to.
   * @returns true when the key was consumed.
   */
  private runKeyAction(action: KeyAction): boolean {
    switch (action) {
      case 'pageUp':
        this.scrollActiveSurface(Math.max(3, Math.floor(this.screenRows() / 2)))
        return true
      case 'pageDown':
        this.scrollActiveSurface(-Math.max(3, Math.floor(this.screenRows() / 2)))
        return true
      case 'toggleCard':
        this.toggleCollapsible()
        return true
      case 'copy':
        this.copyKey()
        return true
      case 'cancel':
        this.handleEscape()
        return true
      default:
        return false
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
    if (!isSurfaceDialog(dialog)) {
      // A deprecated shape (the pre-B2.6 onboarding dialog) is not a live path: it is
      // dropped rather than answered through the question machinery (B2.6 §17).
      this.dialog = undefined
      this.showNextDialog()
      return
    }
    if (dialog.kind === 'confirm') {
      const answer = confirmAnswer(text)
      if (answer !== undefined) this.closeConfirm(answer)
      return
    }
    // Filter mode owns the printable keys: the list's hotkeys are letters and
    // digits, so the two cannot both be live at once.
    if (dialog.filtering === true) {
      if (text === '\r' || text === '\n') {
        applyQuestionFilter(dialog)
        this.markDirty()
        return
      }
      if (text === '\x7f' || text === '\b') {
        backspaceQuestionFilter(dialog)
        this.markDirty()
        return
      }
      if (text.length === 1 && text >= ' ') {
        typeQuestionFilter(dialog, text)
        this.markDirty()
        return
      }
      return
    }
    if (text === '/' && (dialog.question.options?.length ?? 0) > 0) {
      dialog.filtering = true
      dialog.filter = ''
      this.markDirty()
      return
    }
    if (selectQuestionOptionByKey(dialog, text)) this.markDirty()
    if (text === '\r' || text === '\n') {
      const submit = questionSubmit(dialog, this.fieldText())
      if (submit.kind === 'reject') {
        // A list with options always answers with its highlight; this guards
        // only a malformed question whose cursor names no option.
        dialog.reject(new UserQuestionError('ask_user_question was cancelled', 'ASK_ABORTED'))
        return
      }
      if (submit.kind === 'resolve') {
        // The typed answer is carried by the resolve; the borrowed field it was
        // typed into is released by `settleQuestion` on the way out. Clearing a
        // field here would be clearing the *composer* — by then the surface has
        // already given the field back, so `setField` would aim at the draft.
        dialog.resolve({ selected: submit.selected, ...(submit.custom === undefined ? {} : { custom: submit.custom }) })
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
        if (char >= ' ' && char !== '\x7f') this.insertIntoField(char)
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
      { key: 'template:opencode-go', label: templates['opencode-go'].label, detail: t('onboard.protocolAuto') },
      { key: 'template:command-code', label: templates['command-code'].label, detail: t('onboard.protocolAuto') },
      { key: 'template:openai-completions', label: templates['openai-completions'].label, detail: 'openai-completions' },
      { key: 'template:openai-responses', label: templates['openai-responses'].label, detail: 'openai-responses' },
      { key: 'template:anthropic-messages', label: templates['anthropic-messages'].label, detail: 'anthropic-messages' },
    ]
    return mergeProviderEntries(templateEntries, state.catalogPresets ?? [], ['deepseek', 'opencode-go'], state.field)
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

  /** The installed catalog's id→window index, built once per catalog load. */
  private catalogWindowIndexSource(): Map<string, number> {
    this.catalogWindows ??= catalogWindowIndex(this.catalogPresets ?? [])
    return this.catalogWindows
  }

  /**
   * Size the wizard's picked models from the installed catalog, filling in the
   * capacities the endpoint's listing did not disclose and recording them on
   * the wizard state so the saved entries carry them.
   * @param state - the wizard state whose `models` are being sized.
   * @returns the windows discovered for this pick, by model id.
   */
  private sizeOnboardingModels(state: OnboardingState): Map<string, number> {
    const index = this.catalogWindowIndexSource()
    const sized = new Map<string, number>()
    for (const id of state.models) {
      const listed = state.modelCapacity?.get(id)?.contextWindow
      const window = listed ?? (index.size === 0 ? undefined : catalogContextWindow(id, index))
      if (window === undefined) continue
      sized.set(id, window)
      if (listed === undefined) {
        const capacity = state.modelCapacity?.get(id) ?? {}
        state.modelCapacity ??= new Map()
        state.modelCapacity.set(id, { ...capacity, contextWindow: window })
      }
    }
    return sized
  }

  /**
   * Leave the models step, after one best-effort trip to the gateway for what
   * the picks are still missing: the context window / output cap of every model
   * the listing has not described yet, and — for a gateway that spreads over
   * several protocols — the endpoints each picked model answers.
   *
   * `Ctrl+F` stays as it was, but it is no longer the only way to learn these:
   * a model typed by hand would otherwise be saved with no capacity at all, and
   * with no endpoint data the split had nothing to file it by.
   */
  private async finishModelsStep(state: OnboardingState): Promise<void> {
    if (this.onboarding !== state || !isModelsStep(state.step)) return
    if (this.finishingModels.has(state)) return
    this.finishingModels.add(state)
    try {
      const previousStatus = this.status
      if (this.onboardingWantsEndpoint(state)) {
        const fetching = t('onboard.fetchingModels')
        this.status = fetching
        this.markDirty()
        await this.enrichOnboardingModels(state)
        // Only take back the line this step put up: a turn that started while
        // the listing was in flight owns the status now, and restoring the
        // pre-fetch value would erase "turn 7 running" behind its back.
        if (this.status === fetching) this.status = previousStatus
      }
      // The wizard may have been cancelled or reset while the fetch was in flight.
      if (this.onboarding !== state || !isModelsStep(state.step)) return
      // Size the picks before the confirm step so the route default the wizard
      // persists is derived, not guessed: the listing first, the installed
      // catalog second. Only when some pick stayed unsized does the route
      // default matter, and only then is a step shown for it.
      const sized = this.sizeOnboardingModels(state)
      const unsized = state.models.filter(id => !sized.has(id))
      if (unsized.length === 0) {
        state.step = 'confirm'
      } else {
        state.routeContextWindow = suggestedRouteContextWindow(sized.values())
          ?? HARNESS_DEFAULT_CONTEXT_WINDOW
        state.step = 'context'
      }
      this.setField('', 0)
      this.markDirty()
    } finally {
      this.finishingModels.delete(state)
    }
  }

  /** Whether leaving the models step has anything left to ask the gateway for. */
  private onboardingWantsEndpoint(state: OnboardingState): boolean {
    if (onboardTemplate(state).protocols !== undefined && state.modelEndpoints === undefined) return true
    return state.models.some(id => state.modelCapacity?.get(id)?.contextWindow === undefined)
  }

  /** Fill the picks' capacities and endpoints from the gateway; never fatal. */
  private async enrichOnboardingModels(state: OnboardingState): Promise<void> {
    const template = onboardTemplate(state)
    const baseURL = state.baseUrl === '' ? template.defaultBaseUrl : state.baseUrl
    if (baseURL === '') return
    const wantsEndpoints = template.protocols !== undefined && state.modelEndpoints === undefined
    const wantsCapacity = state.models.some(id => state.modelCapacity?.get(id)?.contextWindow === undefined)
    const llm = this.ctx.get('llm')
    if (wantsCapacity && llm !== undefined) {
      try {
        const discovered = await discoverProviderModels(llm, {
          baseURL,
          ...(template.api === undefined ? {} : { api: template.api }),
          ...(state.key === '' ? {} : { apiKey: state.key }),
        }, AbortSignal.timeout(8_000))
        state.modelCapacity ??= new Map()
        for (const model of discovered) {
          if (!state.models.includes(model.id)) continue
          const capacity = { ...(state.modelCapacity.get(model.id) ?? {}) }
          if (capacity.contextWindow === undefined && model.contextWindow !== undefined) {
            capacity.contextWindow = model.contextWindow
          }
          if (capacity.maxTokens === undefined && model.maxTokens !== undefined) {
            capacity.maxTokens = model.maxTokens
          }
          if (Object.keys(capacity).length > 0) state.modelCapacity.set(model.id, capacity)
        }
      } catch {
        // The listing is an enrichment, not a gate: the installed catalog and
        // the route default still cover a gateway that cannot be listed.
      }
    }
    if (wantsEndpoints) {
      const endpoints = await fetchModelEndpoints(baseURL, state.key)
      if (endpoints !== undefined) state.modelEndpoints = endpoints
    }
  }

  /** The wizard's field text, from the wizard's own state. */
  private setupField(state: OnboardingState): string {
    return state.field
  }

  /** Replace the wizard's field and caret; the composer is not touched. */
  private setupSetField(state: OnboardingState, text: string, cursor: number): void {
    state.field = text
    state.fieldCursor = Math.max(0, Math.min(cursor, text.length))
  }

  /** Insert into the wizard's field at its caret. */
  private setupInsert(state: OnboardingState, text: string): void {
    const current = state.field
    const at = state.fieldCursor
    this.setupSetField(state, `${current.slice(0, at)}${text}${current.slice(at)}`, at + text.length)
  }

  /** Delete the code point before the wizard's caret. */
  private setupBackspace(state: OnboardingState): void {
    const current = state.field
    const at = state.fieldCursor
    if (at <= 0) return
    const before = Array.from(current.slice(0, at)).slice(0, -1).join('')
    this.setupSetField(state, `${before}${current.slice(at)}`, before.length)
  }

  /**
   * Say something inside the setup Screen.
   *
   * Framed mode keeps it on the Screen's own message row — the wizard is a screen,
   * not history, and a `Step 1 done` transcript would be a record of a flow that
   * only ever ran once (B2.6 §12/§13). Line mode has no screen to say it on and has
   * always printed the wizard's messages as text, so it still appends one.
   */
  private setupMessage(state: OnboardingState, kind: 'system' | 'error', text: string): void {
    if (this.lineMode) {
      this.pushRow(represent('onboarding', { kind: kind === 'error' ? 'error' : 'system', text }))
      return
    }
    state.notice = { kind, text }
    this.markDirty()
  }

  /**
   * The setup Screen's key handling: its own field, its own navigation.
   *
   * Everything the wizard used to get from the workspace's composer and its
   * dialog key path is handled here — the caret keys edit the wizard's field, the
   * arrows move the wizard's pickers, Esc steps back through the picker steps or
   * abandons the flow, and the confirm step answers itself. A key this does not
   * consume is *not* forwarded anywhere: a setup screen has no other owner (B2.6 §4).
   */
  private handleSetupKey(combined: string, moved: string | undefined): void {
    const state = this.onboarding
    if (state === undefined) {
      // No wizard behind the screen (a teardown raced the paint): leaving is the
      // only honest answer.
      this.closeScreen()
      return
    }
    if (state.saving) return
    if (state.step === 'confirm') {
      if (combined === '\x1b' || combined === '\x03') {
        this.cancelOnboarding()
        return
      }
      const answer = confirmAnswer(combined)
      if (answer !== undefined) {
        if (answer === 'y') void this.saveOnboarding()
        else this.cancelOnboarding()
      }
      return
    }
    if (combined === '\x1b' || combined === '\x03') {
      // Inside the picker steps Esc goes back one step; anywhere else it abandons
      // the wizard, exactly as it always did.
      if (!this.stepBackOnboarding()) this.cancelOnboarding()
      return
    }
    if (moved === 'copy') return
    if (combined === '\x7f' || combined === '\b' || combined === '\x08') {
      if (state.step === 'provider' || state.step === 'models-pick' || state.step === 'model-default') {
        this.handleOnboardingChar('\x7f')
        return
      }
      this.setupBackspace(state)
      this.markDirty()
      return
    }
    if (combined === '\x0c') {
      // Ctrl+L still repaints the whole frame: the field is a row like any other,
      // and a forced repaint is how a reader clears a garbled terminal.
      this.screenNeedsFullPaint = true
      this.markDirty()
      return
    }
    if (combined === '\x15') {
      // Ctrl+U clears the wizard's field, not the workspace's draft.
      this.setupSetField(state, '', 0)
      this.markDirty()
      return
    }
    const sgr = /^\x1b\[(\d+);(\d+);(\d+)([Mm])$/u.exec(combined)
    if (sgr !== null) return
    const escaped = /^\x1b\[([A-D])$/u.exec(combined)
    if (escaped !== null) {
      if (state.step === 'provider') {
        const total = this.mergedProviderEntries(state).length
        if (total > 0) {
          const step = escaped[1] === 'A' ? -1 : escaped[1] === 'B' ? 1 : 0
          if (step !== 0) {
            state.providerCursor = Math.max(0, Math.min(total - 1, state.providerCursor + step))
            this.markDirty()
            return
          }
        }
      } else if (this.moveOnboardingModelCursor(escaped[1] === 'A' ? -1 : escaped[1] === 'B' ? 1 : 0)) {
        return
      }
      return
    }
    this.handleOnboardingChar(combined)
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
          state.modelCapacity = new Map()
          this.setupSetField(state, '', 0)
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
          const current = this.setupField(state)
          if (current !== '') {
            this.setupSetField(state, current.slice(0, -1), Math.max(0, state.fieldCursor - 1))
            state.providerCursor = 0
          }
          this.markDirty()
          return
        }
        let changed = false
        for (const char of text) {
          if (char >= ' ' && char !== '\x7f') {
            this.setupInsert(state, char)
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
      case 'models':
      case 'models-pick':
      case 'model-default':
      case 'context': {
        if (state.step === 'models-pick') {
          // The step is already being left (the gateway listing is in flight):
          // the pick is decided, so a stray key must not reopen it.
          if (this.finishingModels.has(state)) return
          const total = state.modelCandidates?.length ?? 0
          if (total === 0) {
            state.step = 'models'
            this.markDirty()
            return
          }
          const checked = state.modelChecked ?? (state.modelChecked = new Set<number>())
          if (text === '\r' || text === '\n') {
            const picked = this.checkedOnboardingModels(state)
            if (picked.length === 0) {
              this.setupMessage(state, 'error', t('onboard.needModel'))
              this.markDirty()
              return
            }
            state.models = picked
            state.defaultModel = picked[0]
            if (picked.length > 1) {
              state.step = 'model-default'
              state.modelCursor = 0
              this.markDirty()
              return
            }
            this.advanceOnboarding()
            return
          }
          if (text === ' ' || text === '　') {
            const index = state.modelCursor ?? 0
            if (checked.has(index)) checked.delete(index)
            else checked.add(index)
            this.markDirty()
            return
          }
          const hotkey = questionOptionIndex(text, total)
          if (hotkey !== undefined) {
            state.modelCursor = hotkey
            if (checked.has(hotkey)) checked.delete(hotkey)
            else checked.add(hotkey)
            this.markDirty()
          }
          return
        }
        if (state.step === 'model-default') {
          if (this.finishingModels.has(state)) return
          const picked = this.checkedOnboardingModels(state)
          if (text === '\r' || text === '\n') {
            const chosen = picked[Math.min(state.modelCursor ?? 0, Math.max(0, picked.length - 1))]
            if (chosen !== undefined) state.defaultModel = chosen
            this.advanceOnboarding()
            return
          }
          const hotkey = questionOptionIndex(text, picked.length)
          if (hotkey !== undefined) {
            state.modelCursor = hotkey
            this.markDirty()
          }
          return
        }
        if (state.step === 'models' && text === '\x06') {
          void this.fetchOnboardingModels()
          return
        }
        if (text === '\r' || text === '\n') {
          const value = this.setupField(state).trim()
          if (state.step === 'id') {
            const template = onboardTemplate(state)
            const id = value === '' ? template.defaultId : value
            if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
              this.setupMessage(state, 'error', t('onboard.idInvalid'))
              this.markDirty()
              return
            }
            state.providerId = id
          } else if (state.step === 'key') {
            if (value === '' && state.providerType !== 'catalog') {
              this.setupMessage(state, 'error', t('onboard.keyEmpty'))
              this.markDirty()
              return
            }
            state.key = value
          } else if (state.step === 'models') {
            // Leaving the step is already under way (the gateway listing is in
            // flight): a second Enter must not restart it or reopen the picker.
            if (this.finishingModels.has(state)) return
            if (value === '') {
              // The default answer is a choice, not "take everything the listing
              // returned": the picker shows the models and lets the user pick
              // which to configure, then which one to run. A typed list stays
              // the power-user path and skips both questions.
              this.openOnboardingModelPicker(state)
              return
            }
            const parsed = value.split(/[\s,，]+/u).filter(Boolean)
            if (parsed.length === 0) {
              this.setupMessage(state, 'error', t('onboard.needModel'))
              this.markDirty()
              return
            }
            state.models = parsed
            state.defaultModel = parsed[0]
          } else if (state.step === 'context') {
            // Enter keeps the pre-filled value; a typed number overrides it.
            if (value !== '') {
              const parsed = Number.parseInt(value.replace(/[_,\s]/gu, ''), 10)
              if (!Number.isInteger(parsed) || parsed <= 0) {
                this.setupMessage(state, 'error', t('onboard.contextInvalid', { value }))
                this.markDirty()
                return
              }
              state.routeContextWindow = parsed
            }
          } else {
            state.baseUrl = value
          }
          this.setupSetField(state, '', 0)
          this.advanceOnboarding()
          return
        }
        for (const char of text) {
          if (char >= ' ' && char !== '\x7f') this.setupInsert(state, char)
        }
        this.markDirty()
        return
      }
      case 'confirm':
        if (state.saving) return
        if (text === 'y' || text === 'Y') {
          state.saving = true
          this.setupSetField(state, '', 0)
          void this.saveOnboarding()
        } else if (text === 'n' || text === 'N') {
          state.step = 'provider'
          state.providerType = 'official'
          state.providerId = ''
          state.baseUrl = ''
          state.key = ''
          state.models = []
          // A restart must not inherit the previous run's picker: a stale
          // `modelChecked` would pre-tick models from the provider being left.
          state.defaultModel = undefined
          state.modelCandidates = []
          state.modelChecked = new Set<number>()
          state.modelCursor = 0
          state.modelCapacity = new Map()
          this.setupSetField(state, '', 0)
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
    } else if (isModelsStep(state.step)) {
      // Leaving the models step is asynchronous: the gateway is asked once more
      // for whatever the picks are still missing (see finishModelsStep).
      void this.finishModelsStep(state)
      return
    } else if (state.step === 'context') {
      state.step = 'confirm'
    }
    this.setupSetField(state, '', 0)
    this.markDirty()
  }

  /**
   * Open the models picker: every model the listing offered — or the template's
   * pinned ones when nothing was listed — with the template's models checked.
   *
   * Enter used to accept the whole listing, which quietly wrote every model of
   * the gateway into settings and made the session's model whichever id came
   * first. The picker makes both the set and the session's model explicit; a
   * typed list still skips it.
   */
  private openOnboardingModelPicker(state: OnboardingState): void {
    const template = onboardTemplate(state)
    const candidates = [...new Set(
      (state.models.length > 0 ? state.models : template.defaultModels).filter(id => id !== ''),
    )]
    if (candidates.length === 0) {
      this.setupMessage(state, 'error', t('onboard.needModel'))
      this.markDirty()
      return
    }
    const pinned = new Set(template.defaultModels)
    const checked = new Set<number>()
    candidates.forEach((id, index) => {
      if (pinned.has(id)) checked.add(index)
    })
    if (checked.size === 0) checked.add(0)
    state.modelCandidates = candidates
    state.modelChecked = checked
    state.modelCursor = Math.min(...checked)
    state.step = 'models-pick'
    this.setupSetField(state, '', 0)
    this.markDirty()
  }

  /** The checked models of the wizard's picker, in listing order. */
  private checkedOnboardingModels(state: OnboardingState): string[] {
    const candidates = state.modelCandidates ?? []
    return [...(state.modelChecked ?? new Set<number>())]
      .sort((left, right) => left - right)
      .map(index => candidates[index])
      .filter((id): id is string => id !== undefined)
  }

  /** Move the highlight in either picker step. */
  private moveOnboardingModelCursor(delta: number): boolean {
    const state = this.onboarding
    if (state === undefined) return false
    if (state.step === 'models-pick') {
      const total = state.modelCandidates?.length ?? 0
      if (total === 0) return false
      state.modelCursor = Math.max(0, Math.min(total - 1, (state.modelCursor ?? 0) + delta))
      this.markDirty()
      return true
    }
    if (state.step === 'model-default') {
      const picked = this.checkedOnboardingModels(state)
      if (picked.length === 0) return false
      state.modelCursor = Math.max(0, Math.min(picked.length - 1, (state.modelCursor ?? 0) + delta))
      this.markDirty()
      return true
    }
    return false
  }

  /**
   * Esc in a picker step goes back one step instead of throwing the wizard
   * away — the listing is the expensive part and the user is still choosing.
   */
  private stepBackOnboarding(): boolean {
    const state = this.onboarding
    if (state === undefined) return false
    if (state.step === 'models-pick') {
      state.step = 'models'
      this.markDirty()
      return true
    }
    if (state.step === 'model-default') {
      state.step = 'models-pick'
      const checked = [...(state.modelChecked ?? new Set<number>())]
      state.modelCursor = checked.length === 0 ? 0 : Math.min(...checked)
      this.markDirty()
      return true
    }
    return false
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
      this.setupMessage(state, 'error', t('onboard.needBase'))
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
        this.setupMessage(state, 'error', t('onboard.noModels'))
      } else {
        // Read the gateway's own route list while the key is still in hand: the
        // confirm step has no way to ask for it again.
        if (template.protocols !== undefined) {
          state.modelEndpoints = await fetchModelEndpoints(baseURL, key)
        }
        state.models = ids
        state.modelCapacity = new Map(discovered.flatMap(model => {
          const capacity: { contextWindow?: number; maxTokens?: number } = {
            ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
            ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
          }
          return Object.keys(capacity).length === 0 ? [] : [[model.id, capacity] as const]
        }))
        this.setupSetField(state, '', 0)
        this.setupMessage(state, 'system', t('onboard.fetchedModels', { count: ids.length, list: formatModelList(ids, 6) }))
      }
    } catch (error) {
      this.setupMessage(state, 'error', t('onboard.fetchFailed', { error: errorChain(error) }))
    } finally {
      this.status = previousStatus
      this.markDirty()
    }
  }

  private async saveOnboarding(): Promise<void> {
    const state = this.onboarding
    if (state === undefined) return
    // `/setup` can switch the parent route (that is the point of adding a key),
    // so remember where it pointed before the wizard's answer is applied: the
    // subagent pin question below needs the old value.
    const previousParentProvider = this.currentProviderId()
    let saved = true
    try {
      const credentials = this.ctx.get('credentials')
      const settings = this.ctx.get('settings')
      const template = onboardTemplate(state)

      if (state.providerType === 'official') {
        const envRef = 'DEEPSEEK_API_KEY'
        await this.saveCredential(credentials, envRef, state.key)
        const model = state.defaultModel ?? state.models[0] ?? 'deepseek-v4-pro'
        await this.ctx.get('agentDefaultModel')?.saveSelection({ provider: 'deepseek-official', model })
        if (this.selectionRef !== undefined) {
          this.selectionRef.current = { provider: 'deepseek-official', model }
        }
        this.onSelectionChanged?.({ provider: 'deepseek-official', model })
        await this.rememberRoute({ provider: 'deepseek-official', model })
        await this.syncSubagentToProvider('deepseek-official', state.models, previousParentProvider !== 'deepseek-official')
        if (state.baseUrl !== '' && settings !== undefined) {
          await settings.update(settingsNamespace('llm-deepseek'), { baseURL: state.baseUrl })
          this.setupMessage(state, 'system', t('onboard.baseSaved', { path: displayDshPath('settings.yaml') }))
        }
        if (saved) {
          this.setupMessage(state, 'system', t('onboard.officialDone', { model }))
        }
      } else {
        const envRef = envRefForId(state.providerId)
        const model = state.defaultModel ?? state.models[0]
        // OpenCode / third-party (llm-pi-ai) routes have no adapter-level
        // reasoning default. Re-running setup must not silently drop the
        // effort that makes thinking arrive as `reasoning` blocks; default it
        // to a supported level (if any) and persist it in both the profile
        // and the default-model selection.
        const llm = this.ctx.get('llm')
        // A hand-declared OpenAI-compatible gateway has no pi-ai catalog entry,
        // so nothing resolves its models before this profile is saved. Skip the
        // live lookup there and declare the vocabulary the TUI offers instead.
        const handDeclared = declaresOfferedReasoning(state.providerType)
        const defaultEffort = handDeclared || model === undefined || llm === undefined
          ? undefined
          : await defaultReasoningEffort(llm, state.providerId, model)
        const reasoningEfforts = onboardingReasoningEfforts(
          state.providerType,
          defaultEffort === undefined ? undefined : String(defaultEffort),
        )
        const existing = this.piAiProviderProfile(state.providerId)
        // One gateway can already be spread over sibling entries (an earlier
        // setup, or a hand-written profile): the pool is every model the gateway
        // has, so re-running setup re-homes them instead of duplicating or
        // dropping any.
        const baseProtocol = declaredProtocol(existing?.api) ?? template.api ?? 'openai-completions'
        const siblingEntries = template.protocols === undefined
          ? []
          : template.protocols
              .filter(protocol => protocol !== baseProtocol)
              .map(protocol => ({
                protocol,
                profile: this.piAiProviderProfile(siblingProviderId(state.providerId, protocol)),
              }))
        const existingModels = [
          ...(Array.isArray(existing?.models) ? existing.models : []),
          ...siblingEntries.flatMap(entry => (Array.isArray(entry.profile?.models) ? entry.profile.models : [])),
        ]
        // Where each model already sits, so the split re-homes only what the
        // gateway itself says moved: a working placement is never relocated by
        // the table, and `/setup` keeps the promise that an existing model list
        // only grows.
        const modelPlacement = new Map<string, GatewayProtocol>()
        const recordPlacement = (models: unknown, protocol: GatewayProtocol): void => {
          if (!Array.isArray(models)) return
          for (const raw of models) {
            const id = typeof raw === 'string'
              ? raw
              : typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string'
                ? (raw as { id: string }).id
                : ''
            if (id !== '' && !modelPlacement.has(id)) modelPlacement.set(id, protocol)
          }
        }
        recordPlacement(existing?.models, baseProtocol)
        for (const entry of siblingEntries) recordPlacement(entry.profile?.models, entry.protocol)
        // The confirm step can be reached without walking the models step (and
        // a saved catalog answer may have landed after it), so size the picks
        // here too: the call is idempotent and fills only missing windows.
        this.sizeOnboardingModels(state)
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
        const baseURL = state.baseUrl === ''
          ? (typeof existing?.baseURL === 'string' && existing.baseURL !== '' ? existing.baseURL : template.defaultBaseUrl)
          : state.baseUrl
        // A gateway with `protocols` keeps one wizard row and lands in several
        // provider entries, one per protocol its models actually speak. The base
        // id keeps the protocol it already declares (so routes naming it never
        // change meaning); a fresh gateway takes the template's pinned one.
        const split = template.protocols === undefined
          ? new Map<GatewayProtocol, string[]>([[baseProtocol, mergedIds]])
          : splitModelsByProtocol({
              models: mergedIds,
              ...(state.modelEndpoints === undefined ? {} : { advertised: state.modelEndpoints }),
              ...(modelPlacement.size === 0 ? {} : { existing: modelPlacement }),
              ...(gatewayModelTable(baseURL) === undefined ? {} : { table: gatewayModelTable(baseURL) }),
              fallback: baseProtocol,
              preference: template.protocols,
            })
        const profileFor = (protocol: GatewayProtocol, models: string[]): Record<string, unknown> => ({
          displayName: typeof existing?.displayName === 'string' && existing.displayName.trim() !== ''
            ? existing.displayName
            : template.label,
          ...(keyless ? {} : { apiKeyEnv: envRef }),
          // A catalog route leaves the protocol to the installed catalog: it
          // used to write no `api` at all, and pinning one here would override
          // whatever that catalog serves.
          api: template.protocols === undefined ? (template.api ?? existing?.api) : protocol,
          ...(catalogRoute && state.baseUrl === '' ? {} : { baseURL }),
          models: models.map(id => ({
            id,
            ...(state.modelCapacity?.get(id) ?? template.defaultModelCapacity?.[id] ?? {}),
            ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
          })),
          ...(state.routeContextWindow === undefined ? {} : { defaultContextWindow: state.routeContextWindow }),
          ...(defaultEffort === undefined ? {} : { reasoning: defaultEffort }),
        })
        // Write every protocol that ends up holding models, plus any sibling
        // that exists but is now empty because its models moved elsewhere.
        const writes = [...split]
          .filter(([, models]) => models.length > 0)
          .map(([protocol, models]) => ({ protocol, models }))
        for (const sibling of siblingEntries) {
          // Only an entry that exists can be emptied: never create a sibling
          // just to say it holds nothing.
          if (sibling.profile === undefined) continue
          if (!writes.some(entry => entry.protocol === sibling.protocol)) {
            writes.push({ protocol: sibling.protocol, models: [] })
          }
        }
        const entryId = (protocol: GatewayProtocol): string =>
          protocol === baseProtocol ? state.providerId : siblingProviderId(state.providerId, protocol)
        // The route the wizard hands over must be the entry that actually lists
        // the chosen model — with a split they are no longer the same id.
        const ownerId = entryId(writes.find(entry => entry.models.includes(model))?.protocol ?? baseProtocol)
        if (settings === undefined) {
          this.setupMessage(state, 'error', t('onboard.settingsMissing'))
          saved = false
        } else {
          await settings.mutate(settingsNamespace('llm-pi-ai'), writes.map(entry => ({
            op: 'set' as const,
            path: ['providers', entryId(entry.protocol)],
            value: profileFor(entry.protocol, entry.models),
          })))
          this.setupMessage(state, 'system', t('onboard.providerSaved', { id: state.providerId, path: displayDshPath('settings.yaml') }))
          if (template.protocols !== undefined) {
            const summary = writes.map(entry => `${GATEWAY_PROTOCOL_SUFFIX[entry.protocol]} ${entry.models.length}`).join(' · ')
            this.setupMessage(state, 'system', t('onboard.providerSplit', { id: state.providerId, summary }))
          }
        }
        // Only store the key when its provider profile actually made it to
        // settings; otherwise the saved key points at an unusable route.
        if (saved && !keyless) await this.saveCredential(credentials, envRef, state.key)
        if (saved) {
          const selection: ModelSelection = {
            provider: ownerId,
            model,
            ...(defaultEffort === undefined ? {} : { reasoningEffort: defaultEffort }),
          }
          await this.ctx.get('agentDefaultModel')?.saveSelection(selection)
          if (this.selectionRef !== undefined) {
            this.selectionRef.current = selection
          }
          this.onSelectionChanged?.(selection)
          await this.rememberRoute(selection)
          await this.syncSubagentToProvider(ownerId, state.models, previousParentProvider !== ownerId)
          this.setupMessage(state, 'system', t('onboard.customDone', { id: ownerId, model }))
        }
      }
    } catch (error) {
      saved = false
      this.setupMessage(state, 'error', t('onboard.saveFailed', { error: errorChain(error) }))
    } finally {
      this.onboarding = undefined
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
      // The store writes it; we are the reason it exists. On Windows that write
      // ignored any mode the store passed, so the file that holds every API key
      // gets its ACL tightened here.
      await restrictPathToUser(join(dshHomeDir(), '.credentials.yaml'), { mode: 0o600 })
      this.pushRow(represent('command-feedback', { kind: 'system', text: t('onboard.credSaved', { env: envRef, path: displayDshPath('.credentials.yaml') }) }))
      return
    }
    await this.writeLaunchEnv({ [envRef]: key })
    this.pushRow(represent('command-feedback', {
      kind: 'system',
      text: shadowed
        ? IS_WINDOWS
          ? t('onboard.envShadowWin', { env: envRef })
          : t('onboard.envShadowUnix', { env: envRef })
        : t('onboard.credMissing', { path: displayDshPath(envFileName()) }),
    }))
  }

  /** Write launch-environment overrides so they beat system-injected variables. */
  private async writeLaunchEnv(entries: Record<string, string>): Promise<void> {
    const home = dshHomeDir()
    const file = join(home, envFileName())
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
      // This file holds API keys. `mode` covers POSIX; on Windows the same
      // intent has to be an ACL or the keys sit under whatever the parent
      // directory allowed.
      await restrictPathToUser(file, { mode: 0o600 })
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
    await restrictPathToUser(file, { mode: 0o600 })
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
    if (this.screen !== undefined) {
      // A confirmation the Screen is asking is settled first; otherwise Esc leaves
      // the Screen. Esc must not fall through to the transcript below it — that is
      // the same rule every other key follows while a Screen owns the screen.
      this.handleScreenInput('\x1b', undefined)
      return
    }
    if (this.dialog?.kind === 'questions'
      && isSurfaceDialog(this.dialog)
      && (this.dialog.filtering === true || (this.dialog.filter ?? '') !== '')) {
      // Esc means "show me everything again" while a filter is up; cancelling
      // the whole question on the same key would throw away the answer the user
      // is still composing.
      clearQuestionFilter(this.dialog)
      this.markDirty()
      return
    }
    if (this.dialog !== undefined) {
      if (!isSurfaceDialog(this.dialog)) {
        // A deprecated shape cannot be answered; dropping it is the only honest exit
        // (the wizard is a Screen now and never gets here).
        this.dialog = undefined
        this.showNextDialog()
        return
      }
      if (this.dialog.kind === 'confirm') this.closeConfirm('cancel')
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
      this.pushRow(represent('command-feedback', { kind: 'system', text: t('cancel.esc') }))
      this.agent.cancel({ kind: 'user' })
      this.status = 'cancelling…'
      this.markDirty()
    }
  }

  /** Toggle the collapsible row under a click, or copy an OSC-8 link. */
  /**
   * The anchor's line index in the *current* frame.
   *
   * A live session repaints while the button is down, and the transcript is
   * pinned to the bottom: a row arriving below shifts everything up by one. The
   * stored index would then point at whatever moved into that screen row, so
   * the anchor is re-found by the row it grabbed (and by its text when the row
   * carries no identity). When the row has scrolled out of view entirely, the
   * old index is the best that can be done.
   */
  private resolveAnchorLine(): number | undefined {
    const anchor = this.mouseAnchor
    if (anchor === undefined) return undefined
    const candidates: number[] = []
    for (let index = 0; index < this.selectableLines.length; index += 1) {
      const line = this.selectableLines[index]
      if (line === undefined || line.copyable !== true) continue
      if (this.mouseAnchorRef !== undefined) {
        if (line.ref === this.mouseAnchorRef) candidates.push(index)
      } else if (stripAnsi(line.raw) === this.mouseAnchorText) {
        candidates.push(index)
      }
    }
    if (candidates.length === 0) return anchor.line
    return candidates.reduce(
      (best, index) => (Math.abs(index - anchor.line) < Math.abs(best - anchor.line) ? index : best),
      candidates[0] ?? anchor.line,
    )
  }

  /** The painted lines as plain text, for the selection rules. */
  private plainSelectableLines(): SelectableLine[] {
    return this.selectableLines.map(line => ({
      text: stripAnsi(line.raw),
      copyable: line.copyable,
      gutter: line.gutter,
    }))
  }

  /** Screen row from a mouse report to an index into `selectableLines`. */
  private selectableLineAt(screenY: number): number | undefined {
    // A row a covered region sits on is not a row the reader can point at: the drag
    // selection stops at that region's top edge instead of running under it. Both
    // regions count — the live tail paints over the newest history just as the
    // transient layer paints over whatever it needs.
    if (this.interactionRegion !== undefined && screenY >= this.interactionRegion.top) return undefined
    if (this.liveTailRegion !== undefined && screenY >= this.liveTailRegion.top) return undefined
    const index = screenY - this.transcriptTopScreenY
    if (index < 0 || index >= this.selectableLines.length) return undefined
    return index
  }

  /** The last transcript row the interaction does not cover, or the whole list. */
  private lastSelectableLine(): number {
    const tops = [this.interactionRegion?.top, this.liveTailRegion?.top]
      .filter((top): top is number => top !== undefined)
    if (tops.length === 0) return this.selectableLines.length - 1
    return Math.min(this.selectableLines.length - 1, Math.min(...tops) - 1 - this.transcriptTopScreenY)
  }

  /**
   * Left button pressed. The click itself waits for the release: this may turn
   * into a drag, and a press that never moves must still open a link or toggle
   * a card exactly as before.
   */
  private beginMouseSelection(y: number, x: number): void {
    this.pendingMouseClick = undefined
    this.mouseAnchor = undefined
    // A Screen covers the transcript, so nothing behind it is a target: the click
    // is remembered (the release may still be a link or a card toggle, and it too
    // will be refused below) but no selection can start on a row nobody can see.
    if (this.dialog !== undefined || this.screen !== undefined) {
      this.pendingMouseClick = { y, x }
      return
    }
    const line = this.selectableLineAt(y)
    if (line === undefined || this.selectableLines[line]?.copyable !== true) {
      this.pendingMouseClick = { y, x }
      return
    }
    this.mouseAnchor = { line, column: Math.max(0, x - 1) }
    const grabbed = this.selectableLines[line]
    this.mouseAnchorRef = grabbed?.ref
    this.mouseAnchorText = grabbed === undefined ? '' : stripAnsi(grabbed.raw)
    this.mouseSelection = undefined
  }

  /** The button is held and the pointer moved: extend the drag and repaint it. */
  private extendMouseSelection(y: number, x: number): void {
    const resolved = this.resolveAnchorLine()
    if (resolved === undefined || this.mouseAnchor === undefined) return
    this.mouseAnchor = { line: resolved, column: this.mouseAnchor.column }
    const anchor = this.mouseAnchor
    const line = this.selectableLineAt(y) ?? (y < this.transcriptTopScreenY ? 0 : this.lastSelectableLine())
    const clamped = clampSelection(this.plainSelectableLines(), anchor, { line, column: Math.max(0, x - 1) })
    if (clamped === undefined) return
    const same = this.mouseSelection !== undefined
      && this.mouseSelection.from.line === clamped.from.line
      && this.mouseSelection.from.column === clamped.from.column
      && this.mouseSelection.to.line === clamped.to.line
      && this.mouseSelection.to.column === clamped.to.column
    this.mouseSelection = clamped
    if (!same) this.markDirty()
  }

  /** Release: copy the dragged text, or perform the click that never became one. */
  private endMouseSelection(y: number, x: number): void {
    const resolved = this.resolveAnchorLine()
    const anchor = resolved === undefined || this.mouseAnchor === undefined
      ? undefined
      : { line: resolved, column: this.mouseAnchor.column }
    const selection = this.mouseSelection
    const click = this.pendingMouseClick
    this.mouseAnchor = undefined
    this.mouseAnchorRef = undefined
    this.mouseAnchorText = ''
    this.mouseSelection = undefined
    this.pendingMouseClick = undefined
    if (anchor === undefined) {
      if (click !== undefined) this.handleMouseClick(click.y, click.x)
      return
    }
    const text = selection === undefined ? '' : selectionText(this.plainSelectableLines(), selection)
    if (text.trim() === '') {
      // A press that did not really drag is a click, not an empty copy.
      this.handleMouseClick(y, x)
      this.markDirty()
      return
    }
    const lines = selection === undefined ? 1 : selection.to.line - selection.from.line + 1
    this.copyPlainText(text, t('copy.selection', { chars: text.length, lines }))
    this.markDirty()
  }

  /** Paint the drag in reverse video; the affected lines drop their colors. */
  private highlightSelection(visible: readonly string[]): string[] {
    const selection = this.mouseSelection
    if (selection === undefined) return [...visible]
    const plain = this.plainSelectableLines()
    const spans = selectionSpans(plain, selection)
    if (spans.length === 0) return [...visible]
    const lines = [...visible]
    for (const span of spans) {
      const text = plain[span.line]?.text ?? ''
      const startOffset = offsetAtColumn(text, span.start)
      const endOffset = offsetAfterColumn(text, span.end)
      lines[span.line] = `${text.slice(0, startOffset)}\x1b[7m${text.slice(startOffset, endOffset)}\x1b[27m${text.slice(endOffset)}`
    }
    return lines
  }

  handleMouseClick(y: number, x = 1): void {
    // Nothing behind a Surface or a Screen is a target: the rows the reader can
    // point at are the rows the current channel actually painted.
    if (this.dialog !== undefined || this.screen !== undefined) return
    // The health chip is a standing warning, so clicking it opens the report
    // that explains it — the row is the strip, and the chip leads it.
    if (this.healthChipRow !== undefined && y === this.healthChipRow) {
      this.runCommand('/doctor')
      return
    }
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
    // The selection stays: the marker on the copied row is how the reader sees
    // *what* went to the clipboard, and a second press of the copy key must be
    // idempotent. Clearing it here made the next `/copy` silently fall back to
    // "the latest reply" — a different row, with nothing on screen to say so.
    this.input = ''
    this.cursor = 0
    this.inputFolded = false
    this.leaveHistoryBrowse()
    this.write(osc52Clipboard(text))
    this.pushRow(represent('copy-feedback', { kind: 'system', text: notice }))
    // The write is a request the terminal may ignore: VTE (GNOME/XFCE/…) has
    // never implemented OSC 52, conhost and screen cannot, Konsole only from
    // 24.12, and xterm/tmux need configuration. The write still goes out — it is
    // how the terminals that *do* honour it work — but where the table does not
    // promise it the user is told once per session rather than at every copy, or
    // not at all until they paste into an empty clipboard.
    //
    // An SSH session is the exception the table cannot see. The classifier reads
    // the *remote* terminal (the tty on the far side of the connection, which is
    // usually a bare Linux console or an unnamed pty), while the bytes are
    // written to the *local* terminal — the one the user is actually copying
    // into. That local terminal is what accepted the write, which is why a copy
    // over SSH works and then warns that it did not. Warning there is a lie, so
    // the caveat stays quiet inside an SSH session.
    //
    // The test is the session itself and not `paintLink`, which is also `'ssh'`
    // on a local window whenever the launcher relayed the frame: there the
    // capability table *did* describe the terminal that receives the bytes, so
    // the caveat is exactly what the user needs to read (the terminal probe
    // asserts it does, for seven terminal profiles).
    if (!this.terminalCaps.osc52 && !this.sshSession && !this.osc52HintShown) {
      this.osc52HintShown = true
      this.pushRow(represent('copy-caveat', { kind: 'system', text: t('copy.osc52Hint', { terminal: this.terminalCaps.label }) }))
    }
    this.markDirty()
  }

  /**
   * `/copy [reply|highlight|error]` — copy plain text to the local clipboard.
   *
   * The default is the model's **last reply**, which is what a reader wants on
   * the clipboard most of the time: the answer they just read, whole, ready to
   * paste into a report. It used to be "the highlighted card, else the newest
   * reply", so any card left highlighted (one click on a tool card does it)
   * silently redirected the copy and the reply became unreachable without
   * deselecting first. `highlight` is that old rule, now said out loud.
   */
  copyFocusedCard(arg = ''): boolean {
    const mode = arg.trim().toLowerCase()
    // `error` copies the newest failure or diagnostic row: a long path or a
    // command in one of those must reach the clipboard whole, which is exactly
    // what copying the row's own text does (the wrapped screen lines a drag
    // would join are not what the user wants to paste into a report).
    if (mode === 'error') return this.copyErrorRow()
    if (mode === 'highlight') return this.copyHighlighted(false)
    if (mode === '' || mode === 'reply') return this.copyLatestReply()
    this.pushRow(represent('copy-feedback', { kind: 'system', text: t('copy.usage') }))
    this.markDirty()
    return false
  }

  /**
   * The copy key: what the reader is *pointing at*.
   *
   * The key and the command are two grammars over the same act, and they differ
   * in exactly one place: with nothing highlighted the key falls back to the
   * newest reply (a key that copies nothing reads as a broken key), while
   * `/copy highlight` says there is nothing highlighted. Inside a Surface the key
   * is the only way to copy at all: a Screen carries what it shows, and every
   * other dialog keeps the key inert, exactly as it always was.
   */
  private copyKey(): boolean {
    if (this.dialog !== undefined && this.screen === undefined) return false
    return this.copyHighlighted(true)
  }

  /** The newest error or diagnostic row, whole. */
  private copyErrorRow(): boolean {
    const failed = this.rows.findLast(row => row.kind === 'error' || row.kind === 'diag')
    const text = copyTextFromRow(failed)
    if (text.trim() === '') {
      this.pushRow(represent('copy-feedback', { kind: 'system', text: t('copy.noError') }))
      this.markDirty()
      return false
    }
    this.copyPlainText(text, t('copy.ok', { chars: text.length, source: t('copy.sourceError') }))
    return true
  }

  /** The highlighted card — or, for the key, the newest reply when none is. */
  private copyHighlighted(fallbackToReply: boolean): boolean {
    const overlay = this.screen
    const shown = overlay?.copyText
    const picked = shown !== undefined && shown.trim() !== ''
      ? { text: shown, source: 'focused' as const }
      : copyTextFromTranscript([...this.visibleRows()], this.focusedRow, 'highlight')
    if (picked.text.trim() === '') {
      if (fallbackToReply) return this.copyLatestReply()
      this.pushRow(represent('copy-feedback', { kind: 'system', text: t('copy.noHighlight') }))
      this.markDirty()
      return false
    }
    // The label follows the text: when the overlay supplied it, the row the
    // cursor sits on may be a different card entirely (Ctrl+N/P used to move
    // it behind the overlay), and naming that row would be a false report.
    const source = shown !== undefined && shown.trim() !== ''
      ? t('copy.sourceFull')
      : picked.source === 'focused'
        ? t(this.focusedRow?.kind === 'assistant' ? 'copy.sourceFocusedReply' : 'copy.sourceFocused')
        : t('copy.sourceAssistant')
    const notice = t('copy.ok', { chars: picked.text.length, source })
    this.copyPlainText(picked.text, notice)
    if (overlay !== undefined) {
      // The notice row is behind the overlay, so the overlay says it too.
      overlay.notice = notice
      this.markDirty()
    }
    return true
  }

  /** The model's last reply: the `/copy` default, and the key's last resort. */
  private copyLatestReply(): boolean {
    const text = latestReplyText([...this.visibleRows()])
    if (text === '') {
      this.pushRow(represent('copy-feedback', { kind: 'system', text: t('copy.empty') }))
      this.markDirty()
      return false
    }
    this.copyPlainText(text, t('copy.ok', { chars: text.length, source: t('copy.sourceAssistant') }))
    return true
  }

  /**
   * Scroll whichever surface the reader is looking at, by `up` lines toward the
   * earlier content.
   *
   * One sign for every caller, because the two surfaces count in opposite
   * directions: the transcript's `scrollOffset` is the distance *back* from the
   * newest line, and the overlay's `offset` is the index of its first visible line.
   * Adding one delta to both — which is what this did — made PgUp and the wheel
   * scroll the overlay the wrong way, while the arrow keys, which passed their own
   * inverted sign, were the only ones that felt right. A surface that is not the
   * inspect overlay owns the keyboard and takes no scroll at all: the transcript
   * behind a dialog must not move.
   */
  private scrollActiveSurface(up: number): void {
    if (this.screen !== undefined) {
      this.scrollScreen(up)
      return
    }
    if (this.dialog !== undefined) return
    if (this.paintTailBudget > 0) {
      this.paintTailBudget = 0
      this.forceFullPaint = true
    }
    this.scrollOffset = Math.max(0, this.scrollOffset + up)
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
      this.pushRow(represent('command-feedback', { kind: 'system', text: t('cancel.ctrlC') }))
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
    this.pushRow(represent('command-feedback', { kind: 'system', text: t('exit.ctrlCAgain') }))
    this.markDirty()
  }

  private submit(): void {
    if (this.dialog !== undefined) {
      this.handleDialogChar('\r')
      return
    }
    // The reader has moved on: an acknowledgement or a warning from their last action
    // has done its job, and it is not history to keep. A submit is the earliest exit
    // (0.8.2 also expires them on their own after `feedbackTtlMs` — the row is the
    // session's again once the sentence has been readable, whether or not anyone
    // typed in the meantime).
    if (this.footerEcho !== undefined || this.notice !== undefined) {
      this.footerEcho = undefined
      this.notice = undefined
    }
    this.scrollOffset = 0
    // A selected reply has no card to fold, so Enter has to reach it too: the
    // gate below only asks about collapsible rows, and in a session with no card
    // at all (a plain Q&A, or right after `/clear`) that left Enter doing
    // nothing while `Alt+4` / Ctrl+N had just selected the reply.
    if (this.input.trim() === '' && this.focusedRow !== null && this.focusedRow.kind === 'question') {
      // A question the Session still accepts an answer for is the one card whose
      // Enter is an action rather than a fold: the wait that opened it is gone (its
      // window closed, or a different process held it), and the durable projection
      // is what says it is still answerable.
      if (this.answerContinuedQuestion(this.focusedRow)) return
    }
    if (this.input.trim() === '' && this.focusedRow !== null && this.focusedRow.kind === 'assistant') {
      this.toggleCollapsible()
      return
    }
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
    // Framed mode paints the composer; line mode has to put the typed line
    // into the log itself, or a `tee` never sees what the user sent.
    if (this.lineMode) this.pushRow(represent('command-feedback', { kind: 'user', text: t('line.prompt', { text }) }))
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
    this.sawUserInput = true
    this.lastUserText = text
    this.input = ''
    this.cursor = 0
    this.inputFolded = false
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    if (this.agent.status === 'running') {
      this.pendingMessages.set(message.id, text)
      // An acknowledgement, not history: the *record* of a mid-turn message is the
      // `user/message` the Harness appends when the step claims it, and the reader
      // only needs to know now that it was accepted and when it applies. As a
      // footer chip it was the first thing dropped on a busy stats row — with a
      // turn running that row is exactly that — so a reader who typed mid-turn saw
      // no confirmation at all (B2.4). The notice row is always on screen and costs
      // no geometry.
      this.showQueuedNotice(t('steer.queued', { text }))
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
        this.openReport('help', [
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
        ])
        break
      }
      case 'quit':
      case 'exit':
        void this.requestExit(0)
        break
      case 'model':
        void this.runModelCommand().catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow(represent('command-feedback', { kind: 'system', text: t('help.modelCancel') }))
          } else {
            this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command: 'model', error: errorChain(error) }) }))
          }
          this.markDirty()
        })
        break
      case 'effort':
        void this.runEffortCommand(arg).catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow(represent('command-feedback', { kind: 'system', text: t('help.effortCancel') }))
          } else {
            this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command: 'effort', error: errorChain(error) }) }))
          }
          this.markDirty()
        })
        break
      case 'provider':
        void this.runProviderCommand().catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow(represent('command-feedback', { kind: 'system', text: t('help.providerCancel') }))
          } else {
            this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command: 'provider', error: errorChain(error) }) }))
          }
          this.markDirty()
        })
        break
      case 'submodel':
        void this.runSubmodelCommand(arg).catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow(represent('command-feedback', { kind: 'system', text: t('help.submodelCancel') }))
          } else {
            this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command: 'submodel', error: errorChain(error) }) }))
          }
          this.markDirty()
        })
        break
      case 'subeffort':
        void this.runSubeffortCommand(arg).catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow(represent('command-feedback', { kind: 'system', text: t('help.subeffortCancel') }))
          } else {
            this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command: 'subeffort', error: errorChain(error) }) }))
          }
          this.markDirty()
        })
        break
      case 'mode':
        void this.runModeCommand(arg).catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow(represent('command-feedback', { kind: 'system', text: t('help.modeCancel') }))
          } else {
            this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command: 'mode', error: errorChain(error) }) }))
          }
          this.markDirty()
        })
        break
      case 'language':
      case 'lang':
        void this.runLanguageCommand(arg).catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow(represent('command-feedback', { kind: 'system', text: t('help.modeCancel') }))
          } else {
            this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command: 'language', error: errorChain(error) }) }))
          }
          this.markDirty()
        })
        break
      case 'view':
        void this.runViewCommand(arg).catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow(represent('command-feedback', { kind: 'system', text: t('help.modeCancel') }))
          } else {
            this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command: 'view', error: errorChain(error) }) }))
          }
          this.markDirty()
        })
        break
      case 'notify':
        void this.runNotifyCommand(arg).catch((error: unknown) => {
          this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command: 'notify', error: errorChain(error) }) }))
          this.markDirty()
        })
        break
      case 'disconnect':
        void this.runDisconnectCommand(arg).catch((error: unknown) => {
          if (error instanceof UserQuestionError) {
            this.pushRow(represent('command-feedback', { kind: 'system', text: t('help.modeCancel') }))
          } else {
            this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command: 'disconnect', error: errorChain(error) }) }))
          }
          this.markDirty()
        })
        break
      case 'cleanup':
        void this.runCleanupCommand(arg).catch((error: unknown) => {
          this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command: 'cleanup', error: errorChain(error) }) }))
          this.markDirty()
        })
        break
      case 'theme':
        void this.runThemeCommand(arg).catch((error: unknown) => {
          this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command: 'theme', error: errorChain(error) }) }))
          this.markDirty()
        })
        break
      case 'retryauth':
        void this.runRetryAuthCommand(arg).catch((error: unknown) => {
          this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command: 'retryauth', error: errorChain(error) }) }))
          this.markDirty()
        })
        break
      case 'copy':
        this.copyFocusedCard(arg)
        break
      case 'find':
        this.runFindCommand(arg)
        break
      case 'clear':
        // A presentation-only cutoff (AD-4). Nothing is deleted: not the rows, not
        // the session log, not the agent's context, not an artifact. The view starts
        // after this point, and a resume shows the full history again — which is the
        // documented behaviour, not a bug to be papered over with a log write.
        this.clearedRows = this.rows.length
        this.scrollOffset = 0
        this.focusedRow = null
        this.searchHits = []
        this.searchIndex = -1
        this.searchQuery = ''
        this.pendingReveal = undefined
        this.pendingMouseClick = undefined
        this.mouseAnchor = undefined
        this.mouseSelection = undefined
        // Said as a notice rather than a row: the reader asked for a clearer screen,
        // and answering with a line the cutoff immediately hides would be absurd —
        // or worse, a line that survives and makes `/clear` look like it failed.
        this.notice = { text: t('clear.cutoff'), at: Date.now() }
        this.armFeedbackExpiry()
        this.forceFullPaint = true
        this.markDirty()
        break
      case 'status':
        {
          const plan = this.findLivePlanRow()
          // A `continued` question is durable but the turn is over, so it is not a
          // wait: `/status` lists the two separately rather than adding them.
          const waiting = this.rows.filter(row =>
            row.kind === 'question' && row.status === 'waiting' && row.continued !== true).length
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
            ...(sub.provider === undefined ? {} : { subProvider: this.displayProviderId(sub.provider) }),
            subModel: sub.model,
            cwd: this.workspaceCwd(),
            // The default row gave these up when it became a status row rather
            // than a telemetry dump. They are not deleted anywhere: this is
            // where they live now, and `/diag` keeps its own copy.
            stats: statsRowOf(this.statsTracker.snapshot()),
            throughput: this.statsTracker.throughput(),
          })
          this.openReport('status', lines)
        }
        break
      case 'diag':
        void this.runDiagCommand().catch((error: unknown) => {
          this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command, error: errorChain(error) }) }))
          this.markDirty()
        })
        break
      case 'doctor':
        void this.runDoctorCommand(arg, /--fix|(^|\s)fix(\s|$)/u.test(arg)).catch((error: unknown) => {
          this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command, error: errorChain(error) }) }))
          this.markDirty()
        })
        break
      case 'fix':
        void this.runFixCommand(arg).catch((error: unknown) => {
          this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command, error: errorChain(error) }) }))
          this.markDirty()
        })
        break
      case 'usage':
      case 'balance':
      case 'quota':
        void this.runUsageCommand().catch((error: unknown) => {
          this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command, error: errorChain(error) }) }))
          this.markDirty()
        })
        break
      case 'subagents': {
        const trimmed = arg.trim()
        if (trimmed !== '' && trimmed !== 'list') {
          const [action, ...ids] = trimmed.split(/\s+/u)
          if (action === 'kill' || action === 'stop') {
            if (ids.length === 0) {
              this.pushRow(represent('subagent-notice', { kind: 'error', text: t('sub.killNeedId') }))
              break
            }
            const subagents = this.ctx.get('subagents')
            if (subagents === undefined) {
              this.pushRow(represent('command-misuse', { kind: 'error', text: t('cmd.serviceMissing', { service: 'subagents' }) }))
              break
            }
            const targets = ids.map(id => SessionId(id))
            void subagents.drainContinuableChildren(this.agent, targets).then(() => {
              this.pushRow(represent('subagent-notice', { kind: 'system', text: t('sub.killRequested', { ids: ids.join(', ') }) }))
              this.markDirty()
            }).catch((error: unknown) => {
              this.pushRow(represent('command-error', { kind: 'error', text: `/subagents kill failed: ${errorChain(error)}` }))
              this.markDirty()
            })
            break
          }
          this.pushRow(represent('subagent-notice', { kind: 'error', text: t('sub.unknownAction', { action }) }))
          break
        }
        if (this.activeSubagents.size === 0) {
          this.openReport('subagents', [t('sub.none')])
        } else {
          const lines = [...this.activeSubagents.entries()].map(([, sub]) => {
            const card = this.findSubagentRow(sub.id)
            const label = card === undefined ? this.subagentNameFor(sub.id) : subagentDisplayName(card)
            const activity = card === undefined ? '' : (() => {
              const summary = subagentChipSummary(card)
              return summary === '' ? '' : ` · ${summary}`
            })()
            return t('sub.listLine', {
              label,
              // `/subagents kill` takes this id, and the list is where a user
              // looks it up: the chip itself stays name-only.
              id: sub.id,
              provider: sub.provider,
              seconds: Math.floor((Date.now() - sub.startedAt) / 1000),
              activity,
            })
          })
          // The one hint key already carries both halves: the list, then the keys.
          // Rendered empty it yields just the key line, so the body goes above it.
          const hint = t('sub.listHint', { lines: '' }).split('\n').filter(line => line !== '')
          this.openReport('subagents', [...lines, '', ...hint])
        }
        break
      }
      case 'approval': {
        const requested = arg.trim() === '' ? 'toggle' : arg.trim()
        if (isApprovalStatusArg(requested)) {
          this.pushRow(represent('approval-warning', {
            kind: 'system',
            text: this.autoApprovalMode === 'auto'
              ? t('approval.statusAuto', {
                allowed: this.autoAllowedCount,
                denied: this.autoDeniedCount,
                reviewed: this.aiReviewCount,
                cacheHits: this.cacheHitCount,
                cached: this.approvalCache.size,
              })
              : t('approval.statusOff'),
          }))
          this.markDirty()
          break
        }
        // The cache is the one piece of auto-approval state the user can
        // inspect and drop on demand: `/approval cache` reports it,
        // `/approval cache clear` forgets every remembered verdict.
        if (requested === 'cache' || requested === 'cache clear' || requested === 'cache status') {
          if (requested === 'cache clear') {
            const dropped = this.approvalCache.clear()
            this.pushRow(represent('approval-warning', { kind: 'system', text: t('approval.cacheCleared', { count: dropped }) }))
          } else {
            this.pushRow(represent('approval-warning', {
              kind: 'system',
              text: t('approval.cacheStatus', {
                cached: this.approvalCache.size,
                cacheHits: this.cacheHitCount,
                minutes: this.approvalCache.ttlMinutes,
              }),
            }))
          }
          this.markDirty()
          break
        }
        const next = requested === 'toggle'
          ? this.autoApprovalMode === 'auto' ? 'off' : 'auto'
          : parseAutoApprovalMode(requested)
        if (next === undefined) {
          this.pushRow(represent('approval-warning', { kind: 'error', text: t('approval.unknown', { arg: requested }) }))
          this.markDirty()
          break
        }
        this.autoApprovalMode = next
        // A remembered verdict belongs to the mode that produced it; leaving
        // auto mode (or re-entering it) starts from an empty cache.
        this.approvalCache.clear()
        void this.mergeUiSettings({ autoApproval: next }).catch((error: unknown) => {
          this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command: 'approval', error: errorChain(error) }) }))
          this.markDirty()
        })
        this.pushRow(represent('approval-warning', {
          kind: 'system',
          text: next === 'auto' ? t('approval.autoOn') : t('approval.autoOff'),
        }))
        if (next === 'auto') this.warnApprovalMismatch()
        this.markDirty()
        break
      }
      case 'preset':
        void this.runPresetCommand(arg).catch((error: unknown) => {
          this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command, error: errorChain(error) }) }))
          this.markDirty()
        })
        break
      case 'setup':
        void this.runOnboarding()
        break
      case 'dialog-test': {
        const questions = this.ctx.get('userQuestions')
        if (questions === undefined) {
          this.pushRow(represent('command-misuse', { kind: 'error', text: t('cmd.serviceMissing', { service: 'userQuestions' }) }))
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
            this.pushRow(represent('command-status', { kind: 'system', text: t('dialog.answer', { json: JSON.stringify(answer) }) }))
            this.markDirty()
          },
          (error) => {
            this.pushRow(represent('command-error', { kind: 'error', text: t('dialog.error', { error: errorChain(error) }) }))
            this.markDirty()
          },
        )
        break
      }
      default:
        {
          const commands = this.ctx.get('commands')
          if (commands === undefined) {
            this.pushRow(represent('command-misuse', { kind: 'error', text: t('cmd.unknown', { command }) }))
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
              this.pushRow(represent('command-misuse', { kind: 'error', text: t('cmd.unknown', { command }) }))
              return
            }
            // command/run + command/done already paint via handleCommandDone
            // when the session log is live. Fall back if those events never
            // arrived (no persistence, or a handler that skipped the log).
            if (this.seenCommandDoneIds.has(String(execution.commandId))) return
            if (execution.result.kind === 'error') {
              this.pushRow(represent('command-error', { kind: 'error', text: formatCompactCommandError(this.formatCommandText(execution.result.text)) }))
            } else if (execution.result.text !== undefined && execution.result.text !== '') {
              this.pushRow(represent('command-feedback', { kind: 'system', text: this.formatCommandText(execution.result.text) }))
            }
          }).catch((error: unknown) => {
            this.pushRow(represent('command-error', { kind: 'error', text: t('cmd.failedNamed', { command, error: errorChain(error) }) }))
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

  /** Delete one grapheme back, in whichever field owns the keyboard. */
  private backspace(): void {
    const text = this.fieldText()
    const cursor = this.fieldCursor()
    if (cursor === 0) return
    this.leaveHistoryBrowse()
    const range = this.graphemeBefore(cursor)
    this.setField(`${text.slice(0, range.start)}${text.slice(range.end)}`, range.start)
    this.markDirty()
  }

  /** Delete one grapheme forward, in whichever field owns the keyboard. */
  private deleteAtCursor(): void {
    const text = this.fieldText()
    const range = this.graphemeAfter(this.fieldCursor())
    if (range === undefined) return
    this.leaveHistoryBrowse()
    this.setField(`${text.slice(0, range.start)}${text.slice(range.end)}`, range.start)
    this.markDirty()
  }

  /** Move the caret one grapheme, in whichever field owns the keyboard. */
  private moveCursor(delta: number): void {
    const text = this.fieldText()
    const cursor = this.fieldCursor()
    if (delta < 0) {
      let target = 0
      for (const segment of GRAPHEME_SEGMENTER.segment(text)) {
        if (segment.index >= cursor) break
        target = segment.index
      }
      this.setField(text, target)
    } else {
      let target = text.length
      for (const segment of GRAPHEME_SEGMENTER.segment(text)) {
        const start = segment.index
        const end = start + segment.segment.length
        if (start > cursor) {
          target = start
          break
        }
        if (end > cursor) {
          target = end
          break
        }
      }
      this.setField(text, target)
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

  // The explicit `return undefined` is deliberate, not noise: 0.1.6-alpha.2 turns
  // `agent/created` into a serial event whose handler must return
  // `undefined | Promise<undefined>`, and a bare `void` body is *not* assignable
  // to that (verified by compiling this file against the published 0.1.6-alpha.2
  // types: TS2322/TS2345). Returning `undefined` satisfies the whole 0.1.5 line
  // too, so the handler is ready for the next line without a compat branch.
  const disposeCreated = ctx.on('agent/created', ({ agent }) => {
    start(agent)
    return undefined
  })
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
    sessionHadUserInput(): boolean {
      return controller?.sessionHadUserInput() ?? false
    },
  }
}
