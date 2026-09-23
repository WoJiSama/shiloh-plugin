// 群教学事实抽取:从消息/艾特/文本里提取“把X叫Y”类教学指令与身份绑定。
// 从 apps/test.js 原样迁出(P2),行为不变。
import { removeBotAnchors } from "../../utils/messageContext.js"

export function hasExplicitRememberSignal(text = "") {
  return /(?:记住|记一下|记着|记得|记好|记下来|别忘|以后|下次|告诉你|你要知道)/.test(String(text || ""))
}

export function cleanTeachingAlias(value = "", botName = "", prefixes = []) {
  let text = removeBotAnchors(value, botName, prefixes)
    .replace(/@QQ:\d+|@BOT/g, " ")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/(?:帮我|你|妳)?(?:记住|记一下|记着|记得|记好|记下来|知道|认识)/g, " ")
    .replace(/(?:以后|下次)(?:说|看到|提到|有人说|别人说)?/g, " ")
    .replace(/^(?:说|叫|把|将|如果|有人|别人|群里|大家|这个|这|那个|那)+/, " ")
    .replace(/\s+/g, " ")
    .trim()

  const parts = text.split(/[\s，,。.!！?？:：;；~～]+/).filter(Boolean)
  text = parts[parts.length - 1] || text
  text = text.replace(/^(?:说|叫|把|将|这个|那个|这|那)/, "").trim()

  if (!text || text.length > 32) return ""
  if (/(?:不|没|非|并不|并非)$/.test(text)) return ""
  if (/^(?:是|就是|谁|誰|哪位|哪个|哪個|什么|啥|他|她|它|ta|TA|这个|那个|这|那|这人|那人|人|密码|公告|群公告)$/.test(text)) return ""
  return text
}

