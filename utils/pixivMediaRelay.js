import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { isTrustedPixivImageUrl } from "./pixivMessage.js"
import { buildMediaArtifactKey } from "./messagePipeline/mediaArtifactStore.js"

export const PIXIV_ARCHIVE_MAX_PAGES = 5
export const PIXIV_ARCHIVE_MAX_IMAGE_BYTES = 16 * 1024 * 1024
export const PIXIV_ARCHIVE_MAX_TOTAL_BYTES = 40 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 90 * 1000

function extensionForUrl(url = "") {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase()
    return [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg"
  } catch {
    return ".jpg"
  }
}

export async function downloadPixivArchiveImage(imageUrl, { maxBytes = PIXIV_ARCHIVE_MAX_IMAGE_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  if (!isTrustedPixivImageUrl(imageUrl)) return ""
  if (typeof fetchImpl !== "function") return ""
  const dir = path.join(os.tmpdir(), "shiloh-plugin-pixiv-archive")
  await fs.promises.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${Date.now()}-${Math.random().toString(16).slice(2)}${extensionForUrl(imageUrl)}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || DOWNLOAD_TIMEOUT_MS))
  try {
    const response = await fetchImpl(imageUrl, { headers: { Referer: "https://www.pixiv.net/", "User-Agent": "Mozilla/5.0 (compatible; XiloMediaRelay/1.0)" }, signal: controller.signal })
    if (!response?.ok || !response.body) return ""
    if (Number(response.headers.get("content-length") || 0) > maxBytes) return ""
    let size = 0
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length
        if (size > maxBytes) return callback(new Error("Pixiv 图片超过大小上限"))
        callback(null, chunk)
      }
    })
    await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(filePath))
    const stat = await fs.promises.stat(filePath)
    return stat.size > 0 && stat.size <= maxBytes ? filePath : ""
  } catch {
    return ""
  } finally {
    clearTimeout(timer)
    const stat = await fs.promises.stat(filePath).catch(() => null)
    if (!stat || stat.size <= 0 || stat.size > maxBytes) await fs.promises.unlink(filePath).catch(() => {})
  }
}

export async function buildPixivArchiveRelaySegments(card = {}, {
  segmentApi = globalThis.segment,
  artifactStore = null,
  onTiming = null,
  pixivRelay = {}
} = {}) {
  const segments = []
  const tempFiles = []
  const artifactLeases = []
  if (!card || card.type !== "pixiv") return { segments, tempFiles, artifactLeases }
  if (Number(card.x_restrict || 0) > 0 && pixivRelay.allowRestricted !== true) {
    segments.push("\n（该 Pixiv 作品标记为受限内容，未自动附带图片）")
    return { segments, tempFiles, artifactLeases }
  }
  const maxPages = Math.min(PIXIV_ARCHIVE_MAX_PAGES, Math.max(1, Number(pixivRelay.maxPages) || PIXIV_ARCHIVE_MAX_PAGES))
  const maxImageBytes = Math.min(PIXIV_ARCHIVE_MAX_IMAGE_BYTES, Math.max(1, Number(pixivRelay.maxImageBytes) || PIXIV_ARCHIVE_MAX_IMAGE_BYTES))
  const maxTotalBytes = Math.min(PIXIV_ARCHIVE_MAX_TOTAL_BYTES, Math.max(1, Number(pixivRelay.maxTotalBytes) || PIXIV_ARCHIVE_MAX_TOTAL_BYTES))
  const pages = (Array.isArray(card.pages) ? card.pages : []).filter(page => isTrustedPixivImageUrl(page?.image_url)).slice(0, maxPages)
  if (!pages.length) {
    segments.push("\n（Pixiv 未返回可安全下载的作品图片，已保留作品页面）")
    return { segments, tempFiles, artifactLeases }
  }
  let totalBytes = 0
  let sentPages = 0
  let failedPages = 0
  for (const page of pages) {
    const remaining = maxTotalBytes - totalBytes
    if (remaining <= 0) break
    const perImageLimit = Math.min(maxImageBytes, remaining)
    const startedAt = Date.now()
    const key = buildMediaArtifactKey("pixiv", { artwork_id: card.artwork_id, page: page.page })
    const lease = artifactStore && key
      ? await artifactStore.acquire(key, () => downloadPixivArchiveImage(page.image_url, { maxBytes: perImageLimit, timeoutMs: pixivRelay.downloadTimeoutMs, fetchImpl: pixivRelay.fetchImpl }))
      : null
    const filePath = lease?.filePath || (!artifactStore ? await downloadPixivArchiveImage(page.image_url, { maxBytes: perImageLimit, timeoutMs: pixivRelay.downloadTimeoutMs, fetchImpl: pixivRelay.fetchImpl }) : "")
    onTiming?.("download", Date.now() - startedAt)
    if (!filePath) {
      failedPages++
      continue
    }
    const stat = await fs.promises.stat(filePath).catch(() => null)
    if (!stat || stat.size > remaining) {
      if (lease) await lease.release?.()
      else await fs.promises.unlink(filePath).catch(() => {})
      failedPages++
      continue
    }
    totalBytes += stat.size
    sentPages++
    if (lease) artifactLeases.push(lease)
    else tempFiles.push(filePath)
    if (segmentApi?.image) segments.push("\n", segmentApi.image(filePath))
  }
  if (!sentPages) segments.push("\n（作品图片暂时获取失败，已保留作品页面）")
  else if (failedPages || Number(card.page_count || pages.length) > sentPages) segments.push(`\n（已附带 ${sentPages} 张图片；其余图片因页数或大小限制未附带）`)
  return { segments, tempFiles, artifactLeases }
}

export async function cleanupPixivArchiveRelayFiles(tempFiles = []) {
  await Promise.all((Array.isArray(tempFiles) ? tempFiles : []).map(file => fs.promises.unlink(file).catch(() => {})))
}
