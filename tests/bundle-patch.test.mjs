import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FORMS_HOST, HOST_VERSION } from './host-line.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROTECTED_ENTRY_IDS = new Set(['ui-settings-plugin-inventory', 'dsh-safe-plugin-manager'])

test('bundle patch is additive and does not impersonate @deepseek-ai', async () => {
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.files.includes('cordis.patch.yml'), true)
  assert.equal(typeof manifest.exports['./cordis.patch.yml'], 'string')
  // Issue 667: DSH STORE prunes candidates whose Bundle Patch impersonates
  // @deepseek-ai, disables official rows, or omits exact dshReleases.
  // Comments may mention the forbidden namespace; only `name:` rows count.
  assert.equal(/\bname:\s*['"]?@deepseek-ai\//i.test(patch), false)
  assert.equal(/\bdisabled:\s*true\b/i.test(patch), false)
  assert.equal(/^\s*- id:\s*(?!ssh-tui)/m.test(patch.replace(/- insert:[\s\S]*/u, '')), false)

  const ids = [...new Set([...patch.matchAll(/(?:^|\n)\s*- id:\s*['"]?([A-Za-z0-9][A-Za-z0-9._-]{0,95})['"]?\s*(?:\n|$)/g)]
    .map(match => match[1]))]
  // `ssh-tui-routes` and `ssh-tui-subagent` exist because 0.1.7 projects a
  // settings form out of a loader entry's own Config schema, so a namespace a
  // plugin owns needs a row of its own; their ids are the namespaces, which is
  // also what the host imports a pre-0.1.7 `settings.yaml` section into.
  assert.deepEqual(ids.sort(), ['ssh-tui', 'ssh-tui-routes', 'ssh-tui-startup', 'ssh-tui-subagent'])
  assert.equal(ids.some(id => PROTECTED_ENTRY_IDS.has(id)), false)
  assert.equal(ids.some(id => id.startsWith('llm-') || id.startsWith('tool-') || id === 'hmr' || id === 'system-prompt' || id === 'agent-presets'), false)
})

test('manifest declares exact dshReleases for the store window', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const releases = manifest.dsh?.compatibility?.dshReleases
  assert.equal(typeof releases, 'object')
  for (const version of [
    '0.1.3-alpha.1',
    '0.1.3-alpha.2',
    '0.1.5-alpha.1',
    '0.1.5-alpha.2',
    '0.1.5-rc.1',
    '0.1.5-rc.2',
    '0.1.5-rc.3',
  ]) {
    const status = releases[version]
    assert.ok(status === 'compatible' || status === 'incompatible' || status === 'unknown', version)
  }
  // Two lines have been dropped by now, and both keep an explicit verdict
  // instead of being deleted: a user still on that line gets a definite
  // "incompatible, upgrade" from the store rather than silence, and no range
  // comparator can admit them by accident.
  assert.equal(releases['0.1.2-rc.1'], 'incompatible')
  assert.equal(releases['0.1.3-alpha.1'], 'incompatible')
  assert.equal(releases['0.1.3-alpha.2'], 'incompatible')
  assert.equal(releases['0.1.5-alpha.1'], 'incompatible')
  assert.equal(releases['0.1.5-alpha.2'], 'incompatible')
  assert.equal(releases['0.1.5-rc.1'], 'incompatible')
  assert.equal(releases['0.1.5-rc.2'], 'incompatible')
  assert.equal(releases['0.1.5-rc.3'], 'incompatible')
  // The lines that are supported state it per release, newest included.
  assert.equal(releases['0.1.7-rc.1'], 'compatible')
  assert.equal(releases['0.1.7-rc.2'], 'compatible')
  assert.equal(releases['0.2.0-rc.1'], 'compatible')
  assert.equal(manifest.engines?.node, '>=22.19')
})

test('root specs for the family-pinned packages are exact, not floating', async () => {
  // The 0.1.5-rc.3 family moved these from caret ranges to exact pins. A root
  // spec that floats (`^4.0.1`) resolves above the pin (`4.0.2`), and npm then
  // cannot satisfy the family's exact peer — the install dies with ERESOLVE.
  // That is not hypothetical: upstream published cordis 4.0.3/4.0.4,
  // cordis-plugin-loader 1.0.4/1.0.5 and schemastery 3.18.3/3.18.4 on
  // 2026-09-22, minutes before a CI run, and every leg went red on `npm install`.
  // Bumping these is deliberate and comes with bumping the dsh family pin: the
  // 0.1.7 line re-pinned them again (cordis 4.0.4, include 1.0.9, loader 1.0.5,
  // timer 1.1.6, plus the launcher-only cordis-plugin-group 1.0.4).
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  // Which line this tree is pinned to is a CI matrix decision: `package.json`
  // commits the default line, every other leg rewrites the pins with
  // `scripts/ci-pin-line.mjs` before installing, and the expectation here
  // follows the host that actually landed in node_modules rather than the line
  // this checkout commits. The numbers are the ones that script's table holds,
  // pinned by `tests/ci-pin-line.test.mjs`. The schemastery spec below is
  // line-independent on purpose.
  // One set, because 0.1.5 is no longer a supported line (0.8.0 dropped it):
  // every leg that still runs installs a forms host, and the legacy pins that
  // came with the 0.1.5 family are gone from the table with that line.
  const PINS = {
    '@deepseek-ai/cordis': '4.0.4',
    '@deepseek-ai/cordis-plugin-hmr': '1.0.17',
    '@deepseek-ai/cordis-plugin-include': '1.0.9',
    '@deepseek-ai/cordis-plugin-loader': '1.0.5',
    '@deepseek-ai/cordis-plugin-timer': '1.1.6',
  }
  for (const [name, pinned] of Object.entries(PINS)) {
    assert.equal(
      manifest.devDependencies?.[name] ?? manifest.dependencies?.[name],
      pinned,
      `${name} must stay pinned to what the family pins (host ${HOST_VERSION})`,
    )
  }
  // schemastery is the one root the plugin also *ships* (`dependencies`), so its
  // spec has to admit the copy the host resolved instead of nesting a second
  // one — a schema built by another copy is a different class. It admits exactly
  // the two versions the family lines pin (0.1.5 → 3.18.2, 0.1.7 → ~3.18.4) and
  // nothing else; a floating range would let a fresh tree pick a version no host
  // ever resolved.
  assert.equal(manifest.dependencies?.['@deepseek-ai/schemastery'], '3.18.2 || ~3.18.4')
  // The four cordis plugins are here for the same reason and are not imported:
  // cordis peers them optionally, so without a root pin npm takes the newest
  // (`include@1.0.9` once resolved on the oldest leg) and that one demands
  // `cordis ~4.0.4`, which the pinned 4.0.2 can never satisfy. The peer ranges
  // stay ranges: consumers resolve cordis from their host.
  assert.equal(manifest.peerDependencies?.['@deepseek-ai/cordis'], '^4.0.1')
})

test('declared dsh range admits every release marked compatible', async () => {
  const semver = (await import('semver')).default
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const range = manifest.dsh?.compatibility?.dsh
  assert.equal(typeof range, 'string')
  // Node-semver only admits a prerelease when a comparator carries the same
  // [major, minor, patch] tuple, so a bare `>=0.1.3-alpha.2` would silently
  // reject 0.1.5-rc.1. Pin the exact semantics pnpm and the store see.
  const inRange = version => semver.satisfies(version, range)
  // The dropped line stays out of the range: this is the assertion that would
  // catch a stray `>=0.1.2-rc.1` comparator creeping back into the manifest.
  assert.equal(inRange('0.1.1-rc.2'), false)
  assert.equal(inRange('0.1.2-rc.1'), false)
  assert.equal(inRange('0.1.3-alpha.1'), false)
  assert.equal(inRange('0.1.3-alpha.2'), false)
  // The whole 0.1.5 line is out: 0.8.0 dropped it, so no comparator may admit
  // it again — including the final 0.1.5 release.
  assert.equal(inRange('0.1.5-alpha.1'), false)
  assert.equal(inRange('0.1.5-alpha.2'), false)
  assert.equal(inRange('0.1.5-rc.1'), false)
  assert.equal(inRange('0.1.5-rc.2'), false)
  assert.equal(inRange('0.1.5-rc.3'), false)
  assert.equal(inRange('0.1.5'), false)
  // Both verified lines are in, and the window stops at each line's end.
  assert.equal(inRange('0.1.7-rc.1'), true)
  assert.equal(inRange('0.1.7-rc.2'), true)
  assert.equal(inRange('0.1.8'), false)
  assert.equal(inRange('0.1.9'), false)
  assert.equal(inRange('0.2.0-rc.1'), true)
  assert.equal(inRange('0.2.0'), true)
  assert.equal(inRange('0.2.1'), false)
  // The 0.1.6/0.1.7 alphas are published; the range deliberately does not
  // admit them. A prerelease only satisfies a comparator set when a comparator
  // with the *same* [major, minor, patch] tuple carries one, so these stay out
  // until a 0.1.6 rc has been run and declared — refusing an untested line beats
  // silently claiming it.
  assert.equal(inRange('0.1.6-alpha.1'), false)
  assert.equal(inRange('0.1.6-alpha.2'), false)
  assert.equal(inRange('0.1.6'), false)
  assert.equal(inRange('0.1.7-alpha.1'), false)
  assert.equal(semver.maxSatisfying(['0.1.7-rc.2', '0.2.0-rc.1'], range), '0.2.0-rc.1')
  // Every release the manifest calls compatible must actually satisfy the range.
  for (const [version, status] of Object.entries(manifest.dsh.compatibility.dshReleases)) {
    if (status !== 'compatible') continue
    assert.equal(inRange(version), true, `${version} is marked compatible but outside ${range}`)
  }
  // Every dsh peer declares both supported lines in one window. The plural
  // `dsh-agent-presets` used to be here for the 0.1.5 line; it has no release
  // past 0.1.6-alpha.2, and 0.8.0 dropped that line, so the declaration is gone
  // with it — a peer range nothing can satisfy would veto the plugin instead.
  //
  // One comparator per prerelease tuple: node-semver only lets a prerelease
  // satisfy a comparator set when a comparator with the *same* [major, minor,
  // patch] tuple also carries a prerelease, so `>=0.1.7-rc.1 <0.1.8` alone
  // would reject every 0.2.0-rc.
  const SUPPORTED = '>=0.1.7-rc.1 <0.1.8 || >=0.2.0-rc.1 <0.2.1'
  const dshPeers = Object.entries(manifest.peerDependencies ?? {})
    .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  assert.ok(dshPeers.length > 0)
  for (const [name, peerRange] of dshPeers) {
    assert.equal(peerRange, SUPPORTED, `${name} must accept both supported hosts (host ${HOST_VERSION})`)
  }
  // The two preset packages are optional: a host that composes presets
  // process-wide has no such service, and a required peer npm cannot satisfy is
  // an install failure rather than a fallback.
  for (const name of ['@deepseek-ai/dsh-agent-preset', '@deepseek-ai/dsh-agent-preset-registry']) {
    assert.ok(dshPeers.some(([peer]) => peer === name), `${name} must stay declared`)
    assert.equal(manifest.peerDependenciesMeta?.[name]?.optional, true, `${name} must be optional`)
  }
  // The dropped line's package is declared nowhere at all any more — neither as
  // a peer nor in the optional list next to it.
  assert.equal(manifest.peerDependencies?.['@deepseek-ai/dsh-agent-presets'], undefined)
  assert.equal(manifest.peerDependenciesMeta?.['@deepseek-ai/dsh-agent-presets'], undefined)
})
