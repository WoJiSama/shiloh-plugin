import {test} from 'node:test'
import assert from 'node:assert/strict'
import {validateActionReply, buildActionReplyFallback} from '../../src/modules/conversation/domain/actionReplyGrounding.js'
import type {TurnActionFacts, TurnTaskFact} from '../../src/contracts/turnActionFacts.js'

const fact = (overrides: Partial<TurnTaskFact> = {}): TurnTaskFact => ({
  taskId: 'job', requestMessageId: 'request', toolName: 'imageEdit', source: 'task_record', observedAt: Date.now(),
  execution: 'unknown', result: 'unknown', delivery: {state: 'unknown'}, followUp: {state: 'none'}, ...overrides
})
const facts = (tasks: TurnTaskFact[] = []): TurnActionFacts => ({scope: {botId: '99', conversationId: 'group:1', userId: '2'}, observedAt: Date.now(), lookup: 'ok', tasks})

test('unknown evidence does not imply not finished, still running, failed or delivered', () => {
  for (const text of ['还没出来欸，这边没收到结果。', '图还在生成，别急。', '刚才那步没跑到结果。', '已经做好了，往上看。', '处理失败了。', '图已经发给你了。']) {
    assert.ok(validateActionReply(text, facts(), '刚才的图出来了吗？').length, text)
  }
  for (const text of ['我这边没看到处理结果，暂时还不能确认。', '是否已经发出，我还没核实。', '不能确认图已经做好了。', '没有证据说明任务还在生成。']) {
    assert.deepEqual(validateActionReply(text, facts()), [], text)
  }
})

test('conditional and direct future commitments require matching live registration', () => {
  for (const text of ['好了我第一时间发你。', '确认到成品我再来找你。', '如果出来了，我会通知你。', '有结果就给你补上。', '稍后我给你重跑。', '明早我提醒你考试。', '提醒已经帮你安排好了。']) {
    assert.ok(validateActionReply(text, facts()).some(item=>item.code === 'unregistered_followup'), text)
  }
  for (const text of ['你回来再问我，我再查。', '“好了再发你”这句话我不能保证。', '我不会稍后给你重跑。', '不能承诺有结果就通知你。', '你发我看看。', '有结果也不代表已经发过了。']) {
    assert.deepEqual(validateActionReply(text, facts()), [], text)
  }
})

test('registration kinds support only their actual action and no promise of automatic rerun', () => {
  const reminder = facts([fact({source: 'reminder', execution: 'queued', followUp: {state: 'registered', kind: 'reminder', id: 'r', dueAt: Date.now() + 60_000}})])
  const live = facts([fact({source: 'live_job', execution: 'running', followUp: {state: 'registered', kind: 'job_completion', id: 'l'}})])
  assert.deepEqual(validateActionReply('明早我提醒你考试。', reminder), [])
  assert.ok(validateActionReply('好了我第一时间发你。', reminder).length)
  assert.deepEqual(validateActionReply('好了我第一时间发你。', live), [])
  assert.ok(validateActionReply('明早我提醒你考试。', live).length)
  assert.ok(validateActionReply('稍后我给你重跑。', live).length, 'completion callback is not a scheduled rerun')
  assert.ok(validateActionReply('好了我第一时间发你。', facts([fact({execution:'failed',followUp:{state:'unknown'}})])).length)
})

test('available artifact, execution and receipt remain separate evidence dimensions', () => {
  const available = facts([fact({execution: 'completed', result: 'available', delivery: {state: 'failed'}})])
  assert.deepEqual(validateActionReply('图已经做好了，发送没有成功。', available), [])
  assert.ok(validateActionReply('图已经发给你了。', available).some(item=>item.code==='unsupported_delivery'))
  const sent = facts([fact({execution:'completed',result:'available',delivery:{state:'sent',messageId:'receipt'}})])
  assert.deepEqual(validateActionReply('图已经做好了，刚才已经发给你了。', sent), [])
  assert.ok(validateActionReply('还没出来。', sent).length)
  assert.match(buildActionReplyFallback(available), /已有可用结果.*发送没有成功/u)
  assert.match(buildActionReplyFallback(facts()), /不能确认/u)
})

test('an empty task envelope does not turn human activity or computer operation into task status', () => {
  for (const raw of ['', '刚才的图出来了吗？']) {
    for (const text of [
      '我妈还没出来，我在门口等她。', 'CPU正在处理指令。', '姐姐已经做好了饭。',
      '我妹妹的图已经画好了。', '她的报告已经完成了。', '服务器正在运行。',
      '图里的人还没出来，我在等下一集。', '我已经做好了饭。'
    ]) assert.deepEqual(validateActionReply(text, facts(), raw), [], `${raw}: ${text}`)
  }
})

