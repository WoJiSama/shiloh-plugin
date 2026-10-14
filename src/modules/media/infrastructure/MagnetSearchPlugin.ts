import type {MediaPluginConstructor,MediaCommandEvent} from '../../../contracts/mediaCards.js';
import {pixivRecord as record} from '../../../contracts/pixiv.js';
import fs from "fs"
import path from "path"
import yaml from "yaml"
import {
  MagnetSearchClient,
  buildMagnetSearchReportData,
  formatMagnetSearchResponse,
  getMagnetSearchHelp,
  normalizeSearchLimit
} from "./MagnetSearchClient.js"


export function createMagnetSearchPlugin(plugin:MediaPluginConstructor,ports:{renderMagnetSearchReport(e:MediaCommandEvent,report:ReturnType<typeof buildMagnetSearchReportData>):Promise<unknown>;logger:{warn(message:string):void}}){
const {renderMagnetSearchReport}=ports;
const _path = process.cwd()

function readPluginSettings() {
  const userConfigPath = path.join(_path, "plugins/shiloh-plugin/config/message.yaml")
  const defaultConfigPath = path.join(_path, "plugins/shiloh-plugin/config_default/message.yaml")
  const configPath = fs.existsSync(userConfigPath) ? userConfigPath : defaultConfigPath
  if (!fs.existsSync(configPath)) return {}
  return record(record(yaml.parse(fs.readFileSync(configPath, "utf8"))).pluginSettings)
}

async function replyMagnetSearchReport(e:MediaCommandEvent,report:ReturnType<typeof buildMagnetSearchReportData>,fallbackText:string){
 let image:unknown;try{image=await renderMagnetSearchReport(e,report)}catch(error){ports.logger.warn(`磁力搜索渲染失败: ${String(error)}`)}
 await e.reply(image||fallbackText);
}

class MagnetSearchPlugin extends plugin {
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

  async showHelp(e:MediaCommandEvent) {
    await e.reply(getMagnetSearchHelp())
    return true
  }

  async search(e:MediaCommandEvent) {
    let deliveryAttempted=false;
    try {
      const rawArgs = e.msg.replace(/^[.。](磁力搜索|磁链搜索|磁力)\s*/, "").trim()
      const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : []
      let limit = 10
      if (args.length > 1 && /^\d+$/.test(args[args.length - 1]||"")) {
        limit = normalizeSearchLimit(args.pop())
      }
      const keyword = args.join(" ").trim()
      if (!keyword) {
        await e.reply("请提供要搜索的关键词，例如：.磁力 ubuntu")
        return true
      }

      const client = new MagnetSearchClient(readPluginSettings())
      const result = await client.search({ keyword, limit })
      deliveryAttempted=true;
      await replyMagnetSearchReport(
        e,
        buildMagnetSearchReportData(result, { keyword, limit }),
        formatMagnetSearchResponse(result, { keyword, limit })
      )
    } catch (err) {
      ports.logger.warn(`[磁力搜索] 查询失败: ${err instanceof Error?err.message:String(err)}`)
      if(!deliveryAttempted)await e.reply(`磁力搜索失败：${err instanceof Error?err.message:String(err)}`)
    }
    return true
  }
}

return MagnetSearchPlugin;
}
