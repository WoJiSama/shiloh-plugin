import { readUserSettings } from "../../utils/configWriter.js"
import { AdCorpusStore, adCorpusStore } from "./adCorpusStore.js"
import {
  analyzeModerationRules,
  buildModerationReport,
  clamp01,
  formatActionName,
  normalizeGroupModerationConfig,
  normalizeStringList
} from "./groupModerationRules.js"
import { getMentionTargetId } from "../../utils/mentionTargets.js"
import { safeTruncateUnicode } from "../../utils/unicodeText.js"
import { resolveChatCompletionUrl as normalizeChatCompletionUrl } from "../../utils/chatCompletionUrl.js"

// QQ 群里能发 markdown/json 卡片的基本只有机器人；卡片里的 mqqapi://、图片 URL
// 会误触"包含外链"规则。取其可见文本并剥掉链接类 token，结构化卡片折叠成占位符。
export function extractCardSegmentText(content) {
  const text = String(content || "")
    .replace(/\[CQ:[^\]]+\]/gi, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(?:https?:\/\/|mqqapi:\/\/|www\.)\S+/gi, " ")
    .replace(/&#?\w+;/g, " ")
  return text.replace(/\s+/g, " ").trim()
}

export function getSegmentText(segment) {
  if (!segment) return ""
  if (typeof segment === "string") return segment
  if (segment.type === "text") return segment.text || segment.data?.text || ""
  if (segment.type === "markdown") return extractCardSegmentText(segment.content || segment.data?.content || segment.data?.data || segment.data || "") || "[卡片消息]"
  if (segment.type === "json" || segment.type === "xml") return "[卡片消息]"
  if (segment.type === "face") return `[表情:${segment.id || segment.data?.id || ""}]`
  if (segment.type === "image") return "[图片]"
  if (segment.type === "at") return `@${getMentionTargetId(segment) || ""}`
  if (segment.type === "forward") return "[合并转发]"
  return ""
}

function countSegments(message = [], type) {
  return Array.isArray(message) ? message.filter(item => item?.type === type).length : 0
}

function extractJsonObject(text = "") {
  const content = String(text || "").trim()
  if (!content) return null
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const raw = fenced ? fenced[1].trim() : content
  try {
    return JSON.parse(raw)
  } catch {}
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1))
    } catch {}
  }
  return null
}

// 官方 Q群管家两个账号：入群须知/公告自带二维码和"加微信"字样，会误触规则，内置豁免
const OFFICIAL_BOT_IDS = new Set(["2854196310", "3858854713"])

export function isIgnoredBotUser(userId, config) {
  const id = String(userId || "").trim()
  if (!id) return false
  if (OFFICIAL_BOT_IDS.has(id)) return true
  return normalizeStringList(config?.ignoredBotIds).includes(id)
}

export class GroupModerationManager {
  getConfig() {
    return normalizeGroupModerationConfig(readUserSettings().groupModeration)
  }

  isGroupEnabled(config, groupId) {
    return Boolean(config.enabled && config.enabledGroups.includes(String(groupId)))
  }

  getCustomGroupAdmins(config, groupId) {
    const item = config.groupAdmins.find(entry => entry.groupId === String(groupId))
    return item?.admins || []
  }

