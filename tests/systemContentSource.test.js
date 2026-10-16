import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {resolveSystemContentSource} from '../dist/backend/modules/conversation/domain/systemContentSource.js'
import {buildPersonaStyleOverride, renderPersonaTemplate} from '../utils/personaSource.js'
import {createTurnPromptComposer} from '../dist/backend/modules/conversation/infrastructure/turnPromptComposer.js'
import {buildMainSystemPrompt} from '../utils/systemPromptTemplate.js'
import {resolvePromptLayerProfile} from '../utils/promptLayers.js'
import {buildStructuredHistoryMessage} from '../dist/backend/modules/conversation/domain/agentIntelligence.js'
import {createPersonProfileClass} from '../dist/backend/modules/memory/application/personProfileInjector.js'

const legacy = fs.readFileSync(new URL('./fixtures/legacyBuiltinSystemContent.txt', import.meta.url), 'utf8')

test('已登记官方模板仅完整匹配时不再重复注入，空配置走内置规则', () => {
  assert.deepEqual(resolveSystemContentSource(undefined), {text:'', source:'builtin'})
  assert.deepEqual(resolveSystemContentSource('  \n'), {text:'', source:'builtin'})
  assert.deepEqual(resolveSystemContentSource(legacy), {text:'', source:'legacy_builtin'})
  assert.deepEqual(resolveSystemContentSource(`\r\n${legacy.replaceAll('\n','\r\n')}  `), {text:'', source:'legacy_builtin'})
})

test('任何修改及未知自定义内容都完整保留，不根据旧台词或人设名猜来源', () => {
  for (const text of [legacy+'用户自定义尾句', legacy.replace('真实反应 > 完美回答','准确优先'), legacy.replaceAll('{personaName}','小白'), '我对大家都好呀\n  CUSTOM_SENTINEL  \n']) {
    assert.deepEqual(resolveSystemContentSource(text), {text, source:'custom'})
  }
})

test('最终 chat/task system 都得到当前人设语气、风格、偏好与边界，custom哨兵原文保留一次', async () => {
  const composer=createTurnPromptComposer()
  const custom='  CUSTOM_SENTINEL {personaName}\n保留这个用户约定。  '
  const personas=[
    {name:'昼光',identity:'活泼温暖',tone:'热情、俏皮',speechStyle:['轻快短句'],preferences:['喜欢热闹'],boundaries:['不接受占有关系']},
    {name:'夜巡',identity:'冷静克制',tone:'冷静、简练',speechStyle:['少用语气词'],preferences:['喜欢准确的信息'],boundaries:Array.from({length:10},(_,i)=>`界限${i}`),notes:'喜欢把例子讲清楚'}
  ]
  for (const persona of personas) {
    for (const modelIntent of ['', 'search']) {
      const profile=resolvePromptLayerProfile({responseKind:'chat', modelIntent})
      const layers=await composer.composeTurnPromptLayers({config:{persona},profile,turn:{messageText:'在吗',toneText:'在吗'}})
      const prompt=buildMainSystemPrompt({baseIdentity:renderPersonaTemplate(resolveSystemContentSource(custom).text,persona),personaOverride:buildPersonaStyleOverride(persona),enhancedPrompts:layers.prompt,personaName:persona.name})
      assert.ok(prompt.includes(`  CUSTOM_SENTINEL ${persona.name}\n保留这个用户约定。  `))
      for (const value of [persona.identity,persona.tone,...persona.speechStyle,...persona.preferences,...persona.boundaries,...(persona.notes?[persona.notes]:[])]) assert.equal(prompt.split(value).length-1,1,value)
      assert.equal(prompt.split(`【${persona.name}场景口吻】`).length-1,1)
      assert.ok(!prompt.includes('懒要懒得软'))
      assert.ok(!prompt.includes('我对大家都好呀'))
    }
  }
})

test('官方旧模板拼装后只保留当前人格与公共规则，原配置字符串没有被修改', () => {
  const original=legacy
  const source=resolveSystemContentSource(original)
  const prompt=buildMainSystemPrompt({baseIdentity:renderPersonaTemplate(source.text,{name:'夜巡'}),personaOverride:buildPersonaStyleOverride({name:'夜巡',identity:'冷静克制',tone:'简练'}),personaName:'夜巡'})
  assert.equal(original,legacy)
  assert.ok(!prompt.includes('真实反应 > 完美回答'))
  assert.ok(!prompt.includes('窝在沙发里'))
  assert.ok(prompt.includes('冷静克制'))
})

test('任务人物画像保留群和对话者信息，不再重复投影自身人格；历史机器人标签不硬编码名字', async () => {
  const persona={enabled:true,name:'安序',identity:'冷静克制',tone:'简练',notes:'备注哨兵'}
  const PersonProfile=createPersonProfileClass({getConfig:()=>({persona,personProfileInjection:{enabled:true},groupProfiles:[{groupId:123,atmosphere:'讨论技术'}]}),getPersonaFor:()=>persona,getMessages:async()=>[{sender:{user_id:202},content:'讨论数据库'}]})
  const profile=await new PersonProfile().build(123,202,{sender:{nickname:'群友'}})
  assert.ok(profile.includes('讨论技术'))
  assert.ok(profile.includes('讨论数据库'))
  assert.ok(!profile.includes('备注哨兵'))
  assert.ok(!profile.includes('固定人设'))
  const history=buildStructuredHistoryMessage([{role:'assistant',content:'安序(QQ号:99): 已说清楚。'}])
  assert.ok(history.content.includes('当前机器人回复'))
  assert.ok(!history.content.includes('希洛'))
})
