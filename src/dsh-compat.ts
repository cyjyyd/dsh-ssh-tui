/**
 * Dual-stack shims for dsh 0.1.1-rc.2 and 0.1.2-rc.1.
 *
 * 0.1.2 turned the settings free functions into `SettingsProvider` methods,
 * replaced `Session.events` with on-demand readers, and started branding
 * namespaces at the type level only. Every shim here keeps the same runtime
 * value on both hosts and picks the API shape that is actually present.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SettingsNamespace, SettingsSectionHooks } from '@deepseek-ai/dsh-settings'
import * as dshSettings from '@deepseek-ai/dsh-settings'
import type z from '@deepseek-ai/schemastery'

/**
 * 0.1.1-rc.2 wraps namespaces via `settingsNamespace()`; 0.1.2 brands them at
 * the type level and takes the plain string at runtime. A cast covers both.
 */
export function settingsNamespace(value: string): SettingsNamespace {
  return value as SettingsNamespace
}

/**
 * Register a settings section: 0.1.2-rc.1 moved the free function onto the
 * `settings` service as `installSection`, callable only once that service is
 * injected (plugins apply before it, so `ctx.inject` must defer — same
 * pattern the harness's own packages use); 0.1.1-rc.2 keeps the free
 * function, which defers internally and is safe at apply time.
 */
export function installSettingsSection<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  const legacy = (dshSettings as {
    installSettingsSection?: (
      ctx: Context,
      ns: SettingsNamespace,
      schema: z<T>,
      entry: T,
      hooks: SettingsSectionHooks<T>,
    ) => void
  }).installSettingsSection
  if (typeof legacy === 'function') {
    legacy(ctx, ns, schema, entry, hooks)
    return
  }
  const host = ctx as {
    inject?: (services: readonly string[], callback: (injected: unknown) => void) => void
  }
  if (typeof host.inject !== 'function') {
    throw new Error('dsh-settings: no legacy installSettingsSection and ctx.inject is unavailable')
  }
  host.inject(['settings'], (injected) => {
    const holder = injected as { settings?: { installSection?: (...args: unknown[]) => void } }
    const provider = (holder.settings ?? injected) as {
      installSection?: (...args: unknown[]) => void
    }
    if (typeof provider?.installSection !== 'function') {
      throw new Error('dsh-settings: settings service has no installSection')
    }
    provider.installSection(ctx, ns, schema, entry, hooks)
  })
}

/**
 * Read the full durable event log: 0.1.2-rc.1 replaced the `Session.events`
 * property with on-demand readers; 0.1.1-rc.2 still exposes the property.
 */
export function sessionEvents(session: object): readonly SessionEvent[] {
  const host = session as {
    events?: readonly SessionEvent[]
    snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly SessionEvent[]
  }
  if (typeof host.snapshotEvents === 'function') return host.snapshotEvents()
  return host.events ?? []
}
