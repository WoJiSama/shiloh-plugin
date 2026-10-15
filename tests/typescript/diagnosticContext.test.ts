import {test} from 'node:test'
import assert from 'node:assert/strict'
import {buildDiagnosticContext, buildDiagnosticContextPrompt} from '../../src/modules/conversation/domain/diagnosticContext.js'
import type {DiagnosticHistoryMessage} from '../../src/modules/conversation/domain/diagnosticContext.js'
import type {TurnEvidence} from '../../src/contracts/turnInteraction.js'

const speakerId = '202'
const incident: DiagnosticHistoryMessage = {role: 'user', userId: speakerId, text: '我的电脑满载92℃，闻到焦糊味，还冒烟了。', messageId: 'incident-1'}
const history = [incident]

test('reported electrical incident requires isolation, cooling and damage exclusion before operation', () => {
  const context = buildDiagnosticContext({rawUserText: incident.text, speakerId})!
  assert.equal(context.incident.status, 'asserted')
  assert.deepEqual(new Set(context.incident.signals), new Set(['burning_odor', 'smoke']))
  assert.equal(context.power, 'unknown')
  assert.equal(context.damageExclusion, 'unknown')
  assert.deepEqual(context.allowedChecks, ['static_observation'])
  assert.deepEqual(new Set(context.unmetPrerequisites), new Set(['power_isolated', 'cooled', 'electrical_damage_excluded']))
})

test('absence of visible marks or disappearing odor does not clear a previously reported electrical incident', () => {
  for (const rawUserText of ['没有烧痕，味道散了，现在能开机了吗？', '温度已经降下来了，清灰换了硅脂，可以通电吗？', '现在没有焦糊味了，可以开机了吗？']) {
    const context = buildDiagnosticContext({rawUserText, speakerId, history})!
    assert.equal(context.incident.status, 'asserted', rawUserText)
    assert.equal(context.damageExclusion, 'unknown', rawUserText)
    assert.ok(!context.allowedChecks.includes('operational_monitoring'), rawUserText)
    assert.ok(context.sources.some(source => source.messageId === 'incident-1'), rawUserText)
  }
})

test('explicit user reports of isolation and cooling satisfy only their own prerequisites', () => {
  const context = buildDiagnosticContext({rawUserText: '我已经拔掉电源线，机器现在完全凉透了，但还没检修，下一步怎么检查？', speakerId, history})!
  assert.equal(context.power, 'off')
  assert.ok(!context.unmetPrerequisites.includes('power_isolated'))
  assert.ok(!context.unmetPrerequisites.includes('cooled'))
  assert.deepEqual(context.allowedChecks, ['static_observation'])
  assert.equal(context.damageExclusion, 'unknown')
})

test('shutdown alone does not establish electrical isolation', () => {
  const context = buildDiagnosticContext({rawUserText: '我已经关机了，接下来怎么检查？', speakerId, history})!
  assert.equal(context.power, 'unknown')
  assert.ok(context.unmetPrerequisites.includes('power_isolated'))
})

test('assistant advice and questions never become evidence that power was disconnected', () => {
  const context = buildDiagnosticContext({rawUserText: '我是不是应该先拔掉电源线？', speakerId, history: [incident, {role: 'assistant', userId: '99', text: '已经拔电源，机器完全凉透了。'}]})!
  assert.equal(context.power, 'unknown')
  assert.ok(context.unmetPrerequisites.includes('cooled'))
  assert.equal(context.sources.some(source => source.userId === '99'), false)
})

test('other users historical statements do not become the current users device state', () => {
  const context = buildDiagnosticContext({rawUserText: '我的电脑满载温度92℃，怎么排查散热？', speakerId, history: [{role: 'user', userId: '303', text: incident.text}]})!
  assert.deepEqual(context.incident.signals, [])
  assert.ok(context.allowedChecks.includes('operational_monitoring'))
  assert.equal(context.sources.length, 1)
})

