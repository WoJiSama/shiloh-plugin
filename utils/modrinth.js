import { createHash } from "node:crypto"

export const MODRINTH_API_BASE = "https://api.modrinth.com/v2"
export const MODRINTH_RANK_SORTS = ["downloads", "follows", "newest", "updated", "relevance"]

const MODRINTH_SORT_ALIASES = {
  recently_updated: "updated",
  recentlyupdated: "updated",
  latest_updated: "updated",
  most_recently_updated: "updated",
  updated_at: "updated",
  latest: "newest",
  newest_first: "newest",
  popular: "downloads",
  most_downloaded: "downloads",
  download_count: "downloads",
  most_followed: "follows",
  follows_count: "follows"
}

const MODRINTH_CATEGORY_ALIASES = {
  "魔法": "magic",
  "优化": "optimization",
  "性能": "optimization",
  "冒险": "adventure",
  "装饰": "decoration",
  "建筑": "decoration",
  "科技": "technology"
}

const SORT_LABELS = {
  downloads: "历史下载量",
  follows: "关注数",
  newest: "最新发布",
  updated: "最近更新",
  relevance: "相关度"
}

function normalizeText(value = "", maxLength = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength)
}

function normalizeTextList(value, { maxEntries = 64, maxLength = 48 } = {}) {
  const seen = new Set()
  return (Array.isArray(value) ? value : [])
    .map(item => normalizeText(item, maxLength))
    .filter(item => item && !seen.has(item) && (seen.add(item) || true))
    .slice(0, maxEntries)
}

function normalizeUrl(value = "") {
  const text = String(value || "").trim()
  return /^https:\/\//i.test(text) ? text : ""
}

export function normalizeModrinthRankOptions(options = {}) {
  const rawSort = String(options.sort || "downloads").trim().toLowerCase()
  const sort = MODRINTH_SORT_ALIASES[rawSort] || rawSort
  const loader = String(options.loader || "").trim().toLowerCase()
  const rawCategory = String(options.category || "").trim().toLowerCase()
  const category = MODRINTH_CATEGORY_ALIASES[rawCategory] || rawCategory
  const gameVersion = normalizeText(options.gameVersion, 40)
  const query = normalizeText(options.query, 120)
  const limit = Math.max(1, Math.min(10, Math.floor(Number(options.limit) || 5)))

  if (!MODRINTH_RANK_SORTS.includes(sort)) throw new Error(`不支持的排序方式: ${sort}`)
  if (loader && !["fabric", "forge", "neoforge", "quilt"].includes(loader)) {
    throw new Error(`不支持的加载器: ${loader}`)
  }
  if (category && !/^[a-z0-9-]{1,64}$/.test(category)) throw new Error("模组分类格式不正确")
  if (gameVersion && !/^[A-Za-z0-9._-]{1,40}$/.test(gameVersion)) throw new Error("Minecraft 版本格式不正确")

  return { sort, loader, category, gameVersion, query, limit }
}

const CHINESE_LIMITS = new Map([
  ["一", 1], ["二", 2], ["两", 2], ["三", 3], ["四", 4], ["五", 5],
  ["六", 6], ["七", 7], ["八", 8], ["九", 9], ["十", 10]
])

