// prompt 分层策略：闲聊与任务不再共用同一锅 19 层提示——
// 短句闲聊只留 人设绑定+情绪+记忆+语气+人设守卫反馈，任务/知识/带素材回合才注入全部层，
// 避免闲聊被喂成说明书、长任务被风格层冲淡。
// 层的取舍依据回合开始时的轻量画像（意图判定已前置），执行路由仍由 turnPlan 决定。
const FULL_PROMPT_LAYERS = [
  "identityBindings",
  "workflowTeaching",
  "knowledgeTeaching",
  "workflow",
  "groupKnowledge",
  "mergedTrigger",
  "emotion",
  "memory",
  "expression",
  "personaTone",
  "narrativeWriting",
  "solutionExplanation",
  "cardBody",
  "personaFeedback",
  "globalStyle",
  "semanticStyle",
  "knowledge",
  "memberLookup",
  "personProfile"
]

// 闲聊保底层：人设相关 + 少量记忆（用户的原始诉求）
const CHAT_PROMPT_LAYERS = ["identityBindings", "emotion", "memory", "personaTone", "personaFeedback"]

// resolvePrimaryModelIntent 低置信/超时返回 null，能拿到 intent 即代表 conf>=0.7
const TASK_INTENT_KINDS = new Set([
  "image_generate",
  "image_edit",
  "image_analysis",
  "search",
  "dice",
  "deltaforce",
  "magnet",
  "music",
  "memory_command",
  "emoji",
  "group_admin",
  "other_tool"
])

export function resolvePromptLayerProfile({
  responseKind = "chat",
  modelIntent = "",
  requiredToolNames = [],
  hasImages = false,
  hasVideos = false
} = {}) {
  const intent = String(modelIntent || "")
  const modelIntentIsTask = TASK_INTENT_KINDS.has(intent)
  const hasTaskSignal = modelIntentIsTask || responseKind === "knowledge" || hasImages || hasVideos || requiredToolNames.length > 0
  const reason = modelIntentIsTask
    ? `intent:${intent}`
    : responseKind === "knowledge"
      ? "knowledge"
      : hasImages
        ? "has_images"
        : hasVideos
          ? "has_videos"
          : requiredToolNames.length
            ? "tool_candidates"
            : "casual"
  return {
    profile: hasTaskSignal ? "task" : "chat",
    reason,
    layers: hasTaskSignal ? FULL_PROMPT_LAYERS : CHAT_PROMPT_LAYERS
  }
}

export function applyPromptLayerProfile(profile, layerMap = {}) {
  const selected = new Set(profile?.layers || FULL_PROMPT_LAYERS)
  const included = []
  const omitted = []
  for (const name of FULL_PROMPT_LAYERS) {
    const text = layerMap[name]
    if (!text) continue
    if (selected.has(name)) included.push(text)
    else omitted.push(name)
  }
  return { prompt: included.join("\n"), omitted }
}

export { FULL_PROMPT_LAYERS, CHAT_PROMPT_LAYERS, TASK_INTENT_KINDS }
