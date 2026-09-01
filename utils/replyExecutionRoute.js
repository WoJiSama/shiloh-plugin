const OPTIONAL_REACTION_TOOLS = new Set(["sendLocalEmojiTool"])

/**
 * Separate available capabilities from the execution backend for this turn.
 * An optional reaction tool should not force a knowledge reply through the
 * tool-capable model when there is no action for the model to perform.
 */
export function resolveInitialReplyExecutionRoute({
  responseKind = "",
  toolNames = [],
  toolChoice = "auto",
  toolScopeLocked = false,
  forcedToolCall = null,
  explicitEmojiRequest = false
} = {}) {
  const names = Array.from(new Set((Array.isArray(toolNames) ? toolNames : [])
    .map(name => String(name || "").trim())
    .filter(Boolean)))

  if (toolScopeLocked || forcedToolCall || toolChoice !== "auto") {
    return { mode: "tool", reason: "committed_action" }
  }
  if (!names.length) return { mode: "chat", reason: "no_capability" }
  if (explicitEmojiRequest) return { mode: "tool", reason: "explicit_emoji" }

  const hasOnlyOptionalReactions = names.every(name => OPTIONAL_REACTION_TOOLS.has(name))
  if (responseKind === "knowledge" && hasOnlyOptionalReactions) {
    return { mode: "chat", reason: "knowledge_without_action" }
  }
  return { mode: "tool", reason: "action_candidates" }
}
