import type {Browser,Page} from "puppeteer"
import {record,errorText,type XiaohongshuCard,type MediaLogger} from "./xiaohongshuTypes.js"
import {normalizeXiaohongshuImageUrl,parseXiaohongshuInitialState,buildCardFromNoteState,extractXiaohongshuVideo,extractXiaohongshuDescription,extractXiaohongshuGallery} from "./xiaohongshuMessage.js"
import { createSingleFlightResolver } from "../../foundation/infrastructure/singleFlightResolver.js"

const RESOLVE_TIMEOUT_MS = 25_000
const MOBILE_UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"

// 桌面 UA 会被未登录墙弹回 /explore 首页(2026-10 实测 feed API 返回 -101 无登录信息);
// 移动 UA + 移动视口可直接渲染笔记内容,数据从 DOM/网络层取。
const STEALTH_INIT_SCRIPT = `
  Object.defineProperty(navigator, "webdriver", { get: () => undefined })
  Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] })
`

async function applyMobileProfile(page:Page) {
  await page.setUserAgent(MOBILE_UA)
  await page.setViewport({width: 414, height: 896, isMobile: true, hasTouch: true})
  await page.evaluateOnNewDocument(STEALTH_INIT_SCRIPT)
}

// 页面运行时数据口径:标题去站点后缀,作者取"关注"按钮前的昵称行,
// 正文取内容区选择器(移动端多为 desc 容器)。
// 图片白名单:笔记图床(sns-webpic/sns-img),排除头像(/avatar/)、UI 图(picasso/fe-*)
export function extractFromDomPayload(payload:{
  title:string;bodyText:string;imageUrls:string[];ogImage:string;hasVideo:boolean;noteUrl:string
}) {
  const title = payload.title.replace(/\s*[-|]\s*小红书\s*$/u, "").trim()
  const lines = String(payload.bodyText || "").split("\n").map(line => line.trim()).filter(Boolean)
  let author = ""
  const followIndex = lines.findIndex(line => line === "关注")
  if (followIndex > 0) {
    // 作者行会混入轮播覆盖层噪音:实况角标 LIVE、"打开App查看更多"引导、图片计数 n/m
    const authorLines = lines.slice(0, followIndex).filter(line =>
      !/^(?:LIVE\s*)+$/i.test(line) && !/^打开App/.test(line) && !/^\d+\s*\/\s*\d+$/.test(line))
    author = authorLines.join(" ").slice(0, 60).trim()
  }
  let description = ""
  // 移动端按钮文案随版本在「展开/展开全文」间漂移,两者都认
  const expandIndex = lines.findIndex(line => /^(展开|展开全文)$/.test(line))
  if (expandIndex >= 0 && expandIndex + 1 < lines.length) {
    const stopIndex = lines.findIndex((line, index) => index > expandIndex && /^(发弹幕|点击进入评论区?|\d+条精选评论|昨天|刚刚|\d+分钟前|\d+小时前)$/.test(line))
    description = lines.slice(expandIndex + 1, stopIndex > 0 ? stopIndex : undefined).join(" ").slice(0, 2000)
  }
  const isNoteImage = (url:string) => /(sns-webpic|sns-img|sns-video)[^/]*\.xhscdn\.com/i.test(url) && !/\/avatar\//i.test(url)
  const images = [...new Set((payload.imageUrls || []).map(String).filter(isNoteImage).map(normalizeXiaohongshuImageUrl).filter(Boolean))]
  return {
    title,
    author,
    description,
    cover_url: images[0] || normalizeXiaohongshuImageUrl(payload.ogImage) || "",
    images,
    media_kind: payload.hasVideo ? "video" : "image"
  }
}

