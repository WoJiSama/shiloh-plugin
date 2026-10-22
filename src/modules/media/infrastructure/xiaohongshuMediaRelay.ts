import fs from "fs"
import os from "os"
import path from "path"
import { Readable, Transform } from "stream"
import { pipeline } from "stream/promises"
import {errorText,type XiaohongshuCard,type MediaLogger} from "./xiaohongshuTypes.js"
import {normalizeXiaohongshuImageUrl} from "./xiaohongshuMessage.js"
import { buildMediaArtifactKey } from "../../messaging/infrastructure/mediaArtifactStore.js"
import { fetchDownloadToFile } from "../../shared/infrastructure/parallelDownload.js"

interface Lease {filePath?:string;release?():Promise<unknown>}
interface Store {acquire(key:string,download:()=>Promise<string|null>):Promise<Lease|null>}
interface SegmentApi {image?(path:string):unknown;video?(path:string):unknown}
export interface XiaohongshuRelayOptions {maxImages?:number;maxImageBytes?:number;downloadTimeoutMs?:number;maxVideoSeconds?:number;maxVideoBytes?:number;videoDownloadTimeoutMs?:number}

// 小红书笔记单图上限:图床原图普遍 1-8MB;合并转发节点过多会显著拖慢发送
const XHS_NOTE_IMAGE_MAX_COUNT = 20
const XHS_NOTE_IMAGE_MAX_BYTES = 32 * 1024 * 1024
const XHS_NOTE_IMAGE_DOWNLOAD_TIMEOUT_MS = 60 * 1000
const XHS_ARCHIVE_VIDEO_MAX_SECONDS = 1800
const XHS_ARCHIVE_VIDEO_MAX_BYTES = 256 * 1024 * 1024
const XHS_ARCHIVE_VIDEO_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

function xiaohongshuImageExtension(url = "") {
  const match = (String(url).split("?")[0] || "").match(/\.(jpe?g|png|webp|heic|avif|gif)$/i)
  return match ? `.${match[1]!.toLowerCase().replace("jpeg", "jpg")}` : ".jpg"
}

export function createXiaohongshuMediaRelay(ports:{segmentApi?:SegmentApi;logger?:MediaLogger;fetchImpl?:typeof globalThis.fetch} = {}) {
const fetch:typeof globalThis.fetch=(input,init)=>(ports.fetchImpl ?? globalThis.fetch)(input,init)

function shouldAttachXiaohongshuVideo(card:XiaohongshuCard = {}, maxSeconds = XHS_ARCHIVE_VIDEO_MAX_SECONDS) {
  return Boolean(card.play_url) && Number(card.duration || 0) > 0 && Number(card.duration || 0) <= Math.max(1, Number(maxSeconds) || XHS_ARCHIVE_VIDEO_MAX_SECONDS)
}

// 视频直链带签名短时有效,解析后立即下载;走同一分片工具(Range 并发),失败由上层降级到封面图
async function downloadXiaohongshuVideoUrl(playUrl:string, noteId = "video", { maxBytes = XHS_ARCHIVE_VIDEO_MAX_BYTES, timeoutMs = XHS_ARCHIVE_VIDEO_DOWNLOAD_TIMEOUT_MS, logger = ports.logger }:{maxBytes?:number;timeoutMs?:number;logger?:MediaLogger|undefined} = {}) {
  if (!/^https?:\/\//i.test(String(playUrl || ""))) return null
  const dir = path.join(os.tmpdir(), "shiloh-plugin-xiaohongshu-video")
  await fs.promises.mkdir(dir, { recursive: true })
  const safeId = String(noteId || "video").replace(/[^A-Za-z0-9_-]/g, "")
  const filePath = path.join(dir, `${safeId}-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`)
  let completed = false
  try {
    await fetchDownloadToFile(playUrl, filePath, {
      headers: { Referer: "https://www.xiaohongshu.com/", "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36" },
      maxBytes,
      timeoutMs,
      logger
    })
    const stat = await fs.promises.stat(filePath)
    completed = stat.size > 0 && stat.size <= maxBytes
    return completed ? filePath : null
  } catch (error) {
    logger?.warn?.(`[小红书] 视频下载失败(${String(playUrl).slice(0, 70)}): ${errorText(error)}`)
    return null
  } finally {
    if (!completed) await fs.promises.unlink(filePath).catch(() => {})
  }
}

function downloadXiaohongshuVideo(card:XiaohongshuCard = {}, options:{maxBytes?:number;timeoutMs?:number;logger?:MediaLogger|undefined} = {}) {
  return downloadXiaohongshuVideoUrl(String(card.play_url || ""), String(card.note_id || "video"), options)
}

async function downloadXiaohongshuImage(rawUrl = "", { maxBytes = XHS_NOTE_IMAGE_MAX_BYTES, timeoutMs = XHS_NOTE_IMAGE_DOWNLOAD_TIMEOUT_MS, logger = ports.logger }:{maxBytes?:number;timeoutMs?:number;logger?:MediaLogger|undefined} = {}) {
  const url = normalizeXiaohongshuImageUrl(rawUrl)
  if (!/^https?:\/\//i.test(String(url || ""))) return null
  const dir = path.join(os.tmpdir(), "shiloh-plugin-xiaohongshu-note")
  await fs.promises.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${Date.now()}-${Math.random().toString(16).slice(2)}${xiaohongshuImageExtension(url)}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || XHS_NOTE_IMAGE_DOWNLOAD_TIMEOUT_MS))
  let completed = false
  try {
    // sns-img 图床需带小红书 Referer 防盗链(实测 2026-10)
    const response = await fetch(url, {
      headers: { Referer: "https://www.xiaohongshu.com/", "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36" },
      signal: controller.signal
    })
    if (!response.ok || !response.body) return null
    const contentLength = Number(response.headers.get("content-length") || 0)
    if (contentLength > maxBytes) return null
    let downloadedBytes = 0
    const limitStream = new Transform({
      transform(chunk, encoding, callback) {
        downloadedBytes += chunk.length
        if (downloadedBytes > maxBytes) return callback(new Error("小红书图片超过大小上限"))
        callback(null, chunk)
      }
    })
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), limitStream, fs.createWriteStream(filePath))
    const stat = await fs.promises.stat(filePath)
    completed = stat.size > 0
    return completed ? filePath : null
  } catch (error) {
    logger?.warn?.(`[小红书] 图片下载失败(${String(url).slice(0, 80)}): ${errorText(error)}`)
    return null
  } finally {
    clearTimeout(timer)
    if (!completed) await fs.promises.unlink(filePath).catch(() => {})
  }
}

