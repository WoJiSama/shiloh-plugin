import test from 'node:test'
import assert from 'node:assert/strict'
import {withPersonaSnapshot} from '../../src/modules/conversation/domain/personaSnapshotConfig.js'
import {createReplyRendering, type ReplyDeliveryPort, type ReplyEvent} from '../../src/modules/conversation/application/replyRendering.js'
import {createForbiddenWordGuard} from '../../src/modules/conversation/domain/forbiddenWordGuard.js'
import {BananaTool} from '../../src/modules/toolSupport/infrastructure/BananaTool.js'
import {createGoogleImageAnalysisTool} from '../../src/modules/toolSupport/infrastructure/GoogleAnalysisTool.js'
import {createGoogleImageEditTool} from '../../src/modules/toolSupport/infrastructure/GoogleImageEditTool.js'
import {createPersonaFeedbackModule} from '../../src/modules/memory/infrastructure/personaFeedbackManager.js'
import type {DrawBridge, DrawEvent} from '../../src/contracts/bananaTool.js'
import type {PersonaSnapshot} from '../../src/contracts/persona.js'

function snapshot(name: string, guard = true): PersonaSnapshot {
  return Object.freeze({botId: '99', personaId: name, personaVersion: 'v1', personaName: name,
    persona: Object.freeze({name, tone: `${name}的语气`, notes: `${name}的人设备注`}),
    systemContent: `${name}的系统提示`,
    ...(guard ? {personaGuard: Object.freeze({enabled: true, badPatterns: [`${name}禁词`]})} : {})})
}

test('persona projection preserves provider settings and clears a newly loaded guard absent from the snapshot', () => {
  const provider = {model: 'provider-model', apiKey: 'fixture-key'}
  const config = {provider, persona: {name: '新配置'}, systemContent: '新提示', personaGuard: {enabled: true}}
  const captured = snapshot('甲', false)
  const projected = withPersonaSnapshot(config, {_personaSnapshot: captured})
  assert.equal(projected.provider, provider)
  assert.equal(projected.persona, captured.persona)
  assert.equal(projected.systemContent, captured.systemContent)
  assert.equal(projected.personaGuard, undefined)
  assert.equal(config.persona.name, '新配置', 'the loaded configuration is not mutated')
  assert.equal(withPersonaSnapshot(config, {}), config, 'standalone commands retain their original configuration')
})

