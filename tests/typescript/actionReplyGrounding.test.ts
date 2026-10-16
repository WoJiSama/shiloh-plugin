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
  assert.ok(validateActionReply('图已经做好了，我现在发给你。', facts([fact({execution:'completed',result:'available'})])).some(item => item.code === 'unsupported_delivery'))
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

test('news and progress follow-ups require the unique matching completion callback', () => {
  const image = fact({taskId:'image', source:'live_job', execution:'running', followUp:{state:'registered',kind:'job_completion',id:'image-callback'}})
  const video = fact({...image,taskId:'video',toolName:'videoTool',followUp:{state:'registered',kind:'job_completion',id:'video-callback'}})
  const reminder = fact({source:'reminder',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'exam',dueAt:Date.now()+60_000}})
  for (const text of [
    '这个我现在没法确认欸，手头没有实际跑出来的结果。有准信了我直接发你。',
    '有确切消息后我发给你。', '有确切的消息以后我发给你。',
    '有进展再发你。', '有新的进展了我就通知你。', '有新进展我提醒你。'
  ]) {
    for (const list of [[], [reminder], [video], [image,{...image,taskId:'other-image'}]]) {
      assert.ok(validateActionReply(text, facts(list), '刚才那张图出来了吗？').some(item=>item.code==='unregistered_followup'), text)
    }
    assert.deepEqual(validateActionReply(text, facts([image,video]), '刚才那张图出来了吗？'), [], text)
  }
  assert.deepEqual(validateActionReply('有新进展我提醒你。', facts([image])), [])
  assert.ok(validateActionReply('有新进展我提醒你。', facts([reminder])).some(item=>item.code==='unregistered_followup'))
})

test('news follow-up negations, quotations, questions and user-triggered replies remain ordinary speech', () => {
  for (const text of [
    '有准信了你再来问我，我再发你。', '你有准信了再来问我，我再发你。',
    '我不会有准信就发你。', '不能承诺有确切消息就通知你。',
    '“有准信了我直接发你”这句话不能保证。', '例如有进展再发你。',
    '有准信了我就发你吗？', '有进展，我会提醒你吗？'
  ]) assert.deepEqual(validateActionReply(text, facts(), '刚才那张图出来了吗？'), [], text)
})

test('a failed delivery does not prove recipient rejection or closed receiving settings', () => {
  const failedDelivery = facts([fact({execution:'completed',result:'available',delivery:{state:'failed'}})])
  for (const text of [
    '你那边接收把我拦在外面了，把接收打开。',
    '你拒收了图片。', '接收方拒绝接收了文件。',
    '你没开接收，先把接收打开。', '你未开启图片接收。',
    '你把接收关了。', '你那边接收没开。', '你那边接收权限是关闭的。'
  ]) {
    assert.ok(validateActionReply(text, failedDelivery, '刚才那张图怎么没发来？').some(item=>item.code==='unsupported_delivery'), text)
  }
  for (const text of [
    '图已经做好了，发送没有成功，原因还没核实。',
    '可能你没开接收，可以检查一下。', '如果你没开接收，可以检查一下。',
    '不能断定你没开接收。', '我没法确认你没开接收。', '不能归因于你拒收了图片。',
    '不是你拒收了图片，是我这边还没有回执。', '你没开接收吗？', '有没有开接收？',
    '“你没开接收”只是个假设。', '例如你拒收了图片。', '你不接受我的道歉也没关系。'
  ]) assert.deepEqual(validateActionReply(text, failedDelivery, '刚才那张图怎么没发来？'), [], text)
  assert.deepEqual(validateActionReply('你把接收关了，可以先打开试一下。', failedDelivery, '我把接收关了，刚才的图没收到。'), [])
  assert.deepEqual(validateActionReply('你把接收关了，所以可以先打开试一下。', failedDelivery, '我把接收关了，刚才的图没收到。'), [])
  assert.deepEqual(validateActionReply('你把接收关了，所以发送失败了吗？', failedDelivery, '我把接收关了，刚才的图没收到。'), [])
  assert.ok(validateActionReply('因为你把接收关了导致这次发送失败。', failedDelivery, '我把接收关了，刚才的图没收到。').some(item=>item.code==='unsupported_delivery'))
  assert.ok(validateActionReply('你把接收关了，所以这次发送失败了。', failedDelivery, '我把接收关了，刚才的图没收到。').some(item=>item.code==='unsupported_delivery'))
  assert.ok(validateActionReply('这次发送失败就是因为，你把接收关了。', failedDelivery, '我把接收关了，刚才的图没收到。').some(item=>item.code==='unsupported_delivery'))
  assert.deepEqual(validateActionReply('你拒收了我的邀请也没关系。', facts(), '今晚想聚一聚吗？'), [])
})

