import type {TurnPlan,TurnPlanInput,ToolChoice,ForcedToolCall} from "../../../contracts/turnPlan.js"
import { randomUUID } from "node:crypto"

const OPTIONAL_CAPABILITIES = new Set(["sendLocalEmojiTool"])
const TOOL_INTENT_BY_NAME: [RegExp,string][] = [
  [/image|banana/i, "image"],
  [/video|torrent|media/i, "media"],
  [/excel|workbook/i, "excel"],
  [/mention|moderation|redBag/i, "moderation"],
  [/search|webParser|modrinth/i, "search"]
]

function normalizeNames(names:unknown[] = []) {
  return [...new Set((Array.isArray(names) ? names : [])
    .map(name => String(name || "").trim())
    .filter(Boolean))]
}

function forcedToolName(toolChoice:ToolChoice, forcedToolCall:ForcedToolCall|null) {
  return String(
    forcedToolCall?.function?.name ||
    (typeof toolChoice === "object" ? toolChoice.function?.name : "") ||
    ""
  ).trim()
}

function inferIntent(responseKind:string, requiredCapabilities:string[]) {
  const required = normalizeNames(requiredCapabilities)
  for (const [pattern, intent] of TOOL_INTENT_BY_NAME) {
    if (required.some(name => pattern.test(name))) return intent
  }
  return responseKind === "knowledge" ? "knowledge" : "chat"
}

// 复杂度判定:命中即选 reasoning 路由，具体思考预算由配置决定。除学术推导类原有关键词外,
// 覆盖群里真实发生的复杂问法——多约束对比、故障排查、方案规划;
// 连环追问(疑问信号 ≥3)也算。注意门槛靠 isCasualChatTurn 反向兜底:
// 命中这些模式的回合不可能是 casual,不会误伤短闲聊的提速路径。
export {needsDeliberateReasoning,isCasualChatTurn} from "../domain/turnPlanPolicy.js"
import {needsDeliberateReasoning,isCasualChatTurn} from "../domain/turnPlanPolicy.js"

/**
 * The single policy object for a reply turn. Available capabilities are kept
 * for observability, while required capabilities decide whether an action is
 * mandatory. A short casual turn may also keep an optional reaction tool in
 * the initial request so the tool model can choose between text and a meme.
 */
export function createTurnPlan({
  responseKind = "chat",
  intentText = "",
  interactionKind,
  availableCapabilities = [],
  requiredCapabilities = [],
  toolDecision,
  toolChoice = "auto",
  toolScopeLocked = false,
  forcedToolCall = null,
  explicitEmojiRequest = false,
  keepAutoToolsOnChatTurn = true,
  historyMode = "full",
  selectedHistoryCount = 0
}:TurnPlanInput = {}):TurnPlan {
  const available = normalizeNames(availableCapabilities)
  const requested = normalizeNames(requiredCapabilities)
  const noTools = toolDecision?.intent === "chat" || toolChoice === "none"
  const forcedName = forcedToolName(toolChoice, forcedToolCall)
  const committedAction = !noTools && Boolean(toolScopeLocked || forcedToolCall || forcedName)
  const requestedRequired = (toolDecision?.toolName ? [toolDecision.toolName] : requested).filter(name =>
    explicitEmojiRequest || !OPTIONAL_CAPABILITIES.has(name)
  )
  const required = noTools ? [] : requestedRequired.length
    ? requestedRequired
    : committedAction
    ? normalizeNames(available.length ? available : [forcedName])
    : explicitEmojiRequest
      ? normalizeNames(["sendLocalEmojiTool"])
      : []
  const optional = noTools ? [] : available.filter(name => !required.includes(name))
  const hasRequiredAction = required.length > 0
  const seriousAnswer = interactionKind === "serious_answer"
  const deliveryStatus = interactionKind === "delivery"
  const groundedReply = seriousAnswer || deliveryStatus
  const casual = !groundedReply && !hasRequiredAction && responseKind === "chat" && isCasualChatTurn(intentText)
  // A reaction remains optional: `tool_choice: auto` still permits a normal
  // text reply. It must nevertheless reach the tool-capable model, otherwise
  // the emoji tool is silently stripped before the request is made.
  const hasOptionalReaction = casual && optional.some(name => OPTIONAL_CAPABILITIES.has(name))
  const hasOptionalTools = !noTools && keepAutoToolsOnChatTurn && toolChoice === 'auto' && optional.some(name => !OPTIONAL_CAPABILITIES.has(name))
  const executionMode = hasRequiredAction || hasOptionalReaction || hasOptionalTools ? "tool" : "chat"
  // 认真处理问题与思考预算分开：技术追问即使被判为 chat，也保留 reasoning 路由和
  // 证据约束，但不会因此自动提高到 high；casual 仍由 isCasualChatTurn 排除。
  const reasoning = executionMode === "chat" && (groundedReply || needsDeliberateReasoning(intentText))
  const modelProfile = hasOptionalReaction
    ? "casual"
    : executionMode === "tool"
      ? "task"
      : reasoning
      ? "reasoning"
      : casual
        ? "casual"
      : responseKind === "knowledge"
        ? "fast"
        : "adaptive"
  const intent = inferIntent(responseKind, required)

  return {
    id: randomUUID(),
    intent,
    execution: {
      mode: executionMode,
      modelProfile,
      toolChoice: executionMode === "tool" ? toolChoice : "none"
    },
    capabilities: { required, optional, available },
    ...(toolDecision ? {toolDecision} : {}),
    context: { historyMode, selectedHistoryCount },
    presentation: { kind: responseKind === "knowledge" ? "knowledge" : "text" },
    observability: {
      routeReason: toolDecision?.intent === "chat" ? "semantic_chat" : executionMode === "tool"
        ? committedAction ? "committed_action" : hasOptionalReaction ? "optional_reaction" : hasRequiredAction ? "requested_action" : "optional_tools"
        : seriousAnswer
          ? "serious_answer"
          : deliveryStatus
            ? "delivery_status"
          : optional.length
          ? "optional_capabilities"
          : "no_required_action"
    }
  }
}

