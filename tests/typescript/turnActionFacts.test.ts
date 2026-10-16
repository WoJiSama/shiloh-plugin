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
  assert.match(buildTurnActionFactsPrompt(actual), /已核验该任务当前没有仍有效的后续投递登记/)
})

test('a failed delivery prompt states the observed failure without inventing rejection or interception', () => {
  const actual = validateTurnActionFacts(facts([task({delivery:{state:'failed'}})]), event, now)
  const prompt = buildTurnActionFactsPrompt(actual)
  assert.equal(prompt.split('\n').find(line=>line.startsWith('原请求 ')), '原请求 request（任务类型：图片处理）：执行已结束；已有产物；投递失败，具体原因未确认。')
  assert.match(prompt, /投递失败只说明这次发送未成功，不证明接收者拒收、系统拦截、屏蔽或接收设置等具体原因/)
  assert.match(prompt, /没有原因证据时，不自行补写失败原因/)
  assert.doesNotMatch(prompt, /投递被明确拒绝|有消息回执确认送达|回执消息/)
  assert.match(prompt, /已核验该任务当前没有仍有效的后续投递登记/)
})

test('missing records and registrations describe this lookup rather than system capability', () => {
  const prompt = buildTurnActionFactsPrompt({scope:{botId:'99',conversationId:'group:1',userId:'2'},observedAt:now,lookup:'unavailable',tasks:[]})
  assert.match(prompt,/未查到记录不代表任务没有在执行/)
  assert.match(prompt,/这次未核验到有效后续登记，只限制本次自动跟进/)
  assert.match(prompt,/不能据此说系统没有这个功能/)
})

test('a verified sent receipt remains delivery evidence rather than an unknown failure cause', () => {
  const actual = validateTurnActionFacts(facts([task({delivery:{state:'sent',messageId:'receipt'}})]), event, now)
  const prompt = buildTurnActionFactsPrompt(actual)
  assert.equal(prompt.split('\n').find(line=>line.startsWith('原请求 ')), '原请求 request（任务类型：图片处理）：执行已结束；已有产物；有消息回执确认送达（回执消息 receipt）。')
  assert.doesNotMatch(prompt, /投递失败|投递被明确拒绝|投递结果未确认/)
  const withoutReceipt = validateTurnActionFacts(facts([task({delivery:{state:'sent'}})]), event, now)
  assert.match(buildTurnActionFactsPrompt(withoutReceipt), /已有产物；投递结果未确认/)
  assert.doesNotMatch(buildTurnActionFactsPrompt(withoutReceipt), /有消息回执确认送达|回执消息/)
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

test('task existence, a usable result and a cancelled callback are projected as independent positive facts',()=>{
 const value=facts([task({source:'live_job',execution:'running',result:'available',delivery:{state:'failed'},followUp:{state:'none'}})])
 const prompt=buildTurnActionFactsPrompt(validateTurnActionFacts(value,event,now))
 assert.match(prompt,/任务存在、执行、产物、投递和后续登记分别成立/)
 assert.match(prompt,/已核验该请求对应的任务记录存在/)
 assert.match(prompt,/记录为执行中；已有产物；投递失败/)
 assert.match(prompt,/已确认有可用产物，这一事实独立于投递状态/)
 assert.match(prompt,/后续发送未登记、已取消或未确认，均不能否定原任务存在/)
 assert.match(prompt,/原任务及其执行状态仍按上面的记录成立/)
})

test('an unknown callback remains unknown rather than being projected as an explicit cancellation',()=>{
 const prompt=buildTurnActionFactsPrompt(facts([task({followUp:{state:'unknown'}})]))
 assert.match(prompt,/后续投递登记尚未确认/)
 assert.doesNotMatch(prompt,/已核验该任务当前没有仍有效的后续投递登记/)
 assert.match(prompt,/未确认不等于没有、失败或未完成/)
 assert.match(prompt,/颜色、背景、版本等限定语，不改变该任务的证据归属/)
})

test('each request identifies its actual task type so a reminder queue cannot become an image job',()=>{
 const reminder=task({taskId:'exam',requestMessageId:'exam-request',source:'reminder',toolName:'reminderTool',execution:'queued',result:'unknown',followUp:{state:'registered',kind:'reminder',id:'r-exam',dueAt:now+60_000}})
 const prompt=buildTurnActionFactsPrompt(facts([reminder,task({requestMessageId:'image-request'})]))
 assert.match(prompt,/原请求 exam-request（任务类型：定时提醒）：已登记排队/)
 assert.match(prompt,/原请求 image-request（任务类型：图片处理）：执行已结束/)
 assert.match(prompt,/这里的登记和排队只属于该提醒，不证明图片处理任务存在、已登记、正在排队或会在完成后发图/)
})
