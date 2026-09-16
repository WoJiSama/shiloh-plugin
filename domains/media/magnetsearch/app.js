import fs from "fs"
import path from "path"
import yaml from "js-yaml"
import {
  MagnetSearchClient,
  buildMagnetSearchReportData,
  formatMagnetSearchResponse,
  getMagnetSearchHelp,
  normalizeSearchLimit
} from "./MagnetSearchClient.js"
import { renderMagnetSearchReport } from "./MagnetSearchReportRenderer.js"

const _path = process.cwd()

function readPluginSettings() {
  const userConfigPath = path.join(_path, "plugins/bl-chat-plugin/config/message.yaml")
  const defaultConfigPath = path.join(_path, "plugins/bl-chat-plugin/config_default/message.yaml")
  const configPath = fs.existsSync(userConfigPath) ? userConfigPath : defaultConfigPath
  if (!fs.existsSync(configPath)) return {}
  return yaml.load(fs.readFileSync(configPath, "utf8"))?.pluginSettings || {}
}

async function replyMagnetSearchReport(e, report, fallbackText) {
  try {
    const image = await renderMagnetSearchReport(e, report)
    if (image) {
      await e.reply(image)
      return
    }
  } catch (err) {
    globalThis.logger?.warn?.(`[磁力搜索] 图片渲染失败: ${err.message}`)
  }
  await e.reply(fallbackText)
}

export class MagnetSearchPlugin extends plugin {
  constructor() {
    super({
      name: "磁力搜索",
      dsc: "公开索引磁力搜索，只返回清单不自动下载",
      event: "message",
      priority: 500,
      rule: [
        { reg: "^[.。](磁力|磁力搜索|磁链搜索)\\s*$", fnc: "showHelp" },
        { reg: "^[.。](磁力|磁力搜索|磁链搜索)\\s+[\\s\\S]+$", fnc: "search" }
      ]
    })
  }

  async showHelp(e) {
    await e.reply(getMagnetSearchHelp())
    return true
  }

  async search(e) {
    try {
      const rawArgs = e.msg.replace(/^[.。](磁力搜索|磁链搜索|磁力)\s*/, "").trim()
      const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : []
      let limit = 10
      if (args.length > 1 && /^\d+$/.test(args[args.length - 1])) {
        limit = normalizeSearchLimit(args.pop())
      }
      const keyword = args.join(" ").trim()
      if (!keyword) {
        await e.reply("请提供要搜索的关键词，例如：.磁力 ubuntu")
        return true
      }

      const client = new MagnetSearchClient(readPluginSettings())
      const result = await client.search({ keyword, limit })
      await replyMagnetSearchReport(
        e,
        buildMagnetSearchReportData(result, { keyword, limit }),
        formatMagnetSearchResponse(result, { keyword, limit })
      )
    } catch (err) {
      globalThis.logger?.warn?.(`[磁力搜索] 查询失败: ${err.message}`)
      await e.reply(`磁力搜索失败：${err.message}`)
    }
    return true
  }
}