export function parseModrinthRequestOptions(text = "") {
  const content = String(text || "").replace(/\s+/g, " ").trim()
  if (!content || !/(?:modrinth|mc\s*模组|minecraft\s*模组|(?:mc|minecraft).{0,24}(?:榜|排行|排名).{0,24}模组)/i.test(content)) return null
  const nameQuery = content.match(/(?:名字|名称)(?:里面|中|里)?(?:带有|包含|含有|有)\s*["“”']?([A-Za-z0-9][A-Za-z0-9._-]{0,47})/i)?.[1] || ""
  const isRankingRequest = /(?:排名|排行|榜|热门|前\s*(?:10|[1-9一二两三四五六七八九十]))/i.test(content)
  if (!isRankingRequest && !nameQuery) return null
  if (/https?:\/\/modrinth\.com\//i.test(content)) return null

  const limitMatch = content.match(/前\s*(10|[1-9]|[一二两三四五六七八九十])/i)
  const rawLimit = limitMatch?.[1] || ""
  const limit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : CHINESE_LIMITS.get(rawLimit) || 5
  const version = content.match(/\b(1\.\d{1,2}(?:\.\d{1,2})?)\b/)?.[1]
  const loader = content.match(/\b(fabric|forge|neoforge|quilt)\b/i)?.[1]?.toLowerCase()
  const categoryMap = [
    [/优化|性能/i, "optimization"],
    [/冒险/i, "adventure"],
    [/装饰|建筑/i, "decoration"],
    [/科技/i, "technology"],
    [/魔法/i, "magic"]
  ]
  const category = categoryMap.find(([pattern]) => pattern.test(content))?.[1]
  const sort = nameQuery
    ? "relevance"
    : /关注(?:数|量)?|按关注/.test(content)
    ? "follows"
    : /最新发布|新发布|最新上架/.test(content)
      ? "newest"
      : /最近更新|按更新/.test(content)
        ? "updated"
        : "downloads"

  return normalizeModrinthRankOptions({
    sort,
    limit,
    ...(version ? { gameVersion: version } : {}),
    ...(loader ? { loader } : {}),
    ...(category ? { category } : {}),
    ...(nameQuery ? { query: nameQuery } : {})
  })
}

export function buildModrinthSearchUrl(options = {}) {
  const normalized = normalizeModrinthRankOptions(options)
  const facets = [["project_type:mod"]]
  if (normalized.gameVersion) facets.push([`versions:${normalized.gameVersion}`])
  if (normalized.loader) facets.push([`categories:${normalized.loader}`])
  if (normalized.category && normalized.category !== normalized.loader) facets.push([`categories:${normalized.category}`])

  const params = new URLSearchParams({
    query: normalized.query,
    limit: String(normalized.limit),
    index: normalized.sort,
    facets: JSON.stringify(facets)
  })
  return `${MODRINTH_API_BASE}/search?${params.toString()}`
}

function formatNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? new Intl.NumberFormat("zh-CN").format(number) : "未知"
}

export function buildModrinthRankingData(payload = {}, options = {}) {
  const query = normalizeModrinthRankOptions(options)
  const hits = Array.isArray(payload?.hits) ? payload.hits : []
  return {
    kind: "modrinth_ranking",
    version: 1,
    source: "https://api.modrinth.com/v2/search",
    totalHits: Math.max(0, Number(payload?.total_hits) || 0),
    query,
    items: hits.map((hit, index) => {
      const slug = normalizeText(hit?.slug || hit?.project_id || "", 160)
      return {
        rank: index + 1,
        projectId: normalizeText(hit?.project_id || slug, 160),
        slug,
        name: normalizeText(hit?.title || slug || "未命名模组", 160),
        author: normalizeText(hit?.author || "未知", 120),
        downloads: Math.max(0, Number(hit?.downloads) || 0),
        follows: Math.max(0, Number(hit?.follows) || 0),
        tags: normalizeTextList(hit?.categories, { maxEntries: 8, maxLength: 64 }),
        gameVersions: normalizeTextList(hit?.versions),
        clientSide: normalizeText(hit?.client_side || "unknown", 32),
        serverSide: normalizeText(hit?.server_side || "unknown", 32),
        dateCreated: normalizeText(hit?.date_created || "", 64),
        dateModified: normalizeText(hit?.date_modified || "", 64),
        license: normalizeText(hit?.license || "", 160),
        iconUrl: normalizeUrl(hit?.icon_url),
        descriptionEn: normalizeText(hit?.description || "", 1000),
        pageUrl: slug ? `https://modrinth.com/mod/${encodeURIComponent(slug)}` : ""
      }
    })
  }
}

export function parseModrinthRankingData(value) {
  let data = value
  if (typeof data === "string") {
    try {
      data = JSON.parse(data)
    } catch {
      return null
    }
  }
  if (!data || data.kind !== "modrinth_ranking" || !Array.isArray(data.items)) return null
  const items = data.items
    .slice(0, 10)
    .filter(item => item && Number(item.rank) > 0 && item.name && item.projectId)
    .map(item => ({
      rank: Math.floor(Number(item.rank)),
      projectId: normalizeText(item.projectId, 160),
      slug: normalizeText(item.slug, 160),
      name: normalizeText(item.name, 160),
      author: normalizeText(item.author || "未知", 120),
      downloads: Math.max(0, Number(item.downloads) || 0),
      follows: Math.max(0, Number(item.follows) || 0),
      tags: normalizeTextList(item.tags, { maxEntries: 8, maxLength: 64 }),
      gameVersions: normalizeTextList(item.gameVersions),
      clientSide: normalizeText(item.clientSide || "unknown", 32),
      serverSide: normalizeText(item.serverSide || "unknown", 32),
      dateCreated: normalizeText(item.dateCreated || "", 64),
      dateModified: normalizeText(item.dateModified || "", 64),
      license: normalizeText(item.license || "", 160),
      iconUrl: normalizeUrl(item.iconUrl),
      descriptionEn: normalizeText(item.descriptionEn, 1000),
      pageUrl: /^https:\/\/modrinth\.com\/mod\//i.test(String(item.pageUrl || "")) ? String(item.pageUrl) : ""
    }))
  return items.length ? { ...data, items } : null
}

export function formatModrinthRanking(payload = {}, options = {}) {
  const ranking = buildModrinthRankingData(payload, options)
  const normalized = ranking.query
  const hits = ranking.items
  const filters = [
    normalized.gameVersion ? `MC ${normalized.gameVersion}` : "全部 MC 版本",
    normalized.loader || "全部加载器",
    normalized.category && normalized.category !== normalized.loader ? normalized.category : "全部分类",
    normalized.query ? `关键词:${normalized.query}` : "无关键词"
  ]
  const lines = [
    "【Modrinth 模组排名】",
    `排序: ${SORT_LABELS[normalized.sort] || normalized.sort}`,
    `筛选: ${filters.join(" | ")}`,
    `匹配项目: ${ranking.totalHits} 个；以下列出 ${hits.length} 个。`,
    "数据来源: Modrinth 公开 API，数据会随查询时间变化。",
    ""
  ]

  for (const hit of hits) {
    lines.push(`#${hit.rank} ${hit.name}`)
    lines.push(`作者: ${hit.author}`)
    lines.push(`下载: ${formatNumber(hit.downloads)} | 关注: ${formatNumber(hit.follows)}`)
    if (hit.tags.length) lines.push(`标签: ${hit.tags.join(", ")}`)
    if (hit.descriptionEn) lines.push(`英文简介: ${hit.descriptionEn}`)
    else lines.push("英文简介: (该项目未提供简介)")
    if (hit.pageUrl) lines.push(`项目页: ${hit.pageUrl}`)
    lines.push("")
  }

  if (!hits.length) lines.push("没有找到符合条件的 Modrinth 模组，不要根据记忆补出排名。")
  return lines.join("\n").trim()
}

export const MODRINTH_TRANSLATION_PROMPT_VERSION = "v2-descriptions-only"

function translationCacheKey(description, locale = "zh-CN", promptVersion = MODRINTH_TRANSLATION_PROMPT_VERSION) {
  return createHash("sha256").update(`${locale}\0${promptVersion}\0${description}`).digest("hex")
}

export class ModrinthTranslationCache {
  constructor({ ttlMs = 7 * 24 * 60 * 60 * 1000, maxEntries = 512 } = {}) {
    this.ttlMs = Math.max(60_000, Number(ttlMs) || 7 * 24 * 60 * 60 * 1000)
    this.maxEntries = Math.max(16, Number(maxEntries) || 512)
    this.cache = new Map()
  }

  get(description, options = {}) {
    const key = translationCacheKey(description, options.locale, options.promptVersion)
    const item = this.cache.get(key)
    if (!item || item.expiresAt <= Date.now()) {
      this.cache.delete(key)
      return ""
    }
    this.cache.delete(key)
    this.cache.set(key, item)
    return item.text
  }

  set(description, text, options = {}) {
    const source = normalizeText(description, 1000)
    const translated = normalizeText(text, 1200)
    if (!source || !translated) return
    const key = translationCacheKey(source, options.locale, options.promptVersion)
    this.cache.set(key, { text: translated, expiresAt: Date.now() + this.ttlMs })
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value)
  }

  clear() {
    this.cache.clear()
  }
}

export const modrinthTranslationCache = new ModrinthTranslationCache()

export function collectModrinthTranslations(ranking, cache = modrinthTranslationCache) {
  const normalized = parseModrinthRankingData(ranking)
  if (!normalized) return { cached: new Map(), missing: [] }
  const cached = new Map()
  const missing = []
  for (const item of normalized.items) {
    if (!item.descriptionEn) {
      cached.set(item.projectId, "暂无官方英文简介")
      continue
    }
    const translated = cache?.get?.(item.descriptionEn) || ""
    if (translated) cached.set(item.projectId, translated)
    else missing.push({ projectId: item.projectId, en: item.descriptionEn })
  }
  return { cached, missing }
}

export function parseModrinthTranslationResponse(text = "", expectedProjectIds = []) {
  const source = String(text || "").trim()
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] || source
  let parsed
  try {
    parsed = JSON.parse(fenced)
  } catch {
    return null
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.translations
  if (!Array.isArray(rows)) return null
  const expected = new Set(expectedProjectIds.map(String))
  const result = new Map()
  for (const row of rows) {
    const projectId = String(row?.projectId || "")
    const zh = normalizeText(row?.zh, 1200)
    if (!expected.has(projectId) || !zh || result.has(projectId)) continue
    result.set(projectId, zh)
  }
  return result.size === expected.size ? result : null
}

export function cacheModrinthTranslations(ranking, translations, cache = modrinthTranslationCache) {
  const normalized = parseModrinthRankingData(ranking)
  if (!normalized || !(translations instanceof Map)) return
  for (const item of normalized.items) {
    const text = translations.get(item.projectId)
    if (item.descriptionEn && text) cache?.set?.(item.descriptionEn, text)
  }
}

export function buildModrinthForwardItemsFromData(ranking, translations) {
  const normalized = parseModrinthRankingData(ranking)
  if (!normalized || !(translations instanceof Map)) return []
  return normalized.items.map(item => [
    `排名: 第 ${item.rank} 名`,
    `名称: ${item.name}`,
    `作者: ${item.author}`,
    `下载: ${formatNumber(item.downloads)}`,
    `关注: ${formatNumber(item.follows)}`,
    `标签: ${item.tags.length ? item.tags.join(", ") : "无"}`,
    `英文简介: ${item.descriptionEn || "暂无官方英文简介"}`,
    `中文翻译（希洛）: ${translations.get(item.projectId) || "翻译暂时不可用"}`,
    `项目页: ${item.pageUrl}`
  ].join("\n"))
}

function formatModrinthDate(value = "") {
  const date = new Date(String(value || ""))
  if (Number.isNaN(date.getTime())) return "未知"
  return date.toISOString().slice(0, 10)
}

function formatSideRequirement(value = "") {
  const normalized = String(value || "unknown").toLowerCase()
  if (normalized === "required") return "必需"
  if (normalized === "optional") return "可选"
  if (normalized === "unsupported") return "不适用"
  return "未知"
}

function formatModrinthCardFallback(item, translated = "") {
  return [
    `排名: 第 ${item.rank} 名`,
    `名称: ${item.name}`,
    `作者: ${item.author}`,
    `下载: ${formatNumber(item.downloads)}`,
    `关注: ${formatNumber(item.follows)}`,
    `标签: ${item.tags.length ? item.tags.join(", ") : "无"}`,
    `支持的 MC 版本: ${item.gameVersions.length ? item.gameVersions.join(", ") : "未提供"}`,
    `安装侧: 客户端${formatSideRequirement(item.clientSide)} | 服务端${formatSideRequirement(item.serverSide)}`,
    `创建时间: ${formatModrinthDate(item.dateCreated)}`,
    `最近更新: ${formatModrinthDate(item.dateModified)}`,
    `许可证: ${item.license || "未提供"}`,
    `英文简介: ${item.descriptionEn || "暂无官方英文简介"}`,
    `中文翻译（希洛）: ${translated || "翻译暂时不可用"}`
  ].join("\n")
}

export function buildModrinthCardItemsFromData(ranking, translations) {
  const normalized = parseModrinthRankingData(ranking)
  if (!normalized || !(translations instanceof Map)) return []
  return normalized.items.map(item => {
    const translated = translations.get(item.projectId) || "翻译暂时不可用"
    return {
      projectId: item.projectId,
      pageUrl: item.pageUrl,
      fallbackText: formatModrinthCardFallback(item, translated),
      view: {
        title: `Modrinth 第 ${item.rank} 名`,
        rank: item.rank,
        name: item.name,
        author: item.author,
        downloads: formatNumber(item.downloads),
        follows: formatNumber(item.follows),
        tagsText: item.tags.length ? item.tags.join(" · ") : "无",
        versionsText: item.gameVersions.length ? item.gameVersions.join(" · ") : "未提供",
        clientSide: formatSideRequirement(item.clientSide),
        serverSide: formatSideRequirement(item.serverSide),
        dateCreated: formatModrinthDate(item.dateCreated),
        dateModified: formatModrinthDate(item.dateModified),
        license: item.license || "未提供",
        descriptionEn: item.descriptionEn || "暂无官方英文简介",
        descriptionZh: translated,
        iconUrl: item.iconUrl
      }
    }
  })
}

export function wrapModrinthForwardItems(items = []) {
  return items.map(item => `[[MODRINTH_ITEM]]\n${item}\n[[/MODRINTH_ITEM]]`).join("\n")
}

export function buildModrinthBilingualReplyInstruction() {
  return [
    "【Modrinth 双语简介回复规则】",
    "这是需要完整保留字段的查询结果。系统会根据结构化结果生成每项独立的 HTML 卡面；你只输出项目块，不要调用任何图片工具或自行改写字段。",
    "最终会被发送为一条合并转发：每个模组各占一个独立聊天节点。你必须只输出项目块，禁止写任何开头、结尾、总评、推荐、追问或聊天补话。",
    "每个项目必须按以下顺序逐项写全，不能省略、合并、改名或用‘基本都是’概括：排名、名称、作者、下载、关注、标签、英文简介、中文翻译（希洛）、项目页。排名必须直接写实际数字，例如‘排名: 第 5 名’；禁止输出字母 N、N 名、尖括号或任何占位符。",
    "严格使用下列标记包住每个项目，5 个项目就输出 5 个完整块，标记外不得有任何文字：\n[[MODRINTH_ITEM]]\n排名: 第 1 名\n名称: ...\n作者: ...\n下载: ...\n关注: ...\n标签: ...\n英文简介: ...\n中文翻译（希洛）: ...\n项目页: ...\n[[/MODRINTH_ITEM]]",
    "工具结果中的‘英文简介’是 Modrinth 原始资料，必须逐字保留。每个有实际英文简介的项目必须紧接着写‘中文翻译（希洛）：<忠实自然的中文翻译>’。",
    "中文翻译只能翻译对应英文原文，不得添加官网没有写出的功能、兼容性、性能结论或推荐理由；它是希洛的翻译，不是 Modrinth 官方中文文案。",
    "没有英文简介时明确写‘暂无官方英文简介’，不要编造中文简介。项目页必须保留完整 URL。不要使用 Markdown 加粗、表格或代码块。"
  ].join("\n")
}

export function buildModrinthTranslationMessages(items = []) {
  const source = (Array.isArray(items) ? items : [])
    .map(item => ({ projectId: String(item?.projectId || ""), en: normalizeText(item?.en, 1000) }))
    .filter(item => item.projectId && item.en)
  return [
    {
      role: "system",
      content: [
        "你只负责把 Modrinth 英文简介忠实翻译成简体中文。",
        "只输出严格 JSON 数组，每项格式为 {\"projectId\":\"原ID\",\"zh\":\"中文译文\"}。",
        "projectId 必须原样返回；不得输出排名、作者、下载量、标签、链接、Markdown、解释、推荐或其他字段。",
        "不得添加英文原文没有写出的功能、兼容性或性能结论。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify(source)
    }
  ]
}

const MODRINTH_REQUIRED_ITEM_FIELDS = [
  /^(?:排名\s*[:：]\s*第\s*\d+\s*名|第\s*\d+\s*名\s*[:：])/m,
  /^名称\s*[:：]/m,
  /^作者\s*[:：]/m,
  /^下载\s*[:：]/m,
  /^关注\s*[:：]/m,
  /^标签\s*[:：]/m,
  /^英文简介\s*[:：]/m,
  /^中文翻译（希洛）\s*[:：]/m,
  /^项目页\s*[:：]\s*https:\/\/modrinth\.com\/mod\//mi
]

export function extractModrinthForwardItems(text = "") {
  const source = String(text || "")
  const items = []
  const matcher = /\[\[MODRINTH_ITEM\]\]\s*([\s\S]*?)\s*\[\[\/MODRINTH_ITEM\]\]/g
  let match
  while ((match = matcher.exec(source))) {
    const item = normalizeModrinthForwardItem(match[1])
    if (item && MODRINTH_REQUIRED_ITEM_FIELDS.every(pattern => pattern.test(item))) items.push(item)
  }
  return items.slice(0, 10)
}

function normalizeModrinthForwardItem(item = "") {
  return String(item || "")
    .replace(/^第\s*n\s*名\s*[:：]\s*(10|[1-9])\s*$/gim, "排名: 第 $1 名")
    .trim()
}

export function stripModrinthForwardMarkers(text = "") {
  return String(text || "")
    .replace(/\[\[\/?MODRINTH_ITEM\]\]\s*/g, "")
    .trim()
}

export function shouldKeepModrinthReplyAsText(toolName = "", userText = "") {
  return false
}

export class ModrinthClient {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.useIpv4Dispatcher = options.useIpv4Dispatcher === true || (options.useIpv4Dispatcher !== false && !options.fetchImpl)
    this.dispatcherFactory = options.dispatcherFactory || null
    this.dispatcherPromise = null
    this.cache = options.cache || new Map()
    this.cacheTtlMs = Math.max(5_000, Math.min(10 * 60_000, Number(options.cacheTtlMs) || 2 * 60_000))
    this.timeoutMs = Math.max(1_000, Math.min(30_000, Number(options.timeoutMs) || 8_000))
  }

  async getIpv4Dispatcher() {
    if (!this.useIpv4Dispatcher) return null
    if (!this.dispatcherPromise) {
      this.dispatcherPromise = Promise.resolve()
        .then(async () => {
          if (this.dispatcherFactory) return await this.dispatcherFactory()
          const { Agent } = await import("undici")
          return new Agent({ connect: { family: 4, timeout: this.timeoutMs } })
        })
        .catch(() => null)
    }
    return await this.dispatcherPromise
  }

  pruneCache() {
    const now = Date.now()
    for (const [key, entry] of this.cache) {
      if (!entry || entry.expiresAt <= now) this.cache.delete(key)
    }
    while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value)
  }

  async search(options = {}) {
    if (typeof this.fetchImpl !== "function") throw new Error("当前运行环境不支持联网查询")
    const url = buildModrinthSearchUrl(options)
    this.pruneCache()
    const cached = this.cache.get(url)
    if (cached?.expiresAt > Date.now()) return await cached.promise

    const promise = this.requestJson(url)
    this.cache.set(url, { promise, expiresAt: Date.now() + this.cacheTtlMs })
    try {
      return await promise
    } catch (error) {
      this.cache.delete(url)
      throw error
    }
  }

  async requestJson(url) {
    const ipv4Dispatcher = await this.getIpv4Dispatcher()
    const attempts = ipv4Dispatcher ? [ipv4Dispatcher, null] : [null]
    let lastError
    for (const dispatcher of attempts) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.fetchImpl(url, {
          headers: { Accept: "application/json", "User-Agent": "bl-chat-plugin/1.0 Modrinth ranking" },
          signal: controller.signal,
          ...(dispatcher ? { dispatcher } : {})
        })
        if (!response?.ok) throw new Error(`Modrinth 返回 HTTP ${response?.status || "未知"}`)
        const payload = await response.json()
        if (!payload || !Array.isArray(payload.hits)) throw new Error("Modrinth 返回的数据格式不正确")
        return payload
      } catch (error) {
        lastError = error
        const networkFailure = error?.name === "AbortError" || error?.name === "TypeError" || Boolean(error?.cause?.code)
        if (!dispatcher || !networkFailure) break
      } finally {
        clearTimeout(timer)
      }
    }
    if (lastError?.name === "AbortError") throw new Error(`Modrinth 查询超时（${Math.round(this.timeoutMs / 1000)} 秒）`)
    throw lastError
  }
}
