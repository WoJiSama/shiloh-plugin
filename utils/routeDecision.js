// 工具路由决策表:原 apps/test.js 主链路里 16 个顺序 if 块的忠实转写。
// 第一刀原则:只搬家、不调序——每条规则的判定条件、工具选择、锁语义、日志
// 与原代码逐字等价;唯一删除的是原 4905-4918 的"识图强制路由"重复块
// (与 4747 块逐字相同,且因 toolChoice 守卫永不触发,属复制粘贴死代码)。
//
// 规则求值协议(与原 if 块语义一一对应):
// - guard: "both" = !toolScopeLocked && toolChoice==="auto"(标准守卫);
//          "auto" = 仅 toolChoice==="auto"(原 Excel 块的写法);
//          "unlocked" = 仅 !toolScopeLocked(原头像编辑模式/导图块的写法)。
// - evaluate 返回 decision 或 null;decision:
//   { toolChoiceName, forcedToolCallParams | toolCall, tools(直接数组) | toolNames(getToolsByName),
//     lock, lockOnlyWithToolChoice, sessionPatch, appendAvatarLink, log, logParams, abort, intent }
// - 原代码中"先 session.tools = getToolsByName(...),工具存在才设 toolChoice"的次序
//   由 evaluate 内调用 ctx.applyTools(names) 保留:applyTools 返回工具数组并写入 session.tools。
import { isImageAnalysisRequest, isImageCompositionEditRequest, getImageVerificationMode, normalizeIntentText, isRealtimeInfoRequest, isExplicitSearchRequest } from "../core/intent/messageIntent.js"
import { looksLikeImageVerificationRequest } from "./imageRequestGuard.js"
import { shouldPreferImageGeneration } from "./imageTaskPolicy.js"
import { resolveDeterministicToolIntent } from "./toolIntentManifests.js"
import { resolveForcedReactionEmoji, suppressEmojiByCooldown, pickForcedReplyLayout } from "./emojiToolPolicy.js"
import { resolveNaturalDeltaForceToolCall } from "./deltaForceIntent.js"

// 从 apps/test.js 原样迁出:识图请求是否需要在视觉之后接搜索
function getImageAnalysisToolNames(text = "") {
  const content = normalizeIntentText(text)
  const shouldAllowSearchAfterVision =
    looksLikeImageVerificationRequest(content) ||
    isRealtimeInfoRequest(content) ||
    isExplicitSearchRequest(content)
  return shouldAllowSearchAfterVision
    ? ["googleImageAnalysisTool", "searchInformationTool"]
    : ["googleImageAnalysisTool"]
}

