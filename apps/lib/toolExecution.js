// 工具执行循环:消息规范化/终态判定/后台终态/图片核验接力/单次调用/
// 多轮循环/最终执行。从 apps/test.js 原样迁出(P2),行为不变;
// this 依赖以 host(插件实例)注入。
import { TERMINAL_TOOL_NAMES, BACKGROUND_TERMINAL_TOOL_NAMES, getImageVerificationMode } from "../../core/intent/messageIntent.js"
import { resolveEmojiTurnSkips } from "../../utils/emojiToolPolicy.js"
import { buildModrinthBilingualReplyInstruction, parseModrinthRankingData, collectModrinthTranslations, cacheModrinthTranslations } from "../../utils/modrinth.js"
import { buildToolGroundingInstruction, hasUsableToolResult, buildUnavailableToolReply } from "../../utils/toolResultGrounding.js"
import { decideToolContinuation } from "../../utils/toolContinuationPolicy.js"
import { resolveToolRoundLimit } from "../../utils/agentIntelligence.js"
import { safeTruncateUnicode } from "../../utils/unicodeText.js"
import { joinIntentParts } from "../../utils/messageContext.js"
import { normalizeIntentText } from "../../core/intent/messageIntent.js"
import { buildVisibleFailureDetail } from "../../utils/visibleFailure.js"

export function normalizeAssistantToolMessage(host, message) {
    const normalized = {
      role: "assistant",
      content: message.content || "",
      tool_calls: (message.tool_calls || []).map(toolCall => ({
        id: toolCall.id,
        type: toolCall.type || "function",
        function: {
          name: toolCall.function?.name,
          arguments: toolCall.function?.arguments || "{}"
        }
      }))
    }

    if (message.reasoning_content) {
      normalized.reasoning_content = message.reasoning_content
    }

    return normalized
  }

export function serializeToolResult(host, result) {
    if (typeof result === "string") return result

    if (result?.content && Array.isArray(result.content)) {
      return result.content
        .map(item => item.type === "text" ? item.text : JSON.stringify(item))
        .join("\n")
    }

    return JSON.stringify(result ?? "")
  }

export function getToolCallName(host, toolCall = {}) {
    return toolCall?.function?.name || ""
  }

export function shouldRunTerminalToolsInBackground(host, toolCalls = []) {
    return toolCalls.length > 0 &&
      toolCalls.every(toolCall => BACKGROUND_TERMINAL_TOOL_NAMES.has(host.getToolCallName(toolCall)))
  }

export function buildGroundedImageAnalysisPrompt(host, prompt = "", session = {}, e = {}) {
    const currentIntentText = [
      session.rawArgs,
      e?.msg,
      prompt
    ].filter(Boolean).join("\n")
    const originalPrompt = String(prompt || currentIntentText || "").trim()
    const sourcePrompt = session.groupContextImagePrompt || e?._groupContextImagePrompt || ""
    const needsVerification =
      looksLikeImageVerificationRequest(currentIntentText) ||
      isRealtimeInfoRequest(currentIntentText) ||
      isExplicitSearchRequest(currentIntentText)
    const mode = getImageVerificationMode(currentIntentText)

    if (!needsVerification) return [originalPrompt, sourcePrompt].filter(Boolean).join("\n")

    if (mode === "image_authenticity") {
      return [
        "用户明确想判断图片本身是否为AI生成、P图、合成或被篡改。你现在只负责读图和提取可核查线索，不要给泛泛的鉴定教程。",
        "请严格基于图片完成以下内容：",
        "1. OCR提取图片里所有可见文字。",
        "2. 描述图片里的关键视觉内容、版式、边缘、光影、透视、文字渲染等可疑或正常线索。",
        "3. 提取3-8个适合联网搜索核实来源、旧图或相关事件的关键词或短句。",
        "4. 如果看不清，明确说哪些地方看不清，不要编。",
        `用户原话：${originalPrompt || "请分析这张图片是否可能被生成或修改。"}`,
        sourcePrompt
      ].filter(Boolean).join("\n")
    }

    return [
      "用户给图片是把它当作截图/信息载体，想核实图片里那段内容、消息、公告、新闻、政策、事件或说法是真是假，以及现在最新情况。",
      "默认不要判断图片本身是不是AI生成、P图，也不要给反向搜图、Exif、AI检测工具这类泛泛鉴定教程；除非用户明确问图片本身。",
      "你现在只负责读图和提取可核查内容。",
      "请严格基于图片完成以下内容：",
      "1. OCR提取图片里所有可见文字，尽量保留标题、正文、机构名、地点、时间、金额、政策名、链接、账号名。",
      "2. 用一句话概括图片里到底在说什么主张/消息/事件。",
      "3. 提取3-8个适合联网搜索核实这个内容真实性和最新状态的关键词或短句。",
      "4. 如果图片太糊或文字看不清，明确说哪些地方看不清，不要编。",
      "注意：不要把“不能直接检测真假”当作最终回答；内容真假和最新信息会在下一步联网核查。",
      `用户原话：${originalPrompt || "请识别这张图片里有什么内容，并提取可核查信息。"}`,
      sourcePrompt
    ].filter(Boolean).join("\n")
  }