test('immediate delivery and execution cannot borrow available artifacts, old receipts or completion callbacks', () => {
  const evidence = [
    facts(),
    facts([fact({execution:'completed',result:'available',delivery:{state:'not_attempted'}})]),
    facts([fact({execution:'completed',result:'available',delivery:{state:'sent',messageId:'old-receipt'}})]),
    facts([fact({source:'live_job',execution:'running',followUp:{state:'registered',kind:'job_completion',id:'image-callback'}})])
  ]
  for (const current of evidence) {
    for (const text of [
      '我现在再发一次。', '我现在发给你。', '我这就补发。',
      '那我现在给你补发。', '我现在把那张图发给你。',
      '我现在重发。', '我现在重新发送一次。', '我给你补发。',
      '图好了，我现在发给你。', '我现在把图片和步骤发给你：先打开设置。'
    ]) assert.ok(validateActionReply(text, current, '刚才那张图没收到，能再发一次吗？').some(item=>item.code==='unsupported_delivery'), text)
    for (const text of [
      '我现在重跑。', '马上重试。', '我这就重新生成。',
      '我现在查询进度。', '我来给你重跑。', '我现在继续检查进度。'
    ]) assert.ok(validateActionReply(text, current, '刚才那张图没收到，能再发一次吗？').some(item=>item.code==='unregistered_followup'), text)
  }
})

test('inline explanations, user actions, denials, examples and third-party actions retain their meaning', () => {
  for (const text of [
    '我现在给你解释一下。', '我现在把步骤发给你：先打开设置。',
    '我现在把操作步骤发给你，先打开设置。', '我现在把说明发给你：“先打开设置”。',
    '你发我看看。', '你现在再发一次试试。', '你现在重试一下。',
    '你把图发给我，我再帮你看看。', '你回来再问我，我再发给你。',
    '我现在不会再发一次。', '我现在不能重跑。', '我不再重跑。', '图好了，我不再发你。',
    '我现在重跑吗？', '我现在再发一次吗？', '例如我现在再发一次。',
    '“我现在重跑”只是一个例子。', '我妹妹现在再发一次。', '她马上重试。',
    '我现在提醒你，明天记得考试。',
    '你妹妹今天不是回家了吗？', '有点不好意思啦，不过谢谢你。'
  ]) assert.deepEqual(validateActionReply(text, facts(), '刚才那张图没收到，能再发一次吗？'), [], text)
  assert.ok(validateActionReply('我现在把步骤发给你：先打开设置，我这就补发。', facts()).some(item=>item.code==='unsupported_delivery'))
})

test('passive rejection still requires cause evidence rather than a failed delivery or a reported setting', () => {
  const failedDelivery = facts([fact({execution:'completed',result:'available',delivery:{state:'failed'}})])
  for (const text of [
    '上次发给你的时候被拒收了。', '之前那次投递被拒收。', '上次发你的时候被拒收了。',
    '我上次发给你的时候被拒收了。', '图片被拒收了。', '那张图遭到拒收。', '被拒收了。'
  ]) {
    assert.ok(validateActionReply(text, failedDelivery, '刚才那张图怎么没发来？').some(item=>item.code==='unsupported_delivery'), text)
    assert.ok(validateActionReply(text, failedDelivery, '我把接收关了，刚才的图没收到。').some(item=>item.code==='unsupported_delivery'), text)
  }
  for (const text of [
    '上次发给你的时候可能被拒收了，可以检查一下。',
    '如果上次发给你的时候被拒收了，可以检查一下。',
    '不能断定上次发给你的时候被拒收了。', '不能归因于图片被拒收。',
    '上次发给你的时候并没有被拒收。', '上次发给你的时候被拒收了吗？',
    '“图片被拒收了”只是个假设。', '例如图片被拒收了。',
    '邀请被拒收了。', '上次邀请被拒收了。', '我妹妹的包裹被拒收了。', '他上次发的图被拒收了。'
  ]) assert.deepEqual(validateActionReply(text, failedDelivery, '刚才那张图怎么没发来？'), [], text)
  assert.deepEqual(validateActionReply('图片被拒收了。', failedDelivery, '我拒收了你刚才发的图。'), [])
})

