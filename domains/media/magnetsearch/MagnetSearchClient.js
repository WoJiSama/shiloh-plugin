import { addPublicTrackersToMagnet, formatBytes } from "../../../utils/torrentDownload.js"

const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce"
]

const DEFAULT_TIMEOUT_MS = 10000
const DEFAULT_PROXY_TIMEOUT_MS = 8000
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20
const DEFAULT_SEARCH_URL = "https://torrents-csv.com/service/search"
const DEFAULT_PROXY_URL = "http://127.0.0.1:7890"
const DEFAULT_BITSEARCH_URL = "https://bitsearch.eu/search"
const DEFAULT_SOLID_URL = "https://solidtorrents.to/api/v1/search"
const INFO_HASH_RE = /^[a-f\d]{40}$/i
const proxyFetchCache = new Map()

export function normalizeMagnetSearchConfig(config = {}) {
  const source = config.magnetSearchSystem || config
  const proxyUrl = String(source.proxyUrl ?? DEFAULT_PROXY_URL).trim()
  return {
    enabled: source.enabled !== false,
    searchUrl: String(source.searchUrl || DEFAULT_SEARCH_URL).trim().replace(/\/+$/, "") || DEFAULT_SEARCH_URL,
    bitsearchUrl: String(source.bitsearchUrl || DEFAULT_BITSEARCH_URL).trim().replace(/\/+$/, "") || DEFAULT_BITSEARCH_URL,
    solidSearchUrl: String(source.solidSearchUrl || DEFAULT_SOLID_URL).trim().replace(/\/+$/, "") || DEFAULT_SOLID_URL,
    proxyUrl: /^https?:\/\//i.test(proxyUrl) ? proxyUrl.replace(/\/+$/, "") : "",
    timeoutMs: Math.max(1000, Math.min(Number(source.timeoutMs) || DEFAULT_TIMEOUT_MS, 60000)),
    proxyTimeoutMs: Math.max(1000, Math.min(Number(source.proxyTimeoutMs) || DEFAULT_PROXY_TIMEOUT_MS, 30000))
  }
}

export function normalizeSearchLimit(value, fallback = DEFAULT_LIMIT) {
  const number = Number.parseInt(value, 10)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.max(1, Math.min(number, MAX_LIMIT))
}

export function getMagnetSearchHelp() {
  return [
    "磁力搜索",
    "说明：[] 内为可选参数，<> 内为必填参数",
    ".磁力 <关键词> [数量] - 搜索磁力资源，只返回清单，不会自动下载",
    "默认 10 条，最多 20 条。找到磁链后可直接发送，走现有磁链下载。"
  ].join("\n")
}

export function buildMagnetFromInfoHash(infoHash, name = "", trackers = DEFAULT_TRACKERS) {
  const hash = String(infoHash || "").trim().toLowerCase()
  if (!INFO_HASH_RE.test(hash)) return ""
  const params = [`xt=urn:btih:${hash}`]
  const displayName = String(name || "").trim()
  if (displayName) params.push(`dn=${encodeURIComponent(displayName)}`)
  for (const tracker of trackers) {
    if (tracker) params.push(`tr=${encodeURIComponent(tracker)}`)
  }
  return `magnet:?${params.join("&")}`
}

export function buildMagnetSearchUrl(searchUrl, { keyword = "", limit = DEFAULT_LIMIT } = {}) {
  const url = new URL(String(searchUrl || DEFAULT_SEARCH_URL).trim() || DEFAULT_SEARCH_URL)
  url.searchParams.set("q", String(keyword || "").trim())
  url.searchParams.set("size", String(Math.max(normalizeSearchLimit(limit), 25)))
  return url.toString()
}

export function buildBitsearchSearchUrl(searchUrl, { keyword = "" } = {}) {
  const url = new URL(String(searchUrl || DEFAULT_BITSEARCH_URL).trim() || DEFAULT_BITSEARCH_URL)
  url.searchParams.set("q", String(keyword || "").trim())
  return url.toString()
}

