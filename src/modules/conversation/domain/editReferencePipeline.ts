interface ReferenceMember {card?:string;nickname?:string;name?:string;user_id?:unknown;qq?:unknown;uin?:unknown}
export interface EditReferenceContext {text?:string;botId?:unknown;memberMap?:ReadonlyMap<string|number,ReferenceMember>|null|undefined;atQq?:unknown[]|undefined;replyTargetUserId?:unknown;replyTargetLabel?:string}
export interface EditReferenceAsset {id?:string;role:string;kind?:string;source:string;label?:string;position?:number;target?:{userId:string;label:string}}
type Resolver=(context:EditReferenceContext)=>EditReferenceAsset[]
function normalizeText(text = "") {
  return String(text || "")
    .replace(/\[CQ:at,[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function normalizeForMatch(text = "") {
  return normalizeText(text)
    .replace(/[^\p{L}\p{N}\u4e00-\u9fa5]+/gu, "")
    .toLowerCase()
}

function memberNames(member:ReferenceMember = {}) {
  return [member.card, member.nickname, member.name]
    .map(value => String(value || "").trim())
    .filter(Boolean)
}

function memberUserId(member:ReferenceMember = {}) {
  return String(member.user_id || member.qq || member.uin || "").replace(/\D/g, "")
}

export function buildQqAvatarUrl(userId:unknown) {
  const qq = String(userId || "").replace(/\D/g, "")
  return qq ? `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640` : ""
}

function isAppearanceReplacementRequest(text = "") {
  const content = normalizeText(text)
  if (!content) return false
  const subject = "(?:头像|脸|面部|头部|脑袋|头|外貌|长相|形象)"
  const operation = "(?:换成|替换成|改成|换上|替换|换掉|换脸|换头|贴上|贴成|套用|使用|参考)"
  return new RegExp(`${operation}.{0,28}${subject}|${subject}.{0,28}${operation}`).test(content)
}

function isAppearanceGuidedEditRequest(text = "") {
  const content = normalizeText(text)
  if (!content || !/(头像|脸|面部|头部|外貌|长相|形象|样子|五官)/.test(content)) return false
  const editAction = /(?:取消掉|去掉|去除|删掉|删除|移除|擦掉|修掉|改掉|修改|调整|修一下|改一下|修得|改得|融合|贴合|换成|替换|换头|换脸)/
  return editAction.test(content)
}

function normalizeTextWithMentionMarker(text = "") {
  return String(text || "")
    .replace(/\[CQ:at,[^\]]+\]/g, "@")
    .replace(/\s+/g, " ")
    .trim()
}

function escapeRegExp(text = "") {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function buildMemberReferencePattern(member:ReferenceMember = {}, userId = "") {
  const names = memberNames(member)
    .map(name => normalizeText(name))
    .filter(name => name.length >= 2)
    .map(escapeRegExp)
  const qq = String(userId || memberUserId(member) || "").replace(/\D/g, "")
  const parts = [...names]
  if (qq.length >= 5) parts.push(escapeRegExp(qq))
  return parts.length ? `(?:${parts.join("|")})` : ""
}

function hasAvatarObjectEditActionAfter(referencePattern = "", text = "") {
  if (!referencePattern) return false
  const content = normalizeTextWithMentionMarker(text)
  const action = "(?:换成|替换成|改成|改为|变成|变为|弄成|修成|换掉|改掉|修改成|调整成|改得|变得)"
  return new RegExp(`${referencePattern}.{0,6}(?:的)?头像.{0,24}${action}`, "i").test(content)
}

function hasMentionAvatarObjectEditAction(text = "") {
  const content = normalizeTextWithMentionMarker(text)
  const action = "(?:换成|替换成|改成|改为|变成|变为|弄成|修成|换掉|改掉|修改成|调整成|改得|变得)"
  return new RegExp(`(?:@|他|她|ta|TA|这个人|那个人|对方|群友).{0,8}(?:的)?头像.{0,24}${action}`, "i").test(content)
}

function findUniqueMember(memberMap:EditReferenceContext["memberMap"], text = "") {
  if (!memberMap?.values) return null
  const content = normalizeForMatch(text)
  if (!content) return null

  const candidates = []
  for (const member of memberMap.values()) {
    const userId = memberUserId(member)
    if (!userId) continue
    let score = userId.length >= 5 && content.includes(userId) ? userId.length : 0
    const names = memberNames(member)
    for (const name of names) {
      const normalizedName = normalizeForMatch(name)
      if (normalizedName.length >= 2 && content.includes(normalizedName)) score = Math.max(score, normalizedName.length)
    }
    if (score > 0) candidates.push({ member, userId, names, score })
  }

  candidates.sort((left, right) => right.score - left.score)
  if (!candidates.length || candidates[1]?.score === candidates[0]!.score) return null
  return candidates[0]
}

function resolveGroupMemberAppearanceReferences(context:EditReferenceContext = {}) {
  if (!isAppearanceReplacementRequest(context.text) && !isAppearanceGuidedEditRequest(context.text)) return []

  const targets:{userId:string;label:string;image?:string}[] = []
  const addTarget = (userId:unknown) => {
    const qq = String(userId || "").replace(/\D/g, "")
    if (!qq || qq === String(context.botId || "") || targets.some(item => item.userId === qq)) return
    const member = context.memberMap?.get?.(Number(qq)) || context.memberMap?.get?.(qq)
    targets.push({ userId: qq, label: memberNames(member)[0] || `用户${qq}` })
  }

  const namedCandidate = findUniqueMember(context.memberMap, context.text)
  if (namedCandidate) addTarget(namedCandidate.userId)

  const content = normalizeText(context.text)
  const mentionIsExplicitReference = /(?:换成|替换成|改成|参考|按照|照着|用).{0,16}@|@.{0,16}(?:头像|脸|头|外貌|样子|形象)|(?:他|她|ta|TA|对方|这个人|那个人).{0,8}(?:头像|脸|头|外貌|样子|形象)/.test(content)
  if (!targets.length && mentionIsExplicitReference) {
    for (const userId of context.atQq || []) addTarget(userId)
    if (!targets.length && context.replyTargetUserId) addTarget(context.replyTargetUserId)
  }

  return targets.map(target => ({
    id: `qq-avatar:${target.userId}`,
    role: "appearance_reference",
    kind: "group_member_avatar",
    source: buildQqAvatarUrl(target.userId),
    label: `${target.label}(QQ:${target.userId})`,
    target
  }))
}

export const defaultEditReferenceResolvers: Resolver[] = [resolveGroupMemberAppearanceReferences]

export function resolveAvatarEditBase(context:EditReferenceContext = {}) {
  const targets:{userId:string;label:string;image?:string}[] = []
  const addTarget = (userId:unknown, label = "") => {
    const qq = String(userId || "").replace(/\D/g, "")
    if (!qq || qq === String(context.botId || "") || targets.some(item => item.userId === qq)) return
    const member = context.memberMap?.get?.(Number(qq)) || context.memberMap?.get?.(qq)
    targets.push({
      userId: qq,
      label: label || memberNames(member)[0] || `用户${qq}`,
      image: buildQqAvatarUrl(qq)
    })
  }

  const namedCandidate = findUniqueMember(context.memberMap, context.text)
  if (namedCandidate) {
    const referencePattern = buildMemberReferencePattern(namedCandidate.member, namedCandidate.userId)
    if (hasAvatarObjectEditActionAfter(referencePattern, context.text)) {
      addTarget(namedCandidate.userId, namedCandidate.names?.[0] || "")
    }
  }

  if (!targets.length && (context.atQq || []).length === 1 && hasMentionAvatarObjectEditAction(context.text)) {
    addTarget(context.atQq?.[0])
  }

  if (!targets.length && context.replyTargetUserId && hasMentionAvatarObjectEditAction(context.text)) {
    addTarget(context.replyTargetUserId, context.replyTargetLabel || "")
  }

  if (!targets.length) return null
  const names = targets.map(item => `${item.label}(QQ:${item.userId})`).join("、")
  const manifest = buildEditAssetManifest(targets.map(item => item.image || ""), [])
  return {
    targets,
    manifest,
    images: getEditManifestImages(manifest),
    promptHint: [
      `头像编辑底图：${names}。`,
      "第1张开始的 edit_base 是用户点名要修改的群友 QQ 头像；请直接编辑这些头像本身，不要把它们当成额外参考图。",
      "只按用户要求改变头像中的外观/风格，不要编造头像背后的真实身份或经历。"
    ].join("")
  }
}

export function resolveEditReferenceAssets(context:EditReferenceContext = {}, resolvers:Resolver[] = defaultEditReferenceResolvers) {
  const assets:EditReferenceAsset[] = []
  const seen = new Set()
  for (const resolver of resolvers) {
    for (const asset of resolver(context) || []) {
      const key = asset.id || `${asset.role}:${asset.source}`
      if (!asset.source || seen.has(key)) continue
      seen.add(key)
      assets.push(asset)
    }
  }
  return assets
}

export function buildEditAssetManifest(baseImages:string[] = [], references:EditReferenceAsset[] = []) {
  const assets:EditReferenceAsset[] = []
  const seenSources = new Set()
  const append = (asset:EditReferenceAsset) => {
    const source = String(asset?.source || "").trim()
    if (!source || seenSources.has(source)) return
    seenSources.add(source)
    assets.push({ ...asset, source, position: assets.length + 1 })
  }

  for (const [index, source] of (Array.isArray(baseImages) ? baseImages : []).entries()) {
    append({ id: `base:${index}`, role: "edit_base", kind: "user_image", source, label: index === 0 ? "主要编辑原图" : `附加原图${index + 1}` })
  }
  for (const reference of references || []) append(reference)
  return assets
}

export function getEditManifestImages(manifest:EditReferenceAsset[] = []) {
  return manifest.map(asset => asset.source).filter(Boolean)
}

export function formatEditAssetManifestPrompt(manifest:EditReferenceAsset[] = []) {
  const references = manifest.filter(asset => asset.role !== "edit_base")
  if (!references.length) return ""
  const lines = manifest.map(asset => {
    const role = asset.role === "edit_base" ? "待编辑原图" : "参考素材"
    return `第${asset.position}张：${role}；用途=${asset.role}；内容=${asset.label || asset.kind || "未命名素材"}`
  })
  return [
    "图片素材清单（位置和用途必须严格遵守）：",
    ...lines,
    "只编辑标记为 edit_base 的图片；其他图片仅用于对应角色的视觉参考，不得把参考图整体当作输出主体。未被用户要求修改的主体、姿势、构图、服装和背景应保持不变。"
  ].join("\n")
}

export function prepareImageEditAssets({ baseImages = [], ...context }:EditReferenceContext & {baseImages?:string[]} = {}, resolvers:Resolver[] = defaultEditReferenceResolvers) {
  const references = resolveEditReferenceAssets(context, resolvers)
  const manifest = buildEditAssetManifest(baseImages, references)
  return {
    references,
    manifest,
    images: getEditManifestImages(manifest),
    promptHint: formatEditAssetManifestPrompt(manifest)
  }
}
