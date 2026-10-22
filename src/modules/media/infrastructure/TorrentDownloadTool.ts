import {extractDeliveryMessageId} from '../../messaging/domain/deliveryObservability.js'
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import YAML from "yaml"
import { AbstractTool } from "../../toolSupport/infrastructure/AbstractTool.js"

import { buildTorrentListCardData } from "./torrentListCard.js"
import {
  TorrentDownloadError,
  addPublicTrackersToMagnet,
  assertTorrentFitsArchive,
  assertTorrentWithinLimits,
  buildAriaDownloadArgs,
  buildAriaMetadataArgs,
  buildMetadataCacheUrls,
  buildZipArgs,
  extractValidBtihMagnetUri,
  fingerprintTorrentMetadata,
  findSavedTorrentFile,
  formatTorrentSelectionListing,
  formatBytes,
  getTorrentInfoHash,
  normalizeTorrentDownloadConfig,
  parseMagnetUri,
  parseTorrentMetadata,
  selectTorrentFiles,
  verifyArchiveFile,
  verifyDownloadedFiles
} from "./torrentDownload.js"

import type {TorrentConfig,TorrentMetadata,TorrentFile} from './torrentDownload.js'
interface TorrentPeer {sendMsg?(message:unknown):Promise<unknown>;sendFile?(file:string,name:string):Promise<unknown>}
interface TorrentEvent {friend?:TorrentPeer;group?:TorrentPeer;_turnId?:string;group_id?:string|number|undefined;user_id?:string|number;self_id?:string|number;sender?:{user_id?:string|number};msg?:string;bot?:TorrentBot;reply?(message:unknown):Promise<unknown>}
interface TorrentBot {pickFriend?(id:number):TorrentPeer;sendApi?(action:string,params:Record<string,unknown>):Promise<unknown>}
interface SelectionRecord {version:number;magnet:string;infoHash:string;metadataFingerprint?:string;files:TorrentFile[];createdAt:number;expiresAt:number}
interface RedisPort {get(key:string):Promise<string|null>;set(key:string,value:string,options:{EX:number}):Promise<unknown>;del(key:string):Promise<unknown>}
interface ToolPorts {cwd:string;bot():TorrentBot|undefined;redis():RedisPort|null;image(path:string):unknown;logger:{info(message:string):void;warn(message:string):void};fileSender(e:TorrentEvent,path:string,options:{fileName:string;maxBytes:number}):Promise<unknown>;cardRenderer(data:ReturnType<typeof buildTorrentListCardData>):Promise<string>;deleteTorrentCard(path:string):Promise<unknown>}
interface ToolOptions {configPath?:string;configProvider?:()=>TorrentConfig;commandRunner?:(command:string,args:string[],options:{cwd?:string;timeoutMs?:number})=>Promise<unknown>;fetchImpl?:typeof fetch;fileSender?:ToolPorts['fileSender'];cardRenderer?:ToolPorts['cardRenderer'];fs?:typeof fs;redis?:RedisPort|null}
function record(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'?value as Record<string,unknown>:{}}
function decodeSelection(value:unknown):SelectionRecord|null {const r=record(value);if(r.version!==1||typeof r.magnet!=='string'||typeof r.infoHash!=='string'||typeof r.createdAt!=='number'||typeof r.expiresAt!=='number'||!Array.isArray(r.files))return null;const files:TorrentFile[]=[];for(const item of r.files){const f=record(item);if(typeof f.index!=='number'||typeof f.size!=='number'||!Array.isArray(f.relativePath)||!f.relativePath.every((p:unknown)=>typeof p==='string'))return null;files.push({index:f.index,size:f.size,relativePath:f.relativePath})}return {version:1,magnet:r.magnet,infoHash:r.infoHash,createdAt:r.createdAt,expiresAt:r.expiresAt,files,...(typeof r.metadataFingerprint==='string'?{metadataFingerprint:r.metadataFingerprint}:{})}}
function parsePeer(value:unknown):TorrentPeer {
 const peer=record(value),sendMsg=peer.sendMsg,sendFile=peer.sendFile
 return {...(typeof sendMsg==='function'?{sendMsg:async(message:unknown)=>sendMsg.call(value,message)}:{}),...(typeof sendFile==='function'?{sendFile:async(file:string,name:string)=>sendFile.call(value,file,name)}:{})}
}
export function parseTorrentEvent(value:unknown):TorrentEvent {
 if(value===null||typeof value!=='object')throw new TorrentDownloadError('消息事件无效')
 const e=record(value);if(typeof e.reply!=='function')throw new TorrentDownloadError('缺少回复接口')
 const reply=e.reply;const result:TorrentEvent={reply:async message=>reply.call(value,message),msg:typeof e.msg==='string'?e.msg:''}
 for(const key of ['group_id','user_id','self_id'] as const){const id=e[key];if(typeof id==='string'||typeof id==='number')result[key]=id}
 const senderId=record(e.sender).user_id;if(typeof senderId==='string'||typeof senderId==='number')result.sender={user_id:senderId}
 if(typeof e._turnId==='string')result._turnId=e._turnId
 if(e.friend)result.friend=parsePeer(e.friend)
 if(e.group)result.group=parsePeer(e.group)
 const bot=record(e.bot),sendApi=bot.sendApi,pickFriend=bot.pickFriend
 result.bot={...(typeof sendApi==='function'?{sendApi:async(action:string,params:Record<string,unknown>)=>sendApi.call(e.bot,action,params)}:{}),...(typeof pickFriend==='function'?{pickFriend:(id:number)=>parsePeer(pickFriend.call(e.bot,id))}:{})}
 return result
}
export function createTorrentDownloadTool(ports:ToolPorts) {
const {fileSender:sendCompleteLocalFile,cardRenderer:renderTorrentListCard,deleteTorrentCard}=ports
const activeJobs = new Map<string,Promise<string>>()
const OUTPUT_LIMIT = 12_000
const PENDING_SELECTION_PREFIX = "ytbot:torrent_download_selection:v1:"
const localPendingSelections = new Map<string,SelectionRecord>()

function metadataUnavailableError() {
  const error = new TorrentDownloadError(
    "DHT、补充 tracker 和种子元数据缓存都没拿到文件清单和大小。内容下载没有开始"
  )
  error.code = "metadata_unavailable"
  return error
}

function compactError(error:unknown) {
  return String((error instanceof Error?error.message:error) || "磁链下载失败")
    .replace(/magnet:\?[^\s]+/gi, "磁链")
    .replace(/https?:\/\/[^\s]+/gi, "链接")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260)
}

function findConfigPath() {
  const cwd = ports.cwd
  const candidates = [
    path.join(cwd, "plugins", "shiloh-plugin", "config", "message.yaml"),
    path.join(cwd, "config", "message.yaml")
  ]
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0]!
}