export const ROUTE_RULES = [
  {
    name: "singularOwnerMention",
    guard: "auto",
    evaluate(ctx) {
      const mention = ctx.helpers.resolveSingularOwnerMention(ctx.intentText, ctx.memberMap)
      if (!mention) return null
      return {
        toolNames: ["mentionMembersTool"],
        toolChoiceName: "mentionMembersTool",
        forcedToolCallParams: { targets: [mention.targetUserId], message: mention.message },
        lock: true,
        log: `[工具快路] group=${ctx.groupId} 单数群主请求精确艾特 owner=${mention.targetUserId}`
      }
    }
  },
  {
    name: "forcedReactionEmoji",
    guard: "both",
    async evaluate(ctx) {
      const reaction = resolveForcedReactionEmoji(ctx.intentText)
      if (!reaction) return null
      if (suppressEmojiByCooldown(ctx.intentText, ctx.groupId, ctx.emojiCooldownMs)) return null
      const tools = ctx.applyTools(["sendLocalEmojiTool"])
      if (!tools?.length) return { silent: true }
      // 强制路配文：从规则配文池抽样（不加模型调用）；该群裸表情占比高时配文率自适应下降
      const forcedTextRate = await ctx.helpers.resolveForcedReplyTextRate(ctx.groupId)
      const forcedLayout = pickForcedReplyLayout({ replies: reaction.replies, textRate: forcedTextRate })
      return {
        toolChoiceName: "sendLocalEmojiTool",
        forcedToolCallParams: {
          tags: reaction.tags,
          useCases: reaction.useCases,
          leadText: forcedLayout.leadText
        },
        lock: true,
        log: `[表情包快路] group=${ctx.groupId} 强制发送反应表情 tags=${reaction.tags.join(",")} layout=${forcedLayout.layout}${forcedLayout.leadText ? ` lead="${forcedLayout.leadText}"` : ""}`
      }
    }
  },
  {
    name: "excelWorkbook",
    guard: "auto",
    evaluate(ctx) {
      if (!ctx.excelToolIntent) return null
      const tools = ctx.applyTools(["excelWorkbookTool"])
      if (!tools?.length) return { silent: true }
      if (ctx.excelToolParams) {
        return {
          toolChoiceName: "excelWorkbookTool",
          forcedToolCallParams: ctx.excelToolParams,
          lock: true,
          log: `[工具快路] group=${ctx.groupId} 直接执行 excelWorkbookTool params=${JSON.stringify(ctx.excelToolParams)}`
        }
      }
      // Excel 开放式任务:锁工具范围但保持 tool_choice=auto(原块 4693 的锁语义)
      return {
        lock: true,
        log: `[工具选择] group=${ctx.groupId} Excel 开放式任务仅开放 excelWorkbookTool 并保持 tool_choice=auto`
      }
    }
  },
  {
    name: "videoAnalysis",
    guard: "both",
    evaluate(ctx) {
      if (!(ctx.videos?.length >= 1)) return null
      const tools = ctx.applyTools(["videoAnalysisTool"])
      if (!tools?.length) return { silent: true }
      return { toolChoiceName: "videoAnalysisTool" }
    }
  },
  {
    name: "forcedAvatarMode",
    guard: "unlocked",
    evaluate(ctx) {
      if (!ctx.config?.forcedAvatarMode || !ctx.rawMsg?.includes("头像编辑")) return null
      const tools = ctx.applyTools(["googleImageEditTool"])
      if (!tools?.length) return { silent: true }
      return { toolChoiceName: "googleImageEditTool", appendAvatarLink: ctx.userId }
    }
  },
  {
    name: "avatarEditBase",
    guard: "both",
    async evaluate(ctx) {
      if (!ctx.session?.avatarEditBase?.images?.length) return null
      const tools = ctx.applyTools(["googleImageEditTool"])
      if (!tools?.length) return { silent: true }
      return {
        toolChoiceName: "googleImageEditTool",
        forcedToolCallParams: {
          images: ctx.images,
          prompt: [
            ctx.helpers.buildImageEditPrompt(ctx.promptContext()),
            ctx.session.avatarEditBase.promptHint
          ].filter(Boolean).join("\n")
        },
        log: `[工具选择] group=${ctx.groupId} 强制使用 googleImageEditTool 处理群友头像编辑请求`
      }
    }
  },
  {
    name: "avatarInspection",
    guard: "both",
    evaluate(ctx) {
      if (!ctx.session?.avatarInspection?.images?.length) return null
      const tools = ctx.applyTools(["googleImageAnalysisTool"])
      if (!tools?.length) return { silent: true }
      return {
        toolChoiceName: "googleImageAnalysisTool",
        forcedToolCallParams: {
          images: ctx.session.avatarInspection.images,
          prompt: ctx.session.avatarInspection.prompt
        },
        log: `[工具选择] group=${ctx.groupId} 强制使用 googleImageAnalysisTool 处理头像识别请求`
      }
    }
  },
  {
    name: "mindMap",
    guard: "unlocked",
    evaluate(ctx) {
      if (!(ctx.rawMsg?.includes("导图") || ctx.rawMsg?.includes("思维导图"))) return null
      const tools = ctx.applyTools(["aiMindMapTool"])
      if (!tools?.length) return { silent: true }
      return { toolChoiceName: "aiMindMapTool" }
    }
  },
  {
    name: "imageAnalysis",
    guard: "both",
    evaluate(ctx) {
      if (!(ctx.images?.length && (isImageAnalysisRequest(ctx.intentText) || ctx.modelIntent === "image_analysis"))) return null
      const imageAnalysisToolNames = getImageAnalysisToolNames(ctx.intentText)
      ctx.applyTools(imageAnalysisToolNames)
      // 与原块一致:核实模式标记在工具存在性判定之前写入 session
      ctx.session.imageVerificationNeedsSearch = imageAnalysisToolNames.includes("searchInformationTool")
      ctx.session.imageVerificationMode = getImageVerificationMode(ctx.intentText)
      if (!ctx.session.tools?.length) return { silent: true }
      return {
        toolChoiceName: "googleImageAnalysisTool",
        forcedToolCallParams: {
          images: ctx.images,
          prompt: ctx.intentText || ctx.args || ctx.rawMsg || "请识别这张图片里有什么内容，并用中文简洁描述。"
        },
        log: `[工具选择] group=${ctx.groupId} 强制使用 googleImageAnalysisTool 处理识图请求`
      }
    }
  },
  {
    name: "recentImageContinuation",
    guard: "both",
    async evaluate(ctx) {
      if (!(ctx.session?.recentImageContinuation?.image && ctx.modelIntent !== "image_analysis")) return null
      const tools = ctx.applyTools(["googleImageEditTool"])
      if (!tools?.length) return { silent: true }
      return {
        toolChoiceName: "googleImageEditTool",
        forcedToolCallParams: {
          images: ctx.images,
          prompt: ctx.helpers.buildImageEditPrompt(ctx.promptContext())
        },
        log: `[工具选择] group=${ctx.groupId} 最近成图续改强制使用 googleImageEditTool`
      }
    }
  },
  {
    name: "contextualDraw",
    guard: "both",
    evaluate(ctx) {
      const drawCall = ctx.helpers.resolveContextualDrawGeneration({
        ...ctx.promptContext(),
        images: ctx.imageGenerationReferenceImages(),
        avatarDrawReference: ctx.session.avatarDrawReference
      })
      if (!drawCall) return null
      const tools = ctx.applyTools(["bananaTool"])
      if (!tools?.length) return { silent: true }
      return {
        toolChoiceName: "bananaTool",
        forcedToolCallParams: {
          prompt: drawCall.prompt,
          images: ctx.imageGenerationReferenceImages()
        },
        log: `[工具选择] group=${ctx.groupId} 上下文衔接使用 bananaTool reason=${drawCall.reason}`
      }
    }
  },
  {
    name: "explicitImageGeneration",
    guard: "both",
    async evaluate(ctx) {
      const preferImageGeneration = ctx.modelIntent === "image_generate" || (
        !(ctx.modelIntent === "image_edit" || ctx.modelIntent === "image_analysis") &&
        shouldPreferImageGeneration(ctx.intentText, {
          hasImages: ctx.imageGenerationReferenceImages().length > 0,
          hasRecentBotImage: Boolean(ctx.session.recentImageContinuation)
        })
      )
      if (!preferImageGeneration) return null
      const tools = ctx.applyTools(["bananaTool"])
      if (!tools?.length) {
        // 原块 4819-4825:显式生图但没有可用渠道 → 发失败提示并终止本回合(由主链路执行)
        return { abort: "no-banana-channel", warn: `[工具选择] group=${ctx.groupId} 显式生图请求没有可用 bananaTool，拒绝降级为闲聊` }
      }
      return {
        toolChoiceName: "bananaTool",
        forcedToolCallParams: {
          prompt: ctx.helpers.buildImageGenerationPrompt({
            ...ctx.promptContext(),
            images: ctx.imageGenerationReferenceImages(),
            avatarDrawReference: ctx.session.avatarDrawReference
          }),
          images: ctx.imageGenerationReferenceImages()
        },
        log: `[工具选择] group=${ctx.groupId} 显式生图请求直接使用 bananaTool，跳过语义规划`
      }
    }
  },
  // 确定性快路必须先于语义规划器:正则清单命中即免 LLM 分类直接调用,
  // 否则"搜搜初音未来的图"这类消息会被语义分类抢先判成通用搜索。
  {
    name: "deterministicManifest",
    guard: "both",
    evaluate(ctx) {
      const decision = resolveDeterministicToolIntent(
        ctx.intentText,
        (ctx.session.tools || []).map(tool => tool?.function?.name).filter(Boolean),
        { hasExcelContext: ctx.hasExcelContext, hasPixivSearchSession: ctx.hasPixivSearchSession }
      )
      const toolCall = decision
        ? ctx.helpers.buildToolCallFromDecision(decision, ctx.promptContext())
        : null
      if (!toolCall) return null
      return {
        tools: toolCall.tools,
        toolChoiceName: toolCall.toolName,
        toolCall: toolCall.toolCall,
        lock: true,
        logParams: decision.params,
        log: `[工具兜底] group=${ctx.groupId} 使用确定性参数解析 ${toolCall.toolName} params=${JSON.stringify(decision.params)}`
      }
    }
  },
  {
    name: "semanticPlanner",
    guard: "both",
    async evaluate(ctx) {
      const decision = await ctx.helpers.classifySemanticToolIntent({
        ...ctx.promptContext(),
        images: ctx.images,
        videos: ctx.videos,
        avatarDrawReference: ctx.session.avatarDrawReference,
        groupWorkflowPrompt: ctx.groupWorkflowPrompt,
        sessionTools: ctx.helpers.semanticSessionTools()
      })
      const toolCall = decision?.toolName
        ? ctx.helpers.buildToolCallFromDecision(decision, {
          ...ctx.promptContext(),
          images: ctx.imageGenerationReferenceImages(),
          avatarDrawReference: ctx.session.avatarDrawReference
        })
        : null
      if (!toolCall) return null
      return {
        tools: toolCall.tools,
        toolChoiceName: toolCall.toolName,
        toolCall: toolCall.toolCall,
        intent: toolCall.intent,
        log: `[工具选择] group=${ctx.groupId} 语义分类强制使用 ${toolCall.toolName} intent=${toolCall.intent}`
      }
    }
  },
  {
    name: "naturalDeltaForce",
    guard: "both",
    evaluate(ctx) {
      const call = resolveNaturalDeltaForceToolCall(ctx.intentText, { botName: ctx.botName })
      if (!call) return null
      const tools = ctx.applyTools(["deltaForceTool"])
      if (!tools?.length) return { silent: true }
      return {
        toolChoiceName: "deltaForceTool",
        forcedToolCallParams: call.params,
        log: `[工具选择] group=${ctx.groupId} 规则兜底使用 deltaForceTool 处理三角洲自然语言请求 params=${JSON.stringify(call.params)}`
      }
    }
  },
  {
    name: "imageEdit",
    guard: "both",
    async evaluate(ctx) {
      if (!(ctx.images?.length && (isImageCompositionEditRequest(ctx.intentText) || ctx.modelIntent === "image_edit"))) return null
      const tools = ctx.applyTools(["googleImageEditTool"])
      if (!tools?.length) return { silent: true }
      return {
        toolChoiceName: "googleImageEditTool",
        forcedToolCallParams: {
          images: ctx.images,
          prompt: [
            ctx.helpers.buildImageEditPrompt(ctx.promptContext()),
            ctx.session.editAssets?.promptHint
          ].filter(Boolean).join("\n")
        },
        log: `[工具选择] group=${ctx.groupId} 强制使用 googleImageEditTool 处理图片编辑请求`
      }
    }
  }
]

