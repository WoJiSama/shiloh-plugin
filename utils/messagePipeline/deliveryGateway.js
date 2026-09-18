import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import { logDeliveryOutcome } from "../deliveryObservability.js"

const FORWARD_MEDIA_TIMEOUT_MS = 15 * 60 * 1000
const mediaTimeoutLeases = new WeakMap()

export class DeliveryError extends Error {
  constructor(message, { retryable = true, uncertain = false, retcode = null } = {}) {
    super(message)
    this.name = "DeliveryError"
    this.retryable = retryable
    this.uncertain = uncertain
    this.retcode = retcode
  }
}

function toOneBotContent(message = []) {
  return (Array.isArray(message) ? message : [message]).map(item => {
    if (typeof item !== "object" || item === null) return { type: "text", data: { text: String(item || "") } }
    const data = item.data && typeof item.data === "object" ? { ...item.data } : { ...item }
    delete data.type
    if (item.type === "image" && data.url && !data.file) data.file = data.url
    return { type: item.type || "text", data }
  })
}

export function buildOneBotForwardNodes(nodes = []) {
  return nodes.map(node => ({
    type: "node",
    data: {
      name: node.nickname || "匿名消息",
      uin: String(node.user_id || 80000000),
      content: toOneBotContent(node.message)
    }
  }))
}