function readRuntimeConfig(configPath = findConfigPath()) {
  try {
    const document = record(YAML.parse(fs.readFileSync(configPath, "utf8")))
    return normalizeTorrentDownloadConfig(record(record(document.pluginSettings).torrentDownload))
  } catch (error) {
    throw new TorrentDownloadError(`无法读取磁链下载配置：${compactError(error)}`)
  }
}

function runCommand(command:string, args:string[], { cwd, timeoutMs, spawnImpl = spawn }:{cwd?:string;timeoutMs?:number;spawnImpl?:typeof spawn} = {}):Promise<{output:string}> {
  return new Promise((resolve, reject) => {
    let child:ReturnType<typeof spawn>
    try {
      child = spawnImpl(command, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false
      })
    } catch (error) {
      reject(error)
      return
    }

    const output:string[] = []
    let outputBytes = 0
    const append = (chunk:Buffer|string) => {
      if (outputBytes >= OUTPUT_LIMIT) return
      const text = Buffer.from(chunk).toString("utf8")
      outputBytes += Buffer.byteLength(text)
      output.push(text.slice(0, OUTPUT_LIMIT - outputBytes))
    }
    child.stdout?.on?.("data", append)
    child.stderr?.on?.("data", append)
    let timeoutError:TorrentDownloadError|null = null
    let killTimer:ReturnType<typeof setTimeout>|undefined
    const timer = setTimeout(() => {
      timeoutError = new TorrentDownloadError(`下载超过 ${Math.ceil((timeoutMs || 1000) / 1000)} 秒上限`)
      timeoutError.code = "timeout"
      child.kill("SIGTERM")
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000)
    }, Math.max(1_000, Number(timeoutMs) || 1_000))
    const finish = () => {
      clearTimeout(timer)
      clearTimeout(killTimer)
    }

    child.once("error", error => {
      finish()
      reject(error)
    })
    child.once("close", (code, signal) => {
      finish()
      if (timeoutError) {
        reject(timeoutError)
        return
      }
      if (code === 0) {
        resolve({ output: output.join("") })
        return
      }
      const detail = output.join("").replace(/\s+/g, " ").trim().slice(-600)
      reject(new TorrentDownloadError(`下载器退出异常${signal ? `（${signal}）` : ""}${detail ? `：${detail}` : ""}`))
    })
  })
}

