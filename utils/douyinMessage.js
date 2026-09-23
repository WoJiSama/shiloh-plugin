// 分享页里的封面/播放地址是短时资源；缓存只用于合并几乎同时到达的同一链接。
const DOUYIN_CACHE_TTL_MS = 30 * 1000
const DOUYIN_CACHE_MAX = 100
export const DOUYIN_ARCHIVE_VIDEO_MAX_SECONDS = 30 * 60
const metadataCache = new Map()
// 同 key 的在途富化请求合并:outbox 预刷新(cacheTtlMs:0)与消息富化几乎同时到达,
// 若各自发起会并发触发两次浏览器兜底,反而被抖音反爬判罚。落地结果仍按 TTL 缓存。
const inflightEnrichments = new Map()

function cleanText(value = "", maxLength = 1000) {
  const text = String(value || "").replace(/&amp;/gi, "&").replace(/\\\//g, "/").replace(/\s+/g, " ").trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function normalizeUrl(value = "") {
  const text = cleanText(value)
  if (!text) return ""
  if (text.startsWith("//")) return `https:${text}`
  if (/^http:\/\//i.test(text)) return text.replace(/^http:/i, "https:")
  return text
}

function firstUrl(value) {
  return (Array.isArray(value) ? value : []).map(normalizeUrl).find(Boolean) || ""
}

function numberOrNull(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null
}

function normalizeDuration(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.round(parsed > 10_000 ? parsed / 1_000 : parsed)
}

function normalizeStats(stat = {}) {
  const result = {}
  for (const key of ["play_count", "digg_count", "comment_count", "share_count", "collect_count"]) {
    const value = numberOrNull(stat?.[key])
    if (value !== null) result[key] = value
  }
  return Object.keys(result).length ? result : null
}

function allowedDouyinHost(value = "") {
  try {
    const host = new URL(value).hostname.toLowerCase()
    return host === "v.douyin.com" || host.endsWith(".douyin.com") || host.endsWith(".iesdouyin.com")
  } catch {
    return false
  }
}

export function extractDouyinShareFromText(value = "") {
  const text = String(value || "").replace(/&amp;/gi, "&")
  const match = text.match(/https?:\/\/(?:v\.douyin\.com|(?:www\.)?(?:douyin\.com|iesdouyin\.com))\/[^\s，。！？；;）)\]}>]+/i)
  if (!match) return null
  const shortUrl = normalizeUrl(match[0])
  if (!allowedDouyinHost(shortUrl)) return null
  const awemeId = shortUrl.match(/(?:share\/video|video)\/(\d{10,})/i)?.[1] || ""
  return {
    type: "douyin",
    platform: "douyin",
    short_url: shortUrl,
    aweme_id: awemeId,
    page_url: awemeId ? `https://www.iesdouyin.com/share/video/${awemeId}/` : shortUrl,
    video_url: awemeId ? `https://www.iesdouyin.com/share/video/${awemeId}/` : shortUrl,
    metadata_status: awemeId ? "identified" : "link"
  }
}

function extractBalancedJson(text = "", marker = "") {
  const markerIndex = text.indexOf(marker)
  if (markerIndex < 0) return null
  const start = text.indexOf("{", markerIndex + marker.length)
  if (start < 0) return null
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === "{") depth += 1
    else if (char === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, index + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

function getDouyinItem(html = "") {
  const routerData = extractBalancedJson(html, "window._ROUTER_DATA =")
  const item = routerData?.loaderData?.["video_(id)/page"]?.videoInfoRes?.item_list?.[0]
  return item && typeof item === "object" ? item : null
}

function canonicalPageUrl(awemeId, fallback = "") {
  return awemeId ? `https://www.iesdouyin.com/share/video/${awemeId}/` : normalizeUrl(fallback)
}

function buildDouyinCard(base = {}, item = {}, finalUrl = "") {
  const awemeId = String(item.aweme_id || base.aweme_id || "").trim()
  const pageUrl = canonicalPageUrl(awemeId, finalUrl || base.page_url || base.short_url)
  return {
    ...base,
    type: "douyin",
    platform: "douyin",
    title: cleanText(item.desc || base.title || "抖音视频", 300),
    description: cleanText(item.desc || base.description || "", 1000),
    aweme_id: awemeId,
    author: cleanText(item.author?.nickname || base.author || "", 120),
    author_uid: String(item.author?.uid || item.author?.sec_uid || base.author_uid || ""),
    duration: normalizeDuration(item.duration || item.video?.duration || base.duration),
    stats: normalizeStats(item.statistics || base.stats),
    cover_url: firstUrl(item.video?.cover?.url_list) || base.cover_url || "",
    play_url: firstUrl(item.video?.play_addr?.url_list) || base.play_url || "",
    page_url: pageUrl,
    video_url: pageUrl,
    metadata_status: "resolved"
  }
}

function pruneCache() {
  const now = Date.now()
  for (const [key, item] of metadataCache) {
    if (!item || item.expiresAt <= now) metadataCache.delete(key)
  }
  while (metadataCache.size > DOUYIN_CACHE_MAX) metadataCache.delete(metadataCache.keys().next().value)
}

async function requestDouyinShare(card = {}, { fetchImpl, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 7000))
  try {
    const response = await fetchImpl(card.short_url || card.page_url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 10; K)",
        Accept: "text/html,application/xhtml+xml"
      },
      redirect: "follow",
      signal: controller.signal
    })
    const finalUrl = normalizeUrl(response?.url || card.page_url || card.short_url)
    if (!response?.ok || !allowedDouyinHost(finalUrl)) throw new Error("抖音分享页不可用")
    const item = getDouyinItem(await response.text())
    if (!item) throw new Error("抖音分享页未提供作品数据")
    return buildDouyinCard(card, item, finalUrl)
  } finally {
    clearTimeout(timer)
  }
}

