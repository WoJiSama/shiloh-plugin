// 工具任务状态:任务/绘图进度查询的 Redis 持久化与运行时缓存、状态回复文案。
// 从 apps/test.js 原样迁出(行为不变),this 依赖以 host 注入。
import { activeDedupeToolRuns } from "./splitState.js"
import { isDrawTaskStatusInquiry } from "../../core/intent/messageIntent.js"

const TASK_STATUS_REDIS_TIMEOUT_MS = 2000

const logger = globalThis.logger

const activeUserToolTaskCache = new Map()

async function settleTaskStatusRedis(promise, fallback, label) {
  let timer = null
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(fallback), TASK_STATUS_REDIS_TIMEOUT_MS)
  })
  try {
    return await Promise.race([promise, timeout])
  } catch (error) {
    logger.warn(`[任务状态] ${label}失败：${error.message}`)
    return fallback
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const taskStatusCache = new Map()
export function getTaskStatusCacheKey(host, groupId, messageId) {
    return `${groupId}:${messageId}`
}

export function getTaskStatusRedisKey(host, groupId, messageId) {
    return `${host.TASK_STATUS_PREFIX}${groupId}:${messageId}`
}

export function getActiveToolTaskCacheKey(host, groupId, userId, toolName) {
    return `${groupId}:${userId}:${toolName}`
}

export function getActiveToolTaskRedisKey(host, groupId, userId, toolName) {
    return `${host.ACTIVE_TOOL_TASK_PREFIX}${groupId}:${userId}:${toolName}`
}

export function getTaskStatusTtlSeconds(host) {
    return Math.max(60, Math.floor((host.config.groupChatMemoryDays || 1) * 24 * 60 * 60))
}

export async function saveTaskStatus(host, { groupId, userId, messageId, status, toolName = "", error = "" }) {
    if (!groupId || !messageId || !status) return

    const record = {
      groupId: String(groupId),
      userId: userId ? String(userId) : "",
      messageId: String(messageId),
      status,
      toolName,
      error: error ? String(error).slice(0, 120) : "",
      updatedAt: Date.now()
    }
    const cacheKey = host.getTaskStatusCacheKey(groupId, messageId)
    taskStatusCache.set(cacheKey, record)

    await settleTaskStatusRedis(
      redis.set(host.getTaskStatusRedisKey(groupId, messageId), JSON.stringify(record), {
        EX: host.getTaskStatusTtlSeconds()
      }),
      undefined,
      "写入"
    )
}

export async function getTaskStatus(host, groupId, messageId) {
    if (!groupId || !messageId) return null

    const cacheKey = host.getTaskStatusCacheKey(groupId, messageId)
    if (taskStatusCache.has(cacheKey)) return taskStatusCache.get(cacheKey)

    const raw = await settleTaskStatusRedis(
      redis.get(host.getTaskStatusRedisKey(groupId, messageId)),
      null,
      "读取"
    )
    if (!raw) return null
    try {
      const record = JSON.parse(raw)
      taskStatusCache.set(cacheKey, record)
      return record
    } catch (error) {
      logger.warn(`[任务状态] 解析失败：${error.message}`)
      return null
    }
}

export async function clearTaskStatus(host, groupId, messageId) {
    if (!groupId || !messageId) return
    taskStatusCache.delete(host.getTaskStatusCacheKey(groupId, messageId))
    await settleTaskStatusRedis(
      redis.del(host.getTaskStatusRedisKey(groupId, messageId)),
      undefined,
      "清理"
    )
}

export async function updateUserToolTaskStatus(host, { groupId, userId, messageId = "", toolName, status, requesterName = "", detail = "", scopeKey = "" }) {
    if (!groupId || !userId || !toolName || !status) return

    const key = host.getActiveToolTaskCacheKey(groupId, userId, toolName)
    const previous = activeUserToolTaskCache.get(key) || {}
    const record = {
      ...previous,
      groupId: String(groupId),
      userId: String(userId),
      messageId: messageId ? String(messageId) : String(previous.messageId || ""),
      toolName,
      status,
      requesterName: requesterName || previous.requesterName || "",
      detail: detail ? String(detail).slice(0, 160) : "",
      scopeKey: scopeKey || previous.scopeKey || "",
      startedAt: previous.startedAt || Date.now(),
      updatedAt: Date.now()
    }
    activeUserToolTaskCache.set(key, record)

    try {
      await redis.set(host.getActiveToolTaskRedisKey(groupId, userId, toolName), JSON.stringify(record), {
        EX: host.getTaskStatusTtlSeconds()
      })
    } catch (error) {
      logger.warn(`[活跃任务] 写入失败：${error.message}`)
    }
}

export async function getUserToolTaskStatus(host, groupId, userId, toolName) {
    if (!groupId || !userId || !toolName) return null

    const key = host.getActiveToolTaskCacheKey(groupId, userId, toolName)
    if (activeUserToolTaskCache.has(key)) return activeUserToolTaskCache.get(key)

    try {
      const raw = await redis.get(host.getActiveToolTaskRedisKey(groupId, userId, toolName))
      if (!raw) return null
      const record = JSON.parse(raw)
      activeUserToolTaskCache.set(key, record)
      return record
    } catch (error) {
      logger.warn(`[活跃任务] 读取失败：${error.message}`)
      return null
    }
}

export async function clearUserToolTaskStatus(host, { groupId, userId, toolName }) {
    if (!groupId || !userId || !toolName) return
    const key = host.getActiveToolTaskCacheKey(groupId, userId, toolName)
    activeUserToolTaskCache.delete(key)

    try {
      await redis.del(host.getActiveToolTaskRedisKey(groupId, userId, toolName))
    } catch (error) {
      logger.warn(`[活跃任务] 清理失败：${error.message}`)
    }
}

export function getRuntimeToolTaskStatus(host, groupId, userId, toolName) {
    const runtime = activeDedupeToolRuns.get(host.getToolRunKey(groupId, userId, toolName))
    if (!runtime) return null
    return {
      ...runtime,
      groupId: String(groupId),
      userId: String(userId),
      toolName,
      status: "running",
      updatedAt: Date.now()
    }
}

export async function getCurrentUserToolTaskStatus(host, groupId, userId, toolName) {
    const runtime = host.getRuntimeToolTaskStatus(groupId, userId, toolName)
    if (runtime) return runtime
    const stored = await host.getUserToolTaskStatus(groupId, userId, toolName)
    if (!stored || !["queued", "running"].includes(stored.status)) return null
    return stored
}

export function buildDrawTaskStatusReply(host, status) {
    const queued = status?.status === "queued"
    const isEdit = status?.toolName === "googleImageEditTool"
    if (isEdit) {
      return "那张图还在改，结果还没回来。出来了我就直接发。"
    }
    return queued
      ? "这张已经在队列里，前面还有任务。轮到它就会继续画，成图会直接发。"
      : "这张还在生成，结果还没回来。成图会直接发。"
}

export function buildReplySegment(host, messageId) {
    if (!messageId) return null
    if (globalThis.segment?.reply) return globalThis.segment.reply(messageId)
    if (typeof segment !== "undefined" && segment?.reply) return segment.reply(messageId)
    return { type: "reply", id: String(messageId), data: { id: String(messageId) } }
}

export function buildTaskStatusReplyMessage(host, status, text) {
    const replySegment = host.buildReplySegment(status?.messageId)
    return replySegment ? [replySegment, text] : text
}

export async function handleActiveDrawStatusQuestion(host, e, text = "") {
    if (!isDrawTaskStatusInquiry(text)) return false
    const statuses = await Promise.all([
      host.getCurrentUserToolTaskStatus(e.group_id, e.user_id, "bananaTool"),
      host.getCurrentUserToolTaskStatus(e.group_id, e.user_id, "googleImageEditTool")
    ])
    const status = statuses.find(Boolean)
    if (!status) return false

    logger.info(`[活跃任务] 命中图片任务进度追问 group=${e.group_id} user=${e.user_id} tool=${status.toolName} status=${status.status}`)
    await host.sendObservedReply(e, host.buildTaskStatusReplyMessage(status, host.buildDrawTaskStatusReply(status)))
    return true
}

export function formatTaskStatusForPrompt(host, status) {
    if (!status?.status) return ""
    if (status.status === "processing") {
      return "[历史处理标记: 这条历史消息已进入处理流程，禁止把它当作当前新任务重复处理]"
    }
    if (status.status === "tool_running") {
      return "[历史处理标记: 这条历史消息仍在后台处理，禁止重复处理；不要在回复中提到后台状态]"
    }
    if (status.status === "tool_success") {
      return "[历史处理标记: 这条历史消息已经处理完，禁止重复处理]"
    }
    if (status.status === "tool_failed") {
      return "[历史处理标记: 这条历史消息此前没有产生可用输出。除非当前用户明确要求重试，否则只把它当普通历史；不要提到后台、工具、模型、接口、报错或失败等内部状态]"
    }
    return ""
}
