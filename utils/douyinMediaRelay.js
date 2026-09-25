import fs from "fs"
import os from "os"
import path from "path"
import { Readable, Transform } from "stream"
import { pipeline } from "stream/promises"
import { DOUYIN_ARCHIVE_VIDEO_MAX_SECONDS, shouldAttachDouyinVideo } from "./douyinMessage.js"
import { buildMediaArtifactKey } from "./messagePipeline/mediaArtifactStore.js"
import { fetchDownloadToFile } from "./parallelDownload.js"

export const DOUYIN_ARCHIVE_VIDEO_MAX_BYTES = 512 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000
// 抖音图集上限 35 张;合并转发里放太多节点会显著拖慢发送,超出的截断并说明
const DOUYIN_NOTE_IMAGE_MAX_COUNT = 20
const DOUYIN_NOTE_IMAGE_MAX_BYTES = 32 * 1024 * 1024
const DOUYIN_NOTE_IMAGE_DOWNLOAD_TIMEOUT_MS = 60 * 1000

function douyinNoteImageExtension(url = "") {
  const match = String(url).split("?")[0].match(/\.(jpe?g|png|webp|heic|avif)$/i)
  return match ? `.${match[1].toLowerCase().replace("jpeg", "jpg")}` : ".jpg"
}

export async function downloadDouyinNoteImage(url = "", { logger = globalThis.logger } = {}) {
  if (!/^https?:\/\//i.test(String(url || ""))) return null
  const dir = path.join(os.tmpdir(), "shiloh-plugin-douyin-note")
  await fs.promises.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${Date.now()}-${Math.random().toString(16).slice(2)}${douyinNoteImageExtension(url)}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOUYIN_NOTE_IMAGE_DOWNLOAD_TIMEOUT_MS)
  let completed = false
  try {
    const response = await fetch(url, {
      headers: { Referer: "https://www.douyin.com/", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36" },
      signal: controller.signal
    })
    if (!response.ok || !response.body) return null
    const contentLength = Number(response.headers.get("content-length") || 0)
    if (contentLength > DOUYIN_NOTE_IMAGE_MAX_BYTES) return null
    let downloadedBytes = 0
    const limitStream = new Transform({
      transform(chunk, encoding, callback) {
        downloadedBytes += chunk.length
        if (downloadedBytes > DOUYIN_NOTE_IMAGE_MAX_BYTES) return callback(new Error("抖音图集单张超过32MB安全上限"))
        callback(null, chunk)
      }
    })
    await pipeline(Readable.fromWeb(response.body), limitStream, fs.createWriteStream(filePath))
    const stat = await fs.promises.stat(filePath)
    completed = stat.size > 0
    return completed ? filePath : null
  } catch (error) {
    logger?.warn?.(`[MessageArchive] 抖音图集下载失败(${String(url).slice(0, 80)}): ${error.message}`)
    return null
  } finally {
    clearTimeout(timer)
    if (!completed) await fs.promises.unlink(filePath).catch(() => {})
  }
}

export async function downloadDouyinArchiveVideo(card = {}, { logger = globalThis.logger } = {}) {
  if (!card.play_url) return null
  const dir = path.join(os.tmpdir(), "shiloh-plugin-douyin-archive")
  await fs.promises.mkdir(dir, { recursive: true })
  const safeId = String(card.aweme_id || "video").replace(/[^A-Za-z0-9_-]/g, "")
  const filePath = path.join(dir, `${safeId}-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`)
  let completed = false
  try {
    // 抖音 CDN 单流通常不限速,但走同一分片工具:支持 Range 就并发,不支持自动单流
    await fetchDownloadToFile(card.play_url, filePath, {
      headers: { Referer: card.page_url || "https://www.douyin.com/", "User-Agent": "Mozilla/5.0 (Linux; Android 10; K)" },
      maxBytes: DOUYIN_ARCHIVE_VIDEO_MAX_BYTES,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      logger
    })
    const stat = await fs.promises.stat(filePath)
    completed = stat.size > 0 && stat.size <= DOUYIN_ARCHIVE_VIDEO_MAX_BYTES
    return completed ? filePath : null
  } catch (error) {
    logger?.warn?.(`[MessageArchive] 抖音视频本体下载失败: ${error.message}`)
    return null
  } finally {
    if (!completed) await fs.promises.unlink(filePath).catch(() => {})
  }
}

export async function buildDouyinArchiveRelaySegments(card = {}, {
  segmentApi = globalThis.segment,
  logger = globalThis.logger,
  artifactStore = null,
  onTiming = null
} = {}) {
  const segments = []
  const tempFiles = []
  const artifactLeases = []
  // 图集(图文作品)节点:每张图独立节点,由 MediaOutbox 放进同一条合并转发
  const imageNodes = []
  if (!card || card.type !== "douyin") return { segments, imageNodes, tempFiles, artifactLeases }
  const noteImages = (Array.isArray(card.images) ? card.images : [])
    .map(url => String(url || "").trim())
    .filter(url => /^https?:\/\//i.test(url))
  const attachVideo = shouldAttachDouyinVideo(card, DOUYIN_ARCHIVE_VIDEO_MAX_SECONDS)
  // 有图集时封面不再单独内联(图集第一张通常就是封面),避免同图重复
  if (card.cover_url && segmentApi?.image && !noteImages.length) segments.push("\n", segmentApi.image(card.cover_url))

  if (noteImages.length && !attachVideo) {
    const downloadStartedAt = Date.now()
    const capped = noteImages.slice(0, DOUYIN_NOTE_IMAGE_MAX_COUNT)
    const baseKey = artifactStore ? buildMediaArtifactKey("douyin", card) : ""
    for (let index = 0; index < capped.length; index++) {
      const imageUrl = capped[index]
      const key = baseKey ? `${baseKey}#img${index}` : ""
      const useArtifactStore = Boolean(artifactStore && key)
      const lease = useArtifactStore
        ? await artifactStore.acquire(key, () => downloadDouyinNoteImage(imageUrl, { logger }))
        : null
      const filePath = useArtifactStore ? lease?.filePath : await downloadDouyinNoteImage(imageUrl, { logger })
      if (!filePath) {
        if (lease) await lease.release?.().catch?.(() => {})
        continue
      }
      if (lease) artifactLeases.push(lease)
      else tempFiles.push(filePath)
      if (segmentApi?.image) imageNodes.push(segmentApi.image(filePath))
    }
    onTiming?.("download", Date.now() - downloadStartedAt)
    if (noteImages.length > capped.length) segments.push(`\n（图集共${noteImages.length}张，仅附前${capped.length}张）`)
    if (imageNodes.length) {
      logger?.info?.(`[抖音图集] 已就绪 ${imageNodes.length}/${noteImages.length} 张,将并入合并转发`)
    } else {
      segments.push("\n（图集图片暂时获取失败，已保留作品页面）")
    }
    return { segments, imageNodes, tempFiles, artifactLeases }
  }

  if (!attachVideo) {
    if (Number(card.duration || 0) > DOUYIN_ARCHIVE_VIDEO_MAX_SECONDS) segments.push("\n（视频超过30分钟，未附带视频本体）")
    return { segments, imageNodes, tempFiles, artifactLeases }
  }
  if (!segmentApi?.video) return { segments, imageNodes, tempFiles, artifactLeases }
  const downloadStartedAt = Date.now()
  const key = buildMediaArtifactKey("douyin", card)
  const useArtifactStore = Boolean(artifactStore && key)
  const lease = useArtifactStore
    ? await artifactStore.acquire(key, () => downloadDouyinArchiveVideo(card, { logger }))
    : null
  const filePath = useArtifactStore ? lease?.filePath : await downloadDouyinArchiveVideo(card, { logger })
  onTiming?.("download", Date.now() - downloadStartedAt)
  if (!filePath) {
    segments.push("\n（视频本体暂时获取失败，已保留视频页面）")
    return { segments, imageNodes, tempFiles, artifactLeases }
  }
  if (lease) artifactLeases.push(lease)
  else tempFiles.push(filePath)
  segments.push("\n", segmentApi.video(filePath))
  return { segments, imageNodes, tempFiles, artifactLeases }
}

export async function cleanupDouyinArchiveRelayFiles(tempFiles = []) {
  await Promise.all((Array.isArray(tempFiles) ? tempFiles : []).map(file => fs.promises.unlink(file).catch(() => {})))
}
