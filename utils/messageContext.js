// 消息上下文与提及识别:从 apps/test.js 原样迁出的纯函数簇,
// 覆盖"这句话在对谁说/引用了谁/群成员叫什么"三类判定,
// 供主链路与提示词组装层共用。函数体除 import 外零改动。
import { PREVIOUS_SPEAKER_REPLY_PATTERNS, isQuestionMessage, looksGroupAddressed } from "../core/intent/messageIntent.js"
import { stripCqMarkup } from "./replySanitizer.js"

export const ROLE_MAP = { owner: "owner", admin: "admin", member: "member" }

export function summarizeForLog(text = "", max = 100) {
  const compact = stripCqMarkup(text).replace(/\s+/g, " ").trim()
  return compact.length > max ? `${compact.slice(0, max)}...` : compact
}

export function hasDirectBotName(text = "", botName = "") {
  const msg = String(text || "").toLowerCase()
  const name = String(botName || "").toLowerCase()
  return Boolean(name && msg.includes(name))
}

export function hasBotTextAnchor(text = "", botName = "", prefixes = []) {
  const msg = String(text || "").toLowerCase()
  if (hasDirectBotName(msg, botName)) return true
  return (Array.isArray(prefixes) ? prefixes : []).some(prefix => {
    const p = String(prefix || "").toLowerCase().trim()
    return p && msg.includes(p)
  })
}

export function getReplySender(seg = {}) {
  return seg?.sender_id ?? seg?.user_id ?? seg?.qq ??
    seg?.sender?.user_id ?? seg?.sender?.qq ??
    seg?.data?.sender_id ?? seg?.data?.user_id ?? seg?.data?.qq ??
    seg?.data?.sender?.user_id ?? seg?.data?.sender?.qq
}

export function messageQuotesUser(e = {}, userId = "") {
  if (!userId) return false
  const sources = [e?.source, e?.reply, e?.replyMessage, e?.quoted, e?.quote]
  for (const source of sources) {
    if (!source) continue
    const sender = getReplySender(source)
    if (sender && String(sender) === String(userId)) return true
  }
  if (Array.isArray(e?.message)) {
    for (const seg of e.message) {
      if (seg?.type !== "reply") continue
      const sender = getReplySender(seg)
      if (sender && String(sender) === String(userId)) return true
    }
  }
  return false
}

export function getPreviousRecentMessage(state, e) {
  const messages = Array.isArray(state?.recentMessages) ? state.recentMessages : []
  const currentUserId = String(e?.user_id || "")
  const currentText = String(e?.msg || "").trim()
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i]
    if (!item) continue
    const isCurrent = String(item.userId || "") === currentUserId &&
      String(item.text || "").trim() === currentText &&
      Date.now() - Number(item.at || 0) < 5000
    if (isCurrent) continue
    return item
  }
  return null
}

export function looksAddressedToPreviousSpeaker(text = "", previousMessage = null, currentUserId = "", botId = "") {
  if (!previousMessage) return false
  if (String(previousMessage.userId || "") === String(currentUserId || "")) return false
  if (botId && String(previousMessage.userId || "") === String(botId)) return false
  if (Date.now() - Number(previousMessage.at || 0) > 120000) return false
  const msg = String(text || "").trim()
  if (!msg || looksGroupAddressed(msg)) return false
  if (PREVIOUS_SPEAKER_REPLY_PATTERNS.some(pattern => pattern.test(msg))) return true
  return msg.length <= 18 && !isQuestionMessage(msg)
}

export function uniqText(values = []) {
  const result = []
  const seen = new Set()
  for (const value of values) {
    const text = String(value || "").trim()
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
  }
  return result
}

export function getMemberNames(member = {}, fallback = "") {
  return uniqText([member.card, member.nickname, fallback])
}

export function formatMemberDisplayName(member = {}, fallback = "未知用户") {
  const names = getMemberNames(member, fallback)
  if (!names.length) return fallback
  if (names.length === 1) return names[0]
  return `${names[0]}（昵称:${names.slice(1).join(" / ")}）`
}