test('ordinary temperature troubleshooting with denied smoke and odor does not invent an electrical incident', () => {
  const context = buildDiagnosticContext({rawUserText: 'CPU满载92℃，没有焦糊味，也没有冒烟，风扇怎么检查？', speakerId})!
  assert.equal(context.incident.status, 'denied')
  assert.ok(context.allowedChecks.includes('operational_monitoring'))
  assert.ok(!context.unmetPrerequisites.includes('electrical_damage_excluded'))
})

test('hypothetical smoke is discussion rather than a report about the current device', () => {
  const context = buildDiagnosticContext({rawUserText: '假如我的电脑冒烟，应该怎么办？', speakerId})!
  assert.equal(context.incident.status, 'unknown')
  assert.equal(context.purpose, 'discussion')
  assert.deepEqual(context.allowedChecks, [])
})

test('fictional smoke remains figurative and a subsequent real report supersedes the joke', () => {
  const joke = '这张梗图是电脑笑得冒烟，接个梗。'
  const initial = buildDiagnosticContext({rawUserText: joke, speakerId})!
  assert.equal(initial.incident.status, 'figurative')
  assert.equal(initial.purpose, 'figurative')
  assert.deepEqual(initial.allowedChecks, [])
  const actual = buildDiagnosticContext({rawUserText: '这次真的冒烟了，我的电脑怎么办？', speakerId, history: [{role: 'user', userId: speakerId, text: joke}]})!
  assert.equal(actual.incident.status, 'asserted')
  assert.deepEqual(actual.allowedChecks, ['static_observation'])
  const numericMeme = buildDiagnosticContext({rawUserText: '这张梗图是CPU满载92℃冒烟，吐槽一下。', speakerId})!
  assert.equal(numericMeme.purpose, 'figurative', 'a temperature in a meme is still not a request to operate a device')
  assert.deepEqual(numericMeme.allowedChecks, [])
})

test('laughter does not cancel an actual smoke report and double negation is not treated as an all clear', () => {
  for (const rawUserText of ['哈哈，我的电源真的冒烟了，怎么办？', '不是没冒烟，是真的冒烟了，电脑怎么处理？', '不开玩笑，真冒烟了，电脑怎么办？', '刚才是梗图，不过现在我的电源冒烟了，怎么办？']) {
    const context = buildDiagnosticContext({rawUserText, speakerId})!
    assert.equal(context.incident.status, 'asserted', rawUserText)
    assert.ok(!context.allowedChecks.includes('operational_monitoring'), rawUserText)
  }
})

test('a literal question about isolation or a future conditional is not a completed isolation report', () => {
  for (const rawUserText of ['我已经拔掉电源线了吗？', '拔掉电源线之后检查风扇，是这么做吗？']) {
    const context = buildDiagnosticContext({rawUserText, speakerId, history})!
    assert.equal(context.power, 'unknown', rawUserText)
    assert.ok(context.unmetPrerequisites.includes('power_isolated'), rawUserText)
  }
})

test('attributed third-party quote keeps a real incident without assigning it to the current user', () => {
  const quote: TurnEvidence = {origin: 'quote', kind: 'text', state: 'readable', text: '我的电脑有焦糊味，还冒烟了。', speaker: {userId: '303', name: '朋友'}, messageId: 'friend-1'}
  const context = buildDiagnosticContext({rawUserText: '这是朋友转来的，他现在怎么办？', speakerId, evidence: [quote]})!
  assert.equal(context.subject.kind, 'third_party_device')
  assert.equal(context.subject.userId, '303')
  assert.equal(context.incident.status, 'asserted')
  assert.ok(context.sources.some(source => source.origin === 'quote' && source.messageId === 'friend-1'))
})

test('explicit third-party device in the current message does not inherit the current users old incident', () => {
  const context = buildDiagnosticContext({rawUserText: '朋友的电脑只是温度高，没有冒烟，怎么检查风扇？', speakerId, history})!
  assert.equal(context.subject.kind, 'third_party_device')
  assert.equal(context.incident.status, 'denied')
  assert.ok(context.allowedChecks.includes('operational_monitoring'))
  assert.ok(context.sources.every(source => source.origin !== 'history'))
})

