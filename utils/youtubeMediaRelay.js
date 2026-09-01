import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import { YOUTUBE_ARCHIVE_VIDEO_MAX_SECONDS, shouldAttachYoutubeVideo, youtubeAccessFailureReason } from "./youtubeMessage.js"
import { buildMediaArtifactKey } from "./messagePipeline/mediaArtifactStore.js"
import { withYoutubeYtDlpAuth } from "./youtubeAuth.js"

const execFile = promisify(execFileCallback)
export const YOUTUBE_ARCHIVE_VIDEO_MAX_BYTES = 512 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

function safeName(value = "video") {
  return String(value || "video").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120) || "video"
}

function ytDlpProxyArgs(proxyUrl) {
  const value = String(proxyUrl || "").trim()
  return value ? ["--proxy", value] : []
}

async function runYtDlp(args, { binary = "yt-dlp", timeoutMs = DOWNLOAD_TIMEOUT_MS, runCommand } = {}) {
  if (typeof runCommand === "function") return await runCommand(args, { binary, timeoutMs })
  try {
    return await execFile(binary, args, {
      timeout: Math.max(1_000, Number(timeoutMs) || DOWNLOAD_TIMEOUT_MS),
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    })
  } catch (error) {
    if (error?.code === "ENOENT") {
      const unavailable = new Error("YouTube 下载器 yt-dlp 未安装或不在 PATH 中")
      unavailable.code = "youtube_downloader_unavailable"
      throw unavailable
    }
    throw error
  }
}

function compactYtDlpError(error) {
  const text = String(error?.stderr || error?.message || error || "下载器未返回文件").replace(/https?:\/\/\S+/g, "[url]").replace(/\s+/g, " ").trim()
  const accessReason = youtubeAccessFailureReason(text)
  if (accessReason) return accessReason
  if (/not available in your country|geo/i.test(text)) return "该 YouTube 视频受地区限制"
  if (/requested format is not available/i.test(text)) return "YouTube 未提供可直接发送的单文件 MP4"
  if (error?.code === "youtube_downloader_unavailable") return error.message
  return "YouTube 视频本体暂时获取失败"
}

export async function downloadYoutubeArchiveVideo(card = {}, options = {}) {
  const sourceUrl = String(card.page_url || card.short_url || "").trim()
  if (!sourceUrl) return { filePath: "", reason: "未找到 YouTube 视频页面" }
  const maxBytes = Math.min(YOUTUBE_ARCHIVE_VIDEO_MAX_BYTES, Math.max(1, Number(options.maxBytes) || YOUTUBE_ARCHIVE_VIDEO_MAX_BYTES))
  const dir = path.join(os.tmpdir(), "bl-chat-plugin-youtube-archive")
  await fs.promises.mkdir(dir, { recursive: true })
  const template = path.join(dir, `${safeName(card.video_id)}-${Date.now()}-${Math.random().toString(16).slice(2)}.%(ext)s`)
  const outputPrefix = path.basename(template).replace(".%(ext)s", "")
  try {
    await withYoutubeYtDlpAuth(options, async authArgs => await runYtDlp([
      "--no-playlist", "--no-warnings", "--no-progress", "--max-filesize", String(maxBytes),
      "--retries", "0", "--socket-timeout", "8",
      "-f", "worst[ext=mp4][vcodec!=none][acodec!=none]",
      "-o", template, ...authArgs, ...ytDlpProxyArgs(options.proxyUrl), sourceUrl
    ], options))
    const names = await fs.promises.readdir(dir)
    const files = await Promise.all(names.filter(name => name.startsWith(outputPrefix)).map(async name => {
      const filePath = path.join(dir, name)
      const stat = await fs.promises.stat(filePath).catch(() => null)
      return stat?.isFile() ? { filePath, stat } : null
    }))
    const file = files.filter(Boolean).find(item => item.stat.size > 0 && item.stat.size <= maxBytes && path.extname(item.filePath).toLowerCase() === ".mp4")
    if (!file) return { filePath: "", reason: "YouTube 未提供可直接发送的单文件 MP4" }
    return { filePath: file.filePath, dir, reason: "" }
  } catch (error) {
    return { filePath: "", reason: compactYtDlpError(error) }
  }
}

export async function buildYoutubeArchiveRelaySegments(card = {}, {
  segmentApi = globalThis.segment,
  logger = globalThis.logger,
  artifactStore = null,
  onTiming = null,
  youtubeRelay = {}
} = {}) {
  const segments = []
  const tempFiles = []
  const artifactLeases = []
  if (!card || card.type !== "youtube") return { segments, tempFiles, artifactLeases }
  if (card.cover_url && segmentApi?.image) segments.push("\n", segmentApi.image(card.cover_url))
  const maxSeconds = Math.min(YOUTUBE_ARCHIVE_VIDEO_MAX_SECONDS, Math.max(1, Number(youtubeRelay.maxSeconds) || YOUTUBE_ARCHIVE_VIDEO_MAX_SECONDS))
  if (!shouldAttachYoutubeVideo(card, maxSeconds)) {
    if (Number(card.duration || 0) > maxSeconds) segments.push("\n（视频超过30分钟，未附带视频本体）")
    else if (card.is_live) segments.push("\n（直播中的视频未附带视频本体）")
    return { segments, tempFiles, artifactLeases }
  }
  if (!segmentApi?.video) return { segments, tempFiles, artifactLeases }
  const maxBytes = Math.min(YOUTUBE_ARCHIVE_VIDEO_MAX_BYTES, Math.max(1, Number(youtubeRelay.maxBytes) || YOUTUBE_ARCHIVE_VIDEO_MAX_BYTES))
  const downloadStartedAt = Date.now()
  const key = buildMediaArtifactKey("youtube", card)
  let lease = null
  let filePath = ""
  let reason = ""
  if (artifactStore && key) {
    let acquiredReason = ""
    lease = await artifactStore.acquire(key, async () => {
      const result = await downloadYoutubeArchiveVideo(card, { ...youtubeRelay, maxBytes })
      acquiredReason = result.reason
      return result.filePath
    })
    filePath = lease?.filePath || ""
    reason = acquiredReason
  } else {
    const result = await downloadYoutubeArchiveVideo(card, { ...youtubeRelay, maxBytes })
    filePath = result.filePath
    reason = result.reason
  }
  onTiming?.("download", Date.now() - downloadStartedAt)
  if (!filePath) {
    if (lease) await lease.release?.()
    segments.push(`\n（${reason || "YouTube 视频本体暂时获取失败"}，已保留视频页面）`)
    return { segments, tempFiles, artifactLeases }
  }
  if (lease) artifactLeases.push(lease)
  else tempFiles.push(filePath)
  segments.push("\n", segmentApi.video(filePath))
  return { segments, tempFiles, artifactLeases }
}

export async function cleanupYoutubeArchiveRelayFiles(tempFiles = []) {
  await Promise.all((Array.isArray(tempFiles) ? tempFiles : []).map(async file => {
    await fs.promises.unlink(file).catch(() => {})
  }))
}
