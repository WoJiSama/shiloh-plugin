import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConversationContext } from '../../src/adapters/conversationContext.js'

test('group identities isolate bots and group/private namespaces', () => {
  const group = resolveConversationContext({ self_id: 1, user_id: 2, group_id: 3 })!
  const otherBot = resolveConversationContext({ self_id: 4, user_id: 2, group_id: 3 })!
  const privateChat = resolveConversationContext({ self_id: 1, user_id: 3 })!
  assert.equal(new Set([group.conversationId, otherBot.conversationId, privateChat.conversationId]).size, 3)
  assert.equal(resolveConversationContext({ self_id: 1, user_id: 8, group_id: 3 })?.conversationId, group.conversationId)
  assert.equal(group.kind, 'group')
})

test('private identities isolate peers and normalize adapter bot fallback', () => {
  const context = resolveConversationContext({ bot: { uin: 1 }, user_id: '002' })!
  assert.deepEqual(context, { kind: 'private', botId: '1', userId: '2', conversationId: '["qq","1","private","2"]' })
  assert.notEqual(context.conversationId, resolveConversationContext({ self_id: 1, user_id: 3 })?.conversationId)
})

test('invalid inputs fail closed without throwing or inventing group identity', () => {
  for (const input of [null, 1, {}, { self_id: 1 }, { self_id: 0, user_id: 2 }, { self_id: 1, user_id: NaN }, { self_id: 1, user_id: 2, message_type: 'group' }, { self_id: 1, user_id: 2, group_id: 'bad' }]) {
    assert.equal(resolveConversationContext(input), null)
  }
})

test('context is JSON serializable and contains no event, cancellation, or callable state', () => {
  const event = { self_id: 1, user_id: 2, group_id: 3, reply() {}, signal: new AbortController().signal }
  const context = resolveConversationContext(event)
  assert.deepEqual(JSON.parse(JSON.stringify(context)), context)
  assert.deepEqual(Object.keys(context!).sort(), ['botId', 'conversationId', 'groupId', 'kind', 'userId'])
})
