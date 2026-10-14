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
      allowRestricted: relay.allowRestricted === true,
      maxPages: Number(relay.maxPages) || 5
    }
  } catch {
    return { enabled: true, proxyUrl: "", allowRestricted: false, maxPages: 5 }
  }
}

export function createPixivDownloadTool(ports:{search:ReturnType<typeof createPixivSearch>;image(path:string):unknown}){
const {listPixivArtistRecentWorks,renderPixivListCard,cleanupPixivListCard,resolvePixivArtistFromItems,savePixivSearchSession,searchPixivArtworks,loadPixivSearchSession,resolvePixivDownloadTarget,touchPixivSearchSession}=ports.search;
class PixivDownloadTool extends AbstractTool {
manifest:typeof PIXIV_DOWNLOAD_TOOL_MANIFEST;
  constructor() {
    super()
    this.name = PIXIV_DOWNLOAD_TOOL_MANIFEST.name
    this.description = PIXIV_DOWNLOAD_TOOL_MANIFEST.description
    this.skill = PIXIV_DOWNLOAD_TOOL_MANIFEST.skill
    // 单一声明点:终态/触发词/确定性解析器全部由 manifest 派生
    this.manifest = PIXIV_DOWNLOAD_TOOL_MANIFEST
    this.parameters = {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "搜索列表里的序号(如 3)或作品ID(纯数字,如 126649495)"
        }
      },
      required: ["target"],
      additionalProperties: false
    }
  }

  async func(opts:Record<string,unknown>, event:unknown) {
    const e=parseDrawEvent(event);
    const config = readPixivRelayConfig()
    if (!config.enabled) return "error: Pixiv 功能当前已在配置中关闭"

    const session = await loadPixivSearchSession(e)
    const { id, item } = resolvePixivDownloadTarget(text(opts.target), session)
    if (!id) {
      return session
        ? "error: 没有在最近一次搜索列表里找到这个序号。序号范围是列表里的 1-8,也可以直接给作品ID(纯数字)。"
        : "error: 最近 5 分钟内没有 Pixiv 搜索记录。请先让我搜索(例如「查一下 wlop 的作品」),再回复 下载 序号。"
    }
    if ((item?.xRestrict || 0) > 0 && !config.allowRestricted) {
      return `error: 作品 ${id}(${item?.title})是 R-18/受限内容,当前配置默认不搬运。`
    }

    let card:PixivCard
    try {
      card = await enrichPixivShare(
        { type: "pixiv", platform: "pixiv", artwork_id: id, page_url: `https://www.pixiv.net/artworks/${id}`, metadata_status: "identified" },
        { proxyUrl: config.proxyUrl }
      )
    } catch (error) {
      return `error: Pixiv 作品详情获取失败: ${String(error instanceof Error?error.message:error).slice(0, 160)}`
    }
    if (card.metadata_status !== "resolved") {
      return `error: 作品 ${id} 详情暂时没有解析成功,可能已删除或非公开,稍后可以再试一次。`
    }
    if (Number(card.x_restrict || 0) > 0 && !config.allowRestricted) {
      return `error: 《${card.title}》是 R-18/受限内容,当前配置默认不搬运。`
    }

    let relay:Awaited<ReturnType<typeof buildPixivArchiveRelaySegments>> = { segments: [], tempFiles: [], artifactLeases: [] }
    try {
      relay = await buildPixivArchiveRelaySegments(card, {
        segmentApi: {
          image: (file:string) => ({ type: "image", file })
        },
        pixivRelay: { proxyUrl: config.proxyUrl, maxPages: config.maxPages, allowRestricted: config.allowRestricted }
      })
    } catch (error) {
      return `error: 作品图片下载失败: ${String(error instanceof Error?error.message:error).slice(0, 160)}`
    }

    let sentImages=false;
    try {
      const sendable = relay.segments.filter(segment => record(segment).type === "image" || (typeof segment === "string" && segment.trim()))
      if (sendable.length && typeof e?.reply === "function") {
        sentImages=sendable.some(segment=>record(segment).type==='image');
        await e.reply(sendable)
        // 下载成功后续期会话,5 分钟窗口从现在重新起算
        if(sentImages)await touchPixivSearchSession(e)
      }
    } finally {
      await cleanupPixivArchiveRelayFiles(relay.tempFiles)
    }

    const notice = relay.segments.filter(segment => typeof segment === "string" && segment.trim()).join(" ").trim()
    const summary = `《${card.title}》by ${card.author || item?.userName || "?"}${(card.page_count||0) > 1 ? `(${Math.min(card.page_count||0, config.maxPages)}张)` : ""} ${sentImages?"已提交发送":"未下载到可发送图片"}${notice ? `;${notice.replace(/[()]/g, "")}` : ""}`
    return summary
  }
}

return PixivDownloadTool;
}
