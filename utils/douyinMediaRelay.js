import fs from "fs"
import os from "os"
import path from "path"
import { Readable, Transform } from "stream"
import { pipeline } from "stream/promises"
import { DOUYIN_ARCHIVE_VIDEO_MAX_SECONDS, shouldAttachDouyinVideo } from "./douyinMessage.js"
import { buildMediaArtifactKey } from "./messagePipeline/mediaArtifactStore.js"

export const DOUYIN_ARCHIVE_VIDEO_MAX_BYTES = 512 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

export async function downloadDouyinArchiveVideo(card = {}, { logger = globalThis.logger } = {}) {
  if (!card.play_url) return null
  const dir = path.join(os.tmpdir(), "shiloh-plugin-douyin-archive")
  await fs.promises.mkdir(dir, { recursive: true })
  const safeId = String(card.aweme_id || "video").replace(/[^A-Za-z0-9_-]/g, "")
  const filePath = path.join(dir, `${safeId}-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  let completed = false
  try {
    const response = await fetch(card.play_url, {
      headers: { Referer: card.page_url || "https://www.douyin.com/", "User-Agent": "Mozilla/5.0 (Linux; Android 10; K)" },
      signal: controller.signal
    })
    if (!response.ok || !response.body) return null
    const contentLength = Number(response.headers.get("content-length") || 0)
    if (contentLength > DOUYIN_ARCHIVE_VIDEO_MAX_BYTES) return null
    let downloadedBytes = 0
    const limitStream = new Transform({
      transform(chunk, encoding, callback) {
        downloadedBytes += chunk.length
        if (downloadedBytes > DOUYIN_ARCHIVE_VIDEO_MAX_BYTES) return callback(new Error("抖音视频本体超过512MB安全上限"))
        callback(null, chunk)
      }
    })
    await pipeline(Readable.fromWeb(response.body), limitStream, fs.createWriteStream(filePath))
    const stat = await fs.promises.stat(filePath)
    completed = stat.size > 0 && stat.size <= DOUYIN_ARCHIVE_VIDEO_MAX_BYTES
    return completed ? filePath : null
  } catch (error) {
    logger?.warn?.(`[MessageArchive] 抖音视频本体下载失败: ${error.message}`)
    return null
  } finally {
    clearTimeout(timer)
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
  if (!card || card.type !== "douyin") return { segments, tempFiles, artifactLeases }
  if (card.cover_url && segmentApi?.image) segments.push("\n", segmentApi.image(card.cover_url))
  if (!shouldAttachDouyinVideo(card, DOUYIN_ARCHIVE_VIDEO_MAX_SECONDS)) {
    if (Number(card.duration || 0) > DOUYIN_ARCHIVE_VIDEO_MAX_SECONDS) segments.push("\n（视频超过30分钟，未附带视频本体）")
    return { segments, tempFiles, artifactLeases }
  }
  if (!segmentApi?.video) return { segments, tempFiles, artifactLeases }
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
    return { segments, tempFiles, artifactLeases }
  }
  if (lease) artifactLeases.push(lease)
  else tempFiles.push(filePath)
  segments.push("\n", segmentApi.video(filePath))
  return { segments, tempFiles, artifactLeases }
}

export async function cleanupDouyinArchiveRelayFiles(tempFiles = []) {
  await Promise.all((Array.isArray(tempFiles) ? tempFiles : []).map(file => fs.promises.unlink(file).catch(() => {})))
}
