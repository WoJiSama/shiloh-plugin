import test from 'node:test'
import assert from 'node:assert/strict'
import { MentionMembersTool } from '../functions/functions_tools/MentionMembersTool.js'

function event() {
  const sent = []
  return {
    group_id: 100,
    group: {
      async getMemberMap() {
        return new Map([
          [2, { user_id: 2, card: '甲' }],
          [3, { user_id: 3, nickname: '乙' }]
        ])
      },
      async sendMsg(segments) { sent.push(segments); return {message_id:sent.length} }
    },
    sent
  }
}

test('mentions exact QQ targets in one native QQ message', async () => {
  const e = event()
  const tool = new MentionMembersTool()
  const result = JSON.parse(await tool.execute({ targets: ['2', '3'], message: '有人要挂团' }, e))
  assert.equal(result.count, 2)
  assert.deepEqual(e.sent[0].filter(segment => segment.type === 'at').map(segment => segment.data.qq), ['2', '3'])
  assert.equal(e.sent[0].at(-1).data.text, '有人要挂团')
})

test('does not guess partial names and reports members that are no longer present in the same message', async () => {
  const e = event()
  const tool = new MentionMembersTool()
  const result = JSON.parse(await tool.execute({ targets: ['甲', '999'], message: '开会' }, e))
  assert.equal(result.count, 1)
  assert.deepEqual(result.skipped, ['999'])
  assert.match(e.sent[0].at(-1).data.text, /未艾特：999/)
})
