import { resolveGroupAdminSettings } from '../domain/groupAdminPolicy.js'
import {adminRecord,adminError,requireAdminBot,decodeAdminEvent} from '../../../contracts/groupAdmin.js'
import type {AdminPorts,AdminEvent,GroupId,ModerationConfig,ModerationResult,GroupMember} from '../../../contracts/groupAdmin.js'

import { AdCorpusStore } from "./adCorpusStore.js"
import {
  analyzeModerationRules,
  buildModerationReport,
  clamp01,
  formatActionName,
  normalizeGroupModerationConfig,
  normalizeStringList
} from "../domain/groupModerationRules.js"
import { getMentionTargetId } from "../../conversation/domain/mentionTargets.js"
import { safeTruncateUnicode, splitUnicodeText } from "../../models/domain/unicodeText.js"
import { resolveChatCompletionUrl as normalizeChatCompletionUrl } from "../../models/domain/chatCompletionUrl.js"

// QQ 群里能发 markdown/json 卡片的基本只有机器人；卡片里的 mqqapi://、图片 URL
// 会误触"包含外链"规则。取其可见文本并剥掉链接类 token，结构化卡片折叠成占位符。
export function extractCardSegmentText(content:unknown) {
  const text = String(content || "")
    .replace(/\[CQ:[^\]]+\]/gi, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(?:https?:\/\/|mqqapi:\/\/|www\.)\S+/gi, " ")
    .replace(/&#?\w+;/g, " ")
  return text.replace(/\s+/g, " ").trim()
}

export function getSegmentText(input:unknown):string {
  if(typeof input === "string")return input
  const segment=adminRecord(input)
  if (!segment) return ""
  if (typeof segment === "string") return segment
  if (segment.type === "text") return String(segment.text || adminRecord(segment.data).text || "")
  if (segment.type === "markdown") return extractCardSegmentText(segment.content || adminRecord(segment.data).content || adminRecord(segment.data).data || segment.data || "") || "[卡片消息]"
  if (segment.type === "json" || segment.type === "xml") return "[卡片消息]"
  if (segment.type === "face") return `[表情:${segment.id || adminRecord(segment.data).id || ""}]`
  if (segment.type === "image") return "[图片]"
  if (segment.type === "at") return `@${getMentionTargetId(segment) || ""}`
  if (segment.type === "forward") return "[合并转发]"
  return ""
}

function countSegments(message:unknown = [], type:string) {
  return Array.isArray(message) ? message.filter(item => adminRecord(item).type === type).length : 0
}

function extractJsonObject(text:unknown = ""):Record<string,unknown>|null {
  const content = String(text || "").trim()
  if (!content) return null
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const raw = fenced ? fenced[1]!.trim() : content
  try {
    return adminRecord(JSON.parse(raw) as unknown)
  } catch {}
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    try {
      return adminRecord(JSON.parse(raw.slice(start, end + 1)) as unknown)
    } catch {}
  }
  return null
}

// 官方 Q群管家两个账号：入群须知/公告自带二维码和"加微信"字样，会误触规则，内置豁免
const OFFICIAL_BOT_IDS = new Set(["2854196310", "3858854713"])

// 超长消息折叠为合并聊天记录时，每个转发节点承载的字数
const OVERLONG_FORWARD_CHUNK_CHARS = 1000

export function isIgnoredBotUser(userId:unknown, config:Partial<ModerationConfig>) {
  const id = String(userId || "").trim()
  if (!id) return false
  if (OFFICIAL_BOT_IDS.has(id)) return true
  return normalizeStringList(config?.ignoredBotIds).includes(id)
}

export class GroupModerationManager {
  floodTrackers = new Map<string,number[]>()
  burstTrackers = new Map<string,{messageId:GroupId|undefined;text:string;at:number}[]>()
  constructor(private readonly ports:AdminPorts,private readonly corpus:AdCorpusStore) {}
  getConfig(groupId?:GroupId) {
    return normalizeGroupModerationConfig(resolveGroupAdminSettings(this.ports.readSettings(), groupId).groupModeration)
  }

  isGroupEnabled(config:ModerationConfig, groupId:GroupId|undefined) {
    return Boolean(config.enabled && config.enabledGroups.includes(String(groupId)))
  }

