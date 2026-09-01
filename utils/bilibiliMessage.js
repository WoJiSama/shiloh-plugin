const BILIBILI_CACHE_TTL_MS = 30 * 60 * 1000
const BILIBILI_CACHE_MAX = 100
export const BILIBILI_ARCHIVE_VIDEO_MAX_SECONDS = 30 * 60
const metadataCache = new Map()
const playbackPromiseCache = new Map()

export function decodeBilibiliCardEntities(text = "") {
  return String(text || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
}

function compactText(value = "", maxLength = 1000) {
  const text = decodeBilibiliCardEntities(value).replace(/\s+/g, " ").trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function normalizeUrl(value = "") {
  const url = decodeBilibiliCardEntities(value).replace(/\\\//g, "/").trim()
  if (!url) return ""
  if (url.startsWith("//")) return `https:${url}`
  if (/^http:\/\//i.test(url)) return url.replace(/^http:/i, "https:")
  if (/^(?:b23\.tv|www\.bilibili\.com|m\.bilibili\.com)\//i.test(url)) return `https://${url}`
  return url
}

function parseJson(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value
  if (typeof value !== "string") return null
  const decoded = decodeBilibiliCardEntities(value).trim()
  if (!decoded) return null
  try {
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

function getSegmentPayload(segment = {}) {
  if (typeof segment?.data === "string") return parseJson(segment.data)
  if (typeof segment?.data?.data === "string") return parseJson(segment.data.data)
  if (segment?.data && typeof segment.data === "object") return parseJson(segment.data)
  return null
}

function getRawJsonPayload(rawMessage = "") {
  const text = String(rawMessage || "")
  const marker = "[CQ:json,data="
  const start = text.indexOf(marker)
  const end = text.lastIndexOf("]")
  if (start < 0 || end <= start) return null
  return parseJson(text.slice(start + marker.length, end))
}

function walkObjects(value, output = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 7) return output
  if (!Array.isArray(value)) output.push(value)
  for (const item of Object.values(value)) walkObjects(item, output, depth + 1)
  return output
}

function findFirstUrl(value, pattern) {
  if (typeof value === "string") {
    const url = normalizeUrl(value)
    if (pattern.test(url)) return url
  }
  if (!value || typeof value !== "object") return ""
  for (const item of Object.values(value)) {
    const found = findFirstUrl(item, pattern)
    if (found) return found
  }
  return ""
}

export function extractBilibiliBvid(value = "") {
  return String(value || "").match(/\b(BV[0-9A-Za-z]{8,16})\b/i)?.[1] || ""
}

export function extractBilibiliEpisodeId(value = "") {
  return String(value || "").match(/\/bangumi\/play\/ep(\d+)/i)?.[1] || ""
}

export function extractBilibiliUrls(value = "") {
  const text = decodeBilibiliCardEntities(value).replace(/\\\//g, "/")
  const matches = text.match(/https?:\/\/(?:(?:b23\.tv\/[^\s，。！？；;）)\]}>]+)|(?:(?:(?:www|m)\.)?bilibili\.com\/(?:video\/BV[0-9A-Za-z]+|bangumi\/play\/ep\d+)[^\s，。！？；;）)\]}>]+))/gi) || []
  return [...new Set(matches.map(normalizeUrl).filter(Boolean))]
}

function createBilibiliCard({
  shortUrl = "",
  title = "B站视频",
  cardTitle = "哔哩哔哩",
  coverUrl = "",
  sharedBy = "",
  sharedByQq = ""
} = {}) {
  const bvid = extractBilibiliBvid(shortUrl)
  const epId = extractBilibiliEpisodeId(shortUrl)
  return {
    type: "bilibili",
    platform: "bilibili",
    title: compactText(title, 300),
    card_title: compactText(cardTitle, 80),
    short_url: shortUrl,
    page_url: bvid ? `https://www.bilibili.com/video/${bvid}` : epId ? `https://www.bilibili.com/bangumi/play/ep${epId}` : shortUrl,
    video_url: bvid ? `https://www.bilibili.com/video/${bvid}` : epId ? `https://www.bilibili.com/bangumi/play/ep${epId}` : shortUrl,
    cover_url: coverUrl,
    bvid,
    ep_id: epId,
    shared_by: compactText(sharedBy, 80),
    shared_by_qq: sharedByQq ? String(sharedByQq) : "",
    metadata_status: bvid || epId ? "identified" : "card"
  }
}

export function extractBilibiliShareFromText(value = "") {
  const shortUrl = extractBilibiliUrls(value)[0] || ""
  return shortUrl ? createBilibiliCard({ shortUrl }) : null
}

export function extractBilibiliShare(payload = {}) {
  if (!payload || typeof payload !== "object") return null
  const serialized = JSON.stringify(payload)
  if (!/(?:哔哩哔哩|bilibili|b23\.tv|\/video\/BV[0-9A-Za-z]+)/i.test(serialized)) return null

  const objects = walkObjects(payload)
  const detail = objects.find(item => item.qqdocurl || item.preview || item.desc || item.title) || payload
  const shortUrl = normalizeUrl(detail.qqdocurl || findFirstUrl(payload, /(?:b23\.tv|bilibili\.com\/video\/BV)/i))
  const prompt = compactText(payload.prompt || "").replace(/^\[QQ小程序\]/i, "")
  const genericTitle = /^(?:哔哩哔哩|bilibili)$/i.test(String(detail.title || "").trim()) ? "" : detail.title
  const title = detail.desc || genericTitle || prompt || "B站视频"
  const coverUrl = normalizeUrl(detail.preview || detail.cover || detail.pic || "")
  return createBilibiliCard({
    shortUrl,
    title,
    cardTitle: detail.title || "哔哩哔哩",
    coverUrl,
    sharedBy: detail.host?.nick || "",
    sharedByQq: detail.host?.uin || ""
  })
}

export function extractBilibiliShareFromSegment(segment = {}, rawMessage = "") {
  if (segment?.type === "bilibili") return { ...segment }
  if (segment?.type === "text") return extractBilibiliShareFromText(segment.text || segment.data?.text || "")
  if (segment?.type !== "json") return null
  return extractBilibiliShare(getSegmentPayload(segment) || getRawJsonPayload(rawMessage) || {})
}

function pruneCache() {
  const now = Date.now()
  for (const [key, item] of metadataCache) {
    if (!item || item.expiresAt <= now) metadataCache.delete(key)
  }
  while (metadataCache.size > BILIBILI_CACHE_MAX) {
    metadataCache.delete(metadataCache.keys().next().value)
  }
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, options)
  if (!response?.ok) throw new Error(`B站接口返回 ${response?.status || "未知状态"}`)
  return await response.json()
}

