// 语义工具意图:低模型前置分类器(候选工具+技能目录+披露规则)与决策归一化。
// 从 apps/test.js 原样迁出(P2),行为不变;this 依赖以 host(插件实例)注入,
// 类上保留同名委托方法。
import { normalizeIntentText, isRealtimeInfoRequest, isExplicitSearchRequest, isExplicitToolIntent, isImageGenerationRequest, isImageAnalysisRequest, isImageCompositionEditRequest, hasToolCommitmentText, SEMANTIC_TOOL_INTENTS, SEMANTIC_TOOL_INTENT_MIN_CONFIDENCE, SEMANTIC_TOOL_INTENT_TIMEOUT_MS } from "../../core/intent/messageIntent.js"
import { isExplicitAdminCollectionMentionRequest } from "../../utils/mentionRoleRouting.js"
import { selectToolIntentCandidates } from "../../utils/toolIntentManifests.js"
import { buildToolSkillCatalog, normalizeToolSkillParams } from "../../utils/toolSkills.js"
import { fetchWithTimeout } from "../../utils/modelGateway.js"
import { safeTruncateUnicode } from "../../utils/unicodeText.js"
import { joinIntentParts } from "../../utils/messageContext.js"
import { resolvePersonaName } from "../../utils/personaSource.js"
import { resolveChatCompletionUrl } from "../../utils/chatCompletionUrl.js"
import { hasSemanticPlannerCandidate } from "../../utils/semanticToolPolicy.js"

export function shouldUseSemanticToolIntent(host, e = {}, text = "", images = [], videos = [], options = {}) {
    const content = normalizeIntentText(text || e?.msg || "")
    return shouldRunSemanticToolPlanner({
      hasMedia: images.length > 0 || videos.length > 0,
      hasKnownToolCandidate: Array.isArray(options.knownToolCandidates) && options.knownToolCandidates.length > 0,
      hasExplicitToolIntent: isExplicitToolIntent(content),
      hasRealtimeRequest: isRealtimeInfoRequest(content),
      hasExplicitSearchRequest: isExplicitSearchRequest(content)
    })
  }

export function normalizeToolDecision(host, decision = {}, context = {}) {
    const intent = String(decision.intent || "chat").trim()
    const confidence = Number(decision.confidence)
    if (!Number.isFinite(confidence) || confidence < SEMANTIC_TOOL_INTENT_MIN_CONFIDENCE) return null

    const requestedToolName = String(decision.toolName || decision.tool_name || "").trim()
    const availableToolNames = new Set(Array.isArray(context.availableToolNames) ? context.availableToolNames : [])
    if (requestedToolName === "mentionAdminsTool" && !isExplicitAdminCollectionMentionRequest(context.currentIntentText || context.args || context.msg || "")) {
      logger.warn("[语义工具分类] 拒绝非集合措辞的 mentionAdminsTool 请求")
      return null
    }
    if (requestedToolName && availableToolNames.has(requestedToolName)) {
      const params = decision.params && typeof decision.params === "object"
        ? decision.params
        : (decision.arguments && typeof decision.arguments === "object" ? decision.arguments : {})
      const tool = host.toolInstances?.[requestedToolName]
      let normalizedParams
      try {
        normalizedParams = normalizeToolSkillParams(tool, params, {
          userText: context.currentIntentText || context.args || context.msg || "",
          currentIntentText: context.currentIntentText || "",
          decision
        })
      } catch (error) {
        logger.warn(`[ToolSkill] 参数规范化失败 tool=${requestedToolName}: ${error.message}`)
        return null
      }
      return {
        intent: "tool",
        toolName: requestedToolName,
        params: normalizedParams
      }
    }

    if (!SEMANTIC_TOOL_INTENTS.has(intent)) return null

    const images = Array.isArray(context.images) ? context.images : []
    if (intent === "image_edit" && !images.length) return null
    if (intent === "image_analysis" && !images.length) return null

    const rawUserPrompt = String(context.args || context.msg || context.currentIntentText || "").trim()
    const prompt = String(rawUserPrompt || decision.prompt || "").trim()
    const query = String(decision.query || decision.prompt || context.args || context.msg || context.currentIntentText || "").trim()

    if (intent === "image_generate") {
      return {
        intent,
        toolName: "bananaTool",
        params: {
          prompt: host.buildImageGenerationPrompt({ ...context, prompt }),
          images
        }
      }
    }
    if (intent === "image_edit") {
      return {
        intent,
        toolName: "googleImageEditTool",
        params: {
          images,
          prompt: host.buildImageEditPrompt({ ...context, prompt })
        }
      }
    }
    if (intent === "image_analysis") {
      return { intent, toolName: "googleImageAnalysisTool", params: { images, prompt: prompt || "请识别这张图片里有什么内容，并用中文简洁描述。" } }
    }
    if (intent === "search") {
      if (!query) return null
      return { intent, toolName: "searchInformationTool", params: { query } }
    }
    return { intent: "chat" }
  }

