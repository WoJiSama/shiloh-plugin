import { readUserSettings } from "../../utils/configWriter.js"
import {
  generateMathQuestion,
  normalizeQuestionMaxNumber,
  normalizeQuestionOperators
} from "./groupGuardQuestion.js"

const DEFAULT_GROUP_GUARD_CONFIG = {
  enabled: false,
  enabledGroups: [],
  verifyInviteJoin: true,
  timeoutSeconds: 300,
  questionMaxNumber: 10,
  questionOperators: ["add", "sub"],
  maxWrongTimes: 1,
  kickOnTimeout: true,
  kickOnWrongAnswer: true,
  promptTemplate: "{at} 欢迎入群，请在 {timeout} 秒内回答：{question}",
  passMessage: "验证通过",
  retryMessage: "回答错误，请重新回答：{question}",
  failMessage: "回答错误，已移出群聊",
  timeoutMessage: "用户 {userId} 入群验证超时，已移出群聊"
}

function normalizeConfig(raw = {}) {
  const config = { ...DEFAULT_GROUP_GUARD_CONFIG, ...(raw || {}) }
  config.enabledGroups = Array.isArray(config.enabledGroups)
    ? config.enabledGroups.map(id => String(id).trim()).filter(Boolean)
    : []
  config.timeoutSeconds = Math.max(30, Number(config.timeoutSeconds) || DEFAULT_GROUP_GUARD_CONFIG.timeoutSeconds)
  config.questionMaxNumber = normalizeQuestionMaxNumber(config.questionMaxNumber)
  config.questionOperators = normalizeQuestionOperators(config.questionOperators)
  config.maxWrongTimes = Math.max(1, Number(config.maxWrongTimes) || DEFAULT_GROUP_GUARD_CONFIG.maxWrongTimes)
  return config
}