  getNotificationAdmins(config, groupId, excludedUserIds = []) {
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

  isConfiguredAdmin(config, groupId, userId) {
    const id = String(userId)
    return config.globalAdmins.includes(id) || this.getCustomGroupAdmins(config, groupId).includes(id)
  }

  isNativeGroupAdmin(e) {
    return Boolean(e?.isMaster || ["owner", "admin"].includes(e?.sender?.role))
  }

  async getGroup(e, groupId) {
    if (e?.group) return e.group
    const bot = e?.bot || globalThis.Bot
    return await bot?.pickGroup?.(groupId)
  }

  async getBotRole(e, groupId) {
    try {
      const group = await this.getGroup(e, groupId)
      if (!group?.getMemberMap) return "member"
      const members = await group.getMemberMap()
      const botId = e?.self_id || globalThis.Bot?.uin
      return members.get(Number(botId))?.role || "member"
    } catch {
      return "member"
    }
  }

  async isBotAdmin(e, groupId) {
    return ["owner", "admin"].includes(await this.getBotRole(e, groupId))
  }

  async getGroupMemberInfo(e, groupId, userId) {
    const fromEvent = e?.sender || {}
    if (fromEvent?.level !== undefined || fromEvent?.role) return fromEvent
    try {
      const bot = e?.bot || Bot
      const response = await bot.sendApi("get_group_member_info", {
        group_id: Number(groupId),
        user_id: Number(userId),
        no_cache: false
      })
      return response?.data || response || {}
    } catch (error) {
      globalThis.logger?.warn?.(`[GroupModeration] 获取成员信息失败 group=${groupId} user=${userId}: ${error.message}`)
      return fromEvent
    }
  }

  // 命令入口用：取当前消息引用的那条消息（.广告入库 依赖）
  async loadQuotedMessage(e) {
    if (typeof e?.getReply !== "function") return null
    try {
      const reply = await e.getReply()
      return reply && (reply.message || reply.raw_message) ? reply : null
    } catch (error) {
      globalThis.logger?.debug?.(`[GroupModeration] 读取引用消息失败: ${error.message}`)
      return null
    }
  }

  async extractContent(e, config) {
    const message = Array.isArray(e?.message) ? e.message : []
    const parts = []
    if (typeof e?.msg === "string" && e.msg.trim()) parts.push(e.msg.trim())
    for (const segment of message) {
      const text = getSegmentText(segment)
      if (text) parts.push(text)
    }

    const forwardIds = message
      .filter(item => item?.type === "forward")
      .map(item => item.id || item.data?.id)
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

  async extractForwardText(e, forwardId, config) {
    try {
      const bot = e?.bot || Bot
      const response = await bot.sendApi("get_forward_msg", { id: forwardId })
      const nodes = response?.data?.messages || response?.data || response?.messages || []
      const lines = this.flattenForwardNodes(nodes)
      return safeTruncateUnicode(lines.join("\n"), config.evidenceMaxChars)
    } catch (error) {
      globalThis.logger?.warn?.(`[GroupModeration] 读取合并转发失败 id=${forwardId}: ${error.message}`)
      return ""
    }
  }

  flattenForwardNodes(nodes = []) {
    if (!Array.isArray(nodes)) return []
    const lines = []
    for (const node of nodes) {
      const sender = node?.sender?.nickname || node?.sender?.card || node?.nickname || node?.user_id || "未知"
      const message = node?.message || node?.content || node?.raw_message || ""
      const text = Array.isArray(message)
        ? message.map(item => getSegmentText(item)).join("")
        : String(message || "")
      if (text.trim()) lines.push(`${sender}: ${text.trim()}`)
    }
    return lines
  }

  async modelReview(e, config, evidence, baseResult) {
    if (!config.modelReviewEnabled) return null
    const settings = readUserSettings()
    const ai = settings.toolsAiConfig || {}
    const apiUrl = ai.toolsAiUrl
    const apiKey = ai.toolsAiApikey
    const model = ai.toolsAiModel
    if (!apiUrl || !apiKey || !model || String(apiKey).includes("sk-xxx")) return null
    try {
      const fetchImpl = globalThis.fetch || (await import("node-fetch")).default
      const response = await fetchImpl(this.resolveChatCompletionUrl(apiUrl), {
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
      const data = await response.json()
      const parsed = extractJsonObject(data?.choices?.[0]?.message?.content)
      if (!parsed || clamp01(parsed.confidence) < config.modelThreshold) return null
      return {
        isAd: Boolean(parsed.isAd),
        confidence: clamp01(parsed.confidence),
        rules: normalizeStringList(parsed.rules),
        reason: safeTruncateUnicode(parsed.reason || "", 120)
      }
    } catch (error) {
      globalThis.logger?.warn?.(`[GroupModeration] 模型复核失败: ${error.message}`)
      return null
    }
  }

  resolveChatCompletionUrl(apiUrl = "") {
    return normalizeChatCompletionUrl(apiUrl)
  }

  // 刷屏滑动窗口：groupId:userId -> 时间戳数组。命中后清空窗口避免同窗口重复触发
  checkFlood(groupId, userId, memberLevel, config, now = Date.now()) {
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

  decideAction(config, confidence) {
    if (config.actions.kickEnabled && confidence >= config.thresholds.kick) return "kick"
    if (config.actions.muteEnabled && confidence >= config.thresholds.mute) return "mute"
    if (config.actions.recallEnabled && confidence >= config.thresholds.recall) return "recall"
    if (confidence >= config.thresholds.report) return "report"
    return "ignore"
  }

  async applyAction(e, config, action) {
    if (action === "ignore" || action === "report") return false
    const bot = e?.bot || Bot
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
      globalThis.logger?.warn?.(`[GroupModeration] 执行动作失败 action=${action} group=${e.group_id} user=${e.user_id}: ${error.message}`)
    }
    return false
  }

  async sendEvidenceToAdmins(e, config, result, evidence) {
    if (!config.forwardEvidenceToAdmins) return false
    const admins = this.getNotificationAdmins(config, e.group_id, [e.user_id])
    if (!admins.length) return false

    const message = [
      "群管检测证据",
      `群号：${e.group_id}`,
      `用户：${e.user_id}`,
      `命中规则：${result.rules.join("、") || "无"}`,
      `置信度：${result.confidence.toFixed(2)}`,
      `建议动作：${formatActionName(result.action)}`,
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
        await (e?.bot || Bot).sendApi("send_private_msg", {
          user_id: Number(admin),
          message
        })
        sent = true
      } catch (error) {
        globalThis.logger?.warn?.(`[GroupModeration] 私聊管理员失败 admin=${admin}: ${error.message}`)
      }
    }
    return sent
  }

  async sendGroupReport(e, config, result) {
    if (!config.publicReportEnabled) return false
    const text = buildModerationReport(result, config)
    if (!text) return false
    try {
      const botId = e?.self_id || e?.bot?.uin || globalThis.Bot?.uin
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
      await e.reply(message)
      return true
    } catch (error) {
      globalThis.logger?.warn?.(`[GroupModeration] 发送群内提醒失败 group=${e.group_id}: ${error.message}`)
      return false
    }
  }

  async handleMessage(e) {
    const groupId = e?.group_id
    const userId = e?.user_id
    if (!groupId || !userId) return false
    if (String(userId) === String(e?.self_id || globalThis.Bot?.uin || "")) return false

    const config = this.getConfig()
    if (isIgnoredBotUser(userId, config)) {
      globalThis.logger?.debug?.(`[GroupModer] 跳过白名单机器人 user=${userId}`)
      return false
    }
    if (!this.isGroupEnabled(config, groupId)) return false
    if (!await this.isBotAdmin(e, groupId)) return false
    if (this.isConfiguredAdmin(config, groupId, userId) || this.isNativeGroupAdmin(e)) return false

    const member = await this.getGroupMemberInfo(e, groupId, userId)
    if (["owner", "admin"].includes(member?.role)) return false
    const level = Number(member?.level)
    if (config.inspectLowLevelOnly && Number.isFinite(level) && level > config.minActiveLevel) return false

    // 刷屏检测：独立等级门槛，与广告规则无关（纯表情/短消息刷屏也算）
    const flood = this.checkFlood(groupId, userId, member?.level, config)

    const content = await this.extractContent(e, config)
    if (!content.text && !content.imageCount && !content.forwardCount && !flood) return false

      const base = analyzeModerationRules({
        text: content.text,
        memberLevel: member?.level,
        imageCount: content.imageCount,
        atCount: content.atCount,
        forwardCount: content.forwardCount
      }, config, { extraTemplates: adCorpusStore.getTemplateTexts() })

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
    if (action === "ignore") return false
    globalThis.logger?.info?.(`[GroupModeration] 命中 group=${groupId} user=${userId} rules=${rules.join("、")} confidence=${confidence.toFixed(2)} action=${action}${flood ? ` flood=${flood.count}条/${flood.windowSeconds}s` : ""}`)

    // 命中即入库：确认是广告的消息自动进样本库，之后同类变体也能命中；
    // 误判可在群里引用该消息执行 .广告出库 删除。纯刷屏（非广告）不进样本库
    let corpusEntryId = ""
    const floodOnly = flood && rules.length === 1
    if (config.adCorpusAutoCollect !== false && content.text && !floodOnly) {
      const autoAdd = adCorpusStore.addEntry({
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

export const groupModerationManager = new GroupModerationManager()
