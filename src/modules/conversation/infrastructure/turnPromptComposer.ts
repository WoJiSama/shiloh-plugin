import type {createGlobalStyleLearnerClass} from '../../memory/infrastructure/globalStyleLearner.js'
import type {createPersonProfileClass} from '../../memory/application/personProfileInjector.js'
import type {PersonaText} from '../domain/personaSource.js'
import type {TurnInteractionContext} from '../../../contracts/turnInteraction.js'
import type {PersonaScope, PersonaSnapshot} from '../../../contracts/persona.js'
import {createHash} from 'node:crypto'
import {resolvePersonaName} from '../domain/personaSource.js'
type Style=InstanceType<ReturnType<typeof createGlobalStyleLearnerClass>>
type Profile=InstanceType<ReturnType<typeof createPersonProfileClass>>
interface ComposerConfig {emotionSystem?:{enabled?:boolean};memorySystem?:{enabled?:boolean};expressionLearning?:{enabled?:boolean};personProfileInjection?:{enabled?:boolean};midtermMemory?:{enabled?:boolean};globalStyleLearning?:Parameters<Style['buildPrompt']>[0] & {semanticPromptWaitMs?:number};embeddingAiConfig?:{embeddingApiUrl?:string;embeddingApiKey?:string;embeddingApiModel?:string};persona?:PersonaText;personaGuard?:Record<string,unknown>;promptLayerCache?:{enabled?:boolean}}
interface ComposerTurn {groupId?:string|number;userId?:string|number;event?:Parameters<Profile['build']>[2];viewerSelfId?:unknown;viewerBotName?:string;messageText?:string;memoryText?:string;rawMessageText?:string;toneText?:string;cardText?:string;cardResponseKind?:string;moodHint?:Parameters<typeof formatMoodPrompt>[0];interactionContext?:TurnInteractionContext}
interface ComposerDeps {emotionManager?:{getEmotionPromptForGroup(groupId:unknown,botId:string):Promise<string>};memoryManager?:{getContextualMemoryPrompt(groupId:unknown,userId:unknown,text:string,now:number,options:{viewerBotName:string;viewer?:PersonaScope|undefined}):Promise<string>;getGroupWorkflowPrompt(groupId:unknown,text:string):Promise<string>;getGroupKnowledgePrompt(groupId:unknown,options:{speakerQQ:unknown;message:string}):Promise<string>};expressionLearner?:{getExpressionPromptForGroup(groupId:unknown):Promise<string>};knowledgeSearcher?:{search(text:string):Promise<{knowledgeContext?:string}|null>};personaFeedbackManager?:{buildFeedbackPrompt(config:Record<string,unknown>|undefined,options:{personaName?:string;source?:PersonaScope}):string;getFeedbackRevision?(source?:PersonaScope):string|number};globalStyleLearnerManager?:Pick<Style,'buildRelevantPrompt'|'buildPrompt'>;personProfileInjector?:Pick<Profile,'build'>;midtermSummaryManager?:{getSummaryPrompt(groupId:unknown):string}}
interface ComposerOptions {config?:ComposerConfig;personaSnapshot?:PersonaSnapshot;profile?:{profile?:string;reason?:string;layers?:string[]};turn?:ComposerTurn;precomputed?:Partial<Record<'identityBindings'|'workflowTeaching'|'knowledgeTeaching'|'memberLookup'|'mergedTrigger',string>>;deps?:ComposerDeps}
interface ComposerLogger {warn?(message:string):void;error?(message:string):void;info?(message:string):void}
function message(error:unknown){return error instanceof Error?error.message:String(error)}

