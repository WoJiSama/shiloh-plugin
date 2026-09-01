import { readUserSettings } from "./configWriter.js"
import {
  analyzeModerationRules,
  buildModerationReport,
  clamp01,
  formatActionName,
  normalizeGroupModerationConfig,
  normalizeStringList
} from "./groupModerationRules.js"
import { getMentionTargetId } from "./mentionTargets.js"
import { safeTruncateUnicode } from "./unicodeText.js"
import { resolveChatCompletionUrl as normalizeChatCompletionUrl } from "./chatCompletionUrl.js"

function getSegmentText(segment) {
  if (!segment) return ""
  if (typeof segment === "string") return segment
  if (segment.type === "text") return segment.text || segment.data?.text || ""
  if (segment.type === "markdown") return segment.content || segment.data?.content || segment.data?.data || segment.data || ""
  if (segment.type === "json" || segment.type === "xml") return segment.data?.data || segment.data || ""
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

class GroupModerationManager {
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
    const admins = [...new Set([
      ...config.globalAdmins,
      ...this.getCustomGroupAdmins(config, e.group_id)
    ])].filter(id => id && id !== String(e.user_id))
    if (!admins.length) return false

    const message = [
      "群管检测证据",
      `群号：${e.group_id}`,
      `用户：${e.user_id}`,
      `命中规则：${result.rules.join("、") || "无"}`,
      `置信度：${result.confidence.toFixed(2)}`,
      `建议动作：${formatActionName(result.action)}`,
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
      await e.reply(text)
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
    if (!this.isGroupEnabled(config, groupId)) return false
    if (!await this.isBotAdmin(e, groupId)) return false
    if (this.isConfiguredAdmin(config, groupId, userId) || this.isNativeGroupAdmin(e)) return false

    const member = await this.getGroupMemberInfo(e, groupId, userId)
    if (["owner", "admin"].includes(member?.role)) return false
    const level = Number(member?.level)
    if (config.inspectLowLevelOnly && Number.isFinite(level) && level > config.minActiveLevel) return false

    const content = await this.extractContent(e, config)
    if (!content.text && !content.imageCount && !content.forwardCount) return false

    const base = analyzeModerationRules({
      text: content.text,
      memberLevel: member?.level,
      imageCount: content.imageCount,
      atCount: content.atCount,
      forwardCount: content.forwardCount
    }, config)

    let rules = base.rules
    let confidence = base.confidence
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

    const result = { rules, confidence, action, evidenceForwarded: false }
    result.evidenceForwarded = await this.sendEvidenceToAdmins(e, config, result, content.text)
    await this.applyAction(e, config, action)
    await this.sendGroupReport(e, config, result)
    return true
  }
}

export const groupModerationManager = new GroupModerationManager()
