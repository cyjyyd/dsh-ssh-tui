import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import {
  errorText, lastSystemText, systemText, tick, waitForDialog, waitForError, waitForLastSystem, waitForText,
} from './wait.mjs'

/**
 * `/preset` drives the same four operations the web client has (list, read,
 * copy, delete) plus the display-metadata edits upstream has no method for.
 * These tests run the command through the real TUI against a fake service and a
 * temporary user root, so the refusals, the confirmation, and the backup are
 * the ones a user gets.
 */
const SYSTEM = {
  id: 'standard',
  trust: 'system',
  path: '/pkg/presets/standard/agent.cordis.yml',
  name: '标准模式',
  description: '功能完整的编码 Agent',
  order: 1,
}

function fixture(overrides = {}) {
  const calls = { copy: [], remove: [] }
  const service = {
    defaultId: 'standard',
    authorable: true,
    roots: [
      { path: '/pkg/presets', trust: 'system' },
      { path: '/home/u/.dsh/.agent-presets', trust: 'user' },
    ],
    list: async () => [SYSTEM, overrides.userPreset ?? {
      id: 'routing-suite',
      trust: 'user',
      path: '/home/u/.dsh/.agent-presets/routing-suite/agent.cordis.yml',
      name: '智能路由模式',
      order: 5,
    }],
    compositionInventory: async () => [
      { id: 'standard', trust: 'system', name: '标准模式', isDefault: true, rows: [
        { entryId: 'persona', moduleName: '@deepseek-ai/dsh-persona', enabled: true },
        { entryId: null, moduleName: '@deepseek-ai/dsh-tool-bash', enabled: true },
        { entryId: 'legacy', moduleName: './legacy.mjs', enabled: false },
      ] },
    ],
    copy: async (from, id, name) => { calls.copy.push({ from, id, name }) },
    remove: async (id) => { calls.remove.push(id) },
    ...overrides.service,
  }
  const ctx = {
    get: name => (name === 'agentPresets' ? (overrides.noService === true ? undefined : service) : undefined),
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  return { tui: new SshTui(ctx, agent, { sessionId: 'main-session', color: false }), calls, service }
}

/**
 * Wait for an async write to land instead of sleeping once.
 *
 * A rename reads the current metadata and writes beside a backup; on a slower
 * runner that chain finishes after a fixed tick, which read the old file and
 * failed a test whose command had actually succeeded.
 */
async function waitForFileText(path, pattern, tui, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const text = await readFile(path, 'utf8').catch(() => '')
    if (pattern.test(text)) return text
    if (Date.now() >= deadline) {
      assert.fail(`timed out waiting for ${pattern} in ${path}; last content:\n${text}\n--- transcript ---\n${systemText(tui)}\n${errorText(tui)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** Wait until the directory holds a backup of the preset metadata. */
async function waitForBackup(directory, tui, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const names = await readdir(directory).catch(() => [])
    if (names.some(name => name.includes('.bak-'))) return names
    if (Date.now() >= deadline) assert.fail(`timed out waiting for a backup in ${directory}: ${names.join(', ')}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
test('the list names every preset with its trust and flags', async () => {
  setLocale('zh')
  const { tui } = fixture()
  tui.runCommand('/preset list')
  await waitForText(tui, 'Agent presets')
  const text = systemText(tui)
  assert.match(text, /Agent presets：2 个 · 默认 standard/u)
  assert.match(text, /standard · 标准模式 · 出厂 · 默认/u)
  assert.match(text, /routing-suite · 智能路由模式 · 用户/u)
  assert.match(text, /可写（用户层：\/home\/u\/\.dsh\/\.agent-presets）/u)
})

test('a read-only deployment says so instead of offering writes', async () => {
  setLocale('zh')
  const { tui } = fixture({ service: { authorable: false } })
  tui.runCommand('/preset list')
  await waitForText(tui, '只读')
  assert.match(systemText(tui), /只读：本部署未配置用户可写的 preset root|只读：本部署未配置用户可写的 preset/u)
})

test('show prints the metadata and the composition rows', async () => {
  setLocale('zh')
  const { tui } = fixture()
  tui.runCommand('/preset show standard')
  await waitForText(tui, '@deepseek-ai/dsh-persona')
  const text = systemText(tui)
  assert.match(text, /preset standard：标准模式/u)
  assert.match(text, /出厂 · order 1/u)
  assert.match(text, /功能完整的编码 Agent/u)
  assert.match(text, /@deepseek-ai\/dsh-persona（id persona）/u)
  assert.match(text, /\/pkg\/presets\/standard/u)
  assert.match(text, /\[已禁用\]/u)
})

test('show reports a broken preset instead of its rows', async () => {
  setLocale('zh')
  const { tui } = fixture({ userPreset: {
    id: 'broken-one', trust: 'user', path: '/home/u/.dsh/.agent-presets/broken-one/agent.cordis.yml',
    broken: 'the composition file agent.cordis.yml is missing',
  } })
  tui.runCommand('/preset show broken-one')
  await waitForText(tui, '不可用：the composition file')
  assert.match(systemText(tui), /不可用：the composition file/u)
})

test('an unknown id lists what is available', async () => {
  setLocale('zh')
  const { tui } = fixture()
  tui.runCommand('/preset show nope')
  await waitForError(tui, '未知的 preset')
  assert.match(errorText(tui), /未知的 preset：nope（可用：standard, routing-suite）/u)
})

test('copy calls the service and points at /mode', async () => {
  setLocale('zh')
  const { tui, calls } = fixture()
  tui.runCommand('/preset copy standard review-only 只读审查')
  await waitForText(tui, '已复制 standard → review-only')
  assert.deepEqual(calls.copy, [{ from: 'standard', id: 'review-only', name: '只读审查' }])
  const text = systemText(tui)
  assert.match(text, /已复制 standard → review-only · 只读审查/u)
  assert.match(text, /切过去：\/mode review-only/u)
})

test('copy refusals never reach the service', async () => {
  setLocale('zh')
  const { tui, calls } = fixture()
  // One token, so the id is what is invalid and "Id" is not read as a name.
  tui.runCommand('/preset copy standard Bad-Id')
  await waitForError(tui, 'id 不合法')
  assert.match(errorText(tui), /id 不合法：Bad-Id/u)
  tui.runCommand('/preset copy standard routing-suite')
  await waitForError(tui, 'id 已被占用')
  assert.match(errorText(tui), /id 已被占用：routing-suite/u)
  tui.runCommand('/preset copy ghost fresh')
  await waitForError(tui, '找不到来源 preset：ghost')
  assert.match(errorText(tui), /找不到来源 preset：ghost/u)
  tui.runCommand('/preset copy')
  await waitForError(tui, '找不到来源 preset')
  assert.match(errorText(tui), /找不到来源 preset/u)
  assert.deepEqual(calls.copy, [], 'a refused plan never calls out')
})

test('a shipped preset is refused by the plan, not by the service error', async () => {
  setLocale('zh')
  const { tui, calls } = fixture()
  tui.runCommand('/preset delete standard')
  await waitForError(tui, '出厂 preset 不能修改或删除')
  assert.match(errorText(tui), /出厂 preset 不能修改或删除：standard/u)
  assert.deepEqual(calls.remove, [])
})

test('delete asks once and only then calls the service', async () => {
  setLocale('zh')
  const home = await mkdtemp(join(tmpdir(), 'dsh-preset-cmd-'))
  try {
    const { tui, calls } = fixture({ userPreset: {
      id: 'mine', trust: 'user', path: join(home, 'mine', 'agent.cordis.yml'), name: '我的预设',
    } })
    tui.runCommand('/preset delete mine')
    await waitForDialog(tui, 'confirm')
    assert.match(String(tui.dialog.prompt), /删除 preset mine/u)
    tui.handleChar('n')
    await waitForText(tui, '已取消，未删除任何内容')
    assert.deepEqual(calls.remove, [], 'cancelling deletes nothing')
    assert.match(systemText(tui), /已取消，未删除任何内容/u)

    tui.runCommand('/preset delete mine')
    await waitForDialog(tui, 'confirm')
    tui.handleChar('y')
    await waitForText(tui, '已删除 preset mine')
    assert.deepEqual(calls.remove, ['mine'])
    assert.match(systemText(tui), /已删除 preset mine/u)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('renaming writes preset.yml beside a backup and keeps the other fields', async () => {
  setLocale('zh')
  const home = await mkdtemp(join(tmpdir(), 'dsh-preset-cmd-'))
  try {
    const directory = join(home, 'mine')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'preset.yml'), 'name: 旧名字\ndescription: 旧描述\norder: 3\n')
    const { tui } = fixture({ userPreset: {
      id: 'mine', trust: 'user', path: join(directory, 'agent.cordis.yml'), name: '旧名字',
    } })

    tui.runCommand('/preset rename mine 只读审查')
    const written = await waitForFileText(join(directory, 'preset.yml'), /name: 只读审查/u, tui)
    assert.match(written, /description: 旧描述/u, 'the description survives a rename')
    assert.match(written, /order: 3/u, 'order survives')
    const backups = (await waitForBackup(directory, tui)).filter(name => name.includes('.bak-'))
    assert.equal(backups.length, 1, 'the previous file is kept')
    // The rows that report the rename land a microtask after the write resolves;
    // wait for them instead of reading the transcript first (this exact race
    // failed the 0.1.5-rc.2 leg).
    await waitForText(tui, '已更新 mine 的名称')
    assert.match(systemText(tui), /已更新 mine 的名称/u)
    assert.match(systemText(tui), /原文件备份/u)

    tui.runCommand('/preset describe mine 新的描述')
    const described = await waitForFileText(join(directory, 'preset.yml'), /description: 新的描述/u, tui)
    assert.match(described, /name: 只读审查/u, 'the name survives a description edit')
    assert.match(described, /description: 新的描述/u)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('renaming without a value, or a shipped preset, is refused', async () => {
  setLocale('zh')
  const { tui } = fixture()
  tui.runCommand('/preset rename routing-suite')
  await waitForError(tui, '需要一个新的值')
  assert.match(errorText(tui), /需要一个新的值/u)
  tui.runCommand('/preset rename standard 新名字')
  await waitForError(tui, '出厂 preset 不能修改或删除')
  assert.match(errorText(tui), /出厂 preset 不能修改或删除：standard/u)
})

test('an older host degrades with a clear message instead of throwing', async () => {
  setLocale('zh')
  const { tui } = fixture({ service: {
    copy: undefined,
    remove: undefined,
    compositionInventory: undefined,
    read: async () => 'rows:\n  - @deepseek-ai/dsh-persona\n',
  } })
  tui.runCommand('/preset copy standard fresh')
  await waitForError(tui, '不支持该操作：copy')
  assert.match(errorText(tui), /不支持该操作：copy/u)
  tui.runCommand('/preset delete routing-suite')
  await waitForError(tui, '不支持该操作：delete')
  assert.match(errorText(tui), /不支持该操作：delete/u)
  tui.runCommand('/preset show standard')
  await waitForText(tui, '@deepseek-ai/dsh-persona')
  const text = systemText(tui)
  assert.match(text, /没有 compositionInventory/u)
  assert.match(text, /@deepseek-ai\/dsh-persona/u, 'the raw document still answers show')
})

test('a profile without the preset service points at /mode fix', async () => {
  setLocale('zh')
  const { tui } = fixture({ noService: true })
  tui.runCommand('/preset list')
  await waitForError(tui, 'agentPresets 服务不可用')
  const text = errorText(tui)
  assert.match(text, /agentPresets 服务不可用/u)
  assert.match(text, /\/mode fix/u)
})

test('an unknown subcommand lists the surface', async () => {
  setLocale('zh')
  const { tui } = fixture()
  tui.runCommand('/preset frobnicate')
  await waitForError(tui, '未知的子命令')
  assert.match(errorText(tui), /未知的子命令：frobnicate（可用：list \/ show \/ copy \/ rename \/ describe \/ delete）/u)
})

/**
 * The wizard: `/preset` with no arguments picks a preset and then an action.
 * It exists because authoring is a multi-step thing — and it must never take a
 * shortcut past the plans, so every case below ends in the same assertions the
 * line commands make.
 */
const pickerLabels = tui => (tui.dialog?.question?.options ?? []).map(option => option.label)

/** Answer a picker or a free-form step by its visible label / typed text. */
function choose(tui, label) {
  const options = pickerLabels(tui)
  const index = options.indexOf(label)
  assert.ok(index >= 0, `no option ${JSON.stringify(label)} in ${JSON.stringify(options)}`)
  tui.handleChar(String(index + 1))
  tui.handleChar('\r')
}

test('the wizard shows a preset and then its composition', async () => {
  setLocale('zh')
  const { tui } = fixture()
  tui.runCommand('/preset')
  await waitForDialog(tui, 'questions')
  assert.deepEqual(pickerLabels(tui), ['standard · 标准模式', 'routing-suite · 智能路由模式'])
  choose(tui, 'standard · 标准模式')
  await waitForDialog(tui, 'questions')
  assert.match(String(tui.dialog?.question?.question ?? ''), /preset standard（标准模式）：要做什么/u)
  choose(tui, '查看组成（有哪些行）')
  await waitForText(tui, '@deepseek-ai/dsh-persona（id persona）')
})

test('the wizard copies after asking for an id and an optional name', async () => {
  setLocale('zh')
  const { tui, calls } = fixture()
  tui.runCommand('/preset')
  await tick()
  choose(tui, 'standard · 标准模式')
  await waitForDialog(tui, 'questions')
  choose(tui, '复制一份（web 端同款创建方式）')
  await waitForDialog(tui, 'questions')
  tui.handleChar('r')
  tui.handleChar('e')
  tui.handleChar('v')
  tui.handleChar('\r')
  await waitForDialog(tui, 'questions')
  assert.match(String(tui.dialog?.question?.question ?? ''), /显示名/u, 'the name step is a free-form question')
  tui.handleChar('只')
  tui.handleChar('读')
  tui.handleChar('\r')
  await waitForText(tui, '已复制 standard → rev')
  assert.deepEqual(calls.copy, [{ from: 'standard', id: 'rev', name: '只读' }])
  assert.match(systemText(tui), /已复制 standard → rev · 只读/u)
})

test('the wizard renames a user preset and refuses a shipped one', async () => {
  setLocale('zh')
  const home = await mkdtemp(join(tmpdir(), 'dsh-preset-wizard-'))
  try {
    const directory = join(home, 'mine')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'preset.yml'), 'name: 旧名字\norder: 4\n')
    const { tui } = fixture({ userPreset: {
      id: 'mine', trust: 'user', path: join(directory, 'agent.cordis.yml'), name: '旧名字',
    } })
    tui.runCommand('/preset')
    await tick()
    choose(tui, 'mine · 旧名字')
    await waitForDialog(tui, 'questions')
    choose(tui, '改显示名')
    await waitForDialog(tui, 'questions')
    tui.handleChar('新')
    tui.handleChar('\r')
    await waitForFileText(join(directory, 'preset.yml'), /name: 新/u, tui)
    // Same race as above: the file can be readable one microtask before the row
    // that announces it.
    await waitForText(tui, '已更新 mine 的名称')
    assert.match(systemText(tui), /已更新 mine 的名称/u)

    // A shipped preset offers no rename/delete action at all.
    tui.runCommand('/preset')
    await tick()
    choose(tui, 'standard · 标准模式')
    await waitForDialog(tui, 'questions')
    const actions = pickerLabels(tui)
    assert.ok(actions.includes('查看组成（有哪些行）'))
    assert.deepEqual(actions.filter(label => /改显示名|改描述|删除/.test(label)), [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the wizard deletes only after the same confirmation', async () => {
  setLocale('zh')
  const home = await mkdtemp(join(tmpdir(), 'dsh-preset-wizard-'))
  try {
    const { tui, calls } = fixture({ userPreset: {
      id: 'mine', trust: 'user', path: join(home, 'mine', 'agent.cordis.yml'), name: '我的',
    } })
    tui.runCommand('/preset')
    await tick()
    choose(tui, 'mine · 我的')
    await waitForDialog(tui, 'questions')
    choose(tui, '删除（仅用户层）')
    await waitForDialog(tui, 'confirm')
    tui.handleChar('y')
    await waitForText(tui, '已删除 preset mine')
    assert.deepEqual(calls.remove, ['mine'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('backing out of the wizard writes nothing', async () => {
  setLocale('zh')
  const { tui, calls } = fixture()
  const lastSystem = () => lastSystemText(tui)
  tui.runCommand('/preset')
  await waitForDialog(tui, 'questions')
  tui.handleChar('\x1b')
  await waitForLastSystem(tui, '已取消，未做任何改动')
  assert.match(lastSystem(), /已取消，未做任何改动/u)
  assert.deepEqual(calls.copy, [])
  assert.deepEqual(calls.remove, [])

  // Cancelling at the free-form step is a cancel too, not a failed command —
  // and not an empty answer the plan then refuses.
  tui.runCommand('/preset')
  await tick()
  choose(tui, 'routing-suite · 智能路由模式')
  await tick()
  choose(tui, '改描述')
  await tick()
  tui.handleChar('\x1b')
  await waitForLastSystem(tui, '已取消，未做任何改动')
  assert.match(lastSystem(), /已取消，未做任何改动/u)
  assert.equal(errorText(tui), '', 'a cancel must not surface as an error')
})

test('a read-only deployment offers no write action in the wizard', async () => {
  setLocale('zh')
  const { tui } = fixture({ service: { authorable: false } })
  tui.runCommand('/preset')
  await tick()
  choose(tui, 'routing-suite · 智能路由模式')
  await waitForDialog(tui, 'questions')
  assert.deepEqual(pickerLabels(tui), ['查看组成（有哪些行）'])
})
