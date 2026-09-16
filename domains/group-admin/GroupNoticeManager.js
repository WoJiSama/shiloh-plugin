import { readUserSettings } from "../../utils/configWriter.js"

const DEFAULT_GROUP_NOTICE_CONFIG = {
  enabled: false,
  enabledGroups: [],
  groupRules: [],
  welcomeEnabled: true,
  leaveEnabled: true,
  suppressWelcomeWhenGroupGuardEnabled: true,
  welcomeMessage: "{at} 欢迎入群",
  leaveMessage: "用户 {userId} 退出了群聊"
}

function normalizeConfig(raw = {}) {
  const config = { ...DEFAULT_GROUP_NOTICE_CONFIG, ...(raw || {}) }
  config.enabledGroups = Array.isArray(config.enabledGroups)
    ? config.enabledGroups.map(id => String(id).trim()).filter(Boolean)
    : []
  config.groupRules = Array.isArray(config.groupRules)
    ? config.groupRules
      .map(rule => ({
        ...rule,
        groupId: String(rule?.groupId || "").trim()
      }))
      .filter(rule => rule.groupId)
    : []
  return config
}

function renderTemplate(template, data) {
  return String(template || "").replace(/\{(\w+)}/g, (_, key) => {
    return data[key] === undefined || data[key] === null ? "" : String(data[key])
  })
}

function buildAtSegment(userId) {
  if (globalThis.segment?.at) return globalThis.segment.at(userId)
  return { type: "at", qq: userId }
}

class GroupNoticeManager {
  getConfig() {
    return normalizeConfig(readUserSettings().groupNotice)
  }

  getGroupGuardConfig() {
    const raw = readUserSettings().groupGuard || {}
    return {
      enabled: Boolean(raw.enabled),
      enabledGroups: Array.isArray(raw.enabledGroups)
        ? raw.enabledGroups.map(id => String(id).trim()).filter(Boolean)
        : []
    }
  }

  isGroupEnabled(config, groupId) {
    return Boolean(config.enabled && (
      config.enabledGroups.some(id => id === String(groupId)) ||
      this.getGroupRule(config, groupId)
    ))
  }

  getGroupRule(config, groupId) {
    return config.groupRules.find(rule => rule.groupId === String(groupId)) || null
  }

  resolveGroupConfig(config, groupId) {
    const rule = this.getGroupRule(config, groupId)
    if (!rule) return config

    const resolved = { ...config }
    const hasOwnWelcomeMessage = typeof rule.welcomeMessage === "string" && rule.welcomeMessage.trim()
    const hasOwnLeaveMessage = typeof rule.leaveMessage === "string" && rule.leaveMessage.trim()
    if (hasOwnWelcomeMessage) resolved.welcomeEnabled = true
    if (hasOwnLeaveMessage) resolved.leaveEnabled = true
    for (const key of ["welcomeMessage", "leaveMessage"]) {
      if (typeof rule[key] === "string" && rule[key].trim()) {
        resolved[key] = rule[key]
      }
    }
    return resolved
  }

  isGroupGuardEnabled(groupId) {
    const config = this.getGroupGuardConfig()
    return Boolean(config.enabled && config.enabledGroups.some(id => id === String(groupId)))
  }

  async getGroup(e, groupId) {
    if (e?.group) return e.group
    return await (e?.bot || Bot).pickGroup(groupId)
  }

  async getMemberInfo(e, groupId, userId) {
    const fallback = {
      userId,
      nickname: e?.nickname || e?.sender?.nickname || "",
      card: e?.card || e?.sender?.card || ""
    }

    try {
      const group = await this.getGroup(e, groupId)
      const members = await group.getMemberMap()
      const member = members.get(Number(userId))
      if (!member) return fallback
      return {
        userId,
        nickname: member.nickname || fallback.nickname,
        card: member.card || fallback.card
      }
    } catch {
      return fallback
    }
  }

  async getGroupName(e, groupId) {
    try {
      const group = await this.getGroup(e, groupId)
      return group?.name || groupId
    } catch {
      return groupId
    }
  }

  async sendGroupMessage(e, groupId, message) {
    if (!message || (Array.isArray(message) && message.length === 0)) return null
    if (e?.reply) return await e.reply(message)
    const group = await this.getGroup(e, groupId)
    return await group.sendMsg(message)
  }

  buildMessage(template, data, { includeAt = false } = {}) {
    const text = renderTemplate(template, { ...data, at: "" }).trim()
    if (!includeAt) return text
    return [buildAtSegment(Number(data.userId)), text ? ` ${text}` : ""].filter(Boolean)
  }

  async buildTemplateData(e, groupId, userId) {
    const member = await this.getMemberInfo(e, groupId, userId)
    const groupName = await this.getGroupName(e, groupId)
    return {
      userId,
      groupId,
      groupName,
      nickname: member.nickname || "",
      card: member.card || "",
      displayName: member.card || member.nickname || userId
    }
  }

  async handleGroupIncrease(e) {
    const groupId = e?.group_id
    const userId = e?.user_id
    if (!groupId || !userId) return false
    if (String(userId) === String(e?.self_id || Bot.uin)) return false

    const config = this.getConfig()
    if (!this.isGroupEnabled(config, groupId)) return false
    const groupConfig = this.resolveGroupConfig(config, groupId)
    if (!groupConfig.welcomeEnabled) return false
    if (groupConfig.suppressWelcomeWhenGroupGuardEnabled && this.isGroupGuardEnabled(groupId)) return false

    const data = await this.buildTemplateData(e, groupId, userId)
    await this.sendGroupMessage(
      e,
      groupId,
      this.buildMessage(groupConfig.welcomeMessage, data, { includeAt: groupConfig.welcomeMessage.includes("{at}") })
    )
    return true
  }

  async handleGroupDecrease(e) {
    const groupId = e?.group_id
    const userId = e?.user_id
    if (!groupId || !userId) return false
    if (String(userId) === String(e?.self_id || Bot.uin)) return false

    const config = this.getConfig()
    if (!this.isGroupEnabled(config, groupId)) return false
    const groupConfig = this.resolveGroupConfig(config, groupId)
    if (!groupConfig.leaveEnabled) return false

    const data = await this.buildTemplateData(e, groupId, userId)
    await this.sendGroupMessage(
      e,
      groupId,
      this.buildMessage(groupConfig.leaveMessage, data, { includeAt: groupConfig.leaveMessage.includes("{at}") })
    )
    return true
  }
}

export const groupNoticeManager = new GroupNoticeManager()
