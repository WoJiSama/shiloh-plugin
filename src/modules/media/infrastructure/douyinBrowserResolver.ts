import type {Browser,Page} from "puppeteer"
import {record,errorText,type DouyinCard,type MediaLogger} from "./douyinTypes.js"
import { createSingleFlightResolver } from "../../foundation/infrastructure/singleFlightResolver.js"

const RESOLVE_TIMEOUT_MS = 25_000
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"

/**
 * 从任意 JSON 里深找第一个可用的 play_addr(抖音 detail 响应结构随版本漂移,
 * 深找比固定路径稳)。纯函数,便于单测。
 */
export function extractPlayUrlFromJson(value:unknown, visited = new Set<object>()):string {
  if (!value || typeof value !== "object" || visited.has(value)) return ""
  visited.add(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractPlayUrlFromJson(item, visited)
      if (found) return found
    }
    return ""
  }
  const data=record(value)
  const playAddr = record(data.play_addr || data.playAddr)
  if (Array.isArray(playAddr.url_list) && playAddr.url_list.length) {
    const url = String(playAddr.url_list.find(Boolean) || "")
    if (/^https?:\/\//i.test(url)) return url
  }
  if (typeof data.play_url === "string" && /^https?:\/\/\S+\.mp4/i.test(data.play_url)) return data.play_url
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
export function extractNoteImagesFromJson(value:unknown) {
  const item = deepFind(value, node =>
    node && typeof node === "object" &&
    /^\d{6,}$/.test(String(node.aweme_id || "")) &&
    Array.isArray(node.images) && node.images.length > 0
  )
  if (!item) return []
  return dedupeUrls((Array.isArray(item.images)?item.images:[]).map(image => firstHttpUrlOf(record(image).url_list)))
}

function firstHttpUrlOf(list:unknown) {
  const url = Array.isArray(list) ? list.find(Boolean) : list
  return url && /^https?:\/\//i.test(String(url)) ? String(url) : ""
}

function dedupeUrls(list:string[] = []) {
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
function dedupeByTosKey(list:string[] = []) {
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

async function applyStealth(page:Page) {
  await page.setUserAgent(DESKTOP_UA)
  await page.evaluateOnNewDocument(STEALTH_INIT_SCRIPT)
}

// 短链(v.douyin.com/xxx)用纯 HTTP 跟随重定向即可解析出最终地址,
// 不必让浏览器先加载分享页再被客户端跳转(省 0.5-1.5s 与一次二次导航)
async function resolveShortLinkTarget(entry:string, { timeoutMs = 5000 } = {}) {
  try {
    let url = String(entry || "")
    for (let hop = 0; hop < 3; hop++) {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 10; K)" }
      })
      const location = response.headers.get("location")
      if (response.status >= 300 && response.status < 400 && location) {
        url = new URL(location, url).href
        continue
      }
      return url
    }
    return url
  } catch {
    return ""
  }
}

async function resolveAwemeId(page:Page, card:DouyinCard) {
  const known = String(card.aweme_id || "").trim()
  if (known && /^\d{6,}$/.test(known)) return known
  // 短链跳转后的分享页 URL 是 /share/video/<id>/ 或 /share/note/<id>/(图文)
  const current = page.url()
  const fromUrl = current.match(/\/(?:share\/)?(?:video|note)\/(\d{6,})/)?.[1]
  if (fromUrl) return fromUrl
  return await page.evaluate(() => {
    const router = (window as Window & {_ROUTER_DATA?:{loaderData?:Record<string,{itemId?:string;query?:{item_id?:string}}>}})._ROUTER_DATA?.loaderData?.["video_(id)/page"]
    return String(router?.itemId || router?.query?.item_id || "").trim()
  }).catch(() => "") || ""
}

/**
 * 从 detail JSON 深找图文作品的背景音乐直链(music.play_url.url_list)。
 * 纯函数,便于单测;返回空串表示无音乐。
 */
