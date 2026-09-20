#!/usr/bin/env node
/**
 * Mount the agent-preset roster the TUI's /mode needs into a dsh profile.
 *
 * `dsh-base` composes no preset roster in a terminal profile, and this plugin's
 * own bundle patch may not mount one: DSH STORE accepts additive rows with
 * plugin-owned ids and no @deepseek-ai/* module names. The profile's user patch
 * layer is the supported home for them, so this materializes:
 *
 *   agent-presets                     the roster /mode lists and switches
 *   code-runtime                      the TypeScript runtime the ptc preset needs
 *   subagent-model-selection-settings the host-owned subagent delegation setting
 *
 * Idempotent: a profile that already composes @deepseek-ai/dsh-agent-presets
 * (one bundling @deepseek-ai/dsh-web-app, for example) is left untouched.
 * Adding such a bundle to a profile that ALREADY has this block would list the
 * roster row twice, and the second mount fails ("service ... has been
 * registered"): remove the block below from the profile patch first.
 *
 * Portable on purpose: `scripts/ensure-profile-rows.sh` is a thin wrapper, and
 * the CI probe bootstrap calls this module directly, so Windows gets the same
 * roster without needing bash.
 *
 * Usage:
 *   node scripts/profile-rows.mjs [profile]      # default: tui (or $DSH_TUI_PROFILE)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

const ROSTER_MODULE = '@deepseek-ai/dsh-agent-presets'

/**
 * The patch block this module owns, verbatim (comment included on purpose).
 *
 * Exported so `tests/preset-rows.test.mjs` can diff it against the runtime's
 * copy in `src/preset-rows.ts`: the published package does not ship `scripts/`,
 * so those two must stay identical or the in-app repair writes a different
 * roster than the install path.
 */
export const ROSTER_BLOCK = `# dsh-ssh-tui /mode: the agent-preset roster (standard / minimal / PTC /
# cordis, plus every preset under $DSH_HOME/.agent-presets) and the two host
# services the shipped presets need. dsh-base composes no roster in a terminal
# profile, and a third-party bundle patch may not mount an @deepseek-ai row, so
# the profile's user layer owns them.
- insert:
    - id: agent-presets
      name: '${ROSTER_MODULE}'
      config:
        default: standard

    - id: code-runtime
      name: '@deepseek-ai/dsh-code-runtime-worker-thread'

    - id: subagent-model-selection-settings
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
`

/** The patch file a profile starts from when it has none. */
const PATCH_HEADER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv.trim() : join(homedir(), '.dsh')
}

export function profilePatchPath(profile, home) {
  return join(home, 'profiles', profile, 'cordis.patch.yml')
}

/**
 * Whether the profile in `home` already composes the roster.
 *
 * The check is the composition, not the patch text: a profile bundling the web
 * app has the roster already, and adding this block there would mount the row
 * twice. A profile that cannot even dump its config is treated as "not yet".
 */
export function profileComposesRoster({ profile, home, cli, run = spawnSync }) {
  const result = run(process.execPath, [cli, '--profile', profile, '--dump-config'], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    windowsHide: true,
  })
  return String(result.stdout ?? '').includes(ROSTER_MODULE)
}

/**
 * Materialize the roster rows in `home`'s profile patch. Returns what it did so
 * callers can log it; never throws on an already-mounted profile.
 */
export function mountProfileRows({
  profile,
  home,
  cli = require.resolve('@deepseek-ai/dsh/lib/bin.js'),
  log = console.log,
  run,
}) {
  if (profileComposesRoster({ profile, home, cli, ...(run === undefined ? {} : { run }) })) {
    log(`==> profile '${profile}' already composes the agent-preset roster`)
    return 'already-mounted'
  }
  const patchFile = profilePatchPath(profile, home)
  if (!existsSync(patchFile)) {
    log(`==> creating profile patch file at ${patchFile}`)
    mkdirSync(dirname(patchFile), { recursive: true })
    writeFileSync(patchFile, PATCH_HEADER)
  }
  const text = readFileSync(patchFile, 'utf8')
  if (new RegExp(`name:\\s*'${ROSTER_MODULE.replaceAll('/', '\\/')}'`).test(text)) {
    log('    patch already names the roster row; leaving it as it is')
    return 'already-named'
  }
  log(`==> mounting the agent-preset roster in profile '${profile}'`)
  const next = /^\s*\[\s*\]\s*$/mu.test(text)
    ? text.replace(/^\s*\[\s*\]\s*$/mu, `${ROSTER_BLOCK.trimEnd()}\n`)
    : `${text.endsWith('\n') ? text : `${text}\n`}\n${ROSTER_BLOCK}`
  writeFileSync(patchFile, next)
  return 'mounted'
}

function main(argv = process.argv.slice(2)) {
  const profile = argv[0] ?? process.env.DSH_TUI_PROFILE ?? 'tui'
  mountProfileRows({ profile, home: resolveDshHome() })
  console.log(`==> done`)
  console.log(`restart the TUI for /mode to pick up the roster: dsh --profile ${profile}`)
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
}
