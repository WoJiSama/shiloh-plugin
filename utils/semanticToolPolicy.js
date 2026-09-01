// Planner calls are valuable only when they can unlock a real tool decision.
// A direct mention or a vague action word alone must not add a second model round.
export function shouldRunSemanticToolPlanner({
  hasMedia = false,
  hasKnownToolCandidate = false,
  hasExplicitToolIntent = false,
  hasRealtimeRequest = false,
  hasExplicitSearchRequest = false
} = {}) {
  return Boolean(
    hasMedia ||
    hasKnownToolCandidate ||
    hasExplicitToolIntent ||
    hasRealtimeRequest ||
    hasExplicitSearchRequest
  )
}

export function hasSemanticPlannerCandidate(candidates = []) {
  return Array.isArray(candidates) && candidates.some(name => name && name !== "sendLocalEmojiTool")
}
