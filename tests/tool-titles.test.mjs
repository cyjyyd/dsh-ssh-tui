import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale, t } from '../lib/i18n/index.js'
import { jobAlias } from '../lib/job-label.js'
import { presentToolCall, toolTitle } from '../lib/tool-present.js'

/**
 * Tool cards must never fall back to the raw tool vocabulary: an untranslated
 * `job_output` / `read_image` title is what this file guards. The list below is
 * every model-facing tool name in docs/tool-catalog.md plus `present`.
 */
const CATALOG_TOOLS = [
  'ask_user_question', 'run_code', 'exit_plan_mode',
  'bash', 'pwsh',
  'cordis_define', 'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',
  'cordis_run', 'cordis_stop', 'cordis_undefine',
  'str_replace_editor', 'edit', 'read', 'read_image', 'write',
  'glob', 'grep',
  'terminal_close', 'terminal_list', 'terminal_open', 'terminal_read', 'terminal_send', 'terminal_signal',
  'create_goal', 'get_goal', 'update_goal',
  'schedule_create', 'schedule_delete', 'schedule_list',
  'lsp', 'ralph', 'skill',
  'session_event_read', 'session_event_search', 'session_event_trace', 'session_search', 'session_trace',
  'list_subagent_models', 'subagent', 'subagent_fork',
  'interrupt_agent', 'list_agents', 'send_message',
  'job_kill', 'job_list', 'job_output',
  'followup_task', 'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list',
  'team_task_update', 'wait_agent',
  'todo_write', 'workflow', 'web_fetch', 'web_search',
  'present',
]

test('every catalog tool has a title in both locales', () => {
  // `t()` falls back to zh, so a sentinel detects a key missing from both
  // catalogs; `tests/i18n.test.mjs` owns zh/en parity.
  const MISSING = '\u0000missing'
  for (const locale of ['zh', 'en']) {
    setLocale(locale)
    for (const name of CATALOG_TOOLS) {
      const title = t(`toolTitle.${name}`, undefined, MISSING)
      assert.notEqual(title, MISSING, `${locale}: toolTitle.${name} is missing`)
      assert.ok(title.trim() !== '', `${locale}: toolTitle.${name} is blank`)
    }
  }
  setLocale('zh')
})

test('bash and pwsh both read as the terminal card', () => {
  for (const locale of ['zh', 'en']) {
    setLocale(locale)
    const expected = t('toolTitle.bash')
    assert.equal(toolTitle('pwsh'), expected, `${locale}: bash and pwsh must share a title`)
  }
  setLocale('zh')
  assert.equal(toolTitle('bash'), '终端')
})

test('shell cards use the translated title, not the raw tool name', () => {
  const bash = presentToolCall('bash', '{"command":"ls -la","workdir":"/root"}')
  assert.equal(bash.title, '终端')
  assert.equal(bash.summary, '$ ls -la')
  assert.equal(bash.cwd, '/root')
  assert.equal(presentToolCall('pwsh', '{"command":"Get-ChildItem"}').title, '终端')
})

test('job cards lead with a stable alias instead of the raw job_id field', () => {
  const call = presentToolCall('job_output', '{"job_id":"bash-1"}')
  assert.equal(call.title, '任务输出')
  assert.match(call.summary, /^.+ · #bash-1$/u)
  assert.equal(call.summary.includes('job_id'), false)

  const kill = presentToolCall('job_kill', '{"job_id":"bash-1"}')
  assert.equal(kill.title, '终止任务')
  assert.equal(kill.summary, call.summary)

  // job_list carries no id: the title alone is the card.
  const list = presentToolCall('job_list', '{}')
  assert.equal(list.title, '后台任务')
  assert.equal(list.summary, '')
})

test('a job alias is stable, id-derived, and locale-owned', () => {
  setLocale('zh')
  const zh = jobAlias('bash-1')
  assert.ok(zh !== undefined && zh.length > 0)
  assert.equal(jobAlias('bash-1'), zh)
  assert.equal(jobAlias('  bash-1  '), zh)
  assert.equal(jobAlias(''), undefined)
  assert.notEqual(jobAlias('bash-2'), zh)

  const en = (() => {
    setLocale('en')
    return jobAlias('bash-1')
  })()
  setLocale('zh')
  assert.match(en, /^[a-z]+ [a-z]+$/u)
})

test('present and read_image cards are translated', () => {
  assert.equal(presentToolCall('present', '{"path":"/root/a.md"}').title, '交付文件')
  assert.equal(presentToolCall('read_image', '{"path":"/root/a.png"}').title, '读取图片')
  setLocale('en')
  assert.equal(presentToolCall('present', '{"path":"/root/a.md"}').title, 'deliver files')
  assert.equal(presentToolCall('read_image', '{"path":"/root/a.png"}').title, 'read image')
  setLocale('zh')
})