export function extractToolResultText(host, result = "") {
    const text = String(result || "").trim()
    if (!text) return ""
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed?.analysis === "string") return parsed.analysis
      if (typeof parsed?.content === "string") return parsed.content
      if (typeof parsed?.message === "string") return parsed.message
    } catch {}
    return text
  }

export function buildImageVerificationSearchToolCall(host, validResults = [], session = {}, e = {}) {
    if (!session.imageVerificationNeedsSearch || session.imageVerificationSearchDone) return null
    if (!session.tools?.some(tool => tool.function?.name === "searchInformationTool")) return null

    const visionResult = validResults.find(result =>
      result?.toolName === "googleImageAnalysisTool" &&
      result?.result &&
      !host.isToolResultError(result.result)
    )
    if (!visionResult) return null

    const imageText = safeTruncateUnicode(host.extractToolResultText(visionResult.result), 1800)
    if (!imageText) return null

    const rawUserText = [
      session.rawArgs,
      e?.msg
    ].filter(Boolean).join("\n")
    const userText = safeTruncateUnicode(rawUserText, 500)
    const mode = session.imageVerificationMode || getImageVerificationMode(userText)
    const query = mode === "image_authenticity"
      ? [
          "请联网核查这张图片是否可能是旧图、AI生成、P图、合成或被误传，并查找相关来源和最新信息。",
          `用户原话：${userText || "查一下这张图是不是AI生成或P图"}`,
          `图片OCR和识别结果：${imageText}`,
          "要求：优先使用图片中的文字、标题、地点、账号名、事件名等关键词检索；说明能查到的来源、是否存在旧图/相似图/相关事件；如果证据不足就明确说不足。"
        ].join("\n")
      : [
          "请联网核查图片里承载的内容/消息/公告/新闻/政策/事件/说法是否真实，以及现在最新情况。",
          "注意：默认不是核查图片文件本身是否AI生成或P图，不要把主要结论写成反向搜图、Exif、AI检测建议。",
          `用户原话：${userText || "查一下这个是真的假的，看看最新信息"}`,
          `图片OCR和识别结果：${imageText}`,
          "要求：优先使用OCR中的标题、正文关键词、机构名、地点、时间、金额、政策名、账号名、链接等检索；说明目前查到的事实、权威来源、是否过期/断章取义/误传；如果证据不足就明确说不足。"
        ].join("\n")

    session.imageVerificationSearchDone = true
    logger.info(`[工具选择] group=${e?.group_id || ""} 识图后自动追加 searchInformationTool 核实图片信息`)
    return host.buildForcedToolCall("searchInformationTool", { query })
  }

