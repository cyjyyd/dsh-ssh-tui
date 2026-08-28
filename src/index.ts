/**
 * dsh-ssh-tui — an SSH-friendly interactive terminal front door for DeepSeek
 * Harness. The bundle rides over @deepseek-ai/dsh-base and drives one
 * configured agent, so the whole plugin ecosystem (shell, filesystem, skills,
 * subagents, sandbox approvals) is the same one the web surface uses.
 */

import { installModelSelection, type AgentHandle, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { showSessionPicker } from './picker.js'
import { mountTui, type TuiController } from './tui.js'
import { defaultReasoningEffort } from './reasoning.js'
import { createSubagentSelection } from './subagent-model.js'
import { acquireSessionLock, releaseSessionLock, sessionLockDisabled } from './session-lock.js'
import { installRouteMemory } from './route-memory.js'

export const name = 'ssh-tui'

/** Core services required before the terminal channel can drive an agent. */
export const inject = ['agents', 'agentDefaultModel']

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
}

/**
 * Mount the SSH TUI. The `main` agent is created here after the loader
 * settles, reading the saved default provider/model from
 * `agent-default-model` (the same settings memory the official Models page
 * uses). Launch flags still win when supplied.
 */
export function apply(ctx: Context, config: Config): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('dsh-ssh-tui: both stdin and stdout must be TTYs; use a terminal/SSH session')
  }
  const subagentSelection = createSubagentSelection(ctx)
  installRouteMemory(ctx)
  ctx.effect(() => {
    let disposed = false
    let switching = false
    let handle: AgentHandle | undefined
    let controller: TuiController | undefined
    let sessionLockPathHeld: string | undefined

    const dropSessionLock = async (): Promise<void> => {
      const path = sessionLockPathHeld
      sessionLockPathHeld = undefined
      if (path !== undefined) await releaseSessionLock(path)
    }

    const takeSessionLock = async (sessionId: string): Promise<void> => {
      if (sessionLockDisabled()) return
      const { path } = await acquireSessionLock(sessionId, {
        tty: process.env.SSH_TTY ?? process.env.TTY,
      })
      sessionLockPathHeld = path
    }
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
      await ctx.get('loader')?.await()
      if (disposed) return
      const agents = ctx.get('agents')
      if (agents === undefined) throw new Error('dsh-ssh-tui: agents service is unavailable')
      const defaultModel = ctx.get('agentDefaultModel')
      const savedSelection = defaultModel?.currentSelection()

      // An explicit in-process change (/setup or /model) wins over launch-time
      // CLI overrides for every session created or resumed later in this process.
      const provider = liveSelection?.provider
        ?? config.provider
        ?? savedSelection?.provider
        ?? 'deepseek-official'
      const model = liveSelection?.model
        ?? config.model
        ?? savedSelection?.model
        ?? 'deepseek-v4-flash'

      // Reasoning effort is only meaningful for the exact provider/model it
      // belongs to. CLI overrides that change either route must not inherit the
      // saved effort of a different model.
      let reasoningEffort = liveSelection?.reasoningEffort
      if (reasoningEffort === undefined && liveSelection === undefined) {
        const sameSavedRoute = savedSelection !== undefined
          && (config.provider === undefined || config.provider === savedSelection.provider)
          && (config.model === undefined || config.model === savedSelection.model)
        if (sameSavedRoute) reasoningEffort = savedSelection.reasoningEffort
      }
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
      try {
        handle = resume
          ? await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
          : await agents.create({ sessionId, meta: { cwd: process.cwd() }, agentOptions, setup })
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
      let presetName = presetId
      if (presetId !== undefined) {
        try {
          const preset = await agentPresets?.resolve(presetId)
          if (preset?.name !== undefined) presetName = preset.name
        } catch {
          // Fall back to the id.
        }
      }
      controller = mountTui(ctx, {
        ...config,
        resumePicker: false,
        sessionId: String(sessionId),
        resume,
        provider,
        model,
        selectionRef,
        subagentSelection,
        presetId,
        presetName,
        goodbye: goodbyeFor(String(sessionId)),
        onSwitchSession: switchTo,
        onSelectionChanged: (next) => {
          liveSelection = next
        },
      })
    }

    /** Tear down the current channel and resume another session in its place. */
    const switchTo = async (target: string): Promise<void> => {
      if (switching || disposed) return
      switching = true
      try {
        if (controller !== undefined) {
          await controller.dispose()
          controller = undefined
        }
        if (handle !== undefined) {
          await handle.dispose()
          handle = undefined
        }
        await dropSessionLock()
        await start(SessionId(target), true)
      } catch (error: unknown) {
        process.stderr.write(`dsh-ssh-tui: failed to switch to session "${target}": ${errorChain(error)}\n`)
        const exit = ctx.get('appExit')
        if (exit !== undefined) exit(1)
        else process.exit(1)
      } finally {
        switching = false
      }
    }

    const pickerAbort = new AbortController()
    let bootingSessionId = config.sessionId
    const boot = async (): Promise<void> => {
      if (config.resumePicker === true) {
        await ctx.get('loader')?.await()
        const picked = await showSessionPicker(ctx, config.color !== false, pickerAbort.signal)
        if (disposed) return
        if (picked === null) {
          const exit = ctx.get('appExit')
          if (exit !== undefined) exit(0)
          else process.exit(0)
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
      const exit = ctx.get('appExit')
      if (exit !== undefined) exit(1)
      else process.exit(1)
    })

    return async (): Promise<void> => {
      disposed = true
      pickerAbort.abort()
      await controller?.dispose()
      await handle?.dispose()
      await dropSessionLock()
    }
  }, 'ssh-tui')
}