  getCustomGroupAdmins(config:ModerationConfig, groupId:GroupId|undefined) {
    const item = config.groupAdmins.find(entry => entry.groupId === String(groupId))
    return item?.admins || []
  }

  getNotificationAdmins(config:ModerationConfig, groupId:GroupId|undefined, excludedUserIds:(GroupId|undefined)[] = []) {
    const excluded = new Set(
      excludedUserIds.map(userId => String(userId || "").trim()).filter(Boolean)
    )
    return [...new Set([
      ...config.globalAdmins,
      ...this.getCustomGroupAdmins(config, groupId)
    ])].filter(userId => {
      const id = String(userId || "").trim()
      return id && !excluded.has(id)
    })
  }

  isConfiguredAdmin(config:ModerationConfig, groupId:GroupId|undefined, userId:GroupId|undefined) {
    const id = String(userId)
    return config.globalAdmins.includes(id) || this.getCustomGroupAdmins(config, groupId).includes(id)
  }

  isNativeGroupAdmin(e:AdminEvent) {
    return Boolean(e?.isMaster || ["owner", "admin"].includes(e?.sender?.role || ""))
  }

  async getGroup(e:AdminEvent, groupId:GroupId) {
    if (e?.group) return e.group
    const bot = e?.bot || this.ports.getBot()
    return await bot?.pickGroup?.(groupId)
  }

  async getBotRole(e:AdminEvent, groupId:GroupId) {
    try {
      const group = await this.getGroup(e, groupId)
      if (!group?.getMemberMap) return "member"
      const members = await group.getMemberMap()
      const botId = e?.self_id || this.ports.getBot()?.uin
      return members.get(Number(botId))?.role || "member"
    } catch {
      return "member"
    }
  }

  async isBotAdmin(e:AdminEvent, groupId:GroupId) {
    return ["owner", "admin"].includes(await this.getBotRole(e, groupId))
  }

  async getGroupMemberInfo(e:AdminEvent, groupId:GroupId, userId:GroupId):Promise<GroupMember> {
    const fromEvent = e?.sender || {}
    if (fromEvent?.level !== undefined || fromEvent?.role) return fromEvent
    try {
      const bot = requireAdminBot(this.ports,e)
      const response = await bot.sendApi("get_group_member_info", {
        group_id: Number(groupId),
        user_id: Number(userId),
        no_cache: false
      })
      return decodeAdminEvent({sender:adminRecord(response).data || response}).sender || {}
    } catch (error) {
      this.ports.logger?.warn?.(`[GroupModeration] 获取成员信息失败 group=${groupId} user=${userId}: ${adminError(error)}`)
      return fromEvent
    }
  }

  // 命令入口用：取当前消息引用的那条消息（.广告入库 依赖）
  async loadQuotedMessage(e:AdminEvent) {
    if (typeof e?.getReply !== "function") return null
    try {
      const reply = decodeAdminEvent(await e.getReply())
      return reply && (reply.message || reply.raw_message) ? reply : null
    } catch (error) {
      this.ports.logger?.debug?.(`[GroupModeration] 读取引用消息失败: ${adminError(error)}`)
      return null
    }
  }

  async extractContent(e:AdminEvent, config:ModerationConfig) {
    const message = Array.isArray(e?.message) ? e.message.map(adminRecord) : []
    const parts = []
    if (typeof e?.msg === "string" && e.msg.trim()) parts.push(e.msg.trim())
    for (const segment of message) {
      const text = getSegmentText(segment)
      if (text) parts.push(text)
    }

    const forwardIds = message
      .filter(item => item?.type === "forward")
      .map(item => item.id || adminRecord(item.data).id)
      .filter(Boolean)
    const forwardTexts = []
    for (const id of forwardIds) {
      const text = await this.extractForwardText(e, id, config)
      if (text) forwardTexts.push(text)
    }

    return {
      text: [...parts, ...forwardTexts].join("\n").trim(),
      imageCount: countSegments(message, "image"),
      atCount: countSegments(message, "at"),
      forwardCount: forwardIds.length
    }
  }

