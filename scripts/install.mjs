#!/usr/bin/env node
/**
 * Build dsh-ssh-tui and link it into a dsh profile.
 *
 * The portable form of `scripts/install.sh`. The bash file delegates here, so
 * both spellings install the same way:
 *
 *   node scripts/install.mjs [profile]     # default: tui (or $DSH_TUI_PROFILE)
 *   bash scripts/install.sh  [profile]
 *
 * `npm` is a `.cmd` shim on Windows, so it is the one command here that goes
 * through a shell; `dsh` is resolved to its own entry script first (see
 * `cli.mjs`), and only the bare-name fallback needs one.
 */
import { run, step, profileFromArgs, resolveDsh, assertDsh, REPO } from './cli.mjs'
import { mountProfileRows } from './profile-rows.mjs'

const USAGE = `usage: node scripts/install.mjs [profile]

  profile   dsh profile to link into (default: tui, or $DSH_TUI_PROFILE)

Builds this checkout and links it into the profile, then mounts the preset
roster /mode needs.`

/** `npm` is a `.cmd` on Windows; everywhere else it runs directly. */
function npm(args) {
  run('npm', args, { shell: process.platform === 'win32' })
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return
  }
  const profile = profileFromArgs(args)
  const dsh = assertDsh(resolveDsh())

  step('installing dependencies')
  npm(['install', '--no-audit', '--no-fund'])

  step('building dsh-ssh-tui')
  npm(['run', 'build'])

  step(`linking into dsh profile '${profile}'`)
  run(dsh.command, [...dsh.prefix, 'plugin', '--profile', profile, 'add', `link:${REPO}`], { shell: dsh.shell })

  step('mounting the agent-preset roster /mode needs')
  // Only an entry we resolved ourselves is worth passing on: the bare-name
  // fallback has no script path, and the helper finds the CLI on its own.
  mountProfileRows({ profile, ...(dsh.prefix[0] === undefined ? {} : { cli: dsh.prefix[0] }) })

  step('done')
  console.log(`start with:     dsh --profile ${profile}`)
  console.log(`verify with:    node scripts/verify.mjs ${profile}`)
  console.log(`uninstall with: node scripts/uninstall.mjs ${profile}`)
}

main()
