#!/usr/bin/env node
/**
 * Upgrade smoke: a profile that already has this plugin, with a candidate installed over
 * it, and the state a user would lose if the swap were careless.
 *
 * What it exists to catch is the class of defect that only shows up on the *second*
 * install: a manifest reconciliation that drops the bundle entry, a plugin manager that
 * rewrites `dsh.profile.bundles` and forgets the plugin, a credential or a session store
 * that a reinstall wipes. `artifact-smoke.mjs` proves a fresh install works; this proves
 * the install that replaces one does not take the user's state with it.
 *
 *   node scripts/upgrade-smoke.mjs --from 0.8.3 --to <candidate.tgz>
 *   node scripts/upgrade-smoke.mjs --from 0.8.3 --pack
 *   node scripts/upgrade-smoke.mjs --from 0.8.3 --pack --allow-same-version
 *
 * **A same-version swap is not an upgrade**, and this script refuses to pretend otherwise:
 * with `--to` the same version as `--from` it stops and says so, unless
 * `--allow-same-version` is passed, in which case it exercises the mechanics and labels
 * the run a *reinstall* smoke. A real upgrade is a mandatory step **after** the version
 * bump (`docs/release.md`, 「发布前人工门槛」), not something a test may manufacture by
 * editing `package.json` — the version in the tree is what ships.
 *
 * @module dsh-ssh-tui/scripts/upgrade-smoke
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

import { buildProbeHome, packCheckout, provisionProbeCredential } from './probe-home.mjs'

const require = createRequire(import.meta.url)
const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')

const USAGE = `usage: node scripts/upgrade-smoke.mjs --from <version|tgz> [--to <tgz> | --pack]
                                      [--allow-same-version] [--keep] [--json]

  --from <spec>   what the user already has: a published version (\`0.8.3\`), an npm spec,
                  or a path to a tarball
  --to <tgz>      the candidate tarball (default: the checkout, packed)
  --pack          pack this checkout as the candidate
  --allow-same-version
                  run the mechanics even when the candidate's version equals the
                  installed one, and label the result a reinstall smoke, not an upgrade
  --keep          keep the throwaway home
  --json          machine-readable summary`

const runHost = (home, args, options = {}) => spawnSync(process.execPath, [CLI, ...args], {
  env: { ...process.env, DSH_HOME: home, DSH_TUI_NO_UPDATE_CHECK: '1' },
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 64 * 1024 * 1024,
  ...options,
})

/** The version an installed plugin reports, and what its manifest records. */
function installedState(home, profile = 'tui') {
  const dir = join(home, 'profiles', profile)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  let version
  try {
    version = JSON.parse(readFileSync(join(dir, 'node_modules', 'dsh-ssh-tui', 'package.json'), 'utf8')).version
  } catch {
    version = undefined
  }
  return { manifest, version, spec: manifest.dependencies?.['dsh-ssh-tui'] }
}

/** What a user would lose: the credential file and the session store, by hash and count. */
function userState(home) {
  const hash = path => {
    try {
      return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
    } catch {
      return null
    }
  }
  let sessions = 0
  try {
    sessions = statSync(join(home, 'sessions')).isDirectory() ? 1 : 0
  } catch {
    sessions = 0
  }
  return { credential: hash(join(home, '.credentials.yaml')), sessions }
}

