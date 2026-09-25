// Planner calls are valuable only when they can unlock a real tool decision.
// A direct mention or a vague action word alone must not add a second model round.
export function shouldRunSemanticToolPlanner({
  hasMedia = false,
  hasKnownToolCandidate = false,
  hasExplicitToolIntent = false,
  hasRealtimeRequest = false,
  hasExplicitSearchRequest = false,
  hasMemberMentions = false
} = {}) {
  return Boolean(
    hasMedia ||
    hasKnownToolCandidate ||
    hasExplicitToolIntent ||
    hasRealtimeRequest ||
    hasExplicitSearchRequest ||
    // 提及了群成员(@了某人/回复某人)是结构性信号:这类消息可能需要
    // LLM 头像参考规划(谁的头像演什么角色),交给规划器判定。
    hasMemberMentions
  )
}

export function hasSemanticPlannerCandidate(candidates = []) {
  return Array.isArray(candidates) && candidates.some(name => name && name !== "sendLocalEmojiTool")
}