export function startBackgroundTerminalToolCalls(host, toolCalls = [], e, session, senderRole, currentMessages = []) {
    e._longRunningToolTask = true
    session.taskDedupeToolTouched = true
    session.backgroundTerminalToolTouched = true

    for (const toolCall of toolCalls) {
      const toolName = host.getToolCallName(toolCall)
      const taskPromise = host.runToolCall(toolCall, e, session, senderRole)
      taskPromise
        .then(async result => {
          if (!result) return
          session.toolName = result.toolName
          session.toolResults = [result]
          if (!host.isToolResultError(result.result)) {
            logger.info(`[工具调用] 后台终态工具 ${result.toolName} 执行完成`)
            if (isImageDeliveryToolName(result.toolName) && e?.group_id) clearDrawFailureNote(e.group_id)
            return
          }

          if (isImageDeliveryToolName(result.toolName) && e?.group_id) {
            recordDrawTextFallback(e.group_id, session?.rawArgs || e?.msg || "")
          }
          logger.warn(`[工具调用] 后台终态工具 ${result.toolName} 执行失败，发送拟人化失败提示 result=${String(result.result || "").slice(0, 240)}`)
          await host.handleToolFailureResponse(result.toolName, {
            messages: currentMessages,
            factualReply: host.getFriendlyFailureMessage(result.toolName, {
              e,
              session,
              stage: "background_terminal_tool_failed",
              error: result.result
            }),
            e,
            session,
          })
        })
        .catch(async error => {
          logger.error(`[工具调用] 后台终态工具 ${toolName || "unknown"} 异常:`, error)
          try {
            await host.handleToolFailureResponse(toolName, {
              messages: currentMessages,
              factualReply: host.getFriendlyFailureMessage(toolName, {
                e,
                session,
                stage: "background_terminal_tool_exception",
                error: error.message
              }),
              e,
              session,
            })
          } catch (replyError) {
            logger.error(`[工具调用] 后台终态工具失败提示发送异常:`, replyError)
          }
        })
    }
  }

