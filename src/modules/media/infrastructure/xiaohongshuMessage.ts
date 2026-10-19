import {record,errorText,type XiaohongshuCard,type XiaohongshuOptions,type MediaLogger} from './xiaohongshuTypes.js'

// 小红书图床文件 ID(trace id,如 1040g2sg326f...):签名 CDN 地址带时间前缀会过期,
// 按 ID 重建为 sns-img 无签名地址可长期复用(实测 2026-10 直连 200)。
const XHS_IMAGE_CDN_HOST = "sns-img-qc.xhscdn.com"
const XHS_MOBILE_UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"

export function decodeXiaohongshuCardEntities(text:unknown = "") {
  return String(text || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
}

function cleanText(value:unknown = "", maxLength = 1000) {
  const text = String(value || "").replace(/&amp;/gi, "&").replace(/\\\//g, "/").replace(/\s+/g, " ").trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function normalizeUrl(value:unknown = "") {
  const text = cleanText(value)
  if (!text) return ""
  if (text.startsWith("//")) return `https:${text}`
  if (/^http:\/\//i.test(text)) return text.replace(/^http:/i, "https:")
  return text
}

function parseCount(value:unknown) {
  const text = String(value ?? "").trim()
  if (/^\d+$/.test(text)) return Number(text)
  const wan = text.match(/^([\d.]+)\s*万$/)
  if (wan) return Math.round(Number(wan[1]) * 10000)
  return 0
}

export function allowedXiaohongshuHost(value = "") {
  try {
    const host = new URL(value).hostname.toLowerCase()
    return host === "xhslink.com" || host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com")
  } catch {
    return false
  }
}

export function extractXiaohongshuFileId(url:unknown = "") {
  try {
    const path = new URL(String(url || "")).pathname
    return path.split("/").map(part => part.split("!")[0] || part).find(part => /^10[0-9a-z]{18,}$/i.test(part)) || ""
  } catch {
    return ""
  }
}

// 签名地址(sns-webpic-*.xhscdn.com/<时间戳>/<签名>/<文件ID>)与 ci 包装地址
// 都重建成无签名图床地址;已是 sns-img 的保持原样。
export function normalizeXiaohongshuImageUrl(value:unknown = "") {
  const url = normalizeUrl(value)
  if (!url) return ""
  try {
    const parsed = new URL(url)
    if (parsed.hostname.toLowerCase() === "ci.xiaohongshu.com") {
      const inner = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""))
      if (/^https?:\/\//i.test(inner)) return normalizeXiaohongshuImageUrl(inner)
    }
    const fileId = extractXiaohongshuFileId(url)
    if (fileId) return `https://${XHS_IMAGE_CDN_HOST}/${fileId}`
    return url
  } catch {
    return ""
  }
}

function extractXiaohongshuNoteRef(url = "") {
  const noteId = String(url).match(/\/(?:explore|discovery\/item)\/([0-9a-f]{16,32})/i)?.[1] || ""
  const xsecToken = String(url).match(/[?&]xsec_token=([^&#\s]+)/i)?.[1] || ""
  return {noteId, xsecToken}
}

// QQ 分享卡片的 JSON 埋在 raw_message 的 [CQ:json,data={...}] 里,实体转义需先还原
function extractCardJson(text = ""):unknown {
  const marker = "[CQ:json,data="
  const start = text.indexOf(marker)
  const end = text.lastIndexOf("]")
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start + marker.length, end))
  } catch {
    return null
  }
}

function findXiaohongshuUrlInJson(value:unknown):string {
  if (typeof value === "string") {
    const url = normalizeUrl(value)
    if (/^https?:\/\/(?:xhslink\.com|(?:www\.)?xiaohongshu\.com)\//i.test(url)) return url
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findXiaohongshuUrlInJson(item)
      if (found) return found
    }
  }
  return ""
}

function isXhsShortLink(url = "") {
  try {
    return /(^|\.)xhslink\.com$/i.test(new URL(url).hostname)
  } catch {
    return false
  }
}

function buildBaseCard(pageUrl:string, card?:Partial<XiaohongshuCard>):XiaohongshuCard {
  const {noteId, xsecToken} = extractXiaohongshuNoteRef(pageUrl)
  const isShort = isXhsShortLink(pageUrl)
  return {
    type: "xiaohongshu",
    platform: "xiaohongshu",
    page_url: pageUrl,
    ...(isShort ? {short_url: pageUrl} : {}),
    note_id: noteId,
    ...(xsecToken ? {xsec_token: xsecToken} : {}),
    ...(card?.title ? {title: card.title} : {}),
    ...(card?.description ? {description: card.description} : {}),
    ...(card?.cover_url ? {cover_url: card.cover_url} : {}),
    metadata_status: noteId ? "identified" : "link"
  }
}

export function extractXiaohongshuShareFromText(value = "") {
  const text = decodeXiaohongshuCardEntities(value)
  const cardJson = extractCardJson(text)
  if (cardJson) {
    const news = record(record(record(cardJson).meta).news)
    const tag = cleanText(news.tag, 40)
    const jumpUrl = normalizeUrl(news.jumpUrl)
    const cardUrl = allowedXiaohongshuHost(jumpUrl) ? jumpUrl : findXiaohongshuUrlInJson(cardJson)
    if (cardUrl && (tag === "小红书" || allowedXiaohongshuHost(cardUrl))) {
      const preview = normalizeUrl(news.preview)
      const extras:Partial<XiaohongshuCard> = {}
      const title = cleanText(news.title, 300)
      const description = cleanText(news.desc, 1000)
      if (title) extras.title = title
      if (description) extras.description = description
      if (preview && /qq\.ugcimg\.cn|xiaohongshu|xhscdn/i.test(preview)) extras.cover_url = preview
      return buildBaseCard(cardUrl, extras)
    }
  }
  const match = text.match(/https?:\/\/(?:xhslink\.com|(?:www\.)?xiaohongshu\.com)\/[^\s，。！？；;）)\]}>]+/i)
  if (!match) return null
  const url = normalizeUrl(match[0])
  if (!allowedXiaohongshuHost(url)) return null
  return buildBaseCard(url)
}

