const DEFAULT_TIMEOUT_MS = 10000
const DEFAULT_RANK_LIMIT = 10
const MAX_RANK_LIMIT = 20
const DEFAULT_HISTORY_DAYS = 30
const DEFAULT_HISTORY_LIMIT = 5
const MAX_HISTORY_DAYS = 90
const MAX_HISTORY_PAGES = 10

export const DELTA_FORCE_PLACES = [
  {
    type: "workbench",
    name: "工作台",
    aliases: ["工作台", "工作", "工坊", "workbench"]
  },
  {
    type: "tech",
    name: "技术中心",
    aliases: ["技术中心", "技术", "科技", "tech"]
  },
  {
    type: "pharmacy",
    name: "制药台",
    aliases: ["制药台", "制药", "药台", "药品", "pharmacy"]
  },
  {
    type: "armory",
    name: "防具台",
    aliases: ["防具台", "防具", "护甲", "装备", "armory"]
  }
]

export function normalizeDeltaForceConfig(config = {}) {
  const source = config.deltaForceSystem || config
  return {
    enabled: source.enabled === true,
    apiBaseUrl: String(source.apiBaseUrl || "").trim().replace(/\/+$/, ""),
    apiKey: String(source.apiKey || "").trim(),
    timeoutMs: Math.max(1000, Math.min(Number(source.timeoutMs) || DEFAULT_TIMEOUT_MS, 60000)),
    objectCacheEnabled: source.objectCacheEnabled !== false,
    objectCacheRefreshMinutes: Math.max(10, Math.min(Number(source.objectCacheRefreshMinutes) || 360, 1440))
  }
}

export function buildDeltaForceUrl(apiBaseUrl, apiPath, query = {}) {
  const base = String(apiBaseUrl || "").trim().replace(/\/+$/, "")
  const path = String(apiPath || "").trim()
  if (!base) throw new Error("三角洲 API Base URL 未配置")
  if (!path.startsWith("/")) throw new Error("三角洲 API 路径必须以 / 开头")
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue
    search.set(key, String(value))
  }
  const suffix = search.toString()
  return `${base}${path}${suffix ? `?${suffix}` : ""}`
}

export function normalizeDeltaForcePlace(input = "") {
  const text = String(input || "").trim().toLowerCase()
  if (!text) return null
  return DELTA_FORCE_PLACES.find(place =>
    place.aliases.some(alias => String(alias).trim().toLowerCase() === text)
  ) || null
}

export function getDeltaForcePlaceHelp() {
  return [
    "三角洲制作场所",
    ...DELTA_FORCE_PLACES.map(place => `${place.name}：${place.type}`)
  ].join("\n")
}

export function normalizeRankLimit(value, fallback = DEFAULT_RANK_LIMIT) {
  const number = Number.parseInt(value, 10)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.max(1, Math.min(number, MAX_RANK_LIMIT))
}

export function normalizeHistoryDays(value, fallback = DEFAULT_HISTORY_DAYS) {
  const number = Number.parseInt(value, 10)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.max(1, Math.min(number, MAX_HISTORY_DAYS))
}

export function getDeltaForceHelp() {
  return [
    "三角洲命令",
    "说明：[] 内为可选参数，<> 内为必填参数",
    "制作场所：工作台 / 技术中心 / 制药台 / 防具台",
    ".三角洲 今日密码 - 查询三角洲行动今日密码",
    ".三角洲 特勤处利润 [场所] [数量] - 查看制造利润总览",
    ".三角洲 利润排行 [场所] [数量] - 查看制造利润排行",
    ".三角洲 物品价值 <名称或ID> [数量] - 搜索物品价值",
    ".三角洲 价格历史 <名称或ID> [天数] [数量] - 查看物品 30 天价格折线图",
    ".三角洲 改枪码 [关键词] [数量] - 查看改枪方案码"
  ].join("\n")
}

export class DeltaForceClient {
  constructor(config = {}, { fetchImpl = globalThis.fetch } = {}) {
    this.config = normalizeDeltaForceConfig(config)
    this.fetchImpl = fetchImpl
  }

  assertReady() {
    if (!this.config.enabled) throw new Error("三角洲功能未启用，请先在锅巴开启")
    if (!this.config.apiBaseUrl) throw new Error("三角洲 API Base URL 未配置")
    if (!this.config.apiKey) throw new Error("三角洲 API Key 未配置")
    if (typeof this.fetchImpl !== "function") throw new Error("当前运行环境不支持 fetch")
  }

  async requestJson(apiPath, query = {}) {
    this.assertReady()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)

    try {
      const response = await this.fetchImpl(buildDeltaForceUrl(this.config.apiBaseUrl, apiPath, query), {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "X-API-Key": this.config.apiKey
        },
        signal: controller.signal
      })