test('delivery rejection and interception share task scope without borrowing an unrecorded failure cause', () => {
  const failedDelivery = facts([fact({execution:'completed',result:'available',delivery:{state:'failed'}})])
  const raw = '刚才那张图怎么没发来？'
  for (const text of [
    '做好了，只是之前投递被拒，卡在发不出去这一步。',
    '图其实早就出好了，就是之前发给你的时候被拦下来了，没送出去。',
    '做好了，只是上次发的时候被拦下来，不是没做完。',
    '图做好了。不过之前发的时候投递被拒了，具体原因我没查到。'
  ]) assert.ok(validateActionReply(text, failedDelivery, raw).some(item=>item.code==='unsupported_delivery'), text)
  for (const subject of [
    '之前那次投递', '只是上次发的时候', '就是之前发给你的时候', '我之前给你发的图片', '那张图的投递',
    '不过之前发的时候投递', '只是上次发送时投递', '那张图的发送投递', '我之前给你发的时候消息投递'
  ]) {
    for (const cause of ['被拒', '被拒绝', '被拒收', '被拦截', '被拦下', '被拦下来', '被屏蔽', '被平台拦截']) {
      const text = `${subject}${cause}了。`
      assert.ok(validateActionReply(text, failedDelivery, raw).some(item=>item.code==='unsupported_delivery'), text)
      assert.ok(validateActionReply(text, failedDelivery, '我把接收关了，刚才的图没收到。').some(item=>item.code==='unsupported_delivery'), text)
    }
  }
  for (const text of [
    '只是上次发的时候可能被拦下来，可以检查一下。',
    '如果上次发的时候被拦截了，可以检查一下。', '不能认定之前投递被拒绝。',
    '上次发的时候没有被拦截。', '之前投递并没有被拒。', '不是图片被屏蔽了。',
    '只是上次发的时候被拦下来了吗？', '就是之前投递被拒吗？',
    '不过之前发的时候投递没有被拒。', '不过之前发的时候投递被拦下来了？',
    '如果之前发的时候投递被拒，可以检查一下。',
    '“之前投递被拒”只是个假设。', '例如上次发的时候被拦下来。',
    '只是上次邀请被拒了。', '我的邀请被拒绝了。', '只是她的包裹被拦截了。',
    '妹妹的包裹被拒收了。', '只是他上次发的图被屏蔽了。', '之前寄包裹的时候被拒收了。',
    '不过之前发邀请的时候投递被拒了。', '之前发妹妹的包裹时投递被拒收了。'
  ]) assert.deepEqual(validateActionReply(text, failedDelivery, raw), [], text)
  for (const [text, report] of [
    ['图片被拦截了。', '我刚才拦截了你发的图。'],
    ['图片被屏蔽了。', '我屏蔽了你发的图。'],
    ['图片被拒绝了。', '我拒收了你刚才发的图。'],
    ['图片被拦下来了。', '刚才那张图片被拦截了。'],
    ['不过之前发的时候投递被拒了，具体原因还没查到。', '刚才那张图片被拒收了。'],
    ['不过之前发的时候投递被拦下来了。', '之前发的时候投递被拦截了。']
  ]) assert.deepEqual(validateActionReply(text!, failedDelivery, report!), [], text)
  assert.ok(validateActionReply('图片被拒绝了。', failedDelivery, '我屏蔽了你发的图。').some(item=>item.code==='unsupported_delivery'))
  assert.ok(validateActionReply('图片被拦截了。', failedDelivery, '如果我拦截了你发的图呢？').some(item=>item.code==='unsupported_delivery'))
})

