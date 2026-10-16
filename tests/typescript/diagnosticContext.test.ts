import {test} from 'node:test'
import assert from 'node:assert/strict'
import {buildDiagnosticContext, buildDiagnosticContextPrompt, buildDiagnosticFallbackReply, validateDiagnosticReply} from '../../src/modules/conversation/domain/diagnosticContext.js'
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

test('asking for seriousness does not turn an electrical incident into a joke', () => {
  for (const seriousness of ['别开玩笑', '不要开玩笑了', '别再跟我开玩笑', '我没有在开玩笑', '这不是个玩笑', '这不是梗']) {
    const rawUserText = `电脑电源那里有焦糊味，已经拔电了。${seriousness}，能怎么办？`
    const context = buildDiagnosticContext({rawUserText, speakerId})!
    assert.equal(context.purpose, 'troubleshooting', rawUserText)
    assert.equal(context.incident.status, 'asserted', rawUserText)
    assert.equal(context.power, 'off', rawUserText)
    assert.deepEqual(context.allowedChecks, ['static_observation'], rawUserText)
    assert.ok(context.unmetPrerequisites.includes('electrical_damage_excluded'), rawUserText)
  }
})

test('an explicitly genuine joke stays figurative even beside a request not to joke about something else', () => {
  for (const rawUserText of [
    '这真的是个梗：电脑都冒烟了，接一下。',
    '电脑冒烟只是个玩笑，没有现实故障。',
    '别开玩笑是台词，图里的电脑笑得冒烟只是梗图。'
  ]) {
    const context = buildDiagnosticContext({rawUserText, speakerId})!
    assert.equal(context.purpose, 'figurative', rawUserText)
    assert.equal(context.incident.status, 'figurative', rawUserText)
    assert.deepEqual(context.allowedChecks, [], rawUserText)
  }
})

test('quoted joke wording does not override the speakers separate real incident', () => {
  const context = buildDiagnosticContext({rawUserText: '[回复 朋友：这只是个玩笑，电脑笑得冒烟] 我的电脑电源有焦糊味，已经拔了电，怎么办？', speakerId})!
  assert.equal(context.incident.status, 'asserted')
  assert.equal(context.purpose, 'troubleshooting')
  assert.equal(context.power, 'off')
})

test('ordinary completed colloquial disconnection reports retain isolation in the immediate next turn', () => {
  const now = Date.parse('2026-10-15T06:00:00+08:00')
  for (const disconnected of ['已拔电', '已经拔电', '已经拔电了', '拔了电', '我已经拔了电', '拔电了', '刚刚拔掉了电']) {
    const rawUserText = `电脑电源有焦糊味，${disconnected}。别开玩笑，能怎么办？`
    const initial = buildDiagnosticContext({rawUserText, speakerId, now})!
    assert.equal(initial.power, 'off', disconnected)
    const next = buildDiagnosticContext({rawUserText: '那我能先开机试一下吗？', speakerId, now: now + 1000, history: [{role: 'user', userId: speakerId, text: rawUserText, at: now}]})!
    assert.equal(next.incident.status, 'asserted', disconnected)
    assert.equal(next.power, 'off', disconnected)
    assert.deepEqual(next.allowedChecks, ['static_observation'], disconnected)
    assert.ok(!next.unmetPrerequisites.includes('power_isolated'), disconnected)
    assert.ok(next.unmetPrerequisites.includes('electrical_damage_excluded'), disconnected)
  }
})

test('negating colloquial disconnection retracts isolation rather than matching its completed suffix', () => {
  const now = Date.parse('2026-10-15T06:00:00+08:00')
  const isolated: DiagnosticHistoryMessage = {role: 'user', userId: speakerId, text: '电脑有焦糊味，我已经拔电了。', at: now - 1000}
  for (const rawUserText of ['我没有拔电，怎么检查？', '其实我还没拔电，怎么办？', '电没拔，怎么排查？', '我并没有拔了电，只关机了。怎么检查？', '我不是已经拔了电，只关机了。怎么检查？']) {
    const context = buildDiagnosticContext({rawUserText, speakerId, now, history: [isolated]})!
    assert.equal(context.incident.status, 'asserted', rawUserText)
    assert.equal(context.power, 'unknown', rawUserText)
    assert.ok(context.unmetPrerequisites.includes('power_isolated'), rawUserText)
  }
})

test('uncompleted, hypothetical, uncertain or partial component disconnections do not prove isolation', () => {
  for (const report of ['拔电', '我已经拔电了吗？', '如果我已经拔电了', '我打算拔了电', '稍后我已经拔电了再检查', '可能已经拔电了', '我已经拔电池了', '已经拔了电容']) {
    const context = buildDiagnosticContext({rawUserText: `电脑有焦糊味。${report}。`, speakerId})!
    assert.equal(context.power, 'unknown', report)
    if (context.purpose === 'troubleshooting') assert.ok(context.unmetPrerequisites.includes('power_isolated'), report)
  }
})