// 顺序求值规则表。守卫语义与原 if 块一致:
// - 命中(设了 toolChoice)后,后续 "auto"/"both" 守卫的规则自然跳过;
// - lock 后,后续 "both"/"unlocked" 守卫的规则跳过(与原 toolScopeLocked 用法一致)。
// 返回 { toolChoice, forcedToolCall, toolScopeLocked, applied: [ruleName], aborted, warn }
export async function resolveToolRoute(ctx) {
  let toolChoice = "auto"
  let forcedToolCall = null
  let toolScopeLocked = false
  const applied = []
  let aborted = null
  let warn = null

  for (const rule of ROUTE_RULES) {
    if (aborted) break
    if (rule.guard !== "unlocked" && toolChoice !== "auto") continue
    if (rule.guard !== "auto" && toolScopeLocked) continue

    const decision = await rule.evaluate(ctx)
    if (!decision) continue
    if (decision.silent) continue
    applied.push(rule.name)

    if (decision.warn) warn = decision.warn
    if (decision.abort) {
      aborted = decision.abort
      break
    }
    if (decision.tools) ctx.session.tools = decision.tools
    if (decision.toolChoiceName) {
      toolChoice = { type: "function", function: { name: decision.toolChoiceName } }
      if (decision.forcedToolCallParams) {
        forcedToolCall = ctx.helpers.buildForcedToolCall(decision.toolChoiceName, decision.forcedToolCallParams)
      }
      if (decision.toolCall) forcedToolCall = decision.toolCall
    }
    if (decision.appendAvatarLink != null) {
      ctx.session.groupUserMessages.at(-1).content += `[用户头像链接: (https://q1.qlogo.cn/g?b=qq&nk=${decision.appendAvatarLink}&s=640)]`
    }
    if (decision.lock) toolScopeLocked = true
    if (decision.log) ctx.log(decision.log)
  }

  return { toolChoice, forcedToolCall, toolScopeLocked, applied, aborted, warn }
}