  async extractForwardText(e:AdminEvent, forwardId:unknown, config:ModerationConfig) {
    try {
      const bot = requireAdminBot(this.ports,e)
      const response = await bot.sendApi("get_forward_msg", { id: forwardId })
      const nodes = adminRecord(adminRecord(response).data).messages || adminRecord(response).data || adminRecord(response).messages || []
      const lines = this.flattenForwardNodes(nodes)
      return safeTruncateUnicode(lines.join("\n"), config.evidenceMaxChars)
    } catch (error) {
      this.ports.logger?.warn?.(`[GroupModeration] 读取合并转发失败 id=${forwardId}: ${adminError(error)}`)
      return ""
    }
  }

  flattenForwardNodes(nodes:unknown = []) {
    if (!Array.isArray(nodes)) return []
    const lines = []
    for (const raw of nodes) {
      const node=adminRecord(raw)
      const sender = adminRecord(node.sender).nickname || adminRecord(node.sender).card || node?.nickname || node?.user_id || "未知"
      const message = node?.message || node?.content || node?.raw_message || ""
      const text = Array.isArray(message)
        ? message.map(item => getSegmentText(item)).join("")
        : String(message || "")
      if (text.trim()) lines.push(`${sender}: ${text.trim()}`)
    }
    return lines
  }

