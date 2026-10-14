import fs from 'node:fs';import path from 'node:path';import YAML from 'yaml';
import {AbstractTool} from './AbstractTool.js';
import type {PixivSession,PixivCard} from '../../../contracts/pixiv.js';
import {pixivRecord as record,pixivText as text} from '../../../contracts/pixiv.js';
import {parseDrawEvent} from './bananaDecoders.js';
import type {createPixivSearch} from '../../media/infrastructure/pixivSearch.js';
import {enrichPixivShare} from '../../media/infrastructure/pixivMessage.js';
import {buildPixivArchiveRelaySegments,cleanupPixivArchiveRelayFiles} from '../../media/infrastructure/pixivMediaRelay.js';
import {PIXIV_SEARCH_TOOL_MANIFEST,PIXIV_DOWNLOAD_TOOL_MANIFEST,normalizePixivKeyword,normalizePixivOrderBy,normalizePixivSearchType} from '../../media/domain/pixivIntent.js';
function findConfigPath() {
  const cwd = process.cwd()
  const candidates = [
    path.join(cwd, "plugins", "shiloh-plugin", "config", "message.yaml"),
    path.join(cwd, "config", "message.yaml")
  ]
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0] || ""
}

function readPixivRelayConfig() {
  try {
    const document = record(YAML.parse(fs.readFileSync(findConfigPath(), "utf8")))
    const relay = record(record(document.pluginSettings).pixivRelay)
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

export function createPixivSearchTool(ports:{search:ReturnType<typeof createPixivSearch>;image(path:string):unknown}){
const {listPixivArtistRecentWorks,renderPixivListCard,cleanupPixivListCard,resolvePixivArtistFromItems,savePixivSearchSession,searchPixivArtworks,loadPixivSearchSession,resolvePixivDownloadTarget,touchPixivSearchSession}=ports.search;
class PixivSearchTool extends AbstractTool {
manifest:typeof PIXIV_SEARCH_TOOL_MANIFEST;
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
  normalizeParameters(params:unknown) {
    const next = { ...record(params) }
    if (next.keyword != null) next.keyword = normalizePixivKeyword(next.keyword)
    if (next.searchType != null) next.searchType = normalizePixivSearchType(next.searchType)
    if (next.orderBy != null) next.orderBy = normalizePixivOrderBy(next.orderBy)
    return next
  }

  async func(opts:Record<string,unknown>, event:unknown) {
    const e=parseDrawEvent(event);
    const keyword=text(opts.keyword),searchType=text(opts.searchType),orderBy=text(opts.orderBy)
    const config = readPixivRelayConfig()
    if (!config.enabled) return "error: Pixiv 功能当前已在配置中关闭"

    const order = ["newest", "oldest", "popular"].includes(orderBy) ? orderBy : "newest"
    let session:PixivSession
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
      return `error: Pixiv 搜索失败: ${String(error instanceof Error?error.message:error).slice(0, 160)}`
    }

    await savePixivSearchSession(e, session)

    let card:{imagePath:string;tempFiles:string[]} = { imagePath: "", tempFiles: [] }
    let delivered=false;
    try {
      card = await renderPixivListCard(session, { proxyUrl: config.proxyUrl })
      if (card.imagePath && typeof e?.reply === "function") {
        await e.reply(ports.image(card.imagePath));delivered=true
      }
    } finally {
      await cleanupPixivListCard(card.tempFiles)
      if (card.imagePath) await fs.promises.unlink(card.imagePath).catch(() => {})
    }

    const listing = session.items.slice(0, 8).map((item, index) =>
      `${index + 1}. ${item.title} / ${item.userName}${item.pageCount > 1 ? `(${item.pageCount}张)` : ""} [${item.id}]${item.xRestrict > 0 ? "(R-18)" : ""}`
    ).join("\n")
    const head = session.mode === "artist"
      ? `已找到画师 ${session.artist?.userName} 的最近 ${session.items.length} 张作品`
      : `「${keyword}」共 ${session.total} 个结果,已展示前 ${Math.min(8, session.items.length)} 个`
    return `${head},${delivered?"列表卡面已提交发送":"卡面生成失败，以下为文字列表"}。引导用户:回复「下载 序号」(如 下载 1)或「下载 作品ID」即可搬运对应作品;R-18 作品默认不提供下载。\n${listing}`
  }
}

return PixivSearchTool;
}
