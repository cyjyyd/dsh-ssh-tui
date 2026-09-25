#!/usr/bin/env node
/**
 * Install dsh-routing-suite into a dsh profile and materialize its
 * "智能路由模式" preset so the TUI /mode menu can select it.
 *
 * The portable form of `scripts/install-routing-suite.sh`:
 *
 *   node scripts/install-routing-suite.mjs [profile]   # default: tui
 *
 * The suite injects the host `webServer` service for its read-only status API.
 * dsh-base does not provide that service in a terminal profile, so this mounts
 * the in-box loopback web server on an OS-assigned port.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { run, step, profileFromArgs, resolveDsh, assertDsh, dshHome } from './cli.mjs'

const USAGE = `usage: node scripts/install-routing-suite.mjs [profile]

  profile   dsh profile to install into (default: tui, or $DSH_TUI_PROFILE)`

const WEBSERVER_BLOCK = `# dsh-routing-suite injects the host webServer service to expose its
# read-only status API. dsh-base does not provide that service in a terminal
# profile, so mount the in-box loopback webserver on an OS-assigned port.
- insert:
    - id: webserver
      name: '@deepseek-ai/dsh-host-webserver'
      config:
        host: '127.0.0.1'
        port: 0
`

/** Append the loopback web server row unless the patch already names it. */
function mountWebServer(patchFile) {
  if (!existsSync(patchFile)) {
    step(`creating profile patch file at ${patchFile}`)
    mkdirSync(dirname(patchFile), { recursive: true })
    writeFileSync(patchFile, '[]\n')
  }
  const text = readFileSync(patchFile, 'utf8')
  if (/name:\s*'@deepseek-ai\/dsh-host-webserver'/u.test(text)) return
  step('adding loopback webServer service for dsh-routing-suite')
  const next = /^\s*\[\s*\]\s*$/mu.test(text)
    ? text.replace(/^\s*\[\s*\]\s*$/mu, `${WEBSERVER_BLOCK.trimEnd()}\n`)
    : `${text.endsWith('\n') ? text : `${text}\n`}\n${WEBSERVER_BLOCK}`
  writeFileSync(patchFile, next)
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return
  }
  const profile = profileFromArgs(args)
  const home = dshHome()
  const dsh = assertDsh(resolveDsh())

  step(`adding dsh-routing-suite into dsh profile '${profile}'`)
  run(dsh.command, [...dsh.prefix, 'plugin', '--profile', profile, 'add', 'dsh-routing-suite'], { shell: dsh.shell })

  const pkgDir = join(home, 'profiles', profile, 'node_modules', 'dsh-routing-suite')
  const source = join(pkgDir, 'preset', 'routing-suite')
  if (!existsSync(source)) {
    console.error(`error: cannot find dsh-routing-suite preset at ${source}`)
    process.exit(1)
  }
  const dest = join(home, '.agent-presets', 'routing-suite')
  mkdirSync(join(home, '.agent-presets'), { recursive: true })
  rmSync(dest, { recursive: true, force: true })
  cpSync(source, dest, { recursive: true })

  mountWebServer(join(home, 'profiles', profile, 'cordis.patch.yml'))

  step('done')
  console.log(`start with: dsh --profile ${profile}`)
  console.log('then use /mode and select 智能路由模式 (routing-suite)')
}

main()