  async modelReview(e:AdminEvent, config:ModerationConfig, evidence:string, baseResult:ModerationResult) {
    if (!config.modelReviewEnabled) return null
    const settings = this.ports.readSettings()
    const ai = adminRecord(settings.toolsAiConfig)
    const apiUrl = ai.toolsAiUrl
    const apiKey = ai.toolsAiApikey
    const model = ai.toolsAiModel
    if (!apiUrl || !apiKey || !model || String(apiKey).includes("sk-xxx")) return null
    try {
      const fetchImpl = this.ports.fetchImpl || globalThis.fetch
      const response = await fetchImpl(this.resolveChatCompletionUrl(String(apiUrl)), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          stream: false,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: "你是QQ群广告风控分类器。只输出严格 JSON：{\"isAd\":true|false,\"confidence\":0-1,\"rules\":[\"规则名\"],\"reason\":\"简短原因\"}。不要输出 Markdown。"
            },
            {
              role: "user",
              content: [
                `群号:${e.group_id}`,
                `用户:${e.user_id}`,
                `规则层命中:${baseResult.rules.join("、") || "无"}`,
                `规则层置信度:${baseResult.confidence.toFixed(2)}`,
                "待判断内容:",
                safeTruncateUnicode(evidence || "", 1800)
              ].join("\n")
            }
          ]
        })
      })
      if (!response.ok) return null
      const data = adminRecord(await response.json() as unknown)
      const parsed = extractJsonObject(adminRecord(adminRecord(Array.isArray(data.choices)?data.choices[0]:undefined).message).content)
      if (!parsed || clamp01(parsed.confidence) < config.modelThreshold) return null
      return {
        isAd: Boolean(parsed.isAd),
        confidence: clamp01(parsed.confidence),
        rules: normalizeStringList(parsed.rules),
        reason: safeTruncateUnicode(String(parsed.reason || ""), 120)
      }
    } catch (error) {
      this.ports.logger?.warn?.(`[GroupModeration] 模型复核失败: ${adminError(error)}`)
      return null
    }
  }

  resolveChatCompletionUrl(apiUrl = "") {
    return normalizeChatCompletionUrl(apiUrl)
  }

  // 刷屏滑动窗口：groupId:userId -> 时间戳数组。命中后清空窗口避免同窗口重复触发
  checkFlood(groupId:GroupId, userId:GroupId, memberLevel:unknown, config:ModerationConfig, now = Date.now()) {
    if (!config?.floodEnabled) return null
    const level = Number(memberLevel)
    if (Number.isFinite(level) && level > config.floodMaxLevel) return null

    const windowMs = Math.max(3, Number(config.floodWindowSeconds) || 10) * 1000
    const maxMessages = Math.max(3, Number(config.floodMaxMessages) || 8)
    const key = `${groupId}:${userId}`
    this.floodTrackers ||= new Map()
    const stamps = (this.floodTrackers.get(key) || []).filter(t => now - t < windowMs)
    stamps.push(now)
    if (stamps.length >= maxMessages) {
      this.floodTrackers.delete(key)
      return { count: stamps.length, windowSeconds: Math.round(windowMs / 1000) }
    }
    if (this.floodTrackers.size > 10000) this.floodTrackers.clear()
    this.floodTrackers.set(key, stamps)
    return null
  }

  getSenderName(e:AdminEvent) {
    const name = String(e?.card || e?.nickname || e?.sender?.card || e?.sender?.nickname || e?.user_id || "").trim()
    return name || "群成员"
  }

  // 消息自身的可见文本：只取消息段渲染结果，不与 e.msg 重复拼接，
  // 也不把合并转发内部的内容算进来（那部分属于"低活跃合并转发"规则管辖）
  extractVisibleText(e:AdminEvent) {
    if (Array.isArray(e?.message)) {
      const text = e.message.map(item => getSegmentText(adminRecord(item))).join("").trim()
      if (text) return text
    }
    return String(e?.msg || e?.raw_message || "").trim()
  }

  // 超长判定按码点计数（emoji 不重复计 2 个字符）
  checkOverlongMessage(text:string, config:ModerationConfig) {
    const overlong = config.overlongMessage
    if (!overlong?.enabled) return null
    const length = Array.from(String(text || "").trim()).length
    const maxLength = Math.floor(Number(overlong.maxLength) || 1500)
    if (length < maxLength) return null
    return { length, maxLength }
  }

  buildOverlongForwardNodes(e:AdminEvent, text:string, overlong:{length:number}) {
    const senderName = this.getSenderName(e)
    const botId = e?.self_id || e?.bot?.uin || this.ports.getBot()?.uin || 80000000
    return [
      {
        user_id: botId,
        nickname: "群管助手",
        message: `已撤回 ${senderName} 的超长消息（约 ${overlong.length} 字），原内容如下：`
      },
      ...splitUnicodeText(text, OVERLONG_FORWARD_CHUNK_CHARS).map(chunk => ({
        user_id: e.user_id,
        nickname: senderName,
        message: chunk
      }))
    ]
  }

  // 合并转发优先走适配器 makeForwardMsg，缺失或失败时退回 OneBot 的 send_group_forward_msg 直发
  async sendForwardNodes(e:AdminEvent, nodes:{user_id:GroupId|undefined;nickname:string;message:string}[]) {
    try {
      const group = await this.getGroup(e, e.group_id!)
      if (typeof group?.makeForwardMsg === "function") {
        const forward = await group.makeForwardMsg(nodes)
        await group.sendMsg(forward)
        return true
      }
    } catch (error) {
      this.ports.logger?.warn?.(`[GroupModeration] 合并转发失败，尝试 OneBot 直发 group=${e.group_id}: ${adminError(error)}`)
    }
    try {
      await (requireAdminBot(this.ports,e)).sendApi("send_group_forward_msg", {
        group_id: Number(e.group_id),
        messages: nodes.map(node => ({
          type: "node",
          data: { name: String(node.nickname || ""), uin: String(node.user_id || 80000000), content: node.message }
        }))
      })
      return true
    } catch (error) {
      this.ports.logger?.warn?.(`[GroupModeration] OneBot 直发合并转发失败 group=${e.group_id}: ${adminError(error)}`)
      return false
    }
  }

  async sendOverlongForward(e:AdminEvent, text:string, overlong:{length:number}) {
    return await this.sendForwardNodes(e, this.buildOverlongForwardNodes(e, text, overlong))
  }

  // 超长消息折叠：撤回原消息后把内容转成一条合并聊天记录发出。
  // 撤回失败就不转发，避免原消息和转发卡片内容重复刷屏。
  async handleOverlongMessage(e:AdminEvent, config:ModerationConfig, text:string, overlong:{length:number;maxLength:number}) {
    this.ports.logger?.info?.(`[GroupModeration] 超长消息折叠 group=${e.group_id} user=${e.user_id} chars=${overlong.length}/${overlong.maxLength}`)
    const recalled = await this.applyAction(e, config, "recall")
    if (!recalled) return false
    if (!config.overlongMessage.forwardEnabled) return true
    if (await this.sendOverlongForward(e, text, overlong)) return true
    try {
      await e.reply?.(`已撤回 ${this.getSenderName(e)} 的超长消息（约 ${overlong.length} 字），但转发聊天记录失败。`)
    } catch (error) {
      this.ports.logger?.warn?.(`[GroupModeration] 发送超长撤回提示失败 group=${e.group_id}: ${adminError(error)}`)
    }
    return true
  }

  // 连发折叠：记录窗口内每条消息的 id 和文本，达到条数阈值返回全部待折叠消息并清空窗口。
  // 命中后由连发分支统一撤回/转发/禁言，避免与刷屏风控重复处理同一批消息
  trackBurstMessage(e:AdminEvent, config:ModerationConfig, now = Date.now()) {
    const burst = config.burstMessage
    if (!burst?.enabled) return null
    const windowMs = Math.max(2, Number(burst.windowSeconds) || 5) * 1000
    const maxMessages = Math.max(3, Math.floor(Number(burst.maxMessages) || 6))
    const key = `${e.group_id}:${e.user_id}`
    this.burstTrackers ||= new Map()
    const entries = (this.burstTrackers.get(key) || []).filter(item => now - item.at < windowMs)
    entries.push({ messageId: e?.message_id || e?.seq, text: this.extractVisibleText(e), at: now })
    if (entries.length < maxMessages) {
      if (this.burstTrackers.size > 10000) this.burstTrackers.clear()
      this.burstTrackers.set(key, entries)
      return null
    }
    this.burstTrackers.delete(key)
    return { messages: entries, windowSeconds: Math.round(windowMs / 1000) }
  }

  // 连发折叠处理：撤回窗口内全部消息 → 禁言 → 把这批消息合并成一条聊天记录发出。
  // 一条都没撤回成功时不禁言不转发，避免原消息与转发卡片内容重复刷屏
  async handleBurstMessage(e:AdminEvent, config:ModerationConfig, burst:{messages:{messageId:GroupId|undefined;text:string;at:number}[];windowSeconds:number}) {
    const senderName = this.getSenderName(e)
    const count = burst.messages.length
    this.ports.logger?.info?.(`[GroupModeration] 连发折叠 group=${e.group_id} user=${e.user_id} count=${count}/${burst.windowSeconds}s`)
    const bot = requireAdminBot(this.ports,e)
    const seen = new Set<GroupId>()
    let recalled = 0
    for (const item of burst.messages) {
      const messageId = item.messageId
      if (!messageId || seen.has(messageId)) continue
      seen.add(messageId)
      try {
        await bot.sendApi("delete_msg", { message_id: messageId })
        recalled++
      } catch (error) {
        this.ports.logger?.warn?.(`[GroupModeration] 连发撤回失败 msg=${messageId}: ${adminError(error)}`)
      }
    }
    if (!recalled) return false

    const muteSeconds = Math.max(0, Math.floor(Number(config.burstMessage.muteSeconds) || 0))
    if (muteSeconds > 0) {
      try {
        await bot.sendApi("set_group_ban", {
          group_id: Number(e.group_id),
          user_id: Number(e.user_id),
          duration: muteSeconds
        })
      } catch (error) {
        this.ports.logger?.warn?.(`[GroupModeration] 连发禁言失败 group=${e.group_id} user=${e.user_id}: ${adminError(error)}`)
      }
    }
    // 这批消息已经处理完，清掉刷屏窗口避免随后再触发一次风控禁言
    this.floodTrackers.delete(`${e.group_id}:${e.user_id}`)

    if (config.burstMessage.forwardEnabled !== false) {
      const botId = e?.self_id || e?.bot?.uin || this.ports.getBot()?.uin || 80000000
      const nodes = [
        {
          user_id: botId,
          nickname: "群管助手",
          message: `${senderName} 在 ${burst.windowSeconds} 秒内连发 ${count} 条消息，已全部撤回并折叠${muteSeconds > 0 ? `，禁言 ${muteSeconds} 秒` : ""}：`
        },
        ...burst.messages.map(item => ({
          user_id: e.user_id,
          nickname: senderName,
          message: item.text || " "
        }))
      ]
      if (await this.sendForwardNodes(e, nodes)) return true
      try {
        await e.reply?.(`已撤回 ${senderName} ${burst.windowSeconds} 秒内发送的 ${count} 条消息${muteSeconds > 0 ? `并禁言 ${muteSeconds} 秒` : ""}（转发聊天记录失败）`)
      } catch (error) {
        this.ports.logger?.warn?.(`[GroupModeration] 发送连发折叠提示失败 group=${e.group_id}: ${adminError(error)}`)
      }
    }
    return true
  }

  decideAction(config:ModerationConfig, confidence:number) {
    if (config.actions.kickEnabled && confidence >= config.thresholds.kick) return "kick"
    if (config.actions.muteEnabled && confidence >= config.thresholds.mute) return "mute"
    if (config.actions.recallEnabled && confidence >= config.thresholds.recall) return "recall"
    if (confidence >= config.thresholds.report) return "report"
    return "ignore"
  }

  async applyAction(e:AdminEvent, config:ModerationConfig, action:string) {
    if (action === "ignore" || action === "report") return false
    const bot = requireAdminBot(this.ports,e)
    try {
      if (action === "recall") {
        const messageId = e?.message_id || e?.seq
        if (!messageId) return false
        await bot.sendApi("delete_msg", { message_id: messageId })
        return true
      }
      if (action === "mute") {
        await bot.sendApi("set_group_ban", {
          group_id: Number(e.group_id),
          user_id: Number(e.user_id),
          duration: Number(config.actions.muteSeconds)
        })
        return true
      }
      if (action === "kick") {
        await bot.sendApi("set_group_kick", {
          group_id: Number(e.group_id),
          user_id: Number(e.user_id),
          reject_add_request: false
        })
        return true
      }
    } catch (error) {
      this.ports.logger?.warn?.(`[GroupModeration] 执行动作失败 action=${action} group=${e.group_id} user=${e.user_id}: ${adminError(error)}`)
    }
    return false
  }

  async sendEvidenceToAdmins(e:AdminEvent, config:ModerationConfig, result:ModerationResult, evidence:string) {
    if (!config.forwardEvidenceToAdmins) return false
    const admins = this.getNotificationAdmins(config, e.group_id, [e.user_id])
    if (!admins.length) return false

    const message = [
      "群管检测证据",
      `群号：${e.group_id}`,
      `用户：${e.user_id}`,
      `命中规则：${result.rules.join("、") || "无"}`,
      `置信度：${result.confidence.toFixed(2)}`,
      `建议动作：${formatActionName(result.action || "report")}`,
      ...(result.flood ? [`刷屏频率：${result.flood.windowSeconds} 秒内 ${result.flood.count} 条`] : []),
      ...(result.corpusEntryId
        ? [`已自动入库样本 #${result.corpusEntryId}（误判可引用该消息发送 .广告出库 删除）`]
        : []),
      "",
      safeTruncateUnicode(evidence || "", config.evidenceMaxChars)
    ].join("\n")

    let sent = false
    for (const admin of admins) {
      try {
        await (requireAdminBot(this.ports,e)).sendApi("send_private_msg", {
          user_id: Number(admin),
          message
        })
        sent = true
      } catch (error) {
        this.ports.logger?.warn?.(`[GroupModeration] 私聊管理员失败 admin=${admin}: ${adminError(error)}`)
      }
    }
    return sent
  }

  async sendGroupReport(e:AdminEvent, config:ModerationConfig, result:ModerationResult) {
    if (!config.publicReportEnabled) return false
    const text = buildModerationReport(result, config)
    if (!text) return false
    try {
      const botId = e?.self_id || e?.bot?.uin || this.ports.getBot()?.uin
      const admins = config.mentionConfiguredAdminsInGroup
        ? this.getNotificationAdmins(config, e.group_id, [e.user_id, botId])
        : []
      const message = admins.length
        ? [
            ...admins.flatMap(userId => [
              { type: "at", data: { qq: userId } },
              { type: "text", data: { text: " " } }
            ]),
            { type: "text", data: { text } }
          ]
        : text
      await e.reply?.(message)
      return true
    } catch (error) {
      this.ports.logger?.warn?.(`[GroupModeration] 发送群内提醒失败 group=${e.group_id}: ${adminError(error)}`)
      return false
    }
  }

  async handleMessage(e:AdminEvent) {
    const groupId = e?.group_id
    const userId = e?.user_id
    if (!groupId || !userId) return false
    if (String(userId) === String(e?.self_id || this.ports.getBot()?.uin || "")) return false

    const config = this.getConfig(groupId)
    if (isIgnoredBotUser(userId, config)) {
      this.ports.logger?.debug?.(`[GroupModer] 跳过白名单机器人 user=${userId}`)
      return false
    }
    if (!this.isGroupEnabled(config, groupId)) return false
    if (!await this.isBotAdmin(e, groupId)) return false
    if (this.isConfiguredAdmin(config, groupId, userId) || this.isNativeGroupAdmin(e)) return false

    const member = await this.getGroupMemberInfo(e, groupId, userId)
    if (["owner", "admin"].includes(member?.role || "")) return false
    const level = Number(member?.level)
    if (config.inspectLowLevelOnly && Number.isFinite(level) && level > config.minActiveLevel) return false

    // 连发折叠检测：独立于广告规则；触发后优先于刷屏/超长处理，避免同一批消息被处理两次
    const burst = this.trackBurstMessage(e, config)
    // 刷屏检测：独立等级门槛，与广告规则无关（纯表情/短消息刷屏也算）
    const flood = burst ? null : this.checkFlood(groupId, userId, member?.level, config)

    const content = await this.extractContent(e, config)
    if (!content.text && !content.imageCount && !content.forwardCount && !flood && !burst) return false

    // 超长折叠与广告风控并行判定：命中风控的消息优先按风控处理（不把广告内容再转发一遍）
    const visibleText = this.extractVisibleText(e)
    const overlong = this.checkOverlongMessage(visibleText, config)

      const base = analyzeModerationRules({
        text: content.text,
        memberLevel: member?.level,
        imageCount: content.imageCount,
        atCount: content.atCount,
        forwardCount: content.forwardCount
      }, config, { extraTemplates: this.corpus.getTemplateTexts() })

    let rules = base.rules
    let confidence = base.confidence
    if (flood) {
      rules = [...new Set([...rules, "刷屏"])]
      confidence = Math.max(confidence, config.floodConfidence)
    }
    const model = base.rules.length > 0
      ? await this.modelReview(e, config, content.text, base)
      : null
    if (model?.isAd) {
      rules = [...new Set([...rules, ...model.rules])]
      confidence = Math.max(confidence, model.confidence)
      if (!rules.includes("模型判断疑似广告")) rules.push("模型判断疑似广告")
    }

    const action = this.decideAction(config, confidence)
    if (action === "ignore") {
      // 连发折叠优先：整批撤回 + 合并转发 + 可选禁言
      if (burst) return await this.handleBurstMessage(e, config, burst)
      // 未命中风控但超长的普通消息：撤回后把内容转成合并聊天记录
      if (overlong) return await this.handleOverlongMessage(e, config, visibleText, overlong)
      return false
    }
    this.ports.logger?.info?.(`[GroupModeration] 命中 group=${groupId} user=${userId} rules=${rules.join("、")} confidence=${confidence.toFixed(2)} action=${action}${flood ? ` flood=${flood.count}条/${flood.windowSeconds}s` : ""}`)

    // 命中即入库：确认是广告的消息自动进样本库，之后同类变体也能命中；
    // 误判可在群里引用该消息执行 .广告出库 删除。纯刷屏（非广告）不进样本库
    let corpusEntryId = ""
    const floodOnly = flood && rules.length === 1
    if (config.adCorpusAutoCollect !== false && content.text && !floodOnly) {
      const autoAdd = this.corpus.addEntry({
        text: content.text,
        groupId,
        userId,
        addedBy: "auto-detect",
        source: "auto"
      })
      if (autoAdd.entry) corpusEntryId = autoAdd.entry.id
    }

    const result = { rules, confidence, action, flood, corpusEntryId, evidenceForwarded: false }
    result.evidenceForwarded = await this.sendEvidenceToAdmins(e, config, result, content.text)
    await this.applyAction(e, config, action)
    await this.sendGroupReport(e, config, result)
    return true
  }
}


