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
  ctx.effect(() => {
    let disposed = false
    let switching = false
    let handle: AgentHandle | undefined
    let controller: TuiController | undefined
    // An explicit in-process change (/setup or /model) wins over launch-time
    // CLI overrides for every session created or resumed later in this process.
    let liveSelection: ModelSelection | undefined

    const start = async (sessionId: SessionId, resume: boolean): Promise<void> => {
      await ctx.get('loader')?.await()
      if (disposed) return
      const agents = ctx.get('agents')
      if (agents === undefined) throw new Error('dsh-ssh-tui: agents service is unavailable')
      const defaultModel = ctx.get('agentDefaultModel')
      const selection = liveSelection ?? defaultModel?.currentSelection()
      const provider = liveSelection !== undefined
        ? liveSelection.provider
        : config.provider ?? selection?.provider ?? 'deepseek-official'
      const model = liveSelection !== undefined
        ? liveSelection.model
        : config.model ?? selection?.model ?? 'deepseek-v4-flash'
      const selectionRef: ModelSelectionRef = {
        current: selection ?? { provider, model },
        assembled: undefined,
      }
      const agentPresets = ctx.get('agentPresets')
      const agentOptions = {
        provider,
        model,
          ...(selection?.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      }
      const setup = async (agentCtx: Context): Promise<void> => {
        installModelSelection(agentCtx, selectionRef)
        await agentPresets?.mount(agentCtx)
      }
      handle = resume
        ? await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
        : await agents.create({ sessionId, meta: { cwd: process.cwd() }, agentOptions, setup })
      if (disposed) {
        await handle.dispose()
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
        presetId,
        presetName,
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

    const boot = async (): Promise<void> => {
      if (config.resumePicker === true) {
        await ctx.get('loader')?.await()
        const picked = await showSessionPicker(ctx, config.color !== false)
        if (disposed) return
        if (picked === null) {
          const exit = ctx.get('appExit')
          if (exit !== undefined) exit(0)
          else process.exit(0)
          return
        }
        if (picked.kind === 'resume') {
          await start(SessionId(picked.id), true)
        } else {
          await start(SessionId(`main-session-${randomUUID()}`), false)
        }
        return
      }
      await start(SessionId(config.sessionId), config.resume === true)
    }

    void boot().catch((error: unknown) => {
      process.stderr.write(`dsh-ssh-tui: session "${config.sessionId}" failed to start: ${errorChain(error)}\n`)
      const exit = ctx.get('appExit')
      if (exit !== undefined) exit(1)
      else process.exit(1)
    })

    return async (): Promise<void> => {
      disposed = true
      await controller?.dispose()
      await handle?.dispose()
    }
  }, 'ssh-tui')
}