test('implicit progress needs current task words or a real artifact task, not a reminder or a quotation', () => {
  const reminder = facts([fact({source: 'reminder', execution: 'queued', followUp: {state:'registered',kind:'reminder',id:'exam',dueAt:Date.now()+60_000}})])
  for (const text of ['还没出来。', '已经做好了。', '刚才已经发给你了。']) {
    assert.deepEqual(validateActionReply(text, facts()), [], text)
    assert.deepEqual(validateActionReply(text, reminder, '明天提醒我考试。'), [], text)
    assert.deepEqual(validateActionReply(text, facts(), '“刚才的图出来了吗”这句话怎么理解？'), [], text)
    assert.ok(validateActionReply(text, facts(), '刚才的图出来了吗？').length, text)
    assert.ok(validateActionReply(text, facts([fact()])).length, text)
  }
})

test('negation, uncertainty, questions and wording examples preserve their ordinary meaning', () => {
  for (const text of [
    '图不是还没出来，是我这边没有回执。', '不是图还没出来，而是发送情况未确认。',
    '图还没出来吗？', '图片已经做好了吗？', '图已经发给你了没有？',
    '图是不是还在生成？', '图可能还在生成，我还需要核实。',
    '“图还没出来”这句话不能直接使用。', '例如：图已经做好了。',
    '不要说图已经发给你了。', '你问图还没出来吗，我现在还无法确认。',
    '```text\n图已经完成了\n```', '我不会在完成后自动把图片发到群里。',
    '不能承诺图好了，我会发给你。', '图好了也不代表我会自动发给你。',
    '图好了我会提醒你吗？', '图好了我会提醒你吗', '图好了，我会提醒你吗？',
    '图好了，我不会通知你。', '例如图好了我会提醒你。', '你回来再问我，我再查。',
    '这就给你解释。', '我现在给你解释一下。', '我会告诉你答案，先看题目。',
    '你把图发给我，我再帮你看看。', '‘图已经好了’是示例。', "'图已经好了'是示例。"
  ]) assert.deepEqual(validateActionReply(text, facts(), '图出来了吗？'), [], text)
})

test('completion-triggered notification cannot be proved by a timed exam reminder', () => {
  const reminder = facts([fact({source:'reminder',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'exam',dueAt:Date.now()+60_000}})])
  const live = facts([fact({source:'live_job',execution:'running',followUp:{state:'registered',kind:'job_completion',id:'image-callback'}})])
  for (const text of [
    '图好了我会提醒你。', '好了我会自动发图给你。', '图一出就发给你。',
    '我会在完成后自动把图片发到群里。', '等图片生成好了，我就通知你。',
    '成品一出来就给你补上。', '结果到了我会发到这里。', '等有结果了，我会再来找你。',
    '图出来就发你。', '图好我就发给你。', '生成完我就通知你。', '结果一到我就提醒你。',
    '图好了，第一时间给你补发。', '图好了，我会提醒你。', '等图出了之后，我稍后提醒你。'
  ]) {
    assert.ok(validateActionReply(text, facts()).some(item => item.code === 'unregistered_followup'), text)
    assert.ok(validateActionReply(text, reminder).some(item => item.code === 'unregistered_followup'), text)
    assert.deepEqual(validateActionReply(text, live), [], text)
  }
})

test('a quoted, denied or user-triggered promise cannot license a separate automatic promise', () => {
  for (const text of [
    '“好了发给你”不能保证；图一出来我会发给你。',
    '我不会重跑，但我稍后会查进度。',
    '你回来再问我，我再查，图好了我会主动发给你。',
    '姐姐还没回来，我会在图好后发给你。',
    '还没收到结果，不确定多久，图好了我会发给你。'
  ]) assert.ok(validateActionReply(text, facts()).some(item => item.code === 'unregistered_followup'), text)
})

test('execution, queuing, artifact availability and delivered receipts cannot substitute for one another', () => {
  const queued = facts([fact({execution:'queued'})])
  const completed = facts([fact({execution:'completed'})])
  assert.deepEqual(validateActionReply('任务还在排队。', queued), [])
  assert.ok(validateActionReply('图正在生成。', queued).length)
  assert.deepEqual(validateActionReply('任务已经完成了。', completed), [])
  assert.ok(validateActionReply('图已经做好了。', completed).length)
  assert.ok(validateActionReply('图已经发给你了。', completed).some(item => item.code === 'unsupported_delivery'))
  assert.ok(validateActionReply('图生成失败了。', completed).some(item => item.code === 'unsupported_task_state'))
  const sent = facts([fact({execution:'completed',result:'available',delivery:{state:'sent',messageId:'receipt'}})])
  assert.deepEqual(validateActionReply('图好了，刚才已经发给你了。', sent), [])
  assert.deepEqual(validateActionReply('图已经做好了，我现在发给你。', facts([fact({execution:'completed',result:'available'})])), [])
  assert.ok(validateActionReply('我刚才给你发过了。', facts(), '刚才的图发了吗？').some(item => item.code === 'unsupported_delivery'))
})

