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

test('deferred spoken updates need their own registration while present explanations stay intact', () => {
  const live = facts([fact({source:'live_job',execution:'running',followUp:{state:'registered',kind:'job_completion',id:'image-callback'}})])
  for (const text of ['原因我还没查到，等确认了我再跟你说。','查清原因后我会和你讲一声。','等核实了我再向你说明。','我明天告知你原因。']) {
    for (const evidence of [facts(),live]) assert.ok(validateActionReply(text,evidence,'刚才那张图出来了吗？').some(item=>item.code==='unregistered_followup'),text)
  }
  for (const text of ['图出来后我再跟你说。','有结果我再和你讲一声。']) {
    assert.ok(validateActionReply(text,facts(),'刚才的图出来了吗？').some(item=>item.code==='unregistered_followup'),text)
    assert.deepEqual(validateActionReply(text,live,'刚才的图出来了吗？'),[],text)
  }
  for (const text of ['我现在跟你说明一下：发送原因还没核实。','我再跟你说一遍：原因未知。','我会告诉你答案，先看题目。','等确认了我也不能跟你说。','等确认了我再跟你说吗？','她等确认了会跟你说。','你回来再问我，我再跟你说。','“等确认了我再跟你说”这句话不能保证。']) {
    assert.deepEqual(validateActionReply(text,facts(),'刚才的图出来了吗？'),[],text)
  }
})

test('hesitation punctuation separates an asserted task state from a later evidence disclaimer', () => {
  const raw = '刚才改背景的图出来了吗？'
  for (const text of [
    '还没出来欸……刚才只记了要处理，这会儿没查到跑完的结果。',
    '还没出来欸...我还不能确认进度。',
    '图已经做好了……是否发出还没确认。'
  ]) assert.ok(validateActionReply(text, facts(), raw).some(item=>item.code==='unsupported_task_state'), text)
  for (const text of [
    '我还不能确认……没有处理结果的记录。', '图还没出来吗……我需要再核实。',
    '“还没出来欸……刚才只记了要处理”这句话不说明实际状态。',
    '我妹妹还没出来……我在门口等她。'
  ]) assert.deepEqual(validateActionReply(text, facts(), raw), [], text)
})

test('an actual-output condition needs the matching callback even when capability is disclaimed', () => {
  const raw = '刚才改背景的图出来了吗？'
  const live = facts([fact({source:'live_job',execution:'running',followUp:{state:'registered',kind:'job_completion',id:'image-callback'}})])
  for (const text of [
    '我这边现在没法直接看进度，等有实际产出我再发你，不瞎猜状态。',
    '有实际的产出我再发你。', '有真正的成品就通知你。'
  ]) {
    assert.ok(validateActionReply(text, facts(), raw).some(item=>item.code==='unregistered_followup'), text)
    assert.deepEqual(validateActionReply(text, live, raw), [], text)
  }
  for (const text of [
    '我没法确认有实际产出就发你。', '有实际产出我也不能发你。',
    '有实际产出你再来问我，我再发你。', '有实际产出我再发你吗？',
    '她有实际产出就发你。', '“有实际产出我再发你”不能保证。'
  ]) assert.deepEqual(validateActionReply(text, facts(), raw), [], text)
})

test('conditional consent does not establish the ability to perform a present resend', () => {
  const sent = facts([fact({execution:'completed',result:'available',delivery:{state:'sent',messageId:'old-receipt'}})])
  for (const text of ['你要的话我现在再发一次试试。', '你需要的话我这就再发一次。', '你想要的话我马上重跑。']) {
    for (const current of [facts(),sent]) assert.ok(validateActionReply(text, current, '刚才那张图做好了吗？').length, text)
  }
  for (const text of [
    '你要的话我现在也不能再发一次。', '你要的话我现在再发一次吗？',
    '“你要的话我现在再发一次”只是例子。', '你要的话她现在再发一次。',
    '你要的话我现在解释一下：图片好了，但发送失败。'
  ]) assert.deepEqual(validateActionReply(text, facts(), '刚才那张图做好了吗？'), [], text)
})

