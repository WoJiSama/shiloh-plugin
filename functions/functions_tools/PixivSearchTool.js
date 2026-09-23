import fs from "node:fs"
import YAML from "yaml"
import path from "node:path"
import { AbstractTool } from "./AbstractTool.js"
import {
  listPixivArtistRecentWorks,
  renderPixivListCard,
  cleanupPixivListCard,
  resolvePixivArtistFromItems,
  savePixivSearchSession,
  searchPixivArtworks
} from "../../utils/pixivSearch.js"
import { normalizePixivKeyword, normalizePixivOrderBy, normalizePixivSearchType } from "../../utils/pixivIntent.js"

function findConfigPath() {
  const cwd = process.cwd()
  const candidates = [
    path.join(cwd, "plugins", "shiloh-plugin", "config", "message.yaml"),
    path.join(cwd, "config", "message.yaml")
  ]
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0]
}

function readPixivRelayConfig() {
  try {
    const document = YAML.parse(fs.readFileSync(findConfigPath(), "utf8")) || {}
    const relay = document.pluginSettings?.pixivRelay || {}
    return {
      enabled: relay.enabled !== false,
      proxyUrl: String(relay.proxyUrl || "").trim(),
      cookieHeader: String(relay.cookieHeader || "").trim(),
      allowRestricted: relay.allowRestricted === true
    }
  } catch {
    return { enabled: true, proxyUrl: "", cookieHeader: "", allowRestricted: false }
  }
}

export class PixivSearchTool extends AbstractTool {
  constructor() {
    super()
    this.name = "pixivSearchTool"
    this.description = "搜索 Pixiv 插画并发送带缩略图的结果卡面。群友说「找图/搜图/来张XX的图/找跟XX有关的图/查画师作品」想要插画或二次元作品时,优先用本工具而不是 bingImageSearchTool(必应适合找照片/截图/素材,P站适合插画作品)。用户回复「下载 序号」时改用 pixivDownloadTool。"
    this.skill = {
      name: "pixivSearchTool",
      purpose: "在 Pixiv 搜索插画并发送带缩略图与收藏数的结果列表卡面。",
      whenToUse: "用户想找插画/二次元图/某画师作品/某角色的同人图时。「跟XX有关的图」「来点XX的图」「查XX画师」都算。找照片、实拍、截图素材应改用 bingImageSearchTool。",
      boundaries: "不是画图(生图)、不是看图识图、不是表情包。磁链下载与本工具无关。",
      instructions: "keyword 只留搜索主体(角色名/画师名/标签),剥掉「跟…有关的图/查一下/来点/一些热门的」等框架词;searchType 只能 artworks 或 artist(看某画师本人作品时用 artist);orderBy 只能 newest/oldest/popular(热门/人气/收藏最多 → popular)。"
    }
    this.parameters = {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "搜索关键词,支持画师名、角色名或标签,例如 wlop、海琴烟、初音未来"
        },
        searchType: {
          type: "string",
          enum: ["artworks", "artist"],
          description: "必须填英文枚举:artworks=按关键词搜作品(默认);artist=用户想看某位画师本人的作品。不要填中文(插画/画师等会被自动纠正,但请优先直接用枚举值)"
        },
        orderBy: {
          type: "string",
          enum: ["newest", "oldest", "popular"],
          description: "必须填英文枚举:newest=最新(默认);oldest=最早;popular=人气(热门/收藏最多)。不要填中文(相关度/热门等会被自动纠正,但请优先直接用枚举值)"
        }
      },
      required: ["keyword"],
      additionalProperties: false
    }
  }

  /**
   * 低模型偶发用自然语言填枚举(searchType:"插画"、orderBy:"相关度"),
   * 这里统一归一化,避免参数校验拒绝后大模型临场换错工具。
   */
  normalizeParameters(params) {
    const next = { ...(params || {}) }
    if (next.keyword != null) next.keyword = normalizePixivKeyword(next.keyword)
    if (next.searchType != null) next.searchType = normalizePixivSearchType(next.searchType)
    if (next.orderBy != null) next.orderBy = normalizePixivOrderBy(next.orderBy)
    return next
  }

  async func(opts, e) {
    const { keyword, searchType, orderBy } = opts
    const config = readPixivRelayConfig()
    if (!config.enabled) return "error: Pixiv 功能当前已在配置中关闭"

    const order = ["newest", "oldest", "popular"].includes(orderBy) ? orderBy : "newest"
    let session
    try {
      const result = await searchPixivArtworks(keyword, { order, proxyUrl: config.proxyUrl, cookieHeader: config.cookieHeader })
      if (searchType === "artist") {
        // 画师意图:从结果里按画师名匹配;匹配到就切换为该画师最近作品列表
        const artist = resolvePixivArtistFromItems(result.items, keyword)
        if (artist) {
          const works = await listPixivArtistRecentWorks(artist.userId, { proxyUrl: config.proxyUrl, cookieHeader: config.cookieHeader })
          session = { keyword, mode: "artist", order: "newest", orderSource: "native", artist, total: works.items.length, items: works.items }
        } else {
          session = { keyword, mode: "artworks", order, orderSource: result.orderSource, total: result.total, items: result.items }
        }
      } else {
        session = { keyword, mode: "artworks", order, orderSource: result.orderSource, total: result.total, items: result.items }
      }
    } catch (error) {
      return `error: Pixiv 搜索失败: ${String(error?.message || error).slice(0, 160)}`
    }

    await savePixivSearchSession(e, session)

    let card = { imagePath: "", tempFiles: [] }
    try {
      card = await renderPixivListCard(session, { proxyUrl: config.proxyUrl })
      if (card.imagePath && typeof e?.reply === "function") {
        await e.reply(segment.image(card.imagePath))
      }
    } finally {
      await cleanupPixivListCard(card.tempFiles)
      if (card.imagePath) await fs.promises.unlink(card.imagePath).catch(() => {})
    }

    const listing = session.items.slice(0, 8).map((item, index) =>
      `${index + 1}. ${item.title} / ${item.userName}${item.pageCount > 1 ? `(${item.pageCount}张)` : ""} [${item.id}]${item.xRestrict > 0 ? "(R-18)" : ""}`
    ).join("\n")
    const head = session.mode === "artist"
      ? `已找到画师 ${session.artist.userName} 的最近 ${session.items.length} 张作品`
      : `「${keyword}」共 ${session.total} 个结果,已展示前 ${Math.min(8, session.items.length)} 个`
    return `${head},列表卡面已发送。引导用户:回复「下载 序号」(如 下载 1)或「下载 作品ID」即可搬运对应作品;R-18 作品默认不提供下载。\n${listing}`
  }
}
