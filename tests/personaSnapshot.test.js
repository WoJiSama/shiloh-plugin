import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createPersonaSnapshot} from '../dist/backend/modules/conversation/infrastructure/personaSnapshot.js'
import {createPersonaLibrary} from '../dist/backend/modules/conversation/infrastructure/personaLibrary.js'
import {createChatPlugin} from '../dist/backend/modules/host/infrastructure/chatPlugin.js'
import {resolveConversationContext} from '../dist/backend/adapters/conversationContext.js'

test('snapshot copies and freezes nested persona and guard values without changing live configuration', () => {
  const persona = {name:'夜巡', tone:'简练', speechStyle:['少用语气词'], moods:[{name:'愉快',hint:'轻快',probability:0.1}]}
  const guard = {enabled:true, badPatterns:['旧规则']}
  const snapshot = createPersonaSnapshot({botId:99, personaId:'night', persona, personaGuard:guard, systemContent:'custom {personaName}'})
  persona.speechStyle.push('后来添加的规则')
  persona.moods[0].hint = '后来修改的心情'
  guard.badPatterns.push('后来添加的guard')
  assert.deepEqual(snapshot.persona.speechStyle, ['少用语气词'])
  assert.equal(snapshot.persona.moods[0].hint, '轻快')
  assert.deepEqual(snapshot.personaGuard.badPatterns, ['旧规则'])
  assert.throws(() => snapshot.persona.moods[0].hint = 'mutation', TypeError)
  assert.throws(() => snapshot.persona.speechStyle.push('mutation'), TypeError)
  assert.throws(() => snapshot.personaGuard.badPatterns.push('mutation'), TypeError)
  assert.throws(() => snapshot.personaName = 'mutation', TypeError)
})

test('revision is stable for equivalent configuration and changes for every captured persona rule', () => {
  const input = {botId:99,personaId:'a',persona:{name:'同名',tone:'简练',notes:'备注',boundaries:['边界']},systemContent:'原自定义',personaGuard:{enabled:true,badPatterns:['a']}}
  const first = createPersonaSnapshot(input)
  assert.equal(createPersonaSnapshot({...input,persona:{boundaries:['边界'],notes:'备注',tone:'简练',name:'同名'}}).personaVersion, first.personaVersion)
  for (const changed of [
    {...input,persona:{...input.persona,tone:'热情'}},
    {...input,persona:{...input.persona,notes:'新备注'}},
    {...input,persona:{...input.persona,boundaries:['新边界']}},
    {...input,systemContent:'新自定义'},
    {...input,personaGuard:{enabled:false,badPatterns:['a']}}
  ]) assert.notEqual(createPersonaSnapshot(changed).personaVersion, first.personaVersion)
  assert.notEqual(createPersonaSnapshot({...input,personaId:'b'}).personaId, first.personaId)
  assert.notEqual(createPersonaSnapshot({...input,botId:303}).botId, first.botId)
})

test('host resolves library id once and event snapshot pins later configuration reads', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'persona-host-snapshot-'))
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}))
  const {ExamplePlugin} = createChatPlugin({Plugin:class {},shared:{},logger:{}})
  const host = Object.create(ExamplePlugin.prototype)
  host.config = {persona:{name:'默认'}, systemContent:'原提示',personaGuard:{enabled:true}}
  host.personaLibrary = createPersonaLibrary({libraryPath:path.join(dir,'library.yaml'),getBasePersona:()=>host.config.persona})
  const a = host.personaLibrary.upsert({name:'甲',tone:'冷静'})
  const b = host.personaLibrary.upsert({name:'乙',tone:'活泼'})
  host.personaLibrary.setGroupBinding(123,a.id)
  const event = {self_id:99,user_id:202,group_id:123,message_type:'group'}
  const original = host.getPersonaSnapshotFor(event)
  assert.equal(original.personaId,a.id)
  event._personaSnapshot = original
  host.personaLibrary.setGroupBinding(123,b.id)
  host.config.systemContent = '新提示'
  host.config.personaGuard.enabled = false
  assert.equal(host.getPersonaFor(event), original.persona)
  assert.equal(host.getChatConfig(event).systemContent, '原提示')
  assert.equal(host.getChatConfig(event).personaGuard.enabled, true)
  const next = host.getPersonaSnapshotFor(event)
  assert.equal(next.personaId,b.id)
  assert.equal(next.personaName,'乙')
  const context = resolveConversationContext(event)
  assert.deepEqual(context.persona,{personaId:original.personaId,personaVersion:original.personaVersion,personaName:'甲'})
  assert.deepEqual(Object.keys(context.persona).sort(),['personaId','personaName','personaVersion'])
  const noGuard = createPersonaSnapshot({botId:99,persona:{name:'甲'}})
  event._personaSnapshot = noGuard
  host.config.personaGuard = {enabled:true,badPatterns:['后来配置的规则']}
  assert.equal(host.getChatConfig(event).personaGuard,undefined,'a guard added mid-turn cannot enter a snapshot that captured no guard')
})
