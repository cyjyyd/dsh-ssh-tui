/**
 * Loader row that carries the `/model` route memory as a settings form.
 *
 * On the 0.1.5 line `route-memory.ts` registers this namespace itself through
 * `installSettingsSection`; from 0.1.7 a settings form is projected out of a
 * loader entry's own `Config` schema, so the same schema is mounted as a row.
 * The row id (`ssh-tui-routes`, see `cordis.patch.yml`) is the namespace every
 * read goes through, and it is also the id the host's legacy `settings.yaml`
 * import lands on, so an existing `ssh-tui-routes` section keeps its routes.
 */
import type { Context } from '@deepseek-ai/cordis'
import { ROUTE_MEMORY_SCHEMA } from './route-memory.js'

export const name = 'ssh-tui-settings-routes'

/** The route-memory section, as the 0.1.7 settings service wants to see it. */
export const Config = ROUTE_MEMORY_SCHEMA

/** Nothing to mount: the TUI owns every read and write of this section. */
export function apply(_ctx: Context): void {
  // The row exists for its schema; the runtime in `route-memory.ts` is the
  // only consumer, and it is mounted by the plugin's own row.
}
