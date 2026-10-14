import type {MentionEvent,ChatIdentity} from "../../../contracts/chatEvent.js"
function record(v:unknown):Record<string,unknown> {return v && typeof v === "object" ? v as Record<string,unknown>: {}}
function normalizeUserId(value:unknown) {
  if (value && typeof value === "object") return ""
  const userId = String(value ?? "").trim()
  if (!userId || userId.toLowerCase() === "all") return ""
  return /^\d+$/.test(userId) ? userId : ""
}

export function getMentionTargetId(input:unknown = {}) {
  const segment=record(input), data=record(segment.data)
  return segment.qq ?? segment.user_id ?? segment.id ?? segment.uin ?? segment.uid ??
    data.qq ?? data.user_id ?? data.id ?? data.uin ?? data.uid
}

export function collectMentionTargetIds(event:MentionEvent = {}, excludedUserId:ChatIdentity = "") {
  const targets:string[] = []
  const seen = new Set()
  const excluded = normalizeUserId(excludedUserId)
  const addTarget = (value:unknown) => {
    const userId = normalizeUserId(value)
    if (!userId || userId === excluded || seen.has(userId)) return
    seen.add(userId)
    targets.push(userId)
  }

  const eventTargets = [event?.at, event?.at_user].flatMap(value => Array.isArray(value) ? value : [value])
  for (const target of eventTargets) addTarget(typeof target === "object" ? getMentionTargetId(target) : target)

  for (const segment of Array.isArray(event?.message) ? event.message : []) {
    if (segment.type === "at") addTarget(getMentionTargetId(segment))
  }

  const raw = String(event?.msg || "")
  for (const match of raw.matchAll(/\[CQ:at,[^\]]*(?:qq|user_id|id|uin)=(\d+)(?:,|\])/g)) {
    addTarget(match[1])
  }

  return targets
}

export function messageMentionsUser(event:MentionEvent = {}, userId:ChatIdentity = "") {
  const targetUserId = normalizeUserId(userId)
  if (!targetUserId) return false

  const botId = normalizeUserId(event?.bot?.uin || event.self_id)
  if (targetUserId === botId && (event?.atBot || event?.atme || event?.atMe || event?.isAt)) return true
  return collectMentionTargetIds(event).includes(targetUserId)
}

export function replaceCqMentions(text = "", replacer = (userId:string) => `@${userId}`) {
  return String(text || "").replace(
    /\[CQ:at,[^\]]*(?:qq|user_id|id|uin)=(\d+)[^\]]*\]/g,
    (_, userId) => replacer(String(userId))
  )
}

export function stripCqMentions(text = "") {
  return replaceCqMentions(text, () => " ").replace(/\s+/g, " ").trim()
}
