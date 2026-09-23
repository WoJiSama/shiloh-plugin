// 提示上下文构建:引用/近景/生图连续性/理解增强/生图修图 prompt。
// 从 apps/test.js 原样迁出(P2),行为不变;this 依赖以 host(插件实例)注入。
import { normalizeIntentText, isImageGenerationRequest, isImageEditRequest, isImageCompositionEditRequest } from "../../core/intent/messageIntent.js"
import { safeTruncateUnicode } from "../../utils/unicodeText.js"
import { joinIntentParts } from "../../utils/messageContext.js"

export function getQuotedPromptContextText(host, e = {}, userContent = "") {
    const context = e?._quotedPromptContext
    const lines = []
    if (context?.text) {
      if (context.senderName) lines.push(`引用自 ${context.senderName}:`)
      lines.push(context.text)
    }
    if (context?.mediaSummary) lines.push(`引用消息还包含：${context.mediaSummary}`)
    if (lines.length) return compactDrawPromptText(lines.join("\n"), 2800)

    const content = String(userContent || "")
    const match = content.match(/\[回复\s+(.{1,80}?)的消息[:：]\s*([\s\S]*?)\]\s*(?:@|在群里说[:：]|$)/)
    if (!match) return ""
    return compactDrawPromptText(`引用自 ${match[1]}:\n${match[2]}`, 2800)
  }

export function getRecentPromptContextText(host, messages = [], currentUserContent = "", maxLength = 1200) {
    if (!Array.isArray(messages) || !messages.length) return ""

    const current = normalizeForContainment(currentUserContent)
    const lines = []
    for (const message of messages) {
      if (!message || message.role === "system") continue
      const content = String(message.content || "")
      if (!content || content.startsWith("【系统提示】")) continue

      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine
          .replace(/\[CQ:[^\]]+\]/g, " ")
          .replace(/https?:\/\/\S+/g, "[图片/链接]")
          .replace(/\s+/g, " ")
          .trim()
        if (!line) continue
        if (/此处为调用工具的结果|调用工具|当前QQ群.*群聊历史记录|系统提示/.test(line)) continue
        if (/^\[图片\/链接\]$/.test(line)) continue
        if (current && normalizeForContainment(line).includes(current.slice(0, 32))) continue
        lines.push(safeTruncateUnicode(line, 180))
      }
    }

    const recent = lines.slice(-8)
    return recent.length ? compactDrawPromptText(recent.join("\n"), maxLength) : ""
  }

export function getRecentDrawContextText(host, messages = [], currentUserContent = "", maxLength = 1200) {
    if (!Array.isArray(messages) || !messages.length) return ""

    const current = normalizeForContainment(currentUserContent)
    const lines = []
    for (const message of messages) {
      if (!message || message.role === "system") continue
      const content = String(message.content || "")
      if (!content || content.startsWith("【系统提示】")) continue

      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine
          .replace(/\[CQ:[^\]]+\]/g, " ")
          .replace(/https?:\/\/\S+/g, "[图片/链接]")
          .replace(/\s+/g, " ")
          .trim()
        if (!line) continue
        if (/此处为调用工具的结果|调用工具|当前QQ群.*群聊历史记录|系统提示/.test(line)) continue
        if (/^\[历史处理标记/.test(line)) continue
        if (current && normalizeForContainment(line).includes(current.slice(0, 32))) continue

        const normalized = normalizeIntentText(line)
        const isDrawRequest = isImageGenerationRequest(normalized) ||
          /(?:画|绘制|生成|出图|做图|捏).{0,80}(?:图|图片|照片|照|插画|角色|人物|场景|完整|出来)/i.test(normalized)
        const isDrawCommitment = hasToolCommitmentText(normalized) && /(?:画|生成|出图|做图|捏)/i.test(normalized)
        if (isDrawRequest || isDrawCommitment) {
          lines.push({
            text: safeTruncateUnicode(line, 220),
            isDrawRequest
          })
        }
      }
    }

    const recent = selectLatestDrawContextLines(lines, 3)
    return recent.length
      ? compactDrawPromptText(recent.join("\n"), maxLength)
      : ""
  }

