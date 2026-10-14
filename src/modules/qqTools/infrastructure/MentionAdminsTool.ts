import {normalizeDeliveryReceipt} from '../../messaging/domain/deliveryReceipt.js'
import {qqViewRecord,qqViewEvent,qqViewBot,callQqViewApi} from '../../../contracts/qqToolViews.js'
import type {QqViewEvent,QqViewMember,QqViewPorts} from '../../../contracts/qqToolViews.js'
import { AbstractTool } from "../../toolSupport/infrastructure/AbstractTool.js"

export function createMentionAdminsTool(ports:QqViewPorts = {}){
class MentionAdminsTool extends AbstractTool {
  constructor() {
    super()
    this.name = "mentionAdminsTool"
    this.description = "在当前群聊中艾特所有管理员，并可附带一段通知内容。"
    this.parameters = {
      type: "object",
      properties: {
        message: { type: "string", description: "可选，附在管理员 @ 后面的通知内容。" },
        includeOwner: { type: "boolean", description: "是否同时艾特群主，默认否。" },
        excludeTargets: {
          type: "array",
          items: { type: "string" },
          description: "可选，不艾特的管理员 QQ 号、群名片或昵称。"
        }
      },
      required: []
    }
    this.skill = {
      name: this.name,
      purpose: "读取当前群管理员并在同一条消息中逐个艾特，可附带用户指定的通知。",
      whenToUse: "用户明确要求艾特/通知/喊所有管理员、管理们或群管时使用。",
      boundaries: "仅在当前群执行；默认不艾特机器人自身和群主，除非用户明确要求包含群主。",
      instructions: "message 保留用户要传达的原意，不编造通知内容。管理员列表由当前群成员角色实时读取。",
      examples: [
        "艾特所有管理员 说有人要挂团 -> message=有人要挂团",
        "艾特除了小明和 123456 之外的管理 -> excludeTargets=[小明,123456]"
      ]
    }
  }

  async func(input:unknown = {}, event:unknown = {}) {
    const options=qqViewRecord(input), e=qqViewEvent(event)
    if (!e.group_id) return "error: 只能在群聊中艾特管理员"
    const group = e.group || await e?.bot?.pickGroup?.(e.group_id)
    if (!group?.getMemberMap) return "error: 当前适配器无法读取群成员角色"

    const members = await group.getMemberMap()
    const botId = String(e?.bot?.uin || qqViewBot(ports.getBot?.())?.uin || "")
    const roles = options.includeOwner === true ? new Set(["admin", "owner"]) : new Set(["admin"])
    const exclusions = Array.isArray(options.excludeTargets) ? options.excludeTargets : []
    const normalizedExclusions = exclusions.map(value => String(value || "").trim()).filter(Boolean)
    const excludedIds = new Set<string>()
    const unresolved = []
    for (const target of normalizedExclusions) {
      const byId = /^\d+$/.test(target) ? members.get(target) : null
      const matched = byId || Array.from(members.values()).find(member => {
        const needle = target.toLowerCase()
        return [member?.card, member?.nickname, String(member?.user_id || "")]
          .filter(Boolean)
          .some(value => String(value).toLowerCase().includes(needle))
      })
      if (matched?.user_id) excludedIds.add(String(matched.user_id))
      else unresolved.push(target)
    }
    if (unresolved.length) return `error: 未在当前群找到要排除的成员: ${unresolved.join("、")}`
    const targets = Array.from(members.values())
      .filter(member => roles.has(member?.role || "") && String(member?.user_id || "") !== botId && !excludedIds.has(String(member?.user_id || "")))
      .map(member => String(member.user_id))

    if (!targets.length) return "error: 当前群没有可艾特的其他管理员"

    const segments = []
    for (const userId of targets) {
      segments.push({ type: "at", data: { qq: userId } })
      segments.push({ type: "text", data: { text: " " } })
    }
    const message = String(options.message || "").trim()
    if (message) segments.push({ type: "text", data: { text: message } })

    const receipt = typeof group.sendMsg === 'function' ? await group.sendMsg(segments)
      : typeof e.reply === 'function' ? await e.reply(segments) : null
    const delivery=normalizeDeliveryReceipt(receipt)
    if (delivery.state === 'failed') return 'error: 群消息发送失败'
    if (delivery.state === 'unknown') return JSON.stringify({action:'mention_delivery',deliveryState:'unknown',message:'发送结果未确认，请勿自动重发'})

    return JSON.stringify({ action: "mention_admins", count: targets.length, includeOwner: options.includeOwner === true, excluded: excludedIds.size })
  }
}

return MentionAdminsTool
}
