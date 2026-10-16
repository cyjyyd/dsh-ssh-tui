#!/usr/bin/env node
/**
 * The artifact gate: what `npm publish` would upload, installed the way a user installs
 * it, booted on a real PTY.
 *
 * Every other probe in this repo runs the **checkout** — `probe-home.mjs` installs
 * `link:<repo>`, so the tree under test is the source tree, with its `src/`, its tests
 * and its uncommitted edits. That is the right subject for a behavioural probe and the
 * wrong one for "does a fresh install work": 0.8.3's incident (a pasted API key never
 * reaching the wizard's field) was found by a user on a `npm i dsh-ssh-tui` install,
 * and nothing in CI had ever run that artifact.
 *
 * So this packs the tree, inspects the tarball, installs **that file** into a throwaway
 * home outside the repository, proves the installed package is the packed one rather
 * than the checkout, and then runs the two probes that matter on it: the first-run
 * wizard (unconfigured home) and the workspace (`/diag`, `/status`, the layers).
 *
 *   node scripts/artifact-smoke.mjs                 # pack, install, probe, clean up
 *   node scripts/artifact-smoke.mjs --keep          # leave the home for inspection
 *   node scripts/artifact-smoke.mjs --check <tgz>   # manifest gate only, on any tarball
 *   node scripts/artifact-smoke.mjs --json          # machine-readable summary
 *
 * Exit code 0 means every assertion passed. A failure prints its classification — see
 * `classifyInstallFailure` for the difference between "this package is broken" and "the
 * host's plugin manager could not run here", because the second one must not be fixed by
 * changing this package.
 *
 * @module dsh-ssh-tui/scripts/artifact-smoke
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

const require = createRequire(import.meta.url)
const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')

/** Files the published package must carry: the entry points and what they need. */
const REQUIRED = [
  'package.json',
  'lib/index.js',
  'lib/tui.js',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
]

