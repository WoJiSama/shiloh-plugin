import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import { withYoutubeYtDlpAuth } from "./youtubeAuth.js"

const execFile = promisify(execFileCallback)
const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_MAX = 100
export const YOUTUBE_ARCHIVE_VIDEO_MAX_SECONDS = 30 * 60
const metadataCache = new Map()

function cleanText(value = "", maxLength = 1000) {
  const text = String(value || "").replace(/\s+/g, " ").trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null
}

function allowedYoutubeUrl(value = "") {
  try {
    const host = new URL(value).hostname.toLowerCase()
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")
  } catch {
    return false
  }
}

function urlFromText(value = "") {
  return String(value || "").match(/https?:\/\/(?:youtu\.be\/[A-Za-z0-9_-]+|(?:(?:www|m|music)\.)?youtube\.com\/(?:watch\?[^\s，。！？；;）)\]}>]+|shorts\/[A-Za-z0-9_-]+|embed\/[A-Za-z0-9_-]+|live\/[A-Za-z0-9_-]+)[^\s，。！？；;）)\]}>]*)/i)?.[0] || ""
}

export function extractYoutubeVideoId(value = "") {
  try {
    const url = new URL(String(value || ""))
    const host = url.hostname.toLowerCase()
    if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || ""
    const part = url.pathname.split("/").filter(Boolean)
    if (url.pathname === "/watch") return url.searchParams.get("v") || ""
    if (["shorts", "embed", "live"].includes(part[0])) return part[1] || ""
  } catch {}
  return ""
}

function canonicalUrl(videoId, fallback = "") {
  return videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : fallback
}

function ytDlpProxyArgs(proxyUrl) {
  const value = String(proxyUrl || "").trim()
  return value ? ["--proxy", value] : []
}

export function extractYoutubeShareFromText(value = "") {
  const shortUrl = urlFromText(value)
  if (!shortUrl || !allowedYoutubeUrl(shortUrl)) return null
  const videoId = extractYoutubeVideoId(shortUrl)
  return {
    type: "youtube",
    platform: "youtube",
    video_id: videoId,
    short_url: shortUrl,
    page_url: canonicalUrl(videoId, shortUrl),
    video_url: canonicalUrl(videoId, shortUrl),
    metadata_status: videoId ? "identified" : "link"
  }
}

function pruneCache() {
  const now = Date.now()
  for (const [key, entry] of metadataCache) if (!entry || entry.expiresAt <= now) metadataCache.delete(key)
  while (metadataCache.size > CACHE_MAX) metadataCache.delete(metadataCache.keys().next().value)
}

async function runYtDlp(args, { binary = "yt-dlp", timeoutMs = 15_000, runCommand } = {}) {
  if (typeof runCommand === "function") return await runCommand(args, { binary, timeoutMs })
  try {
    return await execFile(binary, args, {
      timeout: Math.max(1_000, Number(timeoutMs) || 15_000),
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    })
  } catch (error) {
    if (error?.code === "ENOENT") {
      const unavailable = new Error("YouTube 下载器 yt-dlp 未安装或不在 PATH 中")
      unavailable.code = "youtube_downloader_unavailable"
      throw unavailable
    }
    if (error?.killed || error?.signal === "SIGTERM") {
      const timeout = new Error("YouTube 元数据请求超时")
      timeout.code = "youtube_metadata_timeout"
      throw timeout
    }
    throw error
  }
}

function metadataFailureReason(error) {
  if (error?.code === "youtube_downloader_unavailable") return error.message
  if (error?.code === "youtube_metadata_timeout") return error.message
  if (error?.killed || error?.signal === "SIGTERM") return "YouTube 元数据请求超时"
  const text = String(error?.stderr || error?.message || "").replace(/https?:\/\/\S+/g, "[url]").replace(/\s+/g, " ").trim()
  const accessReason = youtubeAccessFailureReason(text)
  if (accessReason) return accessReason
  if (/not available in your country|geo/i.test(text)) return "该 YouTube 视频受地区限制"
  return "YouTube 视频详情暂时获取失败"
}

export function youtubeAccessFailureReason(text = "") {
  const message = String(text || "")
  if (/confirm you.?re not a bot|cookies(?:-from-browser)?/i.test(message)) return "YouTube 要求通过账号 Cookie 完成访问验证"
  if (/sign in|login|members-only|private video|premium/i.test(message)) return "该 YouTube 视频需要登录、会员资格或没有公开访问权限"
  return ""
}

