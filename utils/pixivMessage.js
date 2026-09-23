import { fetchWithProxy } from "./proxiedFetch.js"

const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_MAX = 100
const metadataCache = new Map()
// 同 key 在途请求合并:outbox 预刷新(cacheTtlMs:0)与消息富化并发时共享一次 Pixiv 请求。
const inflightEnrichments = new Map()
// pixiv.net 在国内不可达;元数据请求默认走启动时注入的代理(runtime 从 pixivRelay.proxyUrl 读取)。
let pixivProxyUrl = ""

export function setPixivFetchProxy(proxyUrl = "") {
  pixivProxyUrl = String(proxyUrl || "").trim()
}

function cleanText(value = "", maxLength = 1000) {
  const text = String(value || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null
}

export function isTrustedPixivImageUrl(value = "") {
  try {
    const url = new URL(String(value || ""))
    return url.protocol === "https:" && url.hostname === "i.pximg.net"
  } catch {
    return false
  }
}

function urlFromText(value = "") {
  return String(value || "").match(/https?:\/\/(?:www\.)?pixiv\.net\/(?:[a-z]{2}\/)?artworks\/\d+[^\s，。！？；;）)\]}>]*|https?:\/\/(?:www\.)?pixiv\.net\/member_illust\.php\?[^\s，。！？；;）)\]}>]*/i)?.[0] || ""
}

export function extractPixivArtworkId(value = "") {
  const text = String(value || "")
  return text.match(/\/artworks\/(\d+)/i)?.[1] || text.match(/[?&]illust_id=(\d+)/i)?.[1] || ""
}

export function extractPixivShareFromText(value = "") {
  const shortUrl = urlFromText(value)
  const artworkId = extractPixivArtworkId(shortUrl)
  if (!shortUrl || !artworkId) return null
  return {
    type: "pixiv",
    platform: "pixiv",
    artwork_id: artworkId,
    short_url: shortUrl,
    page_url: `https://www.pixiv.net/artworks/${artworkId}`,
    metadata_status: "identified"
  }
}

function pruneCache() {
  const now = Date.now()
  for (const [key, entry] of metadataCache) if (!entry || entry.expiresAt <= now) metadataCache.delete(key)
  while (metadataCache.size > CACHE_MAX) metadataCache.delete(metadataCache.keys().next().value)
}

function pixivHeaders() {
  return { Referer: "https://www.pixiv.net/", "User-Agent": "Mozilla/5.0 (compatible; XiloMediaRelay/1.0)", Accept: "application/json" }
}

export async function fetchPixivJson(url, { fetchImpl = null, proxyUrl = "", cookieHeader = "", signal } = {}) {
  const headers = pixivHeaders()
  if (cookieHeader) headers.Cookie = String(cookieHeader).replace(/^\s*cookie\s*:\s*/i, "").trim()
  const readPayload = async response => {
    if (!response?.ok) throw new Error(`Pixiv 接口返回 ${response?.status || "未知状态"}`)
    const payload = await response.json()
    if (payload?.error || !payload?.body) throw new Error(cleanText(payload?.message || "Pixiv 未返回公开作品信息", 120))
    return payload.body
  }
  if (typeof fetchImpl === "function") return await readPayload(await fetchImpl(url, { headers, signal }))
  return await fetchWithProxy(url, { proxyUrl: proxyUrl || pixivProxyUrl, headers, signal }, readPayload)
}

function normalizeTags(tags = []) {
  return (Array.isArray(tags) ? tags : []).map(item => cleanText(item?.tag || item, 80)).filter(Boolean).slice(0, 20)
}

function normalizePages(pages = []) {
  return (Array.isArray(pages) ? pages : []).map((item, index) => {
    const urls = item?.urls || {}
    const imageUrl = String(urls.regular || urls.small || urls.original || "")
    return isTrustedPixivImageUrl(imageUrl) ? { page: index, image_url: imageUrl, width: numberOrNull(item?.width), height: numberOrNull(item?.height) } : null
  }).filter(Boolean)
}

