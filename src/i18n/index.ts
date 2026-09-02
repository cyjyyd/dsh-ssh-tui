/**
 * Runtime UI locale for the SSH TUI.
 *
 * Order: `DSH_TUI_LANG` → settings `ssh-tui.language` (`/language`) →
 * `LC_ALL` / `LC_MESSAGES` / `LANG`. Unrecognized and C/POSIX stay Chinese:
 * jump-host SSH is the default audience, and CI often runs with `LANG=C`.
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { en } from './en.js'
import { zh } from './zh.js'

export type Locale = 'zh' | 'en'

export type MessageVars = Record<string, string | number>

const TABLES: Record<Locale, Record<string, string>> = { zh, en }

export const UI_LOCALE_NAMESPACE = settingsNamespace('ssh-tui')

export const UI_LOCALE_SCHEMA = z.object({
  language: z.string(),
})

let current: Locale = resolveLocale()

export function localeFromTag(tag: string): Locale | undefined {
  const raw = tag.trim().toLowerCase()
  if (raw === '') return undefined
  if (raw === 'chinese' || raw === '中文') return 'zh'
  if (raw === 'english') return 'en'
  const primary = raw.replace(/_/gu, '-').split(/[-.]/u)[0] ?? ''
  if (primary === 'c' || primary === 'posix') return undefined
  if (primary === 'en') return 'en'
  if (primary === 'zh') return 'zh'
  return undefined
}

/** Pick zh/en from env, optionally after a saved settings value. */
export function resolveLocale(
  env: NodeJS.ProcessEnv = process.env,
  saved?: string,
): Locale {
  const override = localeFromTag(env.DSH_TUI_LANG ?? '')
  if (override !== undefined) return override
  const fromSaved = localeFromTag(saved ?? '')
  if (fromSaved !== undefined) return fromSaved
  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const) {
    const fromEnv = localeFromTag(env[key] ?? '')
    if (fromEnv !== undefined) return fromEnv
  }
  return 'zh'
}

export function getLocale(): Locale {
  return current
}

export function setLocale(locale: Locale): void {
  current = locale
}

export function t(key: string, vars?: MessageVars, fallback?: string): string {
  const template = TABLES[current][key] ?? TABLES.zh[key]
  if (template === undefined) return fallback ?? key
  if (vars === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) => {
    const value = vars[name]
    return value === undefined ? whole : String(value)
  })
}

export function refreshLocale(env: NodeJS.ProcessEnv = process.env, saved?: string): Locale {
  current = resolveLocale(env, saved)
  return current
}

export function applySavedLocale(raw: unknown): Locale {
  const saved = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    && typeof (raw as { language?: unknown }).language === 'string'
    ? (raw as { language: string }).language
    : undefined
  return refreshLocale(process.env, saved)
}

/** Register `$DSH_HOME/settings.yaml` `ssh-tui.language` and apply it now. */
export function installUiLocale(ctx: Context): void {
  let source = (): { language?: string } => ({})
  installSettingsSection(ctx, UI_LOCALE_NAMESPACE, UI_LOCALE_SCHEMA, {}, {
    setSource: (currentSource) => {
      source = () => currentSource() as { language?: string }
    },
    onChange: () => {
      applySavedLocale(source())
    },
  })
  applySavedLocale(source())
}

export function localeDisplayName(locale: Locale): string {
  return locale === 'en' ? t('lang.en') : t('lang.zh')
}