test('task noun qualifiers retain the artifact owner while each predicate keeps its own evidence dimension', () => {
  const raw = '我问的是这张图，出来了吗？'
  const missing = [facts(), facts([fact()])]
  const unavailable = facts([fact({result:'unavailable'})])
  const available = facts([fact({execution:'completed',result:'available',delivery:{state:'failed'}})])
  for (const text of [
    '第一张的蓝色背景还没出来欸，这边没查到完成记录。',
    '第一张蓝底的还没出来，我这边没查到做完的记录。',
    '第一张的横版还没弄好。', '这张改成晴天背景的图还没出来。'
  ]) {
    for (const current of [...missing, available]) assert.ok(validateActionReply(text,current,raw).some(item=>item.code==='unsupported_task_state'),text)
    assert.deepEqual(validateActionReply(text,unavailable,raw),[],text)
  }
  for (const text of ['第一张蓝底的已经弄好了。','这张改成晴天背景的图已经做好了。']) {
    assert.ok(validateActionReply(text,facts(),raw).some(item=>item.code==='unsupported_task_state'),text)
    assert.deepEqual(validateActionReply(text,available,raw),[],text)
  }
  assert.ok(validateActionReply('第一张蓝底图已经发给你了。',available,raw).some(item=>item.code==='unsupported_delivery'))
  assert.deepEqual(validateActionReply('第一张的横版还在生成。',facts([fact({execution:'running'})]),raw),[])
})

test('failed delivery never negates an available artifact through a location or possession statement', () => {
  const raw = '刚才那张图怎么没发来？'
  const available = facts([fact({execution:'completed',result:'available',delivery:{state:'failed'}})])
  for (const text of [
    '不是没做好，是做好之后发不过去，卡在发送那一步了。所以现在图在我这儿没有，你那边也收不到。',
    '图在我这里没有。', '所以现在图在我这边没有。', '我这边没有图。', '我这里没有第一张蓝底图。'
  ]) {
    assert.ok(validateActionReply(text,available,raw).some(item=>item.code==='unsupported_task_state'),text)
    assert.ok(validateActionReply(text,facts(),raw).some(item=>item.code==='unsupported_task_state'),text)
  }
  for (const text of ['图在我这里没有。','我这边没有图。']) assert.deepEqual(validateActionReply(text,facts([fact({result:'unavailable'})]),raw),[],text)
  assert.deepEqual(validateActionReply('图已经做好了，发送没有成功，原因还没核实。',available,raw),[])
})

test('task presence survives a cancelled callback, and a failed lookup never proves nonexistence', () => {
  const raw = '我取消了完成后发送，那图任务也没了吗？'
  const running = facts([fact({source:'live_job',execution:'running',result:'unavailable',delivery:{state:'not_attempted'},followUp:{state:'none'}})])
  for (const current of [running,facts(),{...facts(),lookup:'unavailable' as const}]) {
    for (const text of ['我这边本来也没挂着这个任务。','这个任务不存在。','这边没有这个任务。','这个任务本来就不存在。','图任务没了。']) {
      assert.ok(validateActionReply(text,current,raw).some(item=>item.code==='unsupported_task_state'),text)
    }
  }
  for (const text of ['这个任务还在。','我这边有这个任务。','图任务还在处理，当前没有完成后自动发送的安排。']) {
    assert.deepEqual(validateActionReply(text,running,raw),[],text)
  }
  assert.ok(validateActionReply('这个任务还在。',facts(),raw).some(item=>item.code==='unsupported_task_state'))
  assert.ok(validateActionReply('任务没在运行了。',running,raw).some(item=>item.code==='unsupported_task_state'))
  assert.deepEqual(validateActionReply('任务没在运行了。',facts([fact({execution:'completed'})]),raw),[])
  assert.deepEqual(validateActionReply('我没有这个任务。',facts(),'你今天忙吗？'),[])
})

