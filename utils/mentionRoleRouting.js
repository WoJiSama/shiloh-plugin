function normalizeText(text = "") {
  return String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

const MENTION_ACTION_RE = /(?:艾特|@|通知|喊(?:一下|人)?|叫(?:一下|人)?)/u
const ADMIN_COLLECTION_RE = /(?:所有|全部|全体).{0,8}(?:管理员|管理|群管)|(?:管理员|管理|群管)(?:们|全体)|(?:管理们|群管们)|(?:除了?|除去).{0,40}(?:管理员|管理|群管)/u
const OWNER_WITH_OTHER_ROLES_RE = /群主\s*(?:和|、|，|,|及|以及|还有|与)\s*(?:管理员|管理|群管)|(?:管理员|管理|群管).{0,12}群主/u

// mentionAdminsTool has collection semantics. Keep that contract explicit so a
// singular role name can never expand into a group-wide mention.
export function isExplicitAdminCollectionMentionRequest(text = "") {
  const content = normalizeText(text)
  return MENTION_ACTION_RE.test(content) && ADMIN_COLLECTION_RE.test(content)
}

export function isSingularOwnerMentionRequest(text = "") {
  const content = normalizeText(text)
  return Boolean(
    content &&
    MENTION_ACTION_RE.test(content) &&
    /群主/u.test(content) &&
    !ADMIN_COLLECTION_RE.test(content) &&
    !OWNER_WITH_OTHER_ROLES_RE.test(content)
  )
}

export function extractRoleMentionMessage(text = "", role = "群主") {
  const content = normalizeText(text)
  if (!content) return ""

  const explicitMessage = content.match(/(?:告诉(?:他|她|群主)?|跟(?:他|她|群主)说|说(?:一下|一声)?|通知(?:他|她|群主)?)(?:\s*[，,:：]\s*|\s+)([\s\S]+)$/u)
  if (explicitMessage?.[1]) return explicitMessage[1].trim()

  const roleAt = content.lastIndexOf(role)
  if (roleAt < 0) return ""
  return content.slice(roleAt + role.length)
    .replace(/^[\s，,:：]*(?:(?:告诉|通知)(?:他|她)?|跟(?:他|她)说|说(?:一下|一声)?)?[\s，,:：]*/u, "")
    .trim()
}

export function resolveSingularOwnerMention(text = "", memberMap) {
  if (!isSingularOwnerMentionRequest(text)) return null
  const members = memberMap instanceof Map
    ? Array.from(memberMap.values())
    : Array.isArray(memberMap) ? memberMap : []
  const owners = members.filter(member => String(member?.role || "").toLowerCase() === "owner" && member?.user_id != null)
  if (owners.length !== 1) return null

  return {
    targetUserId: String(owners[0].user_id),
    message: extractRoleMentionMessage(text, "群主")
  }
}