function stableFingerprint(value: unknown): string {
  const stable = (input: unknown): unknown => Array.isArray(input) ? input.map(stable)
    : input && typeof input === 'object'
      ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
      : input
  return createHash('sha256').update(JSON.stringify(stable(value)) ?? '').digest('hex')
}
// 回合提示词组装器:把原本内联在 apps/test.js 主回复流程里的 19 层取数与拼装
// 收敛为一个可单测的函数。职责边界:
// - 异步层读取(emotion/memory/workflow/groupKnowledge/expression/knowledge/
//   personProfile/globalStyle/semanticStyle)并发执行;单层失败按原有降级语义退为空层,
//   不再拖垮整轮回合;
// - 纯文本层(personaTone/narrativeWriting/cardBody/solutionExplanation/personaFeedback)
//   在此构建;
// - 通过 applyPromptLayerProfile 按回合画像(chat/task)裁剪层;
// - 产出 report:每层字符数与总字符数,供观测"这轮到底喂了什么"。
// 所有外部依赖(各 manager)经 deps 注入,本模块不 import 任何 domains 单例,
// 保证测试可以直接用假依赖驱动。
import { applyPromptLayerProfile } from "../domain/promptLayers.js"
import { buildPersonaTonePrompt } from "../domain/personaTonePolicy.js"
import { buildTurnInteractionPrompt } from "../domain/turnInteractionContext.js"
import { formatMoodPrompt } from "../domain/personaMoods.js"
import { isNarrativeWritingRequest } from "../domain/narrativeReply.js"
import { buildSolutionExplanationStylePrompt } from "../domain/solutionExplanationStyle.js"
import { resolveCardPresentation } from "../domain/turnPresentation.js"
import { cachedPromptLayer, isPromptLayerCacheEnabled, LAYER_CACHE_TTL_MS } from "../application/promptLayerCache.js"