export function extractDouyinMusicFromJson(value:unknown, awemeId = ""):string {
  // _ROUTER_DATA 里推荐流/相关作品也带 music:全局深找会配错 BGM。
  // 先定位目标作品节点(aweme_id 匹配)在其子树内找,找不到匹配节点才退全局。
  const extractFrom = (node:unknown, visited = new Set<object>()):string => {
    if (!node || typeof node !== "object" || visited.has(node)) return ""
    visited.add(node)
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = extractFrom(item, visited)
        if (found) return found
      }
      return ""
    }
    const data = record(node)
    const playUrl = record(record(data.music).play_url)
    const urlList = Array.isArray(playUrl.url_list) ? playUrl.url_list : []
    const url = String(urlList.find(Boolean) || playUrl.url || "")
    if (/^https?:\/\//i.test(url) && /mp3|m4a|aac|audio|ies-music|douyinstatic/i.test(url)) return url.replace(/^http:\/\//i, "https://")
    for (const child of Object.values(node)) {
      const found = extractFrom(child, visited)
      if (found) return found
    }
    return ""
  }
  const wanted = String(awemeId || "").trim()
  if (wanted) {
    const item = deepFind(value, node => String(node.aweme_id || "") === wanted)
    if (item) {
      const scoped = extractFrom(item)
      if (scoped) return scoped
    }
  }
  return extractFrom(value)
}