function getMessageText(e) {
  if (typeof e?.msg === "string") return e.msg.trim()
  const textItems = Array.isArray(e?.message)
    ? e.message.filter(item => item?.type === "text").map(item => item?.text || item?.data?.text || "")
    : []
  return textItems.join("").trim()
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

class GroupGuardManager {
  constructor() {
    this.pending = new Map()
  }

  getConfig() {
    return normalizeConfig(readUserSettings().groupGuard)
  }

  getKey(groupId, userId) {
    return `${groupId}:${userId}`
  }

  isGroupEnabled(config, groupId) {
    return Boolean(config.enabled && config.enabledGroups.some(id => id === String(groupId)))
  }

  async getGroup(e, groupId) {
    if (e?.group) return e.group
    return await (e?.bot || Bot).pickGroup(groupId)
  }

  async getBotRole(e, groupId) {
    try {
      const group = await this.getGroup(e, groupId)
      const members = await group.getMemberMap()
      return members.get(Bot.uin)?.role || "member"
    } catch (error) {
      globalThis.logger?.error?.(`[GroupGuard] 获取机器人群权限失败 group=${groupId}: ${error.message}`)
      return "member"
    }
  }

  async isBotAdmin(e, groupId) {
    return ["owner", "admin"].includes(await this.getBotRole(e, groupId))
  }

  async isTargetProtected(e, groupId, userId) {
    try {
      const group = await this.getGroup(e, groupId)
      const members = await group.getMemberMap()
      return ["owner", "admin"].includes(members.get(Number(userId))?.role)
    } catch {
      return false
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

  async handleGroupIncrease(e) {
    const groupId = e?.group_id
    const userId = e?.user_id
    if (!groupId || !userId) return false
    if (String(userId) === String(e?.self_id || Bot.uin)) return false

    const config = this.getConfig()
    if (!this.isGroupEnabled(config, groupId)) return false
    if (e?.sub_type === "invite" && !config.verifyInviteJoin) return false

    if (!await this.isBotAdmin(e, groupId)) {
      globalThis.logger?.warn?.(`[GroupGuard] 群 ${groupId} 已启用入群验证，但机器人不是管理员/群主`)
      return false
    }

    if (await this.isTargetProtected(e, groupId, userId)) return false

    const key = this.getKey(groupId, userId)
    this.clearPending(key)

    const question = generateMathQuestion(config)
    const timeoutMs = config.timeoutSeconds * 1000
    const timer = setTimeout(() => {
      this.handleTimeout(groupId, userId).catch(error => {
        globalThis.logger?.error?.(`[GroupGuard] 超时处理失败 group=${groupId} user=${userId}: ${error.message}`)
      })
    }, timeoutMs)

    this.pending.set(key, {
      groupId,
      userId,
      answer: question.answer,
      question: question.question,
      wrongTimes: 0,
      createdAt: Date.now(),
      timer
    })

    await this.sendGroupMessage(
      e,
      groupId,
      this.buildMessage(config.promptTemplate, {
        userId,
        question: question.question,
        timeout: config.timeoutSeconds
      }, { includeAt: true })
    )
    return true
  }

  async handleMessage(e) {
    const groupId = e?.group_id
    const userId = e?.user_id
    if (!groupId || !userId) return false

    const key = this.getKey(groupId, userId)
    const item = this.pending.get(key)
    if (!item) return false

    const config = this.getConfig()
    if (!this.isGroupEnabled(config, groupId)) {
      this.clearPending(key)
      return false
    }

    const text = getMessageText(e)
    if (!text) return false

    const numbers = text.match(/-?\d+/g) || []
    const answer = numbers[numbers.length - 1]
    if (answer === item.answer) {
      this.clearPending(key)
      if (config.passMessage) {
        await this.sendGroupMessage(e, groupId, renderTemplate(config.passMessage, {
          userId,
          question: item.question,
          timeout: config.timeoutSeconds
        }))
      }
      return true
    }

    item.wrongTimes += 1
    if (item.wrongTimes < config.maxWrongTimes) {
      await this.sendGroupMessage(
        e,
        groupId,
        this.buildMessage(config.retryMessage, {
          userId,
          question: item.question,
          timeout: config.timeoutSeconds,
          wrongTimes: item.wrongTimes,
          maxWrongTimes: config.maxWrongTimes
        }, { includeAt: true })
      )
      return true
    }

    this.clearPending(key)
    if (config.kickOnWrongAnswer) {
      await this.kickUser(e, groupId, userId, "wrong_answer")
    }
    if (config.failMessage) {
      await this.sendGroupMessage(e, groupId, renderTemplate(config.failMessage, {
        userId,
        question: item.question,
        timeout: config.timeoutSeconds
      }))
    }
    return true
  }

  async handleGroupDecrease(e) {
    const groupId = e?.group_id
    const userId = e?.user_id
    if (!groupId || !userId) return false
    this.clearPending(this.getKey(groupId, userId))
    return false
  }

  async handleTimeout(groupId, userId) {
    const key = this.getKey(groupId, userId)
    const item = this.pending.get(key)
    if (!item) return

    const config = this.getConfig()
    this.clearPending(key)
    if (!this.isGroupEnabled(config, groupId)) return

    const fakeEvent = { group_id: groupId, user_id: userId }
    if (config.kickOnTimeout) {
      await this.kickUser(fakeEvent, groupId, userId, "timeout")
    }
    if (config.timeoutMessage) {
      await this.sendGroupMessage(fakeEvent, groupId, renderTemplate(config.timeoutMessage, {
        userId,
        question: item.question,
        timeout: config.timeoutSeconds
      }))
    }
  }

  async kickUser(e, groupId, userId, reason) {
    const config = this.getConfig()
    if (!this.isGroupEnabled(config, groupId)) return false
    if (!await this.isBotAdmin(e, groupId)) return false
    if (await this.isTargetProtected(e, groupId, userId)) return false

    try {
      const bot = e?.bot || Bot
      const response = await bot.sendApi("set_group_kick", {
        group_id: Number(groupId),
        user_id: Number(userId),
        reject_add_request: false
      })
      const ok = response?.status === "ok" || response?.retcode === 0
      if (!ok) globalThis.logger?.warn?.(`[GroupGuard] 踢出失败 group=${groupId} user=${userId} reason=${reason}: ${JSON.stringify(response)}`)
      return ok
    } catch (error) {
      globalThis.logger?.error?.(`[GroupGuard] 踢出失败 group=${groupId} user=${userId} reason=${reason}: ${error.message}`)
      return false
    }
  }

  clearPending(key) {
    const item = this.pending.get(key)
    if (item?.timer) clearTimeout(item.timer)
    this.pending.delete(key)
  }
}

export const groupGuardManager = new GroupGuardManager()
