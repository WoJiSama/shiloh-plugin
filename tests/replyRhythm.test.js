import test from 'node:test'
import assert from 'node:assert/strict'
import { planEmojiReplySequence, planTextReplyMessages } from '../utils/replyRhythm.js'

test('keeps ordinary and formal replies in one visible message', () => {
  assert.deepEqual(planTextReplyMessages('这个我知道，直接说就行。').messages, ['这个我知道，直接说就行。'])
  assert.deepEqual(
    planTextReplyMessages('结论如下。\n\n1. 检查配置\n2. 查看日志', { userText: '帮我排查服务器报错' }).messages,
    ['结论如下。\n\n1. 检查配置\n2. 查看日志']
  )
})

test('keeps punctuation and consecutive sentences inside the same message', () => {
  for (const text of ['刚吃完饭回来。外面快热死了。', '哈哈哈。笑死我了。这什么操作。', '真的吗？？我不信。']) {
    assert.deepEqual(planTextReplyMessages(text, { maxTextMessages: 3 }).messages, [text])
  }
})

test('splits only a complete short reaction followed by an independent addendum', () => {
  assert.deepEqual(
    planTextReplyMessages('笑死，这也能撞上。\n\n不过他一直这样找项目，确实挺累的。').messages,
    ['笑死，这也能撞上。', '不过他一直这样找项目，确实挺累的。']
  )
  assert.deepEqual(
    planTextReplyMessages('我觉得主要是，\n\n他还没有想清楚方向。').messages,
    ['我觉得主要是，\n\n他还没有想清楚方向。']
  )
})

test('supports emoji-only, before-text, after-text and rare three-part layouts', () => {
  assert.equal(planEmojiReplySequence({}).layout, 'emoji')
  assert.deepEqual(planEmojiReplySequence({ leadText: '你又来了' }).sequence.map(item => item.type), ['text', 'emoji'])
  assert.deepEqual(planEmojiReplySequence({ followUpText: '不过这次确实有点离谱' }).sequence.map(item => item.type), ['emoji', 'text'])
  assert.deepEqual(planEmojiReplySequence({ leadText: '等一下', followUpText: '你先把前面那句解释清楚' }).sequence.map(item => item.type), ['text', 'emoji', 'text'])
})

test('drops duplicated emoji-side text and respects the visible message budget', () => {
  const duplicate = planEmojiReplySequence({ leadText: '我真的无语了', followUpText: '我真的无语了。' })
  assert.deepEqual(duplicate.sequence.map(item => item.type), ['text', 'emoji'])
  const limited = planEmojiReplySequence({ leadText: '先说一句', followUpText: '再补一句' }, { maxEmojiReplyMessages: 2 })
  assert.deepEqual(limited.sequence.map(item => item.type), ['text', 'emoji'])
})