export function resolveContextualDrawGeneration(host, context = {}) {
    const currentIntentText = String(context.currentIntentText || context.args || context.msg || "").trim()
    const normalized = normalizeIntentText(currentIntentText)
    if (!normalized) return null
    if (isImageGenerationRequest(normalized) || isImageEditRequest(normalized)) return null

    const isStatusInquiry = isDrawTaskStatusInquiry(normalized)
    const quotedContext = host.getQuotedPromptContextText(context.e, context.userContent)
    const isQuotedDrawExecution = /(?:执行|照着|按).{0,12}(?:上面|引用|这条|刚才|前面)/.test(normalized) &&
      isImageGenerationRequest(normalizeIntentText(quotedContext))
    const isContinuation = isDrawContextContinuationRequest(normalized) || isQuotedDrawExecution
    if (!isStatusInquiry && !isContinuation && !context.modelCommittedToDraw) return null

    const recentContext = host.getRecentDrawContextText(
      context.groupUserMessages || context.messages || [],
      context.userContent || currentIntentText,
      1200
    )
    if (isStatusInquiry && !quotedContext && !/(?:我|希洛|好嘞|马上|开始|这就|帮你|给你|那就).{0,40}(?:画|生成|出图|做图|捏)/i.test(recentContext)) {
      return null
    }
    const drawContext = [quotedContext, recentContext].filter(Boolean).join("\n")
    if (!drawContext) return null

    const headline = isStatusInquiry
      ? "用户在追问刚才承诺的画图任务，请不要把追问本身画进画面，而是继续完成上下文里的真实画图目标。"
      : "用户在延续上一轮画图需求，请把本轮补充和上下文合并成新的画面需求。"
    const supplement = isStatusInquiry ? "" : `用户本轮补充：${currentIntentText}`
    const rawPrompt = compactDrawPromptText([
      headline,
      supplement,
      "可继承的画图上下文：",
      drawContext
    ].filter(Boolean).join("\n"), 2600)

    return {
      prompt: host.buildImageGenerationPrompt({
        ...context,
        prompt: rawPrompt,
        currentIntentText,
        userContent: context.userContent,
        groupUserMessages: context.groupUserMessages
      }),
      rawPrompt,
      reason: isStatusInquiry ? "draw_status_context_recovery" : "draw_context_continuation"
    }
  }

export function getUnderstandingEnhancementConfig(host, ) {
    const cfg = host.config.understandingEnhancement || {}
    return {
      enabled: cfg.enabled !== false,
      maxChars: Math.max(600, Math.min(3000, Number(cfg.maxChars) || 1400)),
      includeRecentContext: cfg.includeRecentContext !== false,
      // 模型理解简报:非闲聊回合先跑一次结构化判读,失败/超时回退规则卡
      briefEnabled: cfg.briefEnabled !== false,
      briefTimeoutMs: Math.max(500, Math.min(8000, Number(cfg.briefTimeoutMs) || 2500))
    }
  }

