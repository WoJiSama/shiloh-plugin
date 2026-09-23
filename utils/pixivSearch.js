import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fetchPixivJson, isTrustedPixivImageUrl } from "./pixivMessage.js"
import { downloadPixivArchiveImage } from "./pixivMediaRelay.js"
import { getSharedBrowser, scheduleSharedBrowserClose } from "./sharedBrowser.js"

const SEARCH_TIMEOUT_MS = 12_000
const ARTIST_RECENT_LIMIT = 8
const LIST_MAX_ITEMS = 8
// 搜索会话是短期单槽上下文:5 分钟内不下载就失效;新的搜索立刻覆盖旧会话;成功下载会续期。
export const PIXIV_SEARCH_SESSION_TTL_MS = 5 * 60 * 1000
const SESSION_KEY_PREFIX = "ytbot:pixiv_search_session:v1:"
const localSessions = new Map()

function cleanText(value = "", maxLength = 200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength)
}

function normalizeNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

/** 搜索/画师列表条目统一为 { id, title, userName, userId, pageCount, xRestrict, thumbUrl } */
export function normalizePixivSearchItem(item = {}) {
  const id = String(item.id || item.illustId || "").trim()
  if (!/^\d{3,12}$/.test(id)) return null
  return {
    id,
    title: cleanText(item.title || item.alt, 120) || "未命名作品",
    userName: cleanText(item.userName || item.user?.name || "", 60),
    userId: String(item.userId || item.user?.id || "").trim(),
    pageCount: Math.max(1, Math.round(normalizeNumber(item.pageCount) || 1)),
    xRestrict: Math.min(2, Math.max(0, Math.round(normalizeNumber(item.xRestrict)))),
    thumbUrl: isTrustedPixivImageUrl(item.url || item.profileImageUrl || "") ? String(item.url || item.profileImageUrl) : ""
  }
}

/**
 * 关键词搜索 Pixiv 插画/漫画,匿名 ajax 接口,自动经代理。
 * order: "newest"(默认,时间倒序) | "oldest"(时间正序) | "popular"(人气)。
 * 匿名接口会静默忽略 popular_* 排序,人气排序通过并行取详情的收藏数重排实现。
 */
export const PIXIV_SEARCH_ORDERS = new Set(["newest", "oldest", "popular"])
const NATIVE_ORDER_MAP = { newest: "date_d", oldest: "date" }
const POPULAR_CANDIDATES = 24

export async function searchPixivArtworks(keyword = "", {
  order = "newest",
  page = 1,
  mode = "safe",
  fetchImpl = null,
  proxyUrl = "",
  cookieHeader = "",
  timeoutMs = SEARCH_TIMEOUT_MS
} = {}) {
  const word = cleanText(keyword, 80)
  if (!word) throw new Error("缺少搜索关键词")
  const sortBy = PIXIV_SEARCH_ORDERS.has(order) ? order : "newest"
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs) || SEARCH_TIMEOUT_MS))
  try {
    // 匿名接口会静默忽略 popular_* 排序;带登录 Cookie 才能用原生全站热门
    const nativeOrder = sortBy === "popular"
      ? (cookieHeader ? "popular_d" : "date_d")
      : (NATIVE_ORDER_MAP[sortBy] || "date_d")
    const url = `https://www.pixiv.net/ajax/search/artworks/${encodeURIComponent(word)}?word=${encodeURIComponent(word)}&order=${nativeOrder}&mode=${encodeURIComponent(mode)}&p=${Math.max(1, Math.round(page) || 1)}&type=all&lang=zh`
    const body = await fetchPixivJson(url, { fetchImpl, proxyUrl, cookieHeader, signal: controller.signal })
    const raw = body?.illustManga?.data || body?.illust?.data || []
    let items = raw.map(normalizePixivSearchItem).filter(Boolean)
    if (!items.length) throw new Error(`Pixiv 没有返回「${word}」的搜索结果`)
    let total = Number(body?.illustManga?.total || items.length) || items.length
    let orderSource = "native"
    if (sortBy === "popular" && !cookieHeader) {
      // 无 Cookie 降级:并行取最近候选的收藏数重排,只代表近期人气
      const ranked = await rankPixivItemsByBookmarks(items.slice(0, POPULAR_CANDIDATES), { fetchImpl, proxyUrl, signal: controller.signal })
      if (ranked.length) {
        items = ranked
        total = Math.min(total, POPULAR_CANDIDATES)
        orderSource = "rerank"
      }
    }
    return { keyword: word, order: sortBy, orderSource, total, items }
  } finally {
    clearTimeout(timer)
  }
}