export async function runToolCall(host, toolCall, e, session, senderRole) {
    const { type, function: funcData } = toolCall
    if (type !== "function" || !funcData?.name) return null

    const toolName = funcData.name
    const isMCPTool = mcpManager.isMCPTool(toolName)
    const isLocalTool = !isMCPTool && host.toolInstances[toolName]
    const isValidTool = session.tools?.some(t => t.function?.name === toolName)

    if (!isValidTool || (!isMCPTool && !isLocalTool)) {
      return {
        toolCall,
        toolName,
        result: `error: tool ${toolName} is not available in this session`
      }
    }

    let params
    try {
      params = JSON.parse(funcData.arguments || "{}")
    } catch (error) {
      return {
        toolCall,
        toolName,
        result: `error: 参数 JSON 解析失败：${buildVisibleFailureDetail(error)}`
      }
    }

    if (toolName === "mentionAdminsTool" && !isExplicitAdminCollectionMentionRequest(session?.rawArgs || e?.msg || "")) {
      logger.warn(`[工具调用] 拒绝非集合措辞的 mentionAdminsTool group=${e?.group_id || ""}`)
      return {
        toolCall,
        toolName,
        result: "error: mentionAdminsTool 只能用于明确要求所有管理员、管理员们或全体群管的通知"
      }
    }

    if (["bananaTool", "googleImageEditTool", "googleImageAnalysisTool", "searchInformationTool"].includes(toolName) && !params.agentContext) {
      params.agentContext = buildAgentProgressContext({
        userContent: session?.userContent || e?.msg || "",
        quotedContext: e?._quotedPromptContext?.text || "",
        messages: session?.groupUserMessages || []
      })
    }

    if (toolName === "googleImageAnalysisTool" && (!Array.isArray(params.images) || !params.images.length) && session.images?.length) {
      params.images = session.images
    }
    if (toolName === "googleImageAnalysisTool") {
      params.prompt = host.buildGroundedImageAnalysisPrompt(params.prompt, session, e) || params.prompt
    }
    if (toolName === "googleImageEditTool" && (!Array.isArray(params.images) || !params.images.length) && session.images?.length) {
      params.images = session.images
    }
    if (toolName === "googleImageEditTool") {
      params.prompt = host.buildImageEditPrompt({
        e,
        prompt: params.prompt,
        args: session.rawArgs,
        msg: e?.msg,
        currentIntentText: [session.rawArgs, e?.msg].filter(Boolean).join("\n"),
        userContent: session.userContent,
        groupUserMessages: session.groupUserMessages
      }) || params.prompt
      if (session.editAssets?.promptHint && !params.prompt.includes(session.editAssets.promptHint)) {
        params.prompt = [params.prompt, session.editAssets.promptHint].filter(Boolean).join("\n")
      }
      if (session.avatarEditBase?.promptHint && !params.prompt.includes(session.avatarEditBase.promptHint)) {
        params.prompt = [params.prompt, session.avatarEditBase.promptHint].filter(Boolean).join("\n")
      }
    }
    if (toolName === "bananaTool") {
      if (!params.prompt && session.rawArgs) params.prompt = session.rawArgs
      const imageGenerationReferenceImages = host.getImageGenerationReferenceImages(params.images, session)
      if ((!Array.isArray(params.images) || !params.images.length) && imageGenerationReferenceImages.length) {
        params.images = imageGenerationReferenceImages
      }
      if (session.avatarDrawReference?.images?.length) {
        params.referencePurpose = "member_avatar"
      }
      params.prompt = host.buildImageGenerationPrompt({
        e,
        prompt: params.prompt,
        args: session.rawArgs,
        msg: e?.msg,
        currentIntentText: [session.rawArgs, e?.msg].filter(Boolean).join("\n"),
        userContent: session.userContent,
        images: params.images,
        avatarDrawReference: session.avatarDrawReference
      }) || params.prompt
    }

    if (toolName === "jinyanTool" && senderRole) {
      params.senderRole = senderRole
    }
    if (toolName === "changeCardTool" && senderRole) {
      params.senderRole = senderRole
    }

    const dedupeEnabled = host.isDedupeTool(toolName)
    const task = session.taskContext || {}
    const toolRunKey = dedupeEnabled ? host.getToolRunKey(e.group_id, e.user_id, toolName) : ""
    const toolRunValue = {
      groupId: e.group_id,
      userId: e.user_id,
      messageId: task.messageId || e.message_id || null,
      toolName,
      startedAt: Date.now()
    }

    if (dedupeEnabled) {
      if (activeDedupeToolRuns.has(toolRunKey)) {
        return {
          toolCall,
          toolName,
          result: `工具 ${toolName} 正在处理同一用户的上一条请求，已跳过重复调用`
        }
      }

      activeDedupeToolRuns.set(toolRunKey, toolRunValue)
      session.taskDedupeToolTouched = true
      if (toolRunValue.messageId) {
        await host.saveTaskStatus({
          groupId: e.group_id,
          userId: e.user_id,
          messageId: toolRunValue.messageId,
          status: "tool_running",
          toolName
        })
      }
    }

    const toolStartedAt = Date.now()
    try {
      logger.info(`[工具调用] ${isMCPTool ? "MCP" : "本地"} ${formatTurnPlanLog(session.turnPlan)} tool=${toolName} params=${JSON.stringify(params)}`)
      const toolEvent = isMCPTool ? e : Object.assign(Object.create(e || null), {
        memoryManager: host.memoryManager
      })
      const rawResult = isMCPTool
        ? await host.executeTool(toolName, params, e)
        : await host.executeTool(host.toolInstances[toolName], params, toolEvent)
      const serializedResult = host.serializeToolResult(rawResult)
      // Tool output is fed back into another model and may later be shown to
      // the user. Normalize every failing result here, including legacy tools
      // that still return a raw error string instead of throwing.
      const result = host.isRawToolFailure(serializedResult)
        ? `error: ${buildVisibleFailureDetail(serializedResult)}`
        : serializedResult
      logger.info(`[工具耗时] group=${e?.group_id || ""} ${formatTurnPlanLog(session.turnPlan)} tool=${toolName} elapsed=${Date.now() - toolStartedAt}ms`)
      recordTurnPlanToolOutcome(session.turnPlan, {
        toolName,
        success: !host.isToolResultError(result)
      })
      if (dedupeEnabled && toolRunValue.messageId) {
        const failed = host.isToolResultError(result)
        await host.saveTaskStatus({
          groupId: e.group_id,
          userId: e.user_id,
          messageId: toolRunValue.messageId,
          status: failed ? "tool_failed" : "tool_success",
          toolName,
          error: failed ? result : ""
        })
      }
      return {
        toolCall,
        toolName,
        elapsed: Date.now() - toolStartedAt,
        result: result?.trim() ? result : `工具 ${toolName} 执行成功`
      }
    } catch (error) {
      if (dedupeEnabled && toolRunValue.messageId) {
        await host.saveTaskStatus({
          groupId: e.group_id,
          userId: e.user_id,
          messageId: toolRunValue.messageId,
          status: "tool_failed",
          toolName,
          error: buildVisibleFailureDetail(error)
        })
      }
      logger.error(`[工具调用] ${toolName} 执行失败:`, error)
      recordTurnPlanToolOutcome(session.turnPlan, { toolName, success: false })
      return {
        toolCall,
        toolName,
        elapsed: Date.now() - toolStartedAt,
        result: `error: ${buildVisibleFailureDetail(error)}`
      }
    } finally {
      if (dedupeEnabled && activeDedupeToolRuns.get(toolRunKey) === toolRunValue) {
        activeDedupeToolRuns.delete(toolRunKey)
      }
    }
  }