for (const kind of ['banana', 'analysis', 'edit'] as const) {
  for (const hasGuard of [true, false]) {
    test(`${kind} progress generation and guard retain the captured persona while configuration changes (guard=${hasGuard})`, async () => {
      const initial = snapshot('甲', hasGuard), replacement = snapshot('乙')
      const provider = {progress: {model: 'unchanged-provider'}}
      const config: Record<string, unknown> = {persona: replacement.persona, systemContent: replacement.systemContent,
        personaGuard: replacement.personaGuard, taskAiConfig: provider}
      let bridge: DrawBridge = {config: {persona: replacement.persona, personaGuard: replacement.personaGuard}, getPersonaFor: () => replacement.persona}
      let finishProgress!: () => void
      const waiting = new Promise<void>(resolve => { finishProgress = resolve })
      let generatedConfig: unknown
      const guardCalls: {config: unknown; botNames: unknown[]}[] = []
      const sent: unknown[] = []
      const {PersonaFeedbackManager} = createPersonaFeedbackModule({isToneCorrectionMessage: () => false})
      const feedbackManager = new PersonaFeedbackManager({cwd: '/unused'})
      const progressReplyFactory = async (input: {config?: unknown} = {}) => {
        generatedConfig = input.config
        await waiting
        return '欸，别突然这么叫呀，有点不好意思啦。'
      }
      const guardReply = (text: string, guard: unknown, context: {botNames: unknown[]}) => {
        guardCalls.push({config: guard, botNames: context.botNames})
        return feedbackManager.guardReply(text, guard as Record<string, unknown> | undefined,
          {userText: '这处构图帮我调整一下', botNames: context.botNames.filter((value): value is string => typeof value === 'string')})
      }
      const logger = {info() {}, warn() {}, error() {}}
      const unused = async (): Promise<never> => { throw new Error('unexpected provider request') }
      const common = {loadConfig: () => config, normalizeImageUrls: async (images: string[]) => images,
        imageLoader: unused, progressReplyFactory, guardReply, callApi: unused, logger}
      const tool = kind === 'banana'
        ? new BananaTool({progressReplyFactory}, {getRedis: () => null, getBot: () => null, getBridge: () => bridge,
          normalizeImageUrls: common.normalizeImageUrls, guardReply, logger,
          segment: {image: buffer => ({type: 'image', buffer})}, resolveImageBuffer: unused, getImageBufferMetadata: unused,
          isMessageSendFailed: () => false, formatMessageSendFailure: () => '', isUrlAvailable: async () => false,
          imageService: {fetch: globalThis.fetch, loadReference: unused, encodeMultipart: unused, resolveImage: unused, metadata: unused}})
        : kind === 'analysis'
          ? new (createGoogleImageAnalysisTool(common))()
          : new (createGoogleImageEditTool({...common, getRedis: () => null, getBot: () => null,
            sendImageReliably: unused, mimeTypes: {extension: () => false, lookup: () => false}}))()
      const event: DrawEvent = {_personaSnapshot: initial, msg: '这处构图帮我调整一下', bot: {uin: 99, nickname: '账号昵称'},
        reply: async message => { sent.push(message); return {message_id: 1} }}
      const pending = tool.sendProgress(event, {config})
      assert.ok(generatedConfig, 'the progress factory is entered before the configuration changes')
      config.persona = snapshot('丙').persona
      config.systemContent = '丙的提示'
      config.personaGuard = {enabled: false}
      bridge = {config: {persona: {name: '丙'}, personaGuard: {enabled: false}}, getPersonaFor: () => ({name: '丙'})}
      event.bot!.nickname = '异步切换后的账号别名'
      event._personaSnapshot = replacement
      finishProgress()
      assert.equal(await pending, true)
      const generated = generatedConfig as Record<string, unknown>
      assert.equal(generated.persona, initial.persona)
      assert.equal(generated.systemContent, initial.systemContent)
      assert.equal(generated.taskAiConfig, provider)
      assert.equal(generated.personaGuard, initial.personaGuard)
      assert.equal(guardCalls.length, 1)
      assert.equal(guardCalls[0]!.config, initial.personaGuard)
      assert.deepEqual(guardCalls[0]!.botNames, ['甲'], 'an account alias must not take the persona name used by the guard')
      assert.deepEqual(sent, ['叫我甲就好。'], 'the real guard must speak as the captured persona even with no explicit guard configuration')
    })
  }
}

test('unguarded reply delivery pins persona and an absent guard before awaiting a claim', async () => {
  const initial = snapshot('甲', false), replacement = snapshot('乙')
  let releaseClaim!: () => void
  const waiting = new Promise<void>(resolve => { releaseClaim = resolve })
  const seen: {personaGuard?: unknown; botNames: string[]}[] = [], sent: unknown[] = []
  const api = createReplyRendering({logger: {info() {}, warn() {}, mark() {}, error() {}}, bot: () => ({uin: 99, nickname: '账号昵称'}),
    at: qq => ({type: 'at', qq}), lastIncoming: () => 0, shouldCancelProactiveReply: () => false,
    guard: createForbiddenWordGuard({warn() {}}), applyOutputPersonaGuards: (text, options) => { seen.push(options); return text },
    TotalTokens: async () => ({total_tokens: 5}), stats: () => null})
  const host: ReplyDeliveryPort = {config: {persona: replacement.persona, personaGuard: replacement.personaGuard!, replyRhythm: {enabled: false}, sendPacing: {enabled: false}},
    claimTurnReply: async () => { await waiting; return {claimed: true} }, getPersonaFor: () => replacement.persona,
    sendObservedReply: async (_event, payload) => { sent.push(payload); return {message_id: 1} },
    getSmartState: () => ({lastBotReplyAt: 0, lastBotReplyToUserId: null, lastBotReplyKeywords: []}),
    splitMessage: text => [text], splitLongMessageByPunctuation: text => [text],
    convertAtInString: async () => ({hasAt: false, msgSegments: null}), findMember: () => null}
  const event: ReplyEvent = {_personaSnapshot: initial, group_id: 1, user_id: 2, msg: '你好', reply: async () => ({message_id: 1})}
  const pending = api.sendSegmentedMessage(host, event, '这是原人格的回复。', 0)
  host.config = {...host.config, persona: {name: '丙'}, personaGuard: {enabled: false}}
  event._personaSnapshot = replacement
  releaseClaim()
  assert.equal(await pending, 1)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.personaGuard, undefined)
  assert.ok(seen[0]!.botNames.includes('甲'))
  assert.ok(!seen[0]!.botNames.includes('乙'))
  assert.deepEqual(sent, ['这是原人格的回复。'])
})
