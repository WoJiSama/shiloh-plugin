import { getSharedBrowser, scheduleSharedBrowserClose } from "./sharedBrowser.js"
import { createSingleFlightResolver } from "./singleFlightResolver.js"

const RESOLVE_TIMEOUT_MS = 25_000
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"

/**
 * 从任意 JSON 里深找第一个可用的 play_addr(抖音 detail 响应结构随版本漂移,
 * 深找比固定路径稳)。纯函数,便于单测。
 */
export function extractPlayUrlFromJson(value, visited = new Set()) {
  if (!value || typeof value !== "object" || visited.has(value)) return ""
  visited.add(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractPlayUrlFromJson(item, visited)
      if (found) return found
    }
    return ""
  }
  const playAddr = value.play_addr || value.playAddr
  if (playAddr?.url_list?.length) {
    const url = String(playAddr.url_list.find(Boolean) || "")
    if (/^https?:\/\//i.test(url)) return url
  }
  if (typeof value.play_url === "string" && /^https?:\/\/\S+\.mp4/i.test(value.play_url)) return value.play_url
  for (const child of Object.values(value)) {
    const found = extractPlayUrlFromJson(child, visited)
    if (found) return found
  }
  return ""
}

// 抖音 2026-09 改版:分享页不再 SSR 视频数据,mobile 版对无头浏览器返回"抱歉出错了"。
// 验证可行的路径:反检测补丁 + 桌面页 www.douyin.com/video/<id>,页面自己的 JS 会
// 完成 a_bogus 签名并请求 /aweme/v1/web/aweme/detail/,从 <video> 元素和网络响应截取。
const STEALTH_INIT_SCRIPT = `
  Object.defineProperty(navigator, "webdriver", { get: () => undefined })
  Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] })
  Object.defineProperty(navigator, "platform", { get: () => "Win32" })
  if (navigator.userAgentData) {
    Object.defineProperty(navigator, "userAgentData", { get: () => ({
      brands: [{ brand: "Chromium", version: "125" }, { brand: "Google Chrome", version: "125" }],
      mobile: false,
      platform: "Windows"
    }) })
  }
  window.chrome = window.chrome || { runtime: {} }
`

async function applyStealth(page) {
  await page.setUserAgent(DESKTOP_UA)
  await page.evaluateOnNewDocument(STEALTH_INIT_SCRIPT)
}

async function resolveAwemeId(page, card) {
  const known = String(card.aweme_id || "").trim()
  if (known && /^\d{6,}$/.test(known)) return known
  // 短链跳转后的分享页 URL 是 /share/video/<id>/
  const current = page.url()
  const fromUrl = current.match(/\/(?:share\/)?video\/(\d{6,})/)?.[1]
  if (fromUrl) return fromUrl
  return await page.evaluate(() => {
    const router = window._ROUTER_DATA?.loaderData?.["video_(id)/page"]
    return String(router?.itemId || router?.query?.item_id || "").trim()
  }).catch(() => "") || ""
}

const RESOLVE_RESULT_TTL_MS = 60_000
// 同一时刻只开一个抖音页面:并发打开相同/相近页面会触发反爬,导致部分页面静默拿不到数据。
// 成功结果保留 60s(play_url 实际有效期远长于此),失败不缓存可立即重试。
const resolveAwemeViaBrowserPage = createSingleFlightResolver(
  (card, options) => resolveDouyinShareInPage(card, options),
  { ttlMs: RESOLVE_RESULT_TTL_MS }
)

