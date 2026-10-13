import assert from 'node:assert/strict'
import test from 'node:test'
import { schemas } from '../../src/modules/config/domain/schemas/guoba/index.js'
import conversation from '../../src/modules/config/domain/schemas/shared/conversation.js'
import { createConfigPanel } from '../../src/modules/config/application/configPanel.js'
import { getProviderDefinition, normalizeAiProviderUpdates } from '../../src/modules/config/domain/aiProviderConfig.js'

test('shared config schemas retain unique named fields and reasoning choices', () => {
 const fields = conversation.flatMap(item => item.field ? [item.field] : [])
 assert.equal(new Set(fields).size, fields.length)
 assert.ok(schemas.some(item => item.field === 'chatAiConfig.providers'))
 const definition = getProviderDefinition('imageGenerationAiConfig')
 assert.ok(definition?.extraFields?.some(field => field.panelField === 'portraitSize'))
})
test('panel saves normalized channel updates and reports persistence failure as failure', () => {
 let updates: Record<string, unknown> = {}
 const Result = { ok: (_data: unknown, text: string) => ({ ok: true, text }), error: (text: string) => ({ ok: false, text }) }
 const panel = createConfigPanel({ readSettings: () => ({}), applyUpdates: value => { updates = value }, probeProviders: async () => [], classifyKind: () => 'chat', summarizeProbes: () => ({allOk: true, text: ''}) })
 assert.deepEqual(panel.setConfigData({ 'chatAiConfig.providers': [{ apiUrl: 'https://fixture.invalid', model: 'fixture', apiKey: 'key', priority: 1 }] }, {Result}), {ok: true, text:'保存成功 (´。• ᵕ •。`)'})
 assert.equal(updates['chatAiConfig.chatApiModel'], 'fixture')
 const failed = createConfigPanel({ readSettings: () => ({}), applyUpdates: () => { throw new Error('conflict') }, probeProviders: async () => [], classifyKind: () => 'chat', summarizeProbes: () => ({allOk: true, text: ''}) })
 assert.deepEqual(failed.setConfigData({}, {Result}), {ok: false, text:'保存失败: conflict'})
 assert.deepEqual(normalizeAiProviderUpdates({'chatAiConfig.providers':[null, 7, {}]}), {})
})
test('provider updates preserve custom fields and propagate explicit cleared size', () => {
 const updates = normalizeAiProviderUpdates({ 'imageGenerationAiConfig.providers': [{ apiUrl:'https://fixture.invalid', model:'fixture', apiKey:'secret', capabilities:{edit:true}, portraitSize:'' }] })
 const providers = updates['imageGenerationAiConfig.providers'] as Record<string, unknown>[]
 assert.deepEqual(providers[0]?.capabilities, {edit:true})
 assert.equal(updates['imageGenerationAiConfig.imageGenerationPortraitSize'], '')
})
test('legacy form preserves unsubmitted extensions by unique identity, never by position', () => {
 const row = {name:'channel',apiUrl:'https://fixture.invalid',model:'fixture',apiKey:'key',priority:1, custom:{enabled:true}}
 const updates = normalizeAiProviderUpdates({'chatAiConfig.providers':[{name:row.name,apiUrl:row.apiUrl,model:row.model,apiKey:row.apiKey,priority:2}]}, {chatAiConfig:{providers:[row]}})
 assert.deepEqual((updates['chatAiConfig.providers'] as Record<string, unknown>[])[0]?.custom, {enabled:true})
})
