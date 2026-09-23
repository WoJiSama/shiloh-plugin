// 头像检查/头像生图引用的解析:从文本与艾特里定位目标成员与参考图。
// 从 apps/test.js 原样迁出(P2),行为不变。
import { removeBotAnchors } from "../../utils/messageContext.js"
import { isImageGenerationRequest } from "../../core/intent/messageIntent.js"
import { normalizeForContainment, getReplyTargetUserId } from "./messageSegments.js"

export function extractAvatarLookupTerms(text = "", botName = "", prefixes = []) {
  const cleaned = removeBotAnchors(text, botName, prefixes)
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/@\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!cleaned.includes("头像")) return []

  const terms = []
  const patterns = [
    /([A-Za-z0-9_\-.\u4e00-\u9fa5·•]{2,32})\s*的?头像/g,
    /(?:看|看看|看下|看一下|帮.*看|分析|识别|描述|评价|点评|说说|讲讲)\s*([A-Za-z0-9_\-.\u4e00-\u9fa5·•]{2,32})\s*的?头像/g
  ]
  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const term = String(match[1] || "")
        .replace(/^(?:我|你|他|她|它|ta|TA|这个|那个|这人|那人|对方|大家|群友)$/, "")
        .replace(/^(?:帮我|给我|替我|可以|能不能|能|想要|要|希洛|看看|看下|看一下|分析|识别|描述|评价|点评|说说|讲讲)+/, "")
        .replace(/[，,。.!！?？:：;；~～]+$/g, "")
        .trim()
      if (term) terms.push(term)
    }
  }
  return uniqText(terms).slice(0, 5)
}

export function resolveAvatarInspectionTargets({ e = {}, text = "", atQq = [], memberMap = null, reply = null, botName = "", prefixes = [] } = {}) {
  if (!isAvatarInspectionRequest(text)) return null

  const targets = []
  const addTarget = (userId, label = "") => {
    const qq = String(userId || "").replace(/\D/g, "")
    if (!qq || String(qq) === String(Bot.uin)) return
    if (targets.some(item => item.userId === qq)) return
    const member = memberMap?.get?.(Number(qq))
    targets.push({
      userId: qq,
      label: label || (member ? formatMemberDisplayName(member, `用户${qq}`) : `用户${qq}`),
      image: buildQqAvatarUrl(qq)
    })
  }

  for (const qq of atQq || []) addTarget(qq)

  const content = normalizeIntentText(text)
  const replyTarget = getReplyTargetUserId(reply)
  if (replyTarget && /(?:他|她|ta|TA|这个|那个|这人|那人|对方|回复|引用).{0,12}头像|头像.{0,12}(?:他|她|ta|TA|这个|那个|这人|那人|对方)/.test(content)) {
    addTarget(replyTarget, reply?.sender?.card || reply?.sender?.nickname || "")
  }

  const terms = extractAvatarLookupTerms(text, botName, prefixes)
  const memberMatches = matchGroupMembersByTerms(memberMap, terms, e?.user_id)
  for (const item of memberMatches) {
    if (item.members?.length === 1) addTarget(item.members[0].userId, item.members[0].names?.[0] || "")
  }

  if (!targets.length && /(?:我|自己|本人|咱|俺).{0,8}头像|头像.{0,8}(?:我|自己|本人|咱|俺)|^(?:.*?)(?:看|看看|看下|看一下|分析|评价|点评|描述)(?:一下)?头像/.test(content)) {
    addTarget(e?.user_id, e?.sender?.card || e?.sender?.nickname || "")
  }

  if (!targets.length) return null
  const names = targets.map(item => `${item.label}(QQ:${item.userId})`).join("、")
  return {
    images: targets.map(item => item.image).filter(Boolean),
    prompt: `${text || "看一下头像"}\n目标头像：${names}。请基于头像本身做简洁自然的描述，不要假装知道头像背后的真实身份或经历。`
  }
}

