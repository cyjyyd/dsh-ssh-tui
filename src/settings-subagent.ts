/**
 * Loader row that carries the subagent model selection as a settings form.
 *
 * On the 0.1.5 line `subagent-model.ts` registers this namespace itself through
 * `installSettingsSection`; from 0.1.7 a settings form is projected out of a
 * loader entry's own `Config` schema, so the same schema is mounted as a row.
 * The row id (`ssh-tui-subagent`, see `cordis.patch.yml`) is the namespace
 * every read and write goes through, and the id the host's legacy
 * `settings.yaml` import lands on, so an existing `/submodel` pin survives.
 */
import type { Context } from '@deepseek-ai/cordis'
import { SUBAGENT_SETTINGS_SCHEMA } from './subagent-model.js'

export const name = 'ssh-tui-settings-subagent'

/** The subagent selection, as the 0.1.7 settings service wants to see it. */
export const Config = SUBAGENT_SETTINGS_SCHEMA

/** Nothing to mount: the TUI owns every read and write of this section. */
export function apply(_ctx: Context): void {
  // The row exists for its schema; `/submodel` and the request waterfall read
  // and write it through `subagent-model.ts`.
}