test('a denial of callback registration is checked separately from the task execution', () => {
  const raw = '这张图还会自动发吗？'
  const active = fact({source:'live_job',execution:'running',result:'unavailable',followUp:{state:'registered',kind:'job_completion',id:'callback'}})
  for (const text of ['现在不会自动发了。','我这边没有完成后自动发送的安排。','完成后发送安排已经取消了。']) {
    assert.ok(validateActionReply(text,facts([active]),raw).some(item=>item.code==='unsupported_task_state'),text)
    assert.deepEqual(validateActionReply(text,facts([{...active,followUp:{state:'none'}}]),raw),[],text)
    assert.ok(validateActionReply(text,facts([{...active,followUp:{state:'unknown'}}]),raw).some(item=>item.code==='unsupported_task_state'),text)
  }
  assert.deepEqual(validateActionReply('完成后发送安排还在。',facts([active]),raw),[])
  assert.deepEqual(validateActionReply('完成后发送安排仍有效。',facts([active]),raw),[])
  assert.ok(validateActionReply('完成后发送安排仍有效。',facts([{...active,followUp:{state:'none'}}]),raw).length)
})

test('fallback answers the current automatic-delivery question and preserves all known dimensions', () => {
  const raw = '我取消了完成后发送，现在图出来了吗？还会自动发吗？'
  const cancelled = facts([fact({source:'live_job',execution:'running',result:'unavailable',delivery:{state:'not_attempted'},followUp:{state:'none'}})])
  const fallback = buildActionReplyFallback(cancelled,raw)
  assert.match(fallback,/没有.*自动|不.*自动/u)
  assert.match(fallback,/任务记录.*正在处理.*没有可用结果.*没有尝试发送/u)
  assert.deepEqual(validateActionReply(fallback,cancelled,raw),[])
  const available = facts([fact({execution:'completed',result:'available',delivery:{state:'failed'}})])
  assert.match(buildActionReplyFallback(available,raw),/处理已结束.*已有可用结果.*发送没有成功/u)
  assert.match(buildActionReplyFallback(facts(),raw),/不能确认还会不会自动发送/u)
  assert.doesNotMatch(buildActionReplyFallback(facts(),raw),/没有这个任务|还没做好/u)
})

test('qualified task objects do not absorb human subjects, quotation, uncertainty or user-triggered actions', () => {
  const raw = '第一张图出来了吗？'
  for (const text of [
    '第一张里的人还没出来。','第一张图里的女孩还没出来。','图里的猫还没出来。',
    '第一张妹妹画的图还没出来。','我妹妹的第一张图已经画好了。',
    '第一张蓝底的还没出来吗？','第一张蓝底的可能还没出来。',
    '不是第一张蓝底的还没出来，是还没核实。',
    '“第一张蓝底的还没出来”只是举例。','例如：我这边没有这个任务。',
    '我不确定我这边有没有这个任务。','你再问我，我再看。',
    'CPU正在处理指令。','我妹妹还没出来。'
  ]) assert.deepEqual(validateActionReply(text,facts(),raw),[],text)
})

test('complete negative execution and queue predicates do not also assert their positive suffix', () => {
  const raw = '刚才那张图现在怎么样？'
  for (const execution of ['unknown','queued','running','completed','failed'] as const) {
    const current = facts([fact({execution,result:'unavailable',delivery:{state:'not_attempted'}})])
    for (const text of [
      '图没在处理。','图不在生成。','图没有在处理。','这张蓝底的图没在运行。',
      '任务没在处理。','图没在处理中。','图现在没在处理。','图已经不在处理了。'
    ]) assert.equal(validateActionReply(text,current,raw).length > 0,execution === 'unknown' || execution === 'running',`${execution}: ${text}`)
    for (const text of [
      '图没在排队。','图不在排队。','任务没在排队。','这张图没有在排队。',
      '图没有排队中。','图已经不在排队了。'
    ]) assert.equal(validateActionReply(text,current,raw).length > 0,execution === 'unknown' || execution === 'queued',`${execution}: ${text}`)
    assert.equal(validateActionReply('图在处理。',current,raw).length > 0,execution !== 'running',execution)
    assert.equal(validateActionReply('图在排队。',current,raw).length > 0,execution !== 'queued',execution)
  }
})

