/**
 * Slash-command suggestions: which commands the box offers, in which order, and
 * how the host's commands join them. The rules used to live in `SshTui`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { commandSuggestions, localizedCommands } from '../lib/commands.js'

const foreign = (name, description = 'host command') => ({ name, description, local: false })

test('only a slash-prefixed line suggests commands', () => {
  assert.deepEqual(commandSuggestions('', []), [])
  assert.deepEqual(commandSuggestions('hello', []), [])
  assert.ok(commandSuggestions('/', []).length > 0)
})

test('the bare slash lists this plugin commands, without aliases or dialog-test', () => {
  const names = commandSuggestions('/', []).map(command => command.name)
  assert.equal(names.includes('help'), true)
  assert.equal(names.includes('diag'), true, 'the /diag command is offered')
  assert.equal(names.includes('resume'), false, 'in-app session switching was removed; resume is a launch flag')
  assert.equal(names.includes('exit'), false, 'an alias waits for a typed prefix')
  assert.equal(names.includes('dialog-test'), false, 'a test-only command stays out of the list')
  assert.equal(commandSuggestions('/', []).every(command => command.local), true)
})

test('a typed prefix brings aliases back and filters the list', () => {
  const names = commandSuggestions('/ex', []).map(command => command.name)
  assert.deepEqual(names, ['exit'])
  const usage = commandSuggestions('/usage', []).map(command => command.name)
  assert.equal(usage.includes('usage'), true)
})

test('an alias describes the command it points at', () => {
  const alias = localizedCommands().find(command => command.name === 'exit')
  assert.equal(alias.aliasOf, 'quit')
  assert.equal(alias.description.includes('quit'), true, alias.description)
})

test('a prefix that starts a name ranks it above a name that merely contains it', () => {
  const suggestions = commandSuggestions('/se', [
    foreign('user-settings'),
    foreign('session'),
  ])
  const names = suggestions.map(command => command.name)
  assert.equal(names[0], 'setup', names.join(','))
  assert.equal(names.includes('session'), true, names.join(','))
  assert.equal(names.at(-1), 'user-settings', names.join(','))
})

test("the host's commands follow this plugin's, and a local name wins the duplicate", () => {
  const suggestions = commandSuggestions('/', [foreign('model', 'host model'), foreign('sessions')])
  const model = suggestions.filter(command => command.name === 'model')
  assert.equal(model.length, 1, 'no duplicate rows')
  assert.equal(model[0].local, true, 'the local description wins')
  assert.equal(suggestions.at(-1).name, 'sessions')
  assert.equal(suggestions.at(-1).local, false)
})

test('a host-only command is filtered like a local one', () => {
  const names = commandSuggestions('/sess', [foreign('sessions'), foreign('model')]).map(command => command.name)
  assert.deepEqual(names, ['sessions'])
})

test('a prefix matches whatever case the user typed', () => {
  assert.deepEqual(commandSuggestions('/EXIT', []).map(command => command.name), ['exit'])
  assert.deepEqual(commandSuggestions('/Diag', []).map(command => command.name), ['diag'])
})

test('ranking does not depend on which side of the comparison comes first', () => {
  // 'se-helper' and the local 'setup' start with the prefix; 'x-se-y' only
  // contains it, so it sorts last whatever order the host listed them in. A
  // one-sided comparator would order by input order instead.
  for (const list of [
    [foreign('x-se-y'), foreign('se-helper')],
    [foreign('se-helper'), foreign('x-se-y')],
  ]) {
    const names = commandSuggestions('/se', list).map(command => command.name)
    assert.equal(names.at(-1), 'x-se-y', names.join(','))
    assert.equal(names.includes('se-helper'), true, names.join(','))
    assert.ok(names.indexOf('setup') < names.indexOf('x-se-y'), names.join(','))
  }
})