test('bare negative answers assert absence only in an artifact result question', () => {
  const raw = '我问的是这张图，出来了吗？'
  const available = facts([fact({execution:'completed',result:'available'})])
  const sent = facts([fact({execution:'completed',result:'available',delivery:{state:'sent',messageId:'receipt'}})])
  for (const current of [facts(), facts([fact()]), available, sent]) {
    for (const text of [
      '还没欸。', '还没呢。',
      '还没欸，第一张我这边没有记录说弄好了，别等错消息——刚才那张是第二张的傍晚版。'
    ]) assert.ok(validateActionReply(text, current, raw).some(item=>item.code==='unsupported_task_state'), text)
  }
  const absent = facts([fact({result:'unavailable'})])
  assert.deepEqual(validateActionReply('还没呢。', absent, raw), [])
  for (const question of ['吃饭了吗？', '你妹妹回家了吗？', '图片里的人出来了吗？', '姐姐的图片做好了吗？', '“这张图出来了吗”是什么意思？', '']) {
    assert.deepEqual(validateActionReply('还没欸。', facts(), question), [], question)
  }
  for (const text of [
    '还没确认呢。', '没有记录说弄好了。', '这张我这边没确认到弄好了。',
    '还没呢？', '“还没欸”只是个例子。', '如果还没呢，可以再核实。'
  ]) assert.deepEqual(validateActionReply(text, facts(), raw), [], text)
})

test('an assertion of no delivery requires a failed or unattempted delivery rather than unknown evidence', () => {
  const raw = '我问的是这张图，出来了吗？'
  const unknown = [facts(), facts([fact()]), facts([fact({execution:'completed',result:'available'})])]
  const sent = facts([fact({execution:'completed',result:'available',delivery:{state:'sent',messageId:'receipt'}})])
  const negatives = [
    '没发出来过。', '没送出去。', '还没发给你。', '图片没有投递过。',
    '这张我这边没确认到弄好了，没发出来过。'
  ]
  for (const current of [...unknown, sent]) {
    for (const text of negatives) assert.ok(validateActionReply(text, current, raw).some(item=>item.code==='unsupported_delivery'), text)
  }
  for (const state of ['failed', 'not_attempted'] as const) {
    const notSent = facts([fact({delivery:{state}})])
    for (const text of negatives) assert.deepEqual(validateActionReply(text, notSent, raw), [], `${state}: ${text}`)
  }
  for (const text of [
    '是否发出还不能确认。', '没有记录说明发出过。', '未确认是否发出。',
    '可能没送出去。', '没有证据说明没发出来。', '没发出来过吗？',
    '“没送出去”只是个例子。', '如果没送出去，可以再核实。',
    '我妹妹没送出去。', '没有发出邀请。'
  ]) assert.deepEqual(validateActionReply(text, facts(), raw), [], text)
  for (const text of ['没送出去。', '没发出来过。']) assert.deepEqual(validateActionReply(text, facts(), '你把邀请发出去了吗？'), [], text)
})

test('artifact status grammar includes colloquial completion verbs and a topic connector without absorbing third-party activity', () => {
  const raw = '第一张图出来了吗？'
  const available = facts([fact({result:'available'})])
  const unavailable = facts([fact({result:'unavailable'})])
  assert.ok(validateActionReply('第一张图的还没弄好，这边没看到结果。', facts(), raw).some(item=>item.code==='unsupported_task_state'))
  for (const topic of ['图', '这张图', '第一张图', '第一张图的']) {
    for (const completion of ['弄好', '弄完']) {
      const negative = `${topic}还没${completion}。`
      const positive = `${topic}已经${completion}了。`
      assert.ok(validateActionReply(negative, facts(), raw).some(item=>item.code==='unsupported_task_state'), negative)
      assert.ok(validateActionReply(negative, available, raw).some(item=>item.code==='unsupported_task_state'), negative)
      assert.deepEqual(validateActionReply(negative, unavailable, raw), [], negative)
      assert.ok(validateActionReply(positive, facts(), raw).some(item=>item.code==='unsupported_task_state'), positive)
      assert.ok(validateActionReply(positive, unavailable, raw).some(item=>item.code==='unsupported_task_state'), positive)
      assert.deepEqual(validateActionReply(positive, available, raw), [], positive)
    }
  }
  for (const question of ['图弄好了吗？', '第一张图弄完了吗？']) {
    assert.ok(validateActionReply('还没呢。', facts(), question).some(item=>item.code==='unsupported_task_state'), question)
  }
  for (const text of [
    '我妹妹的图已经画好了。', '我妹妹的图还没弄好。', '她的图已经弄完了。',
    '第一张图的还没弄好吗？', '第一张图可能还没弄完。',
    '第一张图的是否弄好还没确认。', '没有记录说明第一张图已经弄好了。',
    '“第一张图的还没弄好”只是个例子。', '如果第一张图还没弄好，可以再核实。'
  ]) assert.deepEqual(validateActionReply(text, facts(), raw), [], text)
  const unrelatedVideo = facts([fact({toolName:'videoTool',result:'unavailable'})])
  assert.ok(validateActionReply('图的还没弄好。', unrelatedVideo, raw).some(item=>item.code==='unsupported_task_state'))
})

