/**
 * The slash-command catalog the input box suggests: this plugin's own commands
 * plus the host's, merged and ranked the way the suggestion list shows them.
 */
import { t } from './i18n/index.js'

/** This plugin's own commands, in suggestion order. */
export const LOCAL_COMMANDS = [
  { name: 'help', key: 'cmd.help' },
  { name: 'model', key: 'cmd.model' },
  { name: 'effort', key: 'cmd.effort' },
  { name: 'provider', key: 'cmd.provider' },
  { name: 'submodel', key: 'cmd.submodel' },
  { name: 'subeffort', key: 'cmd.subeffort' },
  { name: 'mode', key: 'cmd.mode' },
  { name: 'quit', key: 'cmd.quit' },
  { name: 'exit', key: 'cmd.quit', aliasOf: 'quit' },
  { name: 'clear', key: 'cmd.clear' },
  { name: 'status', key: 'cmd.status' },
  { name: 'diag', key: 'cmd.diag' },
  { name: 'disconnect', key: 'cmd.disconnect' },
  { name: 'approval', key: 'cmd.approval' },
  { name: 'view', key: 'cmd.view' },
  { name: 'usage', key: 'cmd.usage' },
  { name: 'balance', key: 'cmd.usage', aliasOf: 'usage' },
  { name: 'quota', key: 'cmd.usage', aliasOf: 'usage' },
  { name: 'subagents', key: 'cmd.subagents' },
  { name: 'setup', key: 'cmd.setup' },
  { name: 'find', key: 'cmd.find' },
  { name: 'copy', key: 'cmd.copy' },
  { name: 'language', key: 'cmd.language' },
  { name: 'lang', key: 'cmd.language', aliasOf: 'language' },
  { name: 'dialog-test', key: 'cmd.dialog-test' },
] as const

export interface LocalizedCommand {
  name: string
  description: string
  aliasOf?: string
}

export interface CommandSuggestion {
  name: string
  description: string
  local: boolean
}

export function commandDescription(name: string, aliasOf?: string): string {
  if (aliasOf !== undefined) return t('cmd.aliasOf', { name: aliasOf })
  return t(`cmd.${name}`)
}

export function localizedCommands(): LocalizedCommand[] {
  return LOCAL_COMMANDS.map(command => ({
    name: command.name,
    description: commandDescription(command.name, 'aliasOf' in command ? command.aliasOf : undefined),
    ...('aliasOf' in command ? { aliasOf: command.aliasOf } : {}),
  }))
}

/**
 * Suggestions for the current input: only a `/`-prefixed line suggests
 * anything, aliases are held back until a prefix is typed, and the host's
 * commands follow this plugin's (a local name wins the duplicate). A typed
 * prefix ranks names that start with it above names that merely contain it.
 */
export function commandSuggestions(
  input: string,
  foreign: readonly CommandSuggestion[],
): CommandSuggestion[] {
  if (!input.startsWith('/')) return []
  const prefix = input.slice(1).toLowerCase()
  const local = localizedCommands()
    .filter(command => command.name !== 'dialog-test' && (prefix !== '' || command.aliasOf === undefined))
    .map(command => ({ name: command.name, description: command.description, local: true }))
  const seen = new Set(local.map(command => command.name))
  const all = [...local, ...foreign.filter(command => !seen.has(command.name))]
  const filtered = prefix === ''
    ? all
    : all.filter(command => command.name.startsWith(prefix) || command.name.includes(prefix))
  if (prefix === '') return filtered
  return filtered.sort((a, b) => {
    const aStart = a.name.startsWith(prefix) ? 0 : 1
    const bStart = b.name.startsWith(prefix) ? 0 : 1
    return aStart - bStart
  })
}
