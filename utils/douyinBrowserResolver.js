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

/**
 * 从 detail JSON 里提取图集(图文作品)的图片列表:先定位作品节点
 * (带 aweme_id 的 item),只取该节点自己的 images——页面数据里还有
 * 推荐流/评论区/贴纸等结构也带 images 数组,全局深挖会把杂图收进来。
 */
export function extractNoteImagesFromJson(value) {
  const item = deepFind(value, node =>
    node && typeof node === "object" &&
    /^\d{6,}$/.test(String(node.aweme_id || "")) &&
    Array.isArray(node.images) && node.images.length > 0
  )
  if (!item) return []
  return dedupeUrls(item.images.map(image => firstHttpUrlOf(image?.url_list)))
}

function firstHttpUrlOf(list) {
  const url = Array.isArray(list) ? list.find(Boolean) : list
  return url && /^https?:\/\//i.test(String(url)) ? String(url) : ""
}

function dedupeUrls(list = []) {
  const seen = new Set()
  const out = []
  for (const url of list) {
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

// 同一张图的 CDN 变体(不同主机/签名)按图床对象 ID 去重:
// URL 路径里的 /tos-cn-xxx/<文件id>~tplv-... 是图片本体标识。
function dedupeByTosKey(list = []) {
  const seen = new Set()
  const out = []
  for (const url of list) {
    const text = String(url || "")
    const key = text.match(/\/(tos-cn-[^/?]+)\/([^?~]+)/)?.slice(1).join("/") || text.split("?")[0]
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out
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
  // 短链跳转后的分享页 URL 是 /share/video/<id>/ 或 /share/note/<id>/(图文)
  const current = page.url()
  const fromUrl = current.match(/\/(?:share\/)?(?:video|note)\/(\d{6,})/)?.[1]
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
    const timing = { start: Date.now() }
    const mark = label => { timing[label] = Date.now() - timing.start }
    mark("init")
    page.on("response", async response => {
      try {
        if (detailJson) return
        const url = response.url()
        if (!/\/aweme\/v1\/web\/aweme\/detail/.test(url)) return
        if (!/json/i.test(String(response.headers()?.["content-type"] || ""))) return
        const json = await response.json()
        if (json && (extractPlayUrlFromJson(json) || extractNoteImagesFromJson(json).length)) detailJson = json
      } catch {}
    })

    await page.goto(entry, { waitUntil: "domcontentloaded", timeout: Math.min(deadline - Date.now(), 15000) })
    mark("goto1")
    // 图文作品:短链可能落在 /share/note/<id>(移动分享页)或 /note/<id>(桌面页)
    const isNoteShare = /\/(?:share\/)?note\/\d+/i.test(page.url()) || card.media_kind === "note"
    const awemeId = await resolveAwemeId(page, card)
    mark("awemeId")
    if (awemeId && !page.url().includes(`/${awemeId}`)) {
      await page.goto(`https://www.douyin.com/${isNoteShare ? "note" : "video"}/${awemeId}`, { waitUntil: "domcontentloaded", timeout: Math.min(deadline - Date.now(), 15000) })
    }
    mark("goto2")
    // 视频页等播放器挂载和 detail 响应(1-3s)。图文(图集)页:作品图片由轮播
    // 播放器渲染(feed-active-video/player-container 容器,带作品图床标记),
    // 实测约 5-6s 出现——等它出现即取,不空耗 video/detail 等待。
    if (isNoteShare) {
      // 期望张数 = .xgplayer-slider 子元素数(挂载即有);到位判据用播放器容器内
      // 标记图按图床对象ID去重后的数量——海报随容器 ~6s 全齐,而 slider 每张
      // slide 的 img 是逐张懒加载(~12s),用后者会白等。凑齐即走。
      await page.waitForFunction(() => {
        const slider = document.querySelector(".xgplayer-slider")
        if (!slider || !slider.childElementCount) return false
        const seen = new Set()
        for (const img of document.querySelectorAll('[data-e2e="feed-active-video"] img[src*="douyinpic"], [data-e2e="player-container"] img[src*="douyinpic"], .xgplayer-slider img[src*="douyinpic"]')) {
          seen.add((img.src.match(/\/(tos-cn-[^/?]+)\/([^?~]+)/) || [])[0] || img.src.split("?")[0])
        }
        return seen.size >= slider.childElementCount
      }, { timeout: Math.min(deadline - Date.now(), 12000), polling: 300 }).catch(() => {})
    } else {
      await page.waitForSelector("video", { timeout: Math.min(deadline - Date.now(), 10000) }).catch(() => {})
      await page.waitForFunction(() => Boolean(detailJson), { timeout: Math.min(deadline - Date.now(), 6000) }).catch(() => {})
    }
    mark("waits")

    const domInfo = await page.evaluate(awemeId => {
      const video = document.querySelector("video")
      const sources = video ? [video.src, video.currentSrc, ...[...video.querySelectorAll("source")].map(s => s.src)] : []
      const src = sources.find(Boolean) || ""
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content || ""
      const title = ogTitle || document.querySelector("h1")?.textContent || document.title || ""
      const poster = video?.poster || document.querySelector('meta[property="og:image"]')?.content || ""
      const jsonLd = document.querySelector('script[type="application/ld+json"]')?.textContent || ""
      // 图集图片:slider 图 ∪ 播放器容器标记图(两者在等待退出时已凑齐,
      // 下游按图床对象ID去重),再退到"非评论区带标记"、全部 douyinpic
      const inPlayer = img => Boolean(img.closest('[data-e2e="feed-active-video"], [data-e2e="player-container"]'))
      const notComment = img => (img.closest("[data-e2e]")?.getAttribute("data-e2e") || "") !== "comment-item"
      const hasMark = url => /biz_tag=aweme_images|PackSourceEnum_AWEME_DETAIL|tplv-dy-aweme-images/i.test(String(url))
      const douyinpicSrc = img => String(img.src || img.getAttribute("data-src") || "")
      const douyinpicImages = [...document.querySelectorAll('img[src*="douyinpic"]')].map(douyinpicSrc).filter(Boolean)
      const sliderImages = [...document.querySelectorAll(".xgplayer-slider img")]
        .map(douyinpicSrc)
        .filter(url => /douyinpic\./i.test(String(url)))
      const inPlayerMarked = [...document.querySelectorAll('img[src*="douyinpic"]')]
        .filter(img => inPlayer(img) && hasMark(img.src))
        .map(douyinpicSrc)
      const byMarker = [...document.querySelectorAll('img[src*="douyinpic"]')]
        .filter(img => notComment(img) && hasMark(img.src))
        .map(douyinpicSrc)
      const gallerySet = [...sliderImages, ...inPlayerMarked]
      const galleryImages = gallerySet.length ? gallerySet
        : byMarker.length ? byMarker
        : douyinpicImages
      return { src: String(src || ""), poster: String(poster || ""), title: String(title || "").trim(), ogTitle: String(ogTitle || "").trim(), jsonLd, galleryImages, awemeId }
    }, awemeId).catch(() => null)

    const domGalleryImages = dedupeByTosKey((domInfo?.galleryImages || []).map(String))
    const noteImages = detailJson
      ? dedupeByTosKey(extractNoteImagesFromJson(detailJson))
      : domGalleryImages
    const playUrl = (domInfo && /^https?:\/\//i.test(domInfo.src) ? domInfo.src : "") || (detailJson ? extractPlayUrlFromJson(detailJson) : "")
    const result = {
      play_url: playUrl,
      images: noteImages,
      media_kind: playUrl ? (isNoteShare ? "note" : "video") : (noteImages.length ? "note" : "video"),
      cover_url: domInfo?.poster || "",
      title: domInfo?.title || "",
      author: "",
      // 图文作品不搬轮播视频(要的是图集本身);duration 保持 0,
      // shouldAttachDouyinVideo 会拦下视频路径,relay 走图集图片。
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

    if (!/^https?:\/\//i.test(result.play_url) && !result.images.length) {
      logger?.warn?.(`[抖音] 浏览器解析未取得播放地址 aweme=${result.aweme_id || "?"} 页面=${page.url()}`)
      return null
    }
    mark("done")
    logger?.info?.(`[抖音] 浏览器解析成功 aweme=${result.aweme_id || "?"} ${result.images.length ? `图集${result.images.length}张` : `duration=${result.duration}s`} 来源=${detailJson ? "detail响应" : domInfo && /^https?:/.test(domInfo.src) ? "video元素" : "页面图片"} note=${isNoteShare ? 1 : 0} 分段=${JSON.stringify(timing)}`)
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
