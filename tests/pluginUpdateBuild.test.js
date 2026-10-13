import test from 'node:test'
import assert from 'node:assert/strict'
import { explainCompiledPluginUpdate } from '../utils/pluginUpdateBuild.js'

test('compiled release gate does not elevate non-master users', async () => {
  let replies = 0
  const event = { isMaster: false, reply: async () => { replies++ } }
  assert.equal(await explainCompiledPluginUpdate(event), false)
  assert.equal(event.isMaster, false)
  assert.equal(replies, 0)
})

for (const command of ['#bl更新', '#bl强制更新']) {
  test(`${command} reports the build requirement without invoking host update`, async () => {
    globalThis.plugin = class { constructor(options) { this.options = options } }
    const { BlChatUpdate } = await import('../apps/update.js')
    const replies = []
    const event = { isMaster: true, msg: command, reply: async text => replies.push(text) }
    const handler = new BlChatUpdate()
    assert.equal(handler.options.rule[0].permission, 'master')
    assert.equal(await handler.update(event), true)
    assert.equal(event.msg, command)
    assert.equal(replies.length, 1)
    assert.match(replies[0], /scripts\/deploy\.sh/)
    assert.match(replies[0], /未拉取代码、未重启/)
    assert.match(replies[0], /暂不可用/)
  })
}