export function extractJsonObject(host, text = "") {
    const content = String(text || "").trim()
    if (!content) return null
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    const raw = fenced ? fenced[1].trim() : content
    try {
      return JSON.parse(raw)
    } catch {}
    const start = raw.indexOf("{")
    const end = raw.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1))
      } catch {}
    }
    return null
  }

export async function classifySemanticToolIntent(host, context = {}) {
    // 分类需要低延迟:优先独立的 intentAiConfig(可指向快速模型),回落 tools 模型。
    // 实测 gpt-5.6-sol 单次 14-48s(必超时),deepseek-v4-flash 稳定 ~4s。
    const fastIntent = host.config?.intentAiConfig || {}
    const cfg = host.config.toolsAiConfig || {}
    const apiUrl = fastIntent.intentAiUrl || cfg.toolsAiUrl
    const apiKey = fastIntent.intentAiApikey || cfg.toolsAiApikey
    const model = fastIntent.intentAiModel || cfg.toolsAiModel
    if (!apiUrl || !apiKey || !model || String(apiKey).includes("sk-xxx")) return null

    const url = host.resolveChatCompletionUrl(apiUrl)
    const userText = safeTruncateUnicode(context.currentIntentText || "", 1200)
    const hasImages = Array.isArray(context.images) && context.images.length > 0
    const hasVideos = Array.isArray(context.videos) && context.videos.length > 0
    const quoted = safeTruncateUnicode(context.userContent || "", 1600)
    const availableTools = (context.sessionTools || context.tools || [])
      .map(tool => tool?.function)
      .filter(tool => tool?.name)
    const availableToolNames = availableTools.map(tool => tool.name)
    const knownToolCandidates = selectToolIntentCandidates(context.currentIntentText || "", availableToolNames)
    if (!host.shouldUseSemanticToolIntent(context.e, context.currentIntentText, context.images, context.videos, {
      knownToolCandidates: hasSemanticPlannerCandidate(knownToolCandidates) ? knownToolCandidates : []
    })) return null
    const toolCatalog = buildToolSkillCatalog(host.toolInstances, availableToolNames)

    const classifyStartedAt = Date.now()
    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          stream: false,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: [
                "你是QQ群机器人前置工具意图分类器，只输出严格 JSON。",
                "可选 intent: chat, image_generate, image_edit, image_analysis, search。",
                "image_generate: 用户要从文字生成新图片、画图、出图、做图。",
                "image_edit: 用户给了图片并要求修改、去水印、加东西、换背景、美化、图生图。",
                "image_analysis: 用户给了图片并要求看图、识别、分析、说明图片内容。",
                "search: 用户询问实时信息或明确要搜索/查询/最新信息。",
                "chat: 普通闲聊、问能不能做某事但没有给出具体任务、玩梗、情绪回应。",
                "如果用户需求明确对应【候选工具】中的某个工具，优先输出该工具名；这适用于三角洲、提醒、点歌、禁言、改名片、戳一戳、点赞、礼物、聊天记录、表情、导图等已有工具。",
                `选择具体工具时，intent 写 tool，toolName 写工具名，params 按该工具参数名生成 JSON；不确定必要参数时不要乱填，选 chat 让${resolvePersonaName(host.config?.persona)}追问。`,
                "如果【候选工具详细规则】出现，必须优先按详细规则抽参；详细规则比通用描述更可信。",
                "语义判断框架：先判断载体和真实目标。图片/截图/引用/转发常是载体，用户真正要处理的可能是里面的内容、说法、政策、事件或人物。",
                "带图片/截图并说“查一下这个是真的假的/是不是真的/看看最新信息”时，真实目标默认是核实图片里承载的内容或说法；应先选 image_analysis 提取内容，后续再搜索。不要直接选纯 search，也不要理解成图片AI检测。",
                "只有用户明确说“图片本身、AI生成、P图、合成、修过、改过、伪造痕迹”时，才把目标理解为图片本身真实性鉴定。",
                "带指代词“这个/这张/里面/上面/刚才/他说的”时，必须结合格式化消息、引用和媒体判断指代对象。",
                "不要受角色人设影响；只判断用户真实语义。用户明确要求做图时，不要因为角色说不会画而选 chat。",
                "prompt 字段只用于缺少原文时兜底；不要为了委婉、安全或总结而改写用户的画图/修图原话，真正给绘图工具的文本会优先使用用户原话。",
                "reason 只写简短依据，不要输出完整思维链。",
                "输出格式: {\"intent\":\"...\",\"confidence\":0到1,\"toolName\":\"可选工具名\",\"params\":{},\"prompt\":\"给工具用的中文任务文本\",\"query\":\"搜索词或空字符串\",\"reason\":\"简短原因\"}",
                "",
                "【已注册 Agent Skills】",
                toolCatalog || "(无)",
                "每项 Skill 都是当前可执行能力。不要因为措辞不在示例中就忽略能力；先按语义选 Skill，再让其参数规范化器处理同义词和枚举。"
              ].join("\n")
            },
            {
              role: "user",
              content: [
                `当前文本: ${userText || "(空)"}`,
                `是否带图片: ${hasImages ? "是" : "否"}`,
                `是否带视频: ${hasVideos ? "是" : "否"}`,
                `格式化消息: ${quoted || "(空)"}`,
                context.groupWorkflowPrompt ? `可执行群工作流: ${safeTruncateUnicode(context.groupWorkflowPrompt, 1800)}` : ""
              ].join("\n")
            }
          ]
        })
      }, SEMANTIC_TOOL_INTENT_TIMEOUT_MS)

      const text = await response.text()
      context.session?.turnTrace?.addModelCall("planner", Date.now() - classifyStartedAt)
      if (!response.ok) {
        logger.warn(`[语义工具分类] 请求失败: ${response.status} ${text.slice(0, 240)}`)
        return null
      }
      const data = JSON.parse(text)
      const content = data?.choices?.[0]?.message?.content
      const parsed = host.extractJsonObject(content)
      const normalized = host.normalizeToolDecision(parsed, {
        ...context,
        availableToolNames
      })
      if (normalized) {
        logger.info(`[语义工具分类] intent=${normalized.intent} tool=${normalized.toolName || "none"} confidence=${parsed?.confidence ?? ""} elapsed=${Date.now() - classifyStartedAt}ms reason=${String(parsed?.reason || "").slice(0, 80)}`)
      }
      return normalized
    } catch (error) {
      logger.warn(`[语义工具分类] 失败 elapsed=${Date.now() - classifyStartedAt}ms: ${error.message}`)
      return null
    }
  }