async function buildXiaohongshuRelaySegments(card:XiaohongshuCard = {}, {
  segmentApi = ports.segmentApi,
  logger = ports.logger,
  artifactStore = null,
  onTiming = null,
  xiaohongshuRelay = {}
}:{segmentApi?:SegmentApi|undefined;logger?:MediaLogger|undefined;artifactStore?:Store|null;onTiming?:((kind:string,ms:number)=>void)|null;xiaohongshuRelay?:XiaohongshuRelayOptions} = {}) {
  const segments:unknown[] = []
  const tempFiles:string[] = []
  const artifactLeases:Lease[] = []
  // 图集节点:每张图独立节点,由 MediaOutbox 放进同一条合并转发(与抖音图集一致)
  const imageNodes:unknown[] = []
  // 简介全文单独成转发节点,不在信息头部裁剪展示
  const textNodes:string[] = []
  if (!card || card.type !== "xiaohongshu") return { segments, imageNodes, textNodes, tempFiles, artifactLeases }
  const description = String(card.description || "").trim()
  if (description && description !== card.title) textNodes.push(description)
  const maxImages = Math.min(XHS_NOTE_IMAGE_MAX_COUNT, Math.max(1, Number(xiaohongshuRelay.maxImages) || XHS_NOTE_IMAGE_MAX_COUNT))
  const maxImageBytes = Math.max(1, Number(xiaohongshuRelay.maxImageBytes) || XHS_NOTE_IMAGE_MAX_BYTES)
  const timeoutMs = Number(xiaohongshuRelay.downloadTimeoutMs) || XHS_NOTE_IMAGE_DOWNLOAD_TIMEOUT_MS
  const maxVideoSeconds = Math.max(1, Number(xiaohongshuRelay.maxVideoSeconds) || XHS_ARCHIVE_VIDEO_MAX_SECONDS)
  const maxVideoBytes = Math.max(1, Number(xiaohongshuRelay.maxVideoBytes) || XHS_ARCHIVE_VIDEO_MAX_BYTES)
  const videoDownloadTimeoutMs = Number(xiaohongshuRelay.videoDownloadTimeoutMs) || XHS_ARCHIVE_VIDEO_DOWNLOAD_TIMEOUT_MS
  // 原位清洗保与 live_photos 的下标对齐:非法槽位置 "" 由循环跳过,不做剔除
  const noteImages = (Array.isArray(card.images) ? card.images : [])
    .map(url => {
      const normalized = normalizeXiaohongshuImageUrl(url)
      return /^https?:\/\//i.test(String(normalized || "")) ? normalized : ""
    })
  const images = noteImages.some(Boolean) ? noteImages : (card.cover_url ? [normalizeXiaohongshuImageUrl(card.cover_url)].filter(Boolean) : [])

  // 真实视频笔记优先搬视频本体(直链短时有效,组装阶段立即下载);
  // 时长超限直接跳过,下载失败降级为封面图集;图文笔记不走此路径
  if (card.media_kind === "video" && card.play_url) {
    if (Number(card.duration || 0) > maxVideoSeconds) {
      segments.push(`\n（视频超过${Math.floor(maxVideoSeconds / 60)}分钟，未附带视频本体）`)
    } else if (shouldAttachXiaohongshuVideo(card, maxVideoSeconds)) {
      if (!segmentApi?.video) return { segments, imageNodes, textNodes, tempFiles, artifactLeases }
      const videoDownloadStartedAt = Date.now()
      const key = buildMediaArtifactKey("xiaohongshu", card)
      const useArtifactStore = Boolean(artifactStore && key)
      const lease = useArtifactStore
        ? await artifactStore!.acquire(key, () => downloadXiaohongshuVideo(card, { maxBytes: maxVideoBytes, timeoutMs: videoDownloadTimeoutMs, logger }))
        : null
      const filePath = useArtifactStore ? lease?.filePath : await downloadXiaohongshuVideo(card, { maxBytes: maxVideoBytes, timeoutMs: videoDownloadTimeoutMs, logger })
      onTiming?.("download", Date.now() - videoDownloadStartedAt)
      if (filePath) {
        if (lease) artifactLeases.push(lease)
        else tempFiles.push(filePath)
        segments.push("\n", segmentApi.video(filePath))
        return { segments, imageNodes, textNodes, tempFiles, artifactLeases }
      }
      if (lease) await lease.release?.().catch?.(() => {})
      segments.push("\n（视频本体暂时获取失败，附封面与原文）")
    }
  }

  if (!images.length) {
    segments.push("\n（笔记图片暂时获取失败，已保留笔记页面）")
    return { segments, imageNodes, textNodes, tempFiles, artifactLeases }
  }
  const downloadStartedAt = Date.now()
  const capped = images.slice(0, maxImages)
  const baseKey = artifactStore ? buildMediaArtifactKey("xiaohongshu", card) : ""
  // 实况照片与图集同下标对齐:该槽位有实况直链则发实况视频,下载失败回退静态图
  // 原位清洗保下标对齐:空槽/非法链接置 "" 而不是剔除
  const livePhotos = (Array.isArray(card.live_photos) ? card.live_photos : []).map(url => {
    const text = String(url || "").trim()
    return /^https?:\/\//i.test(text) ? text : ""
  })
  let liveSent = 0
  for (let index = 0; index < capped.length; index++) {
    const liveUrl = index < livePhotos.length ? livePhotos[index]! : ""
    if (liveUrl && segmentApi?.video) {
      const liveKey = baseKey ? `${baseKey}#live${index}` : ""
      const useLiveStore = Boolean(artifactStore && liveKey)
      const liveLease = useLiveStore
        ? await artifactStore!.acquire(liveKey, () => downloadXiaohongshuVideoUrl(liveUrl, `${card.note_id || "note"}-live${index}`, { maxBytes: maxVideoBytes, timeoutMs: videoDownloadTimeoutMs, logger }))
        : null
      const livePath = useLiveStore ? liveLease?.filePath : await downloadXiaohongshuVideoUrl(liveUrl, `${card.note_id || "note"}-live${index}`, { maxBytes: maxVideoBytes, timeoutMs: videoDownloadTimeoutMs, logger })
      if (livePath) {
        if (liveLease) artifactLeases.push(liveLease)
        else tempFiles.push(livePath)
        segments.push("\n", segmentApi.video(livePath))
        liveSent++
        continue
      }
      if (liveLease) await liveLease.release?.().catch?.(() => {})
    }
    const imageUrl = capped[index]!
    if (!imageUrl) continue
    const key = baseKey ? `${baseKey}#img${index}` : ""
    const useArtifactStore = Boolean(artifactStore && key)
    const lease = useArtifactStore
      ? await artifactStore!.acquire(key, () => downloadXiaohongshuImage(imageUrl, { maxBytes: maxImageBytes, timeoutMs, logger }))
      : null
    const filePath = useArtifactStore ? lease?.filePath : await downloadXiaohongshuImage(imageUrl, { maxBytes: maxImageBytes, timeoutMs, logger })
    if (!filePath) {
      if (lease) await lease.release?.().catch?.(() => {})
      continue
    }
    if (lease) artifactLeases.push(lease)
    else tempFiles.push(filePath)
    if (segmentApi?.image) imageNodes.push(segmentApi.image(filePath))
  }
  onTiming?.("download", Date.now() - downloadStartedAt)
  if (images.length > capped.length) segments.push(`\n（笔记共${images.length}张图，仅附前${capped.length}张）`)
  if (imageNodes.length || liveSent) {
    logger?.info?.(`[小红书] 已就绪 图${imageNodes.length}/${images.length} 实况${liveSent}段,将并入合并转发`)
  } else {
    segments.push("\n（笔记图片暂时获取失败，已保留笔记页面）")
  }
  return { segments, imageNodes, textNodes, tempFiles, artifactLeases }
}

async function cleanupXiaohongshuRelayFiles(tempFiles:string[] = []) {
  await Promise.all((Array.isArray(tempFiles) ? tempFiles : []).map(file => fs.promises.unlink(file).catch(() => {})))
}

return {downloadXiaohongshuImage,downloadXiaohongshuVideo,shouldAttachXiaohongshuVideo,buildXiaohongshuRelaySegments,cleanupXiaohongshuRelayFiles}
}