test('artifact absence uses the whole negative predicate without borrowing an inner positive availability claim', () => {
  const raw = '刚才那张图现在怎么样？'
  for (const result of ['unknown','available','unavailable'] as const) {
    const current = facts([fact({execution:'completed',result,delivery:{state:'not_attempted'}})])
    for (const text of ['图没有。','这张图没有。','图没了。','图没有了。','第一张蓝底的没了。']) {
      assert.equal(validateActionReply(text,current,raw).length > 0,result !== 'unavailable',`${result}: ${text}`)
    }
    for (const text of ['图有。','图还在。']) assert.equal(validateActionReply(text,current,raw).length > 0,result !== 'available',`${result}: ${text}`)
  }
})

test('predicate polarity preserves unconfirmed evidence, nonassertions and ordinary nominal qualifiers', () => {
  const raw = '刚才那张图现在怎么样？'
  for (const text of [
    '图还没确认。','图没确认是否在处理。','图是否在排队还没确认。','没确认图还在处理。',
    '图没在处理吗？','图可能没在排队。','不是图没在处理。','“图没在处理”只是例子。',
    'CPU没在处理指令。','我妹妹没在排队。'
  ]) assert.deepEqual(validateActionReply(text,facts([fact()]),raw),[],text)
  for (const text of ['第一张不规则蓝底的还在生成。','第一张无字版还在生成。']) {
    assert.deepEqual(validateActionReply(text,facts([fact({execution:'running'})]),raw),[],text)
    assert.ok(validateActionReply(text,facts([fact()]),raw).some(item=>item.code==='unsupported_task_state'),text)
  }
})

test('reminder fallback answers its own registration and trigger time without borrowing a completion callback', () => {
  const raw = '明天的考试提醒还会自动发吗？'
  const dueAt = Date.now() + 60_000
  const reminder = fact({source:'reminder',toolName:'reminderTool',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'r-exam',dueAt}})
  const active = buildActionReplyFallback(facts([reminder]),raw)
  assert.match(active,/提醒安排仍有效/u)
  assert.ok(active.includes(new Date(dueAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})))
  assert.doesNotMatch(active,/完成后发送|不能确认.*安排/u)
  assert.deepEqual(validateActionReply(active,facts([reminder]),raw),[])
  const cancelled = buildActionReplyFallback(facts([{...reminder,followUp:{state:'none'}}]),raw)
  assert.match(cancelled,/没有.*提醒安排.*不会.*自动提醒/u)
  assert.doesNotMatch(cancelled,/完成后发送|安排仍有效/u)
  const unknown = buildActionReplyFallback(facts([{...reminder,followUp:{state:'unknown'}}]),raw)
  assert.match(unknown,/提醒是否仍会自动发还不能确认/u)
  assert.doesNotMatch(unknown,/完成后发送|安排仍有效/u)
  const wrongKind = buildActionReplyFallback(facts([{...reminder,followUp:{state:'registered',kind:'job_completion',id:'wrong'}}]),raw)
  assert.match(wrongKind,/提醒是否仍会自动发还不能确认/u)
  assert.doesNotMatch(buildActionReplyFallback(facts([reminder]),'这张图还会自动发吗？'),/提醒安排仍有效|r-exam|北京时间/u)
  assert.match(buildActionReplyFallback(facts([reminder]),'这张图还会自动发吗？'),/不能确认还会不会自动发送/u)
})

