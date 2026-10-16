import {test} from 'node:test'
import assert from 'node:assert/strict'
import {actionFactScope, buildTurnActionFactsPrompt, validateTurnActionFacts} from '../../src/modules/conversation/domain/turnActionFacts.js'
import type {TurnActionFacts, TurnTaskFact} from '../../src/contracts/turnActionFacts.js'

const now = 10_000_000
const event = {self_id: 'bot-a', group_id: 'g', user_id: 'u'}
const task = (change: Partial<TurnTaskFact> = {}): TurnTaskFact => ({
  taskId: 't', requestMessageId: 'request', toolName: 'bananaTool', source: 'task_record', observedAt: now,
  execution: 'completed', result: 'available', delivery: {state: 'unknown'}, followUp: {state: 'none'}, ...change
})
const facts = (tasks = [task()]): TurnActionFacts => ({scope: actionFactScope(event), observedAt: now, lookup: 'ok', tasks})

test('task facts reject another bot, private context, requester, and stale snapshot', () => {
  for (const change of [{botId: 'bot-b'}, {conversationId: 'private:u'}, {userId: 'other'}]) {
    const value = facts(); value.scope = {...value.scope, ...change}
    assert.equal(validateTurnActionFacts(value, event, now).lookup, 'unavailable')
  }
  assert.equal(validateTurnActionFacts({...facts(), observedAt: now - 60_001}, event, now).lookup, 'unavailable')
})

test('facts returned by an optional host must match the explicit request or receipt query',()=>{
 const rows=facts([task({requestMessageId:'old-a',delivery:{state:'unknown'}}),task({requestMessageId:'unrelated-b',delivery:{state:'sent',messageId:'receipt-b'}})])
 assert.deepEqual(validateTurnActionFacts(rows,event,now,{referenceMessageId:'old-a',recentRequestMessageIds:['unrelated-b']}).tasks.map(t=>t.requestMessageId),['old-a'])
 assert.deepEqual(validateTurnActionFacts(rows,event,now,{referenceMessageId:'missing',recentRequestMessageIds:['unrelated-b']}).tasks,[])
 assert.deepEqual(validateTurnActionFacts(rows,event,now,{referenceMessageId:'receipt-b'}).tasks.map(t=>t.requestMessageId),['unrelated-b'])
 assert.deepEqual(validateTurnActionFacts(rows,event,now,{recentRequestMessageIds:['old-a']}).tasks.map(t=>t.requestMessageId),['old-a'])
 assert.deepEqual(validateTurnActionFacts(rows,event,now,{}).tasks,[])
})

test('an available image and completed call do not imply delivery or a future task', () => {
  const actual = validateTurnActionFacts(facts(), event, now)
  assert.equal(actual.tasks[0]?.result, 'available')
  assert.equal(actual.tasks[0]?.delivery.state, 'unknown')
  assert.equal(actual.tasks[0]?.followUp.state, 'none')
  assert.match(buildTurnActionFactsPrompt(actual), /已有产物；投递结果未确认/)
  assert.match(buildTurnActionFactsPrompt(actual), /没有核验到仍有效的后续投递登记/)
})

test('a partial lookup preserves independently verified facts and names the remaining evidence gap',()=>{
 const actual=validateTurnActionFacts({...facts(),lookup:'unavailable'},event,now)
 assert.equal(actual.tasks[0]?.result,'available')
 assert.equal(actual.lookup,'unavailable')
 assert.match(buildTurnActionFactsPrompt(actual),/部分记录未能核验/)
})

test('a reported sent state without an id stays unknown; old running state cannot authorize later delivery', () => {
  const value = facts([task({execution: 'running', observedAt: now - 16 * 60_000, delivery: {state: 'sent'}, source: 'live_job', followUp: {state: 'registered', kind: 'job_completion', id: 'job'}})])
  const actual = validateTurnActionFacts(value, event, now).tasks[0]!
  assert.equal(actual.execution, 'unknown')
  assert.equal(actual.delivery.state, 'unknown')
  assert.equal(actual.followUp.state, 'unknown')
})

test('only future registered reminders can support the corresponding reminder commitment', () => {
  const pending = task({source: 'reminder', execution: 'queued', followUp: {state: 'registered', kind: 'reminder', id: 'r', dueAt: now + 5000}})
  assert.equal(validateTurnActionFacts(facts([pending]), event, now).tasks[0]?.followUp.state, 'registered')
  assert.match(buildTurnActionFactsPrompt(facts([pending])), /只证明该提醒已登记，不证明原图会完成/)
  const expired = {...pending, followUp: {...pending.followUp, dueAt: now - 1}}
  assert.equal(validateTurnActionFacts(facts([expired]), event, now).tasks[0]?.followUp.state, 'unknown')
  assert.equal(validateTurnActionFacts(facts([{...pending, source: 'task_record'}]), event, now).tasks[0]?.followUp.state, 'unknown')
})
