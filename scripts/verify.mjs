#!/usr/bin/env node
/**
 * Verify the dsh-ssh-tui integration for one profile.
 *
 * The portable form of `scripts/verify.sh`:
 *
 *   node scripts/verify.mjs [profile]    # default: tui (or $DSH_TUI_PROFILE)
 *
 * Three checks, same as the bash script: the composed profile names the plugin,
 * the CLI parses, and the preset roster (or, on 0.1.7, the agent plane) is
 * mounted. The roster check warns instead of failing — a missing roster is
 * repaired from inside the TUI, and the message says how.
 */
import { run, step, profileFromArgs, resolveDsh, assertDsh } from './cli.mjs'

const USAGE = `usage: node scripts/verify.mjs [profile]

  profile   dsh profile to check (default: tui, or $DSH_TUI_PROFILE)`

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return
  }
  const profile = profileFromArgs(args)
  const dsh = assertDsh(resolveDsh())

  step('composed profile contains dsh-ssh-tui')
  const dump = run(dsh.command, [...dsh.prefix, '--profile', profile, '--dump-config'], { shell: dsh.shell }).output
  if (!dump.includes('name: dsh-ssh-tui')) {
    console.error(`error: dsh-ssh-tui is not composed in profile '${profile}'`)
    process.exit(1)
  }
  console.log(`ok: dsh-ssh-tui is composed in profile '${profile}'`)

  step('CLI parses')
  run(dsh.command, [...dsh.prefix, '--profile', profile, '--help'], { shell: dsh.shell })
  console.log(`ok: dsh --profile ${profile} --help`)

  step('composed profile mounts the agent-preset roster')
  // 0.1.7 composes the agent process-wide and has no roster row at all; what it
  // has instead is the config editor, so either marker means /mode can work.
  const forms = dump.includes('- id: config-editor')
  const roster = dump.includes('@deepseek-ai/dsh-agent-presets')
  if (forms || roster) {
    console.log('ok: /mode can list and switch presets')
  } else {
    console.error('warn: no agent-presets row composed, so /mode reports the service missing')
    console.error(`      fix with: node scripts/profile-rows.mjs ${profile}`)
  }

  step('done')
}

main()
