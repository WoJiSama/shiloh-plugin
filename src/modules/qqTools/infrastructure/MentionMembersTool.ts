import {normalizeDeliveryReceipt} from '../../messaging/domain/deliveryReceipt.js'
import {qqViewRecord,qqViewEvent,qqViewBot,callQqViewApi} from '../../../contracts/qqToolViews.js'
import type {QqViewEvent,QqViewMember,QqViewPorts} from '../../../contracts/qqToolViews.js'
import { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'

function memberLabel(member:Partial<QqViewMember> = {}) {
  return String(member.card || member.nickname || member.user_id || '').trim()
}

export function createMentionMembersTool(ports:QqViewPorts = {}){
class MentionMembersTool extends AbstractTool {
  constructor() {
    super()
    this.name = 'mentionMembersTool'
    this.description = '在当前群聊中精确艾特指定的群成员，并附带一段通知内容。'
    this.parameters = {
      type: 'object',
      properties: {
        targets: { type: 'array', items: { type: 'string' }, description: '要艾特的当前群成员 QQ 号；也可使用唯一群名片或昵称。' },
        message: { type: 'string', description: '可选，附在所有艾特后的通知内容。' }
      },
      required: ['targets']
    }
    this.skill = {
      name: this.name,
      purpose: '把明确指定的当前群成员逐个真实艾特，并在同一条消息中发送通知。',
      whenToUse: '用户明确要求通知/艾特已知的具体群成员，或当前群工作流规则提供了精确 targetUserIds 时使用。',
      boundaries: '仅在当前群执行；targets 必须来自当前消息、可靠群上下文或已教会的群工作流，不能猜测姓名或自行扩大通知范围。',
      instructions: '优先填 QQ 号。按群工作流执行时必须原样使用规则中的 targets；message 保留用户现在要传达的内容。',
      examples: [
        '有人要挂团，帮我艾特 -> targets=[123,456], message=有人要挂团',
        '通知 @小明和@小红开会 -> targets=[小明,小红], message=要开会'
      ]
    }
  }

  async func(input:unknown = {}, event:unknown = {}) {
    const options=qqViewRecord(input), e=qqViewEvent(event)
    if (!e.group_id) return 'error: 只能在群聊中艾特成员'
    const group = e.group || await e?.bot?.pickGroup?.(e.group_id)
    if (!group?.getMemberMap) return 'error: 当前适配器无法读取群成员'
    const members = await group.getMemberMap()
    const requested = [...new Set((Array.isArray(options.targets) ? options.targets : []).map(value => String(value || '').trim()).filter(Boolean))]
    if (!requested.length) return 'error: 没有指定要艾特的成员'

    const resolved:QqViewMember[] = []
    const missing = []
    for (const target of requested) {
      const byId = /^\d+$/.test(target) ? members.get(target) : null
      const exactMatches = byId ? [byId] : Array.from(members.values()).filter(member => {
        const needle = target.toLowerCase()
        return [member?.card, member?.nickname].filter(Boolean).some(value => String(value).toLowerCase() === needle)
      })
      if (exactMatches.length !== 1 || !exactMatches[0]?.user_id) {
        missing.push(target)
        continue
      }
      const member = exactMatches[0]
      if (!resolved.some(item => String(item.user_id) === String(member.user_id))) resolved.push(member)
    }
    if (!resolved.length) return `error: 当前群未找到要艾特的成员: ${missing.join('、')}`

    const segments = []
    for (const member of resolved) {
      segments.push({ type: 'at', data: { qq: String(member.user_id) } })
      segments.push({ type: 'text', data: { text: ' ' } })
    }
    const message = String(options.message || '').trim()
    if (message) segments.push({ type: 'text', data: { text: message } })
    if (missing.length) segments.push({ type: 'text', data: { text: `（未艾特：${missing.join('、')}，当前不在群或名称有歧义）` } })

    const receipt = typeof group.sendMsg === 'function' ? await group.sendMsg(segments)
      : typeof e.reply === 'function' ? await e.reply(segments) : null
    const delivery=normalizeDeliveryReceipt(receipt)
    if (delivery.state === 'failed') return 'error: 群消息发送失败'
    if (delivery.state === 'unknown') return JSON.stringify({action:'mention_delivery',deliveryState:'unknown',message:'发送结果未确认，请勿自动重发'})
    return JSON.stringify({ action: 'mention_members', count: resolved.length, skipped: missing, targets: resolved.map(member => ({ userId: String(member.user_id), name: memberLabel(member) })) })
  }
}

return MentionMembersTool
}