export function createDouyinBrowserResolver(ports:{getSharedBrowser():Promise<Browser>;scheduleSharedBrowserClose():void;logger?:MediaLogger}) {
const {getSharedBrowser,scheduleSharedBrowserClose}=ports
const RESOLVE_RESULT_TTL_MS = 60_000
// 同一时刻只开一个抖音页面:并发打开相同/相近页面会触发反爬,导致部分页面静默拿不到数据。
// 成功结果保留 60s(play_url 实际有效期远长于此),失败不缓存可立即重试。
const resolveAwemeViaBrowserPage = createSingleFlightResolver(
  (card:DouyinCard, options:{timeoutMs?:number;logger?:MediaLogger|undefined}) => resolveDouyinShareInPage(card, options),
  { ttlMs: RESOLVE_RESULT_TTL_MS }
)

function resolveDouyinShareViaBrowser(card:DouyinCard = {}, options:{timeoutMs?:number;logger?:MediaLogger|undefined} = {}) {
  const entry = String(card?.page_url || card?.short_url || "").trim()
  if (!/^https?:\/\//i.test(entry)) return Promise.resolve(null)
  const key = String(card?.aweme_id || "").trim() || entry
  return resolveAwemeViaBrowserPage(key, card, options)
}

async function resolveDouyinShareInPage(card:DouyinCard = {}, { timeoutMs = RESOLVE_TIMEOUT_MS, logger = ports.logger }:{timeoutMs?:number;logger?:MediaLogger|undefined} = {}) {
  const entry = String(card.page_url || card.short_url || "").trim()
  if (!/^https?:\/\//i.test(entry)) return null

  const browser = await getSharedBrowser()
  const page = await browser.newPage()
  const deadline = Date.now() + Math.max(8000, Number(timeoutMs) || RESOLVE_TIMEOUT_MS)
  let detailJson:unknown = null
  try {
    await applyStealth(page)
    // 拦截纯浪费的流量:页面自播的视频流(media/m4s,MB级)、字体、埋点上报。
    // 播放地址只从 video 元素 src 属性与 detail 接口取,不依赖页面真的播放
    await page.setRequestInterception(true).catch(() => {})
    let musicFromNetwork = ""
    page.on("request", request => {
      const type = request.resourceType()
      const url = request.url()
      // 图文作品的背景音乐会以 media 类型请求:记录直链后照常拦截(不需要真的下载播放)
      if (!musicFromNetwork && type === "media" && /^https?:\/\//i.test(url) && /(ies-music|\.mp3|\.m4a|\.aac|audio)/i.test(url)) musicFromNetwork = url
      if (type === "media" || type === "font") return request.abort("blockedbyclient").catch(() => {})
      if (/\.(woff2?|ttf|otf|m4s|ts|mp4)(\?|$)/i.test(url)) return request.abort("blockedbyclient").catch(() => {})
      if (/\/(webmssdk|mcs|slardar|tnc|collect|beacon|applog)[/?]|\/log\//i.test(url)) return request.abort("blockedbyclient").catch(() => {})
      return request.continue().catch(() => {})
    })
    const timing:Record<string,number> & {start:number} = { start: Date.now() }
    const mark = (label:string) => { timing[label] = Date.now() - timing.start }
    mark("init")
    page.on("response", async response => {
      try {
        if (detailJson) return
        const url = response.url()
        if (!/\/aweme\/v1\/web\/aweme\/detail/.test(url)) return
        if (!/json/i.test(String(response.headers()?.["content-type"] || ""))) return
        const json:unknown = await response.json()
        if (json && (extractPlayUrlFromJson(json) || extractNoteImagesFromJson(json).length)) detailJson = json
      } catch {}
    })

    // 预解析短链:能直接得到 /video|note/<id> 就跳过分享页直进桌面页
    const resolvedTarget = await resolveShortLinkTarget(entry)
    const directDesktop = /\/(?:video|note)\/\d+/.test(resolvedTarget || "")
      ? resolvedTarget.replace(/^(https?:\/\/[^\/]+)\/(?:share\/)?((?:video|note)\/\d+)[^\s]*$/, "$1/$2")
      : ""
    await page.goto(directDesktop || entry, { waitUntil: "domcontentloaded", timeout: Math.min(deadline - Date.now(), 15000) })
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
        for (const img of document.querySelectorAll<HTMLImageElement>('[data-e2e="feed-active-video"] img[src*="douyinpic"], [data-e2e="player-container"] img[src*="douyinpic"], .xgplayer-slider img[src*="douyinpic"]')) {
          seen.add((img.src.match(/\/(tos-cn-[^/?]+)\/([^?~]+)/) || [])[0] || img.src.split("?")[0])
        }
        return seen.size >= slider.childElementCount
      }, { timeout: Math.min(deadline - Date.now(), 12000), polling: 300 }).catch(() => {})
    } else {
      await page.waitForSelector("video", { timeout: Math.min(deadline - Date.now(), 10000) }).catch(() => {})
      await page.waitForFunction(() => Boolean(document.querySelector("video")?.src), { timeout: Math.min(deadline - Date.now(), 6000) }).catch(() => {})
    }
    mark("waits")

    // evaluate 前已知 detail 音乐与网络捕获:都不缺时跳过整页 _ROUTER_DATA 序列化(几百 KB 级)
    const detailMusic = detailJson ? extractDouyinMusicFromJson(detailJson, awemeId) : ""
    const needRouterData = !detailMusic && !musicFromNetwork
    const domInfo = await Promise.race([
      page.evaluate((awemeId, needRouterData) => {
      const routerDataJson = needRouterData ? JSON.stringify((window as Window & {_ROUTER_DATA?:unknown})._ROUTER_DATA || null) : ""
      const video = document.querySelector("video")
      const sources = video ? [video.src, video.currentSrc, ...[...video.querySelectorAll("source")].map(s => s.src)] : []
      const src = sources.find(Boolean) || ""
      const ogTitle = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content || ""
      const title = ogTitle || document.querySelector("h1")?.textContent || document.title || ""
      const poster = video?.poster || document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content || ""
      const jsonLd = document.querySelector('script[type="application/ld+json"]')?.textContent || ""
      // 图集图片:slider 图 ∪ 播放器容器标记图(两者在等待退出时已凑齐,
      // 下游按图床对象ID去重),再退到"非评论区带标记"、全部 douyinpic
      const inPlayer = (img:HTMLImageElement) => Boolean(img.closest('[data-e2e="feed-active-video"], [data-e2e="player-container"]'))
      const notComment = (img:HTMLImageElement) => (img.closest("[data-e2e]")?.getAttribute("data-e2e") || "") !== "comment-item"
      const hasMark = (url:string) => /biz_tag=aweme_images|PackSourceEnum_AWEME_DETAIL|tplv-dy-aweme-images/i.test(String(url))
      const douyinpicSrc = (img:HTMLImageElement) => String(img.src || img.getAttribute("data-src") || "")
      const douyinpicImages = [...document.querySelectorAll<HTMLImageElement>('img[src*="douyinpic"]')].map(douyinpicSrc).filter(Boolean)
      const sliderImages = [...document.querySelectorAll<HTMLImageElement>(".xgplayer-slider img")]
        .map(douyinpicSrc)
        .filter(url => /douyinpic\./i.test(String(url)))
      const inPlayerMarked = [...document.querySelectorAll<HTMLImageElement>('img[src*="douyinpic"]')]
        .filter(img => inPlayer(img) && hasMark(img.src))
        .map(douyinpicSrc)
      const byMarker = [...document.querySelectorAll<HTMLImageElement>('img[src*="douyinpic"]')]
        .filter(img => notComment(img) && hasMark(img.src))
        .map(douyinpicSrc)
      const gallerySet = [...sliderImages, ...inPlayerMarked]
      const galleryImages = gallerySet.length ? gallerySet
        : byMarker.length ? byMarker
        : douyinpicImages
      return { src: String(src || ""), poster: String(poster || ""), title: String(title || "").trim(), ogTitle: String(ogTitle || "").trim(), jsonLd, galleryImages, awemeId, routerDataJson }
      }, awemeId, needRouterData).catch(() => null),
      new Promise<null>(resolve => { const timer = setTimeout(() => resolve(null), 10000); timer.unref?.() })
    ]).catch(() => null)

    const domGalleryImages = dedupeByTosKey((domInfo?.galleryImages || []).map(String))
    const noteImages = detailJson
      ? dedupeByTosKey(extractNoteImagesFromJson(detailJson))
      : domGalleryImages
    const playUrl = (domInfo && /^https?:\/\//i.test(domInfo.src) ? domInfo.src : "") || (detailJson ? extractPlayUrlFromJson(detailJson) : "")
    // 背景音乐三级来源:detail 响应 → 页面 _ROUTER_DATA → 网络层捕获的 media 请求
    let musicUrl = detailMusic
    if (!musicUrl && domInfo?.routerDataJson && domInfo.routerDataJson !== "null") {
      try {
        musicUrl = extractDouyinMusicFromJson(JSON.parse(domInfo.routerDataJson), awemeId)
      } catch {}
    }
    if (!musicUrl) musicUrl = musicFromNetwork
    const result = {
      play_url: playUrl,
      images: noteImages,
      music_url: musicUrl,
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
      result.author = cleanAuthor(record(item.author).nickname || record(item.author).name)
      result.duration = normalizeMs(Number(item.duration || record(item.video).duration) || 0)
      result.cover_url = result.cover_url || firstUrlOf(record(record(item.video).cover).url_list || record(record(item.video).origin_cover).url_list)
    }
    if (domInfo?.jsonLd && !result.duration) {
      try {
        const ld = record(JSON.parse(domInfo.jsonLd))
        result.duration = normalizeMs(Number(ld.duration || 0) || 0)
        if (!result.cover_url && Array.isArray(ld.thumbnailUrl) && ld.thumbnailUrl.length) result.cover_url = String(ld.thumbnailUrl[0])
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
    logger?.warn?.(`[抖音] 浏览器解析异常: ${errorText(error)}`)
    return null
  } finally {
    page.removeAllListeners?.("response")
    await page.close().catch(() => {})
    scheduleSharedBrowserClose()
  }
}

return {resolveDouyinShareViaBrowser}
}
function deepFind(value:unknown, predicate:(value:Record<string,unknown>)=>unknown, visited = new Set<object>()):Record<string,unknown>|null {
  if (!value || typeof value !== "object" || visited.has(value)) return null
  visited.add(value)
  if (!Array.isArray(value) && predicate(record(value))) return record(value)
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

function cleanTitle(value:unknown) {
  return String(value || "").trim().slice(0, 300)
}

function cleanAuthor(value:unknown) {
  return String(value || "").trim().slice(0, 120)
}

function normalizeMs(value:unknown) {
  const number = Number(value) || 0
  // detail 接口的 duration 有毫秒和秒两种口径,超过 1 小时按毫秒折算
  return number > 36000 ? Math.round(number / 1000) : number
}

function firstUrlOf(list:unknown) {
  const url = Array.isArray(list) ? list.find(Boolean) : list
  return url ? String(url) : ""
}