// 提取 <script>window.__INITIAL_STATE__={...}</script> 的平衡 JSON;
// SSR 数据里允许出现 undefined 字面量,解析失败时回退替换为 null 再试。
function extractBalancedJson(text = "", marker = ""):unknown {
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
      const raw = text.slice(start, index + 1)
      try {
        return JSON.parse(raw)
      } catch {
        try {
          return JSON.parse(raw.replace(/\bundefined\b/g, "null"))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export function parseXiaohongshuInitialState(html = "") {
  return record(record(record(extractBalancedJson(html, "window.__INITIAL_STATE__")).note).noteDetailMap)
}

export function buildCardFromNoteState(base:XiaohongshuCard = {}, noteDetailMap:Record<string,unknown> = {}, finalUrl = ""):XiaohongshuCard|null {
  const entries = Object.entries(noteDetailMap)
  if (!entries.length) return null
  const wantedId = String(base.note_id || "")
  const entry = (wantedId && noteDetailMap[wantedId] ? record(noteDetailMap[wantedId]) : record(entries[0]?.[1]))
  const note = record(entry.note)
  const hasContent = cleanText(note.title) || cleanText(note.desc)
  if (!hasContent) return null
  const user = record(note.user)
  const interact = record(note.interactInfo)
  const imageList = Array.isArray(note.imageList) ? note.imageList : []
  const images = [...new Set(imageList.map(image => {
    const info = record(image)
    const infoList = Array.isArray(info.infoList) ? info.infoList : []
    return normalizeXiaohongshuImageUrl(record(infoList[0]).url || info.urlDefault || info.url)
  }).filter(Boolean))]
  const video = record(note.video)
  const firstFrame = normalizeXiaohongshuImageUrl(record(video.image).firstFrameUrl || record(imageList[0]).urlDefault)
  return {
    ...base,
    title: cleanText(note.title, 300) || "小红书笔记",
    description: cleanText(note.desc, 1000),
    author: cleanText(user.nickname, 120),
    liked: parseCount(interact.liked),
    collected: parseCount(interact.collected),
    comment_count: parseCount(interact.commentCount),
    media_kind: note.type === "video" || video.media ? "video" : "image",
    cover_url: images[0] || firstFrame || base.cover_url || "",
    images,
    page_url: base.page_url || normalizeUrl(finalUrl),
    final_url: normalizeUrl(finalUrl) || base.final_url || "",
    metadata_status: "resolved"
  }
}

export function createXiaohongshuMessage(ports:{browserResolver?:XiaohongshuOptions['browserResolver'];logger?:MediaLogger} = {}) {
// 笔记页数据是短时资源;缓存只用于合并几乎同时到达的同一链接(同一笔记被两人接连分享)。
const XHS_CACHE_TTL_MS = 30 * 1000
const XHS_CACHE_MAX = 100
const metadataCache = new Map<string,{promise:Promise<XiaohongshuCard>;expiresAt:number}>()
// 在途富化合并:outbox 预刷新(cacheTtlMs:0)与消息侧几乎同时到达时避免并发开两个浏览器页
const inflightEnrichments = new Map<string,{promise:Promise<XiaohongshuCard>}>()
// 小红书无登录态 SSR 不出笔记数据(2026-10 实测),静态解析持续失败时短期跳过省时
let lastStaticFailAt = 0
const STATIC_FAIL_SKIP_MS = 30 * 60 * 1000

function pruneCache() {
  const now = Date.now()
  for (const [key, item] of metadataCache) {
    if (!item || item.expiresAt <= now) metadataCache.delete(key)
  }
  while (metadataCache.size > XHS_CACHE_MAX) metadataCache.delete(metadataCache.keys().next().value!)
}

async function requestXiaohongshuPage(card:XiaohongshuCard = {}, { fetchImpl, timeoutMs, cookieHeader = "" }:{fetchImpl:typeof fetch;timeoutMs:number;cookieHeader?:string}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 7000))
  try {
    const entry = card.page_url || card.short_url || ""
    const response = await fetchImpl(entry, {
      headers: {
        "User-Agent": XHS_MOBILE_UA,
        Accept: "text/html,application/xhtml+xml",
        ...(cookieHeader ? {Cookie: cookieHeader} : {})
      },
      redirect: "follow",
      signal: controller.signal
    })
    const finalUrl = normalizeUrl(response?.url || entry)
    if (!response?.ok || !allowedXiaohongshuHost(finalUrl)) throw new Error("小红书笔记页不可用")
    const resolved = buildCardFromNoteState(card, parseXiaohongshuInitialState(await response.text()), finalUrl)
    if (!resolved) throw new Error("小红书笔记页未提供笔记数据")
    return resolved
  } finally {
    clearTimeout(timer)
  }
}

async function enrichXiaohongshuShare(card:XiaohongshuCard = {}, options:XiaohongshuOptions = {}):Promise<XiaohongshuCard> {
  if (!card || card.type !== "xiaohongshu") return card
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== "function") return card
  const key = card.note_id || card.short_url || card.page_url
  if (!key) return card
  const skipStaticParse = !options.forceStaticParse && Date.now() - lastStaticFailAt < STATIC_FAIL_SKIP_MS
  const cacheTtlMs = Math.max(0, Number(options.cacheTtlMs ?? XHS_CACHE_TTL_MS) || 0)
  pruneCache()
  const cached = metadataCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return await cached.promise
  const inflight = inflightEnrichments.get(key)
  if (inflight) return await inflight.promise
  const promise = (skipStaticParse
    ? Promise.reject(new Error("笔记页静态解析近期失败,跳过"))
    : requestXiaohongshuPage(card, { fetchImpl, timeoutMs: options.timeoutMs || 8000, cookieHeader: String(options.cookieHeader || "") }))
    .catch(async error => {
      lastStaticFailAt = Date.now()
      ;(options.logger || ports.logger)?.info?.(`[小红书] 笔记页静态解析失败(${errorText(error)}),尝试浏览器兜底: ${key}`)
      try {
        const resolver = options.browserResolver || ports.browserResolver
        const resolved = await resolver?.(card, { logger: options.logger || ports.logger })
        if (resolved && (resolved.images?.length || resolved.title || resolved.cover_url)) {
          const images = [...new Set((Array.isArray(resolved.images) ? resolved.images : []).map(url => normalizeXiaohongshuImageUrl(url)).filter(Boolean))]
          return {
            ...card,
            title: cleanText(resolved.title || card.title || "小红书笔记", 300),
            description: cleanText(resolved.description || card.description || "", 1000),
            author: cleanText(resolved.author || card.author || "", 120),
            liked: resolved.liked || card.liked || 0,
            collected: resolved.collected || card.collected || 0,
            comment_count: resolved.comment_count || card.comment_count || 0,
            media_kind: resolved.media_kind || card.media_kind || "",
            note_id: String(resolved.note_id || card.note_id || "").trim(),
            cover_url: images[0] || resolved.cover_url || card.cover_url || "",
            images,
            final_url: resolved.final_url || card.final_url || "",
            metadata_status: "resolved"
          }
        }
      } catch (fallbackError) {
        ;(options.logger || ports.logger)?.warn?.(`[小红书] 浏览器兜底也失败: ${errorText(fallbackError)}`)
      }
      // 卡片自带标题/摘要/预览图,解析全失败时至少保留这些
      return { ...card, metadata_status: card.metadata_status || "link" }
    })
  const wrapped = promise.then(result => {
    if (result.metadata_status === "resolved") lastStaticFailAt = 0
    return result
  })
  const inflightRecord = { promise: wrapped }
  inflightEnrichments.set(key, inflightRecord)
  metadataCache.set(key, { promise: wrapped, expiresAt: Date.now() + cacheTtlMs })
  try {
    return await wrapped
  } finally {
    if (inflightEnrichments.get(key) === inflightRecord) inflightEnrichments.delete(key)
  }
}

function formatXiaohongshuHistoryText(card:XiaohongshuCard = {}) {
  const imageCount = Array.isArray(card.images) ? card.images.length : 0
  const lines = [`分享了小红书笔记《${card.title || "未命名笔记"}》`]
  const basic = []
  if (card.author) basic.push(`作者:${card.author}`)
  if (card.note_id) basic.push(`笔记:${card.note_id}`)
  if (imageCount) basic.push(`图片:${imageCount}张`)
  if (card.media_kind === "video") basic.push("视频笔记")
  if (basic.length) lines.push(basic.join(" | "))
  const stats = []
  if (card.liked) stats.push(`点赞:${card.liked}`)
  if (card.collected) stats.push(`收藏:${card.collected}`)
  if (card.comment_count) stats.push(`评论:${card.comment_count}`)
  if (stats.length) lines.push(`数据：${stats.join(" ")}`)
  if (card.description && card.description !== card.title) lines.push(`简介：${cleanText(card.description, 240)}`)
  return lines.join("\n")
}

function formatXiaohongshuHistoryLinks(card:XiaohongshuCard = {}) {
  return [
    card.page_url || card.short_url ? `笔记 URL:${card.page_url || card.short_url}` : "",
    card.cover_url ? `封面 URL:${card.cover_url}` : ""
  ].filter(Boolean).join("，")
}

function clearXiaohongshuMetadataCache() {
  lastStaticFailAt = 0
  metadataCache.clear()
  inflightEnrichments.clear()
}

return {extractXiaohongshuShareFromText,enrichXiaohongshuShare,formatXiaohongshuHistoryText,formatXiaohongshuHistoryLinks,clearXiaohongshuMetadataCache}
}