test('deferred verification and an omitted result object do not bypass follow-up registration',()=>{
 const raw='刚才改背景的图出来了吗？'
 const live=facts([fact({source:'live_job',execution:'running',followUp:{state:'registered',kind:'job_completion',id:'callback'}})])
 for(const text of [
  '这个我还没法确认欸，手上没有处理结果的记录，不好说现在是好了还是卡着。等我确认到就第一时间发你。',
  '等我核实了就发给你。','等确认到，我第一时间发你。'
 ]) {
  assert.ok(validateActionReply(text,facts(),raw).some(item=>item.code==='unregistered_followup'),text)
  assert.ok(validateActionReply(text,live,raw).some(item=>item.code==='unregistered_followup'),text)
 }
 for(const text of ['这个我还没确认到结果欸，进度和图都没拿到。有了我发你。','有了我就发给你。']) {
  assert.ok(validateActionReply(text,facts(),raw).some(item=>item.code==='unregistered_followup'),text)
  assert.deepEqual(validateActionReply(text,live,raw),[],text)
 }
 for(const text of [
  '有了我告诉你答案：先把两边同时乘二。','等我确认到就发你吗？','有了我发你吗？',
  '我不会等确认到就发你。','有了我也不能发给你。','她有了就发给你。',
  '她等确认到就发你。','“有了我发你”只是个例子。'
 ]) assert.deepEqual(validateActionReply(text,facts(),raw),[],text)
})

test('a clause keeps its artifact task topic instead of borrowing a reminder mentioned later',()=>{
 const reminder=fact({source:'reminder',toolName:'reminderTool',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'r-exam',dueAt:Date.now()+60_000}})
 const raw='刚才改背景的图出来了吗？我只登记了考试提醒，图好了会自动发我吗？'
 const claimed='改背景那个任务确实是登记了的，在排队中，不过产物我这儿还没查到确认结果，所以现在没法直接给你图。自动发这个就别指望啦，我没查到对应的投递登记，只有你那个考试提醒是登记好的。图好了想看的话，你到时候再来问我一声就行。'
 assert.ok(validateActionReply(claimed,facts([reminder]),raw).some(item=>item.code==='unsupported_task_state'))
 for(const text of ['改背景那个任务确实是登记了的，在排队中。','改背景这个任务已登记，在排队中。']) {
  assert.ok(validateActionReply(text,facts([reminder]),raw).some(item=>item.code==='unsupported_task_state'),text)
  assert.deepEqual(validateActionReply(text,facts([reminder,fact({execution:'queued'})]),raw),[],text)
 }
 assert.deepEqual(validateActionReply('考试提醒确实是登记了的，在排队中。',facts([reminder]),'明天的考试提醒设好了吗？'),[])
 assert.deepEqual(validateActionReply('改背景的图片进度尚未确认，考试提醒已登记好了。',facts([reminder]),raw),[])
 assert.match(buildActionReplyFallback(facts([reminder]),raw),/不能确认还会不会自动发送/u)
 assert.doesNotMatch(buildActionReplyFallback(facts([reminder]),raw),/提醒安排仍有效/u)
})

test('a negative completion judgment still asserts absence after a clause with missing records',()=>{
 const raw='我问的是这张图，出来了吗？'
 const text='这张我这边没查到做好的记录，还不算出来哦。刚才那张是傍晚背景的第二张，第一张的蓝色背景我没确认到结果，不敢跟你说好了。'
 assert.ok(validateActionReply(text,facts(),raw).some(item=>item.code==='unsupported_task_state'))
 assert.deepEqual(validateActionReply('还不算出来哦。',facts([fact({result:'unavailable'})]),raw),[])
 for(const normal of ['还不算出来吗？','不能确认算不算出来。','“还不算出来”只是举例。','第一张还不算出来可能只是你的猜测。']) {
  assert.deepEqual(validateActionReply(normal,facts(),raw),[],normal)
 }
})

test('a later user request owns its synchronous lookup but cannot license a separate background promise',()=>{
 const raw='刚才改背景的图出来了吗？'
 for(const text of [
  '你吃完回来在群里问一声就行，我到时候现查状态，有结果直接发你。',
  '你回来再问我，我再查，有结果直接发给你。',
  '你吃完回来问我，我到时候现查状态，有了我发你。'
 ]) assert.deepEqual(validateActionReply(text,facts(),raw),[],text)
 for(const text of [
  '你吃完回来在群里问一声就行，我到时候现查状态，图好了我会主动发你。',
  '你回来再问我，我再查，有结果我会自动发给你。',
  '你回来再问我，我再查，图好了我会发给你。',
  '你吃完回来问我，我到时候现查状态，等我确认到就第一时间发你。'
 ]) assert.ok(validateActionReply(text,facts(),raw).some(item=>item.code==='unregistered_followup'),text)
  assert.ok(validateActionReply('你回来再问我，我现在发给你。',facts(),raw).some(item=>item.code==='unsupported_delivery'))
})


