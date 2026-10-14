import dns from "node:dns/promises"
import net from "node:net"
import path from "node:path"
import { getSegmentData, normalizeMessageSegments } from "../../conversation/infrastructure/groupContextResolver.js"

const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'?value as Record<string,unknown>:{}
export interface ExcelEvent {group_id?:string|number;user_id?:string|number;self_id?:string|number;message?:unknown;group?:{getFileUrl?(id:string):Promise<unknown>};friend?:{getFileUrl?(id:string):Promise<unknown>};bot?:{sendApi?(action:string,payload:Record<string,unknown>):Promise<unknown>};getReply?():Promise<unknown>;_groupContextAssets?:{reply?:unknown;media?:unknown[]}}
export interface ExcelFileOptions {fileUrl?:string|undefined;fileName?:string|undefined;folderPath?:string|undefined;query?:string|undefined;maxDepth?:number;maxFolders?:number;maxFiles?:number;maxBytes?:number;timeoutMs?:number}
interface FileCandidate {source?:string;fileName:string;fileId:string;busId?:string;origin:string;senderUserId?:string}
export interface ExcelFile {fileUrl:string;fileName:string;origin:string;fileId?:string;busId?:string;fullPath?:string;folderPath?:string}
export function parseExcelEvent(value:unknown):ExcelEvent {
 const e=record(value),event:ExcelEvent={message:e.message}
 for(const key of ['group_id','user_id','self_id'] as const){const id=e[key];if(typeof id==='string'||typeof id==='number')event[key]=id}
 for(const key of ['group','friend'] as const){const peer=record(e[key]),method=peer.getFileUrl;if(typeof method==='function')event[key]={getFileUrl:async id=>method.call(e[key],id)}}
 const bot=record(e.bot),sendApi=bot.sendApi;if(typeof sendApi==='function')event.bot={sendApi:async(action,payload)=>sendApi.call(e.bot,action,payload)}
 const getReply=e.getReply;if(typeof getReply==='function')event.getReply=async()=>getReply.call(value)
 const assets=record(e._groupContextAssets);event._groupContextAssets={reply:assets.reply,media:Array.isArray(assets.media)?assets.media:[]}
 return event
}
const EXCEL_EXTENSIONS = new Set([".xlsx", ".xlsm", ".xltx", ".xltm"])
const LEGACY_EXCEL_EXTENSIONS = new Set([".xls", ".xlt"])
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024
const RECENT_FILE_MAX_AGE_SECONDS = 30 * 60
const GROUP_FILE_MAX_DEPTH = 5
const GROUP_FILE_MAX_FOLDERS = 100
const GROUP_FILE_MAX_FILES = 500

function safeFileName(value:unknown = "") {
  const text = String(value || "").trim().replace(/[\\/]/g, "_")
  return text.slice(0, 180)
}

