import { pluginBridge } from "../../utils/pluginBridge.js"
import { safeTruncateUnicode } from "../../utils/unicodeText.js"

function asList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || "").trim()).filter(Boolean)
  return String(value || "")
    .split(/[,\n，]/)
    .map(item => item.trim())
    .filter(Boolean)
}

function findById(items = [], id, field = "qq") {
  return Array.isArray(items)
    ? items.find(item => String(item?.[field] || "").trim() === String(id))
    : null
}

function addField(lines, label, value) {
  const list = asList(value)
  if (!list.length) return false
  lines.push(`- ${label}: ${list.join("、")}`)
  return true
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

function compactLine(text, maxLength = 80) {
  return safeTruncateUnicode(String(text || "")
    .replace(/\s+/g, " ")
    .trim(), maxLength)
}

function dedupeRecentMessages(messages = [], limit = 3) {
  const seen = new Set()
  const result = []
  for (const message of messages) {
    const raw = compactLine(message?.raw_message || message?.content || "", 80)
    if (!raw) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(raw)
    if (result.length >= limit) break
  }
  return result
}

export class PersonProfileInjector {
  formatNames(sender = {}, fallback = "") {
    const names = []
    for (const value of [sender.card, sender.nickname, fallback]) {
      const text = String(value || "").trim()
      if (text && !names.some(item => item.toLowerCase() === text.toLowerCase())) names.push(text)
    }
    if (!names.length) return fallback
    if (names.length === 1) return names[0]
    return `${names[0]}（昵称:${names.slice(1).join(" / ")}）`
  }

  async build(groupId, userId, e) {
    const sharedState = pluginBridge.sharedState
    const config = pluginBridge.instance?.config
    const cfg = config?.personProfileInjection
    if (!cfg?.enabled) return ""
    if (!groupId || !userId) return ""
    const maxChars = clampNumber(cfg.maxChars, 900, 200, 3000)

    let sender = e?.sender || {}
    try {
      const memberMap = await e?.group?.getMemberMap?.()
      sender = memberMap?.get?.(Number(userId)) || sender
    } catch {}
    const senderName = this.formatNames(sender, `用户${userId}`)
    const lines = []
    let hasData = false

    const personaPrompt = this.buildPersonaPrompt(config?.persona)
    if (personaPrompt) lines.push(personaPrompt)

    const groupPrompt = this.buildGroupProfilePrompt(config?.groupProfiles, groupId)
    if (groupPrompt) lines.push(groupPrompt)

    const userLines = [`【当前对话者画像】`, `- 昵称: ${senderName} (QQ: ${userId})`]

    try {
      const recent = await sharedState?.messageManager?.getMessages?.("group", groupId)
      if (Array.isArray(recent)) {
        const limit = Math.max(0, Number(cfg.maxRecentMessages) || 3)
        if (limit > 0) {
          const userMsgs = recent
            .filter(m => String(m?.sender?.user_id) === String(userId))
            .slice(0, limit)
          const recentLines = dedupeRecentMessages(userMsgs, limit)
          if (recentLines.length > 0) {
            userLines.push(`- 此人最近发言:`)
            recentLines.forEach(raw => userLines.push(`  · ${raw}`))
            hasData = true
          }
        }
      }
    } catch {}

    if (hasData) lines.push(userLines.join("\n"))
    if (!lines.length) return ""
    return safeTruncateUnicode(lines.join("\n"), maxChars)
  }

  buildPersonaPrompt(persona = {}) {
    if (!persona?.enabled) return ""
    const lines = ["【固定人设】"]
    let hasData = false
    hasData = addField(lines, "名字", persona.name) || hasData
    hasData = addField(lines, "身份", persona.identity) || hasData
    hasData = addField(lines, "语气", persona.tone) || hasData
    hasData = addField(lines, "说话风格", persona.speechStyle) || hasData
    hasData = addField(lines, "边界", persona.boundaries) || hasData
    hasData = addField(lines, "备注", persona.notes) || hasData
    return hasData ? lines.join("\n") : ""
  }

  buildGroupProfilePrompt(groupProfiles = [], groupId) {
    const profile = findById(groupProfiles, groupId, "groupId")
    if (!profile) return ""
    const lines = ["【本群画像】", `- 群号: ${groupId}`]
    if (profile.groupName) lines.push(`- 群名: ${profile.groupName}`)
    let hasData = Boolean(profile.groupName)
    hasData = addField(lines, "群气氛", profile.atmosphere) || hasData
    hasData = addField(lines, "群规/边界", profile.rules) || hasData
    hasData = addField(lines, "群梗/黑话", profile.memes) || hasData
    hasData = addField(lines, "常聊话题", profile.topics) || hasData
    hasData = addField(lines, "常见成员关系", profile.members) || hasData
    hasData = addField(lines, "备注", profile.notes) || hasData
    return hasData ? lines.join("\n") : ""
  }
}

export const personProfileInjector = new PersonProfileInjector()
