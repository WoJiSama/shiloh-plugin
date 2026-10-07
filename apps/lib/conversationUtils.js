// 会话编排共用小件:消息工具暴露过滤与并发限制器等纯函数,
// 从 apps/test.js 迁出以消除 chatTurn→test.js 的循环依赖。
import pLimit from "p-limit"
import { normalizeIntentText } from "../../core/intent/messageIntent.js"
import { isExplicitAdminCollectionMentionRequest } from "../../utils/mentionRoleRouting.js"
import { filterToolsForEmojiExposure } from "../../utils/emojiToolPolicy.js"
import { isRealtimeInfoRequest } from "../../core/intent/messageIntent.js"
import { isExplicitSearchRequest } from "../../core/intent/messageIntent.js"
import { SEARCH_TOOL_NAMES } from "../../core/intent/messageIntent.js"
import { shouldExposeEmojiToolForMessage } from "../../utils/emojiToolPolicy.js"
import { isExplicitToolIntent } from "../../core/intent/messageIntent.js"

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function getOrCreateGroupLimiter(limitersMap, groupId, concurrency) {
  const entry = limitersMap.get(groupId)
  if (entry && entry.concurrency === concurrency) {
    return entry.limiter
  }
  const limiter = pLimit(concurrency)
  limitersMap.set(groupId, { limiter, concurrency })
  return limiter
}

function hasMediaNeedingTool(message = []) {
  return Array.isArray(message) && message.some(seg =>
    ["image", "video", "record", "voice", "file", "wallet"].includes(seg?.type)
  )
}

function shouldExposeToolsForMessage(e = {}, text = "") {
  const content = normalizeIntentText(text || e?.msg || "")
  if (hasMediaNeedingTool(e?.message)) return true
  if (e?._groupContextAssets?.media?.length) return true
  if (shouldExposeEmojiToolForMessage(content)) return true
  return isRealtimeInfoRequest(content) || isExplicitSearchRequest(content) || isExplicitToolIntent(content)
}

export function filterToolsForMessageIntent(tools = [], e = {}, text = "", { allowSearch = false, emojiCooldownMs = 120000 } = {}) {
  if (!Array.isArray(tools) || !tools.length) return []
  const content = normalizeIntentText(text || e?.msg || "")
  if (allowSearch) return tools.filter(tool => tool?.function?.name !== "mentionAdminsTool" || isExplicitAdminCollectionMentionRequest(content))
  if (!shouldExposeToolsForMessage(e, content)) return []

  // The all-admin tool is deliberately unavailable unless the user used
  // collection wording. A singular role request must go through exact member
  // targeting instead of allowing the model to broaden the audience.
  tools = tools.filter(tool =>
    tool?.function?.name !== "mentionAdminsTool" || isExplicitAdminCollectionMentionRequest(content)
  )

  const emojiOnlyTools = filterToolsForEmojiExposure(tools, content, {
    groupId: String(e?.group_id || ""),
    cooldownMs: emojiCooldownMs
  })
  if (emojiOnlyTools) return emojiOnlyTools

  if (allowSearch || isRealtimeInfoRequest(content) || isExplicitSearchRequest(content)) return tools

  return tools.filter(tool => {
    const name = tool?.function?.name
    return name && !SEARCH_TOOL_NAMES.has(name)
  })
}

export function toolConfigHasName(toolNames, name) {
  return Array.isArray(toolNames) && toolNames.some(item => parseToolConfigEntry(item).name === name)
}

export function parseToolConfigEntry(entry) {
  const raw = String(entry || "").trim()
  const match = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*)(?:\(([^)]*)\))?$/)
  if (!match) return { name: raw, dedupe: false, marker: "" }
  return {
    name: match[1],
    dedupe: match[2] !== undefined,
    marker: match[2] || ""
  }
}