function getFileExtension(fileName = "", source = "") {
  const fromName = path.extname(String(fileName || "").split(/[?#]/)[0] || "").toLowerCase()
  if (fromName) return fromName
  try {
    return path.extname(new URL(String(source || "")).pathname).toLowerCase()
  } catch {
    return ""
  }
}

export function isSupportedExcelFile(fileName = "", source = "") {
  return EXCEL_EXTENSIONS.has(getFileExtension(fileName, source))
}

export function isLegacyExcelFile(fileName = "", source = "") {
  return LEGACY_EXCEL_EXTENSIONS.has(getFileExtension(fileName, source))
}

function extractFileCandidates(segments:unknown = [], origin = "message", senderUserId:unknown = "") {
  const result = []
  for (const segment of normalizeMessageSegments(segments)) {
    if (segment?.type !== "file") continue
    const data = getSegmentData(segment)
    const source = String(segment.url || segment.file_url || data.url || data.file_url || "").trim()
    const fileName = safeFileName(segment.name || data.name || segment.file_name || data.file_name || segment.file || data.file)
    const fileId = String(segment.file_id || segment.fid || data.file_id || data.fid || data.id || "").trim()
    const busId = String(segment.busid || segment.bus_id || data.busid || data.bus_id || "").trim()
    result.push({ source, fileName, fileId, busId, origin, senderUserId: String(senderUserId || "") })
  }
  return result
}

function responseData(response:unknown):Record<string,unknown> {
 const outer=record(response),data=record(outer.data)
 return record(data.data || outer.data || response)
}

function responseUrl(response:unknown) {
  const data = responseData(response)
  return String(data.url || data.file_url || data.download_url || "").trim()
}

async function resolveCandidateUrl(candidate:FileCandidate, e:ExcelEvent = {}) {
  if (candidate.fileId) {
    try {
      const direct = e.group_id
        ? await e?.group?.getFileUrl?.(candidate.fileId)
        : await e?.friend?.getFileUrl?.(candidate.fileId)
      if (typeof direct === "string" && /^https?:\/\//i.test(direct)) return direct
      const directUrl = responseUrl(direct)
      if (directUrl) return directUrl
    } catch {}
    try {
      if (e?.bot?.sendApi) {
        const apiName = e.group_id ? "get_group_file_url" : "get_private_file_url"
        const payload = e.group_id
          ? {
              group_id: e.group_id,
              file_id: candidate.fileId,
              ...(candidate.busId ? { busid: candidate.busId } : {})
            }
          : { user_id: e.user_id, file_id: candidate.fileId }
        const apiUrl = responseUrl(await e.bot.sendApi(apiName, payload))
        if (apiUrl) return apiUrl
      }
    } catch {}
  }
  return /^https?:\/\//i.test(candidate.source || "") ? candidate.source : ""
}

function normalizeGroupFilesPayload(response:unknown) {
  const data = responseData(response)
  return {
    files: Array.isArray(data.files) ? data.files : (Array.isArray(data.file_list) ? data.file_list : []),
    folders: Array.isArray(data.folders) ? data.folders : (Array.isArray(data.folder_list) ? data.folder_list : [])
  }
}

function normalizeGroupFile(file:Record<string,unknown> = {}, folderPath = "/") {
  const fileName = safeFileName(file.file_name || file.name || file.file || "")
  const fileId = String(file.file_id || file.id || file.fid || "").trim()
  const busId = String(file.busid || file.bus_id || "").trim()
  return {
    fileName,
    fileId,
    busId,
    folderPath,
    fullPath: `${folderPath === "/" ? "" : folderPath}/${fileName}` || fileName,
    size: Number(file.file_size || file.size || 0),
    uploadTime: Number(file.upload_time || file.modify_time || file.time || 0),
    uploaderId: String(file.uploader || file.uploader_id || file.user_id || ""),
    uploaderName: String(file.uploader_name || file.user_name || ""),
    origin: "group_file"
  }
}

function normalizeGroupFolder(folder:Record<string,unknown> = {}, parentPath = "/") {
  const folderId = String(folder.folder_id || folder.id || "").trim()
  const folderName = safeFileName(folder.folder_name || folder.name || folderId || "未命名目录")
  const folderPath = `${parentPath === "/" ? "" : parentPath}/${folderName}` || "/"
  return { folderId, folderName, folderPath }
}

export async function listGroupExcelFiles(e:ExcelEvent = {}, options:ExcelFileOptions = {}) {
  if (!e?.group_id || !e?.bot?.sendApi) throw new Error("只有群聊中才能读取群文件仓库")
  const maxDepth = Math.max(1, Math.min(8, Number(options.maxDepth) || GROUP_FILE_MAX_DEPTH))
  const maxFolders = Math.max(1, Math.min(300, Number(options.maxFolders) || GROUP_FILE_MAX_FOLDERS))
  const maxFiles = Math.max(1, Math.min(2000, Number(options.maxFiles) || GROUP_FILE_MAX_FILES))
  const queue = [{ folderId: "", folderPath: "/", depth: 0 }]
  const visited = new Set()
  const files = []
  let scannedFolders = 0
  let truncated = false

  while (queue.length) {
    const current = queue.shift()!
    const key = current.folderId || "__root__"
    if (visited.has(key)) continue
    visited.add(key)
    if (++scannedFolders > maxFolders) {
      truncated = true
      break
    }
    let response
    try {
      response = current.folderId
        ? await e.bot.sendApi("get_group_files_by_folder", { group_id: e.group_id, folder_id: current.folderId })
        : await e.bot.sendApi("get_group_root_files", { group_id: e.group_id })
    } catch (error) {
      if (!current.folderId) throw new Error(`读取群文件列表失败: ${error instanceof Error?error.message:String(error)}`)
      continue
    }
    const payload = normalizeGroupFilesPayload(response)
    for (const file of payload.files) {
      const normalized = normalizeGroupFile(record(file), current.folderPath)
      if (!normalized.fileId || (!isSupportedExcelFile(normalized.fileName) && !isLegacyExcelFile(normalized.fileName))) continue
      files.push(normalized)
      if (files.length >= maxFiles) {
        truncated = true
        break
      }
    }
    if (truncated) break
    if (current.depth >= maxDepth) {
      if (payload.folders.length) truncated = true
      continue
    }
    for (const folder of payload.folders) {
      const normalized = normalizeGroupFolder(record(folder), current.folderPath)
      if (normalized.folderId && !visited.has(normalized.folderId)) {
        queue.push({ ...normalized, depth: current.depth + 1 })
      }
    }
  }

  const query = String(options.query || options.fileName || "").trim().toLowerCase()
  const folderQuery = String(options.folderPath || "").trim().toLowerCase().replace(/\/$/, "")
  const filtered = files.filter(file => {
    if (folderQuery && !file.folderPath.toLowerCase().includes(folderQuery)) return false
    if (!query) return true
    return file.fileName.toLowerCase().includes(query) || file.fullPath.toLowerCase().includes(query)
  })
  return { files: filtered, totalExcelFiles: files.length, scannedFolders, truncated, query: String(options.query || options.fileName || "").trim() }
}

function formatGroupFileCandidates(files:ReturnType<typeof normalizeGroupFile>[] = [], maxItems = 12) {
  return files.slice(0, maxItems).map(file => file.fullPath).join("、")
}

async function resolveGroupExcelCandidate(e:ExcelEvent = {}, options:ExcelFileOptions = {}) {
  const requestedName = safeFileName(options.fileName)
  const listing = await listGroupExcelFiles(e, {
    fileName: requestedName,
    folderPath: options.folderPath
  })
  const supported = listing.files.filter(file => isSupportedExcelFile(file.fileName))
  const legacy = listing.files.filter(file => isLegacyExcelFile(file.fileName))
  if (!requestedName) {
    if (supported.length === 1) return supported[0]
    if (supported.length > 1) {
      throw new Error(`群文件中有多个 Excel，请指定文件名或目录: ${formatGroupFileCandidates(supported)}`)
    }
    if (legacy.length) throw new Error("群文件中只找到旧版 .xls，请先另存为 .xlsx 后重新上传")
    return null
  }
  const lowered = requestedName.toLowerCase()
  const exact = supported.filter(file => file.fileName.toLowerCase() === lowered || file.fullPath.toLowerCase() === lowered)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) throw new Error(`群文件中存在多个同名 Excel，请指定目录: ${formatGroupFileCandidates(exact)}`)
  if (supported.length === 1) return supported[0]
  if (supported.length > 1) throw new Error(`群文件中有多个匹配项，请说清文件名或目录: ${formatGroupFileCandidates(supported)}`)
  if (legacy.length) throw new Error("匹配到的是旧版 .xls，请先另存为 .xlsx 后重新上传")
  return null
}

async function getRecentMessageCandidates(e:ExcelEvent = {}) {
  if (!e?.bot?.sendApi) return []
  try {
    const apiName = e.group_id ? "get_group_msg_history" : "get_private_msg_history"
    const payload = e.group_id ? { group_id: e.group_id, count: 30 } : { user_id: e.user_id, count: 30 }
    const response = await e.bot.sendApi(apiName, payload)
    const data = responseData(response)
    const messages = Array.isArray(data.messages) ? data.messages.map(record) : []
    const nowSeconds = Math.floor(Date.now() / 1000)
    return messages
      .filter(message => {
        const senderId = record(message?.sender).user_id || message?.user_id || message?.sender_id
        if (senderId && String(senderId) !== String(e.user_id || "")) return false
        const timestamp = Number(message?.time || message?.timestamp || 0)
        return !timestamp || Math.abs(nowSeconds - timestamp) <= RECENT_FILE_MAX_AGE_SECONDS
      })
      .sort((a, b) => Number(b?.time || b?.timestamp || 0) - Number(a?.time || a?.timestamp || 0))
      .flatMap(message => extractFileCandidates(message?.message || message?.content || [], "recent", record(message?.sender).user_id || message?.user_id))
  } catch {
    return []
  }
}

export async function resolveExcelFileContext(e:ExcelEvent = {}, options:ExcelFileOptions = {}):Promise<ExcelFile> {
  const explicitUrl = String(options.fileUrl || "").trim()
  const explicitName = safeFileName(options.fileName)
  const candidates:FileCandidate[] = []
  if (explicitUrl) candidates.push({ source: explicitUrl, fileName: explicitName, fileId: "", origin: "explicit" })
  candidates.push(...extractFileCandidates(e?.message, "current", e?.user_id))

  let reply:unknown = e?._groupContextAssets?.reply || null
  if (!reply && e?.getReply) {
    try { reply = await e.getReply() } catch {}
  }
  if (reply) {
    const replyRecord=record(reply)
    candidates.push(...extractFileCandidates(replyRecord.message || replyRecord.content, "reply", record(replyRecord.sender).user_id || replyRecord.user_id))
  }
  for (const value of (e?._groupContextAssets?.media || [])) {
    const asset=record(value)
    if (asset?.type !== "file") continue
    candidates.push({
      source: String(asset.source || ""),
      fileName: safeFileName(asset.name || asset.fileName || asset.label),
      fileId: String(asset.fileId || ""),
      busId: String(asset.busId || ""),
      origin: String(asset.origin || "context")
    })
  }
  if (!candidates.some(candidate => isSupportedExcelFile(candidate.fileName, candidate.source) || isLegacyExcelFile(candidate.fileName, candidate.source))) {
    candidates.push(...await getRecentMessageCandidates(e))
  }

  const seen = new Set()
  let legacyCandidate = null
  for (const candidate of candidates) {
    const key = `${candidate.fileId}:${candidate.source}:${candidate.fileName}`
    if (seen.has(key)) continue
    seen.add(key)
    if (isLegacyExcelFile(candidate.fileName, candidate.source)) {
      legacyCandidate ||= candidate
      continue
    }
    if (!isSupportedExcelFile(candidate.fileName, candidate.source)) continue
    const fileUrl = await resolveCandidateUrl(candidate, e)
    if (!fileUrl) continue
    return {
      fileUrl,
      fileName: candidate.fileName || safeFileName(new URL(fileUrl).pathname.split("/").pop()) || "workbook.xlsx",
      origin: candidate.origin,
      ...(candidate.fileId ? { fileId: candidate.fileId } : {}),
      ...(candidate.busId ? { busId: candidate.busId } : {})
    }
  }
  if (legacyCandidate && !["recent"].includes(legacyCandidate.origin)) {
    throw new Error("暂不支持旧版 .xls 二进制工作簿，请先用 Excel/WPS 另存为 .xlsx 后再发给我")
  }
  if (e?.group_id) {
    const groupCandidate = await resolveGroupExcelCandidate(e, options)
    if (groupCandidate) {
      const fileUrl = await resolveCandidateUrl(groupCandidate, e)
      if (!fileUrl) throw new Error(`无法获取群文件下载链接: ${groupCandidate.fullPath}`)
      return {
        fileUrl,
        fileName: groupCandidate.fileName,
        origin: "group_file",
        fileId: groupCandidate.fileId,
        busId: groupCandidate.busId,
        folderPath: groupCandidate.folderPath,
        fullPath: groupCandidate.fullPath
      }
    }
  }
  if (legacyCandidate) throw new Error("暂不支持旧版 .xls 二进制工作簿，请先用 Excel/WPS 另存为 .xlsx 后再发给我")
  throw new Error("当前消息、引用、最近上传和群文件仓库中都没有找到可读取的 .xlsx/.xlsm 工作簿")
}

function isPrivateIp(address = "") {
  const ip = String(address || "").toLowerCase()
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number)
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && (parts[1] || 0) >= 16 && (parts[1] || 0) <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 100 && (parts[1] || 0) >= 64 && (parts[1] || 0) <= 127) ||
      (parts[0] === 198 && [18, 19].includes(parts[1] || 0)) || (parts[0] || 0) >= 224
  }
  if (net.isIPv6(ip)) {
    return ip === "::" || ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") ||
      ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb") ||
      ip.startsWith("::ffff:127.") || ip.startsWith("::ffff:10.") || ip.startsWith("::ffff:192.168.")
  }
  return true
}

