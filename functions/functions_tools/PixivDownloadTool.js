import fs from "node:fs"
import YAML from "yaml"
import path from "node:path"
import { AbstractTool } from "./AbstractTool.js"
import { enrichPixivShare } from "../../utils/pixivMessage.js"
import { buildPixivArchiveRelaySegments, cleanupPixivArchiveRelayFiles } from "../../utils/pixivMediaRelay.js"
import { loadPixivSearchSession, resolvePixivDownloadTarget, touchPixivSearchSession } from "../../utils/pixivSearch.js"
import { PIXIV_DOWNLOAD_TOOL_MANIFEST } from "../../utils/pixivIntent.js"

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
      allowRestricted: relay.allowRestricted === true,
      maxPages: Number(relay.maxPages) || 5
    }
  } catch {
    return { enabled: true, proxyUrl: "", allowRestricted: false, maxPages: 5 }
  }
}

export class PixivDownloadTool extends AbstractTool {
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

  async func(opts, e) {
    const config = readPixivRelayConfig()
    if (!config.enabled) return "error: Pixiv 功能当前已在配置中关闭"

    const session = await loadPixivSearchSession(e)
    const { id, item } = resolvePixivDownloadTarget(opts.target, session)
    if (!id) {
      return session
        ? "error: 没有在最近一次搜索列表里找到这个序号。序号范围是列表里的 1-8,也可以直接给作品ID(纯数字)。"
        : "error: 最近 5 分钟内没有 Pixiv 搜索记录。请先让我搜索(例如「查一下 wlop 的作品」),再回复 下载 序号。"
    }
    if (item?.xRestrict > 0 && !config.allowRestricted) {
      return `error: 作品 ${id}(${item.title})是 R-18/受限内容,当前配置默认不搬运。`
    }

    let card
    try {
      card = await enrichPixivShare(
        { type: "pixiv", platform: "pixiv", artwork_id: id, page_url: `https://www.pixiv.net/artworks/${id}`, metadata_status: "identified" },
        { proxyUrl: config.proxyUrl }
      )
    } catch (error) {
      return `error: Pixiv 作品详情获取失败: ${String(error?.message || error).slice(0, 160)}`
    }
    if (card.metadata_status !== "resolved") {
      return `error: 作品 ${id} 详情暂时没有解析成功,可能已删除或非公开,稍后可以再试一次。`
    }
    if (Number(card.x_restrict || 0) > 0 && !config.allowRestricted) {
      return `error: 《${card.title}》是 R-18/受限内容,当前配置默认不搬运。`
    }

    let relay = { segments: [], tempFiles: [], artifactLeases: [] }
    try {
      relay = await buildPixivArchiveRelaySegments(card, {
        segmentApi: {
          image: file => ({ type: "image", file }),
          video: file => ({ type: "video", file })
        },
        pixivRelay: { proxyUrl: config.proxyUrl, maxPages: config.maxPages, allowRestricted: config.allowRestricted }
      })
    } catch (error) {
      return `error: 作品图片下载失败: ${String(error?.message || error).slice(0, 160)}`
    }

    try {
      const sendable = relay.segments.filter(segment => segment?.type === "image" || (typeof segment === "string" && segment.trim()))
      if (sendable.length && typeof e?.reply === "function") {
        await e.reply(sendable)
        // 下载成功后续期会话,5 分钟窗口从现在重新起算
        await touchPixivSearchSession(e)
      }
    } finally {
      await cleanupPixivArchiveRelayFiles(relay.tempFiles)
    }

    const notice = relay.segments.filter(segment => typeof segment === "string" && segment.trim()).join(" ").trim()
    const summary = `《${card.title}》by ${card.author || item?.userName || "?"}${card.page_count > 1 ? `(${Math.min(card.page_count, config.maxPages)}张)` : ""} 已发送${notice ? `;${notice.replace(/[()]/g, "")}` : ""}`
    return summary
  }
}
