#!/usr/bin/env node
/**
 * Re-apply the local pi-ai fix that keeps `reasoning.summary` out of requests.
 *
 * Why this exists: `@earendil-works/pi-ai`'s Responses adapters set
 *
 *     params.reasoning = { effort, summary: options?.reasoningSummary || "auto" }
 *
 * whenever a reasoning effort is configured — so `summary: "auto"` goes out even
 * though nothing asked for a summary. Gateways that validate unknown fields
 * reject it: command-code's Go gateway answers
 * `400 {"code":"InvalidParameter","message":"json: unknown field \"summary\""}`
 * and the turn dies before the model sees it. Sending `summary` only when it was
 * explicitly requested is both closer to the documented API and accepted by the
 * gateways that complain.
 *
 * The fix lives in the installed dependency, so **every family upgrade wipes
 * it** — which is why it is a script instead of a note. Run it after upgrading
 * dsh:
 *
 *     node scripts/patch-pi-ai-summary.mjs            # patch what needs it
 *     node scripts/patch-pi-ai-summary.mjs --check    # exit 1 if anything is unpatched
 *
 * Each file it touches gets a one-time `<file>.bak` copy (the pristine upstream
 * text), so the change stays reversible and a second run is a no-op.
 *
 * @module dsh-ssh-tui/patch-pi-ai-summary
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'

/** The two Responses adapters: the provider route decides which one loads. */
const ADAPTERS = ['openai-responses.js', 'azure-openai-responses.js']

/** Upstream's line: `summary` is sent even when nobody asked for it. */
const UNPATCHED = /summary:\s*options\?\.reasoningSummary\s*\|\|\s*"auto",/u
/** The patched line: only an explicitly requested summary is sent. */
const PATCHED = /\.\.\.\(options\?\.reasoningSummary\s*\?\s*\{\s*summary:\s*options\.reasoningSummary\s*\}\s*:\s*\{\}\),/u

/**
 * Rewrite one adapter's source.
 *
 * Pure, so the rewrite is testable without touching an install.
 * @param source - the file's text.
 * @returns the text to write and whether it changed, or a refusal when neither
 *   the upstream nor the patched shape is present (a refactor upstream must be
 *   read rather than silently "already fine").
 */
export function patchSource(source) {
  if (PATCHED.test(source)) return { state: 'patched', text: source }
  const match = UNPATCHED.exec(source)
  if (match === null) return { state: 'unknown', text: source }
  const text = source.replace(UNPATCHED, '...(options?.reasoningSummary ? { summary: options.reasoningSummary } : {}),')
  return { state: 'patched-now', text }
}

/** Where a global or local pi-ai copy may live. */
function candidateDirs() {
  const dirs = []
  const push = value => {
    if (typeof value !== 'string' || value.trim() === '') return
    const resolved = value.endsWith('openai-responses.js') ? dirname(value) : value
    if (!dirs.includes(resolved)) dirs.push(resolved)
  }
  push(process.env.DSH_PI_AI_DIR)
  // The CLI this plugin runs under: resolve the sibling dependency from the
  // package that ships it, wherever that package happens to be installed.
  for (const base of [join(homedir(), '.local', 'lib', 'node_modules'), join(process.cwd(), 'node_modules')]) {
    push(join(base, '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'api'))
  }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    push(join(root, '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'api'))
  } catch {
    // No npm on PATH, or it failed: the two guesses above are enough.
  }
  return dirs
}

/** Every adapter file that exists under the candidate directories. */
function candidateFiles(explicit) {
  if (explicit !== undefined) {
    const path = explicit.endsWith('.js') ? explicit : join(explicit, 'openai-responses.js')
    return existsSync(path) ? [path] : []
  }
  const files = []
  for (const dir of candidateDirs()) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) {
      if (!ADAPTERS.includes(name)) continue
      const path = join(dir, name)
      if (!files.includes(path)) files.push(path)
    }
  }
  return files
}

function main(argv) {
  const check = argv.includes('--check')
  const at = argv.indexOf('--path')
  const explicit = at === -1 ? undefined : argv[at + 1]
  if (at !== -1 && explicit === undefined) {
    process.stderr.write('usage: node scripts/patch-pi-ai-summary.mjs [--check] [--path <dir|file>]\n')
    return 2
  }
  const files = candidateFiles(explicit)
  if (files.length === 0) {
    process.stdout.write('no pi-ai Responses adapter found — nothing to do (pass --path if it lives elsewhere)\n')
    return 0
  }

  let unpatched = 0
  let unknown = 0
  for (const path of files) {
    const source = readFileSync(path, 'utf8')
    const result = patchSource(source)
    if (result.state === 'patched') {
      process.stdout.write(`ok       ${path}\n`)
      continue
    }
    if (result.state === 'unknown') {
      unknown += 1
      process.stdout.write(`SKIPPED  ${path}: neither the upstream nor the patched line was found — read it before trusting it\n`)
      continue
    }
    unpatched += 1
    if (check) {
      process.stdout.write(`NEEDS FIX ${path}\n`)
      continue
    }
    const backup = `${path}.bak`
    if (!existsSync(backup)) copyFileSync(path, backup)
    writeFileSync(path, result.text)
    process.stdout.write(`PATCHED  ${path} (backup: ${backup})\n`)
  }
  if (check && unpatched > 0) {
    process.stdout.write(`\n${unpatched} adapter(s) still send reasoning.summary: run without --check\n`)
    return 1
  }
  if (unknown > 0) {
    process.stdout.write('\nAt least one file could not be judged; upstream changed shape. Re-read it, then update this script.\n')
  }
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main(process.argv.slice(2)))
}