async function assertSafeRemoteUrl(value = "") {
  let url
  try { url = new URL(String(value || "")) } catch { throw new Error("Excel 文件链接无效") }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("只允许读取 HTTP/HTTPS Excel 文件链接")
  if (!url.hostname || ["localhost", "localhost.localdomain"].includes(url.hostname.toLowerCase())) {
    throw new Error("不允许读取本机或内网地址")
  }
  const resolved = await dns.lookup(url.hostname, { all: true })
  if (!resolved.length || resolved.some(item => isPrivateIp(item.address))) throw new Error("不允许读取本机或内网地址")
  return url
}

export async function downloadExcelBuffer(fileUrl:string, options:ExcelFileOptions = {}) {
  const maxBytes = Math.max(1024, Math.min(30 * 1024 * 1024, Number(options.maxBytes) || DEFAULT_MAX_BYTES))
  const timeoutMs = Math.max(1000, Math.min(60_000, Number(options.timeoutMs) || 20_000))
  let current = await assertSafeRemoteUrl(fileUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetch(current, { redirect: "manual", signal: controller.signal })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")
        if (!location || redirects === 3) throw new Error("Excel 文件下载重定向次数过多")
        current = await assertSafeRemoteUrl(new URL(location, current).toString())
        continue
      }
      if (!response.ok) throw new Error(`Excel 文件下载失败: HTTP ${response.status}`)
      const declared = Number(response.headers.get("content-length") || 0)
      if (declared > maxBytes) throw new Error(`Excel 文件过大: ${declared} 字节（上限 ${maxBytes}）`)
      const chunks = []
      let total = 0
      if(!response.body)throw new Error("Excel 文件下载响应为空")
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk)
        total += buffer.length
        if (total > maxBytes) throw new Error(`Excel 文件超过大小上限 ${maxBytes} 字节`)
        chunks.push(buffer)
      }
      return Buffer.concat(chunks)
    }
    throw new Error("Excel 文件下载失败")
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`Excel 文件下载超时（${timeoutMs}ms）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}
