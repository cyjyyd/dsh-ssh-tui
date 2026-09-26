#!/usr/bin/env node
/**
 * Re-pin this checkout's manifest to one `@deepseek-ai/dsh` line.
 *
 * `package.json` commits the *default* line — the one CI's default legs and a
 * plain `npm install` resolve. Every other line is derived: CI runs this script
 * before installing, so the same source tree is verified against a host family
 * it is not committed to. Keeping the rewrite here rather than inline in the
 * workflow means it is a pure function with a test (`tests/ci-pin-line.test.mjs`)
 * instead of a shell heredoc nobody can run locally.
 *
 * A line needs more than a version substitution, which is why this is a table:
 *  - the 0.1.7 family split the plural `dsh-agent-presets` into `dsh-agent-preset`
 *    + `dsh-agent-preset-registry` (the plural has no release on that line at
 *    all, so npm fails with ETARGET if it stays), and it moved the family's own
 *    root pins (cordis 4.0.4, include 1.0.9, loader 1.0.5, timer 1.1.6);
 *  - every line needs the whole family on one version: a root spec that floats
 *    resolves above the family's exact peer and the install dies with ERESOLVE;
 *  - 0.1.7 additionally needs `overrides`, because the published ranges still
 *    carry prerelease carets (`^0.1.5-rc.3`) and npm resolves those through the
 *    `latest` tag rather than to the highest match — without the map a plain
 *    install drags 0.1.5 packages into a tree pinned to 0.1.7 and the agent
 *    runtime loads two module instances. `--legacy-peer-deps` is not a
 *    substitute: it skips peer resolution entirely, which leaves peer-only
 *    packages (the plural presets among them) missing.
 *
 * Usage: node scripts/ci-pin-line.mjs <line>
 * CI deletes `package-lock.json` after the rewrite: the committed lock belongs
 * to the default line.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Root specs the plugin pins without importing, per line. */
const LEGACY_ROOTS = {
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/cordis-plugin-include': '1.0.7',
  '@deepseek-ai/cordis-plugin-loader': '1.0.3',
  '@deepseek-ai/cordis-plugin-timer': '1.1.4',
}

export const LINES = {
  '0.1.7-rc.1': {
    /** The family's own pins on this line. `group` is not in the legacy table. */
    roots: {
      '@deepseek-ai/cordis': '4.0.4',
      '@deepseek-ai/cordis-plugin-include': '1.0.9',
      '@deepseek-ai/cordis-plugin-loader': '1.0.5',
      '@deepseek-ai/cordis-plugin-timer': '1.1.6',
      // dsh-app-boot peers on this one to compose the launcher tree; without it
      // the CLI cannot even print its help (ERR_MODULE_NOT_FOUND).
      '@deepseek-ai/cordis-plugin-group': '1.0.4',
    },
    presets: ['@deepseek-ai/dsh-agent-preset', '@deepseek-ai/dsh-agent-preset-registry'],
    overrides: true,
  },
  '0.1.5-rc.3': { roots: LEGACY_ROOTS, presets: ['@deepseek-ai/dsh-agent-presets'], overrides: false },
  '0.1.5-rc.1': { roots: LEGACY_ROOTS, presets: ['@deepseek-ai/dsh-agent-presets'], overrides: false },
}

/** Every root name any line pins: the ones this line does not get deleted. */
const ALL_ROOTS = [...new Set(Object.values(LINES).flatMap(line => Object.keys(line.roots)))]
/** Every presets package any line installs; the others are deleted. */
const ALL_PRESETS = [...new Set(Object.values(LINES).flatMap(line => line.presets))]

/**
 * The line `package.json` commits, so the default leg needs no rewrite at all.
 *
 * CI's pin step is guarded by `if: matrix.dsh != '<this>'`, and
 * `tests/workflow.test.mjs` reads that guard back to keep the two in step: a
 * manifest on one line installed by a leg that rewrites to another is how a
 * green run stops meaning anything.
 */
export const DEFAULT_LINE = '0.1.7-rc.1'

/** `@deepseek-ai/dsh` itself, or a package of the family. */
export function isFamilyPackage(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

function sorted(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/**
 * The manifest as it must look for `line`.
 *
 * Pure: the committed manifest goes in, the rewritten one comes out, and the
 * caller decides what to do with it. Peer ranges are deliberately untouched —
 * the plugin's declared window covers every line it is verified on, and the
 * launcher reads each declared peer range when it decides whether a plugin may
 * load, so narrowing one here would veto the plugin on the other line.
 */
export function pinManifest(manifest, line) {
  const target = LINES[line]
  if (target === undefined) {
    throw new Error(`unknown dsh line ${JSON.stringify(line)}; known: ${Object.keys(LINES).join(', ')}`)
  }
  const next = structuredClone(manifest)
  const dev = next.devDependencies ?? {}

  for (const name of ALL_ROOTS) {
    const pinned = target.roots[name]
    if (pinned === undefined) delete dev[name]
    else dev[name] = pinned
  }
  for (const name of ALL_PRESETS) {
    if (target.presets.includes(name)) dev[name] = line
    else delete dev[name]
  }
  for (const name of Object.keys(dev)) {
    if (isFamilyPackage(name)) dev[name] = line
  }
  next.devDependencies = sorted(dev)

  if (target.overrides) {
    const overrides = {}
    for (const name of new Set([...Object.keys(dev), ...Object.keys(next.dependencies ?? {})])) {
      if (isFamilyPackage(name)) overrides[name] = line
    }
    next.overrides = sorted(overrides)
  } else {
    // The legacy lines resolve from their own exact pins; an override left over
    // from the default line would drag 0.1.7 siblings into that tree instead.
    delete next.overrides
  }
  return next
}

/** Read, re-pin, and write `package.json` in `cwd`. */
export function pinFile(line, cwd = root) {
  const path = join(cwd, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  const next = pinManifest(manifest, line)
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const line = process.argv[2]
  if (line === undefined) {
    process.stderr.write(`usage: node scripts/ci-pin-line.mjs <${Object.keys(LINES).join('|')}>\n`)
    process.exit(2)
  }
  pinFile(line)
  process.stdout.write(`package.json pinned to the dsh ${line} line\n`)
}
