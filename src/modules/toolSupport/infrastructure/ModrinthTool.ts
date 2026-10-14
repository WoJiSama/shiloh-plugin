import {pixivRecord as record,pixivText as text} from '../../../contracts/pixiv.js';
import type {ModrinthClientOptions} from '../../media/infrastructure/modrinth.js';
import { AbstractTool } from "./AbstractTool.js"
import { buildModrinthRankingData, ModrinthClient, normalizeModrinthRankOptions, parseModrinthRequestOptions } from "../../media/infrastructure/modrinth.js"

export class ModrinthTool extends AbstractTool {
client:{search(options:Record<string,unknown>):Promise<unknown>};
  constructor(options:ModrinthClientOptions & {client?:{search(options:Record<string,unknown>):Promise<unknown>}} = {}) {
    super()
    this.name = "modrinthTool"
    this.client = options.client || new ModrinthClient(options)
    this.description = [
      "查询 Modrinth 的 Minecraft 模组公开排名。",
      "用户询问 Modrinth、MC 模组榜、热门模组、下载量前几、指定 Minecraft 版本或 Fabric/Forge/NeoForge/Quilt 的模组排名时调用。",
      "只查询公开 API；可按历史下载量、关注数、最新发布、最近更新或关键词相关度排序。",
      "结果含英文原始简介、图标、支持版本、客户端/服务端侧、创建/更新时间与许可证。最终回复默认以一条合并转发发送，每个模组各占一个独立 HTML 卡面节点；项目页 URL 固定放在卡面外的同一节点文本中，禁止追加总评或追问。中文只能忠实翻译原文，不能伪造成官网中文或补出未经查询的兼容性结论。",
      "默认最多 5 条，最多 10 条；只给项目页，不下载或发送模组 jar 文件。"
    ].join("\n")
    this.parameters = {
      type: "object",
      properties: {
        sort: {
          type: "string",
          enum: ["downloads", "follows", "newest", "updated", "relevance"],
          description: "排名方式：downloads 历史下载量（默认）；follows 关注数；newest 最新发布；updated 最近更新；relevance 与关键词相关。"
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 10,
          description: "返回前几名，默认 5，最多 10。"
        },
        gameVersion: {
          type: "string",
          description: "可选 Minecraft 版本，例如 1.21.1、1.20.1。"
        },
        loader: {
          type: "string",
          enum: ["fabric", "forge", "neoforge", "quilt"],
          description: "可选加载器。用户未指定时不要填写。"
        },
        category: {
          type: "string",
          description: "可选 Modrinth 分类 slug，例如 optimization、adventure、decoration、technology。"
        },
        query: {
          type: "string",
          description: "可选搜索关键词，例如 performance、地图、机械；用户只问总榜时留空。"
        }
      },
      required: [],
      additionalProperties: false
    }
    this.skill = {
      name: this.name,
      purpose: "查询 Modrinth 公开 Minecraft 模组列表、榜单和筛选结果。",
      whenToUse: "用户询问 Modrinth、MC 模组、下载/关注排行、最近发布或更新、版本、加载器、分类时使用。",
      boundaries: "只返回 Modrinth 公开资料和项目页，不下载 jar；不能从结果推断未返回的兼容性结论。",
      instructions: "先以用户原话识别排序、数量、MC 版本、加载器和分类；排序只用 downloads/follows/newest/updated/relevance。",
      examples: [
        "最近更新的魔法模组前五 -> sort=updated, category=magic, limit=5",
        "1.21.1 Fabric 下载量前十 -> sort=downloads, gameVersion=1.21.1, loader=fabric, limit=10"
      ]
    }
  }

  normalizeParameters(params:unknown = {}, context:{event?:unknown;userText?:string;currentIntentText?:string} = {}) {
    const fromUserText = parseModrinthRequestOptions(
      context?.userText || context?.currentIntentText || text(record(context.event).msg) || ""
    )
    return normalizeModrinthRankOptions(fromUserText || record(params))
  }

  async func(options:Record<string,unknown> = {}) {
    const normalized = normalizeModrinthRankOptions(options)
    const payload = await this.client.search(normalized)
    return buildModrinthRankingData(payload, normalized)
  }
}