/** 匿名接口拿不到收藏数:并行取详情接口的 bookmarkCount 给候选重排 */
async function rankPixivItemsByBookmarks(items = [], { fetchImpl = null, proxyUrl = "", signal } = {}) {
  const ranked = await Promise.all(items.map(async item => {
    try {
      const body = await fetchPixivJson(`https://www.pixiv.net/ajax/illust/${encodeURIComponent(item.id)}?lang=zh`, { fetchImpl, proxyUrl, signal })
      return { ...item, bookmarkCount: Math.max(0, Math.round(Number(body?.bookmarkCount) || 0)) }
    } catch {
      return { ...item, bookmarkCount: -1 }
    }
  }))
  const withCount = ranked.filter(item => item.bookmarkCount >= 0)
  if (!withCount.length) return []
  return withCount.sort((a, b) => b.bookmarkCount - a.bookmarkCount)
}

/**
 * 从搜索结果里找画师:匿名画师搜索接口需要登录,这里用结果里的
 * userName 与关键词互相包含(忽略大小写)来识别,识别不到返回 null。
 */
export function resolvePixivArtistFromItems(items = [], keyword = "") {
  const word = cleanText(keyword, 60).toLowerCase()
  if (!word) return null
  const counts = new Map()
  for (const item of items) {
    if (!item.userId || !item.userName) continue
    const name = item.userName.toLowerCase()
    if (!name.includes(word) && !word.includes(name)) continue
    const entry = counts.get(item.userId) || { userId: item.userId, userName: item.userName, hits: 0 }
    entry.hits += 1
    counts.set(item.userId, entry)
  }
  const best = [...counts.values()].sort((a, b) => b.hits - a.hits)[0]
  return best && best.hits >= 1 ? { userId: best.userId, userName: best.userName } : null
}

/** 拉某画师最近的作品:profile/all 全量 ID 取尾部,再批量取详情。 */
export async function listPixivArtistRecentWorks(userId = "", {
  limit = ARTIST_RECENT_LIMIT,
  fetchImpl = null,
  proxyUrl = "",
  cookieHeader = "",
  timeoutMs = SEARCH_TIMEOUT_MS
} = {}) {
  const uid = String(userId || "").trim()
  if (!/^\d{3,12}$/.test(uid)) throw new Error("画师 ID 不合法")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(6000, Number(timeoutMs) * 2 || SEARCH_TIMEOUT_MS * 2))
  const request = { fetchImpl, proxyUrl, cookieHeader, signal: controller.signal }
  try {
    const profile = await fetchPixivJson(`https://www.pixiv.net/ajax/user/${encodeURIComponent(uid)}/profile/all?lang=zh`, request)
    const illustIds = Object.keys(profile?.illusts || {})
    if (!illustIds.length) throw new Error("该画师没有可公开查看的作品")
    const wanted = Math.max(1, Math.min(12, Number(limit) || ARTIST_RECENT_LIMIT))
    // 多取一倍候选:详情可能因删稿失败,失败跳过后继续补足到目标数量
    const candidates = illustIds.sort((a, b) => Number(b) - Number(a)).slice(0, wanted * 2)
    const fetched = await Promise.all(candidates.map(async illustId => {
      try {
        const body = await fetchPixivJson(`https://www.pixiv.net/ajax/illust/${encodeURIComponent(illustId)}?lang=zh`, request)
        return normalizePixivSearchItem({
          id: body?.id || illustId,
          title: body?.title,
          userName: body?.userName,
          userId: body?.userId,
          pageCount: body?.pageCount,
          xRestrict: body?.xRestrict,
          url: body?.urls?.regular || body?.urls?.small
        })
      } catch {
        return null
      }
    }))
    const items = fetched.filter(Boolean).slice(0, wanted)
    if (!items.length) throw new Error("画师作品详情暂时获取失败")
    return { userId: uid, items }
  } finally {
    clearTimeout(timer)
  }
}

