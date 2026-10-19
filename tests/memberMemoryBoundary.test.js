import test from 'node:test'
import assert from 'node:assert/strict'
import {resolveExplicitMemberTarget, resolveMemberInfoIntent, hasUnresolvedMemberReference, validateMemberQueryTarget} from '../dist/backend/modules/tools/domain/memberMemoryIntent.js'

const memberMap = new Map([
  [123, {user_id: 123, nickname: '小明'}],
  [456, {user_id: 456, nickname: '小王'}],
  [789, {user_id: 789, nickname: '机器人'}]
])
const context = {memberMap, currentUserId: 456, botId: 789}

test('member target uses the unique actual mention and ignores a wake-up mention of the bot', () => {
  const result = validateMemberQueryTarget('他是谁', {user_id: '456'}, {...context, atQq: [789, 123]})
  assert.equal(result.status, 'resolved')
  assert.equal(result.userId, '123')
  assert.equal(resolveExplicitMemberTarget('他是谁', {...context, rawText: '[CQ:at,qq=789] [CQ:at,qq=123]他是谁'}), '123')
})

test('multiple mentions and unavailable explicit targets cannot be reduced to a guessed member', () => {
  for (const atQq of [[123, 456], [123, 999], [999]]) {
    const result = validateMemberQueryTarget('查名片', {user_id: '123'}, {...context, atQq})
    assert.equal(result.status, 'needs_clarification')
    assert.equal(resolveExplicitMemberTarget('查名片', {...context, atQq}), null)
    assert.equal(hasUnresolvedMemberReference('查名片', {...context, atQq}), true)
  }
  assert.equal(validateMemberQueryTarget('查名片', {}, {...context, atQq: ['NaN']}).status, 'invalid_target')
})

test('reply-generated mentions do not override a different body target or create false ambiguity', () => {
  const reply = {...context, atQq: [123, 456], replyTargetUserId: 123, rawText: '[CQ:reply,id=abc][CQ:at,qq=123] 查[CQ:at,qq=456]的资料'}
  assert.equal(resolveExplicitMemberTarget('查小王的资料', reply), '456')
  assert.equal(resolveExplicitMemberTarget('他是谁', {...reply, atQq: [123], rawText: '[CQ:reply,id=abc][CQ:at,qq=123]他是谁'}), '123')
})

test('duplicate names remain ambiguous even when a model supplies a real matching member ID', () => {
  const duplicates = {...context, memberMap: new Map([[123, {user_id: 123, nickname: '小明'}], [456, {user_id: 456, card: '小明'}]])}
  const result = validateMemberQueryTarget('小明是谁', {user_id: '123'}, duplicates)
  assert.equal(result.status, 'needs_clarification')
  assert.deepEqual(result.candidates, ['123', '456'])
  assert.equal(hasUnresolvedMemberReference('小明是谁', duplicates), true)
  assert.equal(resolveMemberInfoIntent('小明是谁', duplicates), null)
})

test('exact longer names take precedence over a contained shorter nickname', () => {
  const longer = {...context, memberMap: new Map([[123, {user_id: 123, nickname: '小明'}], [456, {user_id: 456, nickname: '小明同学'}]])}
  assert.equal(resolveExplicitMemberTarget('小明同学是谁', longer), '456')
  assert.equal(validateMemberQueryTarget('小明和小明同学是谁', {}, longer).status, 'needs_clarification')
})

test('self history questions resolve the sender even while replying to another member', () => {
  for (const text of ['我上次说啥', '我之前说过什么', '我昨天聊过部署吗', '我的资料', '查一下我在群里的资料', '查我名片', '我名字是啥来着']) {
    const result = validateMemberQueryTarget(text, {user_id: '123'}, {...context, replyTargetUserId: 123, atQq: [123]})
    assert.equal(result.status, 'resolved')
    assert.equal(result.userId, '456')
  }
})

test('an unresolved pronoun needs clarification while other/indefinite words keep whole-group scope', () => {
  assert.equal(validateMemberQueryTarget('他上次说啥', {user_id: '123'}, context).status, 'needs_clarification')
  assert.equal(validateMemberQueryTarget('他上次说啥', {}, {...context, replyTargetUserId: 123}).userId, '123')
  assert.equal(validateMemberQueryTarget('刚才这个人的入群时间呢', {}, {...context, replyTargetUserId: 123}).userId, '123')
  for (const text of ['之前讨论过其他方案吗', '他人的资料要怎么处理', '刚才谁聊到吉他的', '群友最近在讨论什么']) {
    assert.equal(validateMemberQueryTarget(text, {}, context).status, 'unspecified', text)
    assert.equal(hasUnresolvedMemberReference(text, context), false, text)
  }
})

test('membership does not authorize a model invented target and malformed IDs do not default to sender', () => {
  assert.equal(validateMemberQueryTarget('最近在聊什么', {user_id: '123'}, context).status, 'needs_clarification')
  for (const user_id of ['NaN', '', null, 0, -1, 1.5, {}]) {
    assert.equal(validateMemberQueryTarget('查一下成员资料', {user_id}, context).status, 'invalid_target')
  }
  assert.equal(validateMemberQueryTarget('QQ999是谁', {user_id: '123'}, context).status, 'needs_clarification')
  assert.equal(validateMemberQueryTarget('QQ123是谁', {user_id: '456'}, context).userId, '123')
})

test('text grounded nickname lookup distinguishes absent roster, missing name and ambiguous partial name', () => {
  assert.deepEqual(validateMemberQueryTarget('小赵是谁', {nickname: '小赵'}), {status: 'lookup_by_name', nickname: '小赵', reason: 'explicit_name_needs_lookup'})
  assert.equal(validateMemberQueryTarget('小赵是谁', {nickname: '小明'}).status, 'needs_clarification')
  assert.equal(validateMemberQueryTarget('小赵是谁', {nickname: '小赵'}, context).status, 'needs_clarification')
  const partials = {...context, memberMap: new Map([[123, {user_id: 123, nickname: '小赵同学'}], [456, {user_id: 456, nickname: '小赵老师'}]])}
  assert.equal(validateMemberQueryTarget('小赵是谁', {nickname: '小赵', user_id: '123'}, partials).status, 'needs_clarification')
})

test('deterministic member query never runs for explicit negation or capability discussion', () => {
  assert.equal(resolveMemberInfoIntent('别查小明的群名片', context), null)
  assert.equal(resolveMemberInfoIntent('是否可以查成员资料', context), null)
  assert.deepEqual(resolveMemberInfoIntent('小明是谁', context), {user_id: '123'})
})
