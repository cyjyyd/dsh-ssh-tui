import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * rc.4 → rc.5 differential for the only runtime change this U1 characterises:
 * the base composition no longer pins `web.searchProvider`, so rc.5 selects
 * the search provider from the model route instead of always using the Search
 * API. Running the same probe against both installed families is the RED→GREEN
 * evidence; neither version is treated as a supported Host by this test.
 *
 * Both artifacts are optional. Point `DSH_RC4_ROOT` / `DSH_RC5_ROOT` at strict
 * single-family install trees; the suite skips without them.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const RC4_ROOT = process.env.DSH_RC4_ROOT ? resolve(process.env.DSH_RC4_ROOT) : join(REPO, '.probe-tree', 'rc4-install')
const RC5_ROOT = process.env.DSH_RC5_ROOT ? resolve(process.env.DSH_RC5_ROOT) : join(REPO, '.probe-tree', 'rc5-install')
const VERSIONS = {
  '0.2.2-rc.4': RC4_ROOT,
  '0.2.2-rc.5': RC5_ROOT,
}
const AVAILABLE = Object.fromEntries(Object.entries(VERSIONS).map(([version, root]) => [
  version,
  existsSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')),
]))
const SKIP = Object.values(AVAILABLE).every(Boolean)
  ? false
  : `strict rc.4/rc.5 artifacts are required (${Object.entries(AVAILABLE).filter(([, ok]) => !ok).map(([v]) => v).join(', ')} missing)`

const loaded = {}

before(async () => {
  if (SKIP !== false) return
  for (const [version, root] of Object.entries(VERSIONS)) {
    const require = createRequire(join(root, 'package.json'))
    const load = name => import(pathToFileURL(require.resolve(name)).href)
    const [cordis, web, base] = await Promise.all([
      load('@deepseek-ai/cordis'),
      load('@deepseek-ai/dsh-web'),
      Promise.resolve(require('yaml')),
    ])
    const patch = readFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml'), 'utf8')
    const document = base.parse(patch, { logLevel: 'error' })
    const webRow = findWebRow(document)
    assert.ok(webRow, `${version} declares its web row`)
    loaded[version] = {
      Context: cordis.Context,
      WebRuntime: web.default,
      config: webRow.config ?? {},
    }
  }
})

/** Find the base composition's `@deepseek-ai/dsh-web` row anywhere in the patch tree. */
function findWebRow(node, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) findWebRow(item, found)
  } else if (node !== null && typeof node === 'object') {
    if (node.id === 'web' && node.name === '@deepseek-ai/dsh-web') found.push(node)
    for (const value of Object.values(node)) findWebRow(value, found)
  }
  return found[0]
}

/**
 * Build the version's real WebRuntime with the base composition's
 * `searchProvider` value and two recording providers, then run one official
 * route search. This is the composition default, not a hand-written config.
 */
async function selectFromBase(version, route = 'deepseek-official') {
  const entry = loaded[version]
  const previous = process.env.DSH_WEB_SEARCH_PROVIDER
  delete process.env.DSH_WEB_SEARCH_PROVIDER
  try {
    const web = new entry.WebRuntime(new entry.Context(), {
      searchProvider: { get: () => entry.config.searchProvider },
      fetchProvider: { get: () => undefined },
    })
    const selected = []
    const provider = id => ({
      id,
      available: () => true,
      search: async () => { selected.push(id); return { sources: [] } },
    })
    web.registerSearchProvider(provider('deepseek-official'))
    web.registerSearchProvider(provider('deepseek-search-api'))
    await web.search({ query: 'composition query', llmProvider: route })
    return selected.at(-1)
  } finally {
    if (previous === undefined) delete process.env.DSH_WEB_SEARCH_PROVIDER
    else process.env.DSH_WEB_SEARCH_PROVIDER = previous
  }
}

test('the rc.4 base pins deepseek-search-api and the rc.5 base removes the pin', { skip: SKIP }, () => {
  assert.equal(loaded['0.2.2-rc.4'].config.searchProvider, 'deepseek-search-api')
  assert.equal(loaded['0.2.2-rc.5'].config.searchProvider, undefined)
  assert.equal(loaded['0.2.2-rc.4'].config.fetchProvider, 'http')
  assert.equal(loaded['0.2.2-rc.5'].config.fetchProvider, 'http')
})

test('RED→GREEN: the same official-route search selects Search API on rc.4 and Messages search on rc.5', { skip: SKIP }, async () => {
  assert.equal(await selectFromBase('0.2.2-rc.4'), 'deepseek-search-api', 'rc.4 defaults to the Search API')
  assert.equal(await selectFromBase('0.2.2-rc.5'), 'deepseek-official', 'rc.5 follows the DeepSeek model route')
})

test('RED→GREEN: rc.4 is ambiguous without an explicit provider and rc.5 resolves the route', { skip: SKIP }, async () => {
  async function selectUnconfigured(version) {
    const entry = loaded[version]
    const previous = process.env.DSH_WEB_SEARCH_PROVIDER
    delete process.env.DSH_WEB_SEARCH_PROVIDER
    try {
      const web = new entry.WebRuntime(new entry.Context(), {
        searchProvider: { get: () => undefined },
        fetchProvider: { get: () => undefined },
      })
      const selected = []
      const provider = id => ({
        id,
        available: () => true,
        search: async () => { selected.push(id); return { sources: [] } },
      })
      web.registerSearchProvider(provider('deepseek-official'))
      web.registerSearchProvider(provider('deepseek-search-api'))
      await web.search({ query: 'unconfigured query', llmProvider: 'deepseek-official' })
      return selected.at(-1)
    } finally {
      if (previous === undefined) delete process.env.DSH_WEB_SEARCH_PROVIDER
      else process.env.DSH_WEB_SEARCH_PROVIDER = previous
    }
  }

  await assert.rejects(
    selectUnconfigured('0.2.2-rc.4'),
    error => error.code === 'WEB_PROVIDER_AMBIGUOUS',
    'rc.4 has no route-aware preference',
  )
  assert.equal(await selectUnconfigured('0.2.2-rc.5'), 'deepseek-official')
})