// ---------- 搜索会话:记住每个群/用户最近一次的搜索结果,供「下载 序号」回查 ----------

function sessionKey(e = {}) {
  const id = e.group_id || e.user_id || ""
  return id ? `${SESSION_KEY_PREFIX}${String(id)}` : ""
}

export async function savePixivSearchSession(e = {}, session = {}, { redis = globalThis.redis, savedAt = Date.now() } = {}) {
  const key = sessionKey(e)
  if (!key || !session?.items?.length) return
  const record = {
    keyword: String(session.keyword || ""),
    mode: String(session.mode || "artworks"),
    order: PIXIV_SEARCH_ORDERS.has(session.order) ? session.order : "newest",
    orderSource: session.orderSource === "rerank" ? "rerank" : "native",
    artist: session.artist && typeof session.artist === "object" ? { userId: session.artist.userId, userName: session.artist.userName } : null,
    items: session.items.slice(0, 20).map(({ id, title, userName, pageCount, xRestrict, bookmarkCount }) => ({ id, title, userName, pageCount, xRestrict, bookmarkCount })),
    savedAt
  }
  localSessions.set(key, record)
  pruneLocalSessions()
  if (redis?.set) {
    // 客户端兼容:node-redis v4 只认对象参数 {PX} 且命令是驼峰 pExpire;
    // 位置参数 "PX" 会被静默忽略导致键永不过期。对象形式失败再退回分离设置。
    const ttlMs = Math.max(1000, PIXIV_SEARCH_SESSION_TTL_MS - (Date.now() - savedAt))
    try {
      await redis.set(key, JSON.stringify(record), { PX: ttlMs })
    } catch {
      await redis.set(key, JSON.stringify(record)).catch(() => {})
      const expire = typeof redis.pExpire === "function" ? redis.pExpire.bind(redis)
        : typeof redis.pexpire === "function" ? redis.pexpire.bind(redis)
        : null
      await expire?.(key, ttlMs).catch?.(() => {})
    }
  }
  return record
}

export async function loadPixivSearchSession(e = {}, { redis = globalThis.redis } = {}) {
  const key = sessionKey(e)
  if (!key) return null
  let record = null
  if (redis?.get) {
    try {
      record = JSON.parse(await redis.get(key) || "null")
    } catch {}
  }
  if (!record) record = localSessions.get(key) || null
  if (!record || Date.now() - Number(record.savedAt || 0) > PIXIV_SEARCH_SESSION_TTL_MS) {
    if (record) localSessions.delete(key)
    return null
  }
  return record
}

/** 同步检查本群/用户是否有可用的 Pixiv 搜索会话(路由规则是同步的,只看进程内存副本) */
export function hasRecentPixivSearch(e = {}) {
  const key = sessionKey(e)
  if (!key) return false
  const record = localSessions.get(key)
  return Boolean(record && Date.now() - Number(record.savedAt || 0) <= PIXIV_SEARCH_SESSION_TTL_MS)
}

/** 成功下载后续期会话:把 5 分钟窗口从当前时刻重新起算 */
export async function touchPixivSearchSession(e = {}, { redis = globalThis.redis } = {}) {
  const record = await loadPixivSearchSession(e, { redis })
  if (!record) return null
  return await savePixivSearchSession(e, record, { redis })
}

function pruneLocalSessions() {
  for (const [key, record] of localSessions) {
    if (Date.now() - Number(record?.savedAt || 0) > PIXIV_SEARCH_SESSION_TTL_MS) localSessions.delete(key)
  }
  while (localSessions.size > 64) localSessions.delete(localSessions.keys().next().value)
}