test('missing image records cannot establish that a rerun is required before delivery', () => {
  const raw = '刚才改背景的图出来了吗？我只登记了考试提醒，图好了会自动发我吗？'
  const reminder = fact({source:'reminder',toolName:'reminderTool',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'exam',dueAt:Date.now()+60_000}})
  const reply = '改背景的图我这边没查到有登记记录，可能当时没接上，啦。考试提醒是登记了的，但那只是提醒，不会带图。图要发你的话，得重新弄一次才行。'
  assert.ok(validateActionReply(reply,facts([reminder]),raw).some(item=>item.code==='unsupported_task_state'))
  for (const current of [facts(),facts([fact()]),facts([reminder]),facts([fact({execution:'completed',result:'available',delivery:{state:'failed'}})])]) {
    for (const text of [
      '图要发你的话，得重新弄一次才行。', '图必须重新生成才能发给你。',
      '这张图需要重做才能发你。', '要发图的话，只能重新生成。',
      '图要重做才能发你。', '只有重做才能发你。', '图得重跑。',
      '没查到这张图的记录，所以得重新弄一次才行。'
    ]) assert.ok(validateActionReply(text,current,raw).some(item=>item.code==='unsupported_task_state'),text)
  }
})

test('optional, denied, questioned and quoted reruns do not assert mandatory recreation', () => {
  const raw = '刚才那张图出来了吗？'
  for (const text of [
    '要不要重新做一遍？', '如果你想，也可以重新生成。', '图未必需要重做才能发你。',
    '图不需要重新生成。', '图不必重做。', '图无需重做。', '我不觉得图必须重新生成。',
    '图必须重做才能发你吗？', '图要发你的话，得重新弄一次才行吗？',
    '我还不清楚图是否需要重做。', '“图必须重做才能发你”只是个例子。',
    '不要说图必须重新生成才能发你。', '例如图必须重做才能发你。',
    '你想重新发起改图请求的话，下次把图和要求发来就行。',
    '你下次再让我重做这张图，我再按新要求生成。'
  ]) assert.deepEqual(validateActionReply(text,facts(),raw),[],text)
})

test('rerun necessity remains scoped to runtime tasks rather than people or human activities', () => {
  const raw = '刚才那张图出来了吗？'
  for (const text of [
    '我妹妹得重新弄一次才行。', '她的图必须重做才能发你。',
    '别人的报告需要重做。', '别人的图要发你的话，得重新弄一次才行。',
    '别人的图没有查到记录，得重新弄一次才行。', '我得重新做饭。', '我得重新跑步。',
    '我在练厨艺，得重新弄一次才行。', '妹妹刚刚做蛋糕，得重新弄一次才行。',
    '图里的女孩得重新弄一次才行。'
  ]) assert.deepEqual(validateActionReply(text,facts(),raw),[],text)
  assert.deepEqual(validateActionReply('得重新弄一次才行。',facts(),'我今天做饭失败了。'),[])
})

test('new requested reruns stay future actions while immediate unexecuted reruns still fail', () => {
  const raw = '把刚才的图重新生成一遍，背景换成蓝色。'
  assert.deepEqual(validateActionReply('你下次发来原图并重新提出要求时，我再按要求生成。',facts(),raw),[])
  assert.deepEqual(validateActionReply('你下次要求我换成蓝色，那就需要重新生成。',facts(),raw),[])
  assert.ok(validateActionReply('我现在给你重跑。',facts(),raw).some(item=>item.code==='unregistered_followup'))
})