test('denied automatic arrangements remain denials without exempting a later independent promise', () => {
  for (const text of [
    '我还没核实到进度，这里也没有有效的自动补发安排。',
    '这里没有任何有效的自动补发安排。', '没有可用的后续补发安排。',
    '我没有帮你安排提醒。', '提醒没有安排好。', '没有已经登记的自动补发任务。',
    '图好了，我也没有有效的自动补发安排。'
  ]) assert.deepEqual(validateActionReply(text, facts(), '刚才改背景的图出来了吗？'), [], text)
  for (const text of [
    '这里没有有效的自动补发安排，但图好了我会主动发给你。',
    '我没有帮你安排提醒，但明早我会提醒你考试。',
    '没有有效的自动补发安排，提醒已经帮你安排好了。',
    '我还没核实到进度，这里没有自动补发安排；等我确认了有图再发你。'
  ]) assert.ok(validateActionReply(text, facts()).some(item => item.code === 'unregistered_followup'), text)
})

test('observed completion variants stay distinct from missing-output evidence', () => {
  for (const text of [
    '还没出来欸，我这边没拿到处理结果，先不瞎说。等我确认了有图再发你。',
    '还没出来欸，我这边没拿到处理结果，不敢瞎说。等真有图了再发你，别急哈。'
  ]) assert.ok(validateActionReply(text, facts(), '刚才的图出来了吗？').some(item => item.code === 'unregistered_followup'), text)
  assert.ok(validateActionReply('第一张我这边没跑出来，现在也没查到有在处理中的任务。', facts(), '第一张图出来了吗？').some(item => item.code === 'unsupported_task_state'))
  assert.deepEqual(validateActionReply('第一张我这边没跑出来。', facts(), '姐姐拍照怎么样？'), [])
})

test('image state cannot borrow reminder execution, artifacts or delivery receipts', () => {
  for (const execution of ['queued', 'running', 'completed', 'failed'] as const) {
    const reminder = facts([fact({source:'reminder',execution,result:'available',delivery:{state:'sent',messageId:'exam-receipt'}})])
    for (const text of ['图还在排队。', '图正在生成。', '图已经做好了。', '图生成失败了。', '图已经发给你了。']) {
      assert.ok(validateActionReply(text, reminder, '刚才的图出来了吗？').length, `${execution}: ${text}`)
    }
  }
})

test('fallback and state checks select a unique artifact kind instead of the first unrelated record', () => {
  const reminder = fact({taskId:'exam',source:'reminder',toolName:'reminderTool',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'r',dueAt:Date.now()+60_000}})
  const image = fact({taskId:'image',execution:'completed',result:'available',delivery:{state:'failed'}})
  const video = fact({taskId:'video',toolName:'videoTool',execution:'running'})
  assert.match(buildActionReplyFallback(facts([reminder]), '刚才的图出来了吗？'), /不能确认/u)
  assert.doesNotMatch(buildActionReplyFallback(facts([reminder]), '刚才的图出来了吗？'), /排队|提醒安排/u)
  assert.match(buildActionReplyFallback(facts([reminder,image,video]), '刚才的图出来了吗？'), /已有可用结果.*发送没有成功/u)
  assert.match(buildActionReplyFallback(facts([reminder,image,video]), '视频生成进度怎么样？'), /正在处理/u)
  assert.match(buildActionReplyFallback(facts([reminder,image]), '明早考试提醒设好了吗？'), /提醒安排/u)
  for (const list of [[image,{...image,taskId:'image-2'}], [image,video]]) {
    assert.match(buildActionReplyFallback(facts(list)), /不能确认/u)
    assert.ok(validateActionReply('已经做好了。', facts(list), '处理结果怎么样？').length)
  }
  assert.ok(validateActionReply('图已经做好了。', facts([video]), '图出来了吗？').length)
})

test('completion promises require the matching artifact callback and a unique task', () => {
  const video = fact({taskId:'video', toolName:'videoTool', source:'live_job', execution:'running', followUp:{state:'registered',kind:'job_completion',id:'video-callback'}})
  const image = fact({taskId:'image', source:'live_job', execution:'running', followUp:{state:'registered',kind:'job_completion',id:'image-callback'}})
  for (const text of ['图好了我会发给你。', '图好了我会提醒你。', '好了我第一时间发你。']) {
    for (const list of [[video], [video,fact()], [image,{...image,taskId:'other-image'}]]) {
      assert.ok(validateActionReply(text, facts(list), '刚才那张图出来了吗？').some(item=>item.code==='unregistered_followup'), text)
    }
    assert.deepEqual(validateActionReply(text, facts([image,video]), '刚才那张图出来了吗？'), [], text)
  }
})