async function requestPixivArtwork(card = {}, { fetchImpl = null, proxyUrl = "", timeoutMs = 7000 } = {}) {
  const artworkId = String(card.artwork_id || extractPixivArtworkId(card.page_url || card.short_url) || "").trim()
  if (!artworkId) throw new Error("未识别到 Pixiv 作品 ID")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 7000))
  const request = { fetchImpl, proxyUrl, signal: controller.signal }
  try {
    const illustUrl = `https://www.pixiv.net/ajax/illust/${encodeURIComponent(artworkId)}`
    // 详情与分页两个请求互不依赖,并行发出;分页失败时回退单页
    const [bodyResult, pageBodyResult] = await Promise.allSettled([
      fetchPixivJson(illustUrl, request),
      fetchPixivJson(`${illustUrl}/pages`, request)
    ])
    if (bodyResult.status === "rejected") throw bodyResult.reason
    const body = bodyResult.value
    const pageCount = Math.max(1, numberOrNull(body.pageCount) || 1)
    let pages = []
    if (pageBodyResult.status === "fulfilled") {
      pages = normalizePages(pageBodyResult.value)
    }
    if (!pages.length) {
      const url = String(body.urls?.regular || body.urls?.small || body.urls?.original || "")
      if (isTrustedPixivImageUrl(url)) pages = [{ page: 0, image_url: url, width: numberOrNull(body.width), height: numberOrNull(body.height) }]
    }
    const stats = {}
    for (const [key, source] of [["view_count", "viewCount"], ["like_count", "likeCount"], ["bookmark_count", "bookmarkCount"], ["comment_count", "commentCount"]]) {
      const value = numberOrNull(body[source])
      if (value !== null) stats[key] = value
    }
    return {
      ...card,
      type: "pixiv",
      platform: "pixiv",
      artwork_id: artworkId,
      title: cleanText(body.title || card.title || "Pixiv 作品", 300),
      description: cleanText(body.description || card.description || "", 1000),
      author: cleanText(body.userName || card.author || "", 120),
      author_id: String(body.userId || card.author_id || ""),
      tags: normalizeTags(body.tags?.tags || body.tags || card.tags),
      page_count: pageCount,
      pages,
      cover_url: pages[0]?.image_url || "",
      width: numberOrNull(body.width),
      height: numberOrNull(body.height),
      x_restrict: numberOrNull(body.xRestrict) || 0,
      sanity_level: numberOrNull(body.sanityLevel),
      published_at: body.createDate ? Date.parse(body.createDate) || null : null,
      stats: Object.keys(stats).length ? stats : card.stats || null,
      page_url: `https://www.pixiv.net/artworks/${artworkId}`,
      metadata_status: "resolved"
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function enrichPixivShare(card = {}, options = {}) {
  if (!card || card.type !== "pixiv") return card
  const key = card.artwork_id || card.page_url || card.short_url
  if (!key) return card
  pruneCache()
  const cached = metadataCache.get(key)
  if (cached?.expiresAt > Date.now()) return await cached.promise
  const inflight = inflightEnrichments.get(key)
  if (inflight) return await inflight.promise
  const promise = requestPixivArtwork(card, {
    fetchImpl: options.fetchImpl || null,
    proxyUrl: options.proxyUrl || "",
    timeoutMs: options.timeoutMs
  }).catch(() => ({ ...card, metadata_status: card.metadata_status || "identified" }))
  const inflightRecord = { promise }
  inflightEnrichments.set(key, inflightRecord)
  metadataCache.set(key, { promise, expiresAt: Date.now() + Math.max(0, Number(options.cacheTtlMs ?? CACHE_TTL_MS) || 0) })
  try {
    return await promise
  } finally {
    if (inflightEnrichments.get(key) === inflightRecord) inflightEnrichments.delete(key)
  }
}

export async function enrichPixivMessageSegments(segments = [], rawMessage = "", options = {}) {
  const source = Array.isArray(segments) ? segments : []
  if (source.some(segment => segment?.type === "pixiv")) return source
  const text = [...source.filter(segment => segment?.type === "text").map(segment => segment.text || segment.data?.text || ""), rawMessage].filter(Boolean).join("\n")
  const card = extractPixivShareFromText(text)
  return card ? [...source, await enrichPixivShare(card, options)] : source
}

export function formatPixivHistoryText(card = {}) {
  const lines = [`分享了 Pixiv 作品《${card.title || "未命名作品"}》`]
  const basic = []
  if (card.author) basic.push(`画师:${card.author}`)
  if (card.artwork_id) basic.push(`作品:${card.artwork_id}`)
  if (card.page_count) basic.push(`${card.page_count}张`)
  if (card.width && card.height) basic.push(`${card.width}x${card.height}`)
  if (basic.length) lines.push(basic.join(" | "))
  if (Array.isArray(card.tags) && card.tags.length) lines.push(`标签：${card.tags.join("、")}`)
  const labels = [["view_count", "浏览"], ["like_count", "点赞"], ["bookmark_count", "收藏"], ["comment_count", "评论"]]
  const summary = labels.filter(([key]) => Object.hasOwn(card.stats || {}, key)).map(([key, label]) => `${label}:${card.stats[key]}`).join(" ")
  if (summary) lines.push(`数据：${summary}`)
  if (card.description) lines.push(`简介：${cleanText(card.description, 240)}`)
  return lines.join("\n")
}

export function formatPixivHistoryLinks(card = {}) {
  return (card.page_url || card.short_url) ? `作品 URL:${card.page_url || card.short_url}` : ""
}

export function clearPixivMetadataCache() {
  metadataCache.clear()
  inflightEnrichments.clear()
}