async function assertFreeDisk(directory:string, minimumBytes:number) {
  if (typeof fs.promises.statfs !== "function") return
  const stat = await fs.promises.statfs(directory)
  const freeBytes = Number(stat.bavail) * Number(stat.bsize)
  if (Number.isFinite(freeBytes) && freeBytes < minimumBytes) {
    throw new TorrentDownloadError(`临时下载目录剩余空间不足 ${formatBytes(minimumBytes)}`)
  }
}

class TorrentDownloadTool extends AbstractTool {
 configPath:string|undefined;configProvider:()=>TorrentConfig;commandRunner:NonNullable<ToolOptions["commandRunner"]>;fetchImpl:typeof fetch;fileSender:ToolPorts["fileSender"];cardRenderer:ToolPorts["cardRenderer"];fs:typeof fs;redis:RedisPort|null;
  constructor(options:ToolOptions = {}) {
    super()
    this.name = "torrentDownloadTool"
    this.description = "下载用户明确提供的 BT magnet 磁链。只会先读取种子元数据，确认大小限制后才下载；完成内容会打成一个 ZIP 私发给发起人。"
    this.parameters = {
      type: "object",
      properties: {
        magnet: {
          type: "string",
          description: "用户消息中原样出现的 magnet:?xt=urn:btih:... 磁链；不得猜测、改写或从其他链接转换。选择已解析清单时可省略。"
        },
        selection: {
          type: "array",
          description: "只在本用户刚刚收到该磁链的文件清单后填写：要下载的 1 起始文件编号，例如 [1,3]；也可填写清单中唯一的完整文件名。"
        }
      },
      required: []
    }
    this.skill = {
      name: this.name,
      purpose: "受限下载用户明确给出的 BT 磁链，将符合限制的内容打成一个 ZIP 私发给发起人。超限种子可以让原发起人选择部分文件。",
      whenToUse: "群里出现用户明确提供的有效 magnet:?xt=urn:btih: 磁链时自动使用；收到该工具刚列出的清单后，发起人明确说下载第几个文件时也使用。",
      boundaries: "不接受 HTTP 链接、种子网址、口头 hash 或模型推测；选择只能取当前群内该用户未过期的清单。每次下载前都重新验证种子和 50 MB 限制；超限、无元数据、下载超时、打包或发送失败时立即停止且如实说明。",
      instructions: "初次调用 magnet 必须逐字取自用户当前发言。选择调用只填写 selection 的 1 起始编号；不得根据聊天猜测文件。",
      examples: [
        "用户发 magnet:?xt=urn:btih:... 并说“帮我下载” -> {\"magnet\":\"用户原样磁链\"}",
        "工具刚列出文件后，用户说“下载 1,3” -> {\"selection\":[1,3]}"
      ]
    }
    this.configPath = options.configPath
    this.configProvider = options.configProvider || (() => readRuntimeConfig(this.configPath))
    this.commandRunner = options.commandRunner || runCommand
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.fileSender = options.fileSender || sendCompleteLocalFile
    this.cardRenderer = options.cardRenderer || renderTorrentListCard
    this.fs = options.fs || fs
    this.redis = options.redis || null
  }

  // 清单准备失败可回退文本；投递结果不确定时停止，避免重复发送。
  async sendSelectionListing(e:TorrentEvent, metadata:TorrentMetadata, options:Parameters<typeof buildTorrentListCardData>[1]) {
    const text = () => formatTorrentSelectionListing(metadata, options)
    let imagePath = ""
    let deliveryAttempted=false
    try {
      const data = buildTorrentListCardData(metadata, options)
      imagePath = await this.cardRenderer(data)
      const segmentApi = {image:ports.image}
      const imageSegment = segmentApi?.image?.(`file://${imagePath}`)
      if (!imageSegment) throw new Error("当前运行环境没有 segment.image 可用")
      deliveryAttempted=true
      const receipt=await e?.reply?.(imageSegment)
      if(!extractDeliveryMessageId(receipt))throw new Error("清单发送结果未确认，已停止重复发送")
      ports.logger?.info?.(`[TorrentDownloadTool] 清单已转为卡面发送 files=${metadata.files.length}`)
    } catch (error) {
      if(deliveryAttempted)throw error
      ports.logger?.warn?.(`[TorrentDownloadTool] 清单卡面渲染失败,回退文本: ${compactError(error)}`)
      await this.sendNotice(e, text())
    } finally {
      if (imagePath) await deleteTorrentCard(imagePath)
    }
  }