export function buildSolidSearchUrl(searchUrl, { keyword = "", limit = DEFAULT_LIMIT } = {}) {
  const url = new URL(String(searchUrl || DEFAULT_SOLID_URL).trim() || DEFAULT_SOLID_URL)
  url.searchParams.set("q", String(keyword || "").trim())
  url.searchParams.set("limit", String(normalizeSearchLimit(limit)))
  url.searchParams.set("sort", "seeders")
  return url.toString()
}

async function defaultProxyFetchFactory(proxyUrl) {
  if (!/^https?:\/\//i.test(proxyUrl)) throw new Error(`磁力搜索代理地址不合法: ${proxyUrl}`)
  const cached = proxyFetchCache.get(proxyUrl)
  if (cached) return cached
  const { fetch: undiciFetch, ProxyAgent } = await import("undici")
  const agent = new ProxyAgent(proxyUrl)
  const wrapped = (url, init = {}) => undiciFetch(url, { ...init, dispatcher: agent, redirect: "follow" })
  proxyFetchCache.set(proxyUrl, wrapped)
  return wrapped
}

export class MagnetSearchClient {
  constructor(config = {}, {
    fetchImpl = globalThis.fetch,
    proxyFetchImpl = null,
    proxyFetchFactory = defaultProxyFetchFactory
  } = {}) {
    this.config = normalizeMagnetSearchConfig(config)
    this.fetchImpl = fetchImpl
    this.proxyFetchImpl = proxyFetchImpl
    this.proxyFetchFactory = proxyFetchFactory
  }

  assertReady() {
    if (!this.config.enabled) throw new Error("磁力搜索未启用，请先在锅巴开启")
    if (!this.config.searchUrl) throw new Error("磁力搜索地址未配置")
    if (typeof this.fetchImpl !== "function") throw new Error("当前运行环境不支持 fetch")
  }

  async getProxyFetch() {
    if (this.proxyFetchImpl) return this.proxyFetchImpl
    if (!this.config.proxyUrl) return null
    return this.proxyFetchFactory(this.config.proxyUrl)
  }

  async requestJson(fetchImpl, url, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "bl-chat-plugin-magnet-search"
        },
        signal: controller.signal
      })
      const raw = await response.text()
      let body = null
      if (raw) {
        try { body = JSON.parse(raw) } catch { body = raw }
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return body
    } catch (err) {
      if (err?.name === "AbortError") throw new Error("请求超时")
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  async requestText(fetchImpl, url, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "Mozilla/5.0"
        },
        signal: controller.signal
      })
      const raw = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return raw
    } catch (err) {
      if (err?.name === "AbortError") throw new Error("请求超时")
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  async searchCsv(keyword, limit) {
    return this.requestJson(
      this.fetchImpl,
      buildMagnetSearchUrl(this.config.searchUrl, { keyword, limit }),
      this.config.timeoutMs
    )
  }

  async searchBitsearch(keyword) {
    const proxyFetch = await this.getProxyFetch()
    if (!proxyFetch) throw new Error("未配置代理，跳过 BitSearch")
    const html = await this.requestText(
      proxyFetch,
      buildBitsearchSearchUrl(this.config.bitsearchUrl, { keyword }),
      this.config.proxyTimeoutMs
    )
    return { torrents: parseBitsearchHtml(html) }
  }

  async searchSolid(keyword, limit) {
    const proxyFetch = await this.getProxyFetch()
    if (!proxyFetch) throw new Error("未配置代理，跳过 SolidTorrents")
    return this.requestJson(
      proxyFetch,
      buildSolidSearchUrl(this.config.solidSearchUrl, { keyword, limit }),
      Math.min(this.config.proxyTimeoutMs, 5000)
    )
  }

  async search({ keyword = "", limit = DEFAULT_LIMIT } = {}) {
    this.assertReady()
    const text = String(keyword || "").trim()
    if (!text) throw new Error("请提供要搜索的关键词")
    const resultLimit = normalizeSearchLimit(limit)

    const tasks = [
      this.searchCsv(text, resultLimit).then(body => ({ source: "csv", body }))
    ]
    if (this.config.proxyUrl) {
      tasks.push(this.searchBitsearch(text).then(body => ({ source: "bitsearch", body })))
      tasks.push(this.searchSolid(text, resultLimit).then(body => ({ source: "solid", body })))
    }

    const settled = await Promise.allSettled(tasks)
    const bodies = []
    const errors = []
    for (const item of settled) {
      if (item.status === "fulfilled") {
        bodies.push(item.value.body)
      } else {
        errors.push(item.reason?.message || String(item.reason || "未知错误"))
      }
    }

    const torrents = mergeMagnetSearchItems(bodies, resultLimit)
    if (!torrents.length && errors.length && settled.every(item => item.status === "rejected")) {
      throw new Error(`磁力搜索失败：${errors[0]}`)
    }

    return {
      torrents,
      keyword: text,
      limit: resultLimit,
      sources: settled.map(item => item.status)
    }
  }
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&#x3D;/gi, "=")
    .replace(/&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
}

export function parseBitsearchHtml(html) {
  const decoded = decodeHtml(html)
  const cards = decoded.split(/bg-white rounded-lg shadow-sm border/)
  const items = []
  for (const card of cards.slice(1)) {
    const magnet = card.match(/href="(magnet:\?xt=urn:btih:[^"]+)"/i)?.[1] || ""
    const infoHash = card.match(/\/download\/torrent\/([a-fA-F0-9]{40})/i)?.[1]
      || magnet.match(/btih:([a-fA-F0-9]{40})/i)?.[1]
      || ""
    const name = card.match(/<a href="\/torrent\/[^"]+"[^>]*>\s*([^<]+?)\s*</i)?.[1]?.trim() || ""
    const size = card.match(/<span>([\d.]+ [KMGT]B)<\/span>/i)?.[1] || ""
    const seeders = Number(card.match(/<span class="font-medium">(\d+)<\/span>\s*<span>seeders<\/span>/i)?.[1] || 0)
    const leechers = Number(card.match(/<span class="font-medium">(\d+)<\/span>\s*<span>leechers<\/span>/i)?.[1] || 0)
    if (!infoHash && !magnet) continue
    items.push({
      name,
      infohash: infoHash,
      magnet,
      size,
      seeders,
      leechers
    })
  }
  return items
}

