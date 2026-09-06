/**
 * Web-aligned provider presets, read from the host's own pi-ai catalog.
 *
 * The web Models settings page offers every provider the installed pi-ai
 * catalog ships (`llm.listConfigurableProviders()` on 0.1.2+), with endpoint
 * and model defaults served by that catalog when a profile omits them. The
 * TUI reads the same catalog so /setup can offer the same list without a
 * hand-pinned table that would drift between dsh releases.
 *
 * The read runs in a short-lived child process: importing pi-ai inside the
 * live dsh process can hang on the host's module loader hooks, while a bare
 * `node` child resolves it instantly. Best-effort by design — pi-ai sits at
 * different locations per install layout, and every failure simply hides the
 * catalog option and leaves the pinned templates.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface CatalogPreset {
  id: string
  name: string
  baseUrl: string
  modelIds: string[]
}

/** Filter presets by a case-insensitive substring match on id or name. */
export function filterCatalogPresets(presets: readonly CatalogPreset[], query: string): CatalogPreset[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...presets]
  return presets.filter(preset =>
    preset.id.toLowerCase().includes(needle) || preset.name.toLowerCase().includes(needle))
}

const CHILD_SCRIPT = `
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const anchors = JSON.parse(process.env.DSH_CATALOG_ANCHORS ?? '[]')
const pkgCandidates = []
for (const anchor of anchors) {
  if (!anchor) continue
  let current = anchor.startsWith('file:') ? pathToFileURL(anchor).pathname : anchor
  for (let depth = 0; depth < 10; depth += 1) {
    pkgCandidates.push(join(current, 'node_modules', '@earendil-works', 'pi-ai', 'package.json'))
    pkgCandidates.push(join(current, 'packages', 'llm', 'llm-pi-ai', 'node_modules', '@earendil-works', 'pi-ai', 'package.json'))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}
for (const pkgPath of pkgCandidates) {
  if (!existsSync(pkgPath)) continue
  try {
    const allJs = join(dirname(pkgPath), 'dist', 'providers', 'all.js')
    if (!existsSync(allJs)) continue
    const catalog = await import(pathToFileURL(allJs).href)
    const providers = catalog.builtinProviders?.()
    if (!Array.isArray(providers) || providers.length === 0) continue
    const presets = []
    for (const provider of providers) {
      let modelIds = []
      try {
        modelIds = (provider.getModels?.() ?? []).map(m => m.id).filter(id => typeof id === 'string' && id !== '')
      } catch { modelIds = [] }
      presets.push({
        id: provider.id,
        name: typeof provider.name === 'string' && provider.name !== '' ? provider.name : provider.id,
        baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : '',
        modelIds,
      })
    }
    if (presets.length > 0) {
      process.stdout.write(JSON.stringify(presets))
      process.exit(0)
    }
  } catch { /* next candidate */ }
}
process.exit(1)
`

/**
 * Read the catalog. Anchors are module paths that plausibly sit inside the dsh
 * install: the running CLI entry (`process.argv[1]`) and the plugin's module
 * base. Returns undefined when no reachable install ships a usable catalog or
 * the child does not answer within 10 seconds.
 */
export function readProviderCatalog(anchors: Array<string | undefined>): Promise<CatalogPreset[] | undefined> {
  return new Promise(resolve => {
    try {
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', CHILD_SCRIPT],
        {
          stdio: ['ignore', 'pipe', 'ignore'],
          env: {
            ...process.env,
            DSH_CATALOG_ANCHORS: JSON.stringify(anchors.filter((a): a is string => a !== undefined && a !== '')),
          },
        },
      )
      let stdout = ''
      let settled = false
      const finish = (result: CatalogPreset[] | undefined): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.kill()
        resolve(result)
      }
      const timer = setTimeout(() => finish(undefined), 10_000)
      child.stdout?.on('data', chunk => {
        stdout += String(chunk)
      })
      child.on('exit', code => {
        if (settled) return
        clearTimeout(timer)
        settled = true
        if (code !== 0 || stdout.trim() === '') {
          resolve(undefined)
          return
        }
        try {
          const parsed = JSON.parse(stdout) as CatalogPreset[]
          resolve(parsed.length > 0 ? parsed : undefined)
        } catch {
          resolve(undefined)
        }
      })
      child.on('error', error => {
        clearTimeout(timer)
        settled = true
        resolve(undefined)
      })
    } catch {
      resolve(undefined)
    }
  })
}

let catalogCache: Promise<CatalogPreset[] | undefined> | undefined

/**
 * Read the catalog once per process and memoize the result: the child needs a
 * moment to load pi-ai, so callers warm it at startup and reuse the settled
 * value.
 */
export function loadProviderCatalog(anchors: Array<string | undefined>): Promise<CatalogPreset[] | undefined> {
  catalogCache ??= readProviderCatalog(anchors)
  return catalogCache
}