/** Paths a published package must not carry, with the reason each is a leak. */
const FORBIDDEN = [
  [/^package\/src\//u, 'the TypeScript source (the build output is what ships)'],
  [/^package\/tests\//u, 'the test suite'],
  [/^package\/scripts\//u, 'the repo scripts, probes and CI helpers'],
  [/^package\/\.github\//u, 'CI configuration'],
  [/^package\/\.pf\//u, 'scratch material'],
  [/^package\/\.npm-cache-tmp\//u, 'the local npm cache'],
  [/\.tgz$/u, 'a nested tarball'],
  [/^package\/node_modules\//u, 'vendored dependencies'],
]

/**
 * One tarball's manifest, read without installing anything.
 *
 * Exported because it is the half that can be pointed at *any* tarball (`--check`), which
 * is what makes the assertions testable: a tarball with no `lib/tui.js` or a leaked
 * `tests/` has to fail this function, and a fixture can prove it does.
 */
export function inspectTarball(tarball) {
  const list = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .filter(line => line !== '')
  const files = list.filter(name => !name.endsWith('/'))
  const packed = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
  const problems = []
  for (const name of REQUIRED) {
    if (!files.includes(`package/${name}`)) problems.push(`the tarball is missing ${name}`)
  }
  for (const name of files) {
    for (const [pattern, why] of FORBIDDEN) {
      if (pattern.test(name)) problems.push(`the tarball carries ${name} — ${why}`)
    }
  }
  const bytes = statSync(tarball).size
  return { tarball, files, packed, problems, bytes }
}

/**
 * Why an install failed, in the terms a maintainer has to act on.
 *
 * The distinction that matters: a **package** problem is something this repository can
 * fix (a bad `files` list, a peer range, a broken `prepack`), while an **environment**
 * problem is the host's plugin manager being unable to run (no writable store, no
 * network, a sandbox without pnpm's cache) and must never be worked around by changing
 * the package. The Windows/pnpm manifest-reconciliation reports are the second kind
 * until proven otherwise.
 */
export function classifyInstallFailure({ status, output, repo = REPO }) {
  const text = String(output)
  if (/ERR_PNPM|ERR_SQLITE_ERROR|unable to open database file|ENOSPC|EACCES|EPERM|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/u.test(text)) {
    return {
      kind: 'environment',
      detail: 'the host plugin manager could not run (store/network/permissions), not this package',
    }
  }
  if (/ERR_PNPM_PEER_DEP_ISSUES|unmet peer|peer dep/u.test(text)) {
    return { kind: 'package-or-host-line', detail: 'a peer range disagrees with the installed host line' }
  }
  if (/E404|ETARGET|not found in the registry/u.test(text)) {
    return { kind: 'package-or-registry', detail: 'a dependency this package declares cannot be resolved' }
  }
  if (status !== 0) {
    return { kind: 'unknown', detail: `exit ${status}; see the captured output` }
  }
  return { kind: 'none', detail: 'the command reported success' }
}

/** The profile's manifest and node_modules, as the install left them. */
function profileState(home, profile) {
  const dir = join(home, 'profiles', profile)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const entry = join(dir, 'node_modules', 'dsh-ssh-tui')
  let present = false
  let symlink = false
  let realPath
  try {
    present = true
    symlink = lstatSync(entry).isSymbolicLink()
    realPath = realpathSync(entry)
  } catch {
    // Not installed: the assertions below say so.
  }
  return { dir, manifest, entry, present, symlink, realPath }
}

const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

async function main(argv) {
  const json = argv.includes('--json')
  const keep = argv.includes('--keep')
  const checkAt = argv.indexOf('--check')
  const say = (...args) => { if (!json) console.log(...args) }

  if (checkAt !== -1) {
    const tarball = argv[checkAt + 1]
    if (tarball === undefined) {
      console.error('usage: node scripts/artifact-smoke.mjs --check <tgz>')
      return 2
    }
    const report = inspectTarball(tarball)
    if (json) console.log(JSON.stringify({ mode: 'check', ...report }, null, 2))
    else {
      console.log(`tarball: ${report.tarball} (${report.bytes} B, ${report.files.length} files)`)
      console.log(`packed:  ${report.packed.name}@${report.packed.version}`)
    }
    if (report.problems.length > 0) {
      for (const problem of report.problems) console.error(`  ✗ ${problem}`)
      return 1
    }
    say('OK: the tarball carries what a published package needs, and only that')
    return 0
  }

  const problems = []
  const check = (condition, message) => { if (!condition) problems.push(message) }

  // 1. Pack. `--cache` because a sandbox with a read-only shared cache fails `npm pack`
  //    before it writes anything, and that reads like a packaging defect.
  const packDir = mkdtempSync(join(tmpdir(), 'dsh-artifact-pack-'))
  const status = spawnSync('npm', ['pack', '--pack-destination', packDir, '--cache', join(REPO, '.npm-cache-tmp')], {
    cwd: REPO, encoding: 'utf8', windowsHide: true,
  })
  if (status.status !== 0) {
    console.error(`FAIL: npm pack exited with ${status.status}\n${status.stdout ?? ''}${status.stderr ?? ''}`)
    return 1
  }
  const tarball = join(packDir, String(status.stdout).trim().split('\n').at(-1).trim())
  say(`==> packed ${tarball}`)

  // 2. The manifest itself: what a published package must and must not carry.
  const report = inspectTarball(tarball)
  say(`==> ${report.packed.name}@${report.packed.version} · ${report.files.length} files · ${report.bytes} B`)
  check(report.problems.length === 0, `tarball manifest: ${report.problems.join('; ')}`)
  check(report.packed.name === 'dsh-ssh-tui', `the package name is ${report.packed.name}`)
  check(report.packed.main === 'lib/index.js', `main is ${report.packed.main}`)
  check(report.packed.dsh?.bundle?.patch === './cordis.patch.yml', 'the dsh bundle patch is declared')
  const repoVersion = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version
  check(report.packed.version === repoVersion, `the packed version ${report.packed.version} matches the tree ${repoVersion}`)

  // 3. Install *that file* into a home outside the repository, so "is the running code
  //    the checkout?" is answered by a path comparison rather than by inspection.
  const home = mkdtempSync(join(tmpdir(), 'dsh-artifact-home-'))
  const env = { ...process.env, DSH_HOME: home, DSH_TUI_NO_UPDATE_CHECK: '1' }
  const runHost = (args, options = {}) => spawnSync(process.execPath, [CLI, ...args], {
    env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...options,
  })
  const scaffold = runHost(['--profile', 'tui', '--from-default-profile', 'headless', '--help'], { stdio: 'ignore' })
  if (scaffold.status !== 0) {
    console.error(`FAIL: the host could not scaffold a profile (exit ${scaffold.status})`)
    return 1
  }
  const manifestFile = join(home, 'profiles', 'tui', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== '@deepseek-ai/dsh-headless')
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

  say(`==> installing ${tarball} into ${home}`)
  const install = runHost(['plugin', '--profile', 'tui', 'add', tarball])
  const installText = `${install.stdout ?? ''}${install.stderr ?? ''}`
  const state = profileState(home, 'tui')
  if (install.status !== 0) {
    // §5 of the round brief: keep the failure, classify it, never work around it.
    const verdict = classifyInstallFailure({ status: install.status ?? 1, output: installText, repo: REPO })
    console.error('FAIL: `dsh plugin add <tarball>` did not succeed')
    console.error(`  exit code:       ${install.status}`)
    console.error(`  classification:  ${verdict.kind} — ${verdict.detail}`)
    console.error(`  manifest deps:   ${JSON.stringify(state.manifest.dependencies ?? {})}`)
    console.error(`  manifest bundles:${JSON.stringify(state.manifest.dsh?.profile?.bundles ?? [])}`)
    console.error(`  node_modules:    ${state.present ? 'present' : 'absent'}`)
    console.error(`  stdout/stderr:\n${installText.trim()}`)
    console.error(`  profile:         ${home}${keep ? ' (kept)' : ''}`)
    if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 3 })
    return 1
  }

  // 4. The installed package is the packed one, not the checkout.
  const spec = String(state.manifest.dependencies?.['dsh-ssh-tui'] ?? '')
  check(spec.startsWith('file:'), `the profile depends on ${JSON.stringify(spec)} — a tarball install records \`file:\``)
  check(spec === `file:${tarball}`, `the recorded spec ${JSON.stringify(spec)} is the tarball that was installed`)
  check(state.present, 'the profile has a node_modules/dsh-ssh-tui')
  check(state.symlink === false, 'it is a real install, not a symlink into the checkout (`link:` installs are)')
  check(state.realPath !== realpathSync(REPO), `it resolves to ${state.realPath}, not to the repository`)
  check((state.realPath ?? '').startsWith(join(home, 'profiles', 'tui')), `it lives inside the profile (${state.realPath})`)
  if (state.present) {
    const installed = JSON.parse(readFileSync(join(state.entry, 'package.json'), 'utf8'))
    check(installed.version === report.packed.version, `the installed version is ${installed.version}`)
    check(installed.main === 'lib/index.js', `the installed main is ${installed.main}`)
    for (const name of ['lib/index.js', 'lib/tui.js', 'cordis.patch.yml', 'README.md']) {
      check(statSync(join(state.entry, name), { throwIfNoEntry: false }) !== undefined, `the installed package has ${name}`)
    }
    check(statSync(join(state.entry, 'tests'), { throwIfNoEntry: false }) === undefined, 'and carries no test suite')
  }
  check(state.manifest.dsh?.profile?.bundles?.includes('dsh-ssh-tui') === true,
    `the profile composes the plugin (bundles: ${JSON.stringify(state.manifest.dsh?.profile?.bundles ?? [])})`)
  const config = runHost(['--profile', 'tui', '--dump-config'], { stdio: 'ignore' })
  check(config.status === 0, `the installed profile composes (--dump-config exited ${config.status})`)

  // 5. The probes, on the installed artifact. The wizard first: the home has no
  //    credential, which is exactly the first-run a user meets.
  const probe = (script, extra = {}) => spawnSync(process.execPath, [join(REPO, 'scripts', script)], {
    stdio: json ? 'pipe' : 'inherit',
    windowsHide: true,
    env: { ...process.env, PROBE_HOME: home, PROBE_REQUIRE_PTY: '1', ...extra },
  })
  const wizard = probe('tui-setup-probe.mjs', { PROBE_REQUIRE_WIZARD: '1' })
  check(wizard.status === 0, `the first-run wizard probe exited ${wizard.status}`)
  if (json && wizard.status !== 0) say(String(wizard.stdout ?? '') + String(wizard.stderr ?? ''))

  // …then the workspace, on the same install, with the credential a finished wizard
  // would have left.
  const { provisionProbeCredential } = await import(pathToFileURL(join(REPO, 'scripts', 'probe-home.mjs')).href)
  if (wizard.status === 0) {
    provisionProbeCredential({ home, profile: 'tui', cli: CLI, log: () => {} })
    const workspace = probe('tui-probe.mjs')
    check(workspace.status === 0, `the workspace probe exited ${workspace.status}`)
    if (json && workspace.status !== 0) say(String(workspace.stdout ?? '') + String(workspace.stderr ?? ''))
  }

  if (!keep) {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 })
    rmSync(packDir, { recursive: true, force: true, maxRetries: 3 })
    // A Host the probes left behind can hold the home on Windows; a dirty temp dir is
    // not a gate failure, and the next run gets a fresh one anyway.
    await delay(0)
  } else {
    console.log(`==> kept ${home}`)
  }

  if (json) {
    console.log(JSON.stringify({
      mode: 'smoke',
      tarball,
      packed: { name: report.packed.name, version: report.packed.version, files: report.files.length, bytes: report.bytes },
      installed: { spec, realPath: state.realPath, symlink: state.symlink },
      problems,
    }, null, 2))
  }
  if (problems.length > 0) {
    console.error('FAIL')
    for (const problem of problems) console.error(`  - ${problem}`)
    return 1
  }
  console.log('OK: the packed artifact installs, resolves to the profile rather than the checkout,'
    + ' composes, walks the first-run wizard (pasted key included) and runs the workspace probes')
  return 0
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(await main(process.argv.slice(2)))
}