export function findUniqueGroupMemberMention(memberMap, text = "", currentUserId = null) {
  if (!memberMap) return null
  const content = normalizeForContainment(text)
  if (!content) return null

  const candidates = []
  for (const member of memberMap.values()) {
    if (!member?.user_id) continue
    const names = getMemberNames(member).filter(Boolean)
    let score = 0
    for (const name of names) {
      const normalizedName = normalizeForContainment(name)
      if (!normalizedName || normalizedName.length < 2) continue
      if (content.includes(normalizedName)) {
        score = Math.max(score, normalizedName.length)
      }
    }
    const qq = String(member.user_id)
    if (qq.length >= 5 && content.includes(qq)) score = Math.max(score, qq.length)
    if (score > 0) {
      candidates.push({
        member,
        names,
        score,
        isCurrentSpeaker: currentUserId && String(member.user_id) === String(currentUserId)
      })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  if (!candidates.length) return null
  if (candidates[1] && candidates[1].score === candidates[0].score) return null
  return candidates[0]
}

export function resolveAvatarDrawReference({ e = {}, text = "", atQq = [], memberMap = null, reply = null, botName = "", prefixes = [] } = {}) {
  const content = normalizeIntentText(text)
  if (!isImageGenerationRequest(content)) return null

  const targets = []
  const addTarget = (userId, label = "") => {
    const qq = String(userId || "").replace(/\D/g, "")
    if (!qq || String(qq) === String(Bot.uin)) return
    if (targets.some(item => item.userId === qq)) return
    const member = memberMap?.get?.(Number(qq))
    targets.push({
      userId: qq,
      label: label || (member ? formatMemberDisplayName(member, `用户${qq}`) : `用户${qq}`),
      image: buildQqAvatarUrl(qq)
    })
  }

  const shouldUseAtTargets = (atQq || []).length > 0 &&
    /(?:画|绘制|生成|做|捏).{0,40}(?:@|他|她|ta|TA|这个人|那个人|这人|头像|人像|立绘|角色|本人)|(?:把|将).{0,24}(?:@|他|她|ta|TA|这个人|那个人|这人).{0,40}(?:画|绘制|生成|做|捏)/.test(content)
  if (shouldUseAtTargets) {
    for (const qq of atQq || []) addTarget(qq)
  }

  const replyTarget = getReplyTargetUserId(reply)
  if (replyTarget && /(?:画|绘制|生成|做|捏).{0,24}(?:他|她|ta|TA|这个人|那个人|这人|对方|回复|引用)|(?:把|将).{0,12}(?:他|她|ta|TA|这个人|那个人|这人|对方).{0,24}(?:画|绘制|生成|做|捏)/.test(content)) {
    addTarget(replyTarget, reply?.sender?.card || reply?.sender?.nickname || "")
  }

  if (!targets.length && /(?:画|绘制|生成|做|捏).{0,20}(?:我|自己|本人|咱|俺)|(?:把|将).{0,8}(?:我|自己|本人|咱|俺).{0,24}(?:画|绘制|生成|做|捏)/.test(content)) {
    addTarget(e?.user_id, e?.sender?.card || e?.sender?.nickname || "")
  }

  if (!targets.length) {
    const cleaned = removeBotAnchors(text, botName, prefixes)
      .replace(/\[CQ:[^\]]+\]/g, " ")
      .replace(/@\S+/g, " ")
    const candidate = findUniqueGroupMemberMention(memberMap, cleaned, e?.user_id)
    if (candidate?.member?.user_id) {
      // "蔚蓝档案里面的小鸟游星野"这类作品角色请求不能挂同昵称群友的真人头像：
      // 既指认错了人，也会触发上游"真人改造"内容审核
      if (shouldSkipNicknameAvatarReference(cleaned, candidate.names?.[0] || "")) {
        logger.info(`[头像参考] 命中作品角色/长名片段，跳过昵称匹配群友=${candidate.names?.[0] || ""}`)
      } else {
        addTarget(candidate.member.user_id, candidate.names?.[0] || "")
      }
    }
  }

  if (!targets.length) return null
  const names = targets.map(item => `${item.label}(QQ:${item.userId})`).join("、")
  return {
    images: targets.map(item => item.image).filter(Boolean),
    targets,
    promptHint: `群友头像参考：${names}。用户想画群里的这个/这些人，请把所附 QQ 头像作为外观参考，保留头像中能看见的发型、脸部观感、服饰/配色和整体气质；不要编造头像背后的真实身份或经历。`
  }
}

export function formatAvatarDrawReferencePrompt(reference = null) {
  if (!reference?.images?.length) return ""
  return reference.promptHint || ""
}