/** 「下载 3」或「下载 126649495」→ 作品 ID;找不到返回空串 */
export function resolvePixivDownloadTarget(target = "", session = null) {
  const text = String(target || "").trim()
  const directId = text.match(/^\d{5,12}$/)?.[0]
  if (directId) return { id: directId, item: session?.items?.find(item => item.id === directId) || null }
  const index = Number(text.match(/^(?:#|No\.?|第)?(\d{1,2})$/i)?.[1] || 0)
  if (index >= 1 && session?.items?.length) {
    const item = session.items.slice(0, LIST_MAX_ITEMS)[index - 1]
    if (item) return { id: item.id, item }
  }
  return { id: "", item: null }
}

// ---------- 结果卡面 ----------

function escapeHtml(value = "") {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

// Chromium 在 setContent 页面里默认禁止 file:// 子资源,缩略图必须以 data URI 内嵌
async function imageDataUri(filePath = "") {
  if (!filePath) return ""
  try {
    const buffer = await fs.promises.readFile(filePath)
    const mime = buffer[0] === 0x89 && buffer[1] === 0x50 ? "image/png" : "image/jpeg"
    return `data:${mime};base64,${buffer.toString("base64")}`
  } catch {
    return ""
  }
}

function formatCount(value = 0) {
  const number = Math.max(0, Math.round(Number(value) || 0))
  if (number >= 10000) return `${(number / 10000).toFixed(1)}万`
  return String(number)
}

async function buildPixivListHtml(data = {}) {
  const rows = (await Promise.all(data.items.map(async (item, offset) => {
    const dataUri = await imageDataUri(item.thumbPath)
    return `
    <tr class="${item.xRestrict > 0 ? "restricted" : "ok"}">
      <td class="num">${offset + 1}</td>
      <td class="thumb">${dataUri ? `<img src="${dataUri}" />` : "<div class='thumb ph'>无图</div>"}</td>
      <td class="info">
        <div class="title">${escapeHtml(item.title)}</div>
        <div class="author">${escapeHtml(item.userName)}${item.pageCount > 1 ? ` · ${item.pageCount}张` : ""}${Number(item.bookmarkCount) > 0 ? ` · ♥${formatCount(item.bookmarkCount)}` : ""}${item.xRestrict > 0 ? " · R-18" : ""}</div>
      </td>
      <td class="id">${escapeHtml(item.id)}</td>
    </tr>`
  }))).join("")
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: transparent; font-family: "PingFang SC", "Microsoft YaHei", sans-serif; }
  .card { width: 720px; background: #f8f9fc; border-radius: 14px; padding: 18px 20px 14px; }
  .head h1 { font-size: 19px; color: #0096fa; }
  .head .meta { margin-top: 6px; font-size: 12px; color: #6b7280; }
  table { margin-top: 12px; border-collapse: collapse; width: 100%; background: #fff; border-radius: 10px; overflow: hidden; }
  tr.ok { background: #fff; }
  tr.restricted { background: #fff7f7; }
  td { padding: 8px 8px; vertical-align: middle; }
  td.num { width: 26px; font-weight: 700; color: #0096fa; font-size: 15px; text-align: center; }
  td.thumb { width: 64px; }
  td.thumb img, .thumb.ph { width: 56px; height: 56px; object-fit: cover; border-radius: 6px; display: block; background: #e5e7eb; }
  .thumb.ph { display: flex; align-items: center; justify-content: center; color: #9ca3af; font-size: 10px; }
  td.info .title { font-size: 13px; color: #1f2937; line-height: 1.35; }
  td.info .author { margin-top: 3px; font-size: 11px; color: #6b7280; }
  td.id { width: 88px; font-size: 11px; color: #9ca3af; text-align: right; }
  .foot { margin-top: 10px; font-size: 12px; color: #374151; }
  .foot .hint { margin-top: 4px; font-size: 11px; color: #9ca3af; }
</style></head>
<body>
  <div class="card">
    <div class="head">
      <h1>Pixiv ${escapeHtml(data.mode === "artist" ? "画师作品" : "搜索")}「${escapeHtml(data.keyword)}」</h1>
      <div class="meta">${escapeHtml(data.subtitle)}</div>
    </div>
    <table><tbody>${rows}</tbody></table>
    <div class="foot">
      回复「下载 序号」或「下载 作品ID」即可搬运对应作品
      <div class="hint">列表保留 5 分钟,下载会续期;新搜索会替换当前列表;R-18 作品默认不提供下载。</div>
    </div>
  </div>
</body></html>`
}

/**
 * 渲染搜索结果卡面(缩略图先经代理落盘,再以 file:// 嵌入)。
 * 返回 { imagePath, tempFiles };发送后由调用方删除 tempFiles。
 */
export async function renderPixivListCard(session = {}, { proxyUrl = "", fetchImpl = null, logger = globalThis.logger } = {}) {
  const items = (session.items || []).slice(0, LIST_MAX_ITEMS)
  const tempFiles = []
  // 浏览器冷启动与缩略图下载并行,谁慢等谁
  const browserPromise = getSharedBrowser()
  const withThumbs = await Promise.all(items.map(async item => {
    let thumbPath = ""
    if (item.thumbUrl) {
      // 8 张并发走代理偶发单张失败,补一次重试再降级占位
      thumbPath = await downloadPixivArchiveImage(item.thumbUrl, { maxBytes: 3 * 1024 * 1024, timeoutMs: 12_000, proxyUrl, fetchImpl })
      if (!thumbPath) {
        thumbPath = await downloadPixivArchiveImage(item.thumbUrl, { maxBytes: 3 * 1024 * 1024, timeoutMs: 12_000, proxyUrl, fetchImpl })
      }
      if (thumbPath) tempFiles.push(thumbPath)
    }
    return { ...item, thumbPath }
  }))
  const total = Number(session.total || items.length) || items.length
  const orderLabel = {
    newest: "按时间·最新",
    oldest: "按时间·最早",
    "popular-native": "按人气·全站收藏排序",
    "popular-rerank": "按近期人气(最新上传中收藏最多,登录Cookie可解锁全站)"
  }[session.orderSource === "rerank" ? "popular-rerank" : session.order === "popular" ? "popular-native" : PIXIV_SEARCH_ORDERS.has(session.order) ? session.order : "newest"]
  const subtitle = session.mode === "artist" && session.artist?.userName
    ? `画师 ${session.artist.userName} 的最近作品 · 共 ${items.length} 张 · ${orderLabel}`
    : `共 ${total} 个结果,展示前 ${items.length} 个 · ${orderLabel}`
  const outputDir = path.join(os.tmpdir(), "shiloh-plugin-pixiv-cards")
  await fs.promises.mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `pixiv-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`)

  const browser = await browserPromise
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 760, height: 900, deviceScaleFactor: 2 })
    await page.setContent(await buildPixivListHtml({ keyword: session.keyword, mode: session.mode, subtitle, items: withThumbs }), { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.evaluate(async () => {
      await Promise.all([...document.images].map(img => img.complete ? null : new Promise(resolve => { img.onload = img.onerror = resolve })))
    }).catch(() => {})
    const height = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height))
    // JPEG 截图:比 PNG 小一个量级,大幅缩短随后的 QQ 上传耗时
    await page.screenshot({ path: outputPath, clip: { x: 0, y: 0, width: 760, height: Math.max(1, height) }, type: "jpeg", quality: 88 })
    return { imagePath: outputPath, tempFiles }
  } catch (error) {
    logger?.warn?.(`[Pixiv] 列表卡面渲染失败: ${String(error?.message || error).slice(0, 120)}`)
    await fs.promises.unlink(outputPath).catch(() => {})
    return { imagePath: "", tempFiles }
  } finally {
    await page.close().catch(() => {})
    scheduleSharedBrowserClose()
  }
}

export async function cleanupPixivListCard(tempFiles = []) {
  await Promise.all((Array.isArray(tempFiles) ? tempFiles : []).map(file => fs.promises.unlink(file).catch(() => {})))
}