test('a third partys colloquial disconnection does not establish the current users isolation', () => {
  const now = Date.parse('2026-10-15T06:00:00+08:00')
  for (const rawUserText of [
    '[回复 朋友：我已经拔电了] 我的电脑有焦糊味，怎么办？',
    '朋友说他已经拔电了，我的电脑有焦糊味，怎么办？',
    '朋友的电脑已经拔了电。我的电脑有焦糊味，怎么办？'
  ]) {
    const context = buildDiagnosticContext({rawUserText, speakerId, now})!
    assert.equal(context.subject.kind, 'speaker_device', rawUserText)
    assert.equal(context.incident.status, 'asserted', rawUserText)
    assert.equal(context.power, 'unknown', rawUserText)
  }
  const otherSpeaker = buildDiagnosticContext({rawUserText: '我的电脑有焦糊味，现在怎么检查？', speakerId, now, history: [{role: 'user', userId: '303', text: '我的电脑有焦糊味，已经拔电了。', at: now - 1000}]})!
  assert.equal(otherSpeaker.power, 'unknown')
  assert.equal(otherSpeaker.sources.length, 1)
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

test('the frozen real-fault three-turn wording updates reported cooling and professional clearance', () => {
  // Exact user turns from real-burning-fault-no-visible-mark-then-inspection.
  const inputs = [
    '认真问：我的台式机刚才有焦糊味，机箱后面还冒烟了，我现在该怎么处理？',
    '认真问：已经断电放凉了，外面也看不到烧痕，味道散了。那我能开机测一下吗？',
    '维修师傅已经检查了刚才这台机器的电源、线材和板卡，更换了损坏电源，确认没有其他电气损坏，并让我在店里做受控开机。认真问：这时能先测什么？'
  ]
  const now = Date.parse('2026-10-15T06:00:00+08:00')
  const prior: DiagnosticHistoryMessage[] = []
  const contexts = inputs.map((rawUserText, turnIndex) => {
    const context = buildDiagnosticContext({rawUserText, speakerId, now: now + turnIndex * 1000, history: prior})!
    prior.push({role: 'user', userId: speakerId, text: rawUserText, at: now + turnIndex * 1000})
    return context
  })
  assert.equal(contexts[0]!.incident.status, 'asserted')
  assert.deepEqual(contexts[0]!.allowedChecks, ['static_observation'])
  assert.equal(contexts[1]!.power, 'off')
  assert.deepEqual(contexts[1]!.unmetPrerequisites, ['electrical_damage_excluded'])
  assert.deepEqual(contexts[1]!.allowedChecks, ['static_observation'], 'cooling and no marks do not clear damage')
  const cleared = contexts[2]!
  assert.equal(cleared.incident.status, 'asserted', 'the initial incident remains in the history')
  assert.equal(cleared.sources.at(-1)!.incidentStatus, 'denied', 'no other electrical damage is a negation')
  assert.equal(cleared.damageExclusion, 'reported_professional_clearance')
  assert.ok(cleared.allowedChecks.includes('operational_monitoring'))
  assert.ok(!cleared.unmetPrerequisites.includes('electrical_damage_excluded'))
})

test('completed professional clearance accepts limited negative modifiers and a separate next-step question', () => {
  for (const negativeFinding of ['没有其他电气损坏', '没有其他的电气损坏', '不存在任何其他供电故障', '无其余电路问题']) {
    const rawUserText = `维修师傅已经检查了我的电脑，确认${negativeFinding}。现在能开机吗？`
    const context = buildDiagnosticContext({rawUserText, speakerId, history})!
    assert.equal(context.damageExclusion, 'reported_professional_clearance', rawUserText)
    assert.ok(context.allowedChecks.includes('operational_monitoring'), rawUserText)
    assert.equal(context.power, 'unknown', 'inspection does not report current power isolation')
  }
})

test('negative, interrogative and future versions of the repaired-device report never grant clearance', () => {
  for (const rawUserText of [
    '维修师傅还没检查这台机器，不能确认没有其他电气损坏。现在能开机吗？',
    '维修师傅已经检查了这台机器，但没有确认没有其他电气损坏。',
    '专业人员检查完了，但还不能排除其他电气损坏。',
    '维修师傅已经检查了这台机器，尚未排除其他电气损坏。',
    '维修师傅已经检查了这台机器，确认没有其他电气损坏了吗？',
    '维修师傅已经检查了这台机器，确认没有其他电气损坏？',
    '维修师傅已经检查了这台机器，确认没有其他电气损坏?',
    '维修师傅是否已经检查了这台机器，确认没有其他电气损坏？',
    '如果维修师傅已经检查了这台机器，确认没有其他电气损坏，我能开机吗？',
    '等维修师傅检查完了这台机器，确认没有其他电气损坏再开机。',
    '维修师傅准备检查完这台机器，确认没有其他电气损坏。',
    '维修师傅明天检查完这台机器，确认没有其他电气损坏。'
  ]) {
    const context = buildDiagnosticContext({rawUserText, speakerId, history})!
    assert.equal(context.damageExclusion, 'unknown', rawUserText)
    assert.ok(!context.allowedChecks.includes('operational_monitoring'), rawUserText)
  }
})

test('a current correction retracts an earlier reported professional clearance', () => {
  const context = buildDiagnosticContext({rawUserText: '刚才说错了，维修师傅根本没有检查这台机器，也没有确认是否安全。现在怎么办？', speakerId, history: [...history,
    {role: 'user', userId: speakerId, text: '维修师傅已经检查了我的电脑，确认没有其他电气损坏。'}
  ]})!
  assert.equal(context.damageExclusion, 'unknown')
  assert.ok(!context.allowedChecks.includes('operational_monitoring'))
})

test('the same repaired-device wording about another device or speaker does not clear the current incident', () => {
  for (const rawUserText of [
    '维修师傅已经检查了朋友的电脑，更换了损坏电源，确认没有其他电气损坏。我的电脑现在能通电吗？',
    '维修师傅已经检查了另一台机器，更换了损坏电源，确认没有其他电气损坏。我的电脑现在能通电吗？'
  ]) {
    const context = buildDiagnosticContext({rawUserText, speakerId, history})!
    assert.equal(context.damageExclusion, 'unknown', rawUserText)
    assert.ok(!context.allowedChecks.includes('operational_monitoring'), rawUserText)
  }
  const otherSpeaker = buildDiagnosticContext({rawUserText: '我的电脑现在能通电吗？', speakerId, history: [...history,
    {role: 'user', userId: '303', text: '维修师傅已经检查了刚才这台机器，更换了损坏电源，确认没有其他电气损坏。'}
  ]})!
  assert.equal(otherSpeaker.damageExclusion, 'unknown')
  assert.ok(!otherSpeaker.allowedChecks.includes('operational_monitoring'))
})

test('punctuation-only questions and pending cooling cannot become current physical-state reports', () => {
  for (const rawUserText of [
    '我已经拔掉电源线？机器完全凉透了？',
    '我已经拔掉电源线?机器完全放凉了?',
    '等机器完全放凉了，再拔掉电源线检查。'
  ]) {
    const context = buildDiagnosticContext({rawUserText, speakerId, history})!
    assert.equal(context.power, 'unknown', rawUserText)
    assert.ok(context.unmetPrerequisites.includes('cooled'), rawUserText)
  }
  const stillHot = buildDiagnosticContext({rawUserText: '已经断电了，但是还没放凉，怎么检查？', speakerId, history})!
  assert.equal(stillHot.power, 'off')
  assert.ok(stillHot.unmetPrerequisites.includes('cooled'))
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
  for (const rawUserText of ['今天这碗面挺辣的。', '别聊电脑了，今天晚饭吃啥？', '电脑边上这碗面真好吃。', '谢谢你，讲得很清楚。', '这碗面有焦糊味，不过很好吃。', '厨房那锅菜烧焦了。', '换个话题，那我现在该怎么做？', '先不聊这个，下一步呢？', '那我明天做饭该怎么办？']) {
    assert.equal(buildDiagnosticContext({rawUserText, speakerId, history}), undefined, rawUserText)
  }
})

test('short follow-ups keep unresolved diagnostic prerequisites without inventing execution', () => {
  for (const rawUserText of ['下一步呢？', '那我现在该怎么做？', '能试试了吗？', '然后呢？', '那现在怎么办？', '我现在应该做什么？']) {
    const context = buildDiagnosticContext({rawUserText, speakerId, history})!
    assert.ok(context, rawUserText)
    assert.equal(context.incident.status, 'asserted', rawUserText)
    assert.equal(context.power, 'unknown', rawUserText)
    assert.equal(context.damageExclusion, 'unknown', rawUserText)
    assert.deepEqual(context.allowedChecks, ['static_observation'], rawUserText)
    assert.ok(context.unmetPrerequisites.includes('electrical_damage_excluded'), rawUserText)
  }
})

test('short follow-ups alone do not create device context after unrelated history', () => {
  for (const rawUserText of ['下一步呢？', '那我现在该怎么做？', '能试试了吗？']) {
    const context = buildDiagnosticContext({rawUserText, speakerId, history: [{role: 'user', userId: speakerId, text: '今天这碗面真好吃。'}]})
    assert.equal(context, undefined, rawUserText)
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

test('clearance prompt bounds the confirmed scope and separates user monitoring from internal powered work', () => {
  const context = buildDiagnosticContext({rawUserText: '维修师傅已经检查了我的电脑，确认没有其他电气损坏。现在能先测什么？', speakerId, history})!
  const prompt = buildDiagnosticContextPrompt(context)
  assert.match(prompt, /检修放行仅覆盖报告确认的对象、故障与检查范围/)
  assert.match(prompt, /外壳复原.*非接触运行监测/)
  assert.match(prompt, /必须先关机、拔下电源线并确认隔离/)
  assert.match(prompt, /内部带电检测的步骤交现场专业人员/)
  assert.match(prompt, /初步点亮、BIOS读数或短时运行不能证明整机安全/)
  assert.doesNotMatch(prompt, /电气损坏仍未排除/)
})

test('temperature prompt requires the component, measurement and workload basis without inventing an accident', () => {
  const context = buildDiagnosticContext({rawUserText: '认真问另一个情况：CPU满载82℃，没有焦糊味，也没有冒烟，一直正常运行。我只想了解这个温度该怎么判断。', speakerId})!
  const prompt = buildDiagnosticContextPrompt(context)
  assert.equal(context.incident.status, 'denied')
  assert.ok(context.allowedChecks.includes('operational_monitoring'))
  assert.match(prompt, /具体部件型号、测点与负载等依据/)
  assert.match(prompt, /单个温度读数本身不能保证正常或安全/)
  assert.match(prompt, /正常运行、无烟无味或自动降频保护都不是整机健康证明/)
  assert.doesNotMatch(prompt, /电气损坏仍未排除/)
})

test('symptom reports remain observations rather than professional damage findings', () => {
  for (const rawUserText of ['电脑电源那里有焦糊味，已经拔电了。别开玩笑，能怎么办？', '机箱冒烟了，看着像电源坏了，怎么办？', '电脑有烧塑料味，是不是主板烧了？']) {
    const context = buildDiagnosticContext({rawUserText, speakerId})!
    assert.equal(context.evidenceAssessment?.damage.status, 'unconfirmed', rawUserText)
    assert.deepEqual(context.evidenceAssessment?.damage.findings, [], rawUserText)
  }
})

test('reported professional findings retain the component and the strength of the finding', () => {
  const context = buildDiagnosticContext({rawUserText: '维修师傅已经检查了我的电脑，确认电源损坏，更换了损坏电源，确认没有其他电气损坏。', speakerId, history})!
  assert.equal(context.evidenceAssessment?.damage.status, 'reported_professional_finding')
  assert.deepEqual(context.evidenceAssessment?.damage.components, ['power_supply'])
  assert.equal(context.damageExclusion, 'reported_professional_clearance')
  assert.deepEqual(validateDiagnosticReply('按你报告的检修结果，电源已经损坏并被更换。', context), [])
  assert.ok(validateDiagnosticReply('所以电源已经烧坏了。', context).some(item => item.code === 'unsupported_damage_diagnosis'), 'damage is not automatically a confirmed burn')
  assert.ok(validateDiagnosticReply('主板已经烧坏了。', context).some(item => item.code === 'unsupported_damage_diagnosis'), 'a finding about the power supply cannot diagnose the mainboard')
  const burned = buildDiagnosticContext({rawUserText: '维修师傅检查了我的电脑，确认电源烧坏了。', speakerId, history})!
  assert.deepEqual(validateDiagnosticReply('按你报告的检修结果，电源已经烧坏了。', burned), [])
})

test('future, speculative, quoted and other-device findings never become the current devices diagnosis', () => {
  for (const rawUserText of [
    '维修师傅明天来检查，怀疑电源烧坏了。我的电脑现在怎么办？',
    '维修师傅检查了我的电脑，说可能是电源烧坏了。',
    '维修师傅检查了我的电脑，确认还要检查，主板应该也坏了。',
    '[回复 朋友：维修师傅检查了电脑，确认电源烧坏] 我的电脑有焦糊味，怎么办？',
    '维修师傅检查了朋友的电脑，确认电源烧坏。我的电脑有焦糊味，怎么办？'
  ]) {
    const context = buildDiagnosticContext({rawUserText, speakerId, history})!
    assert.equal(context.evidenceAssessment?.damage.status, 'unconfirmed', rawUserText)
    assert.ok(validateDiagnosticReply('你这台电脑的电源已经烧坏了。', context).some(item => item.code === 'unsupported_damage_diagnosis'), rawUserText)
  }
})

test('a new incident does not inherit the diagnosis of a previously replaced part', () => {
  const repaired: DiagnosticHistoryMessage = {role: 'user', userId: speakerId, text: '维修师傅已经检查了我的电脑，确认电源烧坏，更换了损坏电源，确认没有其他电气损坏。'}
  const context = buildDiagnosticContext({rawUserText: '换好之后现在又冒烟了，怎么办？', speakerId, history: [incident, repaired]})!
  assert.equal(context.damageExclusion, 'unknown')
  assert.equal(context.evidenceAssessment?.damage.status, 'unconfirmed')
  assert.ok(validateDiagnosticReply('换上的电源已经烧坏了。', context).some(item => item.code === 'unsupported_damage_diagnosis'))
  const compatible = buildDiagnosticContext({rawUserText: '现在怎么检查风扇？', speakerId, history: [incident, repaired]})!
  delete compatible.evidenceAssessment
  assert.deepEqual(validateDiagnosticReply('按你报告的维修结果，之前电源烧坏并被更换。', compatible), [])
})

test('unknown temperature prerequisites are explicit and become known only from same-device user reports', () => {
  const unknown = buildDiagnosticContext({rawUserText: '电脑满载82℃，没有焦糊味，没有冒烟，正常吗？', speakerId})!
  assert.deepEqual(unknown.evidenceAssessment?.temperature?.missing, ['component_model', 'measurement_point'])
  assert.deepEqual(unknown.evidenceAssessment?.temperature?.readings, ['82℃'])
  const knownText = '我的电脑 CPU 型号是 i7-13700K，读数是 CPU Package 温度82℃，运行 Cinebench 满载。'
  const known = buildDiagnosticContext({rawUserText: knownText, speakerId})!
  assert.deepEqual(known.evidenceAssessment?.temperature?.missing, [])
  assert.equal(known.evidenceAssessment?.temperature?.componentModel, 'i7-13700K')
  const revised = buildDiagnosticContext({rawUserText: '刚才型号说错了，我不知道型号，也不清楚测点，温度还是82℃。', speakerId, history: [{role: 'user', userId: speakerId, text: knownText}]})!
  assert.ok(revised.evidenceAssessment?.temperature?.missing.includes('component_model'))
  assert.ok(revised.evidenceAssessment?.temperature?.missing.includes('measurement_point'))
  const other = buildDiagnosticContext({rawUserText: '朋友的电脑型号是i7-13700K，CPU Package 满载82℃。我的电脑温度82℃，不知道什么负载。', speakerId})!
  assert.deepEqual(other.evidenceAssessment?.temperature?.missing, ['component_model', 'measurement_point', 'workload'])
  const hypothetical = buildDiagnosticContext({rawUserText: '如果型号是i7-13700K，假如读的是CPU Package，假设满载82℃呢？', speakerId, history: [{role: 'user', userId: speakerId, text: '我的电脑温度82℃，型号和测点都不清楚。'}]})!
  assert.deepEqual(hypothetical.evidenceAssessment?.temperature?.missing, ['component_model', 'measurement_point', 'workload'])
})

test('diagnostic reply validation rejects observed unjustified certainty without changing the candidate', () => {
  const context = buildDiagnosticContext({rawUserText: '电脑电源那里有焦糊味，已经拔电了。别开玩笑，能怎么办？', speakerId})!
  for (const reply of [
    '焦糊味本身就是检测结果了——里面已经有元件烧坏。',
    '焦糊味说明里面大概率已经有东西烧了。',
    '电源多半已经损坏，必须更换。',
    '电源很可能已经烧毁了。'
  ]) {
    const before = reply
    const violations = validateDiagnosticReply(reply, context)
    assert.ok(violations.some(item => item.code === 'unsupported_damage_diagnosis'), reply)
    assert.ok(violations.every(item => item.claim && item.reason && item.correctionInstruction), reply)
    assert.equal(reply, before)
  }
})

test('diagnostic validation preserves explicit uncertainty, quoted examples, denials and inspection questions', () => {
  const context = buildDiagnosticContext({rawUserText: '电脑电源有焦糊味，已经拔电了，怎么办？', speakerId})!
  for (const reply of [
    '光凭焦糊味不能确定里面有元件烧坏，先保持断电并送检。',
    '可能是电源或线材过热，也不能排除元件损坏，需要现场检查。',
    '有焦糊味不一定是元件烧坏。',
    '“里面已经有元件烧坏”这个结论现在还不能下。',
    '先请维修人员检查电源是否烧坏。',
    '电源烧坏时可能出现异味，但气味本身不能定位损坏。',
    '等专业人员完成检修并放行之后，再按他们的要求通电检测。',
    '不要再次通电，也不要开机试探。'
  ]) assert.deepEqual(validateDiagnosticReply(reply, context), [], reply)
})

test('asking a follow-up condition cannot undo an earlier unsupported temperature assurance', () => {
  const context = buildDiagnosticContext({rawUserText: 'CPU满载82℃，没有焦糊味，也没有冒烟，温度正常吗？', speakerId})!
  for (const reply of ['82℃属于正常范围，你是什么型号？', '这温度很正常，先说说测点。', '不算高，可以放心用。', '目前基本没问题。']) {
    assert.ok(validateDiagnosticReply(reply, context).some(item => item.code === 'unsupported_temperature_assurance'), reply)
  }
  for (const reply of [
    '还不知道型号与测点，单凭82℃不能判断正常与否。',
    '先查型号、测点与负载，再对照该部件的规格确认是否正常。',
    '有些型号满载82℃可能处在预期范围，你的设备还需要具体型号和测点。',
    '正常运行或没有烟味，也不能证明整机健康。'
  ]) assert.deepEqual(validateDiagnosticReply(reply, context), [], reply)
})

test('operational checks require current professional clearance and professional clearance remains scoped', () => {
  const fault = buildDiagnosticContext({rawUserText: '已经拔电了，能开机试一下吗？', speakerId, history})!
  assert.ok(validateDiagnosticReply('先重新开机跑一下压力测试。', fault).some(item => item.code === 'unmet_operational_prerequisite'))
  assert.ok(validateDiagnosticReply('如果你想确认，先开机看看。', fault).some(item => item.code === 'unmet_operational_prerequisite'), 'an arbitrary if is not professional clearance')
  assert.ok(validateDiagnosticReply('等维修人员完成检修并放行后，再通电检测。现在先开机试试。', fault).some(item => item.code === 'unmet_operational_prerequisite'), 'a prior conditional sentence does not permit operating now')
  assert.deepEqual(validateDiagnosticReply('等维修人员检查完成并明确放行之后，才能再通电检测。', fault), [])
  const cleared = buildDiagnosticContext({rawUserText: '维修师傅已经检查了我的电脑，更换了损坏电源，确认没有其他电气损坏，允许在店里受控开机。', speakerId, history})!
  assert.ok(validateDiagnosticReply('电气损坏仍未排除，所以绝对不能通电。', cleared).some(item => item.code === 'contradicted_professional_clearance'))
  assert.ok(validateDiagnosticReply('既然师傅修过了，整机肯定没有问题，保证绝对安全。', cleared).some(item => item.code === 'unsupported_safety_certification'))
  assert.deepEqual(validateDiagnosticReply('按现场放行范围，外壳复原后可做非接触运行监测；若出现新的烟味就停止并联系检修人员。', cleared), [])
})

test('a denial about another conclusion or action never hides an unsupported operation', () => {
  const context = buildDiagnosticContext({rawUserText: '电脑电源有焦糊味，已经拔电了，怎么办？', speakerId})!
  for (const reply of [
    '先开机观察别摸内部。',
    '不能确定哪个部件坏了但可以先开机看一下。',
    '不要摸内部，先开机观察一下。',
    '不要摸内部先开机看一下。',
    '先把电源插回去。',
    '先把电源线插回去，再观察。',
    '先插回电源线看看。',
    '别拆内部但可以先通电测一下。'
  ]) assert.ok(validateDiagnosticReply(reply, context).some(item => item.code === 'unmet_operational_prerequisite'), reply)
  for (const reply of [
    '不要再次通电，也不要开机试探。',
    '先别开机，别把电源插回去。',
    '不建议重新给电脑通电。',
    '不要把电源线插回去。',
    '等专业人员完成检修并放行之后，再把电源线插回去做检测。',
    '不能确定哪个部件坏了，但先不要开机试探。'
  ]) assert.deepEqual(validateDiagnosticReply(reply, context), [], reply)
})

test('a later qualified health claim cannot hide an earlier temperature assurance', () => {
  const context = buildDiagnosticContext({rawUserText: '电脑温度82℃，型号和测点不清楚，正常吗？', speakerId})!
  for (const reply of [
    '温度不高但不能确认整机健康。',
    '可以正常使用。',
    '82℃很正常不过这不能证明整机安全。',
    '还不能确定整机健康但温度属于正常范围。',
    '这温度很正常，可以安全运行。'
  ]) assert.ok(validateDiagnosticReply(reply, context).some(item => item.code === 'unsupported_temperature_assurance'), reply)
  for (const reply of [
    '还不能判断温度是否正常，不过可以先确认型号和测点。',
    '先对照型号与测点对应的规格，再确认是否可以正常使用。',
    '你报告一直正常运行，但这不代表温度正常或整机健康。'
  ]) assert.deepEqual(validateDiagnosticReply(reply, context), [], reply)
})

test('quoted operation advice is checked unless explicitly used as a rejected example', () => {
  const context = buildDiagnosticContext({rawUserText: '电脑电源有焦糊味，已经拔电了，怎么办？', speakerId})!
  for (const reply of [
    '“先通电试试”，然后观察有没有烟。',
    '"先通电试试"，然后观察有没有烟。',
    '你可以「先通电试试」，看看情况。',
    '建议先做这步：`把电源线插回去`。'
  ]) assert.ok(validateDiagnosticReply(reply, context).some(item => item.code === 'unmet_operational_prerequisite'), reply)
  for (const reply of [
    '不要照着“先通电试试”去做，先保持电源隔离并送检。',
    '“先通电试试”这个建议不能照做。',
    '错误示例：“先通电试试”。正确做法是保持断电并找专业人员。',
    '不能说“先通电试试”，应该先完成专业排查。',
    '“里面已经有元件烧坏”这个结论现在还不能下。'
  ]) assert.deepEqual(validateDiagnosticReply(reply, context), [], reply)
})

test('arbitrary if clauses cannot exempt unknown-temperature assurances', () => {
  const context = buildDiagnosticContext({rawUserText: '电脑温度82℃，型号和测点不清楚，正常吗？', speakerId})!
  for (const reply of [
    '如果担心也可以放心用。',
    '假如只是闲置，这个温度很正常。',
    '如果你想继续玩，那就可以放心使用。',
    '如果担心就保证绝对安全。'
  ]) assert.ok(validateDiagnosticReply(reply, context).some(item => item.code === 'unsupported_temperature_assurance' || item.code === 'unsupported_safety_certification'), reply)
  for (const reply of [
    '如果该型号官方规格允许这个测点在该负载下达到82℃，那么这个读数才可能处于预期范围。',
    '只有具体型号、测点和负载都符合官方规格允许的范围，才能判断这个温度是否正常。',
    '如果担心，就先确认型号、测点和负载，暂时不能据此保证安全。'
  ]) assert.deepEqual(validateDiagnosticReply(reply, context), [], reply)
})

test('real-model warnings and pending exclusion remain distinct from a diagnosis or operation advice', () => {
  const context = buildDiagnosticContext({rawUserText: '电脑电源有焦糊味，已经拔电了，怎么办？', speakerId})!
  for (const reply of [
    '之后交给维修检测，排除电源或主板损坏之前，不要再通电试。',
    '焦糊味加冒烟说明可能有部件烧了，通电风险大。',
    '没看到烧痕不代表电源、电容或主板没损伤，一通电万一短路可能把别的件也带走。',
    '别直接用这台的原电源开机试',
    '不要再用这台的原装电源开机检测。',
    '电源或主板内部的损坏外面看不出来。',
    '重新通电可能造成短路或进一步损坏。'
  ]) assert.deepEqual(validateDiagnosticReply(reply, context), [], reply)
  for (const reply of [
    '排除电源或主板损坏之前，可以先通电看看。',
    '电源或主板已经损坏，外面看不出来。',
    '电源内部已经损坏外面看不出来。',
    '你的电源内部的损坏外面看不出来。',
    '这台主板内部的损坏外面看不出来。',
    '先通电试试，注意短路风险。',
    '通电风险大但可以先通电观察。',
    '先用这台的原电源开机试，别直接摸内部。',
    '别用手摸内部先开机看看。'
  ]) assert.ok(validateDiagnosticReply(reply, context).length > 0, reply)
})

test('damage synonym shousun cannot turn an odor report into a confirmed diagnosis', () => {
  const context = buildDiagnosticContext({rawUserText: '电脑电源有焦糊味，已经拔电了，怎么办？', speakerId})!
  for (const reply of [
    '焦糊味基本意味着电源内部元件受损，就算看起来没事、味道散了也不能排除损坏',
    '焦糊味说明电源内部元件已经受损。',
    '电源内部元件基本已受损。'
  ]) assert.ok(validateDiagnosticReply(reply, context).some(item => item.code === 'unsupported_damage_diagnosis'), reply)
  for (const reply of [
    '仅凭焦糊味不能确定电源内部元件受损。',
    '电源内部元件可能受损，先保持断电并送检。',
    '尚不能确认电源受损。',
    '重新通电可能导致电源受损，先别开机试探。',
    '排除电源内部元件受损之前，不要再通电。',
    '需要请维修人员确认电源是否受损。'
  ]) assert.deepEqual(validateDiagnosticReply(reply, context), [], reply)
  const reported = buildDiagnosticContext({rawUserText: '维修师傅已经检查了我的电脑，确认电源内部元件受损。', speakerId})!
  assert.equal(reported.evidenceAssessment?.damage.status, 'reported_professional_finding')
  assert.deepEqual(reported.evidenceAssessment?.damage.components, ['power_supply'])
  assert.deepEqual(validateDiagnosticReply('按你报告的检修结果，电源内部元件已经受损。', reported), [])
  assert.ok(validateDiagnosticReply('主板内部元件已经受损。', reported).some(item => item.code === 'unsupported_damage_diagnosis'))
  assert.ok(validateDiagnosticReply('电源内部元件已经烧毁。', reported).some(item => item.code === 'unsupported_damage_diagnosis'))
  const notDamaged = buildDiagnosticContext({rawUserText: '维修师傅已经检查了我的电脑，确认电源未受损。', speakerId})!
  assert.equal(notDamaged.evidenceAssessment?.damage.status, 'unconfirmed', 'a negative finding cannot become positive damage evidence')
  assert.deepEqual(validateDiagnosticReply('按你报告的检修结果，电源未受损。', notDamaged), [])
})

test('a completed denial cannot exempt a later explanatory damage assertion', () => {
  const context = buildDiagnosticContext({rawUserText: '电脑电源有焦糊味，已经拔电了，怎么办？', speakerId})!
  for (const reply of [
    '但这些只能帮你初步判断，不能证明没坏——焦糊味基本说明里面有过热或元件烧了，大概率是电源本身的问题。',
    '不能证明没坏—电源内部元件已经受损。',
    '目前不能保证没坏--焦糊味说明电源已经烧毁。',
    '不能证明没坏：焦糊味说明里面的元件烧了。',
    '暂时无法确认整机健康，不过电源元件肯定已经烧坏。'
  ]) assert.ok(validateDiagnosticReply(reply, context).some(item => item.code === 'unsupported_damage_diagnosis'), reply)
  for (const reply of [
    '不能证明没坏——所以仍要送检。',
    '不能确定——电源是否已经受损还需要现场检查。',
    '不能确认电源内部——有没有元件烧坏。',
    '还不能证明：电源内部元件已经受损。',
    '不能证明电源没坏——有元件受损的可能性，先保持隔离并送检。',
    '看不到烧痕不代表没事——重新通电可能导致电源受损。'
  ]) assert.deepEqual(validateDiagnosticReply(reply, context), [], reply)
})

test('installed 7548294 full fault conversation rejects unverified mechanisms and component ranking', () => {
  // Exact user turns and surviving replies in installed-7548294.json, results 24 and 28.
  const inputs = [
    '认真问：我的台式机刚才有焦糊味，机箱后面还冒烟了，我现在该怎么处理？',
    '认真问：已经断电放凉了，外面也看不到烧痕，味道散了。那我能开机测一下吗？',
    '维修师傅已经检查了刚才这台机器的电源、线材和板卡，更换了损坏电源，确认没有其他电气损坏，并让我在店里做受控开机。认真问：这时能先测什么？'
  ]
  const now = Date.parse('2026-10-16T12:30:00+08:00')
  const prior: DiagnosticHistoryMessage[] = []
  const contexts = inputs.map((rawUserText, index) => {
    const context = buildDiagnosticContext({rawUserText, speakerId, now: now + index * 1000, history: prior})!
    prior.push({role: 'user', userId: speakerId, text: rawUserText, at: now + index * 1000})
    return context
  })
  const replies = [
    '这个要认真处理：现在先直接断电——关机后把电源线拔掉，别只按关机键，拔线才算隔离。然后别开机箱，等它完全冷却再说。\n\n冒烟加焦糊味基本是电气件出问题了，电源或主板可能性大。冷却之后也别自己通电试，拿去维修检测比较稳。就近看着它，别凑近闻或者摸里面。',
    '不建议开机测。冒烟说明曾有元件过热或击穿，外部没烧痕、味道散了都不代表内部损坏排除，再通电可能把小坏烧成大坏。\n\n保持拔线状态，交维修检测比较好。真想自己先做点什么，就断电下侧开侧板做静态观察，看电容有没有鼓包、有没有渗液变色，仅此而已。'
  ]
  for (const [index, reply] of replies.entries()) {
    assert.ok(validateDiagnosticReply(reply, contexts[index]).some(item => item.code === 'unsupported_damage_diagnosis'), reply)
  }
  assert.ok(validateDiagnosticReply('电源或主板可能性大。', contexts[0]).some(item => item.code === 'unsupported_damage_diagnosis'))
  assert.deepEqual(validateDiagnosticReply('仅凭烟雾不能确定故障原因，元件过热或击穿都只是待查的可能性；先隔离电源，冷却后交专业人员检修。', contexts[1]), [])
  assert.equal(contexts[2]!.damageExclusion, 'reported_professional_clearance')
  assert.deepEqual(validateDiagnosticReply('按你报告的检修结果，损坏电源已更换。外壳复原后按现场放行范围做非接触运行监测。', contexts[2]), [])
  assert.ok(validateDiagnosticReply('既然电源损坏，说明它曾经过热或击穿。', contexts[2]).some(item => item.code === 'unsupported_damage_diagnosis'), 'generic damage is not evidence of a specific mechanism')
})

test('installed 7548294 negative symptoms do not prove that the machine never burned', () => {
  // Complete user sequence for installed-7548294.json, results 33..35.
  const context = buildDiagnosticContext({
    rawUserText: '认真问另一个情况：CPU满载82℃，没有焦糊味，也没有冒烟，一直正常运行。我只想了解这个温度该怎么判断。', speakerId,
    history: [
      {role: 'user', userId: speakerId, text: '群友P了个梗图，文字是「本地模型运行两个小时，解锁电子体香成就」。接个梗？'},
      {role: 'user', userId: speakerId, text: '群友又改成「才跑十分钟就解锁赛博香水」，这版本更离谱了。接一下。'}
    ]
  })!
  const reply = '光凭「满载82℃」这一个读数，还没法直接下正常或安全的结论——得看是哪颗CPU、温度从哪个测点读出来的、跑的是什么负载，再对照这颗U的规格才能判断。\n\n大致的思路是：\n- **先确认型号**：查这颗CPU的TjMax（温度上限），比如常见Intel是100℃、AMD锐龙是95℃，读数离上限越远余量越大\n- **确认测点**：软件读的核心温度传感器、封装温度和表面红外测的不是一个东西，82℃在不同测点上含义差很多\n- **看负载下的表现**：持续满载时频率有没有被压、性能有没有掉，这是散热扛不扛得住的直接信号；温度随时间一直往上爬也算要查的迹象\n\n没有焦糊味、没冒烟只能说明没有到烧毁的程度，不等于整机健康。你这台是什么CPU、用什么软件读的温度？说一下我帮你对着规格看。'
  assert.equal(context.incident.status, 'denied')
  assert.deepEqual(context.evidenceAssessment?.damage.excludedFindings, [])
  assert.ok(validateDiagnosticReply(reply, context).some(item => item.code === 'unsupported_damage_exclusion'))
  for (const unsupported of [
    '没有焦糊味、没冒烟只能说明没有到烧毁的程度。',
    '没烟没味就证明电源没有烧坏。',
    '一直正常运行，说明内部没有损坏。',
    '没有烧痕表明主板未受损。',
    '电源没有烧坏也不代表整机健康。',
    '没有到烧毁的程度也不意味着整机安全。'
  ]) assert.ok(validateDiagnosticReply(unsupported, context).some(item => item.code === 'unsupported_damage_exclusion'), unsupported)
  for (const supported of [
    '你目前没有观察到烟雾和焦糊味，这不能证明没有烧毁或内部没有损坏。',
    '没有焦糊味、没冒烟，只能说明没有观察到这些现象。',
    '正常运行、无烟无味都不等于整机健康，不能据此确定内部是否损坏。',
    '没有证据能证明电源没有烧坏，不能远程排除故障。',
    '电源也有可能并未损坏，需要结合检查结果判断。',
    '“无烟无味证明电源没有烧坏”这个结论现在还不能下。'
  ]) assert.deepEqual(validateDiagnosticReply(supported, context), [], supported)
  assert.match(buildDiagnosticContextPrompt(context), /无烟、无味、无烧痕.*不证明未烧毁/u)
})

test('mechanism certainty remains scoped to professional source, component and mechanism', () => {
  const smoke = buildDiagnosticContext({rawUserText: '我的电脑有焦糊味和烟雾，已拔电，怎么办？', speakerId})!
  for (const unsupported of [
    '冒烟说明曾有元件过热或击穿。',
    '焦糊味基本是电气件出问题了。',
    '烟雾证明电容已经击穿。',
    '电源可能性很大。',
    '主板故障的概率很高。',
    '不能确定整机健康，但电源或主板可能性大。'
  ]) assert.ok(validateDiagnosticReply(unsupported, smoke).some(item => item.code === 'unsupported_damage_diagnosis'), unsupported)
  for (const supported of [
    '可能是元件过热或击穿，需要现场检查。',
    '元件过热也有可能，先保持隔离并送检。',
    '不能仅凭烟雾确定电源或主板击穿。',
    '先请维修师傅确认电容是否过热或击穿。',
    '电源、主板或线材都有可能，需要检查定位。',
    '重新通电可能使电容过热或击穿，先别开机试探。',
    '元件击穿时可能出现烟雾，但烟雾本身不能确定原因。'
  ]) assert.deepEqual(validateDiagnosticReply(supported, smoke), [], supported)
  for (const [reported, allowed, rejected] of [
    ['维修师傅已经检查了我的电脑，确认电源过热。', '按你报告的检修结果，电源曾经过热。', '电源曾经击穿。'],
    ['维修师傅已经检查了我的电脑，确认电容击穿。', '按你报告的检修结果，电容已经击穿。', '主板已经击穿。']
  ]) {
    const context = buildDiagnosticContext({rawUserText: reported!, speakerId, history})!
    assert.deepEqual(validateDiagnosticReply(allowed!, context), [])
    assert.ok(validateDiagnosticReply(rejected!, context).some(item => item.code === 'unsupported_damage_diagnosis'), rejected)
  }
})

test('professional exclusions retain negative scope and are invalidated by corrections or new incidents', () => {
  const inspected = '维修师傅已经检查了我的电脑，确认电源没有烧坏，确认主板未受损。'
  const context = buildDiagnosticContext({rawUserText: inspected, speakerId, history})!
  assert.deepEqual(context.evidenceAssessment?.damage.excludedFindings, [
    {components: ['power_supply'], kind: 'burned'}, {components: ['mainboard'], kind: 'damaged'}
  ])
  assert.deepEqual(validateDiagnosticReply('按你报告的检修结果，电源没有烧坏，主板未受损。', context), [])
  for (const reply of ['所以电源没有任何损坏。', '整机没有到烧毁的程度。', '电容没有击穿。']) {
    assert.ok(validateDiagnosticReply(reply, context).some(item => item.code === 'unsupported_damage_exclusion'), reply)
  }
  const whole = buildDiagnosticContext({rawUserText: '维修师傅已经检查了我的电脑，确认没有电气损坏。现在能测什么？', speakerId, history})!
  assert.deepEqual(validateDiagnosticReply('按你报告的检查结果，未发生元件烧毁。', whole), [])
  const other = buildDiagnosticContext({rawUserText: '维修师傅已经检查了我的电脑，更换了烧坏的电源，确认没有其他电气损坏。', speakerId, history})!
  assert.deepEqual(validateDiagnosticReply('按你报告的检修结果，烧坏的电源已更换。', other), [])
  assert.ok(validateDiagnosticReply('因此电源没有烧毁。', other).some(item => item.code === 'unsupported_damage_exclusion'), 'no other damage cannot retract the known burned part')
  for (const rawUserText of ['刚才说错了，维修师傅还没检查我的电脑。', '现在又冒烟了，我的电脑怎么办？']) {
    const revised = buildDiagnosticContext({rawUserText, speakerId, history: [...history, {role: 'user', userId: speakerId, text: inspected}]})!
    assert.deepEqual(revised.evidenceAssessment?.damage.excludedFindings, [])
    assert.ok(validateDiagnosticReply('电源没有烧坏。', revised).some(item => item.code === 'unsupported_damage_exclusion'), rawUserText)
  }
  const compatible = {...context}
  delete compatible.evidenceAssessment
  assert.deepEqual(validateDiagnosticReply('按你报告的检查结果，电源没有烧坏。', compatible), [])
})

test('uncompleted and other-device negative findings cannot become exclusions', () => {
  for (const rawUserText of [
    '我看我的电脑电源没有烧坏，怎么检查？',
    '维修师傅明天检查我的电脑，确认有没有烧毁。',
    '维修师傅检查了我的电脑，猜测电源没有烧毁。',
    '维修师傅检查了我的电脑，但还没确认电源没有烧毁。',
    '维修师傅检查了我的电脑，确认电源没有烧毁了吗？',
    '维修师傅已经检查了朋友的电脑，确认电源没有烧毁。我的电脑有焦糊味，怎么办？',
    '[回复 朋友：维修师傅已经检查了电脑，确认电源没有烧毁] 我的电脑有焦糊味，怎么办？'
  ]) {
    const context = buildDiagnosticContext({rawUserText, speakerId, history})!
    assert.deepEqual(context.evidenceAssessment?.damage.excludedFindings, [], rawUserText)
    assert.ok(validateDiagnosticReply('所以你的电源没有烧毁。', context).some(item => item.code === 'unsupported_damage_exclusion'), rawUserText)
  }
})

test('parallel omitted subjects keep professional exclusions on the same component', () => {
  for (const [report, mechanism, initialKind, finalKind] of [
    ['确认电源没有烧坏也没有短路', '短路', 'burned', 'short_circuit'],
    ['确认电源没有烧坏，也没有短路', '短路', 'burned', 'short_circuit'],
    ['确认电源没有损坏也没有过热', '过热', 'damaged', 'overheated'],
    ['确认电源没有损坏，也没有过热', '过热', 'damaged', 'overheated']
  ] as const) {
    const rawUserText = `维修师傅已经检查了我的电脑，${report}。现在怎么办？`
    const context = buildDiagnosticContext({rawUserText, speakerId})!
    assert.deepEqual(context.evidenceAssessment?.damage.excludedFindings, [
      {components: ['power_supply'], kind: initialKind}, {components: ['power_supply'], kind: finalKind}
    ], rawUserText)
    assert.deepEqual(validateDiagnosticReply(`按你报告的检修结果，电源没有${mechanism}。`, context), [], rawUserText)
    for (const component of ['主板', '显卡', '电容']) {
      assert.ok(validateDiagnosticReply(`按你报告的检修结果，${component}没有${mechanism}。`, context).some(item => item.code === 'unsupported_damage_exclusion'), `${rawUserText} -> ${component}`)
    }
    const compatible = {...context}
    delete compatible.evidenceAssessment
    assert.ok(validateDiagnosticReply(`主板没有${mechanism}。`, compatible).some(item => item.code === 'unsupported_damage_exclusion'), 'source fallback preserves the same component scope')
  }
})

test('an explicit new component and explicit whole-device clearance have different exclusion scopes', () => {
  const changed = buildDiagnosticContext({rawUserText: '维修师傅已经检查了我的电脑，确认电源没有烧坏，主板也没有短路。现在怎么办？', speakerId})!
  assert.deepEqual(changed.evidenceAssessment?.damage.excludedFindings, [
    {components: ['power_supply'], kind: 'burned'}, {components: ['mainboard'], kind: 'short_circuit'}
  ])
  assert.deepEqual(validateDiagnosticReply('按你报告的检修结果，主板没有短路。', changed), [])
  for (const claim of ['电源没有短路。', '显卡没有短路。']) {
    assert.ok(validateDiagnosticReply(claim, changed).some(item => item.code === 'unsupported_damage_exclusion'), claim)
  }
  for (const report of ['确认整机没有烧坏也没有短路', '确认整机没有烧坏，也没有短路', '确认没有电气损坏']) {
    const context = buildDiagnosticContext({rawUserText: `维修师傅已经检查了我的电脑，${report}。现在怎么办？`, speakerId})!
    assert.ok(context.evidenceAssessment?.damage.excludedFindings?.every(finding => finding.scope === 'whole_device'), report)
    assert.deepEqual(validateDiagnosticReply('按你报告的检修结果，主板没有短路。', context), [], report)
  }
  for (const report of ['确认电源没有烧坏。也没有短路', '确认电源没有烧坏，线材也检查完了，没有短路']) {
    const context = buildDiagnosticContext({rawUserText: `维修师傅已经检查了我的电脑，${report}。现在怎么办？`, speakerId})!
    assert.ok(validateDiagnosticReply('主板没有短路。', context).some(item => item.code === 'unsupported_damage_exclusion'), 'an unresolved omitted subject cannot become universal clearance')
  }
  const legacy = {...changed, evidenceAssessment: {damage: {status: 'unconfirmed' as const, components: [], findings: [], excludedFindings: [{components: ['unspecified_component' as const], kind: 'short_circuit' as const}]}}}
  assert.ok(validateDiagnosticReply('主板没有短路。', legacy).some(item => item.code === 'unsupported_damage_exclusion'), 'legacy unspecified scope is not whole-device evidence')
})

test('fallbacks use observed prerequisites and pass the same validation without rewriting the candidate', () => {
  const inputs = [
    {rawUserText: '电脑有焦糊味，已经拔电了，怎么办？'},
    {rawUserText: '电脑有焦糊味，怎么办？'},
    {rawUserText: 'CPU满载82℃，没有烟味，怎么判断温度？'},
    {rawUserText: '维修师傅已经检查了我的电脑，更换了损坏电源，确认没有其他电气损坏。现在能测什么？', history}
  ]
  const fallbacks = inputs.map(input => {
    const context = buildDiagnosticContext({...input, speakerId})!
    const fallback = buildDiagnosticFallbackReply(context)
    assert.ok(fallback.length > 0)
    assert.deepEqual(validateDiagnosticReply(fallback, context), [], fallback)
    return fallback
  })
  assert.match(fallbacks[0]!, /你已报告拔电/)
  assert.match(fallbacks[1]!, /先停机并切断电源/)
  assert.match(fallbacks[2]!, /还不能判断是否正常.*具体部件型号.*测温位置/u)
  assert.match(fallbacks[3]!, /已完成专业检修.*非接触运行监测/u)
  assert.deepEqual(validateDiagnosticReply('电源烧坏了。', undefined), [])
  assert.equal(buildDiagnosticFallbackReply(undefined), '')
})

test('unknown model temperature cannot be certified through a no-danger synonym', () => {
  const context = buildDiagnosticContext({rawUserText: 'CPU满载82℃，没有焦糊味，也没有冒烟，一直正常运行。我只想了解这个温度该怎么判断。', speakerId})!
  const text = '82℃满载这个数本身不算危险信号，一般CPU规格里Tjunction上限在100℃左右，82℃还留有余量。'
  assert.ok(validateDiagnosticReply(text, context).some(item => item.code === 'unsupported_temperature_assurance'))
  for (const normal of [
    '82℃本身是否危险还不能确定。',
    '如果该型号官方上限为100℃，82℃就在这项上限以下；仍需核对测点和负载。',
    '有些型号允许这个温度，当前型号尚未确认。'
  ]) assert.deepEqual(validateDiagnosticReply(normal, context), [], normal)
})

test('professional clearance preserves passive odor detection but never requests active sniffing', () => {
  const context = buildDiagnosticContext({rawUserText: '维修师傅已经检查了我的电脑，更换了损坏电源，确认没有其他电气损坏，允许受控开机。现在能测什么？', speakerId, history})!
  const unsafe = '师傅已经排查过并放行的话，可以让师傅在场做受控开机，先听风扇转速是否正常、闻有没有异味，看能不能点亮进系统。'
  assert.ok(validateDiagnosticReply(unsafe, context).some(item => item.code === 'unsafe_inspection_action'))
  for (const normal of [
    '不要主动嗅闻。',
    '不要凑近闻有没有异味。',
    '别主动闻一下。',
    '如果自然闻到异味，立即停止运行，通知维修师傅。',
    '闻到异味后立即停止受控运行，通知师傅。',
    '观察是否再次出现异常气味，不要凑近。'
  ]) assert.deepEqual(validateDiagnosticReply(normal, context), [], normal)
})

test('704a50c real replay does not turn frequency reduction into a certain thermal-limit diagnosis', () => {
  const context = buildDiagnosticContext({rawUserText: 'CPU满载82℃，没有焦糊味，也没有冒烟，一直正常运行。我只想了解这个温度该怎么判断。', speakerId})!
  const original = '满载时有没有自动降频（频率被压下来说明触发了温度墙，那82℃就偏临界了）'
  const violations = validateDiagnosticReply(original, context)
  assert.ok(violations.some(item => item.code === 'unsupported_temperature_diagnosis' && item.claim.includes('说明触发了温度墙')))
  assert.ok(violations.some(item => item.code === 'unsupported_temperature_diagnosis' && item.claim.includes('82℃就偏临界了')))
  assert.equal(original, '满载时有没有自动降频（频率被压下来说明触发了温度墙，那82℃就偏临界了）')
  for (const unsafe of [
    'CPU频率下降说明已经触发温度墙。',
    '如果你着急，CPU频率被压就说明触发了温度墙。',
    '82℃已经接近温度上限。'
  ]) assert.ok(validateDiagnosticReply(unsafe, context).some(item => item.code === 'unsupported_temperature_diagnosis'), unsafe)
  for (const normal of [
    '频率下降可能与温度有关，也可能是功耗限制，需要结合记录判断。',
    '频率被压下来不一定说明触发了温度墙。',
    '满载频率下降是否说明触发了温度墙？',
    '先确认限频原因记录，看看有没有触发温度墙。',
    '触发温度墙时可能出现频率下降，但仅凭降频不能确定原因。',
    '这个例子说明触发温度墙后频率会下降；仍需查日志确认当前原因。',
    '如果该型号官方温度上限为83℃，这个测点82℃就接近温度上限；仍需核对规格。'
  ]) assert.deepEqual(validateDiagnosticReply(normal, context), [], normal)
  const known = buildDiagnosticContext({rawUserText: 'CPU型号是i7-13700K，CPU Package满载82℃，运行Cinebench时频率下降，怎么判断？', speakerId})!
  assert.ok(validateDiagnosticReply('CPU频率下降说明触发了温度墙。', known).some(item => item.code === 'unsupported_temperature_diagnosis'), 'knowing the model and sensor still does not establish the limiting cause')
  assert.match(buildDiagnosticContextPrompt(context), /降频或频率下降.*不能单凭降频断定触发温度墙/u)
})

test('thermal findings preserve explicit professional component, mechanism and completed-report scope', () => {
  const inspected = '维修师傅已经检查了我的电脑，确认CPU已经触发温度墙。'
  const context = buildDiagnosticContext({rawUserText: inspected, speakerId})!
  assert.deepEqual(validateDiagnosticReply('按你报告的检修结果，CPU已经触发温度墙。', context), [])
  assert.ok(validateDiagnosticReply('GPU已经触发温度墙。', context).some(item => item.code === 'unsupported_temperature_diagnosis'))
  for (const rawUserText of [
    '维修师傅明天检查我的电脑，确认CPU已经触发温度墙。',
    '维修师傅已经检查了我的电脑，但还没有确认CPU已经触发温度墙。',
    '维修师傅已经检查了我的电脑，确认CPU已经触发温度墙了吗？',
    '维修师傅已经检查了朋友的电脑，确认CPU已经触发温度墙。我的电脑CPU满载82℃，怎么判断？'
  ]) {
    const current = buildDiagnosticContext({rawUserText, speakerId})!
    assert.ok(validateDiagnosticReply('CPU已经触发温度墙。', current).some(item => item.code === 'unsupported_temperature_diagnosis'), rawUserText)
  }
  const revised = buildDiagnosticContext({rawUserText: '刚才说错了，维修师傅还没检查这台电脑，CPU温度82℃。', speakerId, history: [{role: 'user', userId: speakerId, text: inspected}]})!
  assert.ok(validateDiagnosticReply('CPU已经触发温度墙。', revised).some(item => item.code === 'unsupported_temperature_diagnosis'))
})


test('a professional negative thermal predicate never supports a positive diagnosis', () => {
  for (const negative of ['没有', '未']) {
    const rawUserText = `维修师傅已经检查了我的电脑，确认CPU${negative}触发温度墙。CPU满载82℃。`
    const context = buildDiagnosticContext({rawUserText, speakerId})!
    assert.ok(validateDiagnosticReply('CPU已经触发温度墙。', context).some(item => item.code === 'unsupported_temperature_diagnosis'), rawUserText)
    assert.deepEqual(validateDiagnosticReply(`按你报告的检查结果，确认CPU${negative}触发温度墙。`, context), [], 'a negative predicate is not itself an unsupported positive diagnosis')
  }
  const positive = '维修师傅已经检查了我的电脑，确认CPU已经触发温度墙。'
  const revised = buildDiagnosticContext({rawUserText: '维修师傅再次检查了我的电脑，确认CPU没有触发温度墙。CPU满载82℃。', speakerId, history: [{role: 'user', userId: speakerId, text: positive}]})!
  assert.ok(validateDiagnosticReply('CPU已经触发温度墙。', revised).some(item => item.code === 'unsupported_temperature_diagnosis'), 'a newer negative finding retracts an older positive finding of the same component and mechanism')
  const local = buildDiagnosticContext({rawUserText: '维修师傅已经检查了我的电脑，确认CPU没有触发温度墙，确认GPU已经触发温度墙。CPU满载82℃。', speakerId})!
  assert.ok(validateDiagnosticReply('CPU已经触发温度墙。', local).some(item => item.code === 'unsupported_temperature_diagnosis'))
  assert.deepEqual(validateDiagnosticReply('GPU已经触发温度墙。', local), [], 'CPU negation does not retract the GPU finding')
  const otherPredicate = buildDiagnosticContext({rawUserText: '维修师傅已经检查了我的电脑，确认CPU没有损坏但已经触发温度墙。CPU满载82℃。', speakerId})!
  assert.deepEqual(validateDiagnosticReply('CPU已经触发温度墙。', otherPredicate), [], 'negation of damage does not govern the later thermal predicate')
})
