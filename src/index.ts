/**
 * dsh-ssh-tui — an SSH-friendly interactive terminal front door for DeepSeek
 * Harness. The bundle rides over @deepseek-ai/dsh-base and drives one
 * configured agent, so the whole plugin ecosystem (shell, filesystem, skills,
 * subagents, sandbox approvals) is the same one the web surface uses.
 */

import { installModelSelection, type AgentHandle, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'

/** Read the user's `agent-default-model` straight from `$DSH_HOME/settings.yaml`. */
function readAgentDefaultFromFile(): Record<string, unknown> | undefined {
  const home = resolveDshHome()
  try {
    const parsed = yaml.load(readFileSync(join(home, 'settings.yaml'), 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const section = (parsed as Record<string, unknown>)['agent-default-model']
    return section !== null && typeof section === 'object' && !Array.isArray(section)
      ? section as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}
import { showSessionPicker } from './picker.js'
import { copyTrapHint } from './doctor.js'
import { presetLabel } from './preset-label.js'

// The attach/recovery state machine (and its constants) live in attach.ts so
// they can be driven by tests; re-exported here for the bundle's own API.
export { ATTACH_RECOVERY_WINDOW_MS, attachPeerVanished } from './attach.js'
import { lineModeEnabled } from './line-mode.js'
import { writeBootSplash } from './paint.js'
import { mountTui, type TuiController } from './tui.js'
import { defaultReasoningEffort } from './reasoning.js'
import { createSubagentSelection, releaseSessionSubagentSelection, SUBAGENT_SETTINGS_NAMESPACE } from './subagent-model.js'
import {
  acquireSessionLock,
  inspectLiveHost,
  releaseSessionLock,
  sessionLockDisabled,
  writeSessionLock,
  type SessionLockInfo,
} from './session-lock.js'
import {
  captureTerminalInput,
  isTuiHostProcess,
  quietTerminalInput,
  resolveDshHome,
  runDisplayRelay,
  spawnDetachedHost,
  waitForDisplaySock,
} from './display-sock.js'
import {
  createAttacher,
  HOST_START_TIMEOUT_MS,
} from './attach.js'
import { createLauncherExit } from './launcher-exit.js'
import { installRouteMemory, latestRememberedRoute, parseRouteMemory, ROUTE_MEMORY_NAMESPACE } from './route-memory.js'
import { enterSessionCwd } from './session-list.js'
import {
  BUILTIN_ROUTABLE_PROVIDERS,
  providerIsRoutable,
  resolveLaunchRoute,
  restoreSessionRoute,
  sameSessionRoute,
  saveSessionRoute,
  sessionRouteInput,
  type SessionRoute,
} from './session-route.js'
import {
  liveField,
  readSettingsSection,
  settingsDocument,
  settingsNamespace,
} from './dsh-compat.js'
import z from '@deepseek-ai/schemastery'
import { installUiLocale, t } from './i18n/index.js'


export const name = 'ssh-tui'

/** Core services required before the terminal channel can drive an agent. */
export const inject = ['agents', 'agentDefaultModel']

// Re-exported for the bundle's own API; the exit path (and its reasons) live in
// `launcher-exit.ts` so the picker, `/exit`, the attach recovery and the error
// paths all hand the terminal back the same way.
export { EXIT_FALLBACK_MS, createLauncherExit } from './launcher-exit.js'

/** Plugin config: the session identity and presentation defaults. */
export interface Config {
  sessionId: string
  showReasoning?: boolean
  maxToolOutputLines?: number
  color?: boolean
  welcome?: string
  /** Whether this launch resumes an existing persisted session. */
  resume?: boolean
  /** Show the history-session picker before mounting the main interface. */
  resumePicker?: boolean
  /** CLI-supplied provider override; otherwise the saved default is used. */
  provider?: string
  /** CLI-supplied model override; otherwise the saved default is used. */
  model?: string
  /** Minimum milliseconds between paints; see DSH_TUI_PAINT_MS. */
  paintIntervalMs?: number
  /**
   * The fields below are the TUI's live settings, i.e. the `ssh-tui` section.
   * They ride on this entry's schema so 0.1.7 can project a form for it — and so
   * a pre-0.1.7 `$DSH_HOME/settings.yaml` `ssh-tui:` section is imported into
   * this entry rather than left behind.
   */
  /** UI language (`/language`); zh unless the environment says otherwise. */
  language?: string
  /** Newest plugin version whose update notice was dismissed. */
  skipUpdate?: string
  /** Workspace pane layout (`/view`). */
  view?: string
  /** What a dropped display does (`/disconnect`). */
  disconnect?: string
  /** Auto-approval mode (`/autoapproval`). */
  autoApproval?: string
  /** Milliseconds a leftover finished Host waits before exiting; 0 = never. */
  idleExit?: number
}

/** Every field above, as schemastery resolves them (all optional). */
interface ConfigFields {
  sessionId?: string
  showReasoning?: boolean
  maxToolOutputLines?: number
  color?: boolean
  welcome?: string
  resume?: boolean
  resumePicker?: boolean
  provider?: string
  model?: string
  paintIntervalMs?: number
  language?: string
  skipUpdate?: string
  view?: string
  disconnect?: string
  autoApproval?: string
  idleExit?: number
}

/**
 * The entry's schema. Everything a launch supplies (`config:` in
 * `cordis.patch.yml`, including its `!!js` expressions) stays ordinary,
 * non-live configuration; the TUI's own settings are the live fields, which is
 * what makes them visible to, and writable through, the 0.1.7 settings service.
 */
export const Config: z<ConfigFields> = z.object({
  sessionId: z.string(),
  showReasoning: z.boolean(),
  maxToolOutputLines: z.number(),
  color: z.boolean(),
  welcome: z.string(),
  resume: z.boolean(),
  resumePicker: z.boolean(),
  provider: z.string(),
  model: z.string(),
  paintIntervalMs: z.number(),
  language: liveField(z.string()),
  skipUpdate: liveField(z.string()),
  view: liveField(z.string()),
  disconnect: liveField(z.string()),
  autoApproval: liveField(z.string()),
  idleExit: liveField(z.number()),
})

/**
 * Mount the SSH TUI. The `main` agent is created here after the loader
 * settles, reading the saved default provider/model from
 * `agent-default-model` (the same settings memory the official Models page
 * uses). Launch flags still win when supplied.
 */
export function apply(ctx: Context, config: Config): void {
  const hostProcess = isTuiHostProcess()
  if (!hostProcess && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('dsh-ssh-tui: both stdin and stdout must be TTYs; use a terminal/SSH session')
  }
  const subagentSelection = createSubagentSelection(ctx)
  installRouteMemory(ctx)
  installUiLocale(ctx)
  ctx.effect(() => {
    let disposed = false
    let handle: AgentHandle | undefined
    let controller: TuiController | undefined
    let sessionLockPathHeld: string | undefined
    let sessionLockInfoHeld: SessionLockInfo | undefined
    let hostOrphaned = false

    const dropSessionLock = async (): Promise<void> => {
      const path = sessionLockPathHeld
      sessionLockPathHeld = undefined
      sessionLockInfoHeld = undefined
      if (path !== undefined) await releaseSessionLock(path)
    }

    const takeSessionLock = async (sessionId: string): Promise<void> => {
      if (sessionLockDisabled()) return
      const { path, info } = await acquireSessionLock(sessionId, {
        tty: process.env.SSH_TTY ?? process.env.TTY,
        state: 'attached',
        agentStatus: 'idle',
        disconnectPolicy: 'pause',
      })
      sessionLockPathHeld = path
      sessionLockInfoHeld = info
    }

    const patchLock = async (patch: Partial<SessionLockInfo>): Promise<void> => {
      const path = sessionLockPathHeld
      const current = sessionLockInfoHeld
      if (path === undefined || current === undefined) return
      const next = { ...current, ...patch }
      sessionLockInfoHeld = next
      try {
        await writeSessionLock(path, next)
      } catch {
        // lock file is best-effort while detached
      }
    }

    let inputCapture: { stop(): string } | undefined
    const exitLauncher = createLauncherExit({
      appExit: () => ctx.get('appExit'),
    })
    const attacher = createAttacher({
      relay: (sock, seed, announce) => runDisplayRelay(sock, {
        ...(seed === '' ? {} : { seed }),
        // Line mode has no status line to erase, and the erase sequence is the
        // one piece of cursor control the launcher still emitted.
        ...(announce && !lineModeEnabled() ? { announce: true } : {}),
      }),
      quiet: () => { quietTerminalInput() },
      beginCapture: () => { inputCapture = captureTerminalInput() },
      endCapture: () => {
        const capture = inputCapture
        inputCapture = undefined
        return capture?.stop() ?? ''
      },
      inspectLiveHost: async (sessionId) => {
        if (sessionLockDisabled()) return undefined
        const live = await inspectLiveHost(sessionId)
        if (live === undefined) return undefined
        return { kind: live.kind, sock: live.sock, pid: live.lock.pid }
      },
      spawnHost: sessionId => spawnDetachedHost(sessionId),
      waitForDisplaySock: async spawned => {
        await waitForDisplaySock(spawned.sock, HOST_START_TIMEOUT_MS, spawned.pid, spawned.errFile, spawned.exitWatch)
      },
      report: message => { process.stderr.write(`${message}\n`) },
      exit: exitLauncher,
      messages: {
        connecting: sessionId => t('attach.connecting', { session: sessionId }),
        recovering: sessionId => t('attach.recovering', { session: sessionId }),
        replaced: sessionId => t('attach.replaced', { session: sessionId }),
        flapping: sessionId => t('attach.flapping', { session: sessionId }),
        zombie: (sessionId, pid) => t('attach.zombie', { session: sessionId, pid }),
      },
      debug: process.env.DSH_TUI_DEBUG === '1',
    })
    const attachExisting = attacher.attachExisting
    const spawnHostAndRelay = attacher.attachOrSpawn

    // An explicit in-process change (/setup or /model) wins over launch-time
    // CLI overrides for every session created or resumed later in this process.
    let liveSelection: ModelSelection | undefined

    /** Build the goodbye hint for the session that actually runs. */
    const goodbyeFor = (sessionId: string): string => {
      const existing = ctx.get('tuiGoodbyeMessage') as string | undefined
      const marker = '--resume='
      const markerIndex = existing?.lastIndexOf(marker) ?? -1
      if (existing !== undefined && markerIndex !== -1) {
        const tail = existing.slice(markerIndex + marker.length)
        if (tail !== '' && !/\s/u.test(tail)) {
          return `${existing.slice(0, markerIndex + marker.length)}${sessionId}`
        }
      }
      return `To resume this session: dsh --profile tui --resume=${sessionId}`
    }

    const start = async (sessionId: SessionId, resume: boolean): Promise<void> => {
      if (!hostProcess) {
        writeBootSplash(resume ? t('boot.resume') : t('boot.host'), config.color !== false)
        await spawnHostAndRelay(String(sessionId))
        return
      }
      writeBootSplash(resume ? t('boot.resume') : t('boot.starting'), config.color !== false)
      await ctx.get('loader')?.await()
      if (disposed) return
      const agents = ctx.get('agents')
      if (agents === undefined) throw new Error('dsh-ssh-tui: agents service is unavailable')
      const defaultModel = ctx.get('agentDefaultModel')
      const serviceSaved = defaultModel?.currentSelection()
      // The settings document / on-disk file is the authoritative source for a
      // default that must survive a restart. The agentDefaultModel service
      // (or a duplicate settings instance) can report a stale in-memory
      // selection, so prefer the file when it carries a user section.
      // `settingsDocument` reads the user layer on both lines: 0.1.7 removed
      // the service's `document` property, and the descriptor's `user` layer is
      // the same view.
      const doc = settingsDocument(ctx)
      const docSection = doc?.['agent-default-model']
      const fileSection = readAgentDefaultFromFile()
      const authoritative = (fileSection ?? docSection) as
        | { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
        | undefined
      const savedSelection: ModelSelection | undefined =
        authoritative !== undefined
          && typeof authoritative.provider === 'string'
          && typeof authoritative.model === 'string'
          ? {
              provider: authoritative.provider,
              model: authoritative.model,
              ...(typeof authoritative.reasoningEffort === 'string'
                ? { reasoningEffort: ReasoningEffortId(authoritative.reasoningEffort) }
                : {}),
            }
          : serviceSaved
      const hasUserDefaultSection = fileSection !== undefined || docSection !== undefined
      const rememberedFallback = !hasUserDefaultSection
        ? latestRememberedRoute(parseRouteMemory(doc?.['ssh-tui-routes']))
        : undefined

      // Which providers this install can still route to. Permissive on purpose:
      // see `providerIsRoutable` — wrongly keeping a record costs the error the
      // harness already reports, wrongly dropping one loses the session's route.
      const listedProviders = (ctx.get('llm')?.listProviders() ?? []).map(entry => entry.id)
      const piAiSection = readSettingsSection(ctx, settingsNamespace('llm-pi-ai')) as { providers?: unknown } | null | undefined
      const configuredProviders = piAiSection?.providers !== null && typeof piAiSection?.providers === 'object'
        ? Object.keys(piAiSection.providers as Record<string, unknown>)
        : []
      const routable = (id: string): boolean =>
        providerIsRoutable({ provider: id, listed: listedProviders, configured: configuredProviders })

      // A resumed session carries its own route: the supplier it was actually
      // spending on, and the subagent route it was running its children on. A
      // new session has no record, and another session's record is never used.
      // A supplier that has since been removed takes its record with it, and the
      // launch falls back to the app-level defaults.
      // A route restored for an earlier session in this process must not leak
      // into this one; only a readable section may replace it.
      releaseSessionSubagentSelection(
        subagentSelection,
        readSettingsSection(ctx, SUBAGENT_SETTINGS_NAMESPACE),
      )
      const sessionPlan = await restoreSessionRoute({
        sessionId: String(sessionId),
        resume,
        subagentSelection,
        routable,
      })
      const sessionRoute = sessionPlan.route
      const launchNotices: { kind: 'system' | 'error'; text: string }[] = []

      // An explicit in-process change (/setup or /model) wins over launch-time
      // CLI overrides for every session created or resumed later in this process.
      const launch = resolveLaunchRoute({
        ...(liveSelection === undefined ? {} : { live: liveSelection }),
        cli: {
          ...(config.provider === undefined ? {} : { provider: config.provider }),
          ...(config.model === undefined ? {} : { model: config.model }),
        },
        ...(sessionRoute === undefined ? {} : { session: sessionRoute }),
        ...(savedSelection === undefined ? {} : { saved: savedSelection }),
        ...(rememberedFallback === undefined ? {} : { remembered: rememberedFallback }),
      })
      const provider = launch.provider
      const model = launch.model
      // Say what the record was worth before anything else can fail: which
      // supplier it fell back from, and — when not even the fallback can be
      // routed to — what is available, so the fix is one command away.
      if (sessionPlan.droppedProvider !== undefined) {
        launchNotices.push({
          kind: 'system',
          text: t('session.routeProviderGone', {
            provider: sessionPlan.droppedProvider,
            route: `${provider}/${model}`,
          }),
        })
      }
      if (sessionPlan.droppedSubagentProvider !== undefined) {
        launchNotices.push({
          kind: 'system',
          text: t('session.subagentProviderGone', { provider: sessionPlan.droppedSubagentProvider }),
        })
      }
      if (!routable(provider)) {
        const available = [...new Set([...BUILTIN_ROUTABLE_PROVIDERS, ...listedProviders, ...configuredProviders])]
        launchNotices.push({
          kind: 'error',
          text: t('session.routeNoneRoutable', {
            provider,
            available: available.join(' · ') || t('session.routeNoProviders'),
          }),
        })
      }
      let reasoningEffort = launch.reasoningEffort === undefined
        ? undefined
        : ReasoningEffortId(launch.reasoningEffort)
      // OpenCode / third-party (llm-pi-ai) routes carry no adapter-level
      // reasoning default, so default a supported effort ourselves when none is
      // selected. Without it the model streams thinking as plain text and the
      // foldable `思考中` block never has data to render.
      if (reasoningEffort === undefined && provider !== 'deepseek-official') {
        const llm = ctx.get('llm')
        if (llm !== undefined) {
          reasoningEffort = await defaultReasoningEffort(llm, provider, model)
        }
      }

      const effectiveSelection: ModelSelection = {
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      }
      // The per-session record: this conversation's supplier and its subagent
      // route. Written when a route settles, and once below so a conversation is
      // recorded from its first turn; a resume that changed nothing rewrites
      // nothing. Best-effort — a missing file only costs the next resume its
      // memory of the route.
      let notedRoute = sessionRoute
      const noteRoute = (route: Omit<SessionRoute, 'updatedAt'>): void => {
        if (sameSessionRoute(notedRoute, route)) return
        notedRoute = { ...route, updatedAt: Date.now() }
        void saveSessionRoute(String(sessionId), route).catch(() => {})
      }
      const selectionRef: ModelSelectionRef = {
        current: effectiveSelection,
        assembled: undefined,
      }
      const agentPresets = ctx.get('agentPresets')
      const agentOptions = {
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      }
      const setup = async (agentCtx: Context): Promise<void> => {
        installModelSelection(agentCtx, selectionRef)
        await agentPresets?.mount(agentCtx)
      }
      await takeSessionLock(String(sessionId))
      let resumeCwdNotice: string | undefined
      try {
        // The frontend always spawns the Host with `--resume=<id>` — including
        // for a brand-new session id it just generated. A missing session must
        // therefore fall back to create (both supported host lines throw
        // `session … not found` instead of creating).
        const missingSession = (error: unknown): boolean => {
          const chain: unknown[] = [error]
          let current = error
          while (current instanceof Error && current.cause !== undefined) {
            current = current.cause
            chain.push(current)
          }
          return chain.some(item => item instanceof Error && /not found/u.test(item.message))
        }
        if (resume) {
          try {
            handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
          } catch (error: unknown) {
            if (!missingSession(error)) throw error
            handle = await agents.create({ sessionId, meta: { cwd: process.cwd() }, agentOptions, setup })
          }
        } else {
          handle = await agents.create({ sessionId, meta: { cwd: process.cwd() }, agentOptions, setup })
        }
        if (resume) {
          const entered = enterSessionCwd(handle.agent.session.header?.cwd)
          resumeCwdNotice = entered.error !== undefined
            ? entered.error
            : entered.changed
              ? t('cwd.entered', { cwd: entered.cwd })
              : undefined
        }
      } catch (error: unknown) {
        await dropSessionLock()
        throw error
      }
      if (disposed) {
        await handle.dispose()
        await dropSessionLock()
        return
      }
      const presetId = agentPresets?.composedPreset(handle.agent.ctx) ?? agentPresets?.defaultId
      // A profile that composes no roster names no preset, and the TUI's own
      // default is the standard composition either way; label it in the active
      // language instead of leaking the raw id.
      let presetName = presetId === undefined ? undefined : presetLabel(presetId)
      let presetTrust: string | undefined
      if (presetId !== undefined) {
        try {
          const preset = await agentPresets?.resolve(presetId)
          presetTrust = preset?.trust
          presetName = presetLabel(presetId, preset?.name, presetTrust)
        } catch {
          // Fall back to the id's own label.
        }
      }
      // Record the route this conversation starts on, before the first turn can
      // spend on it: a resumed session that has no record yet (an older session,
      // or a first run) is remembered from here on.
      const initialRoute = sessionRouteInput({
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort: String(reasoningEffort) }),
        subagent: subagentSelection.current,
      })
      if (initialRoute !== undefined) noteRoute(initialRoute)
      controller = mountTui(ctx, {
        ...config,
        headlessDisplay: true,
        sessionId: String(sessionId),
        resume,
        ...(resumeCwdNotice === undefined ? {} : { cwdNotice: resumeCwdNotice }),
        ...(sessionRoute === undefined ? {} : { restoredRoute: sessionRoute }),
        ...(launchNotices.length === 0 ? {} : { launchNotices }),
        provider,
        model,
        selectionRef,
        subagentSelection,
        presetId,
        presetName,
        presetTrust,
        goodbye: goodbyeFor(String(sessionId)),
        // The record of which supplier this conversation ran on lives in
        // `$DSH_HOME`, written here rather than in the TUI: the launcher is the
        // only place that knows the session is real.
        onRouteSettled: (settled) => { noteRoute(settled) },
        onSelectionChanged: (next) => {
          liveSelection = next
        },
        onHangup: async () => {
          // Only reached when hangup keeps the Host (busy at drop). Idle hangup
          // exits through dispose + appExit and must drop the lock.
          hostOrphaned = true
          const policy = controller?.disconnectPolicy() ?? 'pause'
          await patchLock({
            state: handle?.agent.status === 'running' ? 'running-detached' : 'paused',
            agentStatus: handle?.agent.status === 'running' ? 'running' : 'idle',
            tty: undefined,
            disconnectPolicy: policy,
          })
        },
        onReattach: async () => {
          hostOrphaned = false
          await patchLock({
            state: 'attached',
            tty: process.env.SSH_TTY ?? process.env.TTY,
            agentStatus: handle?.agent.status === 'running' ? 'running' : 'idle',
          })
        },
      })
    }

    const pickerAbort = new AbortController()
    let bootingSessionId = config.sessionId
    const boot = async (): Promise<void> => {
      if (config.resumePicker === true) {
        const picked = await showSessionPicker(ctx, config.color !== false, pickerAbort.signal)
        if (disposed) return
        if (picked === null) {
          // Esc from the picker: drain the cursor reply the launcher's probe
          // may still be owed (or the shell echoes `^[[17;1R` over the prompt),
          // then leave through the same hand-back-and-exit path `/exit` uses.
          // `quietTerminalInput` leaves raw mode on, so the restore inside is
          // what actually gives the user their shell back.
          quietTerminalInput()
          exitLauncher(0)
          return
        }
        if (picked.kind === 'attach') {
          bootingSessionId = picked.id
          await attachExisting(picked.id, picked.sock)
          return
        }
        if (picked.kind === 'resume') {
          bootingSessionId = picked.id
          await start(SessionId(picked.id), true)
        } else {
          // Reuse the startup-minted session identity so the goodbye hint and
          // the launcher-configured `main` identity all describe the session
          // that actually runs.
          const sessionId = config.sessionId === ''
            ? `main-session-${randomUUID()}`
            : config.sessionId
          bootingSessionId = sessionId
          await start(SessionId(sessionId), false)
        }
        return
      }
      await start(SessionId(config.sessionId), config.resume === true)
    }

    void boot().catch((error: unknown) => {
      const detail = error instanceof Error && error.name === 'SessionLockHeldError'
        ? error.message
        : errorChain(error)
      process.stderr.write(`dsh-ssh-tui: session "${bootingSessionId}" failed to start:\n${detail}\n`)
      const hint = copyTrapHint(detail)
      if (hint !== undefined) process.stderr.write(`${hint}\n`)
      exitLauncher(1)
    })

    return async (): Promise<void> => {
      if (hostOrphaned) {
        // Busy SSH drop: keep agent + display socket. Launcher fiber dispose
        // must not release the lock or cancel the leftover Host. Idle hangup
        // never sets this flag, so the lock is released below.
        return
      }
      disposed = true
      pickerAbort.abort()
      await controller?.dispose()
      await handle?.dispose()
      await dropSessionLock()
    }
  }, 'ssh-tui')
}
