import {normalizeDeliveryReceipt} from '../../messaging/domain/deliveryReceipt.js'
import type { QqToolEvent, QqToolBot, QqToolGroup, QqMember, QqToolPorts, PbObject, PbValue } from '../../../contracts/qqTools.js'
import { apiOk, asRecord, errorText, eventBot } from './qqToolRuntime.js'
import { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'
import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import { getRedBagType } from '../../platform/domain/redBagUtils.js'

/**
 * 抢红包工具类
 * 当用户让机器人抢红包时调用（支持引用红包消息或自动查找最近红包）
 */
export function createGrabRedBagTool(ports: QqToolPorts) {
class GrabRedBagTool extends AbstractTool {
  constructor() {
    super()
    this.name = 'grabRedBagTool'
    this.description = '抢红包工具。当用户让机器人抢红包时调用此工具，支持引用红包消息或自动查找群内最近的红包。'
    this.parameters = {
      type: 'object',
      required: [],
      properties: {
        confirm: {
          type: 'boolean',
          description: '确认执行抢红包操作',
          default: true
        }
      }
    }
  }

  /**
   * 获取配置中的 groupMaxMessages
   */
  getGroupMaxMessages() {
    try {
      const configPath = path.join(process.cwd(), 'plugins/shiloh-plugin/config/message.yaml')
      if (fs.existsSync(configPath)) {
        const config = asRecord(YAML.parse(fs.readFileSync(configPath, 'utf8')))
        const count=Number(asRecord(config.pluginSettings).groupMaxMessages)
        return Number.isFinite(count)&&count>0?Math.min(1000,Math.floor(count)):100
      }
    } catch (err) {
      // ignore
    }
    return 100
  }

  /**
   * 从消息中提取红包元素
   */
  extractWalletFromMessage(input: unknown) {
    const msg=asRecord(input)
    const raw=msg.message || msg.msg
    const message = Array.isArray(raw)?raw:[]
    for (const rawSegment of message) {
      const seg=asRecord(rawSegment)
      if (seg.type === 'wallet') {
        return {
          wallet: asRecord(seg.data || seg),
          msgSeq: msg.message_seq || msg.seq || ''
        }
      }
    }
    return null
  }

  /**
   * 从群历史消息中查找最近的红包
   */
  async findRecentRedBag(bot: QqToolBot, groupId: string|number) {
    try {
      const count = this.getGroupMaxMessages()
      const history = await bot.sendApi('get_group_msg_history', {
        group_id: groupId,
        count
      })

      const data=asRecord(asRecord(history).data)
      const messages = Array.isArray(data.messages)?[...data.messages]:[]
      // 从最新消息开始找
      for (const msg of messages.reverse()) {
        const result = this.extractWalletFromMessage(msg)
        if (result) {
          return result
        }
      }
    } catch (err) {
      console.error('获取群历史消息失败:', err)
    }
    return null
  }

  /**
   * 执行抢红包
   */
  async func(opts: Record<string, unknown>, e: QqToolEvent) {
    if(opts.confirm===false)return '已取消抢红包操作'
    const bot = eventBot(e,ports)
    const groupId = e.group_id

    if (!groupId) {
      return '此功能仅支持群聊使用'
    }

    let walletElement = null
    let msgSeq: unknown = ''

    // 1. 优先从引用消息获取红包
    let replyMsg: unknown = null
    try {
      if (e.getReply) {
        replyMsg = await e.getReply()
      }
    } catch (err) {
      // ignore
    }

    if (!replyMsg) {
      const replyId = e.reply_id || e.source?.message_id || e.source?.seq
      if (replyId) {
        try {
          const sourceMsg = await bot.sendApi('get_msg', { message_id: replyId })
          if (asRecord(sourceMsg).data) {
            replyMsg = asRecord(sourceMsg).data
          }
        } catch (err) {
          // ignore
        }
      }
    }

    // 从引用消息中提取红包
    if (replyMsg) {
      const result = this.extractWalletFromMessage(replyMsg)
      if (result) {
        walletElement = result.wallet
        msgSeq = result.msgSeq
      }
    }

    // 2. 如果引用消息没有红包，从最近群消息中查找
    if (!walletElement) {
      const result = await this.findRecentRedBag(bot, groupId)
      if (result) {
        walletElement = result.wallet
        msgSeq = result.msgSeq
      }
    }

    if (!walletElement) {
      return '没有找到红包，请引用红包消息或确认群内最近有红包'
    }

    const title = String(walletElement.title || '红包')
    const rawWallet=asRecord(walletElement.raw)
    const redBagType = getRedBagType({red_channel:Number(walletElement.red_channel)||0,red_type:Number(walletElement.red_type)||0,raw:{redChannel:Number(rawWallet.redChannel)||0,redType:Number(rawWallet.redType)||0,msgType:Number(rawWallet.msgType)||0}})

    try {
      // 口令红包：先发送口令
      if (redBagType.type === 'password' && title) {
        try {
          if(normalizeDeliveryReceipt(await bot.pickGroup(groupId).sendMsg(title)).state !== 'sent')return '口令发送结果未确认，已停止抢红包，请勿重复执行'
          // 等待一小段时间让服务器处理
          await new Promise(resolve => setTimeout(resolve, 500))
        } catch (err) {
          return `口令发送结果未确认，已停止抢红包：${errorText(err)}`
        }
      }

      const result = await bot.sendApi('grab_red_bag', {
        recv_uin: String(groupId),
        recv_type: 2,
        peer_uid: String(groupId),
        name: bot.nickname || 'Bot',
        pc_body: walletElement.pc_body || '',
        wishing: walletElement.title || '',
        msg_seq: walletElement.msg_seq || String(msgSeq || ''),
        index: walletElement.string_index || ''
      })

      const grabResult = asRecord(asRecord(asRecord(asRecord(result).data).result).grabRedBagRsp)
      const amountText=String(asRecord(grabResult.recvdOrder).amount??'0')
      if (Number.isFinite(Number(amountText)) && Number(amountText)>0) {
        const amount = Number(amountText) / 100
        return `抢到了「${title}」红包，金额: ${amount}元`
      } else if (grabResult?.result === 7) {
        return `抢「${title}」红包失败：红包已被抢完或已过期`
      } else if (grabResult?.result === 0 && Number(amountText)===0) {
        return `抢「${title}」红包失败：可能已经抢过了`
      } else {
        return `抢「${title}」红包失败，错误码: ${grabResult?.result || '未知'}`
      }
    } catch (err) {
      if (errorText(err).includes('超时')) {
        return `抢「${title}」红包请求超时，结果未确认，请勿重复执行`
      }
      return `抢红包出错: ${errorText(err)}`
    }
  }
}

return { GrabRedBagTool }
}
