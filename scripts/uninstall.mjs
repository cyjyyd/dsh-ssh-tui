#!/usr/bin/env node
/**
 * Remove dsh-ssh-tui from a dsh profile.
 *
 * The portable form of `scripts/uninstall.sh`:
 *
 *   node scripts/uninstall.mjs [profile]   # default: tui (or $DSH_TUI_PROFILE)
 *
 * Only the profile's plugin dependency and bundle entry go. Session data stays.
 */
import { run, step, profileFromArgs, resolveDsh, assertDsh } from './cli.mjs'

const USAGE = `usage: node scripts/uninstall.mjs [profile]

  profile   dsh profile to remove the plugin from (default: tui, or $DSH_TUI_PROFILE)`

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return
  }
  const profile = profileFromArgs(args)
  const dsh = assertDsh(resolveDsh())

  step(`removing dsh-ssh-tui from dsh profile '${profile}'`)
  run(dsh.command, [...dsh.prefix, 'plugin', '--profile', profile, 'remove', 'dsh-ssh-tui'], { shell: dsh.shell })

  step('done')
}

main()