export function resolveDouyinShareViaBrowser(card = {}, options = {}) {
  const entry = String(card?.page_url || card?.short_url || "").trim()
  if (!/^https?:\/\//i.test(entry)) return Promise.resolve(null)
  const key = String(card?.aweme_id || "").trim() || entry
  return resolveAwemeViaBrowserPage(key, card, options)
}

async function resolveDouyinShareInPage(card = {}, { timeoutMs = RESOLVE_TIMEOUT_MS, logger = globalThis.logger } = {}) {
  const entry = String(card.page_url || card.short_url || "").trim()
  if (!/^https?:\/\//i.test(entry)) return null

  const browser = await getSharedBrowser()
  const page = await browser.newPage()
  const deadline = Date.now() + Math.max(8000, Number(timeoutMs) || RESOLVE_TIMEOUT_MS)
  let detailJson = null
  try {
    await applyStealth(page)
    page.on("response", async response => {
      try {
        if (detailJson) return
        const url = response.url()
        if (!/\/aweme\/v1\/web\/aweme\/detail/.test(url)) return
        if (!/json/i.test(String(response.headers()?.["content-type"] || ""))) return
        const json = await response.json()
        if (json && extractPlayUrlFromJson(json)) detailJson = json
      } catch {}
    })

    await page.goto(entry, { waitUntil: "domcontentloaded", timeout: Math.min(deadline - Date.now(), 15000) })
    const awemeId = await resolveAwemeId(page, card)
    if (awemeId && !page.url().includes(`/${awemeId}`)) {
      await page.goto(`https://www.douyin.com/video/${awemeId}`, { waitUntil: "domcontentloaded", timeout: Math.min(deadline - Date.now(), 15000) })
    }
    // 页面 JS 需要 1-3 秒完成签名请求和播放器挂载
    await page.waitForSelector("video", { timeout: Math.min(deadline - Date.now(), 10000) }).catch(() => {})
    await page.waitForFunction(() => Boolean(detailJson), { timeout: Math.min(deadline - Date.now(), 6000) }).catch(() => {})

    const domInfo = await page.evaluate(awemeId => {
      const video = document.querySelector("video")
      const sources = video ? [video.src, video.currentSrc, ...[...video.querySelectorAll("source")].map(s => s.src)] : []
      const src = sources.find(Boolean) || ""
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content || ""
      const title = ogTitle || document.querySelector("h1")?.textContent || document.title || ""
      const poster = video?.poster || document.querySelector('meta[property="og:image"]')?.content || ""
      const jsonLd = document.querySelector('script[type="application/ld+json"]')?.textContent || ""
      return { src: String(src || ""), poster: String(poster || ""), title: String(title || "").trim(), ogTitle: String(ogTitle || "").trim(), jsonLd, awemeId }
    }, awemeId).catch(() => null)

    const result = {
      play_url: domInfo && /^https?:\/\//i.test(domInfo.src) ? domInfo.src : (detailJson ? extractPlayUrlFromJson(detailJson) : ""),
      cover_url: domInfo?.poster || "",
      title: domInfo?.title || "",
      author: "",
      duration: 0,
      aweme_id: awemeId || card.aweme_id || "",
      final_url: page.url()
    }

    const item = detailJson ? deepFind(detailJson, node => node && typeof node === "object" && node.aweme_id && (node.desc !== undefined || node.video)) : null
    if (item) {
      result.aweme_id = String(item.aweme_id || result.aweme_id || "").trim()
      result.title = cleanTitle(item.desc) || result.title
      result.author = cleanAuthor(item.author?.nickname || item.author?.name)
      result.duration = normalizeMs(Number(item.duration || item.video?.duration) || 0)
      result.cover_url = result.cover_url || firstUrlOf(item.video?.cover?.url_list || item.video?.origin_cover?.url_list)
    }
    if (domInfo?.jsonLd && !result.duration) {
      try {
        const ld = JSON.parse(domInfo.jsonLd)
        result.duration = normalizeMs(Number(ld.duration || 0) || 0)
        if (!result.cover_url && ld.thumbnailUrl?.length) result.cover_url = String(ld.thumbnailUrl[0])
      } catch {}
    }
    // 桌面页标题带 " - 抖音" 后缀
    result.title = result.title.replace(/\s*[-|]\s*抖音\s*$/u, "").trim() || result.title

    if (!/^https?:\/\//i.test(result.play_url)) {
      logger?.warn?.(`[抖音] 浏览器解析未取得播放地址 aweme=${result.aweme_id || "?"} 页面=${page.url()}`)
      return null
    }
    logger?.info?.(`[抖音] 浏览器解析成功 aweme=${result.aweme_id || "?"} duration=${result.duration}s 来源=${domInfo && /^https?:/.test(domInfo.src) ? "video元素" : "detail响应"}`)
    return result
  } catch (error) {
    logger?.warn?.(`[抖音] 浏览器解析异常: ${error.message}`)
    return null
  } finally {
    page.removeAllListeners?.("response")
    await page.close().catch(() => {})
    scheduleSharedBrowserClose()
  }
}

function deepFind(value, predicate, visited = new Set()) {
  if (!value || typeof value !== "object" || visited.has(value)) return null
  visited.add(value)
  if (predicate(value)) return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFind(item, predicate, visited)
      if (found) return found
    }
    return null
  }
  for (const child of Object.values(value)) {
    const found = deepFind(child, predicate, visited)
    if (found) return found
  }
  return null
}

function cleanTitle(value) {
  return String(value || "").trim().slice(0, 300)
}

function cleanAuthor(value) {
  return String(value || "").trim().slice(0, 120)
}

function normalizeMs(value) {
  const number = Number(value) || 0
  // detail 接口的 duration 有毫秒和秒两种口径,超过 1 小时按毫秒折算
  return number > 36000 ? Math.round(number / 1000) : number
}

function firstUrlOf(list) {
  const url = Array.isArray(list) ? list.find(Boolean) : list
  return url ? String(url) : ""
}