export function createTurnPromptComposer(logger:ComposerLogger = {}) {
// 记忆上下文 prompt 热路径超时上限:记忆故障不拖垮回复,超时/异常退化为 ''。
const CONTEXTUAL_MEMORY_PROMPT_TIMEOUT_MS = 1500

async function withContextualMemoryTimeout(promise:Promise<string>) {
  let timer:ReturnType<typeof setTimeout>|null = null
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(''), CONTEXTUAL_MEMORY_PROMPT_TIMEOUT_MS)
  })
  try {
    const result = await Promise.race([promise, timeout])
    return typeof result === 'string' ? result : ''
  } catch (error) {
    logger?.warn?.(`[记忆] 上下文 prompt 获取失败，降级为空: ${message(error)}`)
    return ''
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function withOptionalPromptTimeout(promise:Promise<string>|null, timeoutMs:number) {
  const budget = Math.max(0, Number(timeoutMs) || 0)
  if (!budget) return ''
  let timer:ReturnType<typeof setTimeout>|null = null
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(''), budget)
  })
  try {
    const result = await Promise.race([promise, timeout])
    return typeof result === 'string' ? result : ''
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * @param {object} options
 * @param {object} options.config            完整插件配置(读 persona/personaGuard/各系统开关)
 * @param {object} options.profile           session.promptLayerProfile(resolvePromptLayerProfile 的结果)
 * @param {object} options.turn              回合上下文:
 *   - groupId / userId / event:群与发送者(及原始事件,画像注入需要)
 *   - messageText:e.msg || args(工作流/群知识/语义风格/知识库检索的查询文本)
 *   - memoryText:e.msg || ""(长期记忆取数文本,与原实现一致,不回退到 args)
 *   - toneText:[args, msg, userContent, 引用文本].join("\n")(人设语气/解题风格判定输入)
 *   - cardText:[args, msg, userContent].join("\n")(叙事/卡面判定输入,不含引用文本)
 *   - cardResponseKind:isEducationalExplanationRequest(cardText) ? "knowledge" : "chat"
 * @param {object} options.precomputed       依赖回合早期状态的层 { identityBindings, workflowTeaching, knowledgeTeaching, memberLookup, mergedTrigger }
 * @param {object} options.deps              外部依赖 { emotionManager, memoryManager, expressionLearner, knowledgeSearcher, personaFeedbackManager, globalStyleLearnerManager, personProfileInjector }
 * @returns {Promise<{prompt: string, omitted: string[], layerValues: Record<string,string>, report: object}>}
 */
async function composeTurnPromptLayers({
  config = {},
  personaSnapshot,
  profile,
  turn = {},
  precomputed = {},
  deps = {}
}:ComposerOptions) {
  const {
    emotionManager,
    memoryManager,
    expressionLearner,
    knowledgeSearcher,
    personaFeedbackManager,
    globalStyleLearnerManager,
    personProfileInjector,
    midtermSummaryManager
  } = deps
  const { groupId, userId, event } = turn
  const eventIdentity = event as {self_id?:unknown;bot?:{uin?:unknown}} | undefined
  const viewerSelfId = String(personaSnapshot?.botId || turn.viewerSelfId || eventIdentity?.self_id || eventIdentity?.bot?.uin || "").trim()
  const persona = personaSnapshot?.persona ?? structuredClone(config.persona || {})
  const personaGuard = personaSnapshot ? personaSnapshot.personaGuard ?? {} : structuredClone(config.personaGuard || {})
  const viewerBotName = String(personaSnapshot?.personaName || turn.viewerBotName || "").trim()
  const legacyVersion = stableFingerprint(persona)
  const personaSource: PersonaScope | undefined = personaSnapshot ?? (viewerSelfId ? {
    botId: viewerSelfId,
    personaId: `legacy:${legacyVersion}`,
    personaVersion: legacyVersion,
    personaName: resolvePersonaName(persona)
  } : undefined)
  const messageText = String(turn.messageText || "")
  const memoryText = String(turn.memoryText ?? (turn.messageText || ""))
  const toneText = String(turn.toneText || messageText)
  const cardText = String(turn.cardText ?? toneText)
  const rawMessageText = String(turn.rawMessageText ?? (turn.messageText || ""))
  const chatFastPath = profile?.profile === "chat"
  // 慢变化层(情绪/表达/全局风格/人设反馈/画像)按 TTL 缓存;key 为空表示该层无缓存键(如私聊无群号),直读
  const layerCacheEnabled = isPromptLayerCacheEnabled(config)
  const cachedOr = (key:string, ttlMs:number, loader:()=>Promise<string>|string):Promise<string> =>
    (layerCacheEnabled && key ? cachedPromptLayer(key, ttlMs, loader) : Promise.resolve().then(loader))

  const e_selfId = (selfId:unknown) => (selfId ? String(selfId) : "")

  // ── 异步层读取(原为顺序 await,各层内容与降级语义不变) ──
  // 语义风格层保持原有的"提前启动"时序:先 kickoff,等其他层取完后才进入
  // semanticPromptWaitMs 的超时竞速,避免并发化后丢掉提前量导致该层更容易超时。
  const semanticStylePromise = chatFastPath || !globalStyleLearnerManager
    ? null
    : globalStyleLearnerManager.buildRelevantPrompt(config.globalStyleLearning, {
        query: messageText,
        embeddingConfig: config.embeddingAiConfig || {},
        ...(personaSource ? {source: personaSource} : {})
      }).catch(error => {
        logger?.warn?.(`[全局表达学习] 语义提示读取失败: ${message(error)}`)
        return ''
      })

  const [
    emotionPrompt,
    memoryPrompt,
    workflowPrompt,
    groupKnowledgePrompt,
    expressionPrompt,
    knowledgePrompt,
    personProfilePrompt,
    globalStylePrompt,
    midtermMemoryPrompt
  ] = await Promise.all([
    config.emotionSystem?.enabled && emotionManager
      ? cachedOr(groupId ? `emotion:${viewerSelfId}:${groupId}` : "", LAYER_CACHE_TTL_MS.emotion,
          () => emotionManager.getEmotionPromptForGroup(groupId, e_selfId(viewerSelfId)))
        .catch(error => {
          logger?.warn?.(`[情绪] prompt 获取失败，降级为空: ${message(error)}`)
          return ''
        })
      : '',
    config.memorySystem?.enabled && memoryManager
      ? withContextualMemoryTimeout(memoryManager.getContextualMemoryPrompt(groupId, userId, memoryText, Date.now(), { viewerBotName, viewer:personaSource }))
      : '',
    config.memorySystem?.enabled && memoryManager
      ? memoryManager.getGroupWorkflowPrompt(groupId, messageText).catch(error => {
        logger?.warn?.(`[群工作流] 读取失败 group=${groupId}: ${message(error)}`)
        return ''
      })
      : '',
    config.memorySystem?.enabled && memoryManager
      ? memoryManager.getGroupKnowledgePrompt(groupId, { speakerQQ: userId, message: messageText }).catch(error => {
        logger?.warn?.(`[群知识] 读取失败 group=${groupId}: ${message(error)}`)
        return ''
      })
      : '',
    config.expressionLearning?.enabled && expressionLearner
      ? cachedOr(groupId ? `expression:${groupId}` : "", LAYER_CACHE_TTL_MS.expression,
          () => expressionLearner.getExpressionPromptForGroup(groupId))
        .catch(error => {
          logger?.warn?.(`[表达学习] prompt 获取失败，降级为空: ${message(error)}`)
          return ''
        })
      : '',
    (async () => {
      if (!knowledgeSearcher || !rawMessageText || chatFastPath) return ''
      try {
        const result = await knowledgeSearcher.search(rawMessageText)
        if (result?.knowledgeContext) {
          return `【知识库参考】\n以下是与当前话题相关的参考知识，请在回复时自然融入（不要生硬引用）：\n${result.knowledgeContext}`
        }
      } catch (err) {
        logger?.error?.(`[知识库] 检索失败: ${message(err)}`)
      }
      return ''
    })(),
    (async () => {
      if (!config.personProfileInjection?.enabled || !groupId || !userId || !personProfileInjector) return ''
      try {
        return await cachedOr(`personProfile:${groupId}:${userId}`, LAYER_CACHE_TTL_MS.personProfile,
          () => personProfileInjector.build(groupId, userId, event || {}))
      } catch (err) {
        logger?.error?.(`[画像注入] 失败: ${message(err)}`)
        return ''
      }
    })(),
    globalStyleLearnerManager
      ? cachedOr("globalStyle", LAYER_CACHE_TTL_MS.globalStyle,
          () => globalStyleLearnerManager.buildPrompt(config.globalStyleLearning))
      : '',
    // 中期记忆:本群滚动主线摘要(纯本地读盘,微秒级;摘要变化频率低,走 60s 层缓存)
    (async () => {
      if (!config.midtermMemory?.enabled || !midtermSummaryManager || !groupId) return ''
      try {
        return await cachedOr(groupId ? `midtermMemory:${groupId}` : "", 60_000,
          () => Promise.resolve(midtermSummaryManager.getSummaryPrompt(groupId)))
      } catch (err) {
        logger?.warn?.(`[中期记忆] prompt 读取失败 group=${groupId}: ${message(err)}`)
        return ''
      }
    })()
  ])
  const semanticStylePrompt = await withOptionalPromptTimeout(
    semanticStylePromise,
    config.globalStyleLearning?.semanticPromptWaitMs ?? 350
  )

  // ── 纯文本层 ──
  // 人设语气层顺带携带"本回合心情"(调皮情绪时刻):test.js 每回合掷骰后经 turn.moodHint 传入,
  // 命中时只给这一回合加一点情绪着色,不换人格。
  const moodHintPrompt = turn.interactionContext && !turn.interactionContext.allowPlayfulness ? '' : formatMoodPrompt(turn.moodHint || undefined)
  const personaTonePrompt = [
    buildPersonaTonePrompt({
      userText: turn.interactionContext?.rawUserText ?? toneText,
      ...(turn.interactionContext ? {interactionContext: turn.interactionContext} : {}),
      persona
    }),
    moodHintPrompt
  ].filter(Boolean).join("\n")
  const narrativeWritingPrompt = isNarrativeWritingRequest(cardText)
    ? [
        "【叙事输出格式】",
        "当前回复会在单独的确认消息后被完整渲染为卡面。直接从单独一行的半角 ASCII 一级标题 `# 标题` 开始，再换行写正文；不要使用全角 `＃`，不要把正文紧跟在标题同一行。不要写“我试试看”“我来写”“下面是故事”等开场、创作说明或人物清单。",
        "正文每个自然段之间必须保留一个空行；对话、场景转换和时间跳转都要另起段。不要为了节省篇幅把小说压成连续大段。"
      ].join("\n")
    : ""
  const cardBodyPrompt = resolveCardPresentation(cardText, turn.cardResponseKind || "chat")
    ? [
        "【卡面正文边界】",
        "这次会先单独发送一条确认消息，随后把你的全部输出渲染为卡面。卡面必须直接从完整内容开始：故事从标题开始；解释、整理或文档从结论、标题或第一段实质内容开始。不要重复确认、不要说正在写/整理、不要提及卡面或输出过程。"
      ].join("\n")
    : ""
  // Technical nouns inside a quote or a joke are not a new technical task.
  // Let the shared speech-act state decide whether this template applies.
  const solutionExplanationPrompt = turn.interactionContext
    && (turn.interactionContext.kind !== 'serious_answer' || turn.interactionContext.social?.act === 'criticism')
    ? ''
    : buildSolutionExplanationStylePrompt(toneText)
  const feedbackCacheKey = personaSource ? `personaFeedback:${stableFingerprint({
    botId: personaSource.botId,
    personaId: personaSource.personaId,
    personaVersion: personaSource.personaVersion,
    personaName: personaSource.personaName,
    guard: personaGuard,
    revision: personaFeedbackManager?.getFeedbackRevision?.(personaSource) ?? ''
  })}` : ''
  const personaFeedbackPrompt = personaFeedbackManager
    ? await cachedOr(feedbackCacheKey, LAYER_CACHE_TTL_MS.personaFeedback,
        () => personaFeedbackManager.buildFeedbackPrompt(personaGuard, {
          personaName: personaSource?.personaName ?? resolvePersonaName(persona),
          ...(personaSource ? {source: personaSource} : {})
        }))
    : ''

  const layerMap:Record<string,string> = {
    identityBindings: precomputed.identityBindings || "",
    workflowTeaching: precomputed.workflowTeaching || "",
    knowledgeTeaching: precomputed.knowledgeTeaching || "",
    workflow: workflowPrompt,
    groupKnowledge: groupKnowledgePrompt,
    mergedTrigger: precomputed.mergedTrigger || "",
    emotion: emotionPrompt,
    memory: memoryPrompt,
    midtermMemory: midtermMemoryPrompt,
    expression: expressionPrompt,
    interaction: buildTurnInteractionPrompt(turn.interactionContext),
    personaTone: personaTonePrompt,
    narrativeWriting: narrativeWritingPrompt,
    solutionExplanation: solutionExplanationPrompt,
    cardBody: cardBodyPrompt,
    personaFeedback: personaFeedbackPrompt,
    globalStyle: globalStylePrompt,
    semanticStyle: semanticStylePrompt,
    knowledge: knowledgePrompt,
    memberLookup: precomputed.memberLookup || "",
    personProfile: personProfilePrompt
  }

  const result = applyPromptLayerProfile(profile, layerMap)

  const included = Object.keys(layerMap)
    .filter(name => layerMap[name] && result.prompt.includes(layerMap[name]!))
    .map(name => ({ name, chars: layerMap[name]!.length }))
  const report = {
    profile: profile?.profile || "task",
    reason: profile?.reason || "",
    totalChars: result.prompt.length,
    included,
    omitted: result.omitted
  }
  const layerSummary = included.map(item => `${item.name}=${item.chars}`).join(" ")
  logger?.info?.(
    `[提示词分层] profile=${report.profile} reason=${report.reason || "casual"} layers=${included.length}/${included.length + report.omitted.length} total=${report.totalChars}c ${layerSummary}`
  )

  return { prompt: result.prompt, omitted: result.omitted, layerValues: layerMap, report }
}

return {composeTurnPromptLayers}
}
