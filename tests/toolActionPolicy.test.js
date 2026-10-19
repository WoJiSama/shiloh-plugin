import test from 'node:test'
import assert from 'node:assert/strict'
import {isExplicitNoToolAction, isToolActionDenied, hasReminderActionIntent} from '../dist/backend/modules/conversation/domain/toolActionPolicy.js'
import {filterToolsForMessageIntent} from '../apps/lib/conversationUtils.js'
import {resolveDeterministicToolIntent} from '../utils/toolIntentManifests.js'
import {resolveNaturalDeltaForceToolCall} from '../utils/deltaForceIntent.js'

test('refusals, examples and quotations do not authorize fallback tool calls', () => {
  const tools=['reminderTool','githubRepoTool','deltaForceTool','searchInformationTool'].map(name=>({function:{name}}))
  for (const text of ['不用提醒我，我记得这件事。','只是讨论：到点为什么会弹出提示？','不要解析这个仓库 https://github.com/openai/openai-node ，我只是把地址发给你','这只是示例：看看 https://github.com/microsoft/TypeScript ，别真的查询','别查三角洲今日密码了，继续聊天','只是转述：三角洲H70现在多少钱。我没有让你去查']) {
    assert.equal(isExplicitNoToolAction(text),true,text)
    assert.deepEqual(filterToolsForMessageIntent(tools,{},text),[],text)
    assert.equal(resolveDeterministicToolIntent(text,tools.map(tool=>tool.function.name)),null,text)
    assert.equal(resolveNaturalDeltaForceToolCall(text),null,text)
  }
})

test('time words alone cannot expose a reminder action', () => {
  for (const text of ['我待会儿去吃饭','待会儿我自己处理，你不用做什么。']) {
    assert.equal(hasReminderActionIntent(text),false)
    assert.deepEqual(filterToolsForMessageIntent([{function:{name:'reminderTool'}}],{},text,{toolCandidates:['reminderTool']}),[])
  }
  for (const text of ['十分钟后提醒我喝水','别忘了提醒我喝水','到点叫我','查看我的提醒','取消提醒']) assert.equal(hasReminderActionIntent(text),true,text)
  assert.equal(isExplicitNoToolAction('不用查天气，不过帮我查询成员资料'),false)
})

test('mixed requests reach the planner while each denied capability stays unavailable', () => {
  const cases = [
    ['不用提醒我，查一下今天的天气','reminderTool','searchInformationTool'],
    ['查一下天气，别提醒我','reminderTool','searchInformationTool'],
    ['别查三角洲，给我放首周杰伦的歌','deltaForceTool','searchMusicTool'],
    ['不要查天气，十分钟后提醒我出门','searchInformationTool','reminderTool'],
    ['不要解析这个仓库 https://github.com/openai/openai-node，查询群成员资料','githubRepoTool','memberInfoTool'],
    ['别查成员资料，查一下他上次说什么','memberInfoTool','chatHistoryTool'],
    ['不要翻聊天记录，查询这位成员的信息','chatHistoryTool','memberInfoTool'],
    ['只是示例：查询三角洲今日密码，帮我查询今天的天气','deltaForceTool','searchInformationTool']
  ]
  for (const [text,denied,requested] of cases) {
    assert.equal(isExplicitNoToolAction(text),false,text)
    assert.equal(isToolActionDenied(text,denied),true,`${text}: denied ${denied}`)
    assert.equal(isToolActionDenied(text,requested),false,`${text}: requested ${requested}`)
    const tools=[denied,requested].map(name=>({function:{name}}))
    assert.deepEqual(filterToolsForMessageIntent(tools,{},text,{toolCandidates:[denied,requested]}).map(tool=>tool.function.name),[requested],text)
  }
  assert.equal(hasReminderActionIntent('不要查天气，十分钟后提醒我出门'),true)
})

test('quoted examples cannot authorize their tools while an independent request remains eligible', () => {
  const text='“十分钟后提醒我喝水”是个例子，查一下今天的天气'
  assert.equal(isExplicitNoToolAction(text),false)
  assert.equal(isToolActionDenied(text,'reminderTool'),true)
  assert.equal(isToolActionDenied(text,'searchInformationTool'),false)
  assert.equal(hasReminderActionIntent(text),false)
})

test('same-tool conflicts and unscoped prohibitions cannot be resolved by blindly authorizing a matching candidate', () => {
  const sameTool='别查北京天气，查一下上海天气'
  assert.equal(isExplicitNoToolAction(sameTool),false,'let the planner resolve or explain the conflict')
  assert.equal(isToolActionDenied(sameTool,'searchInformationTool'),true)
  const unresolved='不要调用任何工具，帮我查一下天气'
  assert.equal(isExplicitNoToolAction(unresolved),false)
  assert.equal(isToolActionDenied(unresolved,'searchInformationTool'),true)
})

test('reminder action detection covers requests without mistaking an incidental time phrase for consent', () => {
  for (const text of ['别忘了提醒我喝水','过五分钟喊我起来','到九点提醒一下交日报','晚上八点别让我忘记吃药','帮我设置一个今晚八点吃药的提醒','他说明天下午三点开会，帮我加个提醒']) {
    assert.equal(hasReminderActionIntent(text),true,text)
    assert.equal(isToolActionDenied(text,'reminderTool'),false,text)
  }
  for (const text of ['我待会儿去吃饭','朋友说十分钟后提醒我喝水','只是讨论：到点为什么会弹出提示？']) assert.equal(hasReminderActionIntent(text),false,text)
})