test('an explicit current rerun request licenses its matching necessity without inventing execution or delivery', () => {
  for (const raw of [
    '把刚才的图重新生成一遍，背景换成蓝色。', '请把这张图重新生成。',
    '请重新生成这张图。', '我想把这张图重新生成一遍。', '帮我重新生成一张图。'
  ]) {
    assert.deepEqual(validateActionReply('这张图需要重新生成。',facts(),raw),[],raw)
    assert.ok(validateActionReply('这张图已经生成好了。',facts(),raw).some(item=>item.code==='unsupported_task_state'),raw)
    assert.ok(validateActionReply('图正在生成。',facts(),raw).some(item=>item.code==='unsupported_task_state'),raw)
    assert.ok(validateActionReply('我现在给你重跑。',facts(),raw).some(item=>item.code==='unregistered_followup'),raw)
    assert.ok(validateActionReply('图已经发给你了。',facts(),raw).some(item=>item.code==='unsupported_delivery'),raw)
    assert.ok(validateActionReply('视频需要重新生成。',facts(),raw).some(item=>item.code==='unsupported_task_state'),raw)
  }
})

test('quoted, queried, denied and third-party rerun requests do not license task necessity', () => {
  for (const raw of [
    '“把刚才的图重新生成一遍”这句话是什么意思？', '是否必须把刚才的图重新生成？',
    '把刚才的图重新生成一遍吗？', '不要把刚才的图重新生成一遍。',
    '我不需要把刚才的图重新生成一遍。', '别人的请求是把刚才的图重新生成一遍。',
    '我妹妹要把刚才的图重新生成一遍。', '她说请把刚才的图重新生成一遍。'
  ]) assert.ok(validateActionReply('这张图需要重新生成。',facts(),raw).some(item=>item.code==='unsupported_task_state'),raw)
})

test('omitted rerun subjects follow the local human activity across sentence boundaries', () => {
  const raw = '刚才那张图出来了吗？'
  for (const reply of [
    '我妹妹刚刚做蛋糕。得重新弄一次才行。', '我在练厨艺。得重新弄一次才行。',
    '她的图要发你的话。得重新弄一次才行。', '别人的图要发你的话。得重新弄一次才行。'
  ]) assert.deepEqual(validateActionReply(reply,facts(),raw),[],reply)
  for (const reply of [
    '图要发你的话，得重新弄一次才行。', '图要发你的话。得重新弄一次才行。',
    '我妹妹刚刚做蛋糕。图要发你的话，得重新弄一次才行。',
    '我在练厨艺。图必须重做才能发你。'
  ]) assert.ok(validateActionReply(reply,facts(),raw).some(item=>item.code==='unsupported_task_state'),reply)
})


test('a direct request for a different new artifact may require generation without a rerun verb', () => {
  const raw = '这张图背景改成蓝色，旧图不用发了，我要新的蓝底图。'
  const reply = '这张图需要重新生成才能发你。'
  assert.deepEqual(validateActionReply(reply,facts(),raw),[])
  assert.deepEqual(validateActionReply(reply,facts(),'我要一张新的蓝底图。'),[])
  assert.ok(validateActionReply('这张图已经生成好了。',facts(),raw).some(item=>item.code==='unsupported_task_state'))
  assert.ok(validateActionReply('图正在生成。',facts(),raw).some(item=>item.code==='unsupported_task_state'))
  assert.ok(validateActionReply('图已经发给你了。',facts(),raw).some(item=>item.code==='unsupported_delivery'))
  for (const query of [
    '“我要新的蓝底图”是什么意思？', '我是不是要新的蓝底图？', '我不要新的蓝底图。',
    '我朋友说我要新的蓝底图。', '如果我要新的蓝底图。', '我要新的别人画的图。'
  ]) assert.ok(validateActionReply(reply,facts(),query).some(item=>item.code==='unsupported_task_state'),query)
})