function normalizeMetadata(card = {}, data = {}) {
  const id = String(data.id || card.video_id || "").trim()
  const pageUrl = String(data.webpage_url || canonicalUrl(id, card.page_url || card.short_url) || "").trim()
  const stats = {}
  for (const key of ["view_count", "like_count", "comment_count", "repost_count"]) {
    const value = numberOrNull(data[key])
    if (value !== null) stats[key] = value
  }
  return {
    ...card,
    type: "youtube",
    platform: "youtube",
    video_id: id,
    title: cleanText(data.title || card.title || "YouTube 视频", 300),
    description: cleanText(data.description || card.description || "", 1000),
    channel: cleanText(data.channel || data.uploader || card.channel || "", 120),
    channel_id: String(data.channel_id || data.uploader_id || card.channel_id || ""),
    duration: Math.max(0, Math.round(Number(data.duration || card.duration || 0))),
    cover_url: String(data.thumbnail || card.cover_url || "").trim(),
    page_url: pageUrl,
    video_url: pageUrl,
    short_url: String(card.short_url || pageUrl),
    published_at: data.timestamp ? Number(data.timestamp) * 1000 : card.published_at || null,
    upload_date: String(data.upload_date || card.upload_date || ""),
    age_limit: numberOrNull(data.age_limit),
    availability: cleanText(data.availability || card.availability || "", 80),
    is_live: data.is_live === true,
    was_live: data.was_live === true,
    stats: Object.keys(stats).length ? stats : card.stats || null,
    metadata_status: "resolved"
  }
}

async function requestYoutubeMetadata(card = {}, options = {}) {
  const sourceUrl = card.page_url || card.short_url
  if (!sourceUrl || !allowedYoutubeUrl(sourceUrl)) throw new Error("YouTube 链接不受支持")
  const result = await withYoutubeYtDlpAuth(options, async authArgs => await runYtDlp([
    "--dump-single-json", "--skip-download", "--no-playlist", "--no-warnings", "--retries", "0", "--socket-timeout", "8",
    ...authArgs, ...ytDlpProxyArgs(options.proxyUrl), sourceUrl
  ], options))
  const stdout = typeof result === "string" ? result : result?.stdout
  const data = JSON.parse(String(stdout || "").trim())
  if (!data || Array.isArray(data.entries)) throw new Error("YouTube 播放列表不支持自动搬运")
  return normalizeMetadata(card, data)
}

export async function enrichYoutubeShare(card = {}, options = {}) {
  if (!card || card.type !== "youtube") return card
  const key = card.video_id || card.page_url || card.short_url
  if (!key) return card
  const cacheTtlMs = Math.max(0, Number(options.cacheTtlMs ?? CACHE_TTL_MS) || 0)
  pruneCache()
  const cached = metadataCache.get(key)
  if (cached?.expiresAt > Date.now()) return await cached.promise
  const promise = requestYoutubeMetadata(card, options).catch(error => ({
    ...card,
    metadata_status: "unavailable",
    metadata_failure_reason: metadataFailureReason(error)
  }))
  metadataCache.set(key, { promise, expiresAt: Date.now() + cacheTtlMs })
  return await promise
}

export async function enrichYoutubeMessageSegments(segments = [], rawMessage = "", options = {}) {
  const source = Array.isArray(segments) ? segments : []
  if (source.some(segment => segment?.type === "youtube")) return source
  const text = [...source.filter(segment => segment?.type === "text").map(segment => segment.text || segment.data?.text || ""), rawMessage].filter(Boolean).join("\n")
  const card = extractYoutubeShareFromText(text)
  return card ? [...source, await enrichYoutubeShare(card, options)] : source
}

export function formatYoutubeDuration(seconds = 0) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}` : `${minutes}:${String(total % 60).padStart(2, "0")}`
}

export function formatYoutubeHistoryText(card = {}) {
  if (card.metadata_status && card.metadata_status !== "resolved") {
    const lines = ["视频信息未获取"]
    if (card.video_id) lines.push(`视频:${card.video_id}`)
    return lines.join("\n")
  }
  const lines = [`分享了《${card.title || "未命名视频"}》`]
  const basic = []
  if (card.channel) basic.push(`频道:${card.channel}`)
  if (card.video_id) basic.push(`视频:${card.video_id}`)
  if (card.duration) basic.push(`时长:${formatYoutubeDuration(card.duration)}`)
  if (basic.length) lines.push(basic.join(" | "))
  const labels = [["view_count", "播放"], ["like_count", "点赞"], ["comment_count", "评论"], ["repost_count", "转发"]]
  const summary = labels.filter(([key]) => Object.hasOwn(card.stats || {}, key)).map(([key, label]) => `${label}:${card.stats[key]}`).join(" ")
  if (summary) lines.push(`数据：${summary}`)
  if (card.description) lines.push(`简介：${cleanText(card.description, 240)}`)
  return lines.join("\n")
}

export function formatYoutubeHistoryLinks(card = {}) {
  return [(card.page_url || card.video_url || card.short_url) ? `视频 URL:${card.page_url || card.video_url || card.short_url}` : "", card.cover_url ? `封面 URL:${card.cover_url}` : ""].filter(Boolean).join("，")
}

export function shouldAttachYoutubeVideo(card = {}, maxSeconds = YOUTUBE_ARCHIVE_VIDEO_MAX_SECONDS) {
  const duration = Number(card.duration || 0)
  return duration > 0 && duration <= Math.max(1, Number(maxSeconds) || YOUTUBE_ARCHIVE_VIDEO_MAX_SECONDS) && card.is_live !== true
}

export function clearYoutubeMetadataCache() {
  metadataCache.clear()
}
