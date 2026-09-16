import fs from "fs"
import path from "path"
import yaml from "js-yaml"
import {
  buildObjectValueReportData,
  buildPlaceProfitReportData,
  buildPriceHistoryReportData,
  buildProfitRankReportData,
  buildSolutionListReportData,
  DeltaForceClient,
  formatPlaceProfitResponse,
  formatDailyKeywordResponse,
  formatObjectValueSearchResponse,
  formatPriceHistoryResponse,
  formatProfitRankResponse,
  formatSolutionListResponse,
  getDeltaForceHelp,
  getDeltaForcePlaceHelp,
  normalizeHistoryDays,
  normalizeDeltaForcePlace,
  normalizeRankLimit
} from "./DeltaForceClient.js"
import { DeltaForceObjectCache } from "./DeltaForceObjectCache.js"
import { renderDeltaForceReport } from "./DeltaForceReportRenderer.js"
import { buildVisibleFailureDetail } from "../../../utils/visibleFailure.js"

const _path = process.cwd()
let objectCache = null

function readPluginSettings() {
  const userConfigPath = path.join(_path, "plugins/bl-chat-plugin/config/message.yaml")
  const defaultConfigPath = path.join(_path, "plugins/bl-chat-plugin/config_default/message.yaml")
  const configPath = fs.existsSync(userConfigPath) ? userConfigPath : defaultConfigPath
  if (!fs.existsSync(configPath)) return {}
  return yaml.load(fs.readFileSync(configPath, "utf8"))?.pluginSettings || {}
}

async function getObjectCache(settings, { force = false } = {}) {
  const client = new DeltaForceClient(settings)
  if (!client.config.objectCacheEnabled) return null

  if (!objectCache) objectCache = new DeltaForceObjectCache()
  objectCache.startAutoRefresh(client, client.config.objectCacheRefreshMinutes)

  try {
    await objectCache.refresh(client, { force })
  } catch (err) {
    globalThis.logger?.warn?.(`[三角洲物品缓存] 更新失败: ${err.message}`)
  }

  return objectCache
}

async function replyDeltaForceReport(e, report, fallbackText) {
  try {
    const image = await renderDeltaForceReport(e, report)
    if (image) {
      await e.reply(image)
      return
    }
  } catch (err) {
    globalThis.logger?.warn?.(`[三角洲行动工具] 图片渲染失败: ${err.message}`)
  }
  await e.reply(fallbackText)
}

export class DeltaForcePlugin extends plugin {
  constructor() {
    super({
      name: "三角洲行动工具",
      dsc: "三角洲行动第三方 API 工具",
      event: "message",
      priority: 500,
      rule: [
        { reg: "^[.。]三角洲\\s*$", fnc: "showHelp" },
        { reg: "^[.。]三角洲\\s*(今日密码|每日密码|密码)\\s*$", fnc: "dailyKeyword" },
        { reg: "^[.。]三角洲\\s*(物品价值|价值搜索|查价值)\\s+[\\s\\S]+$", fnc: "objectValueSearch" },
        { reg: "^[.。]三角洲\\s*(价格历史|价格走势|历史价格|价格曲线|折线图)\\s+[\\s\\S]+$", fnc: "priceHistory" },
        { reg: "^[.。]三角洲\\s*(改枪码|改枪方案|方案码)([\\s\\S]*)$", fnc: "solutionList" },
        { reg: "^[.。]三角洲\\s*(特勤处利润|制造利润)(\\s+\\S+)?\\s*$", fnc: "placeProfit" },
        { reg: "^[.。]三角洲\\s*(利润排行)([\\s\\S]*)$", fnc: "profitRank" }
      ]
    })

    this.bootstrapObjectCache()
  }

  bootstrapObjectCache() {
    const timer = setTimeout(async () => {
      try {
        const settings = readPluginSettings()
        if (settings.deltaForceSystem?.enabled !== true) return
        await getObjectCache(settings)
      } catch (err) {
        globalThis.logger?.warn?.(`[三角洲物品缓存] 启动初始化失败: ${err.message}`)
      }
    }, 3000)
    timer.unref?.()
  }

  async showHelp(e) {
    await e.reply(getDeltaForceHelp())
    return true
  }

  async dailyKeyword(e) {
    try {
      const client = new DeltaForceClient(readPluginSettings())
      const result = await client.getDailyKeyword()
      await e.reply(formatDailyKeywordResponse(result))
    } catch (err) {
      globalThis.logger?.warn?.(`[三角洲行动工具] 今日密码查询失败: ${err.message}`)
      await e.reply(`三角洲今日密码查询失败：${buildVisibleFailureDetail(err)}`)
    }
    return true
  }

  async objectValueSearch(e) {
    try {
      const rawArgs = e.msg.replace(/^[.。]三角洲\s*(物品价值|价值搜索|查价值)\s*/, "").trim()
      const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : []
      let limit = 10
      if (args.length > 1 && /^\d+$/.test(args[args.length - 1])) {
        limit = normalizeRankLimit(args.pop())
      }
      const keyword = args.join(" ").trim()
      if (!keyword) {
        await e.reply("请提供要搜索的物品名称或 ID，例如：.三角洲 物品价值 H70")
        return true
      }

      const client = new DeltaForceClient(readPluginSettings())
      const result = await client.searchObjectValue({ keyword, limit })
      await replyDeltaForceReport(
        e,
        buildObjectValueReportData(result, { keyword, limit }),
        formatObjectValueSearchResponse(result, { keyword, limit })
      )
    } catch (err) {
      globalThis.logger?.warn?.(`[三角洲行动工具] 物品价值搜索失败: ${err.message}`)
      await e.reply(`三角洲物品价值搜索失败：${buildVisibleFailureDetail(err)}`)
    }
    return true
  }

