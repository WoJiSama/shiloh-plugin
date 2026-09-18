import { extractChatKeywords } from "../core/intent/messageIntent.js"

// 群聊轻量上下文状态：话题 + 人际互动。纯启发式、零模型调用，
// 从消息流增量维护，给 TimingGate 与主回复链路注入同一份口径。

const TOPIC_WINDOW_MS = 30 * 60 * 1000
const TOPIC_MAX_KEYWORDS = 5
const SOCIAL_MAX_SPEAKERS = 12
const SOCIAL_WINDOW_MS = 30 * 60 * 1000

const topicByGroup = new Map()
const socialByGroup = new Map()

function displayName(id, namesById = {}) {
  return namesById[id] || namesById[String(id)] || `用户${String(id).slice(-4)}`
}

/**
 * 每条群消息调用一次：滚动更新该群的话题关键词。
 * 只保留时间窗内的高频实词，输出「最近在聊：A、B、C」。
 */
export function updateGroupTopic({ groupId = "", text = "" } = {}) {
  const key = String(groupId || "")
  const content = String(text || "").trim()
  if (!key || !content) return
  const state = topicByGroup.get(key) || { keywords: new Map(), recentCount: 0 }
  const now = Date.now()
  state.recentCount += 1
  for (const word of extractChatKeywords(content, 4)) {
    const entry = state.keywords.get(word) || { count: 0, at: 0 }
    entry.count += 1
    entry.at = now
    state.keywords.set(word, entry)
  }
  for (const [word, entry] of state.keywords) {
    if (now - entry.at > TOPIC_WINDOW_MS) state.keywords.delete(word)
  }
  topicByGroup.set(key, state)
}

export function getGroupTopicPrompt(groupId = "") {
  const state = topicByGroup.get(String(groupId || ""))
  if (!state) return ""
  const words = [...state.keywords.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].at - a[1].at)
    .slice(0, TOPIC_MAX_KEYWORDS)
    .map(([word]) => word)
  if (!words.length) return ""
  return `【群话题】最近在聊：${words.join("、")}。回应时贴着这个话题走，别硬扯别的。`
}

/**
 * 每条群消息调用一次：维护最近发言人与互动边（@、引用）。
 * namesById 用来把 QQ 号翻成可读名字（调用方尽力提供，缺省用尾号）。
 */
export function updateGroupSocial({ groupId = "", fromUserId = "", atTargetIds = [], replyToUserId = "", namesById = {} } = {}) {
  const key = String(groupId || "")
  const from = String(fromUserId || "")
  if (!key || !from) return
  const state = socialByGroup.get(key) || { speakers: [], edges: new Map() }
  const now = Date.now()
  const name = namesById[from] || displayName(from, namesById)
  state.speakers.push({ id: from, name, at: now })
  if (state.speakers.length > SOCIAL_MAX_SPEAKERS) state.speakers.splice(0, state.speakers.length - SOCIAL_MAX_SPEAKERS)
  const targets = [...new Set([...(Array.isArray(atTargetIds) ? atTargetIds : []).map(String), String(replyToUserId || "")].filter(t => t && t !== from))]
  for (const target of targets) {
    const edgeKey = `${from}→${target}`
    const entry = state.edges.get(edgeKey) || { count: 0, at: 0, from, target }
    entry.count += 1
    entry.at = now
    state.edges.set(edgeKey, entry)
  }
  for (const [edgeKey, entry] of state.edges) {
    if (now - entry.at > SOCIAL_WINDOW_MS) state.edges.delete(edgeKey)
  }
  socialByGroup.set(key, state)
}

export function getGroupSocialPrompt(groupId = "") {
  const state = socialByGroup.get(String(groupId || ""))
  if (!state) return ""
  const now = Date.now()
  const speakers = state.speakers.filter(s => now - s.at <= SOCIAL_WINDOW_MS)
  if (!speakers.length) return ""
  const lines = []
  const recentNames = [...new Set(speakers.slice(-5).map(s => s.name))]
  if (recentNames.length >= 2) lines.push(`最近发言：${recentNames.join("、")}`)
  const activeEdges = [...state.edges.values()].filter(e => now - e.at <= 5 * 60 * 1000).sort((a, b) => b.at - a.at)
  if (activeEdges.length) {
    const edge = activeEdges[0]
    lines.push(`${displayName(edge.from, {})} 正在和 ${displayName(edge.target, {})} 对话`)
  }
  const targetCounts = new Map()
  for (const edge of state.edges.values()) {
    if (now - edge.at > SOCIAL_WINDOW_MS) continue
    targetCounts.set(edge.target, (targetCounts.get(edge.target) || 0) + edge.count)
  }
  const center = [...targetCounts.entries()].sort((a, b) => b[1] - a[1])[0]
  if (center && center[1] >= 2) lines.push(`话题中心：${displayName(center[0], {})}`)
  if (!lines.length) return ""
  return `【群互动】${lines.join("；")}。别人之间的对话别硬插话。`
}

export function resetGroupContextStateForTests() {
  topicByGroup.clear()
  socialByGroup.clear()
}
