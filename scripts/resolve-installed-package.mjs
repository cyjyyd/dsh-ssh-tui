/**
 * Resolve an installed package's manifest using Node's search paths from the
 * *depending* package, not the plugin repository's top-level node_modules.
 *
 * Using createRequire(...).resolve.paths() respects nested dependency layouts
 * without importing/evaluating runtime code or depending on package.json being
 * publicly exported by each package's "exports" map.
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function resolveInstalledManifest(dependentManifestPath, packageName) {
  if (typeof packageName !== 'string' || !/^@[^/]+\/[^/]+$/u.test(packageName)) {
    throw new TypeError(`expected a scoped npm package name: ${String(packageName)}`)
  }
  const searchPaths = createRequire(dependentManifestPath).resolve.paths(packageName)
  for (const directory of searchPaths ?? []) {
    const manifest = join(directory, ...packageName.split('/'), 'package.json')
    if (existsSync(manifest)) return manifest
  }
  return undefined
}