export function createXiaohongshuBrowserResolver(ports:{getSharedBrowser():Promise<Browser>;scheduleSharedBrowserClose():void;logger?:MediaLogger}) {
const {getSharedBrowser,scheduleSharedBrowserClose}=ports
const RESOLVE_RESULT_TTL_MS = 60_000
// 并发打开多个小红书页面会触发风控静默降级,与抖音一致按链接单飞
const resolveNoteViaBrowserPage = createSingleFlightResolver(
  (card:XiaohongshuCard, options:{timeoutMs?:number;logger?:MediaLogger|undefined}) => resolveXiaohongshuInPage(card, options),
  { ttlMs: RESOLVE_RESULT_TTL_MS }
)

function resolveXiaohongshuShareViaBrowser(card:XiaohongshuCard = {}, options:{timeoutMs?:number;logger?:MediaLogger|undefined} = {}) {
  const entry = String(card?.page_url || card?.short_url || "").trim()
  if (!/^https?:\/\//i.test(entry)) return Promise.resolve(null)
  const key = String(card?.note_id || "").trim() || entry
  return resolveNoteViaBrowserPage(key, card, options)
}

async function resolveXiaohongshuInPage(card:XiaohongshuCard = {}, { timeoutMs = RESOLVE_TIMEOUT_MS, logger = ports.logger }:{timeoutMs?:number;logger?:MediaLogger|undefined} = {}):Promise<XiaohongshuCard|null> {
  const entry = String(card.page_url || card.short_url || "").trim()
  if (!/^https?:\/\//i.test(entry)) return null
  const browser = await getSharedBrowser()
  const page = await browser.newPage()
  const deadline = Date.now() + Math.max(8000, Number(timeoutMs) || RESOLVE_TIMEOUT_MS)
  try {
    await applyMobileProfile(page)
    // 拦截纯浪费的流量:字体、埋点与视频媒体流(blob 播放拆出的分片拿不到直链,只留封面)
    await page.setRequestInterception(true).catch(() => {})
    page.on("request", request => {
      const type = request.resourceType()
      const url = request.url()
      if (type === "font" || type === "media") return request.abort("blockedbyclient").catch(() => {})
      if (/\.(woff2?|ttf|otf|mp4|m4s|ts)(\?|$)/i.test(url)) return request.abort("blockedbyclient").catch(() => {})
      if (/\/(webmssdk|mcs|slardar|tnc|collect|beacon|applog)[/?]|\/log\//i.test(url)) return request.abort("blockedbyclient").catch(() => {})
      return request.continue().catch(() => {})
    })
    await page.goto(entry, { waitUntil: "domcontentloaded", timeout: Math.min(deadline - Date.now(), 15000) })
    // 笔记内容异步渲染:等内容区出现或超时(实测移动端 5-7s 出齐)
    await page.waitForFunction(() => Boolean(document.querySelector("#detail-desc, .note-content, .content") || document.body?.innerText?.length > 200), { timeout: Math.min(deadline - Date.now(), 12000), polling: 400 }).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 1500))

    const domPayload = await page.evaluate(() => {
      // 全量收集 img src,头像/UI 图由 extractFromDomPayload 的白名单过滤(纯函数可测)
      const imageUrls = [...document.querySelectorAll("img")]
        .map(img => String(img.src || img.getAttribute("data-src") || ""))
        .filter(url => /^https?:\/\//i.test(url))
      const state = (window as Window & {__INITIAL_STATE__?:unknown}).__INITIAL_STATE__
      return {
        title: document.title || "",
        bodyText: document.body?.innerText || "",
        imageUrls,
        ogImage: document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content || document.querySelector<HTMLMetaElement>('meta[name="og:image"]')?.content || "",
        hasVideo: Boolean(document.querySelector("video")),
        noteUrl: location.href,
        initialStateJson: JSON.stringify(state || null)
      }
    }).catch(() => null)

    if (!domPayload) return null
    // 已登录或 SSR 命中时页面状态里有完整笔记数据,优先于 DOM 启发式
    let stateCard:XiaohongshuCard|null = null
    try {
      if (domPayload.initialStateJson && domPayload.initialStateJson !== "null") {
        stateCard = buildCardFromNoteState(card, parseXiaohongshuInitialState(`<script>window.__INITIAL_STATE__=${domPayload.initialStateJson}</script>`), domPayload.noteUrl)
      }
    } catch {}
    const domInfo = extractFromDomPayload(domPayload)
    // 视频直链:移动端 state 深找 mp4(带签名,短时有效),优先 h264 保 QQ 兼容;
    // 简介全文同样从 state 深找(DOM 按钮文案漂移时会漏抓)
    let playUrl = ""
    let duration = 0
    let stateDescription = ""
    let gallery:{imageUrl:string; liveUrl:string}[] = []
    try {
      if (domPayload.initialStateJson && domPayload.initialStateJson !== "null") {
        const parsed = JSON.parse(domPayload.initialStateJson)
        const video = extractXiaohongshuVideo(parsed)
        playUrl = video.playUrl
        duration = video.duration
        stateDescription = extractXiaohongshuDescription(parsed)
        gallery = extractXiaohongshuGallery(parsed)
      }
    } catch {}
    // state 图集带实况对齐信息时优先;否则退到 DOM 图片(无实况)
    const galleryImages = gallery.map(entry => entry.imageUrl)
    const galleryLives = gallery.map(entry => entry.liveUrl)
    const hasGalleryLive = galleryLives.some(Boolean)
    const images = stateCard?.images?.length ? stateCard.images : (galleryImages.length ? galleryImages : (domInfo.images || []))
    const livePhotos = hasGalleryLive && images === galleryImages ? galleryLives : []
    // 媒体类型以分享链接自带 type 为准;无此信号时用时长启发式(实况照片是 2 秒左右的短视频段,
    // 不能仅凭页面存在 video 元素就当视频笔记)
    // 无分享类型信号时的兜底:页面有 video 元素且时长像正经视频(≥10s)才算视频笔记,
    // 2 秒级的实况段不算——否则误判为视频会把整个图集丢掉只发实况
    const resolvedMediaKind = stateCard?.media_kind
      || card.media_kind
      || (domInfo.media_kind === "video" && duration >= 10 ? "video" : "image")
    const isVideoNote = resolvedMediaKind === "video"
    if (!isVideoNote) playUrl = ""
    const result:XiaohongshuCard = {
      ...card,
      title: stateCard?.title || domInfo.title || card.title || "",
      description: stateCard?.description || stateDescription || domInfo.description || "",
      author: stateCard?.author || domInfo.author || "",
      liked: stateCard?.liked || 0,
      collected: stateCard?.collected || 0,
      comment_count: stateCard?.comment_count || 0,
      media_kind: isVideoNote ? "video" : "image",
      cover_url: stateCard?.cover_url || domInfo.cover_url || "",
      images,
      ...(livePhotos.length ? {live_photos: livePhotos} : {}),
      play_url: playUrl || stateCard?.play_url || "",
      duration: duration || stateCard?.duration || 0,
      note_id: stateCard?.note_id || card.note_id || "",
      final_url: domPayload.noteUrl || ""
    }
    if (!images.length && !result.title && !result.cover_url && !playUrl) {
      logger?.warn?.(`[小红书] 浏览器解析未取得笔记内容 note=${result.note_id || "?"} 页面=${domPayload.noteUrl}`)
      return null
    }
    logger?.info?.(`[小红书] 浏览器解析成功 note=${result.note_id || "?"} ${images.length ? `图${images.length}张` : "无图"}${livePhotos.filter(Boolean).length ? `实况${livePhotos.filter(Boolean).length}段` : ""} 视频=${isVideoNote ? 1 : 0}${isVideoNote && playUrl ? `(直链${duration}s)` : ""} 简介${(result.description || "").length}字 来源=${stateCard ? "页面状态" : "DOM"}`)
    return result
  } catch (error) {
    logger?.warn?.(`[小红书] 浏览器解析异常: ${errorText(error)}`)
    return null
  } finally {
    page.removeAllListeners?.("request")
    await page.close().catch(() => {})
    scheduleSharedBrowserClose()
  }
}

return {resolveXiaohongshuShareViaBrowser}
}
