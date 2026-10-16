import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import YAML from 'yaml'
import { schemas } from '../../src/modules/config/domain/schemas/guoba/index.js'
import conversation from '../../src/modules/config/domain/schemas/shared/conversation.js'
import dice from '../../src/modules/config/domain/schemas/shared/dice.js'
import tracking from '../../src/modules/config/domain/schemas/shared/tracking.js'
import memory from '../../src/modules/config/domain/schemas/shared/memory.js'
import { createConfigPanel } from '../../src/modules/config/application/configPanel.js'
import { createConfigRepository } from '../../src/modules/config/infrastructure/configRepository.js'
import { getProviderDefinition, normalizeAiProviderUpdates } from '../../src/modules/config/domain/aiProviderConfig.js'

const Result = {
 ok: (_data: unknown, text: string) => ({ ok: true, text }),
 error: (text: string) => ({ ok: false, text })
}
const resultOf = (value: unknown) => value as { ok: boolean; text: string }
const record = (value: unknown) => value as Record<string, unknown>

test('Guoba retains uncovered settings while shared console schemas and providers stay available', () => {
 const conversationFields = [...conversation, ...dice, ...tracking, ...memory].flatMap(item => item.field ? [item.field] : [])
 const guobaFields = new Set(schemas.flatMap(item => item.field ? [item.field] : []))
 assert.equal(new Set(conversationFields).size, conversationFields.length)
 for (const field of conversationFields) assert.equal(guobaFields.has(field), false, field)
 for (const field of [
  'systemContent', 'messageArchive.retentionDays', 'emotionSystem.enabled',
  'expressionLearning.enabled', 'knowledgeSystem.enabled',
  'emojiSystem.enabled', 'voiceSystem.enabled', 'deltaForceSystem.enabled',
  'magnetSearchSystem.enabled', 'umaRace.enabled', 'oneapi_tools'
 ]) assert.ok(guobaFields.has(field), field)
 const migratedPrefixes = [
  'groupGuard', 'groupModeration', 'groupNotice', 'groupAdmin', 'persona', 'personaGuard',
  'globalStyleLearning', 'messagePipeline', 'mediaRelayAdminReport',
  'bilibiliQualityRelay', 'youtubeRelay', 'riskControl', 'smartTrigger', 'personProfileInjection',
  'diceSystem', 'memorySystem', 'semanticMemory', 'midtermMemory'
 ]
 for (const field of guobaFields) {
  assert.equal(migratedPrefixes.some(prefix => field === prefix || field.startsWith(prefix + '.')), false, field)
  assert.equal(field.split('.')[0]?.endsWith('AiConfig'), false, field)
 }
 for (const field of ['chatTriggerMode', 'userProfiles', 'groupProfiles']) assert.equal(guobaFields.has(field), false, field)
 const definition = getProviderDefinition('imageGenerationAiConfig')
 assert.ok(definition?.extraFields?.some(field => field.panelField === 'portraitSize'))
})

test('panel reads only exact registered fields without exposing migrated settings or model secrets', () => {
 const selectedFields = new Set([
  'systemContent', 'messageArchive.groupAdmins', 'messageArchive.enabled', 'deltaForceSystem.apiKey'
 ])
 const settings = {
  systemContent: 'retained prompt',
  smartTrigger: { talkValue: 0.2, groupTalkValues: [{ group: '123', value: 0.4 }], futureTuning: 'hidden' },
  memorySystem: { enabled: false, futureMemory: true },
  messageArchive: { enabled: false, groupAdmins: [{ groupId: '123', admins: ['456'] }], futureArchive: true },
  deltaForceSystem: { apiKey: 'retained-integration-key', futureKey: 'hidden' },
  enabled: true,
  chatTriggerMode: 'smart',
  groupAdmin: { overrides: [{ groupId: '123', groupGuard: { enabled: true } }] },
  groupGuard: { enabled: true },
  persona: { name: 'console persona' },
  chatAiConfig: { providers: [{ apiKey: 'console-provider-key' }] },
  trackAiConfig: { trackAiApikey: 'console-legacy-key' },
  taskAiConfig: { casual: { apiKey: 'console-task-key' } },
  youtubeRelay: { cookie: 'console-cookie' }
 }
 const before = structuredClone(settings)
 const panel = createConfigPanel({
  schemas: schemas.filter(item => item.field && selectedFields.has(item.field)),
  readSettings: () => settings,
  applyUpdates: () => assert.fail('reading cannot write settings')
 })
 const projected = panel.getConfigData()
 assert.deepEqual(projected, {
  systemContent: 'retained prompt',
  messageArchive: { enabled: false, groupAdmins: [{ groupId: '123', admins: ['456'] }] },
  deltaForceSystem: { apiKey: 'retained-integration-key' }
 })
 assert.deepEqual(settings, before)
 const rows = record(projected.messageArchive).groupAdmins as Record<string, unknown>[]
 rows[0]!.groupId = '789'
 assert.deepEqual(settings, before, 'returned subforms must not reference the live settings')
 assert.equal(Object.hasOwn(panel, 'testAiProviders'), false)
})