export function shouldInjectUnderstandingContext(host, { e = {}, userContent = "", images = [], videos = [], currentIntentText = "" } = {}) {
    const cfg = host.getUnderstandingEnhancementConfig()
    if (!cfg.enabled) return false

    const content = `${currentIntentText || ""}\n${userContent || ""}`
    if (content.length > 260) return true
    if (e?._directTriggerMerged || e?._mergedMessageCount) return true
    if (Array.isArray(images) && images.length) return true
    if (Array.isArray(videos) && videos.length) return true
    if (/\[回复\s+.+?的消息[:：]|转发了合并聊天记录|转发记录内容|嵌套转发记录/.test(content)) return true
    if (/(这个|这个人|那个人|上面|里面|前面|刚才|刚刚|上一条|他说|她说|它|这张|这段|这句|哪句|哪个).{0,18}(什么意思|是谁|是啥|咋回事|怎么回事|为什么|总结|分析|讲讲|看看|解释)/.test(normalizeIntentText(content))) return true
    return false
  }

export function extractForwardContextFromUserContent(host, userContent = "", maxLength = 900) {
    const content = String(userContent || "")
    const blocks = []
    for (const marker of ["转发了合并聊天记录:", "转发记录内容:"]) {
      const index = content.indexOf(marker)
      if (index >= 0) {
        blocks.push(content.slice(index + marker.length).trim())
      }
    }
    if (!blocks.length) return ""
    return compactDrawPromptText(blocks.join("\n"), maxLength)
  }

  // 抽取理解卡所需的原文材料;不满足注入条件时返回 null(与规则卡同一道门)
export function gatherUnderstandingMaterials(host, context = {}) {
    const {
      e = {},
      args = "",
      msg = "",
      userContent = "",
      images = [],
      videos = [],
      groupUserMessages = [],
      currentIntentText = ""
    } = context
    if (!host.shouldInjectUnderstandingContext({ e, userContent, images, videos, currentIntentText })) return null

    const cfg = host.getUnderstandingEnhancementConfig()
    return {
      cfg,
      intentText: compactDrawPromptText(currentIntentText || args || msg || "", 360),
      quotedContext: host.getQuotedPromptContextText(e, userContent),
      forwardContext: host.extractForwardContextFromUserContent(userContent),
      recentContext: cfg.includeRecentContext
        ? host.getRecentPromptContextText(groupUserMessages, userContent || currentIntentText, 650)
        : "",
      signals: (() => {
        const signals = []
        if (e?._mergedMessageCount) signals.push(`同一用户连续触发 ${e._mergedMessageCount} 条，已合并成一轮`)
        if (host.getQuotedPromptContextText(e, userContent)) signals.push("当前消息引用了其他消息")
        if (host.extractForwardContextFromUserContent(userContent) || /转发了合并聊天记录|转发记录内容|嵌套转发记录/.test(userContent)) signals.push("当前上下文包含合并转发/嵌套转发记录")
        if (images?.length) signals.push(`当前可见图片 ${images.length} 张`)
        if (videos?.length) signals.push(`当前引用/消息含视频 ${videos.length} 条`)
        if (/(这个|这个人|那个人|上面|里面|前面|刚才|刚刚|上一条|他说|她说|它|这张|这段|这句|哪句|哪个)/.test(normalizeIntentText(currentIntentText || msg))) signals.push("用户用了指代词，需要结合引用、转发和近期对话消解")
        return signals
      })()
    }
  }

  // 模型理解简报优先,失败回退规则卡;两次材料抽取合一(gatherUnderstandingMaterials)
export async function resolveUnderstandingPrompt(host, context = {}) {
    const materials = host.gatherUnderstandingMaterials(context)
    if (!materials) return ""
    const cfg = materials.cfg
    if (cfg.briefEnabled) {
      const toolsCfg = host.config.toolsAiConfig || {}
      const startedAt = Date.now()
      const result = await requestUnderstandingBrief({
        apiUrl: normalizeChatCompletionUrl(toolsCfg.toolsAiUrl || ""),
        apiKey: toolsCfg.toolsAiApikey || "",
        model: toolsCfg.toolsAiModel || "",
        materials,
        fetchImpl: (url, options, timeoutMs) => fetchWithTimeout(url, options, timeoutMs),
        timeoutMs: cfg.briefTimeoutMs
      })
      context.session?.turnTrace?.addModelCall("brief", Date.now() - startedAt)
      if (result.ok) {
        logger.info(`[理解简报] group=${context.e?.group_id || ""} 模型判读成功 elapsed=${Date.now() - startedAt}ms brief=${result.brief.length}c`)
        return composeModelBriefCard({ brief: result.brief, materials, maxChars: cfg.maxChars })
      }
      logger.info(`[理解简报] group=${context.e?.group_id || ""} 回退规则卡 reason=${result.reason} elapsed=${Date.now() - startedAt}ms`)
    }
    return host.buildUnderstandingContextPrompt(context)
  }

export function buildUnderstandingContextPrompt(host, context = {}) {
    const {
      e = {},
      args = "",
      msg = "",
      userContent = "",
      images = [],
      videos = [],
      groupUserMessages = [],
      currentIntentText = ""
    } = context
    if (!host.shouldInjectUnderstandingContext({ e, userContent, images, videos, currentIntentText })) return ""

    const cfg = host.getUnderstandingEnhancementConfig()
    const intentText = compactDrawPromptText(currentIntentText || args || msg || "", 360)
    const quotedContext = host.getQuotedPromptContextText(e, userContent)
    const forwardContext = host.extractForwardContextFromUserContent(userContent)
    const recentContext = cfg.includeRecentContext
      ? host.getRecentPromptContextText(groupUserMessages, userContent || currentIntentText, 650)
      : ""

    const signals = []
    if (e?._mergedMessageCount) signals.push(`同一用户连续触发 ${e._mergedMessageCount} 条，已合并成一轮`)
    if (quotedContext) signals.push("当前消息引用了其他消息")
    if (forwardContext || /转发了合并聊天记录|转发记录内容|嵌套转发记录/.test(userContent)) signals.push("当前上下文包含合并转发/嵌套转发记录")
    if (images?.length) signals.push(`当前可见图片 ${images.length} 张`)
    if (videos?.length) signals.push(`当前引用/消息含视频 ${videos.length} 条`)
    if (/(这个|这个人|那个人|上面|里面|前面|刚才|刚刚|上一条|他说|她说|它|这张|这段|这句|哪句|哪个)/.test(normalizeIntentText(currentIntentText || msg))) signals.push("用户用了指代词，需要结合引用、转发和近期对话消解")

    const lines = [
      "【理解增强卡片】",
      "这张卡片只用于你理解上下文，最终回复不要提到“卡片”“系统”“提示词”“分析过程”。",
      intentText ? `用户当前原话/意图：${intentText}` : "",
      signals.length ? `上下文信号：${signals.join("；")}` : "",
      quotedContext ? `引用内容摘录：\n${compactDrawPromptText(quotedContext, 650)}` : "",
      forwardContext ? `合并转发/嵌套转发摘录：\n${forwardContext}` : "",
      recentContext ? `近期可参考上下文：\n${recentContext}` : "",
      "理解规则：先判断用户真正要你回答什么；如果用户问“这个/里面/刚才/他说的”，优先从引用、转发记录和最近对话里找指代。",
      "理解规则：先区分信息载体和真实目标；图片/截图/引用/转发本身不一定是用户要问的对象，很多时候用户问的是里面那段文字、说法、事件、政策或人物关系。",
      "理解规则：带图问“这个是真的假的/是不是真的/看看最新信息”时，默认核实图片里的内容或说法；只有明确提到AI生成、P图、合成、修过、图片本身时，才转为图片本身鉴定。",
      "理解规则：用户要你查证时，不要只给通用方法；先用可用工具拿证据，再说明查到了什么、没查到什么、结论有多确定。",
      "如果用户让你总结、分析或解释合并转发，要覆盖已展开的全部内容，不要只看第一层或第一条。",
      "如果上下文仍不足，别硬编，像熟人一样自然追问一句。"
    ].filter(Boolean)

    return compactDrawPromptText(lines.join("\n"), cfg.maxChars)
  }

export function buildImageGenerationPrompt(host, context = {}) {
    const mergedPrompt = Array.isArray(context.e?._mergedOriginalTexts) && context.e._mergedOriginalTexts.length
      ? selectMergedImagePromptTexts(context.e._mergedOriginalTexts).join("\n")
      : ""
    const basePrompt = compactDrawPromptText(
      mergedPrompt || context.args || context.msg || context.currentIntentText || context.prompt || "",
      2400
    )
    const avatarReferencePrompt = formatAvatarDrawReferencePrompt(context.avatarDrawReference)
    const quotedContext = host.getQuotedPromptContextText(context.e, context.userContent)
    const contextMode = resolveImageContextMode(basePrompt, quotedContext)
    const recentContext = contextMode === "source"
      ? host.getRecentPromptContextText(
          context.groupUserMessages || context.messages || [],
          context.userContent || context.currentIntentText || basePrompt,
          900
        )
      : contextMode === "draw"
        ? host.getRecentDrawContextText(
            context.groupUserMessages || context.messages || [],
            context.userContent || context.currentIntentText || basePrompt,
            900
          )
        : ""
    const referenceText = [basePrompt, quotedContext].filter(Boolean).join("\n")

    const compiled = compileImagePrompt({
      task: "image_generation",
      userPrompt: [basePrompt, avatarReferencePrompt].filter(Boolean).join("\n"),
      quotedContext,
      recentContext,
      hasReferenceImages: Array.isArray(context.images) && context.images.length > 0,
      hasContextualReference: contextMode !== "none",
      isComic: COMIC_DRAW_PATTERN.test(referenceText)
    })
    return [compiled, context.groupContextImagePrompt || context.e?._groupContextImagePrompt]
      .filter(Boolean)
      .join("\n")
  }

export function getImageGenerationReferenceImages(host, images = [], session = {}) {
    if (Array.isArray(images) && images.length) return images
    if (Array.isArray(session.avatarDrawReference?.images) && session.avatarDrawReference.images.length) {
      return session.avatarDrawReference.images
    }
    return []
  }

export function buildImageEditPrompt(host, context = {}) {
    const basePrompt = compactDrawPromptText(
      context.args || context.msg || context.currentIntentText || context.prompt || "请按用户要求编辑这张图片。",
      2400
    )
    const quotedContext = host.getQuotedPromptContextText(context.e, context.userContent)
    const contextMode = resolveImageContextMode(basePrompt, quotedContext)
    const recentContext = contextMode === "source"
      ? host.getRecentPromptContextText(
          context.groupUserMessages || context.messages || [],
          context.userContent || context.currentIntentText || basePrompt,
          1200
        )
      : contextMode === "draw"
        ? host.getRecentDrawContextText(
            context.groupUserMessages || context.messages || [],
            context.userContent || context.currentIntentText || basePrompt,
            1200
          )
        : ""

    const compiled = compileImagePrompt({
      task: "image_edit",
      userPrompt: basePrompt,
      quotedContext,
      recentContext,
      hasReferenceImages: true,
      hasContextualReference: contextMode !== "none"
    })
    return [compiled, context.groupContextImagePrompt || context.e?._groupContextImagePrompt]
      .filter(Boolean)
      .join("\n")
  }
