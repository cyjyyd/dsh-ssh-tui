/**
 * Which `@deepseek-ai/dsh` line this checkout is installed against.
 *
 * The 0.1.5 and 0.1.7 hosts differ in ways the tests cannot paper over: 0.1.5
 * reads settings through `settings.get` and mounts a terminal preset *roster*,
 * while 0.1.7 projects a settings form per loader entry and composes the agent
 * process-wide, so a terminal profile mounts three *agent-plane* rows instead.
 * The same source tree is installed on either line (CI rewrites the devDeps
 * before `npm install`), so a test that hardcodes one line's rows, wording, or
 * peer spec fails on the other for a reason that is not a regression.
 *
 * Read the version once, from the host that actually landed in `node_modules`,
 * and branch on that — never on the committed manifest, which is the default
 * line and says nothing about the tree the tests are running in.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isFormsVersion } from '../scripts/host-line.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The exact version of the host resolved into this tree's `node_modules`. */
export const HOST_VERSION = JSON.parse(
  readFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
).version

/**
 * Whether the installed host is a settings-form line (0.1.7 and later).
 *
 * The rule itself lives in `scripts/host-line.mjs` so the test tree, the
 * end-to-end probe and the profile-row writer cannot drift apart: each one
 * decides which rows a terminal profile mounts.
 */
export const FORMS_HOST = isFormsVersion(HOST_VERSION)