test('unread or unattributed quote and generic tool prose cannot establish current electrical clearance', () => {
  const evidence: TurnEvidence[] = [
    {origin: 'quote', kind: 'text', state: 'readable', text: '维修师傅检查完了，确认没有电气损坏。'},
    {origin: 'tool', kind: 'text', state: 'readable', text: '维修师傅检查完了，确认没有电气损坏。', toolName: 'webSearch'},
    {origin: 'quote', kind: 'image', state: 'reference_only', speaker: {userId: '303'}, source: 'image-ref'}
  ]
  const context = buildDiagnosticContext({rawUserText: '上面这个能说明我的电脑可以通电了吗？', speakerId, history, evidence})!
  assert.equal(context.damageExclusion, 'unknown')
  assert.ok(!context.allowedChecks.includes('operational_monitoring'))
})

test('only explicit completed professional repair and clearance of the same device permits conditional operation', () => {
  const context = buildDiagnosticContext({rawUserText: '维修师傅已经给我的电脑检查完了，确认没有电气损坏，现在怎么检查风扇？', speakerId, history})!
  assert.equal(context.incident.status, 'asserted', 'past reported incident remains part of the history')
  assert.equal(context.damageExclusion, 'reported_professional_clearance')
  assert.ok(context.allowedChecks.includes('operational_monitoring'))
  assert.ok(!context.unmetPrerequisites.includes('electrical_damage_excluded'))
})

test('pending, uncertain, hypothetical or visual-only inspection does not certify electrical clearance', () => {
  for (const rawUserText of [
    '如果维修师傅检查完了，确认没有电气损坏，能开机吗？',
    '维修师傅还没检修完，没排除电气损坏，可以开机吗？',
    '维修师傅说外面看着没烧痕，能开机吗？',
    '我看过没有烧痕，应该没有电气损坏，可以开机吗？',
    '维修师傅检查完了，确认没有电气损坏了吗？',
    '等维修师傅检查完了，确认没有电气损坏再开机。',
    '待专业人员检修完成，确认没有电气损坏以后再通电。'
  ]) {
    const context = buildDiagnosticContext({rawUserText, speakerId, history})!
    assert.equal(context.damageExclusion, 'unknown', rawUserText)
    assert.ok(!context.allowedChecks.includes('operational_monitoring'), rawUserText)
  }
})

test('quoted assistant advice in a user archive is not a report of completed repair or isolation', () => {
  for (const quote of [
    '[回复 希洛：等维修师傅检查完了，确认没有电气损坏再开机] 我看了，暂时没烧痕。',
    '[回复 希洛(消息ID:old)的消息: "维修师傅检查完了，确认没有电气损坏。已经拔掉电源线了。"] 我看了没烧痕。',
    '[回复 希洛：已经拔掉电源线，[步骤1]维修师傅检查完了，确认没有电气损坏] 我看了没烧痕。',
    '你刚才说“维修师傅检查完了，确认没有电气损坏”，我还没找人检修。',
    '[陌生格式：维修师傅检查完了，确认没有电气损坏。已经拔掉电源线了] 我没有看到烧痕。',
    '[回复 希洛：已经拔掉电源线，维修师傅检查完了，确认没有电气损坏。'
  ]) {
    const context = buildDiagnosticContext({rawUserText: '没有烧痕，现在能开机吗？', speakerId, history: [...history, {role: 'user', userId: speakerId, text: quote}]})!
    assert.equal(context.damageExclusion, 'unknown', quote)
    assert.equal(context.power, 'unknown', quote)
    assert.ok(!context.allowedChecks.includes('operational_monitoring'), quote)
  }
})