export async function enrichDouyinShare(card = {}, options = {}) {
  if (!card || card.type !== "douyin") return card
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== "function") return card
  const key = card.aweme_id || card.short_url || card.page_url
  if (!key) return card
  const cacheTtlMs = Math.max(0, Number(options.cacheTtlMs ?? DOUYIN_CACHE_TTL_MS) || 0)
  pruneCache()
  const cached = metadataCache.get(key)
  if (cached?.expiresAt > Date.now()) return await cached.promise
  const inflight = inflightEnrichments.get(key)
  if (inflight) return await inflight.promise
  const promise = requestDouyinShare(card, { fetchImpl, timeoutMs: options.timeoutMs || 7000 })
    .catch(async error => {
      // 分享页静态解析失败(抖音改版常见):告警不再静默,并尝试浏览器兜底
      ;(options.logger || globalThis.logger)?.warn?.(`[抖音] 分享页解析失败(${error.message}),尝试浏览器兜底: ${key}`)
      try {
        const resolver = options.browserResolver || (await import("./douyinBrowserResolver.js")).resolveDouyinShareViaBrowser
        const resolved = await resolver(card, { logger: options.logger || globalThis.logger })
        if (resolved?.play_url) {
          const awemeId = String(resolved.aweme_id || card.aweme_id || "").trim()
          const pageUrl = canonicalPageUrl(awemeId, resolved.final_url || card.page_url || card.short_url)
          return {
            ...card,
            title: cleanText(resolved.title || card.title || "抖音视频", 300),
            description: cleanText(resolved.description || resolved.title || "", 1000),
            aweme_id: awemeId,
            author: cleanText(resolved.author || card.author || "", 120),
            duration: normalizeDuration(resolved.duration || card.duration),
            cover_url: resolved.cover_url || card.cover_url || "",
            play_url: resolved.play_url,
            page_url: pageUrl,
            video_url: pageUrl,
            metadata_status: "resolved"
          }
        }
      } catch (fallbackError) {
        ;(options.logger || globalThis.logger)?.warn?.(`[抖音] 浏览器兜底也失败: ${fallbackError.message}`)
      }
      return { ...card, metadata_status: card.metadata_status || "link" }
    })
  const inflightRecord = { promise }
  inflightEnrichments.set(key, inflightRecord)
  metadataCache.set(key, { promise, expiresAt: Date.now() + cacheTtlMs })
  try {
    return await promise
  } finally {
    if (inflightEnrichments.get(key) === inflightRecord) inflightEnrichments.delete(key)
  }
}

export async function enrichDouyinMessageSegments(segments = [], rawMessage = "", options = {}) {
  const source = Array.isArray(segments) ? segments : []
  if (source.some(segment => segment?.type === "douyin")) return source
  const text = [
    ...source.filter(segment => segment?.type === "text").map(segment => segment.text || segment.data?.text || ""),
    rawMessage
  ].filter(Boolean).join("\n")
  const card = extractDouyinShareFromText(text)
  return card ? [...source, await enrichDouyinShare(card, options)] : source
}

export function formatDouyinDuration(seconds = 0) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, "0")}`
}

export function formatDouyinHistoryText(card = {}) {
  const lines = [`分享了抖音视频《${card.title || "未命名视频"}》`]
  const basic = []
  if (card.author) basic.push(`作者:${card.author}`)
  if (card.aweme_id) basic.push(`作品:${card.aweme_id}`)
  if (card.duration) basic.push(`时长:${formatDouyinDuration(card.duration)}`)
  if (basic.length) lines.push(basic.join(" | "))
  if (card.stats) {
    const labels = [["play_count", "播放"], ["digg_count", "点赞"], ["comment_count", "评论"], ["share_count", "转发"], ["collect_count", "收藏"]]
    const summary = labels.filter(([key]) => Object.hasOwn(card.stats, key)).map(([key, label]) => `${label}:${card.stats[key]}`).join(" ")
    if (summary) lines.push(`数据：${summary}`)
  }
  if (card.description && card.description !== card.title) lines.push(`简介：${cleanText(card.description, 240)}`)
  return lines.join("\n")
}

export function formatDouyinHistoryLinks(card = {}) {
  return [
    (card.page_url || card.video_url || card.short_url) ? `视频 URL:${card.page_url || card.video_url || card.short_url}` : "",
    card.cover_url ? `封面 URL:${card.cover_url}` : ""
  ].filter(Boolean).join("，")
}

export function shouldAttachDouyinVideo(card = {}, maxSeconds = DOUYIN_ARCHIVE_VIDEO_MAX_SECONDS) {
  const duration = Number(card.duration || 0)
  return duration > 0 && duration <= Math.max(1, Number(maxSeconds) || DOUYIN_ARCHIVE_VIDEO_MAX_SECONDS)
}

export function clearDouyinMetadataCache() {
  metadataCache.clear()
  inflightEnrichments.clear()
}
