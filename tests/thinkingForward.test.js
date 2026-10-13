import test from 'node:test'
import assert from 'node:assert/strict'
import { collectThinking, sendThinkingForward } from '../utils/thinkingForward.js'

const enabled = () => true
function fixture() {
  const calls = []
  const e = { group_id: 123, self_id: 456, group: { async makeForwardMsg(nodes) { calls.push(nodes); return { type: 'forward' } } } }
  const host = { config: {}, async sendObservedReply(...args) { calls.push(args); return { message_id: 1 } } }
  return { e, host, calls }
}
test('only provider reasoning collected; disabled/private/content excluded', () => {
  const session = {}; const { e } = fixture()
  collectThinking(session, { content: 'normal reply' }, e, enabled)
  collectThinking(session, { reasoning_content: 'secret' }, e, () => false)
  collectThinking(session, { reasoning_content: 'private' }, {}, enabled)
  assert.equal(session.thinkingChunks, undefined)
})
test('tool rounds merged once without modifying final message', async () => {
  const session = {}; const { e, host, calls } = fixture()
  const message = { content: 'answer', reasoning_content: 'first round' }
  collectThinking(session, message, e, enabled)
  collectThinking(session, { reasoning_content: 'tool followup' }, e, enabled)
  await sendThinkingForward(host, e, session, enabled)
  await sendThinkingForward(host, e, session, enabled)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].length, 3)
  assert.match(calls[0][2].message, /tool followup/)
  assert.equal(message.content, 'answer')
  assert.equal(session.thinkingChunks, undefined)
})
test('disable during a turn discards captured reasoning', async () => {
  const session = {}; const { e, host, calls } = fixture()
  collectThinking(session, { reasoning_content: 'hidden' }, e, enabled)
  await sendThinkingForward(host, e, session, () => false)
  assert.equal(calls.length, 0)
  assert.equal(session.thinkingChunks, undefined)
})
test('forward failure does not throw or fall back to plain reasoning', async () => {
  const session = {}; const { e, host, calls } = fixture()
  e.group.makeForwardMsg = async () => { throw new Error('adapter down') }
  collectThinking(session, { reasoning_content: 'hidden' }, e, enabled)
  assert.equal(await sendThinkingForward(host, e, session, enabled), null)
  assert.equal(calls.length, 0)
})
test('reasoning is bounded and output forbidden words still apply', async () => {
  const session = {}; const { e, host, calls } = fixture()
  collectThinking(session, { reasoning_content: '😀'.repeat(20000) }, e, enabled)
  assert.ok(Array.from(session.thinkingChunks[0]).length < 12100)
  assert.ok(!session.thinkingChunks[0].includes('�'))
  host.config.forbiddenWords = { words: ['😀'] }
  await sendThinkingForward(host, e, session, enabled)
  assert.equal(calls.length, 0)
})
test('adapter without forwards skips send', async () => {
  const session = {}; const { e, host, calls } = fixture()
  collectThinking(session, { reasoning_content: 'hidden' }, e, enabled)
  e.group = {}
  await sendThinkingForward(host, e, session, enabled)
  assert.equal(calls.length, 0)
})