  async priceHistory(e) {
    try {
      const rawArgs = e.msg.replace(/^[.。]三角洲\s*(价格历史|价格走势|历史价格|价格曲线|折线图)\s*/, "").trim()
      const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : []
      let days = 30
      let limit = 5
      const numbers = []
      while (args.length && /^\d+$/.test(args[args.length - 1])) {
        numbers.unshift(Number(args.pop()))
      }
      if (numbers.length === 1) days = normalizeHistoryDays(numbers[0])
      if (numbers.length >= 2) {
        days = normalizeHistoryDays(numbers[0])
        limit = normalizeRankLimit(numbers[1], 5)
      }
      const keyword = args.join(" ").trim()
      if (!keyword) {
        await e.reply("请提供要搜索的物品名称或 ID，例如：.三角洲 价格历史 显卡")
        return true
      }

      const client = new DeltaForceClient(readPluginSettings())
      const result = await client.searchPriceHistory({ keyword, days, limit })
      await replyDeltaForceReport(
        e,
        buildPriceHistoryReportData(result, { keyword, days, limit }),
        formatPriceHistoryResponse(result, { keyword, days, limit })
      )
    } catch (err) {
      globalThis.logger?.warn?.(`[三角洲行动工具] 价格历史查询失败: ${err.message}`)
      await e.reply(`三角洲价格历史查询失败：${buildVisibleFailureDetail(err)}`)
    }
    return true
  }

  async solutionList(e) {
    try {
      const rawArgs = e.msg.replace(/^[.。]三角洲\s*(改枪码|改枪方案|方案码)\s*/, "").trim()
      const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : []
      let limit = 10
      if (args.length && /^\d+$/.test(args[args.length - 1])) {
        limit = normalizeRankLimit(args.pop())
      }
      const keyword = args.join(" ").trim()

      const client = new DeltaForceClient(readPluginSettings())
      const result = await client.getSolutionList({ keyword, limit })
      await replyDeltaForceReport(
        e,
        buildSolutionListReportData(result, { keyword, limit }),
        formatSolutionListResponse(result, { keyword, limit })
      )
    } catch (err) {
      globalThis.logger?.warn?.(`[三角洲行动工具] 改枪码查询失败: ${err.message}`)
      await e.reply(`三角洲改枪码查询失败：${buildVisibleFailureDetail(err)}`)
    }
    return true
  }


  async placeProfit(e) {
    try {
      const rawArgs = e.msg.replace(/^[.。]三角洲\s*(特勤处利润|制造利润)\s*/, "").trim()
      const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : []
      let place = null
      let limit = 10

      for (const arg of args) {
        if (/^\d+$/.test(arg)) {
          limit = normalizeRankLimit(arg)
          continue
        }

        const parsedPlace = normalizeDeltaForcePlace(arg)
        if (!parsedPlace) {
          await e.reply(`制作场所不支持「${arg}」\n${getDeltaForcePlaceHelp()}`)
          return true
        }
        place = parsedPlace
      }

      const settings = readPluginSettings()
      const client = new DeltaForceClient(settings)
      const cache = await getObjectCache(settings)
      const result = await client.getPlaceProfit()
      const options = {
        placeType: place?.type || "",
        limit,
        objectNameResolver: cache
      }
      await replyDeltaForceReport(
        e,
        buildPlaceProfitReportData(result, options),
        formatPlaceProfitResponse(result, options)
      )
    } catch (err) {
      globalThis.logger?.warn?.(`[三角洲行动工具] 特勤处利润查询失败: ${err.message}`)
      await e.reply(`三角洲特勤处利润查询失败：${buildVisibleFailureDetail(err)}`)
    }
    return true
  }

  async profitRank(e) {
    try {
      const rawArgs = e.msg.replace(/^[.。]三角洲\s*利润排行\s*/, "").trim()
      const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : []
      let place = null
      let limit = 10

      for (const arg of args) {
        if (/^\d+$/.test(arg)) {
          limit = normalizeRankLimit(arg)
          continue
        }

        const parsedPlace = normalizeDeltaForcePlace(arg)
        if (!parsedPlace) {
          await e.reply(`制作场所不支持「${arg}」\n${getDeltaForcePlaceHelp()}`)
          return true
        }
        place = parsedPlace
      }

      const settings = readPluginSettings()
      const client = new DeltaForceClient(settings)
      const cache = await getObjectCache(settings)
      const result = await client.getPlaceProfitRank({ placeType: place?.type || "", limit })
      const options = {
        placeType: place?.type || "",
        limit,
        objectNameResolver: cache
      }
      await replyDeltaForceReport(
        e,
        buildProfitRankReportData(result, options),
        formatProfitRankResponse(result, options)
      )
    } catch (err) {
      globalThis.logger?.warn?.(`[三角洲行动工具] 利润排行查询失败: ${err.message}`)
      await e.reply(`三角洲利润排行查询失败：${buildVisibleFailureDetail(err)}`)
    }
    return true
  }
}
