import { KeyedSerialQueue } from "./keyedSerialQueue.js"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
export interface DeliveryLogger { info?(message: string): void; warn?(message: string): void; error?(message: string): void }
export interface DeliverySegment { type?: string; data?: { file?: string; url?: string; thumb?: string; [key: string]: unknown }; file?: string; thumb?: string; [key: string]: unknown }
export interface ForwardNode { nickname?: string; user_id?: string | number; message?: unknown }
export interface FileOptions { artifactStore?: { encodeFile(file: string): Promise<string> } | null | undefined; sharedMedia?: { hostDir?: string; containerDir?: string } | null | undefined; sharedMediaFiles?: string[] | null }
export interface BotClient { sendApi?(action: string, data: object): Promise<unknown> }
export interface BotRoot extends BotClient { bots?: Record<string, BotClient>; adapter?: { name?: string; id?: string; timeout?: number }[]; [key: string]: unknown }
export interface DeliveryStats { recordFailure(value: object): void; recordSend(value: object): void }
export interface DeliveryGatewayOptions { botRoot?: (() => BotRoot | null | undefined) | BotRoot; logger?: DeliveryLogger | undefined; stats?: DeliveryStats | null }
export interface DeliveryEvent { bot?: BotClient; group_id?: string | number; user_id?: string | number; _turnId?: string; group?: { sendFile?(file: string, name: string): Promise<unknown> }; friend?: { sendFile?(file: string, name: string): Promise<unknown> } }
export interface GroupPayload { botId: string | number; groupId: string | number; nodes?: ForwardNode[]; text?: string | undefined }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {} }
export function createDeliveryGatewayModule(ports: { botRoot(): BotRoot | undefined; logger?: DeliveryLogger; logDeliveryOutcome(logger: DeliveryLogger | undefined, outcome: object): void; isForwardResourceFailure(error: unknown): boolean }) {
const { logDeliveryOutcome, isForwardResourceFailure } = ports
const forwardQueue = new KeyedSerialQueue()

const FORWARD_MEDIA_TIMEOUT_MS = 15 * 60 * 1000
const mediaTimeoutLeases = new WeakMap<object, { originalTimeout: number; active: number }>()

class DeliveryError extends Error {
 retryable: boolean; uncertain: boolean; retcode: number | null
  constructor(message: string, { retryable = true, uncertain = false, retcode = null }: { retryable?: boolean; uncertain?: boolean; retcode?: number | null } = {}) {
    super(message)
    this.name = "DeliveryError"
    this.retryable = retryable
    this.uncertain = uncertain
    this.retcode = retcode
  }
}

function toOneBotContent(message: unknown = []) {
  return (Array.isArray(message) ? message : [message]).map(item => {
    if (typeof item !== "object" || item === null) return { type: "text", data: { text: String(item || "") } }
    const object = record(item)
    const data = object.data && typeof object.data === "object" ? { ...record(object.data) } : { ...object }
    delete data.type
    if (record(item).type === "image" && data.url && !data.file) data.file = data.url
    return { type: record(item).type || "text", data }
  })
}

function buildOneBotForwardNodes(nodes: ForwardNode[] = []) {
  return nodes.map(node => ({
    type: "node",
    data: {
      name: node.nickname || "匿名消息",
      uin: String(node.user_id || 80000000),
      content: toOneBotContent(node.message)
    }
  }))
}

async function inlineForwardLocalFileSegment(segment: DeliverySegment = {}, { artifactStore = null, sharedMedia = null, sharedMediaFiles = null }: FileOptions = {}) {
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
    await fs.promises.copyFile(String(file), target)
    if (Array.isArray(sharedMediaFiles)) sharedMediaFiles.push(target)
    const staged = `file://${containerDir}/${targetName}`
    return segment?.data ? { ...segment, data: { ...segment.data, file: staged } } : { ...segment, file: staged }
  }
  const base64File = artifactStore?.encodeFile
    ? await artifactStore.encodeFile(String(file))
    : `base64://${(await fs.promises.readFile(String(file))).toString("base64")}`
  return segment?.data
    ? { ...segment, data: { ...segment.data, file: base64File } }
    : { ...segment, file: base64File }
}

async function inlineForwardVideoSegment(video: DeliverySegment = {}, options: FileOptions = {}) {
  const output = await inlineForwardLocalFileSegment(video, options)
  const data = video?.data || video
  if (!data?.thumb) return output
  const thumb = await inlineForwardLocalFileSegment({ type: "image", file: String(data.thumb) }, options)
  return output?.data ? { ...output, data: { ...output.data, thumb: thumb.file } } : { ...output, thumb: thumb.file }
}