      const text = await response.text()
      let body = null
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
      }

      if (!response.ok) {
        const message = extractErrorMessage(body) || `HTTP ${response.status}`
        throw new Error(`三角洲 API 请求失败：${message}`)
      }

      return body
    } catch (err) {
      if (err?.name === "AbortError") throw new Error("三角洲 API 请求超时")
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  async getDailyKeyword() {
    return this.requestJson("/api/v1/df/tools/dailykeyword")
  }

  async getPlaceProfit() {
    return this.requestJson("/api/v1/df/place/profit")
  }

  async getPlaceProfitRank({ placeType = "", limit = DEFAULT_RANK_LIMIT } = {}) {
    return this.requestJson("/api/v1/df/place/profit/rank", {
      place: placeType,
      limit: normalizeRankLimit(limit)
    })
  }

  async getObjectList({ page = 1, limit = 1000 } = {}) {
    return this.requestJson("/api/v1/df/object/list", {
      page: Math.max(1, Number.parseInt(page, 10) || 1),
      limit: Math.max(1, Math.min(Number.parseInt(limit, 10) || 1000, 1000))
    })
  }

  async getAllObjectList({ limit = 1000, maxPages = 20 } = {}) {
    const first = await this.getObjectList({ page: 1, limit })
    const data = unwrapApiData(first)
    const list = Array.isArray(data?.list) ? data.list : []
    const total = Math.max(Number(data?.total) || list.length, list.length)
    const pageLimit = Math.max(Number(data?.limit) || limit || list.length || 1, 1)
    const totalPages = Math.min(Math.ceil(total / pageLimit), maxPages)
    const all = [...list]

    for (let page = 2; page <= totalPages; page++) {
      const next = await this.getObjectList({ page, limit: pageLimit })
      const nextData = unwrapApiData(next)
      if (!Array.isArray(nextData?.list) || !nextData.list.length) break
      all.push(...nextData.list)
    }

    return {
      code: first?.code,
      message: first?.message,
      data: {
        list: all,
        total,
        limit: pageLimit,
        page: 1
      }
    }
  }

  async searchObjectValue({ keyword = "", limit = DEFAULT_RANK_LIMIT } = {}) {
    const text = String(keyword || "").trim()
    if (!text) throw new Error("请提供要搜索的物品名称或 ID")
    const isId = /^\d+(?:-[A-Za-z0-9]+)?$/.test(text)
    const resultLimit = normalizeRankLimit(limit)
    const body = await this.requestJson("/api/v1/df/price/ocr/latest", {
      page: 1,
      limit: resultLimit,
      [isId ? "objectID" : "objectName"]: text
    })
    return {
      ...body,
      data: {
        ...unwrapApiData(body),
        keyword: text,
        limit: resultLimit
      }
    }
  }

  async getPriceHistory({ objectID = "", days = DEFAULT_HISTORY_DAYS, page = 1, limit = 1000 } = {}) {
    const id = String(objectID || "").trim()
    if (!id) throw new Error("请提供要查询价格历史的物品 ID")
    const body = await this.requestJson("/api/v1/df/price/ocr/history", {
      objectID: id,
      days: normalizeHistoryDays(days),
      page: Math.max(1, Number.parseInt(page, 10) || 1),
      limit: Math.max(1, Math.min(Number.parseInt(limit, 10) || 1000, 1000))
    })
    return {
      ...body,
      data: {
        ...unwrapApiData(body),
        objectID: id,
        days: normalizeHistoryDays(days)
      }
    }
  }

  async getAllPriceHistory({ objectID = "", days = DEFAULT_HISTORY_DAYS, limit = 1000, maxPages = MAX_HISTORY_PAGES } = {}) {
    const first = await this.getPriceHistory({ objectID, days, page: 1, limit })
    const data = unwrapApiData(first)
    const firstItems = getHistoryItems(data)
    const pagination = data?.pagination || {}
    const total = Math.max(Number(pagination.total) || firstItems.length, firstItems.length)
    const pageLimit = Math.max(Number(pagination.limit) || limit || firstItems.length || 1, 1)
    const totalPages = Math.min(Math.ceil(total / pageLimit), maxPages)
    const all = [...firstItems]

    for (let page = 2; page <= totalPages; page++) {
      const next = await this.getPriceHistory({ objectID, days, page, limit: pageLimit })
      const nextData = unwrapApiData(next)
      const nextItems = getHistoryItems(nextData)
      if (!nextItems.length) break
      all.push(...nextItems)
    }

    return {
      code: first?.code,
      message: first?.message,
      data: {
        ...data,
        items: all,
        objectID: String(objectID || "").trim(),
        days: normalizeHistoryDays(days),
        pagination: {
          ...pagination,
          page: 1,
          limit: pageLimit,
          total,
          fetched: all.length
        }
      }
    }
  }

  async searchPriceHistory({ keyword = "", days = DEFAULT_HISTORY_DAYS, limit = DEFAULT_HISTORY_LIMIT } = {}) {
    const text = String(keyword || "").trim()
    if (!text) throw new Error("请提供要查询价格历史的物品名称或 ID")
    const resultLimit = normalizeRankLimit(limit, DEFAULT_HISTORY_LIMIT)
    const latest = await this.searchObjectValue({ keyword: text, limit: resultLimit })
    const latestData = unwrapApiData(latest)
    const latestItems = getObjectValueItems(latestData)
    const histories = []

    for (const item of latestItems) {
      const objectID = item.objectID ?? item.objectId ?? item.id
      if (!objectID) continue
      const history = await this.getAllPriceHistory({
        objectID,
        days: normalizeHistoryDays(days)
      })
      histories.push({
        latest: item,
        history
      })
    }

    return {
      code: latest?.code,
      message: latest?.message,
      data: {
        keyword: text,
        days: normalizeHistoryDays(days),
        limit: resultLimit,
        items: histories,
        total: Number(latestData?.total ?? latestData?.pagination?.total) || latestItems.length
      }
    }
  }

  async getSolutionList({ keyword = "", limit = DEFAULT_RANK_LIMIT, page = 1 } = {}) {
    const query = {
      page: Math.max(1, Number.parseInt(page, 10) || 1),
      limit: normalizeRankLimit(limit)
    }
    const text = String(keyword || "").trim()
    if (text) query.keyword = text
    const body = await this.requestJson("/api/v1/df/tools/solution/list", query)
    return {
      ...body,
      data: {
        ...unwrapApiData(body),
        keyword: text,
        limit: normalizeRankLimit(limit)
      }
    }
  }
}