export function buildToolCallFromDecision(host, decision, context = {}) {
    if (!decision?.toolName) return null
    const tools = host.getToolsByName([decision.toolName])
    if (!tools?.length) return null
    return {
      ...decision,
      tools,
      toolCall: host.buildForcedToolCall(decision.toolName, decision.params || {})
    }
  }

export function buildMissingToolCommitmentCall(host, content, context = {}) {
    const images = Array.isArray(context.images) ? context.images : []
    const args = context.args || ""
    const msg = context.msg || ""
    const currentIntentText = context.currentIntentText || joinIntentParts(args, msg)
    const combinedText = [currentIntentText, content].filter(Boolean).join("\n")
    const userRequestedImageEdit = images.length && isImageCompositionEditRequest(currentIntentText)
    const userRequestedImageGeneration = isImageGenerationRequest(currentIntentText)
    const userRequestedSearch = isRealtimeInfoRequest(currentIntentText) || isExplicitSearchRequest(currentIntentText)
    const userRequestedImageAnalysis = images.length && isImageAnalysisRequest(currentIntentText)
    const modelCommitted = hasToolCommitmentText(content)
    const contextualDrawCall = modelCommitted
      ? host.resolveContextualDrawGeneration({
          ...context,
          images,
          args,
          msg,
          currentIntentText,
          modelCommittedToDraw: /(?:画|生成|出图|做图|捏|绘制)/i.test(normalizeIntentText(content))
        })
      : null

    if (!modelCommitted && !userRequestedImageEdit && !userRequestedImageGeneration && !userRequestedSearch && !userRequestedImageAnalysis) return null

    const candidates = []
    if (userRequestedImageEdit || (images.length && isImageCompositionEditRequest(combinedText))) {
      candidates.push({
        toolName: "googleImageEditTool",
        reason: "commitment_image_edit",
        params: {
          images,
          prompt: host.buildImageEditPrompt({
            e: context.e,
            args,
            msg,
            currentIntentText,
            userContent: context.userContent,
            groupUserMessages: context.groupUserMessages
          })
        }
      })
    }
    if (!userRequestedImageEdit && images.length && isImageAnalysisRequest(combinedText)) {
      candidates.push({
        toolName: "googleImageAnalysisTool",
        reason: "commitment_image_analysis",
        params: {
          images,
          prompt: args || msg || "请识别这张图片里有什么内容，并用中文简洁描述。"
        }
      })
    }
    if (contextualDrawCall || userRequestedImageGeneration || isImageGenerationRequest(combinedText)) {
      candidates.push({
        toolName: "bananaTool",
        reason: contextualDrawCall?.reason || "commitment_image_generation",
        params: {
          prompt: contextualDrawCall?.prompt || host.buildImageGenerationPrompt({
              e: context.e,
              args,
              msg,
              currentIntentText,
              userContent: context.userContent,
              images,
              groupUserMessages: context.groupUserMessages
            }),
          images
        }
      })
    }
    if (userRequestedSearch || isRealtimeInfoRequest(combinedText) || isExplicitSearchRequest(combinedText)) {
      candidates.push({
        toolName: "searchInformationTool",
        reason: "commitment_search",
        params: {
          query: args || msg || currentIntentText
        }
      })
    }

    for (const candidate of candidates) {
      const tools = host.getToolsByName([candidate.toolName])
      if (!tools?.length) continue
      return {
        ...candidate,
        tools,
        toolCall: host.buildForcedToolCall(candidate.toolName, candidate.params)
      }
    }

    return null
  }

  /**
   * 执行工具 - 统一处理本地工具和MCP工具
   */
