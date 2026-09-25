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

/**
 * The 0.1.7 counterpart: that line composes the agent process-wide (presets are
 * a per-session Web feature), so a terminal profile mounts the two tools the
 * standard preset declares. The persona is deliberately not mounted:
 * `@deepseek-ai/dsh-persona` registers prompt sections `dsh-system-prompt`
 * already owns at this layer, which the loader rejects, so such an entry would
 * never activate. Mirrors `FORMS_PATCH_BLOCK` in `src/preset-rows.ts`; the same
 * test pins them together.
 */
export const FORMS_BLOCK = `# dsh-ssh-tui: the agent-plane rows a 0.1.7 terminal profile mounts for itself.
# That line composes the agent process-wide (presets are a per-session Web
# feature now), and dsh-base already carries the rest of what the standard
# preset declares: dsh-system-prompt owns the persona sections at this layer, so
# only the two tools are left to mount. @deepseek-ai/dsh-persona is deliberately
# absent — mounting it here collides with those sections and never activates.
- insert:
    - id: tool-ask-user
      name: '@deepseek-ai/dsh-tool-ask-user'

    - id: present
      name: '@deepseek-ai/dsh-tool-present'
`

/** The row whose presence means this host line's rows are already mounted. */
const MARKER = { legacy: ROSTER_MODULE, forms: '@deepseek-ai/dsh-tool-present' }

/** The modules whose presence in the composition means "nothing to mount". */
const COMPOSED = { legacy: ROSTER_MODULE, forms: '@deepseek-ai/dsh-agent-preset-registry' }

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

/** The composed profile tree, or `undefined` when it cannot be dumped yet. */
function dumpConfig({ profile, home, cli, run = spawnSync }) {
  const result = run(process.execPath, [cli, '--profile', profile, '--dump-config'], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error !== undefined && result.error !== null) return undefined
  const text = String(result.stdout ?? '')
  return text.trim() === '' ? undefined : text
}

/**
 * Which rows this host line's profile has to mount.
 *
 * Read from the composition, not from a version string: the 0.1.7 base is the
 * one that carries a `config-editor` row (its settings document is the profile
 * patch). A profile that cannot be dumped yet falls back to the launcher's own
 * package version, so a half-built home still gets the right block.
 */
export function profileGeneration({ profile, home, cli, run = spawnSync }) {
  const dump = dumpConfig({ profile, home, cli, ...(run === undefined ? {} : { run }) })
  if (dump !== undefined) return dump.includes('- id: config-editor') ? 'forms' : 'legacy'
  try {
    const version = JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'), 'utf8')).version
    return String(version).startsWith('0.1.7') || /^0\.1\.(?:[89]|\d{2,})/u.test(String(version)) ? 'forms' : 'legacy'
  } catch {
    return 'legacy'
  }
}

/**
 * Whether the profile in `home` already composes this generation's rows.
 *
 * The check is the composition, not the patch text: a profile bundling the web
 * app has a preset roster already, and adding this block there would mount rows
 * twice. A profile that cannot even dump its config is treated as "not yet".
 */
export function profileComposesRoster({ profile, home, cli, run = spawnSync, generation }) {
  const dump = dumpConfig({ profile, home, cli, ...(run === undefined ? {} : { run }) })
  const line = generation ?? (dump !== undefined && dump.includes('- id: config-editor') ? 'forms' : 'legacy')
  return dump !== undefined && dump.includes(COMPOSED[line])
}

/**
 * Materialize the rows in `home`'s profile patch. Returns what it did so
 * callers can log it; never throws on an already-mounted profile.
 */
export function mountProfileRows({
  profile,
  home,
  cli = require.resolve('@deepseek-ai/dsh/lib/bin.js'),
  log = console.log,
  run,
  generation,
}) {
  const line = generation ?? profileGeneration({ profile, home, cli, ...(run === undefined ? {} : { run }) })
  if (profileComposesRoster({ profile, home, cli, ...(run === undefined ? {} : { run }), generation: line })) {
    log(`==> profile '${profile}' already composes the ${line === 'forms' ? 'preset plane' : 'agent-preset roster'}`)
    return 'already-mounted'
  }
  const patchFile = profilePatchPath(profile, home)
  if (!existsSync(patchFile)) {
    log(`==> creating profile patch file at ${patchFile}`)
    mkdirSync(dirname(patchFile), { recursive: true })
    writeFileSync(patchFile, PATCH_HEADER)
  }
  const text = readFileSync(patchFile, 'utf8')
  if (new RegExp(`name:\\s*'${MARKER[line].replaceAll('/', '\\/')}'`).test(text)) {
    log('    patch already names the row; leaving it as it is')
    return 'already-named'
  }
  const block = line === 'forms' ? FORMS_BLOCK : ROSTER_BLOCK
  log(line === 'forms'
    ? `==> mounting the agent-plane rows in profile '${profile}'`
    : `==> mounting the agent-preset roster in profile '${profile}'`)
  const next = /^\s*\[\s*\]\s*$/mu.test(text)
    ? text.replace(/^\s*\[\s*\]\s*$/mu, `${block.trimEnd()}\n`)
    : `${text.endsWith('\n') ? text : `${text}\n`}\n${block}`
  writeFileSync(patchFile, next)
  return 'mounted'
}

function main(argv = process.argv.slice(2)) {
  const profile = argv[0] ?? process.env.DSH_TUI_PROFILE ?? 'tui'
  mountProfileRows({ profile, home: resolveDshHome() })
  console.log(`==> done`)
  console.log(`restart the TUI so the settings rows are picked up: dsh --profile ${profile}`)
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
}
