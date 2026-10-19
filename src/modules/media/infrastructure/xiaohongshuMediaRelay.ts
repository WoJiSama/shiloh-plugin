import fs from "fs"
import os from "os"
import path from "path"
import { Readable, Transform } from "stream"
import { pipeline } from "stream/promises"
import {errorText,type XiaohongshuCard,type MediaLogger} from "./xiaohongshuTypes.js"
import {normalizeXiaohongshuImageUrl} from "./xiaohongshuMessage.js"
import { buildMediaArtifactKey } from "../../messaging/infrastructure/mediaArtifactStore.js"

interface Lease {filePath?:string;release?():Promise<unknown>}
interface Store {acquire(key:string,download:()=>Promise<string|null>):Promise<Lease|null>}
interface SegmentApi {image?(path:string):unknown;video?(path:string):unknown}
export interface XiaohongshuRelayOptions {maxImages?:number;maxImageBytes?:number;downloadTimeoutMs?:number}

// 小红书笔记单图上限:图床原图普遍 1-8MB;合并转发节点过多会显著拖慢发送
const XHS_NOTE_IMAGE_MAX_COUNT = 20
const XHS_NOTE_IMAGE_MAX_BYTES = 32 * 1024 * 1024
const XHS_NOTE_IMAGE_DOWNLOAD_TIMEOUT_MS = 60 * 1000

function xiaohongshuImageExtension(url = "") {
  const match = (String(url).split("?")[0] || "").match(/\.(jpe?g|png|webp|heic|avif|gif)$/i)
  return match ? `.${match[1]!.toLowerCase().replace("jpeg", "jpg")}` : ".jpg"
}

export function createXiaohongshuMediaRelay(ports:{segmentApi?:SegmentApi;logger?:MediaLogger;fetchImpl?:typeof globalThis.fetch} = {}) {
const fetch:typeof globalThis.fetch=(input,init)=>(ports.fetchImpl ?? globalThis.fetch)(input,init)

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
  if (!card || card.type !== "xiaohongshu") return { segments, imageNodes, tempFiles, artifactLeases }
  const maxImages = Math.min(XHS_NOTE_IMAGE_MAX_COUNT, Math.max(1, Number(xiaohongshuRelay.maxImages) || XHS_NOTE_IMAGE_MAX_COUNT))
  const maxImageBytes = Math.max(1, Number(xiaohongshuRelay.maxImageBytes) || XHS_NOTE_IMAGE_MAX_BYTES)
  const timeoutMs = Number(xiaohongshuRelay.downloadTimeoutMs) || XHS_NOTE_IMAGE_DOWNLOAD_TIMEOUT_MS
  const noteImages = (Array.isArray(card.images) ? card.images : [])
    .map(url => normalizeXiaohongshuImageUrl(url))
    .filter(url => /^https?:\/\//i.test(String(url || "")))
  const images = noteImages.length ? noteImages : (card.cover_url ? [normalizeXiaohongshuImageUrl(card.cover_url)].filter(Boolean) : [])
  if (!images.length) {
    segments.push("\n（笔记图片暂时获取失败，已保留笔记页面）")
    return { segments, imageNodes, tempFiles, artifactLeases }
  }
  const downloadStartedAt = Date.now()
  const capped = images.slice(0, maxImages)
  const baseKey = artifactStore ? buildMediaArtifactKey("xiaohongshu", card) : ""
  for (let index = 0; index < capped.length; index++) {
    const imageUrl = capped[index]!
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
  if (imageNodes.length) {
    logger?.info?.(`[小红书] 已就绪 ${imageNodes.length}/${images.length} 张图片,将并入合并转发`)
  } else {
    segments.push("\n（笔记图片暂时获取失败，已保留笔记页面）")
  }
  return { segments, imageNodes, tempFiles, artifactLeases }
}

async function cleanupXiaohongshuRelayFiles(tempFiles:string[] = []) {
  await Promise.all((Array.isArray(tempFiles) ? tempFiles : []).map(file => fs.promises.unlink(file).catch(() => {})))
}

return {downloadXiaohongshuImage,buildXiaohongshuRelaySegments,cleanupXiaohongshuRelayFiles}
}
