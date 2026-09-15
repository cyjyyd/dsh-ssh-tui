import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { allText } from './wait.mjs'

/**
 * `/copy error`: the newest failure or diagnostic row, whole.
 *
 * The rows that matter here carry long absolute paths, commands and module ids.
 * Copying the *screen* would either join wrapped lines with newlines or clip
 * them; copying the row's own text is what a bug report needs.
 */
setLocale('zh')

function fixture() {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 's', options: {}, status: 'idle', session: { id: 's', events: [] }, cancel() {} }
  return new SshTui(ctx, agent, { sessionId: 's', color: false, headlessDisplay: true })
}

test('/copy error copies the newest error row, byte for byte', () => {
  const tui = fixture()
  const longPath = `/root/.dsh/profiles/tui/node_modules/@deepseek-ai/${'scope-'.repeat(20)}inner/lib/bin.js`
  tui.rows.push({ kind: 'error', text: `启动失败：找不到 ${longPath}（exit code 3）` })
  tui.rows.push({ kind: 'assistant', text: '我看到了，先修 profile 补丁。' })

  tui.runCommand('/copy error')
  assert.equal(tui.copyYank, `启动失败：找不到 ${longPath}（exit code 3）`, 'the whole line, unwrapped')
  assert.match(allText(tui), /已复制/u)
  assert.match(allText(tui), /最近错误\/诊断/u)
})

test('/copy error prefers a diagnostic report over an older error', () => {
  const tui = fixture()
  tui.rows.push({ kind: 'error', text: '旧的失败' })
  tui.rows.push({ kind: 'diag', text: '判定链：profile 补丁缺 agent-presets 行' })

  tui.runCommand('/copy error')
  assert.equal(tui.copyYank, '判定链：profile 补丁缺 agent-presets 行')
})

test('a boot notice is not a diagnostic: /copy error still finds nothing', () => {
  // The boot notice says "未挂载 agent-presets 名单…" and reads like a
  // diagnostic, but it is not what the user is trying to paste into a report.
  // Matching it by text made `/copy error` copy the banner.
  const tui = fixture()
  tui.rows.push({ kind: 'system', text: '未挂载 agent-presets 名单：/mode 无法切换模式。' })
  tui.runCommand('/copy error')
  assert.equal(tui.copyYank, '')
  assert.match(allText(tui), /没有错误或诊断行/u)
})

test('a plain /copy still copies the focused card or the latest reply', () => {
  const tui = fixture()
  tui.rows.push({ kind: 'error', text: '一个错误' })
  tui.rows.push({ kind: 'assistant', text: '最近回复正文' })

  tui.runCommand('/copy')
  assert.equal(tui.copyYank, '最近回复正文', 'the error row must not hijack a plain /copy')
})

test('nothing to copy says so instead of copying an empty string', () => {
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: '只有回复' })
  tui.runCommand('/copy error')
  assert.equal(tui.copyYank, '', 'nothing was copied')
  assert.match(allText(tui), /没有错误或诊断行/u)
})

test('an unknown target prints the usage instead of guessing', () => {
  const tui = fixture()
  tui.rows.push({ kind: 'assistant', text: '正文' })
  tui.runCommand('/copy everything')
  assert.equal(tui.copyYank, '')
  assert.match(allText(tui), /用法：\/copy/u)
})
