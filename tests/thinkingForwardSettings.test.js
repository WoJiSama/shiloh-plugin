import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createThinkingForwardSettings, parseThinkingForwardCommand, handleThinkingForwardCommand } from '../utils/thinkingForwardSettings.js'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-forward-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'config', 'thinking-forward.json')
  return { file, store: createThinkingForwardSettings(file) }
}

test('default off; persisted group isolation and live disable across store instances', t => {
  const { file, store } = fixture(t)
  assert.equal(store.isEnabled('100'), false)
  store.setEnabled('100', true)
  assert.equal(store.isEnabled('200'), false)
  const reloaded = createThinkingForwardSettings(file)
  assert.equal(reloaded.isEnabled(100), true)
  reloaded.setEnabled(100, false)
  assert.equal(store.isEnabled(100), false)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['thinking-forward.json', 'thinking-forward.json.bak'])
  assert.equal(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).groups['100'], true)
})

test('corrupt configuration fails closed without overwriting it', t => {
  const { file, store } = fixture(t)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{broken')
  assert.equal(store.isEnabled(100), false)
  assert.throws(() => store.setEnabled(100, true))
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
  assert.throws(() => store.setEnabled('../100', true))
})

test('commands parse exact supported forms', () => {
  for (const text of ['#思考过程开启', '#开启思考过程', '#思考过程 开启']) assert.equal(parseThinkingForwardCommand(text), '开启')
  assert.equal(parseThinkingForwardCommand('#关闭思考过程'), '关闭')
  assert.equal(parseThinkingForwardCommand('#思考过程状态'), '状态')
  assert.equal(parseThinkingForwardCommand('请#思考过程开启'), null)
  assert.equal(parseThinkingForwardCommand('#思考过程开启 200'), null)
})

test('all group commands allow only master or owner, denying admin and member without reading settings', async t => {
  const { store } = fixture(t)
  const replies = []
  const event = { group_id: 100, reply: text => replies.push(text) }
  for (const role of ['admin', 'member', undefined]) {
    for (const action of ['开启', '关闭', '状态']) {
      await handleThinkingForwardCommand({ ...event, msg: `#思考过程${action}`, sender: { role } }, {
        isEnabled() { assert.fail('unauthorized status read') },
        setEnabled() { assert.fail('unauthorized settings mutation') }
      })
      assert.match(replies.at(-1), /仅机器人主人或群主/)
    }
  }
  for (const permission of [{ sender: { role: 'owner' } }, { isMaster: true, sender: { role: 'member' } }]) {
    await handleThinkingForwardCommand({ ...event, ...permission, msg: '#思考过程开启' }, store)
    assert.equal(store.isEnabled(100), true)
    await handleThinkingForwardCommand({ ...event, ...permission, msg: '#思考过程状态' }, store)
    assert.match(replies.at(-1), /已开启/)
    await handleThinkingForwardCommand({ ...event, ...permission, msg: '#思考过程关闭' }, store)
    assert.equal(store.isEnabled(100), false)
  }
  await handleThinkingForwardCommand({ ...event, msg: '#思考过程开启', group_id: undefined, isMaster: true }, store)
  assert.match(replies.at(-1), /请在群里/)
})

test('save failure reports failure without claiming enabled', async () => {
  const replies = []
  await handleThinkingForwardCommand({ msg: '#思考过程开启', group_id: 100, isMaster: true, reply: text => replies.push(text) }, {
    setEnabled() { throw new Error('disk unavailable') }
  })
  assert.match(replies[0], /保存失败/)
})
