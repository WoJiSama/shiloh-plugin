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
import { applyPromptLayerProfile } from "./promptLayers.js"
import { buildPersonaTonePrompt } from "./personaTonePolicy.js"
import { isNarrativeWritingRequest } from "./narrativeReply.js"
import { buildSolutionExplanationStylePrompt } from "./solutionExplanationStyle.js"
import { resolveCardPresentation } from "./turnPresentation.js"
import { cachedPromptLayer, isPromptLayerCacheEnabled, LAYER_CACHE_TTL_MS } from "./promptLayerCache.js"

// 记忆上下文 prompt 热路径超时上限:记忆故障不拖垮回复,超时/异常退化为 ''。
const CONTEXTUAL_MEMORY_PROMPT_TIMEOUT_MS = 1500

async function withContextualMemoryTimeout(promise) {
  let timer = null
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(''), CONTEXTUAL_MEMORY_PROMPT_TIMEOUT_MS)
  })
  try {
    const result = await Promise.race([promise, timeout])
    return typeof result === 'string' ? result : ''
  } catch (error) {
    globalThis.logger?.warn?.(`[记忆] 上下文 prompt 获取失败，降级为空: ${error?.message || error}`)
    return ''
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function withOptionalPromptTimeout(promise, timeoutMs) {
  const budget = Math.max(0, Number(timeoutMs) || 0)
  if (!budget) return ''
  let timer = null
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
export async function composeTurnPromptLayers({
  config = {},
  profile,
  turn = {},
  precomputed = {},
  deps = {}
}) {
  const {
    emotionManager,
    memoryManager,
    expressionLearner,
    knowledgeSearcher,
    personaFeedbackManager,
    globalStyleLearnerManager,
    personProfileInjector
  } = deps
  const { groupId, userId, event } = turn
  const messageText = String(turn.messageText || "")
  const memoryText = String(turn.memoryText ?? (turn.messageText || ""))
  const toneText = String(turn.toneText || messageText)
  const cardText = String(turn.cardText ?? toneText)
  const rawMessageText = String(turn.rawMessageText ?? (turn.messageText || ""))
  const chatFastPath = profile?.profile === "chat"
  // 慢变化层(情绪/表达/全局风格/人设反馈/画像)按 TTL 缓存;key 为空表示该层无缓存键(如私聊无群号),直读
  const layerCacheEnabled = isPromptLayerCacheEnabled(config)
  const cachedOr = (key, ttlMs, loader) =>
    (layerCacheEnabled && key ? cachedPromptLayer(key, ttlMs, loader) : loader())

  // ── 异步层读取(原为顺序 await,各层内容与降级语义不变) ──
  // 语义风格层保持原有的"提前启动"时序:先 kickoff,等其他层取完后才进入
  // semanticPromptWaitMs 的超时竞速,避免并发化后丢掉提前量导致该层更容易超时。
  const semanticStylePromise = chatFastPath || !globalStyleLearnerManager
    ? null
    : globalStyleLearnerManager.buildRelevantPrompt(config.globalStyleLearning, {
        query: messageText,
        embeddingConfig: config.embeddingAiConfig
      }).catch(error => {
        globalThis.logger?.warn?.(`[全局表达学习] 语义提示读取失败: ${error?.message}`)
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
    globalStylePrompt
  ] = await Promise.all([
    config.emotionSystem?.enabled && emotionManager
      ? cachedOr(groupId ? `emotion:${groupId}` : "", LAYER_CACHE_TTL_MS.emotion,
          () => emotionManager.getEmotionPromptForGroup(groupId))
        .catch(error => {
          globalThis.logger?.warn?.(`[情绪] prompt 获取失败，降级为空: ${error?.message || error}`)
          return ''
        })
      : '',
    config.memorySystem?.enabled && memoryManager
      ? withContextualMemoryTimeout(memoryManager.getContextualMemoryPrompt(groupId, userId, memoryText, Date.now()))
      : '',
    config.memorySystem?.enabled && memoryManager
      ? memoryManager.getGroupWorkflowPrompt(groupId, messageText).catch(error => {
        globalThis.logger?.warn?.(`[群工作流] 读取失败 group=${groupId}: ${error?.message}`)
        return ''
      })
      : '',
    config.memorySystem?.enabled && memoryManager
      ? memoryManager.getGroupKnowledgePrompt(groupId, { speakerQQ: userId, message: messageText }).catch(error => {
        globalThis.logger?.warn?.(`[群知识] 读取失败 group=${groupId}: ${error?.message}`)
        return ''
      })
      : '',
    config.expressionLearning?.enabled && expressionLearner
      ? cachedOr(groupId ? `expression:${groupId}` : "", LAYER_CACHE_TTL_MS.expression,
          () => expressionLearner.getExpressionPromptForGroup(groupId))
        .catch(error => {
          globalThis.logger?.warn?.(`[表达学习] prompt 获取失败，降级为空: ${error?.message || error}`)
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
        globalThis.logger?.error?.(`[知识库] 检索失败: ${err?.message}`)
      }
      return ''
    })(),
    (async () => {
      if (!config.personProfileInjection?.enabled || !groupId || !userId || !personProfileInjector) return ''
      try {
        return await cachedOr(`personProfile:${groupId}:${userId}`, LAYER_CACHE_TTL_MS.personProfile,
          () => personProfileInjector.build(groupId, userId, event))
      } catch (err) {
        globalThis.logger?.error?.(`[画像注入] 失败: ${err?.message}`)
        return ''
      }
    })(),
    globalStyleLearnerManager
      ? cachedOr("globalStyle", LAYER_CACHE_TTL_MS.globalStyle,
          () => globalStyleLearnerManager.buildPrompt(config.globalStyleLearning))
      : ''
  ])
  const semanticStylePrompt = await withOptionalPromptTimeout(
    semanticStylePromise,
    config.globalStyleLearning?.semanticPromptWaitMs ?? 350
  )

  // ── 纯文本层 ──
  const personaTonePrompt = buildPersonaTonePrompt({
    userText: toneText,
    persona: config.persona
  })
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
  const solutionExplanationPrompt = buildSolutionExplanationStylePrompt(toneText)
  const personaFeedbackPrompt = personaFeedbackManager
    ? await cachedOr("personaFeedback", LAYER_CACHE_TTL_MS.personaFeedback,
        () => personaFeedbackManager.buildFeedbackPrompt(config.personaGuard, { personaName: config.persona?.name }))
    : ''

  const layerMap = {
    identityBindings: precomputed.identityBindings || "",
    workflowTeaching: precomputed.workflowTeaching || "",
    knowledgeTeaching: precomputed.knowledgeTeaching || "",
    workflow: workflowPrompt,
    groupKnowledge: groupKnowledgePrompt,
    mergedTrigger: precomputed.mergedTrigger || "",
    emotion: emotionPrompt,
    memory: memoryPrompt,
    expression: expressionPrompt,
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
    .filter(name => layerMap[name] && result.prompt.includes(layerMap[name]))
    .map(name => ({ name, chars: layerMap[name].length }))
  const report = {
    profile: profile?.profile || "task",
    reason: profile?.reason || "",
    totalChars: result.prompt.length,
    included,
    omitted: result.omitted
  }
  const layerSummary = included.map(item => `${item.name}=${item.chars}`).join(" ")
  globalThis.logger?.info?.(
    `[提示词分层] profile=${report.profile} reason=${report.reason || "casual"} layers=${included.length}/${included.length + report.omitted.length} total=${report.totalChars}c ${layerSummary}`
  )

  return { prompt: result.prompt, omitted: result.omitted, layerValues: layerMap, report }
}