function normalizePages(pages = []) {
  return (Array.isArray(pages) ? pages : []).slice(0, 50).map(page => ({
    page: Number(page?.page || 0),
    cid: Number(page?.cid || 0),
    title: compactText(page?.part || "", 200),
    duration: Number(page?.duration || 0)
  }))
}

function normalizeBilibiliStats(stat = {}) {
  if (!stat || typeof stat !== "object") return null
  const result = {}
  for (const key of ["view", "like", "coin", "share", "reply", "favorite", "danmaku"]) {
    const value = Number(stat[key])
    if (Number.isFinite(value) && value >= 0) result[key] = Math.floor(value)
  }
  return Object.keys(result).length ? result : null
}

async function requestBilibiliMetadata(card, { fetchImpl, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 5000))
  const headers = {
    "User-Agent": "Mozilla/5.0",
    Referer: "https://www.bilibili.com/"
  }

  try {
    let resolvedUrl = normalizeUrl(card.page_url || card.short_url || "")
    let bvid = extractBilibiliBvid(card.bvid || resolvedUrl)
    let epId = String(card.ep_id || extractBilibiliEpisodeId(resolvedUrl)).trim()
    if (!bvid && resolvedUrl) {
      const response = await fetchImpl(resolvedUrl, { headers, redirect: "follow", signal: controller.signal })
      resolvedUrl = normalizeUrl(response.url || resolvedUrl)
      bvid = extractBilibiliBvid(resolvedUrl)
      epId = epId || extractBilibiliEpisodeId(resolvedUrl)
      if (!bvid && !epId && !response?.ok) throw new Error(`B站短链返回 ${response?.status || "未知状态"}`)
    }
    if (!bvid && !epId) return { ...card, metadata_status: "card" }
    if (epId && !bvid) {
      const season = await fetchJson(fetchImpl, `https://api.bilibili.com/pgc/view/web/season?ep_id=${encodeURIComponent(epId)}`, { headers, signal: controller.signal })
      const episode = season?.result?.episodes?.find(item => String(item?.id) === epId) || season?.result?.episodes?.[0]
      if (!episode?.cid) return { ...card, ep_id: epId, metadata_status: "bangumi_metadata_failed" }
      const pageUrl = `https://www.bilibili.com/bangumi/play/ep${epId}`
      return { ...card, title: compactText(episode.long_title || episode.share_copy || card.title, 300), ep_id: epId, cid: Number(episode.cid), duration: Math.round(Number(episode.duration || 0) / 1000), page_count: 1, pages: [{ page: 1, cid: Number(episode.cid), title: compactText(episode.long_title || card.title, 200), duration: Math.round(Number(episode.duration || 0) / 1000) }], cover_url: normalizeUrl(episode.cover || card.cover_url || ""), page_url: pageUrl, video_url: pageUrl, metadata_status: "resolved_bangumi" }
    }

    const view = await fetchJson(
      fetchImpl,
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      { headers, signal: controller.signal }
    )
    if (Number(view?.code) !== 0 || !view?.data) throw new Error(view?.message || "B站视频信息为空")
    const data = view.data
    const pageUrl = `https://www.bilibili.com/video/${data.bvid || bvid}`
    return {
      ...card,
      title: compactText(data.title || card.title || "B站视频", 300),
      description: compactText(data.desc === "-" ? "" : data.desc || "", 1000),
      bvid: String(data.bvid || bvid),
      aid: Number(data.aid || 0),
      cid: Number(data.cid || data.pages?.[0]?.cid || 0),
      owner: compactText(data.owner?.name || "", 120),
      owner_mid: data.owner?.mid ? String(data.owner.mid) : "",
      duration: Number(data.duration || 0),
      page_count: Number(data.videos || data.pages?.length || 1),
      pages: normalizePages(data.pages),
      cover_url: normalizeUrl(data.pic || card.cover_url || ""),
      page_url: pageUrl,
      video_url: pageUrl,
      stats: normalizeBilibiliStats(data.stat),
      published_at: data.pubdate ? Number(data.pubdate) * 1000 : null,
      metadata_status: "resolved"
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function enrichBilibiliShare(card = {}, options = {}) {
  if (!card || card.type !== "bilibili") return card
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== "function") return card
  const key = card.bvid || card.ep_id || card.short_url || card.page_url
  if (!key) return card

  pruneCache()
  const cached = metadataCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return await cached.promise

  const promise = requestBilibiliMetadata(card, {
    fetchImpl,
    timeoutMs: options.timeoutMs || 5000
  }).catch(() => ({ ...card, metadata_status: card.metadata_status || "card" }))
  metadataCache.set(key, { promise, expiresAt: Date.now() + BILIBILI_CACHE_TTL_MS })
  return await promise
}

export async function enrichBilibiliMessageSegments(segments = [], rawMessage = "", options = {}) {
  const source = Array.isArray(segments) ? segments : []
  const output = []
  let found = false
  for (const segment of source) {
    const card = extractBilibiliShareFromSegment(segment, rawMessage)
    if (!card) {
      output.push(segment)
      continue
    }
    found = true
    output.push(await enrichBilibiliShare(card, options))
  }
  if (!found) {
    const card = extractBilibiliShare(getRawJsonPayload(rawMessage) || {}) || extractBilibiliShareFromText(rawMessage)
    if (card) output.push(await enrichBilibiliShare(card, options))
  }
  return output
}

export function formatBilibiliDuration(seconds = 0) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`
}

export function formatBilibiliHistoryText(card = {}) {
  const lines = [`分享了B站视频《${card.title || "未命名视频"}》`]
  const basic = []
  if (card.owner) basic.push(`UP:${card.owner}`)
  if (card.bvid) basic.push(card.bvid)
  if (card.duration) basic.push(`时长:${formatBilibiliDuration(card.duration)}`)
  if (card.page_count > 1) basic.push(`${card.page_count}个分P`)
  if (basic.length) lines.push(basic.join(" | "))
  const stats = normalizeBilibiliStats(card.stats || card.stat)
  if (stats) {
    const labels = [
      ["view", "播放"],
      ["like", "点赞"],
      ["coin", "投币"],
      ["favorite", "收藏"],
      ["share", "转发"],
      ["reply", "评论"],
      ["danmaku", "弹幕"]
    ]
    const summary = labels
      .filter(([key]) => Object.hasOwn(stats, key))
      .map(([key, label]) => `${label}:${stats[key]}`)
      .join(" ")
    if (summary) lines.push(`数据：${summary}`)
  }
  if (card.description) lines.push(`简介：${compactText(card.description, 240)}`)
  return lines.join("\n")
}

export function formatBilibiliHistoryLinks(card = {}) {
  return [
    (card.page_url || card.video_url || card.short_url) ? `视频 URL:${card.page_url || card.video_url || card.short_url}` : "",
    card.cover_url ? `封面 URL:${card.cover_url}` : ""
  ].filter(Boolean).join("，")
}

export function shouldAttachBilibiliVideo(card = {}, maxSeconds = BILIBILI_ARCHIVE_VIDEO_MAX_SECONDS) {
  const duration = Number(card.duration || 0)
  return duration > 0 && duration <= Math.max(1, Number(maxSeconds) || BILIBILI_ARCHIVE_VIDEO_MAX_SECONDS)
}

function playbackFailureReason(payload = {}, { isBangumi = false } = {}) {
  const prefix = isBangumi ? "B站番剧播放接口" : "B站视频播放接口"
  const code = Number(payload?.code)
  const message = compactText(payload?.message || payload?.result?.message || "", 80)
  if (Number.isFinite(code) && code !== 0) {
    if (/登录|未登录/i.test(message)) return `${prefix}要求登录后才能提供资源`
    if (/地区|区域|版权|港澳台|海外/i.test(message)) return `${prefix}受地区或版权限制，未提供资源`
    return `${prefix}返回错误${code}${message ? `：${message}` : ""}`
  }
  return `${prefix}未提供可下载资源`
}

function normalizeQualityOptions(formats = []) {
  const seen = new Set()
  return (Array.isArray(formats) ? formats : []).flatMap(item => {
    const quality = Number(item?.quality)
    if (!Number.isFinite(quality) || seen.has(quality)) return []
    seen.add(quality)
    const label = compactText(item?.new_description || item?.display_desc || item?.format || `${quality}P`, 40)
    return [{ quality, label }]
  })
}

async function requestBilibiliPlaybackResources(card = {}, options = {}) {
  if (!shouldAttachBilibiliVideo(card, options.maxSeconds)) return { resources: [], failureReason: "", previewNotice: "" }
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== "function") return { resources: [], failureReason: "播放资源请求能力不可用", previewNotice: "" }
  const bvid = String(card.bvid || extractBilibiliBvid(card.page_url || card.video_url || "")).trim()
  const epId = String(card.ep_id || extractBilibiliEpisodeId(card.page_url || card.video_url || "")).trim()
  if (!bvid && !epId) return { resources: [], failureReason: "未识别到B站视频标识", previewNotice: "" }

  const parts = Array.isArray(card.pages) && card.pages.length
    ? card.pages
    : [{ page: 1, cid: card.cid, title: card.title || "P1", duration: card.duration }]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(options.timeoutMs) || 8000))
  const headers = {
    "User-Agent": "Mozilla/5.0",
    Referer: "https://www.bilibili.com/"
  }
  if (options.authCookie) headers.Cookie = String(options.authCookie)
  const resources = []
  const qualityOptions = []
  let failureReason = ""
  let previewNotice = ""

  try {
    for (const part of parts.slice(0, 20)) {
      const cid = Number(part?.cid || 0)
      if (!cid) continue
      const quality = Math.max(1, Number(options.quality) || 6)
      const url = epId ? ["https://api.bilibili.com/pgc/player/web/playurl", `?ep_id=${encodeURIComponent(epId)}`, `&cid=${encodeURIComponent(cid)}`, `&qn=${quality}&fnval=0&fourk=0`].join("") : [
        "https://api.bilibili.com/x/player/playurl",
        `?bvid=${encodeURIComponent(bvid)}`,
        `&cid=${encodeURIComponent(cid)}`,
        `&qn=${quality}&fnval=0&fourk=0`
      ].join("")
      const response = await fetchImpl(url, { headers, signal: controller.signal })
      if (!response?.ok) {
        failureReason ||= `${epId ? "B站番剧" : "B站视频"}播放接口返回 HTTP ${response?.status || "未知状态"}`
        continue
      }
      const payload = await response.json()
      if (Number(payload?.code) !== 0) {
        failureReason ||= playbackFailureReason(payload, { isBangumi: Boolean(epId) })
        continue
      }
      const playData = epId ? payload?.result : payload?.data
      const actualQuality = Math.max(1, Number(playData?.quality) || quality)
      for (const item of normalizeQualityOptions(playData?.support_formats)) {
        if (!qualityOptions.some(existing => existing.quality === item.quality)) qualityOptions.push(item)
      }
      const durls = Array.isArray(playData?.durl) ? playData.durl : []
      if (!durls.length) {
        failureReason ||= playbackFailureReason(payload, { isBangumi: Boolean(epId) })
        continue
      }
      const previewDurationMs = durls.reduce((total, item) => total + Math.max(0, Number(item?.length) || 0), 0)
      const isPreview = Boolean(playData?.is_preview)
      if (isPreview) {
        const previewDuration = previewDurationMs ? formatBilibiliDuration(previewDurationMs / 1000) : "短时"
        previewNotice ||= `${epId ? "B站番剧" : "B站视频"}仅提供约${previewDuration}试看，本体为试看片段`
      }
      for (const item of durls) {
        const mediaUrl = normalizeUrl(item?.url || "")
        if (!mediaUrl) continue
        resources.push({
          bvid: bvid || `ep${epId}`,
          cid,
          page: Number(part?.page || 1),
          quality: actualQuality,
          title: compactText(part?.title || card.title || "", 160),
          duration: Number(item?.length ? item.length / 1000 : part?.duration || 0),
          size: Number(item?.size || 0),
          is_preview: isPreview,
          url: mediaUrl,
          backup_urls: (Array.isArray(item?.backup_url) ? item.backup_url : []).map(normalizeUrl).filter(Boolean)
        })
      }
    }
    return { resources, qualityOptions, failureReason: resources.length ? "" : failureReason || `${epId ? "B站番剧" : "B站视频"}播放接口未提供可下载资源`, previewNotice: resources.length ? previewNotice : "" }
  } catch (error) {
    return { resources, qualityOptions, failureReason: resources.length ? "" : `${epId ? "B站番剧" : "B站视频"}播放资源请求失败：${compactText(error?.message || "未知错误", 80)}`, previewNotice: resources.length ? previewNotice : "" }
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveBilibiliPlaybackResult(card = {}, options = {}) {
  const bvid = String(card.bvid || extractBilibiliBvid(card.page_url || card.video_url || "")).trim()
  const epId = String(card.ep_id || extractBilibiliEpisodeId(card.page_url || card.video_url || "")).trim()
  const parts = Array.isArray(card.pages) && card.pages.length
    ? card.pages
    : [{ page: 1, cid: card.cid }]
  const identity = parts.map(part => `${Number(part?.page || 1)}:${Number(part?.cid || 0)}`).join(",")
  const quality = Math.max(1, Number(options.quality) || 6)
  const key = (bvid || epId) ? `${bvid || `ep${epId}`}:${identity}:qn${quality}` : ""
  // 授权请求不能与匿名/旧会话共享 in-flight 播放结果，避免权限边界穿透缓存。
  if (!key || options.authCookie) return await requestBilibiliPlaybackResources(card, options)
  if (playbackPromiseCache.has(key)) return await playbackPromiseCache.get(key)
  const promise = requestBilibiliPlaybackResources(card, options)
  playbackPromiseCache.set(key, promise)
  try {
    return await promise
  } finally {
    if (playbackPromiseCache.get(key) === promise) playbackPromiseCache.delete(key)
  }
}

export async function resolveBilibiliPlaybackResources(card = {}, options = {}) {
  return (await resolveBilibiliPlaybackResult(card, options)).resources
}

export function clearBilibiliMetadataCache() {
  metadataCache.clear()
  playbackPromiseCache.clear()
}