async function main(argv) {
  const valueOf = flag => {
    const at = argv.indexOf(flag)
    return at === -1 ? undefined : argv[at + 1]
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  const json = argv.includes('--json')
  const keep = argv.includes('--keep')
  const sameVersionAllowed = argv.includes('--allow-same-version')
  const from = valueOf('--from')
  if (from === undefined) {
    console.error(USAGE)
    return 2
  }
  const say = (...args) => { if (!json) console.log(...args) }
  const problems = []
  const check = (condition, message) => { if (!condition) problems.push(message) }

  const to = valueOf('--to') ?? packCheckout()
  const fromSpec = from.endsWith('.tgz') ? `file:${from}` : (/^\d/u.test(from) ? `dsh-ssh-tui@${from}` : from)
  const fromVersion = from.endsWith('.tgz')
    ? JSON.parse(spawnSync('tar', ['-xzOf', from, 'package/package.json'], { encoding: 'utf8' }).stdout).version
    : from
  const toVersion = JSON.parse(spawnSync('tar', ['-xzOf', to, 'package/package.json'], { encoding: 'utf8' }).stdout).version

  say(`==> from ${fromSpec} (${fromVersion})`)
  say(`==> to   ${to} (${toVersion})`)
  if (fromVersion === toVersion && !sameVersionAllowed) {
    // Refusing is the point: an "upgrade" between two identical versions proves nothing
    // about upgrades, and manufacturing a difference by editing the version is forbidden.
    console.log(`SKIP: the candidate is ${toVersion} and the installed plugin is ${fromVersion} —`)
    console.log('      a same-version swap is a REINSTALL, not an upgrade, so there is no upgrade')
    console.log('      evidence to gather here. Run the mechanics anyway with --allow-same-version')
    console.log('      (labelled a reinstall smoke), and run this gate for real after the version')
    console.log('      bump, as the mandatory post-bump release step recorded in docs/release.md.')
    return 0
  }

  // 1. A profile with the *previous* build in it, configured the way a user's is.
  const home = buildProbeHome({ credential: false, log: message => say(message) })
  say(`==> probe home: ${home}`)
  // The install above links the checkout; replace it with the `from` build so the state
  // under test belongs to the older artifact.
  runHost(home, ['plugin', '--profile', 'tui', 'remove', 'dsh-ssh-tui'], { stdio: 'ignore' })
  runHost(home, ['plugin', '--profile', 'tui', 'add', fromSpec], { stdio: 'ignore' })
  provisionProbeCredential({ home, profile: 'tui', cli: CLI, log: () => {} })
  const before = { installed: installedState(home), state: userState(home) }
  check(before.installed.version === fromVersion, `the from-build installed ${before.installed.version}`)

  // 2. The candidate over it.
  const upgrade = runHost(home, ['plugin', '--profile', 'tui', 'add', `file:${to}`])
  check(upgrade.status === 0, `installing the candidate exited ${upgrade.status}: ${String(upgrade.stderr ?? '').trim().slice(0, 400)}`)
  const after = { installed: installedState(home), state: userState(home) }
  check(after.installed.version === toVersion, `the plugin now reports ${after.installed.version}`)
  check(after.installed.manifest.dsh?.profile?.bundles?.includes('dsh-ssh-tui') === true,
    `the profile still composes the plugin (bundles: ${JSON.stringify(after.installed.manifest.dsh?.profile?.bundles ?? [])})`)
  check(after.state.credential === before.state.credential, 'the credential file survived the swap unchanged')
  check(after.state.sessions === before.state.sessions, 'the session store survived the swap')

  // 3. It still boots: composing is the cheap half, `--dump-config` the honest one.
  const boot = runHost(home, ['--profile', 'tui', '--dump-config'], { stdio: 'ignore' })
  check(boot.status === 0, `the upgraded profile composes (exit ${boot.status})`)

  if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 3 })
  else say(`==> kept ${home}`)

  const summary = {
    mode: fromVersion === toVersion ? 'reinstall-smoke' : 'upgrade-smoke',
    from: { spec: fromSpec, version: fromVersion },
    to: { tarball: to, version: toVersion },
    before: before.installed.spec,
    after: after.installed.spec,
    credentialSurvived: after.state.credential === before.state.credential,
    problems,
  }
  if (json) console.log(JSON.stringify(summary, null, 2))
  if (problems.length > 0) {
    console.error(`FAIL (${summary.mode})`)
    for (const problem of problems) console.error(`  - ${problem}`)
    return 1
  }
  console.log(fromVersion === toVersion
    ? `OK (reinstall smoke, NOT an upgrade): ${fromVersion} → ${toVersion} — the manifest, the bundle entry, the credential and the session store survived a same-version swap`
    : `OK (upgrade smoke): ${fromVersion} → ${toVersion} — the manifest, the bundle entry, the credential and the session store survived`)
  return 0
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(await main(process.argv.slice(2)))
}