test('panel saves exact remaining fields unchanged and reports persistence failure', () => {
 const writes: Record<string, unknown>[] = []
 const panel = createConfigPanel({ schemas, readSettings: () => ({}), applyUpdates: value => writes.push(value) })
 const updates = {
  systemContent: 'updated prompt',
  'emotionSystem.decayRate': 0.25,
  'messageArchive.enabled': false,
  'messageArchive.groupAdmins': [],
  githubToken: ''
 }
 assert.deepEqual(panel.setConfigData(updates, { Result }), { ok: true, text: '保存成功 (´。• ᵕ •。`)' })
 assert.deepEqual(writes, [updates])
 const failed = createConfigPanel({ schemas, readSettings: () => ({}), applyUpdates: () => { throw new Error('conflict') } })
 assert.deepEqual(failed.setConfigData({ systemContent: 'prompt' }, { Result }), { ok: false, text: '保存失败: conflict' })
})

test('panel rejects migrated, unknown and parent-object keys atomically', () => {
 const writes: Record<string, unknown>[] = []
 const panel = createConfigPanel({ schemas, readSettings: () => ({}), applyUpdates: value => writes.push(value) })
 const invalid: Record<string, unknown>[] = [
  { 'chatAiConfig.providers': [{ apiUrl: 'https://fixture.invalid', model: 'fixture', apiKey: '' }] },
  { 'chatAiConfig.chatApiKey': '' },
  { 'chatAiConfig.chatReasoningEffort': 'low' },
  { 'groupGuard.timeoutSeconds': 10 },
  { 'groupAdmin.overrides': [] },
  { 'persona.name': 'old page' },
  { 'messagePipeline.eventConcurrency': 1 },
  { 'riskControl.enabled': false },
  { chatTriggerMode: 'strict' },
  { conversationTrackingEnabled: false },
  { 'smartTrigger.talkValue': 0.25 },
  { 'smartTrigger.groupTalkValues': [] },
  { 'personProfileInjection.enabled': false },
  { 'diceSystem.enabled': false },
  { 'diceSystem.baseDir': 'data/new-dice' },
  { 'memorySystem.enabled': false },
  { 'semanticMemory.memoryEvolution.enabled': false },
  { 'semanticMemory.selfCorrection.penalty': 0.5 },
  { 'midtermMemory.model': 'fixture-model' },
  { enabled: false },
  { unknownSetting: true },
  { smartTrigger: { talkValue: 1 } },
  { 'smartTrigger.unregisteredSibling': true },
  { 'smartTrigger.groupTalkValues.0.group': '456' },
  { chatAiConfig: { providers: [] } }
 ]
 for (const payload of invalid) {
  for (const submitted of [payload, { systemContent: 'must not be written', ...payload }]) {
   const result = resultOf(panel.setConfigData(submitted, { Result }))
   assert.equal(result.ok, false, JSON.stringify(submitted))
   assert.ok(result.text.startsWith('保存失败: '))
   assert.ok(result.text.includes(Object.keys(payload)[0]!))
   assert.equal(writes.length, 0)
  }
 }
 for (const payload of [null, [], 'invalid']) {
  assert.deepEqual(panel.setConfigData(payload, { Result }), { ok: false, text: '保存失败: 配置需为字段对象' })
  assert.equal(writes.length, 0)
 }
})

