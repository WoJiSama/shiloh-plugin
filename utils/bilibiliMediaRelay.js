import fs from "fs"
import os from "os"
import path from "path"
import { Readable, Transform } from "stream"
import { pipeline } from "stream/promises"
import {
  BILIBILI_ARCHIVE_VIDEO_MAX_SECONDS,
  resolveBilibiliPlaybackResult,
  shouldAttachBilibiliVideo
} from "./bilibiliMessage.js"
import { buildMediaArtifactKey } from "./messagePipeline/mediaArtifactStore.js"

export const BILIBILI_ARCHIVE_VIDEO_MAX_BYTES = 512 * 1024 * 1024
const BILIBILI_ARCHIVE_VIDEO_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

function getLogger(logger = globalThis.logger) {
  return logger || { warn() {} }
}

export async function downloadBilibiliArchiveVideo(resource = {}, { logger = globalThis.logger, authCookie = "" } = {}) {
  const candidates = [resource.url, ...(resource.backup_urls || [])].filter(Boolean)
  if (!candidates.length || resource.size > BILIBILI_ARCHIVE_VIDEO_MAX_BYTES) return null

  const dir = path.join(os.tmpdir(), "shiloh-plugin-bilibili-archive")
  await fs.promises.mkdir(dir, { recursive: true })
  const safeBvid = String(resource.bvid || "video").replace(/[^A-Za-z0-9_-]/g, "")
  const filePath = path.join(dir, `${safeBvid}-p${Number(resource.page || 1)}-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`)

  for (const url of candidates) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), BILIBILI_ARCHIVE_VIDEO_DOWNLOAD_TIMEOUT_MS)
    try {
      const headers = {
          Referer: "https://www.bilibili.com/",
          "User-Agent": "Mozilla/5.0"
        }
      if (authCookie) headers.Cookie = String(authCookie)
      const response = await fetch(url, {
        headers,
        signal: controller.signal
      })
      if (!response.ok || !response.body) continue
      const contentLength = Number(response.headers.get("content-length") || 0)
      if (contentLength > BILIBILI_ARCHIVE_VIDEO_MAX_BYTES) continue

      let downloadedBytes = 0
      const limitStream = new Transform({
        transform(chunk, encoding, callback) {
          downloadedBytes += chunk.length
          if (downloadedBytes > BILIBILI_ARCHIVE_VIDEO_MAX_BYTES) {
            callback(new Error("B站视频本体超过512MB安全上限"))
            return
          }
          callback(null, chunk)
        }
      })
      await pipeline(Readable.fromWeb(response.body), limitStream, fs.createWriteStream(filePath))
      const stat = await fs.promises.stat(filePath)
      if (stat.size > 0 && stat.size <= BILIBILI_ARCHIVE_VIDEO_MAX_BYTES) return filePath
    } catch (error) {
      getLogger(logger).warn?.(`[MessageArchive] B站视频本体下载失败: ${error.message}`)
    } finally {
      clearTimeout(timer)
    }
    await fs.promises.unlink(filePath).catch(() => {})
  }
  return null
}

export async function buildBilibiliArchiveRelaySegments(card = {}, {
  segmentApi = globalThis.segment,
  logger = globalThis.logger,
  artifactStore = null,
  onTiming = null,
  quality = 6,
  authCookie = "",
  autoAuthRetryCookie = ""
} = {}) {
  const segments = []
  const tempFiles = []
  const artifactLeases = []
  if (!card || card.type !== "bilibili") return { segments, tempFiles, artifactLeases }

  if (card.cover_url && segmentApi?.image) segments.push("\n", segmentApi.image(card.cover_url))
  if (!shouldAttachBilibiliVideo(card, BILIBILI_ARCHIVE_VIDEO_MAX_SECONDS)) {
    if (Number(card.duration || 0) > BILIBILI_ARCHIVE_VIDEO_MAX_SECONDS) {
      segments.push("\n（视频超过30分钟，未附带视频本体）")
    }
    return { segments, tempFiles, artifactLeases }
  }

  if (!segmentApi?.video) return { segments, tempFiles, artifactLeases }
  const resolveStartedAt = Date.now()
  let playback = await resolveBilibiliPlaybackResult(card, {
    maxSeconds: BILIBILI_ARCHIVE_VIDEO_MAX_SECONDS,
    quality,
    authCookie
  })
  let usedAuthorizedRetry = Boolean(authCookie)
  const shouldRetryWithAuthorizedAccount = !authCookie && autoAuthRetryCookie && (
    playback.resources?.some(resource => resource?.is_preview)
    || /要求登录/.test(String(playback.failureReason || ""))
  )
  if (shouldRetryWithAuthorizedAccount) {
    playback = await resolveBilibiliPlaybackResult(card, {
      maxSeconds: BILIBILI_ARCHIVE_VIDEO_MAX_SECONDS,
      quality,
      authCookie: autoAuthRetryCookie
    })
    usedAuthorizedRetry = true
  }
  const authorizedStillPreview = usedAuthorizedRetry && playback.resources?.some(resource => resource?.is_preview)
  const resources = authorizedStillPreview ? [] : playback.resources
  onTiming?.("playback", Date.now() - resolveStartedAt)
  if (playback.previewNotice) segments.push(`\n（${playback.previewNotice}）`)
  for (const resource of resources) {
    const downloadStartedAt = Date.now()
    const key = buildMediaArtifactKey(usedAuthorizedRetry ? "bilibili-auth" : "bilibili", resource)
    const useArtifactStore = Boolean(artifactStore && key)
    const lease = useArtifactStore
      ? await artifactStore.acquire(key, () => downloadBilibiliArchiveVideo(resource, { logger, authCookie: usedAuthorizedRetry ? (authCookie || autoAuthRetryCookie) : "" }))
      : null
    const filePath = useArtifactStore ? lease?.filePath : await downloadBilibiliArchiveVideo(resource, { logger, authCookie: usedAuthorizedRetry ? (authCookie || autoAuthRetryCookie) : "" })
    onTiming?.("download", Date.now() - downloadStartedAt)
    if (!filePath) continue
    if (lease) artifactLeases.push(lease)
    else tempFiles.push(filePath)
    segments.push("\n", segmentApi.video(filePath))
  }
  if (!resources.length || !segments.some(item => item?.type === "video")) {
    const reason = !resources.length
      ? (authorizedStillPreview
          ? "已使用授权账号复试，但B站仍只提供试看资源"
          : playback.failureReason || (card.ep_id ? "B站番剧播放接口未提供可下载资源" : "B站视频播放接口未提供可下载资源"))
      : "B站已提供播放资源，但视频本体下载失败"
    segments.push(`\n（${reason}，已保留视频页面）`)
  }
  return {
    segments,
    tempFiles,
    artifactLeases,
    qualityOptions: playback.qualityOptions || [],
    actualQuality: playback.resources?.[0]?.quality || 0,
    failureReason: playback.failureReason || "",
    usedAuthorizedRetry
  }
}

export async function cleanupBilibiliArchiveRelayFiles(tempFiles = []) {
  await Promise.all((Array.isArray(tempFiles) ? tempFiles : []).map(file => fs.promises.unlink(file).catch(() => {})))
}