/** Record the actual action chosen by the model without making rendering code
 * infer success from unstructured tool text. */
export function recordTurnPlanToolOutcome(plan:TurnPlan|null|undefined, { toolName = "", success = false } = {}) {
  if (!plan || !toolName) return plan
  const name = String(toolName).trim()
  if (!plan.capabilities.required.includes(name)) plan.capabilities.required.push(name)
  plan.capabilities.optional = plan.capabilities.optional.filter(item => item !== name)
  plan.execution.mode = "tool"
  plan.execution.modelProfile = "task"
  plan.intent = inferIntent(plan.intent === "knowledge" ? "knowledge" : "chat", plan.capabilities.required)
  plan.outcomes = [...(plan.outcomes || []), { toolName: name, success: Boolean(success) }]
  return plan
}

export function deriveTurnPlanRequest(plan:Partial<TurnPlan> = {}, config:{chatAiConfig?:{complexReasoningEffort?:unknown}} = {}) {
  const profile = plan?.execution?.modelProfile || "adaptive"
  // reasoning 路由的预算经 options.generation 直达请求体，默认 low。
  // (apiClient: generation.reasoningEffort 优先于 backend.reasoningEffort)。
  // complexReasoningEffort 可显式改档；false/none 仅停止覆盖并继承后端，不是关闭思考。
  const configuredEffort = String(config?.chatAiConfig?.complexReasoningEffort ?? "low").trim().toLowerCase()
  const escalateEffort = ["minimal", "low", "medium", "high", "max"].includes(configuredEffort) ? configuredEffort : ""
  return {
    toolChoice: plan?.execution?.toolChoice || "none",
    ...(plan.execution?.mode === "chat" ? {
      executionPrompt: "【本轮执行范围】\n本次只生成并发出当前回复，没有可调用的工具；这次回复不会新登记自动查询、重试、生成或稍后投递。已经核验且仍有效的后续登记可以按其实际范围说明，不能因为本轮只有文字就否认既有登记；没有核验到登记则不能承诺稍后行动。即使加上条件，‘好了我第一时间发你’‘有结果就通知你’也属于后续承诺，必须有已核验的有效登记才能说。没有登记时只回答当前状态，不能暗示会继续查看或主动补发。基于已有结果回答，缺少当前结果就保持未确认。不要用将来会做某件事代替实际调用，也不要替用户重新发起旧任务。"
    } : {}),
    requestOptions: profile === "fast"
      ? { forceChatBackend: true, routeLabel: "快速知识回复" }
      : profile === "reasoning"
        ? {
            routeLabel: "复杂知识推理",
            ...(escalateEffort ? { generation: { reasoningEffort: escalateEffort } } : {})
          }
        : profile === "casual"
          ? { taskBackend: "casual", routeLabel: "短闲聊模型" }
        : {}
  }
}

export function formatTurnPlanLog(plan:Partial<TurnPlan> = {}) {
  return `turn=${plan.id || ""} intent=${plan.intent || "chat"} mode=${plan.execution?.mode || "chat"} profile=${plan.execution?.modelProfile || "adaptive"} presentation=${plan.presentation?.kind || "text"} reason=${plan.observability?.routeReason || ""}`
}

export { OPTIONAL_CAPABILITIES }