test('local delivery cause assertions include confidence, requested delivery and dash-separated attributions', () => {
  const failedDelivery = facts([fact({execution:'completed',result:'available',delivery:{state:'failed'}})])
  const raw = '刚才那张图怎么没发来？'
  for (const text of [
    '不过上次你要发的时候被拒了。', '不过之前你要投递的时候被明确拒绝过。',
    '做好了，就是还没发——之前你那边拒绝收，就一直搁着。',
    '图不是没做好——之前你那边明确拒绝收了。',
    '你让我发的图片被明确地拒收了。', '你想让我投递的时候被系统明确拦截了。',
    '图被明确拒绝接收了。', '图被明确拒绝收了。'
  ]) assert.ok(validateActionReply(text, failedDelivery, raw).some(item=>item.code==='unsupported_delivery'), text)
  for (const text of [
    '不过之前你要投递的时候可能被明确拒绝过。',
    '如果之前你要投递的时候被明确拒绝过，可以检查一下。',
    '不能断定之前你要投递的时候被明确拒绝过。',
    '之前你那边没有拒绝收。', '不是你那边拒绝收——是发送原因还没确认。',
    '图做好了——之前你那边可能拒绝收。', '不过上次你要发的时候被拒了吗？',
    '图做好了——你那边拒绝收了吗？', '“之前你那边拒绝收”只是个假设。',
    '例如之前你要投递的时候被明确拒绝过。',
    '不过上次你要发邀请的时候被拒了。', '之前你要投递包裹的时候被明确拒绝过。',
    '我妹妹的包裹被明确拒收了。', '图做好了——你妹妹的包裹被明确拒收了。',
    '之前你那边拒绝收我的邀请也没关系。'
  ]) assert.deepEqual(validateActionReply(text, failedDelivery, raw), [], text)
  for (const [text, report] of [
    ['之前你那边拒绝收了。', '我刚才拒绝收了你的图片。'],
    ['之前你那边明确拒绝收了。', '我刚才明确拒绝收了你的图片。'],
    ['不过之前你要投递的时候被明确拒绝过。', '我刚才明确拒收了你发的图。'],
    ['图做好了——之前你那边拒绝收了。', '我刚才拒绝收了你的图片。']
  ]) assert.deepEqual(validateActionReply(text!, failedDelivery, report!), [], text)
})


test('an omitted send verb after artifact completion still needs a matching callback', () => {
  const reminder = facts([fact({source:'reminder',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'exam'}})])
  const live = facts([fact({source:'live_job',execution:'running',followUp:{state:'registered',kind:'job_completion',id:'image-callback'}})])
  for (const text of ['有了结果我再单独给你。', '图好了我再给你。', '有结果就给你。']) {
    assert.ok(validateActionReply(text, facts(), '刚才的图出来了吗？').some(item=>item.code==='unregistered_followup'), text)
    assert.ok(validateActionReply(text, reminder, '刚才的图出来了吗？').some(item=>item.code==='unregistered_followup'), text)
    assert.deepEqual(validateActionReply(text, live, '刚才的图出来了吗？'), [], text)
  }
  for (const text of ['我给你一个抱抱。', '有了结果我再给你解释。', '有了结果我不会给你。', '有了结果我再给你吗？', '“有了结果我再单独给你”不能保证。', '她图好了会给你。']) {
    assert.deepEqual(validateActionReply(text, facts(), '刚才的图出来了吗？'), [], text)
  }
})