  async sendNotice(e:TorrentEvent, text:string) {
    try {
      await e?.reply?.(text)
    } catch (error) {
      ports.logger?.warn?.(`[TorrentDownloadTool] 进度提示发送失败，不中止下载: ${compactError(error)}`)
    }
  }

  async discoverMetadataFromCache(metadataDir:string, magnet:ReturnType<typeof parseMagnetUri>, config:TorrentConfig) {
    for (const url of buildMetadataCacheUrls(magnet.infoHash, config.metadataHttpSources)) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), config.metadataHttpTimeoutMs)
      try {
        const response = await this.fetchImpl(url, { signal: controller.signal, redirect: "error" })
        if (!response?.ok) continue
        const declaredBytes = Number(response.headers?.get?.("content-length") || 0)
        if (declaredBytes > config.maxMetadataBytes) continue
        const content = Buffer.from(await response.arrayBuffer())
        if (!content.length || content.length > config.maxMetadataBytes) continue
        if (getTorrentInfoHash(content) !== magnet.infoHash) continue
        await this.fs.promises.writeFile(path.join(metadataDir, `${magnet.infoHash}.torrent`), content)
        return true
      } catch {
        // A cache is only a metadata discovery fallback. Try the next source.
      } finally {
        clearTimeout(timer)
      }
    }
    return false
  }

  getRedis() {
    return this.redis || ports.redis()
  }

  getSelectionScope(e:TorrentEvent = {}) {
    const userId = String(e?.user_id || e?.sender?.user_id || "").trim()
    if (!userId) throw new TorrentDownloadError("无法确认磁链文件清单的发起人")
    const groupId = String(e?.group_id || "").trim()
    return `${groupId ? `group:${groupId}` : "private"}:user:${userId}`
  }

  getPendingSelectionKey(e:TorrentEvent = {}) {
    return `${PENDING_SELECTION_PREFIX}${this.getSelectionScope(e)}`
  }

  async savePendingSelection(e:TorrentEvent, record:Omit<SelectionRecord,"version"|"createdAt"|"expiresAt">, ttlSeconds:number) {
    const key = this.getPendingSelectionKey(e)
    const value = {
      version: 1,
      ...record,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlSeconds * 1000
    }
    localPendingSelections.set(key, value)
    const store = this.getRedis()
    if (!store) return value
    try {
      await store.set(key, JSON.stringify(value), { EX: ttlSeconds })
    } catch (error) {
      ports.logger?.warn?.(`[TorrentDownloadTool] 保存待选文件清单失败，将仅在当前进程保留: ${compactError(error)}`)
    }
    return value
  }

  async readPendingSelection(e:TorrentEvent) {
    const key = this.getPendingSelectionKey(e)
    let record = localPendingSelections.get(key) || null
    const store = this.getRedis()
    if (store) {
      try {
        const raw = await store.get(key)
        if (raw) record = decodeSelection(JSON.parse(raw))
      } catch (error) {
        ports.logger?.warn?.(`[TorrentDownloadTool] 读取待选文件清单失败，尝试进程内记录: ${compactError(error)}`)
      }
    }
    if (!record || record.version !== 1 || !record.magnet || !record.infoHash || !Array.isArray(record.files)) return null
    if (Number(record.expiresAt) <= Date.now()) {
      await this.clearPendingSelection(e)
      return null
    }
    return record
  }

  async clearPendingSelection(e:TorrentEvent) {
    const key = this.getPendingSelectionKey(e)
    localPendingSelections.delete(key)
    const store = this.getRedis()
    if (!store) return
    try {
      await store.del(key)
    } catch {}
  }

  normalizeSelectionInput(value:unknown) {
    const values = Array.isArray(value) ? value : [value]
    const flattened = []
    for (const item of values) {
      if (typeof item === "string" && /[,，、]/.test(item)) flattened.push(...item.split(/[,，、]/))
      else flattened.push(item)
    }
    return flattened
      .map(item => String(item ?? "").trim().replace(/^第\s*/, "").replace(/(?:个|项|号)$/, ""))
      .filter(Boolean)
  }

  resolveSelection(metadata:TorrentMetadata, selection:unknown, userText = "") {
    const requested = this.normalizeSelectionInput(selection)
    const fromText = this.normalizeSelectionInput(
      requested.length ? [] : (String(userText || "").match(/(?:下载|下|选择|选)\s*(?:第\s*)?([\d\s,，、]+)/i)?.[1] || "")
    )
    const values = requested.length ? requested : fromText
    if (!values.length) throw new TorrentDownloadError("请从刚才的清单中选择文件编号，例如 下载 1,3")

    const allNumeric = values.every(value => /^\d+$/.test(value))
    if (allNumeric) return selectTorrentFiles(metadata, values)

    const normalizedNames = values.map(value => value.replace(/^下载\s*/i, "").trim()).filter(Boolean)
    const indexes = []
    for (const name of normalizedNames) {
      const candidates = metadata.files.filter(file => {
        const relative = file.relativePath.slice(1).join("/") || metadata.name
        const base = file.relativePath.at(-1) || ""
        return name === relative || name === base
      })
      if (candidates.length !== 1) {
        throw new TorrentDownloadError(`没有在刚才的清单中唯一找到“${name}”，请按编号选择`)
      }
      indexes.push(candidates[0]!.index)
    }
    return selectTorrentFiles(metadata, indexes)
  }

  formatSelectionLimitReason(error:unknown, config:TorrentConfig) {
    const message = String((error instanceof Error?error.message:error) || "")
    if (/单文件.*上限/.test(message)) return `超过单文件 ${formatBytes(config.maxSingleFileBytes)} 上限`
    if (/压缩包上传上限/.test(message)) return `超过压缩包 ${formatBytes(config.maxArchiveBytes)} 上传上限`
    if (/当前上限是.*个/.test(message)) return `超过一次最多 ${config.maxFiles} 个文件的限制`
    if (/总大小.*超过/.test(message)) return `所选内容超过 ${formatBytes(config.maxTotalBytes)} 总大小上限`
    return "超过当前下载限制"
  }

  async loadVerifiedMetadata(torrentFile:string, magnet:ReturnType<typeof parseMagnetUri>, config:TorrentConfig) {
    const raw = await this.fs.promises.readFile(torrentFile)
    if (!raw.length || raw.length > config.maxMetadataBytes) throw new TorrentDownloadError("没有拿到可解析的种子元数据")
    if (getTorrentInfoHash(raw) !== magnet.infoHash) throw new TorrentDownloadError("拿到的种子元数据与原磁链不匹配")
    return {
      metadata: parseTorrentMetadata(raw),
      metadataFingerprint: fingerprintTorrentMetadata(raw)
    }
  }

  buildPrivateDeliveryEvent(e:TorrentEvent = {}) {
    if (!e?.group_id) return e
    const userId = Number(e?.user_id || e?.sender?.user_id || 0)
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new TorrentDownloadError("无法确认文件应私发给哪位发起人")
    }
    const bot = e?.bot || ports.bot()
    const friend = bot?.pickFriend?.(userId) || null
    return Object.assign(Object.create(e), {
      group_id: undefined,
      group: undefined,
      message_type: "private",
      user_id: userId,
      friend,
      bot,
      reply: async (message:unknown) => {
        if (typeof friend?.sendMsg === "function") return await friend.sendMsg(message)
        if (typeof bot?.sendApi === "function") {
          return await bot.sendApi("send_private_msg", { user_id: userId, message })
        }
        throw new TorrentDownloadError("当前适配器没有可用的私聊发送接口")
      }
    })
  }

  async sendDeliveryConfirmation(e:TorrentEvent, archive:{name:string;size:number}) {
    if (!e?.group_id) return
    await e.reply?.(`磁链内容已私发给发起人：${archive.name}（${formatBytes(archive.size)}）`)
  }

  normalizeParameters(input:unknown = {}, context:{userText?:string;currentIntentText?:string;event?:unknown} = {}) {
    const params=record(input)
    const userText = String(context?.userText || context?.currentIntentText || record(context?.event).msg || "")
    const fromUser = extractValidBtihMagnetUri(userText)
    const selection = params?.selection ?? (userText.match(/(?:下载|下|选择|选)\s*(?:第\s*)?([\d\s,，、]+)/i)?.[1] || "")
    return {
      magnet: fromUser || String(params?.magnet || "").trim(),
      selection: this.normalizeSelectionInput(selection)
    }
  }

  async func(input:Record<string,unknown>, event:unknown) {
    const e=parseTorrentEvent(event),magnet=String(input.magnet || ""),selection=input.selection ?? [];
    const config = this.configProvider()
    if (!config.enabled) throw new TorrentDownloadError("磁链下载功能当前未启用")

    const hasSelection = this.normalizeSelectionInput(selection).length > 0
    const pending = hasSelection && !magnet ? await this.readPendingSelection(e) : null
    if (hasSelection && !magnet && !pending) {
      throw new TorrentDownloadError("没有待选择的磁链文件清单。请先发送磁链，或在 30 分钟内回复刚才的清单")
    }
    if (!magnet && !pending?.magnet) {
      throw new TorrentDownloadError("请先发送有效的 BTIH 磁链")
    }
    const parsedMagnet = parseMagnetUri(magnet || pending!.magnet)

    if (activeJobs.has(parsedMagnet.infoHash)) {
      throw new TorrentDownloadError("这个磁链正在下载，等当前任务结束后会直接发送文件")
    }
    if (activeJobs.size >= config.maxConcurrentJobs) {
      throw new TorrentDownloadError("当前已有一个磁链下载任务，为了不抢满带宽和磁盘，这条先不启动")
    }

    const job = hasSelection
      ? this.runSelectedDownload(parsedMagnet, pending, selection, config, e)
      : this.runInitialDownload(parsedMagnet, config, e)
    activeJobs.set(parsedMagnet.infoHash, job)
    try {
      return await job
    } finally {
      activeJobs.delete(parsedMagnet.infoHash)
    }
  }

  async discoverAndLoadMetadata(metadataDir:string, magnet:ReturnType<typeof parseMagnetUri>, config:TorrentConfig) {
    const discoverMetadata = async (candidateMagnet:string, timeoutMs:number) => this.commandRunner(
      config.aria2Binary,
      buildAriaMetadataArgs({ directory: metadataDir, magnet: candidateMagnet, proxyUrl: config.proxyUrl }),
      { cwd: metadataDir, timeoutMs }
    )
    if (!await this.discoverMetadataFromCache(metadataDir, magnet, config)) {
      try {
        await discoverMetadata(magnet.magnet, config.metadataDhtTimeoutMs)
      } catch (firstError) {
        if (record(firstError).code === "ENOENT") throw new TorrentDownloadError("服务器没有安装 aria2c，磁链没有开始下载")
        try {
          await discoverMetadata(addPublicTrackersToMagnet(magnet.magnet, config.publicTrackers), config.metadataTrackerTimeoutMs)
        } catch (secondError) {
          if (record(secondError).code === "ENOENT") throw new TorrentDownloadError("服务器没有安装 aria2c，磁链没有开始下载")
          throw metadataUnavailableError()
        }
      }
    }
    const torrentFile = await findSavedTorrentFile(metadataDir)
    const { metadata, metadataFingerprint } = await this.loadVerifiedMetadata(torrentFile, magnet, config)
    return { torrentFile, metadata, metadataFingerprint }
  }

  async runInitialDownload(magnet:ReturnType<typeof parseMagnetUri>, config:TorrentConfig, e:TorrentEvent) {
    return this.runDownload(magnet, config, e, { announce: true, selection: null })
  }

  async runSelectedDownload(magnet:ReturnType<typeof parseMagnetUri>, pending:SelectionRecord|null, selection:unknown, config:TorrentConfig, e:TorrentEvent) {
    return this.runDownload(magnet, config, e, { announce: false, selection, pending })
  }

  async runDownload(magnet:ReturnType<typeof parseMagnetUri>, config:TorrentConfig, e:TorrentEvent, { announce = false, selection = null, pending = null }:{announce?:boolean;selection?:unknown;pending?:SelectionRecord|null} = {}) {
    const workRoot = path.resolve(ports.cwd, config.downloadDir)
    const jobDir = path.join(workRoot, `${Date.now()}-${randomUUID()}`)
    const metadataDir = path.join(jobDir, "metadata")
    const payloadDir = path.join(jobDir, "payload")
    const archivePath = path.join(jobDir, `${magnet.infoHash.slice(0, 12)}.zip`)
    await this.fs.promises.mkdir(metadataDir, { recursive: true })
    await this.fs.promises.mkdir(payloadDir, { recursive: true })

    try {
      await assertFreeDisk(workRoot, config.minFreeBytes)
      if (announce) await this.sendNotice(e, "正在识别磁链")
      const { torrentFile, metadata: completeMetadata, metadataFingerprint } = await this.discoverAndLoadMetadata(metadataDir, magnet, config)
      if (pending && pending.infoHash !== magnet.infoHash) throw new TorrentDownloadError("待选择的磁链已失效，请重新发送磁链")
      if (pending && pending.metadataFingerprint && pending.metadataFingerprint !== metadataFingerprint) {
        throw new TorrentDownloadError("种子文件清单已变化，请重新发送磁链后再选择")
      }

      let metadata
      if (selection) {
        metadata = this.resolveSelection(completeMetadata, selection, e?.msg || "")
        assertTorrentWithinLimits(metadata, config)
        assertTorrentFitsArchive(metadata, config)
      } else {
        try {
          metadata = assertTorrentWithinLimits(completeMetadata, config)
          assertTorrentFitsArchive(metadata, config)
        } catch (error) {
          const selectable = []
          const unavailableReasons = new Map()
          for (const file of completeMetadata.files) {
            try {
              const item = selectTorrentFiles(completeMetadata, [file.index])
              assertTorrentWithinLimits(item, config)
              assertTorrentFitsArchive(item, config)
              selectable.push(file)
            } catch (selectionError) {
              unavailableReasons.set(file.index, this.formatSelectionLimitReason(selectionError, config))
            }
          }
          if (!selectable.length) throw error
          await this.savePendingSelection(e, {
            magnet: magnet.magnet,
            infoHash: magnet.infoHash,
            metadataFingerprint,
            files: completeMetadata.files.map(file => ({
              index: file.index,
              relativePath: file.relativePath,
              size: file.size
            }))
          }, config.selectionTtlSeconds)
          await this.sendSelectionListing(e, completeMetadata, {
            selectableIndexes: selectable.map(file => file.index),
            unavailableReasons,
            maxTotalBytes: config.maxTotalBytes
          })
          return JSON.stringify({
            kind: "tool_outcome",
            status: "selection_required",
            tool: this.name,
            summary: "磁链整体超限，已列出可单独下载的文件，等待发起人选择"
          })
        }
      }

      await this.commandRunner(config.aria2Binary, buildAriaDownloadArgs({
        directory: payloadDir,
        torrentFile,
        selectedFileIndexes: selection ? metadata.files.map(file => file.index) : [],
        proxyUrl: config.proxyUrl
      }), {
        cwd: payloadDir,
        timeoutMs: config.downloadTimeoutMs
      })

      await verifyDownloadedFiles(payloadDir, metadata)
      try {
        await this.commandRunner(config.zipBinary, buildZipArgs({ archiveFile: archivePath, files: metadata.files }), {
          cwd: payloadDir,
          timeoutMs: config.archiveTimeoutMs
        })
      } catch (error) {
        if (record(error).code === "ENOENT") throw new TorrentDownloadError("服务器没有安装 zip，无法生成可下载的压缩包")
        throw error
      }
      const archive = {
        ...(await verifyArchiveFile(archivePath, config.maxArchiveBytes)),
        name: `磁链内容-${magnet.infoHash.slice(0, 12)}.zip`
      }
      const deliveryEvent = this.buildPrivateDeliveryEvent(e)
      await this.fileSender(deliveryEvent, archive.path, {
        fileName: archive.name,
        maxBytes: config.maxArchiveBytes
      })
      await this.sendDeliveryConfirmation(e, archive)
      if (selection) await this.clearPendingSelection(e)
      return JSON.stringify({
        kind: "tool_outcome",
        status: "success",
        tool: this.name,
        summary: `已私发 ${archive.name}（${formatBytes(archive.size)}）给发起人`
      })
    } catch (error) {
      throw error instanceof TorrentDownloadError
        ? error
        : new TorrentDownloadError(compactError(error))
    } finally {
      await this.fs.promises.rm(jobDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

return {TorrentDownloadTool,runCommand}
}
