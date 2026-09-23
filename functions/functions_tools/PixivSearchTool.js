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
import { PIXIV_SEARCH_TOOL_MANIFEST, normalizePixivKeyword, normalizePixivOrderBy, normalizePixivSearchType } from "../../utils/pixivIntent.js"

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
    this.name = PIXIV_SEARCH_TOOL_MANIFEST.name
    this.description = PIXIV_SEARCH_TOOL_MANIFEST.description
    this.skill = PIXIV_SEARCH_TOOL_MANIFEST.skill
    // 单一声明点:终态/触发词/披露规则等全部由 manifest 派生(LocalToolRegistry 注册)
    this.manifest = PIXIV_SEARCH_TOOL_MANIFEST
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