export function cleanTeachingTarget(value = "", botName = "", prefixes = []) {
  let text = String(value || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/@QQ:\d+|@BOT/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  const rememberIndex = text.search(/(?:你|妳)?(?:记住|记一下|记着|记得|知道|认识)(?:了)?(?:吗|嘛)?/)
  if (rememberIndex >= 0) text = text.slice(0, rememberIndex)

  for (const anchor of uniqText([botName, ...(Array.isArray(prefixes) ? prefixes : []), "希洛", "这里是希洛"])) {
    const index = text.indexOf(anchor)
    if (index >= 0) text = text.slice(0, index)
  }

  text = text
    .replace(/^@+/, "")
    .replace(/[，,。.!！?？:：;；~～].*$/g, "")
    .trim()

  if (!text || text.length > 64) return ""
  if (/[吗嘛么呢]$/.test(text)) return ""
  return text
}

export function findGroupMemberByName(memberMap, term = "") {
  if (!memberMap || !term) return null
  const needle = String(term || "").replace(/^@+/, "").toLowerCase().trim()
  if (!needle) return null

  let best = null
  for (const member of memberMap.values()) {
    const names = getMemberNames(member)
    const score = names.reduce((current, name) => {
      const value = String(name || "").toLowerCase()
      if (!value) return current
      if (value === needle) return Math.max(current, 3)
      if (value.includes(needle) || needle.includes(value)) return Math.max(current, 2)
      return current
    }, 0)
    if (score > (best?.score || 0)) best = { member, score }
  }
  return best?.score >= 2 ? best.member : null
}

export function buildTeachingFact({ alias, targetUserId = null, targetText = "", memberMap, rememberRequested = false, source = "text" } = {}) {
  const cleanAlias = String(alias || "").trim()
  if (!cleanAlias) return null

  if (targetUserId) {
    const member = memberMap?.get?.(Number(targetUserId))
    const targetDisplay = member ? formatMemberDisplayName(member, `用户${targetUserId}`) : `用户${targetUserId}`
    return {
      alias: cleanAlias,
      targetUserId: String(targetUserId),
      targetDisplay,
      targetNames: getMemberNames(member || {}, `用户${targetUserId}`),
      rememberRequested,
      source
    }
  }

  const matchedMember = findGroupMemberByName(memberMap, targetText)
  if (matchedMember?.user_id) {
    return buildTeachingFact({
      alias: cleanAlias,
      targetUserId: matchedMember.user_id,
      memberMap,
      rememberRequested,
      source
    })
  }

  const cleanTarget = String(targetText || "").trim()
  if (!cleanTarget) return null
  return {
    alias: cleanAlias,
    targetUserId: null,
    targetDisplay: cleanTarget,
    targetNames: [cleanTarget],
    rememberRequested,
    source
  }
}

export function extractMentionTeachingFacts(messageSegments = [], memberMap, options = {}) {
  if (!Array.isArray(messageSegments) || !messageSegments.length) return []
  const botId = String(options.botId || "")
  let annotated = ""
  for (const segment of messageSegments) {
    if (segment?.type === "text") {
      annotated += segment.text || segment.data?.text || ""
      continue
    }
    if (segment?.type === "at") {
      const qq = String(getMentionTargetId(segment) || "")
      annotated += qq && qq !== botId ? ` @QQ:${qq} ` : " ， "
    }
  }

  const rememberRequested = hasExplicitRememberSignal(`${annotated} ${options.text || ""}`)
  const facts = []
  const relationPattern = /(?:^|[\s，,。.!！?？:：;；~～])([^@，,。.!！?？:：;；\n\r]{1,48}?)\s*(?:就?是|叫|指的是|代表|等于|=)\s*@QQ:(\d+)/g
  for (const match of annotated.matchAll(relationPattern)) {
    const alias = cleanTeachingAlias(match[1], options.botName, options.prefixes)
    const targetUserId = match[2]
    const fact = buildTeachingFact({
      alias,
      targetUserId,
      memberMap,
      rememberRequested,
      source: "mention"
    })
    if (fact) facts.push(fact)
  }
  return facts
}

export function extractTextTeachingFacts(text = "", memberMap, options = {}) {
  const raw = String(text || "")
  if (!raw || !hasExplicitRememberSignal(raw)) return []

  const cleaned = replaceCqMentions(raw, userId => ` @QQ:${userId} `)
    .replace(/\s+/g, " ")
    .trim()

  const facts = []
  const patterns = [
    /(?:记住|记一下|记着|记得|记好|记下来|告诉你|你要知道)[，,\s]*(.{1,48}?)(?:就?是|叫|指的是|代表|等于|=)\s*(@QQ:(\d+)|.{1,80})/g,
    /(.{1,48}?)(?:就?是|叫|指的是|代表|等于|=)\s*(@QQ:(\d+)|.{1,80}?)(?:[，,。.!！?？\s]*(?:你|妳)?(?:记住|记一下|记着|记得|知道))/g
  ]

  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const alias = cleanTeachingAlias(match[1], options.botName, options.prefixes)
      const targetUserId = match[3] || null
      const targetText = targetUserId
        ? ""
        : cleanTeachingTarget(match[2], options.botName, options.prefixes)
      const fact = buildTeachingFact({
        alias,
        targetUserId,
        targetText,
        memberMap,
        rememberRequested: true,
        source: "text"
      })
      if (fact) facts.push(fact)
    }
  }
  return facts
}