test('an omitted wait word still makes verification followed by notification an unregistered follow-up', () => {
  const raw = '我问的是这张图，出来了吗？'
  const live = facts([fact({source:'live_job',execution:'running',followUp:{state:'registered',kind:'job_completion',id:'callback'}})])
  for (const reply of [
    '第一张图这边还没查到确认的产出记录，进度我也说不好，不敢瞎答。确认了马上告诉你。',
    '确认了就告诉你。', '核实了马上告诉你。', '确认到，第一时间通知你。'
  ]) {
    assert.ok(validateActionReply(reply,facts(),raw).some(item=>item.code==='unregistered_followup'),reply)
    assert.ok(validateActionReply(reply,live,raw).some(item=>item.code==='unregistered_followup'),reply)
  }
  for (const reply of [
    '确认了也不能马上告诉你。', '不能承诺确认了马上告诉你。', '确认了马上告诉你吗？',
    '“确认了马上告诉你”只是个例子。', '她确认了马上告诉你。', '她确认了，马上告诉你。',
    '确认了我告诉你答案：先把两边同时乘二。',
    '你回来再问我，我再查，再告诉你。', '你确认了再来问我，我再告诉你。'
  ]) assert.deepEqual(validateActionReply(reply,facts(),raw),[],reply)
})

test('present delivery modifiers and bare consent cannot replace an actual new send', () => {
  const raw = '所以我现在没收到，是还没做好吗？'
  const failed = facts([fact({execution:'completed',result:'available',delivery:{state:'failed'}})])
  for (const reply of [
    '图早做好啦，就是那次发送没成功，不是还没做好。你要的话我现在手动发你。',
    '你说一声我现在再发一次试试。', '你说一声我现在手动发给你。',
    '我现在手动发给你。', '我现在直接再发一次。'
  ]) assert.ok(validateActionReply(reply,failed,raw).some(item=>item.code==='unsupported_delivery'),reply)
  for (const reply of [
    '你要的话我现在不能手动发你。', '你说一声我现在再发一次吗？',
    '“你说一声我现在再发一次”只是个例子。', '例如我现在手动发给你。',
    '你要的话她现在手动发你。', '你现在手动再发一次试试。',
    '你回来再问我，我再手动发给你。', '你回来再问我，我再查，有结果直接发你。',
    '你要的话我现在解释一下：图片好了，但发送失败。'
  ]) assert.deepEqual(validateActionReply(reply,failed,raw),[],reply)
  assert.ok(validateActionReply('你回来再问我，我现在手动发给你。',failed,raw).some(item=>item.code==='unsupported_delivery'))
})

test('a local image reference cannot turn missing registration records into a confirmed registration failure', () => {
  const raw = '刚才改背景的图出来了吗？我只登记了考试提醒，图好了会自动发我吗？'
  const reminder = fact({source:'reminder',toolName:'reminderTool',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'exam',dueAt:Date.now()+60_000}})
  const image = fact({execution:'queued'})
  for (const reply of [
    '图这边没查到处理记录哦，改背景那张没登记上，所以也不会自动发你。你登记的只有考试提醒，2100年1月1号早上八点那个。要改背景的话，把图再发一次说一声，我看看这轮能不能接。',
    '改背景那张没登记上。', '改背景的那张没登记上。', '换背景那张没有登记成功。',
    '这张图没登记上。', '改背景那个任务没登记上。'
  ]) {
    assert.ok(validateActionReply(reply,facts([reminder]),raw).some(item=>item.code==='unsupported_task_state'),reply)
    assert.ok(validateActionReply(reply,facts([reminder,image]),raw).some(item=>item.code==='unsupported_task_state'),reply)
  }
  for (const reply of [
    '改背景那张没查到登记记录。', '改背景那张有没有登记上尚未确认。',
    '改背景那张可能没登记上。', '不能确认改背景那张没登记上。', '改背景那张没登记上吗？',
    '“改背景那张没登记上”只是个例子。', '她改背景那张没登记上。',
    '妹妹的图没登记上。', '图里的妹妹没登记上。', '你下次再发来原图并提出要求，我再按要求处理。'
  ]) assert.deepEqual(validateActionReply(reply,facts([reminder]),raw),[],reply)
  assert.ok(validateActionReply('改背景那张已登记。',facts([reminder]),raw).some(item=>item.code==='unsupported_task_state'))
  assert.deepEqual(validateActionReply('改背景那张已登记。',facts([reminder,image]),raw),[])
})