export function extractErrorMessage(body) {
  if (!body) return ""
  if (typeof body === "string") return body.slice(0, 200)
  for (const key of ["message", "msg", "error", "detail"]) {
    if (typeof body[key] === "string" && body[key].trim()) return body[key].trim()
  }
  return ""
}

export function unwrapApiData(body) {
  if (!body || typeof body !== "object") return body
  if (body.data !== undefined) return body.data
  if (body.result !== undefined) return body.result
  return body
}

function stringifyValue(value) {
  if (value === null || value === undefined || value === "") return ""
  if (Array.isArray(value)) return value.map(stringifyValue).filter(Boolean).join("、")
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${stringifyValue(item)}`)
      .filter(Boolean)
      .join("\n")
  }
  return String(value)
}

function formatNumber(value, digits = 0) {
  const number = Number(value)
  if (!Number.isFinite(number)) return stringifyValue(value)
  return number.toLocaleString("zh-CN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0
  })
}

function placeNameOf(type) {
  return DELTA_FORCE_PLACES.find(place => place.type === type)?.name || type || "未知场所"
}

function resolveObjectName(objectNameResolver, objectID) {
  if (!objectNameResolver || objectID === undefined || objectID === null || objectID === "") return ""
  if (typeof objectNameResolver === "function") return objectNameResolver(objectID) || ""
  if (typeof objectNameResolver.getName === "function") return objectNameResolver.getName(objectID) || ""
  if (typeof objectNameResolver.get === "function") return objectNameResolver.get(String(objectID)) || objectNameResolver.get(Number(objectID)) || ""
  return objectNameResolver[String(objectID)] || objectNameResolver[Number(objectID)] || ""
}

function getProfitItems(data) {
  if (!data || typeof data !== "object") return []
  if (Array.isArray(data.items)) return data.items
  if (Array.isArray(data.list)) return data.list
  if (Array.isArray(data.manufacturingPlaces)) {
    return data.manufacturingPlaces.flatMap(place =>
      (place.manufacturingItems || []).map(item => ({
        ...item,
        level: item.level ?? place.level,
        placeType: item.placeType || place.placeType
      }))
    )
  }
  return []
}

function formatRequiredItems(required = [], objectNameResolver) {
  if (!Array.isArray(required) || !required.length || !objectNameResolver) return ""

  const lines = required
    .map(item => {
      const objectID = item.objectID ?? item.objectId ?? item.id
      const name = resolveObjectName(objectNameResolver, objectID)
      if (!name) return ""
      const count = item.count || item.num || item.quantity || 1
      return `${name}*${formatNumber(count)}`
    })
    .filter(Boolean)

  return lines.length ? `材料：${lines.join("、")}` : ""
}

function formatProfitItem(item, { includeRank = false, includePlace = true, objectNameResolver = null } = {}) {
  if (!item || typeof item !== "object") return ""
  const name = item.objectName || item.name || item.itemName || resolveObjectName(objectNameResolver, item.objectID ?? item.objectId ?? item.id) || "未知物品"
  const rank = includeRank && item.rank ? `${item.rank}. ` : ""
  const place = includePlace ? `｜${item.placeName || placeNameOf(item.placeType)}` : ""
  const level = item.level ? `｜Lv${item.level}` : ""
  const hourProfit = item.hourProfit !== undefined ? `｜时利 ${formatNumber(item.hourProfit, 2)}` : ""
  const totalProfit = item.totalProfit !== undefined ? `｜总利 ${formatNumber(item.totalProfit)}` : ""
  const main = `${rank}${name}${place}${level}${hourProfit}${totalProfit}`
  const required = formatRequiredItems(item.required, objectNameResolver)
  return required ? `${main}\n${required}` : main
}

function getRequiredText(required = [], objectNameResolver) {
  if (!Array.isArray(required) || !required.length || !objectNameResolver) return ""

  return required
    .map(item => {
      const objectID = item.objectID ?? item.objectId ?? item.id
      const name = resolveObjectName(objectNameResolver, objectID)
      if (!name) return ""
      const count = item.count || item.num || item.quantity || 1
      return `${name}*${formatNumber(count)}`
    })
    .filter(Boolean)
    .join("、")
}

function getObjectValueItems(data) {
  if (!data || typeof data !== "object") return []
  if (Array.isArray(data.list)) return data.list
  if (Array.isArray(data.items)) return data.items
  if (Array.isArray(data.records)) return data.records
  return []
}

function getHistoryItems(data) {
  if (!data || typeof data !== "object") return []
  if (Array.isArray(data.list)) return data.list
  if (Array.isArray(data.items)) return data.items
  if (Array.isArray(data.records)) return data.records
  return []
}

function formatDiff(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return stringifyValue(value)
  if (number > 0) return `+${formatNumber(number)}`
  return formatNumber(number)
}

function formatPercent(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return stringifyValue(value)
  const sign = number > 0 ? "+" : ""
  return `${sign}${number.toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0
  })}%`
}

function formatUnixTime(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return stringifyValue(value)
  const ms = number > 100000000000 ? number : number * 1000
  return new Date(ms).toLocaleString("zh-CN", { hour12: false })
}

function formatDateLabel(timestamp) {
  const number = Number(timestamp)
  if (!Number.isFinite(number) || number <= 0) return ""
  const ms = number > 100000000000 ? number : number * 1000
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function shortDateLabel(date = "") {
  const match = String(date).match(/^\d{4}-(\d{2})-(\d{2})$/)
  return match ? `${Number(match[1])}/${Number(match[2])}` : String(date)
}

function formatObjectValueItem(item, index) {
  if (!item || typeof item !== "object") return ""
  const name = item.objectName || item.name || item.itemName || item.objectID || `结果${index + 1}`
  const latestPrice = item.latestPrice ?? item.price ?? item.value
  const avgPrice = item.avgPrice ?? item.sellPrice ?? item.sell ?? item.referencePrice
  const minPrice = item.minPrice
  const maxPrice = item.maxPrice
  const diff = item.diff ?? item.priceDiff
  const change = item.change ?? item.changeRate
  const condition = item.condition ? `｜${item.condition}` : ""
  const grade = item.grade ? `｜等级 ${item.grade}` : ""
  const price = latestPrice !== undefined ? `｜现价 ${formatNumber(latestPrice)}` : ""
  const avg = avgPrice !== undefined ? `｜均价 ${formatNumber(avgPrice)}` : ""
  const min = minPrice !== undefined ? `｜最低 ${formatNumber(minPrice)}` : ""
  const max = maxPrice !== undefined ? `｜最高 ${formatNumber(maxPrice)}` : ""
  const diffText = diff !== undefined ? `｜差值 ${formatDiff(diff)}` : ""
  const changeText = change !== undefined ? `｜涨跌 ${formatPercent(change)}` : ""
  const count = item.count !== undefined ? `｜样本 ${formatNumber(item.count)}` : ""
  const updateTime = item.updateTime || (item.lastUpdated ? formatUnixTime(item.lastUpdated) : "")
  const updateText = updateTime ? `｜${updateTime}` : ""
  return `${index + 1}. ${name}${condition}${grade}${price}${avg}${min}${max}${diffText}${changeText}${count}${updateText}`
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim()
}

function getSolutionItems(data) {
  if (!data || typeof data !== "object") return []
  if (Array.isArray(data.list)) return data.list
  if (Array.isArray(data.items)) return data.items
  if (Array.isArray(data.records)) return data.records
  return []
}

function formatSolutionItem(item, index) {
  if (!item || typeof item !== "object") return ""
  const name = item.name || "未命名方案"
  const weapon = item.armsDetail?.objectName || item.weaponName || item.armsName || item.solutionCode?.split("-")?.[0] || "未知武器"
  const code = item.solutionCode || item.code || item.shareCode || ""
  const price = item.price !== undefined ? `｜价格 ${formatNumber(item.price)}` : ""
  const costPrice = item.costPrice !== undefined ? `｜成本 ${formatNumber(item.costPrice)}` : ""
  const applyNum = item.applyNum !== undefined ? `｜使用 ${formatNumber(item.applyNum)}` : ""
  const likeNum = item.likeNum !== undefined ? `｜点赞 ${formatNumber(item.likeNum)}` : ""
  const tag = item.stickTag ? `｜${item.stickTag}` : ""
  const comment = stripHtml(item.authorComment)
  const commentText = comment ? `\n说明：${comment}` : ""
  const codeText = code ? `\n改枪码：${code}` : ""
  return `${index + 1}. ${weapon}｜${name}${tag}${price}${costPrice}${applyNum}${likeNum}${codeText}${commentText}`
}

function formatMapSecretItem(item) {
  if (!item || typeof item !== "object") return ""
  const mapName = item.mapName || item.map || item.name || item.area
  const secret = item.secret || item.password || item.code || item.keyword
  if (!mapName || !secret) return ""
  return `${stringifyValue(mapName)}：${stringifyValue(secret)}`
}

function collectMapSecretLines(data) {
  const list = Array.isArray(data) ? data : data?.list
  if (!Array.isArray(list)) return []

  const lines = list.map(formatMapSecretItem).filter(Boolean)
  return lines.length === list.length ? lines : []
}

function collectKeywordLines(data) {
  const mapSecretLines = collectMapSecretLines(data)
  if (mapSecretLines.length) return mapSecretLines

  if (Array.isArray(data)) {
    return data
      .map((item, index) => {
        if (typeof item === "string" || typeof item === "number") return `${index + 1}. ${item}`
        return stringifyValue(item)
      })
      .filter(Boolean)
  }

  if (!data || typeof data !== "object") {
    const text = stringifyValue(data)
    return text ? [text] : []
  }

  const labels = {
    keyword: "口令",
    password: "密码",
    code: "密码",
    content: "内容",
    today: "今日",
    date: "日期",
    map: "地图",
    area: "区域",
    name: "名称",
    answer: "答案"
  }
  const preferredKeys = Object.keys(labels)

  const lines = []
  for (const key of preferredKeys) {
    if (data[key] !== undefined && data[key] !== null && data[key] !== "") {
      lines.push(`${labels[key]}：${stringifyValue(data[key])}`)
    }
  }

  if (lines.length) return lines

  return Object.entries(data)
    .map(([key, value]) => `${key}：${stringifyValue(value)}`)
    .filter(line => !line.endsWith("："))
}

export function formatDailyKeywordResponse(body) {
  const data = unwrapApiData(body)
  const lines = collectKeywordLines(data)
  if (!lines.length) return "今天还没拿到三角洲密码数据"
  return ["三角洲今日密码", ...lines].join("\n")
}

export function formatPlaceProfitResponse(body, { placeType = "", limit = DEFAULT_RANK_LIMIT, objectNameResolver = null } = {}) {
  const report = buildPlaceProfitReportData(body, { placeType, limit, objectNameResolver })
  if (!report.rows.length) return "暂时没有拿到特勤处利润数据"

  const lines = [report.title]
  let previousPlace = ""
  for (const row of report.rows) {
    if (row.placeName !== previousPlace) {
      lines.push(row.placeName)
      previousPlace = row.placeName
    }
    const material = row.materials ? `\n材料：${row.materials}` : ""
    lines.push(`${row.name}｜Lv${row.level}｜时利 ${row.hourProfit}｜总利 ${row.totalProfit}${material}`)
  }

  return lines.join("\n")
}

export function formatProfitRankResponse(body, { placeType = "", limit = DEFAULT_RANK_LIMIT, objectNameResolver = null } = {}) {
  const report = buildProfitRankReportData(body, { placeType, limit, objectNameResolver })
  if (!report.rows.length) return "暂时没有拿到利润排行数据"

  const lines = [report.title]
  report.rows.forEach(row => {
    const material = row.materials ? `\n材料：${row.materials}` : ""
    lines.push(`${row.rank}. ${row.name}｜${row.placeName}｜Lv${row.level}｜时利 ${row.hourProfit}｜总利 ${row.totalProfit}${material}`)
  })
  return lines.join("\n")
}

export function buildPlaceProfitReportData(body, { placeType = "", limit = DEFAULT_RANK_LIMIT, objectNameResolver = null } = {}) {
  const data = unwrapApiData(body)
  const manufacturingPlaces = Array.isArray(data?.manufacturingPlaces) ? data.manufacturingPlaces : []
  const normalizedPlaceType = placeType || ""
  const maxItems = normalizeRankLimit(limit)
  const groups = manufacturingPlaces
    .filter(group => {
      const groupPlaceType = group.placeType || group.manufacturingItems?.[0]?.placeType
      return !normalizedPlaceType || groupPlaceType === normalizedPlaceType
    })
    .map(group => {
      const items = [...(group.manufacturingItems || [])]
      items.sort((a, b) => Number(b.hourProfit || 0) - Number(a.hourProfit || 0))
      const top = items[0]
      if (!top) return null
      return {
        placeType: group.placeType || top.placeType,
        level: top.level ?? group.level,
        item: {
          ...top,
          level: top.level ?? group.level,
          placeType: top.placeType || group.placeType
        }
      }
    })
    .filter(Boolean)

  const rows = []
  const orderedTypes = [
    ...DELTA_FORCE_PLACES.map(place => place.type),
    ...[...new Set(groups.map(group => group.placeType || "unknown"))].filter(type => !DELTA_FORCE_PLACES.some(place => place.type === type))
  ]

  for (const type of orderedTypes) {
    const placeGroups = groups
      .filter(group => (group.placeType || "unknown") === type)
      .sort((a, b) => Number(a.level || 0) - Number(b.level || 0))
    for (const group of placeGroups) {
      if (rows.length >= maxItems) break
      const item = group.item
      rows.push({
        rank: rows.length + 1,
        placeName: placeNameOf(type),
        level: item.level || group.level || "",
        name: item.objectName || item.name || item.itemName || resolveObjectName(objectNameResolver, item.objectID ?? item.objectId ?? item.id) || "未知物品",
        hourProfit: formatNumber(item.hourProfit, 2),
        totalProfit: formatNumber(item.totalProfit),
        materials: getRequiredText(item.required, objectNameResolver)
      })
    }
    if (rows.length >= maxItems) break
  }

  return {
    kind: "place-profit",
    title: `三角洲特勤处利润（Top ${rows.length}）`,
    subtitle: normalizedPlaceType ? `${placeNameOf(normalizedPlaceType)}｜默认 10 条，最多 20 条` : "全部场所｜默认 10 条，最多 20 条",
    generatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    columns: ["场所", "等级", "推荐制造", "时利", "总利", "材料"],
    rows
  }
}

export function buildProfitRankReportData(body, { placeType = "", limit = DEFAULT_RANK_LIMIT, objectNameResolver = null } = {}) {
  const data = unwrapApiData(body)
  const items = getProfitItems(data).slice(0, normalizeRankLimit(limit))
  const place = placeType ? placeNameOf(placeType) : "全部场所"
  const rows = items.map((item, index) => ({
    rank: item.rank || index + 1,
    placeName: item.placeName || placeNameOf(item.placeType),
    level: item.level || "",
    name: item.objectName || item.name || item.itemName || resolveObjectName(objectNameResolver, item.objectID ?? item.objectId ?? item.id) || "未知物品",
    hourProfit: formatNumber(item.hourProfit, 2),
    totalProfit: formatNumber(item.totalProfit),
    materials: getRequiredText(item.required, objectNameResolver)
  }))

  return {
    kind: "profit-rank",
    title: `三角洲利润排行（${place} Top ${rows.length}）`,
    subtitle: "按总利润排行｜默认 10 条，最多 20 条",
    generatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    columns: ["排名", "物品", "场所", "等级", "时利", "总利", "材料"],
    rows
  }
}

export function buildSolutionListReportData(body, { keyword = "", limit = DEFAULT_RANK_LIMIT } = {}) {
  const data = unwrapApiData(body)
  const searchText = keyword || data?.keyword || ""
  const items = getSolutionItems(data).slice(0, normalizeRankLimit(limit || data?.limit))
  const total = Number(data?.total)
  const suffix = Number.isFinite(total) && total > items.length ? ` / 共 ${formatNumber(total)} 条` : ""
  const title = searchText
    ? `三角洲改枪码：${searchText}（Top ${items.length}${suffix}）`
    : `三角洲改枪码（Top ${items.length}${suffix}）`

  return {
    kind: "solution-list",
    title,
    subtitle: "按接口返回顺序｜默认 10 条，最多 20 条",
    generatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    columns: ["排名", "武器与方案", "标签", "价格/成本", "热度", "改枪码与说明"],
    emptyText: searchText ? `没有找到「${searchText}」相关的改枪码` : "暂时没有拿到改枪码数据",
    rows: items.map((item, index) => ({
      rank: index + 1,
      weapon: item.armsDetail?.objectName || item.weaponName || item.armsName || item.solutionCode?.split("-")?.[0] || "未知武器",
      name: item.name || "未命名方案",
      tag: item.stickTag || "",
      price: item.price !== undefined ? formatNumber(item.price) : "",
      costPrice: item.costPrice !== undefined ? formatNumber(item.costPrice) : "",
      applyNum: item.applyNum !== undefined ? formatNumber(item.applyNum) : "",
      likeNum: item.likeNum !== undefined ? formatNumber(item.likeNum) : "",
      solutionCode: item.solutionCode || item.code || item.shareCode || "",
      comment: stripHtml(item.authorComment)
    }))
  }
}

export function buildObjectValueReportData(body, { keyword = "", limit = DEFAULT_RANK_LIMIT } = {}) {
  const data = unwrapApiData(body)
  const searchText = keyword || data?.keyword || ""
  const items = getObjectValueItems(data).slice(0, normalizeRankLimit(limit || data?.limit))
  const total = Number(data?.total ?? data?.pagination?.total)
  const suffix = Number.isFinite(total) && total > items.length ? ` / 共 ${formatNumber(total)} 条` : ""
  const title = searchText
    ? `三角洲物品价值：${searchText}（Top ${items.length}${suffix}）`
    : `三角洲物品价值（Top ${items.length}${suffix}）`

  return {
    kind: "object-value",
    title,
    subtitle: "OCR 最新价格｜默认 10 条，最多 20 条",
    generatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    columns: ["排名", "物品", "成色", "现价", "均价", "价格区间", "涨跌/样本", "更新时间"],
    emptyText: searchText
      ? `没有找到「${searchText}」的物品价值数据，可能价格库暂时未覆盖这个物品`
      : "没有找到物品价值数据",
    rows: items.map((item, index) => ({
      rank: index + 1,
      name: item.objectName || item.name || item.itemName || item.objectID || `结果${index + 1}`,
      condition: item.condition || "",
      latestPrice: item.latestPrice !== undefined ? formatNumber(item.latestPrice) : "",
      avgPrice: item.avgPrice !== undefined ? formatNumber(item.avgPrice) : "",
      minPrice: item.minPrice !== undefined ? formatNumber(item.minPrice) : "",
      maxPrice: item.maxPrice !== undefined ? formatNumber(item.maxPrice) : "",
      change: item.change !== undefined || item.changeRate !== undefined ? formatPercent(item.change ?? item.changeRate) : "",
      count: item.count !== undefined ? formatNumber(item.count) : "",
      updateTime: item.updateTime || (item.lastUpdated ? formatUnixTime(item.lastUpdated) : "")
    }))
  }
}

function buildDailyPriceSeries(items = []) {
  const buckets = new Map()
  for (const item of items) {
    const date = formatDateLabel(item.timestamp ?? item.time ?? item.createdAt ?? item.updatedAt)
    const price = Number(item.price ?? item.latestPrice ?? item.value)
    if (!date || !Number.isFinite(price) || price <= 0) continue
    const bucket = buckets.get(date) || { date, sum: 0, count: 0, min: price, max: price }
    bucket.sum += price
    bucket.count += 1
    bucket.min = Math.min(bucket.min, price)
    bucket.max = Math.max(bucket.max, price)
    buckets.set(date, bucket)
  }

  return [...buckets.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(bucket => ({
      date: bucket.date,
      label: shortDateLabel(bucket.date),
      price: Math.round(bucket.sum / bucket.count),
      min: Math.round(bucket.min),
      max: Math.round(bucket.max),
      count: bucket.count
    }))
}

function buildPriceChartSvg(series = []) {
  const width = 980
  const height = 330
  const padding = { top: 28, right: 34, bottom: 56, left: 92 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const prices = series.map(point => Number(point.price)).filter(Number.isFinite)
  if (!prices.length) {
    return `<svg class="price-chart" viewBox="0 0 ${width} ${height}" role="img"><text x="${width / 2}" y="${height / 2}" fill="#aeb8c4" text-anchor="middle" font-size="22">暂无历史价格数据</text></svg>`
  }

  const minPrice = Math.min(...prices)
  const maxPrice = Math.max(...prices)
  const span = Math.max(maxPrice - minPrice, 1)
  const paddedMin = Math.max(0, minPrice - span * 0.08)
  const paddedMax = maxPrice + span * 0.08
  const ySpan = Math.max(paddedMax - paddedMin, 1)
  const xOf = index => padding.left + (series.length <= 1 ? plotWidth / 2 : (index / (series.length - 1)) * plotWidth)
  const yOf = price => padding.top + plotHeight - ((price - paddedMin) / ySpan) * plotHeight
  const coords = series.map((point, index) => ({
    ...point,
    x: xOf(index),
    y: yOf(point.price)
  }))
  const path = coords.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ")
  const areaPath = `${path} L ${coords.at(-1).x.toFixed(1)} ${padding.top + plotHeight} L ${coords[0].x.toFixed(1)} ${padding.top + plotHeight} Z`
  const yTicks = [paddedMin, paddedMin + ySpan / 2, paddedMax]
  const xTickIndexes = [...new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])]

  return `<svg class="price-chart" viewBox="0 0 ${width} ${height}" role="img">
    <defs>
      <linearGradient id="priceArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#78d39a" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="#78d39a" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" rx="8" fill="#171d25"/>
    ${yTicks.map(value => {
      const y = yOf(value)
      return `<line x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}" stroke="#2f3845" stroke-width="1"/>
        <text x="${padding.left - 14}" y="${(y + 6).toFixed(1)}" fill="#91a0b2" font-size="16" text-anchor="end">${formatNumber(value)}</text>`
    }).join("")}
    <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + plotHeight}" stroke="#4b5563" stroke-width="1.5"/>
    <line x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${width - padding.right}" y2="${padding.top + plotHeight}" stroke="#4b5563" stroke-width="1.5"/>
    <path d="${areaPath}" fill="url(#priceArea)"/>
    <path d="${path}" fill="none" stroke="#86efac" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>
    ${coords.map(point => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4.8" fill="#f5d58a" stroke="#171d25" stroke-width="2"/>`).join("")}
    ${xTickIndexes.map(index => {
      const point = coords[index]
      return `<text x="${point.x.toFixed(1)}" y="${height - 20}" fill="#91a0b2" font-size="16" text-anchor="middle">${point.label}</text>`
    }).join("")}
  </svg>`
}

export function buildPriceHistoryReportData(body, { keyword = "", days = DEFAULT_HISTORY_DAYS, limit = DEFAULT_HISTORY_LIMIT } = {}) {
  const data = unwrapApiData(body)
  const items = Array.isArray(data?.items) ? data.items : []
  const searchText = keyword || data?.keyword || ""
  const normalizedDays = normalizeHistoryDays(days || data?.days)
  const rows = items.map(entry => {
    const latest = entry.latest || {}
    const historyData = unwrapApiData(entry.history)
    const historyItems = getHistoryItems(historyData)
    const series = buildDailyPriceSeries(historyItems)
    const latestPoint = series.at(-1)
    const firstPoint = series[0]
    const diff = latestPoint && firstPoint ? latestPoint.price - firstPoint.price : 0
    const diffPercent = latestPoint && firstPoint && firstPoint.price
      ? (diff / firstPoint.price) * 100
      : 0
    return {
      objectID: latest.objectID ?? latest.objectId ?? historyData?.objectID ?? "",
      name: latest.objectName || latest.name || latest.itemName || historyItems[0]?.objectName || "未知物品",
      condition: latest.condition || historyItems[0]?.condition || "",
      latestPrice: latestPoint ? formatNumber(latestPoint.price) : latest.latestPrice !== undefined ? formatNumber(latest.latestPrice) : "",
      change: Number.isFinite(diff) && diff !== 0 ? `${formatDiff(diff)} / ${formatPercent(diffPercent)}` : "0",
      days: normalizedDays,
      pointCount: series.length,
      sampleCount: historyItems.length,
      chartSvg: buildPriceChartSvg(series)
    }
  })

  const total = Number(data?.total)
  const suffix = Number.isFinite(total) && total > rows.length ? ` / 共 ${formatNumber(total)} 个匹配` : ""
  return {
    kind: "price-history",
    title: searchText
      ? `三角洲价格历史：${searchText}（${rows.length}${suffix}）`
      : `三角洲价格历史（${rows.length}）`,
    subtitle: `OCR 历史价格｜默认 ${DEFAULT_HISTORY_DAYS} 天｜按 objectID 分组`,
    generatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    columns: ["价格走势"],
    emptyText: searchText ? `没有找到「${searchText}」的价格历史数据` : "没有找到价格历史数据",
    rows: rows.slice(0, normalizeRankLimit(limit, DEFAULT_HISTORY_LIMIT))
  }
}

export function formatObjectValueSearchResponse(body, { keyword = "", limit = DEFAULT_RANK_LIMIT } = {}) {
  const data = unwrapApiData(body)
  const searchText = keyword || data?.keyword || ""
  const items = getObjectValueItems(data).slice(0, normalizeRankLimit(limit || data?.limit))
  if (!items.length) {
    return searchText
      ? `没有找到「${searchText}」的物品价值数据，可能价格库暂时未覆盖这个物品`
      : "没有找到物品价值数据"
  }

  const total = Number(data?.total ?? data?.pagination?.total)
  const suffix = Number.isFinite(total) && total > items.length ? ` / 共 ${formatNumber(total)} 条` : ""
  const title = searchText
    ? `三角洲物品价值：${searchText}（Top ${items.length}${suffix}）`
    : `三角洲物品价值（Top ${items.length}${suffix}）`
  return [title, ...items.map(formatObjectValueItem).filter(Boolean)].join("\n")
}

export function formatPriceHistoryResponse(body, { keyword = "", days = DEFAULT_HISTORY_DAYS, limit = DEFAULT_HISTORY_LIMIT } = {}) {
  const report = buildPriceHistoryReportData(body, { keyword, days, limit })
  if (!report.rows.length) return report.emptyText
  const lines = [report.title]
  for (const row of report.rows) {
    lines.push(`${row.name}${row.condition ? `｜${row.condition}` : ""}｜现价 ${row.latestPrice || "-"}｜${row.days}天涨跌 ${row.change}｜样本 ${row.sampleCount}`)
  }
  return lines.join("\n")
}

export function formatSolutionListResponse(body, { keyword = "", limit = DEFAULT_RANK_LIMIT } = {}) {
  const data = unwrapApiData(body)
  const searchText = keyword || data?.keyword || ""
  const items = getSolutionItems(data).slice(0, normalizeRankLimit(limit || data?.limit))
  if (!items.length) {
    return searchText
      ? `没有找到「${searchText}」相关的改枪码`
      : "暂时没有拿到改枪码数据"
  }

  const total = Number(data?.total)
  const suffix = Number.isFinite(total) && total > items.length ? ` / 共 ${formatNumber(total)} 条` : ""
  const title = searchText
    ? `三角洲改枪码：${searchText}（Top ${items.length}${suffix}）`
    : `三角洲改枪码（Top ${items.length}${suffix}）`
  return [title, ...items.map(formatSolutionItem).filter(Boolean)].join("\n")
}
