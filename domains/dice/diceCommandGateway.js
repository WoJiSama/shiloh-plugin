import { getMentionTargetId } from "../../utils/mentionTargets.js"

function isGroupManagerRole(role = "") {
  return ["owner", "admin"].includes(String(role || "").toLowerCase())
}

function normalizeUserId(value) {
  const text = String(value ?? "").trim()
  return /^\d+$/.test(text) ? text : ""
}

/**
 * A command plugin receives only the normalized text in some adapters, so an
 * initial @ other member can otherwise be lost before the command regex runs.
 * Only leading mentions suppress command handling: `.st @member` remains a
 * valid dice command that targets a member.
 */
export function startsWithMentionOfOtherMember(e = {}) {
  const botId = normalizeUserId(e?.bot?.uin || globalThis.Bot?.uin)
  const isOtherMember = value => {
    const userId = normalizeUserId(value)
    return Boolean(userId && userId !== botId)
  }

  if (Array.isArray(e?.message)) {
    for (const segment of e.message) {
      if (segment?.type === "at") return isOtherMember(getMentionTargetId(segment))
      if (segment?.type === "text" && String(segment?.text ?? segment?.data?.text ?? "").trim()) return false
      if (segment?.type && segment.type !== "reply") return false
    }
  }

  const raw = String(e?.raw_message || e?.msg || "")
  const leadingMention = raw.match(/^\s*\[CQ:at,[^\]]*(?:qq|user_id|id|uin)=(\d+)(?:,|\])/i)
  return Boolean(leadingMention && isOtherMember(leadingMention[1]))
}

export function canManageGroupDice(e = {}) {
  return Boolean(e?.isMaster || isGroupManagerRole(e?.sender?.role))
}

export function sanitizeDiceCommandError(error) {
  const raw = String(error?.message || error || "未知错误")
    .replace(/(?:file:\/\/)?(?:\/[\w.@%+~#=-]+){2,}/g, "本地文件")
    .replace(/[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s]+/g, "本地文件")
    .replace(/\s+/g, " ")
    .trim()
  return raw.slice(0, 240) || "未知错误"
}

export function getDiceCommandGate({ manager, e, commandName = "" } = {}) {
  if (startsWithMentionOfOtherMember(e)) {
    return { allowed: false, consume: false, response: "" }
  }
  const config = manager?.getConfig?.() || {}
  if (config.enabled === false) {
    return { allowed: false, consume: true, response: "骰娘模块现在没开。" }
  }
  if (commandName !== "replyControl" && manager?.isReplyEnabled?.(e, config) === false) {
    return { allowed: false, consume: true, response: "" }
  }
  return { allowed: true, consume: true, response: "" }
}

export function getCustomDiceCommandGate({ manager, ruleManager, e } = {}) {
  if (startsWithMentionOfOtherMember(e)) {
    return { matched: false, allowed: false, consume: false, response: "" }
  }
  const groupId = e?.group_id || "private"
  const invocation = ruleManager?.findInvocation?.(groupId, e?.msg) || null
  // 海豹扩展命令是顶级命令(.dd/.cook)，findInvocation 只认「包名 命令」两段式，会漏掉它们
  const sealCommandMatched = invocation ? false : (ruleManager?.matchesSealExtCommand?.(groupId, e?.msg) === true)
  if (!invocation && !sealCommandMatched) return { matched: false, allowed: false, consume: false, response: "" }
  const config = manager?.getConfig?.() || {}
  if (config.enabled === false) {
    return { matched: true, allowed: false, consume: true, response: "骰娘模块现在没开。" }
  }
  if (config.customRulesEnabled === false) {
    return { matched: true, allowed: false, consume: true, response: "自定义骰娘规则包当前没有启用。" }
  }
  if (manager?.isReplyEnabled?.(e, config) === false) {
    return { matched: true, allowed: false, consume: true, response: "" }
  }
  return { matched: true, allowed: true, consume: true, response: "", invocation }
}

export async function executeDiceCommand({ manager, e, commandName, work, reply, logger } = {}) {
  const gate = getDiceCommandGate({ manager, e, commandName })
  if (!gate.allowed) {
    if (gate.response && typeof reply === "function") await reply(gate.response)
    return gate.consume
  }
  try {
    return await work()
  } catch (error) {
    const detail = sanitizeDiceCommandError(error)
    logger?.error?.(`[骰娘] 命令 ${commandName || "unknown"} 执行失败: ${detail}`)
    if (typeof reply === "function") {
      await reply(`这条骰娘命令没能执行：${detail}\n请检查命令格式后再试；数据不会按成功处理。`)
    }
    return true
  }
}
