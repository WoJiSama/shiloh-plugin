import test from 'node:test'
import assert from 'node:assert/strict'
import {createChatHistoryTool} from '../dist/backend/modules/qqTools/infrastructure/ChatHistoryTool.js'
import {createMemberInfoTool} from '../dist/backend/modules/qqTools/infrastructure/MemberInfoTool.js'

const History = createChatHistoryTool()
const Member = createMemberInfoTool()
const history = new History()
const record = (id, content, extra = {}) => ({
  message_id: id, event_id: `event-${id}`, group_id: 'group-1',
  sender: {user_id: '123', nickname: '小明'}, content,
  at: Date.parse('2026-10-18T12:00:00+08:00'), time: '2026-10-18 12:00:00', ...extra
})
const event = rows => ({group_id: 'group-1', user_id: '456', message_id: 'current', _chatHistoryMessages: rows})

test('history retrieves original messages by question, user and Beijing calendar range', async () => {
  const result = await history.execute({question: '小明昨天说过预算吗', user_id: '123', start_time: '2026-10-18', end_time: '2026-10-18'}, event([
    record('current', '小明昨天说过预算吗'),
    record('outside-group', '预算是十万', {group_id: 'another-group'}),
    record('outside-day', '预算不能确定', {at: Date.parse('2026-10-17T23:59:59+08:00')}),
    record('other-user', '预算是五万', {sender: {user_id: '456', nickname: '小王'}}),
    record('latest', '预算还没定，明天再确认。', {at: Date.parse('2026-10-18T23:59:59+08:00')}),
    record('first', '预算初步考虑三万。', {at: Date.parse('2026-10-18T00:00:00+08:00')}),
    record('unrelated', '午饭吃面'),
    record('first', '预算初步考虑三万。', {at: Date.parse('2026-10-18T00:00:00+08:00')})
  ]))
  assert.equal(result.status, 'found')
  assert.equal(result.scope.source, 'message_manager')
  assert.equal(result.scope.complete_history, false)
  assert.deepEqual(result.messages.map(row => row.message_id), ['first', 'latest'])
  assert.deepEqual(result.query.terms, ['预算'])
  assert.equal(result.messages[1].content, '预算还没定，明天再确认。')
  assert.equal(result.messages[0].event_id, 'event-first')
  assert.equal(result.messages[0].user_id, '123')
})

test('history distinguishes missing source, empty cache and failed reads without falling back to stale text', async () => {
  assert.equal((await history.func({question: '最近聊什么'}, {})).status, 'unavailable')
  const empty = await history.func({question: '最近聊什么'}, {...event([]), msg: {historyData: '[old] A: stale'}})
  assert.equal(empty.status, 'not_found')
  assert.equal(empty.success, true)
  assert.deepEqual(empty.messages, [])
  const unavailable = await history.func({question: '最近聊什么'}, {...event([record('cached', '旧记录')]), _chatHistoryUnavailable: true})
  assert.equal(unavailable.status, 'unavailable')
  assert.equal(unavailable.success, false)
  assert.deepEqual(unavailable.messages, [])
})

test('a question with no lexical evidence returns not_found and never fabricates an answer', async () => {
  const result = await history.func({question: '之前讨论过数据库连接池吗'}, event([record('a', '今晚一起打游戏'), record('b', '下午三点开会')]))
  assert.equal(result.status, 'not_found')
  assert.equal(result.total_matches, 0)
  assert.match(result.message, /不能据此认定从未/)
  assert.equal('answer' in result, false)
})

test('history requires a resolved person and validates target, dates and bounded limits', async () => {
  const e = event([record('a', '项目已经发布')])
  assert.equal((await history.func({question: '他上次说啥'}, e)).status, 'needs_clarification')
  for (const user_id of ['NaN', '', null, -1, 1.5]) {
    assert.equal((await history.func({question: '他上次说啥', user_id}, e)).status, 'invalid_query')
  }
  for (const parameters of [
    {start_time: '2026-02-30'}, {start_time: '2026-02-30T10:00:00+08:00'}, {start_time: '2026-10-18T10:00:00'},
    {start_time: '2026-10-19', end_time: '2026-10-18'}, {limit: 0}, {limit: 51}, {limit: 1.2}
  ]) assert.equal((await history.func({question: '最近聊什么', ...parameters}, e)).status, 'invalid_query')
  const recalled = await history.func({question: '他上次说啥', user_id: '123'}, e)
  assert.equal(recalled.status, 'found')
  assert.deepEqual(recalled.query.terms, [])
  assert.notEqual((await history.func({question: '之前讨论过其他方案吗'}, e)).status, 'needs_clarification')
})

test('history respects recency limits, excludes tool output and labels forwarded material', async () => {
  const result = await history.func({question: '最近聊什么', limit: 2}, event([
    record('tool', '不要把工具输出当成群友原话', {source: 'tool'}),
    record('new', '转发内容', {source: 'forward', at: Date.parse('2026-10-18T13:00:00+08:00')}),
    record('middle', '机器人回答', {sender: {user_id: '789', nickname: 'Bot', role: 'bot'}}),
    record('old', '较早的记录', {at: Date.parse('2026-10-18T11:00:00+08:00')})
  ]))
  assert.deepEqual(result.messages.map(row => row.message_id), ['middle', 'new'])
  assert.deepEqual(result.messages.map(row => row.origin), ['bot', 'forward'])
  assert.equal(result.total_matches, 3)
  assert.equal(result.truncated, true)
})

