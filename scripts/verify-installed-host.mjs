#!/usr/bin/env node
/**
 * REL.085-U1: cross-platform evidence of the *installed* upstream host.
 *
 * This deliberately avoids node -e with nested quote characters: PowerShell
 * native command argument passing is different from bash, and an identity
 * probe must report both values before returning nonzero.
 *
 * Read-only. No credentials, model calls, profile writes or version changes.
 */
import { readFileSync } from 'node:fs'

const expected = process.argv[2]
if (typeof expected !== 'string' || !/^\d+\.\d+\.\d+-rc\.\d+$/u.test(expected)) {
  console.error('usage: node scripts/verify-installed-host.mjs <0.x.y-rc.z>')
  process.exit(2)
}

function parse(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
}

try {
  const checkout = parse('../package.json')
  const host = parse('../node_modules/@deepseek-ai/dsh/package.json')
  const pinned = checkout.devDependencies?.['@deepseek-ai/dsh']
  console.log(`requested: ${expected}`)
  console.log(`manifest devDependency: ${String(pinned)}`)
  console.log(`installed host: ${String(host.version)}`)
  const family = Object.entries(checkout.devDependencies ?? {})
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  console.log(`manifest family pins: ${family.length}`)
  const mismatches = family.filter(([name, version]) => {
    // The invariants package is an expressly documented per-line exception.
    if (name === '@deepseek-ai/dsh-invariants') return false
    return version !== expected
  })
  if (pinned !== expected || host.version !== expected || mismatches.length !== 0) {
    for (const [name, version] of mismatches) {
      console.error(`family mismatch: ${name}=${version}, expected ${expected}`)
    }
    console.error('FAIL: installed host or pinned family does not match the requested U1 line')
    process.exit(1)
  }
  console.log('OK: installed host and manifest family identity match')
} catch (error) {
  console.error(`FAIL: host identity probe could not read installed package: ${String(error)}`)
  process.exit(1)
}
