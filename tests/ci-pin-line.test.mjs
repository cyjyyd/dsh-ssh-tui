/**
 * The manifest rewrite that gives every CI leg its own host line.
 *
 * `package.json` commits one line; the others are derived by
 * `scripts/ci-pin-line.mjs` before `npm install`. A mistake here is not a
 * cosmetic one — it is a red leg twenty minutes into a run, or worse, a green
 * leg that installed a mixed family. The rewrite is therefore a pure function
 * and this file pins it:
 *  - the tree's manifest must be exactly what the rewrite produces for the line
 *    it is on, so a hand-edited pin the table does not know is caught;
 *  - a legacy rewrite must undo the default line completely — every family
 *    devDep on one version, the presets package the line actually has, the
 *    family's own root pins, and no `overrides` left over from the default line;
 *  - the declared peer window is never touched: the launcher reads each declared
 *    peer range when it decides whether a plugin may load, so narrowing one for
 *    a leg would veto the plugin on the other line.
 *
 * The suite runs on every leg, so nothing here may assume which line this
 * checkout is on: the leg's own rewrite has already run by the time it does.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_LINE, isFamilyPackage, LINES, pinManifest } from '../scripts/ci-pin-line.mjs'

const REPO = join(import.meta.dirname, '..')
/** This tree's manifest: the committed one on the default leg, the rewrite on others. */
const tree = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
const copy = () => JSON.parse(JSON.stringify(tree))
/** The line this tree is on, read from the manifest rather than assumed. */
const TREE_LINE = tree.devDependencies['@deepseek-ai/dsh']
/** The default line's manifest, whatever line this tree is on. */
const defaultManifest = pinManifest(copy(), DEFAULT_LINE)

const familyDevDeps = manifest => Object.keys(manifest.devDependencies ?? {})
  .filter(isFamilyPackage)

test('the manifest is exactly the rewrite for its own line, whatever line that is', () => {
  assert.ok(LINES[TREE_LINE] !== undefined, `unknown dsh line ${TREE_LINE}`)
  assert.deepEqual(pinManifest(copy(), TREE_LINE), tree)
  // Idempotent: a leg's own rewrite must not drift, which is what makes "the
  // default leg installs the committed manifest unchanged" true.
  assert.deepEqual(pinManifest(pinManifest(copy(), TREE_LINE), TREE_LINE), tree)
  // The default line is the one the guard names; the tree is on it only when CI
  // did not rewrite this checkout.
  assert.equal(typeof DEFAULT_LINE, 'string')
  assert.ok(LINES[DEFAULT_LINE] !== undefined)
})

test('every line moves the whole family at once, and nothing else', () => {
  for (const line of Object.keys(LINES)) {
    const pinned = pinManifest(copy(), line)
    const family = familyDevDeps(pinned)
    assert.ok(family.length > 20, `${line}: the family must be pinned as one block`)
    const exceptions = LINES[line].devPins ?? {}
    // A devDep the line never published keeps a pin of its own (the mock LLM
    // server on 0.1.7-rc.2): everything else in the family moves together.
    assert.ok(Object.keys(exceptions).length <= 1, `${line}: at most one such exception, by hand`)
    for (const name of family) {
      const wanted = exceptions[name] ?? line
      assert.equal(pinned.devDependencies[name], wanted, `${name} must be pinned to ${wanted}`)
    }
    // The CLI itself is in the family: missing it left a leg on a caret
    // prerelease range that resolved through the `latest` tag to another line.
    assert.equal(pinned.devDependencies['@deepseek-ai/dsh'], line)
    // Non-family devDeps are none of this script's business.
    for (const name of ['typescript', 'semver', '@types/node', '@xterm/headless']) {
      assert.equal(pinned.devDependencies[name], tree.devDependencies[name], name)
    }
    assert.deepEqual(pinned.devDependencies, Object.fromEntries(
      Object.entries(pinned.devDependencies).sort(([a], [b]) => (a < b ? -1 : 1)),
    ))
  }
})

test('the family root pins follow the line, including the launcher-only one', () => {
  // These are not imported by the plugin: they are pinned so npm cannot pick a
  // version whose peer range fights the pinned cordis. Both supported lines
  // declare the same set — 0.2.0-rc.1 kept what 0.1.7 pinned, which is why one
  // roots table serves the whole `LINES` entry set now that 0.1.5 is gone.
  const roots = {
    '@deepseek-ai/cordis': '4.0.4',
    '@deepseek-ai/cordis-plugin-include': '1.0.9',
    '@deepseek-ai/cordis-plugin-loader': '1.0.5',
    '@deepseek-ai/cordis-plugin-timer': '1.1.6',
    // dsh-app-boot peers on this one; without it the CLI cannot print its help.
    '@deepseek-ai/cordis-plugin-group': '1.0.4',
  }
  const pinnedRoots = manifest => Object.fromEntries(Object.entries(manifest.devDependencies)
    .filter(([name]) => name.startsWith('@deepseek-ai/cordis'))
    .filter(([name]) => name !== '@deepseek-ai/cordis-plugin-hmr'))
  assert.deepEqual(pinnedRoots(defaultManifest), roots)
  for (const line of Object.keys(LINES)) {
    assert.deepEqual(pinnedRoots(pinManifest(copy(), line)), roots, line)
  }
  // hmr is line-independent and not part of the per-line table.
  assert.equal(defaultManifest.devDependencies['@deepseek-ai/cordis-plugin-hmr'], '1.0.17')
})

test('the default line keeps the override map that holds the family together', async () => {
  const { default: manifest } = await import(join(REPO, 'package.json'), { with: { type: 'json' } })
  const overridden = Object.keys(defaultManifest.overrides ?? {})
  assert.deepEqual(overridden, familyDevDeps(defaultManifest).sort())
  for (const name of overridden) assert.equal(defaultManifest.overrides[name], DEFAULT_LINE)
  // The map is built from the roots this manifest *installs* (devDeps and
  // dependencies) and from family names only. A non-family root dependency is
  // resolved by the host's own copy, and overriding it here is what an
  // EOVERRIDE — npm rejecting an override that contradicts a root spec — would
  // answer for. `schemastery` is exactly that case: the plugin ships it, the
  // host provides it, and it must not be dragged onto the dsh line.
  assert.equal(overridden.includes('@deepseek-ai/schemastery'), false)
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (name.startsWith('@deepseek-ai/dsh')) continue
    assert.equal(overridden.includes(name), false, name)
  }
})

test('the declared peer window is the same on every line', () => {
  // The window covers every verified line at once. If a rewrite narrowed it,
  // the other line's launcher would refuse to load the plugin.
  const peers = manifest => ({
    dsh: manifest.dsh.compatibility.dsh,
    peer: manifest.peerDependencies,
  })
  for (const line of Object.keys(LINES)) {
    assert.deepEqual(peers(pinManifest(copy(), line)), peers(tree), line)
  }
})

test('an unknown line is refused instead of silently leaving the default in place', () => {
  assert.throws(() => pinManifest(copy(), '0.1.6-alpha.1'), /unknown dsh line/u)
  assert.throws(() => pinManifest(copy(), undefined), /unknown dsh line/u)
})
