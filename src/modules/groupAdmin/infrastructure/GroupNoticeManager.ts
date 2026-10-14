import {adminRecord,adminError,requireAdminBot} from '../../../contracts/groupAdmin.js'
import type {AdminPorts,AdminEvent,GroupId,NoticeConfig,PendingGuard} from '../../../contracts/groupAdmin.js'

const DEFAULT_GROUP_NOTICE_CONFIG:NoticeConfig = {
  enabled: false,
  enabledGroups: [],
  groupRules: [],
  welcomeEnabled: true,
  leaveEnabled: true,
  suppressWelcomeWhenGroupGuardEnabled: true,
  welcomeMessage: "{at} 欢迎入群",
  leaveMessage: "用户 {userId} 退出了群聊"
}

function normalizeConfig(input:unknown = {}):NoticeConfig {
  const raw=adminRecord(input)
  const config = { ...DEFAULT_GROUP_NOTICE_CONFIG, ...(raw || {}) }
  for(const key of ['enabled','welcomeEnabled','leaveEnabled','suppressWelcomeWhenGroupGuardEnabled'] as const)config[key]=typeof raw[key]==='boolean'?raw[key]:DEFAULT_GROUP_NOTICE_CONFIG[key]
  for(const key of ['welcomeMessage','leaveMessage'] as const)config[key]=typeof raw[key]==='string'?raw[key]:DEFAULT_GROUP_NOTICE_CONFIG[key]
  config.enabledGroups = Array.isArray(config.enabledGroups)
    ? config.enabledGroups.map(id => String(id).trim()).filter(Boolean)
    : []
  config.groupRules = Array.isArray(config.groupRules)
    ? config.groupRules
      .map(value => {const rule=adminRecord(value);return {
        groupId:String(rule.groupId || "").trim(),
        ...(typeof rule.welcomeMessage==='string'?{welcomeMessage:rule.welcomeMessage}:{}),
        ...(typeof rule.leaveMessage==='string'?{leaveMessage:rule.leaveMessage}:{})
      }})
      .filter(rule => rule.groupId)
    : []
  return config
}

function renderTemplate(template:unknown, data:Record<string,unknown>) {
  return String(template || "").replace(/\{(\w+)}/g, (_, key) => {
    return data[key] === undefined || data[key] === null ? "" : String(data[key])
  })
}



export class GroupNoticeManager {
  constructor(private readonly ports:AdminPorts) {}
  getConfig() {
    return normalizeConfig(this.ports.readSettings().groupNotice)
  }

  getGroupGuardConfig() {
    const raw = adminRecord(this.ports.readSettings().groupGuard)
    return {
      enabled: Boolean(raw.enabled),
      enabledGroups: Array.isArray(raw.enabledGroups)
        ? raw.enabledGroups.map(id => String(id).trim()).filter(Boolean)
        : []
    }
  }

  isGroupEnabled(config:NoticeConfig, groupId:GroupId) {
    return Boolean(config.enabled && (
      config.enabledGroups.some(id => id === String(groupId)) ||
      this.getGroupRule(config, groupId)
    ))
  }

  getGroupRule(config:NoticeConfig, groupId:GroupId) {
    return config.groupRules.find(rule => rule.groupId === String(groupId)) || null
  }

  resolveGroupConfig(config:NoticeConfig, groupId:GroupId) {
    const rule = this.getGroupRule(config, groupId)
    if (!rule) return config

    const resolved = { ...config }
    const hasOwnWelcomeMessage = typeof rule.welcomeMessage === "string" && rule.welcomeMessage.trim()
    const hasOwnLeaveMessage = typeof rule.leaveMessage === "string" && rule.leaveMessage.trim()
    if (hasOwnWelcomeMessage) resolved.welcomeEnabled = true
    if (hasOwnLeaveMessage) resolved.leaveEnabled = true
    for (const key of ["welcomeMessage", "leaveMessage"] as const) {
      if (typeof rule[key] === "string" && rule[key].trim()) {
        resolved[key] = rule[key]
      }
    }
    return resolved
  }

  isGroupGuardEnabled(groupId:GroupId) {
    const config = this.getGroupGuardConfig()
    return Boolean(config.enabled && config.enabledGroups.some(id => id === String(groupId)))
  }

  async getGroup(e:AdminEvent, groupId:GroupId) {
    if (e?.group) return e.group
    return await (requireAdminBot(this.ports,e)).pickGroup(groupId)
  }

  async getMemberInfo(e:AdminEvent, groupId:GroupId, userId:GroupId) {
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

  async getGroupName(e:AdminEvent, groupId:GroupId) {
    try {
      const group = await this.getGroup(e, groupId)
      return group?.name || groupId
    } catch {
      return groupId
    }
  }

  async sendGroupMessage(e:AdminEvent, groupId:GroupId, message:unknown) {
    if (!message || (Array.isArray(message) && message.length === 0)) return null
    if (e?.reply) return await e.reply(message)
    const group = await this.getGroup(e, groupId)
    return await group.sendMsg(message)
  }

  buildMessage(template:string, data:Record<string,unknown>, { includeAt = false } = {}) {
    const text = renderTemplate(template, { ...data, at: "" }).trim()
    if (!includeAt) return text
    return [(this.ports.at?.(Number(data.userId)) || {type:"at",qq:Number(data.userId)}), text ? ` ${text}` : ""].filter(Boolean)
  }

  async buildTemplateData(e:AdminEvent, groupId:GroupId, userId:GroupId) {
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

  async handleGroupIncrease(e:AdminEvent) {
    const groupId = e?.group_id
    const userId = e?.user_id
    if (!groupId || !userId) return false
    if (String(userId) === String(e?.self_id || this.ports.getBot()?.uin)) return false

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

  async handleGroupDecrease(e:AdminEvent) {
    const groupId = e?.group_id
    const userId = e?.user_id
    if (!groupId || !userId) return false
    if (String(userId) === String(e?.self_id || this.ports.getBot()?.uin)) return false

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


