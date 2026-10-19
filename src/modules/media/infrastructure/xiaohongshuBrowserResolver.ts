import type {Browser,Page} from "puppeteer"
import {record,errorText,type XiaohongshuCard,type MediaLogger} from "./xiaohongshuTypes.js"
import {normalizeXiaohongshuImageUrl,parseXiaohongshuInitialState,buildCardFromNoteState} from "./xiaohongshuMessage.js"
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
  if (followIndex > 0) author = lines.slice(0, followIndex).join(" ").slice(0, 60)
  let description = ""
  const expandIndex = lines.findIndex(line => line === "展开")
  if (expandIndex >= 0 && expandIndex + 1 < lines.length) {
    const stopIndex = lines.findIndex((line, index) => index > expandIndex && /^(发弹幕|点击进入评论区?|\d+条精选评论)$/.test(line))
    description = lines.slice(expandIndex + 1, stopIndex > 0 ? stopIndex : undefined).join(" ").slice(0, 600)
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
    const images = stateCard?.images?.length ? stateCard.images : (domInfo.images || [])
    const result:XiaohongshuCard = {
      ...card,
      title: stateCard?.title || domInfo.title || card.title || "",
      description: stateCard?.description || domInfo.description || "",
      author: stateCard?.author || domInfo.author || "",
      liked: stateCard?.liked || 0,
      collected: stateCard?.collected || 0,
      comment_count: stateCard?.comment_count || 0,
      media_kind: stateCard?.media_kind || domInfo.media_kind,
      cover_url: stateCard?.cover_url || domInfo.cover_url || "",
      images,
      note_id: stateCard?.note_id || card.note_id || "",
      final_url: domPayload.noteUrl || ""
    }
    if (!images.length && !result.title && !result.cover_url) {
      logger?.warn?.(`[小红书] 浏览器解析未取得笔记内容 note=${result.note_id || "?"} 页面=${domPayload.noteUrl}`)
      return null
    }
    logger?.info?.(`[小红书] 浏览器解析成功 note=${result.note_id || "?"} ${images.length ? `图${images.length}张` : "无图"} 视频=${result.media_kind === "video" ? 1 : 0} 来源=${stateCard ? "页面状态" : "DOM"}`)
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