test('a valid completed repair report outside a known quote wrapper can still supply current evidence', () => {
  const context = buildDiagnosticContext({rawUserText: '[回复 希洛：别急着开机] 维修师傅已经给我的电脑检查完了，确认没有电气损坏，现在怎么检查风扇？', speakerId, history})!
  assert.equal(context.damageExclusion, 'reported_professional_clearance')
  assert.ok(context.allowedChecks.includes('operational_monitoring'))
})

test('a current denial of disconnection retracts stale isolation and a report of renewed power also resets cooling', () => {
  const disconnected: DiagnosticHistoryMessage = {role: 'user', userId: speakerId, text: '我已经拔掉电源线了，机器完全凉透了。', at: Date.now() - 1000}
  for (const rawUserText of ['我没有拔掉电源线，怎么检查？', '电源线没拔，怎么检查风扇？']) {
    const context = buildDiagnosticContext({rawUserText, speakerId, history: [...history, disconnected]})!
    assert.equal(context.power, 'unknown', rawUserText)
    assert.ok(context.unmetPrerequisites.includes('power_isolated'), rawUserText)
  }
  const reconnected = buildDiagnosticContext({rawUserText: '我又插上了电源线，现在还很热，怎么检查？', speakerId, history: [...history, disconnected]})!
  assert.equal(reconnected.power, 'on')
  assert.ok(reconnected.unmetPrerequisites.includes('power_isolated'))
  assert.ok(reconnected.unmetPrerequisites.includes('cooled'))
})

test('recent timestamped user reports establish transient state while an old real incident remains unresolved', () => {
  const now = Date.parse('2026-10-15T06:00:00+08:00')
  const context = buildDiagnosticContext({rawUserText: '下一步怎么检查风扇？', speakerId, now, history: [
    {...incident, at: now - 2 * 86400_000},
    {role: 'user', userId: speakerId, text: '我已经拔掉电源线，机器完全凉透了。', at: now - 4 * 60_000}
  ]})!
  assert.equal(context.incident.status, 'asserted')
  assert.equal(context.power, 'off')
  assert.ok(!context.unmetPrerequisites.includes('power_isolated'))
  assert.ok(!context.unmetPrerequisites.includes('cooled'))
  assert.ok(context.unmetPrerequisites.includes('electrical_damage_excluded'))
})

test('cross-day, over-budget, undated, invalid and future physical states cannot satisfy current prerequisites', () => {
  const now = Date.parse('2026-10-15T06:00:00+08:00')
  const timestamps: Partial<DiagnosticHistoryMessage>[] = [
    {at: now - 86400_000}, {at: now - 5 * 60_000 - 1}, {}, {at: Number.NaN}, {at: now + 6000},
    {time: '2026-10-15 05:59:00'}, {time: 'not-a-time'}
  ]
  for (const timestamp of timestamps) {
    const context = buildDiagnosticContext({rawUserText: '现在怎么检查风扇？', speakerId, now, history: [
      {...incident, at: now - 2 * 86400_000},
      {role: 'user', userId: speakerId, text: '我已经拔掉电源线，机器完全凉透了。', ...timestamp}
    ]})!
    assert.equal(context.power, 'unknown', JSON.stringify(timestamp))
    assert.ok(context.unmetPrerequisites.includes('power_isolated'), JSON.stringify(timestamp))
    assert.ok(context.unmetPrerequisites.includes('cooled'), JSON.stringify(timestamp))
    assert.equal(context.incident.status, 'asserted', 'an old incident is not automatically cleared by passage of time')
    assert.ok(!context.allowedChecks.includes('operational_monitoring'))
  }
})

test('explicit-offset ISO and epoch millisecond compatibility timestamps have the same freshness', () => {
  const now = Date.parse('2026-10-15T06:00:00+08:00')
  for (const time of ['2026-10-15T05:59:00+08:00', now - 60_000]) {
    const context = buildDiagnosticContext({rawUserText: '现在怎么检查风扇？', speakerId, now, history: [incident,
      {role: 'user', userId: speakerId, text: '我已经拔掉电源线，机器已经完全凉透了。', time}
    ]})!
    assert.equal(context.power, 'off')
    assert.ok(!context.unmetPrerequisites.includes('cooled'))
  }
})