export function extractExplicitTeachingFacts(messageSegments = [], memberMap, options = {}) {
  const facts = [
    ...extractMentionTeachingFacts(messageSegments, memberMap, options),
    ...extractTextTeachingFacts(options.text || "", memberMap, options)
  ]

  const result = []
  const seen = new Set()
  for (const fact of facts) {
    const key = `${fact.alias.toLowerCase()}::${fact.targetUserId || fact.targetDisplay.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(fact)
  }
  return result.slice(0, 5)
}

export function formatExplicitTeachingMemoryContent(fact) {
  if (!fact) return ""
  const target = fact.targetUserId
    ? `${fact.targetDisplay} (QQ:${fact.targetUserId})`
    : fact.targetDisplay
  return `群内称呼映射：${fact.alias} = ${target}`
}

export function formatExplicitTeachingPrompt(facts = []) {
  if (!facts.length) return ""
  const lines = [
    "【当前消息显式教学 - 最高优先级】",
    "当前用户正在纠正或教你群内称呼/外号映射。这里的内容优先级高于群公告、旧聊天记录、旧回答、知识库和长期记忆；如果冲突，以这里为准。",
    "回复时直接承认并确认这些映射，不要把同名词从群公告或旧回答里重新解释成别的东西。"
  ]
  for (const fact of facts) {
    lines.push(`- ${formatExplicitTeachingMemoryContent(fact)}`)
  }
  if (facts.some(fact => fact.rememberRequested)) {
    lines.push("- 用户问“记住了吗”时，应回答已经记住/记下这个映射。")
  }
  return lines.join("\n")
}

export function normalizeIdentityBindings(bindings = []) {
  const source = Array.isArray(bindings)
    ? bindings
    : bindings && typeof bindings === "object"
      ? Object.entries(bindings).map(([qq, value]) => ({ qq, ...(value || {}) }))
      : []

  const result = []
  for (const item of source) {
    if (!item || typeof item !== "object") continue
    const qq = String(item.qq || item.userId || item.user_id || "").trim()
    const name = String(item.name || item.nickname || item.displayName || "").trim()
    if (!qq || !name) continue
    result.push({
      qq,
      name,
      aliases: uniqText(Array.isArray(item.aliases) ? item.aliases : [item.alias, item.title]),
      relationToBot: String(item.relationToBot || item.relationship || item.relation || "").trim(),
      notes: uniqText(Array.isArray(item.notes) ? item.notes : [item.note]),
      style: String(item.style || "").trim()
    })
  }
  return result
}

export function formatIdentityBindingsPrompt(bindings = [], currentUserId = "") {
  const normalized = normalizeIdentityBindings(bindings)
  if (!normalized.length) return ""

  const current = normalized.find(item => item.qq === String(currentUserId || ""))
  const lines = [
    "【固定身份关系】",
    "以下身份绑定来自配置，优先级高于群名片、昵称、旧聊天记录和临时猜测。涉及这些 QQ 时必须按绑定理解。"
  ]

  if (current) {
    const aliases = current.aliases.length ? `；别称/身份：${current.aliases.join(" / ")}` : ""
    const relation = current.relationToBot ? `；和你的关系：${current.relationToBot}` : ""
    const notes = current.notes.length ? `；备注：${current.notes.join("；")}` : ""
    const style = current.style ? `；相处方式：${current.style}` : ""
    const identityTerms = uniqText([current.name, ...current.aliases])
    const identityTermsText = identityTerms.length ? `或提到“${identityTerms.join("”“")}”相关内容` : ""
    lines.push(`- 当前发言者 QQ:${current.qq} 就是 ${current.name}${aliases}${relation}${notes}${style}`)
    lines.push(`- 当前发言者说“我”${identityTermsText}时，按“${current.name}本人正在和你说话”理解，不要当成普通群友。`)
  }

  const others = normalized.filter(item => item.qq !== String(currentUserId || ""))
  if (others.length) {
    lines.push("- 已知重要成员：")
    for (const item of others.slice(0, 8)) {
      const aliases = item.aliases.length ? `（${item.aliases.join(" / ")}）` : ""
      const relation = item.relationToBot ? `，${item.relationToBot}` : ""
      lines.push(`  · ${item.name}${aliases}: QQ:${item.qq}${relation}`)
    }
  }

  return lines.join("\n")
}


let sharedConfigStore = null
let pluginInitialized = false
let sharedState = null
let mcpInitPromise = null