test('colloquial recall fillers do not become unrelated search keywords', async () => {
  const e = event([record('a', '这个方案可以继续推进')])
  for (const question of ['刚才我们在讨论啥', '他上次说啥来着', '他最后一次发的消息是什么', '把他昨天的发言找出来']) {
    const result = await history.func({question, user_id: '123'}, e)
    assert.equal(result.status, 'found', question)
    assert.deepEqual(result.query.terms, [], question)
  }
  const proposal = await history.func({question: '他之前提的那个方案', user_id: '123'}, e)
  assert.equal(proposal.status, 'found')
  assert.deepEqual(proposal.query.terms, ['方案'])
})

test('history bounds evidence size and reports clipping instead of claiming complete content', async () => {
  const result = await history.func({question: '最近聊什么', limit: 50}, event(Array.from({length: 30}, (_, i) => record(`long-${i}`, '长内容'.repeat(1000)))))
  assert.equal(result.status, 'found')
  assert.equal(result.total_matches, 30)
  assert.equal(result.truncated, true)
  assert.ok(result.messages.every(row => row.content.length <= 2000))
  assert.ok(result.messages.reduce((sum, row) => sum + row.content.length, 0) <= 16000)
  assert.ok(result.messages.some(row => row.content_truncated))
  assert.ok(result.messages.some(row => row.message_id === 'long-0'), 'newest record survives the evidence character budget')
})

test('legacy history remains evidence with unknown IDs and does not satisfy exact user/time filters', async () => {
  const e = {msg: {historyData: '[new] B: latest\n[old] A: 发送了一张图片'}}
  const result = await history.func({question: '刚才在说什么'}, e)
  assert.equal(result.scope.source, 'legacy_history')
  assert.equal(result.messages[0].message_id, null)
  assert.equal(result.messages[0].origin, 'legacy_history')
  assert.equal(result.summary, 'A: [图片]\nB: latest')
  assert.equal((await history.func({question: '最近聊什么', user_id: '123'}, e)).status, 'not_found')
  assert.equal((await history.func({question: '最近聊什么', start_time: '2026-10-18'}, e)).status, 'not_found')
})

function memberFixture(members) {
  const calls = []
  const bot = {async sendApi(action, params) {
    calls.push({action, params})
    return {status: 'ok', data: action === 'get_group_member_list' ? members : members.find(member => String(member.user_id) === String(params.user_id))}
  }}
  return {calls, bot, e: {group_id: 'group-1', user_id: '999', bot}}
}

test('member lookup prefers an exact match over earlier fuzzy matches', async () => {
  const {e, calls} = memberFixture([{user_id: '1', nickname: '小明同学'}, {user_id: '2', nickname: '小明'}])
  const result = await new Member().func({nickname: '小明'}, e)
  assert.equal(result.success, true)
  assert.equal(result.data.user_id, '2')
  assert.equal(calls.at(-1).params.user_id, '2')
})

test('same-name and fuzzy member ambiguity returns candidates without querying arbitrary details', async () => {
  for (const names of [['小明', '小明'], ['小明同学', '小明老师']]) {
    const {e, calls} = memberFixture(names.map((nickname, i) => ({user_id: String(i + 1), nickname})))
    const result = await new Member().func({nickname: '小明'}, e)
    assert.equal(result.status, 'needs_clarification')
    assert.deepEqual(result.candidates.map(row => row.user_id), ['1', '2'])
    assert.deepEqual(calls.map(call => call.action), ['get_group_member_list'])
  }
})

test('invalid member IDs never fall back to sender or make API calls', async () => {
  const {e, calls} = memberFixture([{user_id: '999', nickname: '本人'}])
  for (const user_id of ['NaN', '', null, 0, -1, 1.5, {}, '1e3']) {
    assert.equal((await new Member().func({user_id}, e)).status, 'invalid_target')
  }
  assert.equal(calls.length, 0)
})

test('live member questions need an explicit target while clear self questions query sender', async () => {
  const {e, calls} = memberFixture([{user_id: '999', nickname: '本人'}])
  assert.equal((await new Member().func({}, {...e, msg: '那哥们是谁来着'})).status, 'needs_clarification')
  assert.equal((await new Member().func({}, {...e, msg: '查一下他的信息'})).status, 'needs_clarification')
  assert.equal(calls.length, 0)
  const result = await new Member().func({}, {...e, msg: '查一下我的资料'})
  assert.equal(result.success, true)
  assert.equal(result.data.user_id, '999')
})

test('member API failures and mismatched identities are not successful evidence', async () => {
  for (const receipt of [{status: 'ok', retcode: 100, data: {user_id: '123'}}, {status: 'ok', data: {user_id: '456'}}]) {
    const result = await new Member().func({user_id: '123'}, {group_id: 'group-1', bot: {sendApi: async () => receipt}})
    assert.equal(result.status, 'unavailable')
    assert.equal(result.success, false)
  }
})