function unwrap(body) {
  if (!body || typeof body !== "object") return body
  if (Array.isArray(body.torrents) || Array.isArray(body.list) || Array.isArray(body.items) || Array.isArray(body.results)) {
    return body
  }
  if (body.data !== undefined) return body.data
  return body
}

function getItems(data) {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== "object") return []
  for (const key of ["torrents", "list", "items", "results", "hits"]) {
    if (Array.isArray(data[key])) return data[key]
  }
  return []
}

function toCount(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return Math.floor(number)
}

function parseSizeToBytes(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
  const text = String(value || "").trim().replace(/,/g, "")
  const match = text.match(/^([\d.]+)\s*(B|KB|MB|GB|TB|KIB|MIB|GIB|TIB)$/i)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null
  const unit = match[2].toUpperCase()
  const factor = {
    B: 1,
    KB: 1e3,
    MB: 1e6,
    GB: 1e9,
    TB: 1e12,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4
  }[unit]
  return factor ? amount * factor : null
}

function extractMagnet(item, name) {
  const direct = String(item.magnet || item.magnetUrl || item.magnetURI || item.magnetUri || "").trim()
  if (/^magnet:\?xt=urn:btih:[a-f\d]{40}/i.test(direct)) {
    try {
      return addPublicTrackersToMagnet(direct)
    } catch {
      return direct
    }
  }
  const infoHash = String(item.infohash || item.infoHash || item.hash || item.btih || "").trim()
  return buildMagnetFromInfoHash(infoHash, name)
}