export async function inlineForwardLocalFileSegment(segment = {}, { artifactStore = null, sharedMedia = null, sharedMediaFiles = null } = {}) {
  const data = segment?.data && typeof segment.data === "object" ? segment.data : segment
  const file = data?.file || ""
  if (!file || String(file).startsWith("base64://") || /^https?:\/\//i.test(String(file))) return segment
  if (sharedMedia?.hostDir && sharedMedia?.containerDir) {
    const hostDir = path.resolve(String(sharedMedia.hostDir))
    const containerDir = String(sharedMedia.containerDir).replace(/\/+$/, "")
    const extension = path.extname(String(file)) || ".mp4"
    const targetName = `${Date.now()}-${randomUUID()}${extension}`
    const target = path.join(hostDir, targetName)
    await fs.promises.mkdir(hostDir, { recursive: true })
    await fs.promises.copyFile(file, target)
    if (Array.isArray(sharedMediaFiles)) sharedMediaFiles.push(target)
    const staged = `file://${containerDir}/${targetName}`
    return segment?.data ? { ...segment, data: { ...segment.data, file: staged } } : { ...segment, file: staged }
  }
  const base64File = artifactStore?.encodeFile
    ? await artifactStore.encodeFile(file)
    : `base64://${(await fs.promises.readFile(file)).toString("base64")}`
  return segment?.data
    ? { ...segment, data: { ...segment.data, file: base64File } }
    : { ...segment, file: base64File }
}

export async function inlineForwardVideoSegment(video = {}, options = {}) {
  return await inlineForwardLocalFileSegment(video, options)
}

function deliveryFailure(result) {
  if (!result || typeof result !== "object") return ""
  if (result.status === "failed") return result.wording || result.msg || "适配器返回发送失败"
  if (result.retcode !== undefined && result.retcode !== null && Number(result.retcode) !== 0) {
    return result.wording || result.msg || `retcode=${result.retcode}`
  }
  return ""
}

function compactFileError(error) {
  return String(error?.message || error || "文件发送失败")
    .replace(/base64:\/\/[A-Za-z0-9+/=]+/g, "base64://[omitted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240)
}

export async function sendCompleteLocalFile(e, filePath, {
  fileName = path.basename(String(filePath || "")),
  maxBytes = 100 * 1024 * 1024,
  logger = globalThis.logger
} = {}) {
  const resolved = path.resolve(String(filePath || ""))
  const stat = await fs.promises.stat(resolved)
  if (!stat.isFile()) throw new DeliveryError("待发送内容不是普通文件", { retryable: false })
  if (stat.size <= 0) throw new DeliveryError("待发送文件为空", { retryable: false })
  if (stat.size > Math.max(1, Number(maxBytes) || 0)) {
    throw new DeliveryError(`文件超过发送上限（${Math.ceil(stat.size / 1024 / 1024)}MB）`, { retryable: false })
  }

  const name = String(fileName || path.basename(resolved)).trim() || path.basename(resolved)
  const bot = e?.bot || globalThis.Bot
  const errors = []
  const apiAction = e?.group_id ? "upload_group_file" : e?.user_id ? "upload_private_file" : ""
  const apiTarget = e?.group_id
    ? { group_id: Number(e.group_id) }
    : e?.user_id
      ? { user_id: Number(e.user_id) }
      : null

  if (apiAction && apiTarget && typeof bot?.sendApi === "function") {
    try {
      const encoded = `base64://${(await fs.promises.readFile(resolved)).toString("base64")}`
      const result = await bot.sendApi(apiAction, { ...apiTarget, file: encoded, name })
      const failure = deliveryFailure(result)
      if (failure) throw new Error(failure)
      logDeliveryOutcome(logger, {
        status: "sent",
        channel: e?.group_id ? "group_file" : "private_file",
        groupId: e?.group_id,
        turnId: e?._turnId,
        messageId: result?.data?.message_id || result?.message_id || null,
        parts: 1
      })
      return { channel: apiAction, fileName: name, size: stat.size, receipt: result }
    } catch (error) {
      errors.push(compactFileError(error))
    }
  }

  const target = e?.group || e?.friend
  if (typeof target?.sendFile === "function") {
    try {
      const result = await target.sendFile(pathToFileURL(resolved).href, name)
      const failure = deliveryFailure(result)
      if (failure) throw new Error(failure)
      logDeliveryOutcome(logger, {
        status: "sent",
        channel: e?.group_id ? "group_file_fallback" : "private_file_fallback",
        groupId: e?.group_id,
        turnId: e?._turnId,
        messageId: result?.data?.message_id || result?.message_id || null,
        parts: 1
      })
      return { channel: "sendFile", fileName: name, size: stat.size, receipt: result }
    } catch (error) {
      errors.push(compactFileError(error))
    }
  }

  const reason = errors.filter(Boolean).join("；") || "当前适配器没有可用的完整文件上传接口"
  logDeliveryOutcome(logger, {
    status: "failed",
    channel: e?.group_id ? "group_file" : "private_file",
    groupId: e?.group_id,
    turnId: e?._turnId,
    error: reason
  })
  throw new DeliveryError(reason, { retryable: true })
}

function compactReceipt(result) {
  return {
    retcode: result?.retcode ?? 0,
    status: result?.status || "ok",
    messageId: result?.data?.message_id || result?.message_id || null,
    wording: result?.wording || result?.msg || ""
  }
}

function oneBotAdapter(root) {
  const adapters = Array.isArray(root?.adapter) ? root.adapter : []
  return adapters.find(adapter => adapter?.name === "OneBotv11" && adapter?.id === "QQ") || null
}

async function withForwardMediaTimeout(root, task) {
  const adapter = oneBotAdapter(root)
  if (!adapter || !Number.isFinite(Number(adapter.timeout))) return await task()

  let lease = mediaTimeoutLeases.get(adapter)
  if (!lease) {
    lease = { originalTimeout: Number(adapter.timeout), active: 0 }
    mediaTimeoutLeases.set(adapter, lease)
  }
  lease.active += 1
  adapter.timeout = Math.max(Number(adapter.timeout), FORWARD_MEDIA_TIMEOUT_MS)
  try {
    return await task()
  } finally {
    lease.active -= 1
    if (lease.active <= 0) {
      adapter.timeout = lease.originalTimeout
      mediaTimeoutLeases.delete(adapter)
    }
  }
}

export class DeliveryGateway {
  constructor({ botRoot = () => globalThis.Bot, logger = globalThis.logger } = {}) {
    this.botRoot = botRoot
    this.logger = logger
  }

  resolveBot(botId) {
    const root = typeof this.botRoot === "function" ? this.botRoot() : this.botRoot
    if (!root) return null
    const key = String(botId || "")
    return root.bots?.[key] || root[key] || (typeof root.sendApi === "function" ? root : null)
  }

  async sendGroupForward({ botId, groupId, nodes }) {
    const root = typeof this.botRoot === "function" ? this.botRoot() : this.botRoot
    const bot = this.resolveBot(botId)
    if (typeof bot?.sendApi !== "function") {
      logDeliveryOutcome(this.logger, { status: "failed", channel: "group_forward", groupId, error: `missing_bot:${botId || "unknown"}` })
      throw new DeliveryError(`Bot ${botId || "unknown"} 当前没有可用的 OneBot sendApi`)
    }
    let result
    try {
      result = await withForwardMediaTimeout(root, () => bot.sendApi("send_group_forward_msg", {
        group_id: Number(groupId),
        messages: buildOneBotForwardNodes(nodes)
      }))
    } catch (error) {
      logDeliveryOutcome(this.logger, { status: "failed", channel: "group_forward", groupId, error })
      throw new DeliveryError(error.message || "OneBot 调用异常", {
        retryable: false,
        uncertain: true
      })
    }
    if (!result || typeof result !== "object" || result.retcode === undefined || result.retcode === null) {
      logDeliveryOutcome(this.logger, { status: "failed", channel: "group_forward", groupId, error: "missing_receipt" })
      throw new DeliveryError("OneBot 未返回可验证的发送回执", {
        retryable: false,
        uncertain: true
      })
    }
    const retcode = Number(result.retcode)
    if (!Number.isFinite(retcode)) {
      logDeliveryOutcome(this.logger, { status: "failed", channel: "group_forward", groupId, error: `invalid_retcode:${result.retcode}` })
      throw new DeliveryError(`OneBot 返回了非法 retcode: ${String(result.retcode).slice(0, 50)}`, {
        retryable: false,
        uncertain: true
      })
    }
    if (retcode !== 0) {
      logDeliveryOutcome(this.logger, { status: "failed", channel: "group_forward", groupId, error: result?.wording || result?.msg || `retcode=${retcode}` })
      throw new DeliveryError(result?.wording || result?.msg || `OneBot retcode=${retcode}`, { retcode })
    }
    const receipt = compactReceipt(result)
    logDeliveryOutcome(this.logger, {
      status: "sent",
      channel: "group_forward",
      groupId,
      messageId: receipt.messageId,
      parts: Array.isArray(nodes) ? nodes.length : 1
    })
    return receipt
  }
}
