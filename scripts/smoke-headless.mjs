#!/usr/bin/env node
/**
 * Smoke the composed headless (or tui) profile over a live LLM route.
 *
 * The portable form of `scripts/smoke-headless.sh`. Prints an outcome summary
 * only — never tokens, never session logs. The record on disk is redacted the
 * same way: anything shaped like a key is replaced before it is written.
 *
 *   node scripts/smoke-headless.mjs [profile]
 *     profile   default: headless (or $DSH_TUI_SMOKE_PROFILE)
 *
 * Official headless has no --provider flag; the live default in
 * $DSH_HOME/settings.yaml (agent-default-model) is what gets smoked.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { run, step, profileFromArgs, resolveDsh, assertDsh } from './cli.mjs'

const USAGE = `usage: node scripts/smoke-headless.mjs [profile]

  profile   dsh profile to smoke (default: headless, or $DSH_TUI_SMOKE_PROFILE)`

/** Bearer tokens and key prefixes, replaced before anything is written down. */
const SECRET = /sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+|npm_[A-Za-z0-9]+|Bearer [A-Za-z0-9._-]+/gu

function redact(text) {
  return text.replace(SECRET, match => {
    if (match.startsWith('sk-')) return '[redacted-key]'
    if (match.startsWith('ghp_')) return '[redacted-github]'
    if (match.startsWith('npm_')) return '[redacted-npm]'
    return 'Bearer [redacted]'
  })
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return
  }
  const profile = profileFromArgs(args, 'DSH_TUI_SMOKE_PROFILE', 'headless')
  const prompt = process.env.DSH_TUI_SMOKE_PROMPT ?? 'Reply with exactly: tui-install-ok. Do not use tools.'
  const outDir = process.env.DSH_TUI_SMOKE_DIR ?? join(homedir(), '.config', 'dsh-publish', 'smoke')
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z')
  const log = join(outDir, `headless-${stamp}.log`)
  const dsh = assertDsh(resolveDsh())

  mkdirSync(outDir, { recursive: true })
  try { chmodSync(outDir, 0o700) } catch { /* a filesystem that has no modes */ }

  step(`dsh --profile ${profile} (prompt redacted from argv dump)`)
  const result = run(dsh.command, [...dsh.prefix, '--profile', profile, prompt], {
    shell: dsh.shell, allowFailure: true,
  })
  const redacted = redact(result.output)

  const record = [
    `stamp=${stamp}`,
    `profile=${profile}`,
    'provider=settings-default',
    `exit=${result.status}`,
    `prompt=${prompt}`,
    '---- stdout/stderr ----',
    redacted,
  ].join('\n')
  writeFileSync(log, record.endsWith('\n') ? record : `${record}\n`)
  try { chmodSync(log, 0o600) } catch { /* same as the directory */ }

  const last = redacted.split('\n').findLast(line => line.trim() !== '') ?? ''
  console.log(`exit: ${result.status}`)
  console.log(`summary: ${last === '' ? '(empty)' : last}`)
  console.log(`record: ${log}`)
  if (result.status !== 0) {
    console.error('error: headless smoke failed')
    process.exit(result.status)
  }
  if (!redacted.includes('tui-install-ok')) {
    console.error('warn: expected marker tui-install-ok not found in output')
  }
  console.log('ok')
}

main()
