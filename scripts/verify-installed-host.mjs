#!/usr/bin/env node
/**
 * REL.085-U1: verify the *installed* host family and root dependency graph.
 *
 * No API/LLM requests, no profile writes. Checks packages by the paths a
 * depending package actually sees (including nested node_modules), not solely
 * by direct manifest pins. It must fail if npm has silently nested the new
 * rc.3 timer/schemastery around outdated root dependencies.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SCHEMA_SPEC, LINES } from './ci-pin-line.mjs'
import { resolveInstalledManifest } from './resolve-installed-package.mjs'

const expected = process.argv[2]
if (typeof expected !== 'string' || !/^\d+\.\d+\.\d+-rc\.\d+$/u.test(expected) || LINES[expected] === undefined) {
  console.error('usage: node scripts/verify-installed-host.mjs <known-0.x.y-rc.z>')
  process.exit(2)
}
const target = LINES[expected]
const checkoutPath = fileURLToPath(new URL('../package.json', import.meta.url))
const failures = []

function parse(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
function fail(reason) {
  failures.push(reason)
  console.error('FAIL: ' + reason)
}
function installedFrom(parentManifest, name) {
  if (parentManifest === undefined) return undefined
  const path = resolveInstalledManifest(parentManifest, name)
  if (path === undefined) return undefined
  const info = parse(path)
  return { path, version: info.version, manifest: info }
}
function verifyVisible(name, wanted, hostPath, requireSingleCopy = false) {
  const root = installedFrom(checkoutPath, name)
  const fromHost = installedFrom(hostPath, name)
  console.log(name + ': root=' + String(root?.version ?? 'MISSING')
    + ' host=' + String(fromHost?.version ?? 'MISSING'))
  if (root?.version !== wanted) fail(name + ' root resolved ' + String(root?.version) + ', expected ' + wanted)
  if (fromHost?.version !== wanted) fail(name + ' host resolved ' + String(fromHost?.version) + ', expected ' + wanted)
  if (requireSingleCopy && root !== undefined && fromHost !== undefined
      && realpathSync(root.path) !== realpathSync(fromHost.path)) {
    fail(name + ' exists as separate root and host-resolved copies: '
      + root.path + ' vs ' + fromHost.path)
  }
}

try {
  const checkout = parse(checkoutPath)
  const direct = checkout.devDependencies ?? {}
  const pinned = direct['@deepseek-ai/dsh']
  const host = installedFrom(checkoutPath, '@deepseek-ai/dsh')
  console.log('requested: ' + expected)
  console.log('manifest devDependency: ' + String(pinned))
  console.log('installed host: ' + String(host?.version ?? 'MISSING'))
  if (pinned !== expected) fail('manifest host pin ' + String(pinned) + ' does not equal ' + expected)
  if (host?.version !== expected) fail('installed host version does not equal ' + expected)

  // Check all direct DSH family packages, not just their package.json strings.
  const family = Object.entries(direct).filter(([name]) =>
    name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  console.log('manifest family pins: ' + family.length)
  for (const [name, declared] of family) {
    const wanted = target.devPins?.[name] ?? expected
    if (declared !== wanted) fail(name + ' manifest pin ' + declared + ', expected ' + wanted)
    const installed = installedFrom(checkoutPath, name)
    if (installed?.version !== wanted) {
      fail(name + ' installed version ' + String(installed?.version) + ', expected ' + wanted)
    }
  }

  // Exact Cordis root pins and the host's effective resolution must agree.
  for (const [name, wanted] of Object.entries(target.roots)) {
    const declared = direct[name]
    if (declared !== wanted) fail(name + ' declared root pin ' + String(declared) + ', expected ' + wanted)
    verifyVisible(name, wanted, host?.path, name === '@deepseek-ai/cordis-plugin-timer')
  }

  // rc.3 has a new Schemastery root. The published rc.2 default range is not
  // rewritten in the repository, only in the temporary rc.3 CI checkout.
  const schemaSpec = target.schemastery ?? DEFAULT_SCHEMA_SPEC
  const declaredSchema = checkout.dependencies?.['@deepseek-ai/schemastery']
  console.log('@deepseek-ai/schemastery declared: ' + String(declaredSchema))
  if (declaredSchema !== schemaSpec) fail('schemastery root spec ' + String(declaredSchema) + ', expected ' + schemaSpec)
  if (target.schemastery !== undefined) {
    verifyVisible('@deepseek-ai/schemastery', target.schemastery, host?.path, true)
  }

  // dsh-hmr is a *host* dependency that may legitimately be nested. Verify it
  // from the host context rather than declaring the tree incomplete.
  const hmrName = '@deepseek-ai/dsh-hmr'
  if (host?.manifest?.dependencies?.[hmrName] !== undefined) {
    const hmr = installedFrom(host.path, hmrName)
    console.log(hmrName + ' from host: ' + String(hmr?.version ?? 'MISSING'))
    if (hmr?.version !== expected) fail(hmrName + ' resolved ' + String(hmr?.version) + ', expected ' + expected)
  }
  if (failures.length > 0) {
    console.error('FAIL: installed host graph (' + failures.length + ' issue(s))')
    process.exitCode = 1
  } else {
    console.log('OK: installed host, DSH family, Cordis roots, Schemastery and nested dependencies match')
  }
} catch (error) {
  console.error('FAIL: installed host graph inspection failed: ' + String(error))
  process.exitCode = 1
}