test('remaining Guoba writes preserve console values, extensions and YAML comments on disk', t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guoba-panel-'))
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
 const file = path.join(dir, 'message.yaml')
 const settings = {
  systemContent: 'original prompt',
  smartTrigger: { talkValue: 0.15, futureTuning: { enabled: true } },
  messageArchive: { retentionDays: 30, groupAdmins: [{ groupId: '123', admins: ['456'] }] },
  chatAiConfig: {
   providers: [{ _consoleId: 'provider-1', name: 'primary', apiUrl: 'https://fixture.invalid', model: 'fixture', apiKey: 'console-secret', priority: 7, autoResolve: false, customVendor: { enabled: true } }],
   chatApiKey: 'legacy-console-secret'
  },
  trackAiConfig: { trackAiUrl: 'https://legacy.invalid', trackAiModel: 'legacy', trackAiApikey: 'legacy-track-secret', trackAiPriority: 4 },
  taskAiConfig: { casual: { apiKey: 'task-secret' } },
  persona: { name: 'console persona', futurePersona: true },
  messagePipeline: { eventConcurrency: 3 },
  groupGuard: { enabled: true, timeoutSeconds: 10 },
  groupAdmin: { overrides: [{ groupId: '123', groupGuard: { enabled: false }, futureGroup: { retained: true } }] },
  youtubeRelay: { cookie: 'console-cookie' },
  futureSettings: { nested: ['retained'] }
 }
 const document = new YAML.Document({ pluginSettings: settings, envelopeExtension: { retained: true } })
 const comments: { keys: (string | number)[]; text: string }[] = [
  { keys: ['pluginSettings', 'chatAiConfig', 'providers', 0, 'apiKey'], text: ' keep provider comment' },
  { keys: ['pluginSettings', 'groupAdmin', 'overrides', 0, 'futureGroup'], text: ' keep group extension comment' },
  { keys: ['pluginSettings', 'smartTrigger', 'futureTuning'], text: ' keep remaining sibling comment' }
 ]
 for (const { keys, text } of comments) {
  const node = document.getIn(keys, true)
  assert.ok(YAML.isNode(node))
  node.comment = text
 }
 fs.writeFileSync(file, '# keep document comment\n' + document.toString())
 const repo = createConfigRepository({ file })
 const panel = createConfigPanel({ schemas, readSettings: () => repo.read().settings, applyUpdates: updates => repo.updateFlat(updates) })
 const result = resultOf(panel.setConfigData({
  systemContent: 'updated prompt',
  'messageArchive.enabled': false,
  'messageArchive.retentionDays': 14
 }, { Result }))
 assert.equal(result.ok, true)
 assert.deepEqual(repo.read().settings, {
  ...settings,
  systemContent: 'updated prompt',
  messageArchive: { ...settings.messageArchive, enabled: false, retentionDays: 14 }
 })
 assert.equal(Object.hasOwn(record(repo.read().settings.trackAiConfig), 'providers'), false)
 const saved = fs.readFileSync(file, 'utf8')
 const parsed = YAML.parseDocument(saved)
 assert.ok(saved.includes('# keep document comment'))
 for (const { keys, text } of comments) {
  const node = parsed.getIn(keys, true)
  assert.ok(YAML.isNode(node))
  assert.equal(node.comment, text)
 }
 assert.deepEqual(record(parsed.toJS()).envelopeExtension, { retained: true })
 const filesAfterSave = fs.readdirSync(dir).sort()
 for (const payload of [
  { systemContent: 'must not be written', 'chatAiConfig.providers': [{ apiKey: '' }] },
  { systemContent: 'must not be written', 'groupAdmin.overrides': [] },
  { chatAiConfig: { providers: [] } },
  { smartTrigger: { talkValue: 1 } }
 ]) {
  assert.equal(resultOf(panel.setConfigData(payload, { Result })).ok, false)
  assert.equal(fs.readFileSync(file, 'utf8'), saved)
  assert.deepEqual(fs.readdirSync(dir).sort(), filesAfterSave)
 }
})

test('shared provider normalizer leaves unsubmitted channels alone and ignores unusable lists', () => {
 const current = { chatAiConfig: { providers: [{ apiUrl: 'https://fixture.invalid', model: 'fixture', apiKey: 'key', priority: 7 }] } }
 assert.deepEqual(normalizeAiProviderUpdates({ 'smartTrigger.talkValue': 0.3 }, current), { 'smartTrigger.talkValue': 0.3 })
 for (const providers of [null, [], [null, 7, {}]]) {
  assert.deepEqual(normalizeAiProviderUpdates({ 'chatAiConfig.providers': providers }, current), {})
 }
})

test('shared provider updates preserve custom fields and propagate explicit cleared size', () => {
 const updates = normalizeAiProviderUpdates({ 'imageGenerationAiConfig.providers': [{ apiUrl:'https://fixture.invalid', model:'fixture', apiKey:'secret', capabilities:{edit:true}, portraitSize:'' }] })
 const providers = updates['imageGenerationAiConfig.providers'] as Record<string, unknown>[]
 assert.deepEqual(providers[0]?.capabilities, {edit:true})
 assert.equal(updates['imageGenerationAiConfig.imageGenerationPortraitSize'], '')
})

test('shared normalizer preserves unsubmitted extensions by unique identity', () => {
 const row = {name:'channel',apiUrl:'https://fixture.invalid',model:'fixture',apiKey:'key',priority:1, custom:{enabled:true}}
 const updates = normalizeAiProviderUpdates({'chatAiConfig.providers':[{name:row.name,apiUrl:row.apiUrl,model:row.model,apiKey:row.apiKey,priority:2}]}, {chatAiConfig:{providers:[row]}})
 assert.deepEqual((updates['chatAiConfig.providers'] as Record<string, unknown>[])[0]?.custom, {enabled:true})
})