test('current direct reports remain usable despite undated historical observations', () => {
  const context = buildDiagnosticContext({rawUserText: '我已经拔掉电源线，机器完全凉透了，下一步怎么检查？', speakerId, now: 1000, history})!
  assert.equal(context.power, 'off')
  assert.ok(!context.unmetPrerequisites.includes('cooled'))
  assert.ok(context.unmetPrerequisites.includes('electrical_damage_excluded'))
})

test('a newly real incident resets old cooling even when earlier isolation was recently reported', () => {
  const now = Date.now()
  const context = buildDiagnosticContext({rawUserText: '我重新插上了电源线，现在机箱真的冒烟了，怎么办？', speakerId, now, history: [incident,
    {role: 'user', userId: speakerId, text: '我已经拔掉电源线，机器完全凉透了。', at: now - 1000}
  ]})!
  assert.equal(context.power, 'on')
  assert.ok(context.unmetPrerequisites.includes('cooled'))
  assert.ok(context.unmetPrerequisites.includes('electrical_damage_excluded'))
})

test('professional clearance of another device is not clearance of the earlier incident device', () => {
  const context = buildDiagnosticContext({rawUserText: '我的电脑还是没检修，朋友的电脑维修师傅检查完了，确认没有电气损坏。我的电脑现在能通电吗？', speakerId, history})!
  assert.equal(context.damageExclusion, 'unknown')
  assert.ok(!context.allowedChecks.includes('operational_monitoring'))
})

test('another device has its own conditions and a later new real incident invalidates earlier clearance', () => {
  const different = buildDiagnosticContext({rawUserText: '我的另一台电脑没有焦糊味，满载温度偏高，怎么排查散热？', speakerId, history})!
  assert.equal(different.incident.status, 'denied')
  assert.ok(different.allowedChecks.includes('operational_monitoring'))
  const again = buildDiagnosticContext({rawUserText: '我又开机了，现在真的冒烟了，怎么办？', speakerId, history: [...history, {role: 'user', userId: speakerId, text: '维修师傅检查完了，确认没有电气损坏。'}]})!
  assert.equal(again.damageExclusion, 'unknown')
  assert.equal(again.power, 'on')
  assert.ok(!again.allowedChecks.includes('operational_monitoring'))
})

test('explicit correction of a false report updates only the corrected signal', () => {
  const context = buildDiagnosticContext({rawUserText: '刚才说错了，并没有真的冒烟，是水汽，但确实有焦糊味，电脑怎么处理？', speakerId, history})!
  assert.equal(context.incident.status, 'asserted', 'retracting smoke does not retract a separately reported burning odor')
  assert.equal(context.damageExclusion, 'unknown')
  assert.ok(!context.allowedChecks.includes('operational_monitoring'))
})

test('unrelated chat does not keep injecting an old incident', () => {
  for (const rawUserText of ['今天这碗面挺辣的。', '别聊电脑了，今天晚饭吃啥？', '电脑边上这碗面真好吃。', '谢谢你，讲得很清楚。', '这碗面有焦糊味，不过很好吃。', '厨房那锅菜烧焦了。']) {
    assert.equal(buildDiagnosticContext({rawUserText, speakerId, history}), undefined, rawUserText)
  }
})

test('prompt renders factual provenance and unmet step conditions without a canned user-facing answer', () => {
  const context = buildDiagnosticContext({rawUserText: '没有烧痕，现在能通电了吗？', speakerId, history})!
  const prompt = buildDiagnosticContextPrompt(context)
  assert.match(prompt, /本轮排障前提/)
  assert.match(prompt, /静态观察/)
  assert.match(prompt, /电气损坏仍未排除/)
  assert.match(prompt, /history\/incident-1/)
  assert.equal(buildDiagnosticContextPrompt(undefined), '')
})
