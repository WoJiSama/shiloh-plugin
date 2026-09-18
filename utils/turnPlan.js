import { randomUUID } from "node:crypto"

const OPTIONAL_CAPABILITIES = new Set(["sendLocalEmojiTool"])
const TOOL_INTENT_BY_NAME = [
  [/image|banana/i, "image"],
  [/video|torrent|media/i, "media"],
  [/excel|workbook/i, "excel"],
  [/mention|moderation|redBag/i, "moderation"],
  [/search|webParser|modrinth/i, "search"]
]

function normalizeNames(names = []) {
  return [...new Set((Array.isArray(names) ? names : [])
    .map(name => String(name || "").trim())
    .filter(Boolean))]
}

function forcedToolName(toolChoice, forcedToolCall) {
  return String(
    forcedToolCall?.function?.name ||
    toolChoice?.function?.name ||
    ""
  ).trim()
}

function inferIntent(responseKind, requiredCapabilities) {
  const required = normalizeNames(requiredCapabilities)
  for (const [pattern, intent] of TOOL_INTENT_BY_NAME) {
    if (required.some(name => pattern.test(name))) return intent
  }
  return responseKind === "knowledge" ? "knowledge" : "chat"
}

function needsDeliberateReasoning(text = "") {
  return /(严格证明|完整推导|逐步推导|严谨分析|多步推理|证明(?:一下|下)?|计算过程)/.test(String(text || ""))
}

export function isCasualChatTurn(text = "") {
  const content = String(text || "").replace(/\s+/g, " ").trim()
  if (!content || content.length > 48) return false
  return !/(为什么|为啥|怎么回事|怎么做|如何|解释|讲解|分析|比较|总结|规划|代码|报错|配置|接口|API|算法|推导|证明|搜索|查询)/i.test(content)
}

/**
 * The single policy object for a reply turn. Available capabilities are kept
 * for observability, while required capabilities decide whether an action is
 * mandatory. A short casual turn may also keep an optional reaction tool in
 * the initial request so the tool model can choose between text and a meme.
 */
export function createTurnPlan({
  responseKind = "chat",
  intentText = "",
  availableCapabilities = [],
  requiredCapabilities = [],
  toolChoice = "auto",
  toolScopeLocked = false,
  forcedToolCall = null,
  explicitEmojiRequest = false,
  historyMode = "full",
  selectedHistoryCount = 0
} = {}) {
  const available = normalizeNames(availableCapabilities)
  const requested = normalizeNames(requiredCapabilities)
  const forcedName = forcedToolName(toolChoice, forcedToolCall)
  const committedAction = Boolean(toolScopeLocked || forcedToolCall || forcedName)
  const requestedRequired = requested.filter(name =>
    explicitEmojiRequest || !OPTIONAL_CAPABILITIES.has(name)
  )
  const required = requestedRequired.length
    ? requestedRequired
    : committedAction
    ? normalizeNames(available.length ? available : [forcedName])
    : explicitEmojiRequest
      ? normalizeNames(["sendLocalEmojiTool"])
      : []
  const optional = available.filter(name => !required.includes(name))
  const hasRequiredAction = required.length > 0
  const casual = !hasRequiredAction && responseKind === "chat" && isCasualChatTurn(intentText)
  // A reaction remains optional: `tool_choice: auto` still permits a normal
  // text reply. It must nevertheless reach the tool-capable model, otherwise
  // the emoji tool is silently stripped before the request is made.
  const hasOptionalReaction = casual && optional.some(name => OPTIONAL_CAPABILITIES.has(name))
  const executionMode = hasRequiredAction || hasOptionalReaction ? "tool" : "chat"
  const reasoning = executionMode === "chat" && responseKind === "knowledge" && needsDeliberateReasoning(intentText)
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
    context: { historyMode, selectedHistoryCount },
    presentation: { kind: responseKind === "knowledge" ? "knowledge" : "text" },
    observability: {
      routeReason: executionMode === "tool"
        ? committedAction ? "committed_action" : hasOptionalReaction ? "optional_reaction" : "requested_action"
        : optional.length
          ? "optional_capabilities"
          : "no_required_action"
    }
  }
}

/** Record the actual action chosen by the model without making rendering code
 * infer success from unstructured tool text. */
export function recordTurnPlanToolOutcome(plan, { toolName = "", success = false } = {}) {
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

export function deriveTurnPlanRequest(plan = {}) {
  const profile = plan?.execution?.modelProfile || "adaptive"
  return {
    toolChoice: plan?.execution?.toolChoice || "none",
    requestOptions: profile === "fast"
      ? { forceChatBackend: true, routeLabel: "快速知识回复" }
      : profile === "reasoning"
        ? { routeLabel: "复杂知识推理" }
        : profile === "casual"
          ? { taskBackend: "casual", routeLabel: "短闲聊模型" }
        : {}
  }
}

export function formatTurnPlanLog(plan = {}) {
  return `turn=${plan.id || ""} intent=${plan.intent || "chat"} mode=${plan.execution?.mode || "chat"} profile=${plan.execution?.modelProfile || "adaptive"} presentation=${plan.presentation?.kind || "text"} reason=${plan.observability?.routeReason || ""}`
}

export { OPTIONAL_CAPABILITIES }