export function dedupeToolCalls(host, toolCalls = []) {
    const seen = new Set()
    return toolCalls.filter(toolCall => {
      const key = `${toolCall.function?.name}:${toolCall.function?.arguments || "{}"}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

export async function processToolCalls(host, message, e, session, groupUserMessages, atQq, senderRole, options = {}) {
    const MAX_TOOL_ROUNDS = resolveToolRoundLimit(host.config, {
      messages: groupUserMessages,
      toolNames: (message?.tool_calls || []).map(toolCall => host.getToolCallName(toolCall))
    })
    let currentMessage = message
    let currentMessages = [...groupUserMessages]
    let round = 0
    const allToolResults = []

    while (currentMessage.tool_calls?.length && round < MAX_TOOL_ROUNDS) {
      round++
      const toolCalls = host.dedupeToolCalls(currentMessage.tool_calls)
      logger.info(`[工具调用] 第 ${round} 轮，共 ${toolCalls.length} 个工具`)

      currentMessages.push(host.normalizeAssistantToolMessage({
        ...currentMessage,
        tool_calls: toolCalls
      }))

      if (host.shouldRunTerminalToolsInBackground(toolCalls)) {
        session.toolName = host.getToolCallName(toolCalls[toolCalls.length - 1])
        host.startBackgroundTerminalToolCalls(toolCalls, e, session, senderRole, currentMessages)
        logger.info(`[工具调用] 后台启动终态工具(${toolCalls.map(toolCall => host.getToolCallName(toolCall)).join(',')})，主流程立即释放`)
        return
      }

      // 表情包每轮最多实际发一张：模型偶尔一轮并行发两个 sendLocalEmojiTool 导致连甩两张表情刷屏
      const emojiPerTurnMax = Math.max(1, Number(host.config?.emoji?.perTurnMax) || 1)
      const emojiSkips = resolveEmojiTurnSkips(
        toolCalls.map(toolCall => host.getToolCallName(toolCall)),
        Number(session?.emojiToolSentThisTurn) || 0,
        emojiPerTurnMax
      )
      const emojiAccepted = toolCalls.reduce((count, toolCall, index) =>
        count + (!emojiSkips[index] && host.getToolCallName(toolCall) === "sendLocalEmojiTool" ? 1 : 0), 0)
      if (session) session.emojiToolSentThisTurn = (Number(session.emojiToolSentThisTurn) || 0) + emojiAccepted
      const validResults = (await Promise.all(
        toolCalls.map((toolCall, index) => {
          if (!emojiSkips[index]) return host.runToolCall(toolCall, e, session, senderRole)
          logger.info(`[工具调用] 表情包每轮上限 ${emojiPerTurnMax} 张，跳过重复的 sendLocalEmojiTool`)
          return Promise.resolve({
            toolCall,
            toolName: "sendLocalEmojiTool",
            result: "本轮已发过一张表情，为避免刷屏跳过本次表情发送；如还有话要补充，请直接用文字回复"
          })
        })
      )).filter(Boolean)

      if (validResults.length === 0) break

      allToolResults.push(...validResults)
      session.toolName = validResults[validResults.length - 1]?.toolName
      const roundToolOk = validResults.map(({ result }) => !host.isToolResultError(result))
      validResults.forEach(({ toolName: outcomeToolName, elapsed }, index) => {
        recordTurnPlanToolOutcome(session.turnPlan, { toolName: outcomeToolName, success: roundToolOk[index] })
        session?.turnTrace?.addTool(outcomeToolName, roundToolOk[index], elapsed || 0)
      })
      if (roundToolOk.every(Boolean)) session?.outboundArbiter?.resolveToolOutcomes()

      currentMessages.push(...validResults.map(({ toolCall, toolName, result }) => ({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolName,
        content: result
      })))

      const imageVerificationSearchCall = host.buildImageVerificationSearchToolCall(validResults, session, e)
      if (imageVerificationSearchCall) {
        currentMessage = {
          role: "assistant",
          content: "",
          tool_calls: [imageVerificationSearchCall]
        }
        continue
      }

      if (
        session.imageVerificationSearchDone &&
        !session.imageVerificationFinalInstructionAdded &&
        validResults.some(result => result.toolName === "searchInformationTool")
      ) {
        session.imageVerificationFinalInstructionAdded = true
        const finalInstruction = session.imageVerificationMode === "image_authenticity"
          ? "【图片本身核实回复要求】请综合图片OCR/识别结果和联网搜索结果，回答用户这张图片本身是否可能是AI生成、P图、合成、旧图或误传。不要只列通用鉴定方法；如果证据不足，就明确说已查到什么、没查到什么、为什么还不能下定论。"
          : "【图片内容核实回复要求】用户问“这图/这个真的假的”时，默认是在问图片里承载的内容/消息/公告/新闻/政策/事件/说法是真是假，不是在问图片文件本身是否AI生成或P图。请综合图片OCR/识别结果和联网搜索结果，直接回答图里这段内容目前看是否真实、是否过期或误传、最新情况是什么。不要只列反向搜图、Exif、AI检测等通用鉴定方法；如果证据不足，就明确说已查到什么、没查到什么、为什么还不能下定论。"
        currentMessages.push({
          role: "system",
          content: finalInstruction
        })
      }

      if (validResults.some(result => result.toolName === "modrinthTool")) {
        currentMessages.push({ role: "system", content: buildModrinthBilingualReplyInstruction() })
      }

      const continuationMode = decideToolContinuation(validResults, options)
      if (continuationMode === "direct_result") {
        session.toolResults = allToolResults
        const directText = validResults
          .map(result => String(result.result || "").replace(/^error:\s*/i, ""))
          .filter(Boolean)
          .join("\n\n")
        await host.handleTextResponse(
          directText || "Excel 查询没有返回可用结果。",
          e,
          session,
          currentMessages,
          session.toolName
        )
        logger.info(`[工具调用] ${validResults.map(result => result.toolName).join(',')} 使用精确结果直接回复，跳过模型总结`)
        return
      }

	      if (validResults.every(r => TERMINAL_TOOL_NAMES.has(r.toolName))) {
		        session.toolResults = allToolResults
			        const failedResult = validResults.find(r => host.isToolResultError(r.result))
		        if (failedResult) {
		          logger.warn(`[工具调用] 终态工具 ${failedResult.toolName} 执行失败，发送拟人化失败提示 result=${String(failedResult.result || "").slice(0, 240)}`)
          await host.handleToolFailureResponse(failedResult.toolName, {
            messages: currentMessages,
            factualReply: host.getFriendlyFailureMessage(failedResult.toolName, {
              e,
              session,
              stage: "terminal_tool_failed",
              error: failedResult.result
            }),
            e,
            session
          })
	          return
	        }
	        logger.info(`[工具调用] 本轮全部为终态工具(${validResults.map(r => r.toolName).join(',')})且执行成功，跳过最终文本回复`)
	        // emoji-only 冷却只在"真的只发了图"时开启；强制路带 leadText 的回合不算 emoji-only
	        if (validResults.every(r => r.toolName === LOCAL_EMOJI_TOOL_NAME) && e?.group_id &&
	            !validResults.some(r => String(r.result || "").includes("段文字"))) {
	          // 硬守卫:用户直接问 bot 个人状态(在干嘛/在吗)却被一张表情打发时,
	          // 不把表情当终态——落回模型补一句短文字(提示词层也有引导,这是兜底)
	          if (looksLikeDirectPersonalQuestion(joinIntentParts(args, msg))) {
	            logger.info("[表情包] 用户直接个人提问但只发了表情，补一轮文字回复")
	          } else {
	            recordEmojiOnlySend(e.group_id, Number(host.config?.emojiSystem?.emojiCooldownMs ?? 120000))
	            logger.info(`[表情包] emoji-only 回复完成，开启冷却 ${Math.round((Number(host.config?.emojiSystem?.emojiCooldownMs ?? 120000)) / 1000)}s（explicit 请求不受限）`)
	            return
	          }
	        } else {
	          return
	       	}
	      }

      if (!hasUsableToolResult(allToolResults)) {
        session.toolResults = allToolResults
        const unavailableReply = buildUnavailableToolReply(allToolResults)
        logger.warn(`[工具事实边界] ${allToolResults.map(result => result.toolName).join(',')} 本轮无可用结果，禁止进入历史补全式总结`)
        await host.handleToolFailureResponse(session.toolName, {
          e,
          session,
          messages: currentMessages,
          factualReply: unavailableReply
        })
        return
      }
      currentMessages.push({
        role: "system",
        content: buildToolGroundingInstruction(allToolResults)
      })

      const isModrinthOnlyResult = allToolResults.length > 0 &&
        allToolResults.every(result => result.toolName === "modrinthTool") &&
        allToolResults.every(result => !host.isToolResultError(result.result))
      if (isModrinthOnlyResult) {
        const ranking = parseModrinthRankingData(validResults.at(-1)?.result)
        if (ranking) {
          const translateStartedAt = Date.now()
          const { cached, missing } = collectModrinthTranslations(ranking)
          const translations = new Map(cached)
          if (missing.length) {
            const compactMessages = buildModrinthTranslationMessages(missing)
            const compactResponse = await host.retryRequest(
              {
                model: host.config?.taskAiConfig?.translation?.model || host.config?.chatAiConfig?.chatApiModel,
                messages: compactMessages,
                stream: false,
                temperature: 0
              },
              session.toolContent,
              1,
              "modrinthTool",
              {
                taskBackend: "translation",
                routeLabel: "Modrinth 简介翻译",
                generation: { temperature: 0, maxOutputTokens: 1200 }
              }
            )
            const compactContent = compactResponse?.choices?.[0]?.message?.content
            const translated = parseModrinthTranslationResponse(compactContent, missing.map(item => item.projectId))
            if (!translated) {
              logger.warn(`[工具调用] Modrinth 简介翻译失败 elapsed=${Date.now() - translateStartedAt}ms error=${compactResponse?.error ? String(compactResponse.error).slice(0, 240) : "invalid_json"}`)
              await host.handleToolFailureResponse("modrinthTool", {
                e,
                session,
                messages: currentMessages,
                factualReply: host.getFriendlyFailureMessage("modrinthTool", { e, session, stage: "modrinth_translation", error: compactResponse?.error || "翻译模型没有返回完整 JSON" })
              })
              return
            }
            for (const [projectId, text] of translated) translations.set(projectId, text)
            cacheModrinthTranslations(ranking, translated)
          }
          const forwardItems = buildModrinthForwardItemsFromData(ranking, translations)
          const cardItems = buildModrinthCardItemsFromData(ranking, translations)
          if (forwardItems.length === ranking.items.length && cardItems.length === ranking.items.length) {
            session.toolResults = allToolResults
            session.modrinthCardItems = cardItems
            await host.handleTextResponse(wrapModrinthForwardItems(forwardItems), e, session, currentMessages, "modrinthTool")
            logger.info(`[工具调用] Modrinth 结构化翻译完成 items=${forwardItems.length} cacheHits=${cached.size} cacheMisses=${missing.length} elapsed=${Date.now() - translateStartedAt}ms`)
            return
          }
        }
        logger.warn(`[工具调用] Modrinth 结构化结果无效，回退通用续轮`)
      }

      if (continuationMode === "chat_only") {
        session.toolResults = allToolResults
        const finalRequest = buildChatRequestData(host.config, currentMessages, [], "none")
        const finalStartedAt = Date.now()
        const finalResponse = await host.retryRequest(finalRequest, session.toolContent, 1, session.toolName)
        session?.turnTrace?.addModelCall("final", Date.now() - finalStartedAt)
        const finalContent = finalResponse?.choices?.[0]?.message?.content
        if (finalContent) {
          await host.handleTextResponse(finalContent, e, session, currentMessages, session.toolName)
        } else {
          logger.warn(`[回复失败] group=${e?.group_id || ""} user=${e?.user_id || ""} stage=synthetic_tool_summary tool=${session.toolName || ""} error=${finalResponse?.error ? JSON.stringify(finalResponse.error).slice(0, 240) : "no_choices"}`)
          await host.handleToolFailureResponse(session.toolName, {
            e,
            session,
            messages: currentMessages,
            factualReply: host.getFriendlyFailureMessage(session.toolName, { e, session, stage: "synthetic_tool_summary", error: finalResponse?.error })
          })
        }
        logger.info(`[工具调用] 合成工具调用 ${session.toolName || "unknown"} 跳过 thinking 工具续轮，直接进入无工具总结`)
        return
      }

	      const nextRequest = buildChatRequestData(host.config, currentMessages, session.tools, "auto")
	      const nextResponse = await host.retryRequest(nextRequest, session.toolContent, 1, session.toolName)
	      const nextMessage = nextResponse?.choices?.[0]?.message
	      if (!nextMessage) {
	        logger.warn(`[回复失败] group=${e?.group_id || ""} user=${e?.user_id || ""} stage=tool_round_summary tool=${session.toolName || ""} error=${nextResponse?.error ? JSON.stringify(nextResponse.error).slice(0, 240) : "no_choices"}`)
	        break
	      }

      currentMessage = nextMessage
      if (!currentMessage.tool_calls?.length && currentMessage.content) {
        session.toolResults = allToolResults
        await host.handleTextResponse(
          currentMessage.content,
          e,
          session,
          currentMessages,
          session.toolName
        )
        return
      }
    }

    if (round >= MAX_TOOL_ROUNDS) {
      logger.warn(`[工具调用] 已达到最大轮数：${MAX_TOOL_ROUNDS}`)
    }

    session.toolResults = allToolResults
    const finalRequest = buildChatRequestData(host.config, currentMessages, [], "none")
    const finalStartedAt = Date.now()
    const finalResponse = await host.retryRequest(finalRequest, session.toolContent, 1, session.toolName)
    session?.turnTrace?.addModelCall("final", Date.now() - finalStartedAt)

	    if (finalResponse?.choices?.[0]?.message?.content) {
	      await host.handleTextResponse(
	        finalResponse.choices[0].message.content,
        e,
        session,
        currentMessages,
	        session.toolName
	      )
	    } else {
	      logger.warn(`[回复失败] group=${e?.group_id || ""} user=${e?.user_id || ""} stage=final_tool_summary tool=${session.toolName || ""} error=${finalResponse?.error ? JSON.stringify(finalResponse.error).slice(0, 240) : "no_choices"}`)
        await host.handleToolFailureResponse(session.toolName, {
          e,
          session,
          messages: currentMessages,
          factualReply: host.getFriendlyFailureMessage(session.toolName, { e, session, stage: "final_tool_summary", error: finalResponse?.error || "没有可用的最终回复" })
        })
	    }
	  }

export async function executeTool(host, tool, params, e, isRetry = false) {
    try {
      if (typeof tool === "string" && mcpManager.isMCPTool(tool)) {
        return await mcpManager.executeToolByAlias(tool, params)
      }

      if (tool && typeof tool.execute === "function") {
        return await tool.execute(params, e)
      }

      return null
    } catch (error) {
      if (!isRetry) {
        return host.executeTool(tool, params, e, true)
      }
      throw error
    }
  }