function deliveryFailure(value: unknown) {
  const result = record(value)
  if (!result || typeof result !== "object") return ""
  if (result.status === "failed") return String(result.wording || result.msg || "适配器返回发送失败")
  if (result.retcode !== undefined && result.retcode !== null && Number(result.retcode) !== 0) {
    return String(result.wording || result.msg || `retcode=${result.retcode}`)
  }
  return ""
}

function compactFileError(error: unknown) {
  return String(record(error).message || error || "文件发送失败")
    .replace(/base64:\/\/[A-Za-z0-9+/=]+/g, "base64://[omitted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240)
}

async function sendCompleteLocalFile(e: DeliveryEvent, filePath: string, {
  fileName = path.basename(String(filePath || "")),
  maxBytes = 100 * 1024 * 1024,
  logger = ports.logger
}: { fileName?: string; maxBytes?: number; logger?: DeliveryLogger } = {}) {
  const resolved = path.resolve(String(filePath || ""))
  const stat = await fs.promises.stat(resolved)
  if (!stat.isFile()) throw new DeliveryError("待发送内容不是普通文件", { retryable: false })
  if (stat.size <= 0) throw new DeliveryError("待发送文件为空", { retryable: false })
  if (stat.size > Math.max(1, Number(maxBytes) || 0)) {
    throw new DeliveryError(`文件超过发送上限（${Math.ceil(stat.size / 1024 / 1024)}MB）`, { retryable: false })
  }

  const name = String(fileName || path.basename(resolved)).trim() || path.basename(resolved)
  const bot = e?.bot || ports.botRoot()
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
      if (failure) throw new DeliveryError(failure)
      if (!result || typeof result !== 'object' || record(result).retcode == null || !Number.isFinite(Number(record(result).retcode))) {
        throw new DeliveryError('文件发送未返回可验证回执', { retryable: false, uncertain: true })
      }
      logDeliveryOutcome(logger, {
        status: "sent",
        channel: e?.group_id ? "group_file" : "private_file",
        groupId: e?.group_id,
        turnId: e?._turnId,
        messageId: record(record(result).data).message_id || record(result).message_id || null,
        parts: 1
      })
      return { channel: apiAction, fileName: name, size: stat.size, receipt: result }
    } catch (error) {
      if (!(error instanceof DeliveryError) || error.uncertain) throw new DeliveryError(compactFileError(error), { retryable: false, uncertain: true })
      errors.push(compactFileError(error))
    }
  }

  const target = e?.group || e?.friend
  if (typeof target?.sendFile === "function") {
    try {
      const result = await target.sendFile(pathToFileURL(resolved).href, name)
      const failure = deliveryFailure(result)
      if (failure) throw new DeliveryError(failure)
      if (!result || typeof result !== 'object' || record(result).retcode == null || !Number.isFinite(Number(record(result).retcode))) {
        throw new DeliveryError('文件发送未返回可验证回执', { retryable: false, uncertain: true })
      }
      logDeliveryOutcome(logger, {
        status: "sent",
        channel: e?.group_id ? "group_file_fallback" : "private_file_fallback",
        groupId: e?.group_id,
        turnId: e?._turnId,
        messageId: record(record(result).data).message_id || record(result).message_id || null,
        parts: 1
      })
      return { channel: "sendFile", fileName: name, size: stat.size, receipt: result }
    } catch (error) {
      if (!(error instanceof DeliveryError) || error.uncertain) throw new DeliveryError(compactFileError(error), { retryable: false, uncertain: true })
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

function compactReceipt(value: unknown) {
 const result = record(value)
  return {
    retcode: result?.retcode ?? 0,
    status: result?.status || "ok",
    messageId: record(record(result).data).message_id || record(result).message_id || null,
    wording: result?.wording || result?.msg || ""
  }
}

function oneBotAdapter(root: BotRoot | null | undefined) {
  const adapters = Array.isArray(root?.adapter) ? root.adapter : []
  return adapters.find(adapter => adapter?.name === "OneBotv11" && adapter?.id === "QQ") || null
}

async function withForwardMediaTimeout<T>(root: BotRoot | null | undefined, task: () => Promise<T>): Promise<T> {
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

class DeliveryGateway {
 botRoot: NonNullable<DeliveryGatewayOptions["botRoot"]>; logger: DeliveryLogger | undefined; stats: DeliveryStats | null
  constructor({ botRoot = () => ports.botRoot(), logger = ports.logger, stats = null }: DeliveryGatewayOptions = {}) {
    this.botRoot = botRoot
    this.logger = logger
    this.stats = stats
  }

  resolveBot(botId: string | number): BotClient | null {
    const root = typeof this.botRoot === "function" ? this.botRoot() : this.botRoot
    if (!root) return null
    const key = String(botId || "")
    const candidate = root.bots?.[key] || root[key] || root
    return typeof record(candidate).sendApi === "function" ? candidate as BotClient : null
  }

  async sendGroupForward(args: GroupPayload) {
    return forwardQueue.run(args.botId, () => this.sendGroupPayload(args))
  }

  async sendGroupText({ botId, groupId, text }: GroupPayload) {
    return forwardQueue.run(botId, () => this.sendGroupPayload({ botId, groupId, nodes: [], text }))
  }

  async sendGroupPayload({ botId, groupId, nodes, text }: GroupPayload) {
    const channel = text === undefined ? "group_forward" : "group_text"
    const statsChannel = text === undefined ? "media_forward" : "media_text"
    const root = typeof this.botRoot === "function" ? this.botRoot() : this.botRoot
    const bot = this.resolveBot(botId)
    if (typeof bot?.sendApi !== "function") {
      logDeliveryOutcome(this.logger, { status: "failed", channel, groupId, error: `missing_bot:${botId || "unknown"}` })
      this.stats?.recordFailure({ botId, groupId, channel: statsChannel, code: `missing_bot:${botId || "unknown"}` })
      throw new DeliveryError(`Bot ${botId || "unknown"} 当前没有可用的 OneBot sendApi`)
    }
    let result: Record<string, unknown>
    try {
      result = record(await withForwardMediaTimeout(root, () => bot.sendApi!(text === undefined ? "send_group_forward_msg" : "send_group_msg", text === undefined ? {
        group_id: Number(groupId),
        messages: buildOneBotForwardNodes(nodes)
      } : { group_id: Number(groupId), message: [{ type: "text", data: { text } }] })))
    } catch (error) {
      logDeliveryOutcome(this.logger, { status: "failed", channel, groupId, error })
      this.stats?.recordFailure({ botId, groupId, channel: statsChannel, code: "send_api_error" })
      throw new DeliveryError(String(record(error).message || "OneBot 调用异常"), {
        retryable: false,
        uncertain: !isForwardResourceFailure(error)
      })
    }
    if (!result || typeof result !== "object" || result.retcode === undefined || result.retcode === null) {
      logDeliveryOutcome(this.logger, { status: "failed", channel, groupId, error: "missing_receipt" })
      this.stats?.recordFailure({ botId, groupId, channel: statsChannel, code: "missing_receipt" })
      throw new DeliveryError("OneBot 未返回可验证的发送回执", {
        retryable: false,
        uncertain: true
      })
    }
    const retcode = Number(result.retcode)
    if (!Number.isFinite(retcode)) {
      logDeliveryOutcome(this.logger, { status: "failed", channel, groupId, error: `invalid_retcode:${result.retcode}` })
      this.stats?.recordFailure({ botId, groupId, channel: statsChannel, code: "invalid_retcode" })
      throw new DeliveryError(`OneBot 返回了非法 retcode: ${String(result.retcode).slice(0, 50)}`, {
        retryable: false,
        uncertain: true
      })
    }
    if (retcode !== 0) {
      logDeliveryOutcome(this.logger, { status: "failed", channel, groupId, error: result?.wording || result?.msg || `retcode=${retcode}` })
      this.stats?.recordFailure({ botId, groupId, channel: statsChannel, code: `retcode:${retcode}` })
      throw new DeliveryError(String(result?.wording || result?.msg || `OneBot retcode=${retcode}`), { retcode })
    }
    const receipt = compactReceipt(result)
    logDeliveryOutcome(this.logger, {
      status: "sent",
      channel,
      groupId,
      messageId: receipt.messageId,
      parts: Array.isArray(nodes) ? nodes.length : 1
    })
    this.stats?.recordSend({ botId, groupId, channel: statsChannel })
    return receipt
  }
}
return { DeliveryError, DeliveryGateway, buildOneBotForwardNodes, inlineForwardLocalFileSegment, inlineForwardVideoSegment, sendCompleteLocalFile }
}