export function extractMemberLookupTerms(text = "") {
  const cleaned = String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/@\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!/(谁|誰|哪位|哪个|哪個|资料|資料|信息|头像|頭像|群名片|昵称|暱稱|QQ|qq|头衔|頭銜|群身份|管理员|管理員)/.test(cleaned)) return []

  const terms = []
  const patterns = [
    /([A-Za-z0-9_\-.\u4e00-\u9fa5·•]{2,32})\s*(?:是)?(?:谁|誰|哪位|哪个|哪個)/g,
    /(?:谁|誰|哪位|哪个|哪個)\s*(?:是)?\s*([A-Za-z0-9_\-.\u4e00-\u9fa5·•]{2,32})/g,
    /([A-Za-z0-9_\-.\u4e00-\u9fa5·•]{2,32})\s*的?(?:资料|資料|信息|头像|頭像|群名片|昵称|暱稱|QQ|qq|头衔|頭銜|群身份)/g
  ]
  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      let term = String(match[1] || "")
        .replace(/是$/g, "")
        .replace(/[，,。.!！?？:：;；~～]+$/g, "")
        .trim()
      let previous = ""
      while (term && term !== previous) {
        previous = term
        term = term
          .replace(/^(?:这里是希洛|希洛|能不能告诉我|可不可以告诉我|能告诉我|告诉我|請問|请问|问一下|求问|你认识|你認識|你知道|你晓得|认识|認識|知道|晓得)\s*/, "")
          .replace(/^(?:帮我|给我|替我|麻烦|请|把|将|看看|看下|看一下|查看|看|查查|查下|查一下|查询|查|读取|读|获取|改改|改下|改一下|修改|改)\s*/, "")
          .replace(/^[，,。.!！?？:：;；~～\s]+/, "")
          .trim()
      }
      if (term && !["是谁", "谁是", "哪位", "哪个", "哪個"].includes(term)) terms.push(term)
    }
  }
  return uniqText(terms).slice(0, 5)
}

export function buildQqAvatarUrl(userId) {
  const qq = String(userId || "").replace(/\D/g, "")
  return qq ? `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640` : ""
}

export function matchGroupMembersByTerms(memberMap, terms = [], currentUserId = null) {
  if (!memberMap || !terms.length) return []
  const members = Array.from(memberMap.values())
  const matches = []
  for (const term of terms) {
    const needle = String(term || "").toLowerCase()
    if (!needle) continue
    const found = members
      .map(member => {
        const names = getMemberNames(member)
        const score = names.reduce((best, name) => {
          const value = String(name || "").toLowerCase()
          if (!value) return best
          if (value === needle) return Math.max(best, 3)
          if (needle.length >= 2 && value.length >= 2 && (value.includes(needle) || needle.includes(value))) {
            return Math.max(best, 2)
          }
          return best
        }, 0)
        return { member, names, score }
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)

    if (found.length) {
      matches.push({
        term,
        members: found.map(({ member, names }) => ({
          userId: member.user_id,
          role: member.role,
          title: member.title,
          names,
          avatarUrl: buildQqAvatarUrl(member.user_id),
          isCurrentSpeaker: currentUserId && String(member.user_id) === String(currentUserId)
        }))
      })
    }
  }
  return matches
}

export function formatMemberLookupPrompt(matches = []) {
  if (!matches.length) return ""
  const lines = [
    "【群成员名称匹配】",
    "用户问到的人名/昵称在当前群成员列表里有匹配。回答这类问题时优先使用这里，不要说群里没看到这个名字。",
    "只允许复述这里列出的字段：昵称/群名片、QQ、群身份、头衔、头像链接、是否当前发言者。没有明确证据时，禁止补充“他发过公告/经常管理/我见过他做某事/大家都怎样评价他”等行为经历。",
    "如果只知道他是管理员，就说“他是群里的管理员，群名片/昵称是...”，不要把管理员身份推断成发公告。"
  ]
  for (const item of matches) {
    lines.push(`- 查询: ${item.term}`)
    for (const member of item.members) {
      const role = ROLE_MAP[member.role] || member.role || "member"
      const current = member.isCurrentSpeaker ? "，当前发言者本人" : ""
      const title = member.title ? `，头衔:${member.title}` : ""
      const avatar = member.avatarUrl ? `，头像:${member.avatarUrl}` : ""
      lines.push(`  · ${member.names.join(" / ")} (QQ:${member.userId})[群身份:${role}${title}${current}${avatar}]`)
    }
  }
  return lines.join("\n")
}

export function escapeRegExp(text = "") {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function removeBotAnchors(text = "", botName = "", prefixes = []) {
  let result = String(text || "")
  const anchors = uniqText([botName, ...(Array.isArray(prefixes) ? prefixes : []), "希洛", "这里是希洛"])
  for (const anchor of anchors) {
    result = result.replace(new RegExp(escapeRegExp(anchor), "gi"), " ")
  }
  return result
}

// 意图文本拼接：args 通常就是 msg 去掉 "#tool" 前缀，普通消息时两者完全相同，
// 直接 join 会把整句话拼两遍——确定性解析(如三角洲规则兜底)会被双倍输入毒化。
export function joinIntentParts(args = "", msg = "") {
  const parts = [String(args || "").trim(), String(msg || "").trim()].filter(Boolean)
  const unique = []
  for (const part of parts) {
    if (!unique.includes(part)) unique.push(part)
  }
  return unique.join("\n")
}
