#!/usr/bin/env node
/**
 * Install dsh-ssh-tui from the npm registry into a dsh profile.
 *
 * The portable form of `scripts/install-npm.sh`:
 *
 *   node scripts/install-npm.mjs [profile]   # default: tui (or $DSH_TUI_PROFILE)
 *
 * The published package cannot mount the roster from its own bundle patch (DSH
 * STORE takes additive, plugin-owned rows only), so a checkout follows up by
 * mounting it. An npm install of *this* package does not ship `scripts/`, which
 * is why the note below points at the patch file instead.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { run, step, profileFromArgs, resolveDsh, assertDsh, dshHome, REPO } from './cli.mjs'

const USAGE = `usage: node scripts/install-npm.mjs [profile]

  profile   dsh profile to install into (default: tui, or $DSH_TUI_PROFILE)`

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return
  }
  const profile = profileFromArgs(args)
  const dsh = assertDsh(resolveDsh())

  step(`adding dsh-ssh-tui from npm into dsh profile '${profile}'`)
  run(dsh.command, [...dsh.prefix, 'plugin', '--profile', profile, 'add', 'dsh-ssh-tui@latest'], { shell: dsh.shell })

  const roster = join(REPO, 'scripts', 'profile-rows.mjs')
  if (existsSync(roster)) {
    step('mounting the agent-preset roster /mode needs')
    run(process.execPath, [roster, profile])
  } else {
    const patch = join(dshHome(), 'profiles', profile, 'cordis.patch.yml')
    console.log(`note: add the agent-presets row to ${patch} if /mode reports it missing`)
  }

  step('done')
  console.log(`start with:     dsh --profile ${profile}`)
  console.log(`verify with:    node scripts/verify.mjs ${profile}`)
  console.log(`uninstall with: dsh plugin --profile ${profile} remove dsh-ssh-tui`)
}

main()