export function normalizeMagnetSearchItems(body, { limit = DEFAULT_LIMIT } = {}) {
  const items = getItems(unwrap(body))
    .map((item, index) => {
      if (!item || typeof item !== "object") return null
      const infoHash = String(item.infohash || item.infoHash || item.hash || item.btih || "").trim()
      const name = String(item.name || item.title || item.dn || "").trim() || (INFO_HASH_RE.test(infoHash) ? infoHash : `结果${index + 1}`)
      const magnet = extractMagnet(item, name)
      if (!magnet) return null
      const sizeBytes = parseSizeToBytes(item.size_bytes ?? item.sizeBytes ?? item.bytes ?? item.length ?? item.size)
      return {
        name,
        infoHash: INFO_HASH_RE.test(infoHash) ? infoHash.toLowerCase() : "",
        magnet,
        sizeBytes,
        size: sizeBytes == null ? String(item.size || "") : formatBytes(sizeBytes),
        seeders: toCount(item.seeders ?? item.seeds),
        leechers: toCount(item.leechers ?? item.peers ?? item.leeches)
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.seeders - a.seeders) || ((b.sizeBytes || 0) - (a.sizeBytes || 0)))
    .slice(0, normalizeSearchLimit(limit))
    .map((item, index) => ({ ...item, rank: index + 1 }))

  return items
}

export function mergeMagnetSearchItems(bodies, limit = DEFAULT_LIMIT) {
  const merged = []
  const seen = new Set()
  for (const body of bodies) {
    for (const item of normalizeMagnetSearchItems(body, { limit: MAX_LIMIT })) {
      const key = item.infoHash || item.magnet
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push(item)
    }
  }
  return merged
    .sort((a, b) => (b.seeders - a.seeders) || ((b.sizeBytes || 0) - (a.sizeBytes || 0)))
    .slice(0, normalizeSearchLimit(limit))
    .map((item, index) => ({ ...item, rank: index + 1 }))
}

export function buildMagnetSearchReportData(body, { keyword = "", limit = DEFAULT_LIMIT } = {}) {
  const searchText = keyword || body?.keyword || ""
  const items = Array.isArray(body?.torrents) && body.torrents[0]?.magnet
    ? mergeMagnetSearchItems([body], limit || body?.limit)
    : normalizeMagnetSearchItems(body, { limit: limit || body?.limit })
  const title = searchText
    ? `磁力搜索：${searchText}（Top ${items.length}）`
    : `磁力搜索（Top ${items.length}）`

  return {
    kind: "magnet-search",
    title,
    subtitle: "公开索引直连 + VPN 补充源｜只展示清单，不会自动下载｜默认 10 条，最多 20 条",
    generatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    columns: ["排名", "名称", "大小", "做种/下载", "磁链"],
    emptyText: searchText ? `没有找到「${searchText}」相关的磁力资源` : "暂时没有拿到磁力搜索数据",
    rows: items.map(item => ({
      rank: item.rank,
      name: item.name,
      size: item.size || "-",
      seeders: String(item.seeders),
      leechers: String(item.leechers),
      magnet: item.magnet
    }))
  }
}

export function formatMagnetSearchResponse(body, { keyword = "", limit = DEFAULT_LIMIT } = {}) {
  const report = buildMagnetSearchReportData(body, { keyword, limit })
  if (!report.rows.length) return report.emptyText
  const lines = [report.title]
  for (const row of report.rows) {
    lines.push(`${row.rank}. ${row.name}｜${row.size}｜做种 ${row.seeders}｜下载 ${row.leechers}`)
    lines.push(`磁链：${row.magnet}`)
  }
  return lines.join("\n")
}
