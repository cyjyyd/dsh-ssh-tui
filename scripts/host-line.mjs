#!/usr/bin/env node
/**
 * Which generation of `@deepseek-ai/dsh` a version string belongs to.
 *
 * 0.1.7 moved settings from `settings.get`/`installSection` to a form projected
 * per loader entry, and replaced the terminal preset *roster* with a process-wide
 * agent composition. That split is a property of the host release, and everything
 * that has to branch on it — the test helper, the end-to-end probe, the profile
 * row writer — must branch the same way, or one of them keeps talking about a
 * roster the installed host never mounts.
 *
 * The comparison is numeric and open-ended on purpose: `0.2.0-rc.1` is a forms
 * host even though it shares no prefix with `0.1.7`, and a future 0.10/1.0 is one
 * too. Anything below 0.1.7 (0.1.5-rc.3, 0.1.6-alpha.2) is legacy.
 *
 * @module dsh-ssh-tui/host-line
 */

/** The release whose settings/agent seam this file keys on. */
export const FORMS_SINCE = [0, 1, 7]

/**
 * `major.minor.patch` of a version string, ignoring prerelease/build tails.
 *
 * Loosely parsed rather than semver-checked: callers feed it what a registry or
 * a package.json said, and a malformed string must degrade to "legacy" instead
 * of throwing inside a probe.
 * @param version - a version string like `0.2.0-rc.1`.
 * @returns the three leading numbers, missing parts as 0.
 */
export function versionTriple(version) {
  const parts = String(version ?? '').split(/[.\-+]/u).slice(0, 3).map(part => Number.parseInt(part, 10))
  return [0, 1, 2].map(index => (Number.isFinite(parts[index]) ? parts[index] : 0))
}

/**
 * Whether this host has the 0.1.7-and-later seam.
 * @param version - the installed `@deepseek-ai/dsh` version.
 * @returns true for a forms host, false for the legacy (roster) generation.
 */
export function isFormsVersion(version) {
  const triple = versionTriple(version)
  for (let index = 0; index < FORMS_SINCE.length; index += 1) {
    const mine = triple[index] ?? 0
    const want = FORMS_SINCE[index] ?? 0
    if (mine > want) return true
    if (mine < want) return false
  }
  return true
}
