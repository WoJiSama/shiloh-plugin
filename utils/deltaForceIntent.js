// DeltaForce(三角洲行动)自然语言意图解析:从 apps/test.js 原样迁出的纯函数簇。
// 唯一改动:原实现直接读全局 Bot.nickname,迁出后改为参数注入(默认仍读全局,行为不变)。
import { normalizeIntentText } from "../core/intent/messageIntent.js"
import { removeBotAnchors } from "./messageContext.js"

function cleanDeltaForceKeyword(text = "", operation = "", botName = "") {
  let value = removeBotAnchors(text, botName, [])
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/[.。]?\s*三角洲(?:行动)?/g, " ")
    .replace(/(?:帮我|给我|替我|麻烦|可以|能不能|能|发一下|发下|看一下|看下|查一下|查下|查查|搜一下|搜下|找一下|找下|我要|想要|要|一下|今天的?|今日|每日|最新|有关的?|相关的?|相关|关于|和|跟|与|告诉我|跟我说|说下|说一下|说说|请问|问下|问一下|看看|里面|里头|有哪些|有什么|哪几个|怎么样|咋样|的)/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (operation === "solution_list") {
    value = value.replace(/(?:改枪码|改枪方案|方案码|枪码|改枪|方案)/g, " ")
  } else if (operation === "object_value") {
    value = value.replace(/(?:物品价值|价值搜索|查价值|价格走向|价格走势|走势|走向|趋势|行情|涨跌|波动|变化|价格|价值|多少钱|卖多少|值多少)/g, " ")
  } else if (operation === "price_history") {
    value = value.replace(/(?:价格走向|价格走势|价格历史|历史价格|走势|走向|趋势图|趋势|行情|价格曲线|折线图|价格|历史|最近|近\s*\d{1,2}\s*天|这\s*\d{1,2}\s*天)/g, " ")
  } else {
    value = value.replace(/(?:特勤处利润|制造利润|利润排行|利润榜|排行|今日密码|每日密码|密码|口令)/g, " ")
  }

  return value
    .replace(/[，,。.!！?？:：;；~～]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function extractDeltaForceKeyword(text = "", operation = "", botName = "") {
  const content = normalizeIntentText(text)
  const relationPatterns = [
    /(?:名字|名称|物品名|道具名)(?:里|中)?(?:有|包含|含有|带有|带)\s*([A-Za-z0-9_\-.\u4e00-\u9fa5·•]{1,40})/,
    /(?:和|跟|与|关于|有关|相关|包含|带|搜|查|找)\s*([A-Za-z0-9_\-.\u4e00-\u9fa5·•]{1,40})\s*(?:有关|相关|的)?/,
    /([A-Za-z0-9_\-.\u4e00-\u9fa5·•]{1,40})\s*(?:有关|相关)/
  ]
  for (const pattern of relationPatterns) {
    const match = content.match(pattern)
    const keyword = cleanDeltaForceKeyword(match?.[1] || "", operation, botName)
    if (keyword) return keyword
  }

  const cleaned = cleanDeltaForceKeyword(content, operation, botName)
  const tokens = cleaned.split(/\s+/).filter(Boolean)
  return tokens.length ? tokens.join(" ") : ""
}

export function resolveNaturalDeltaForceToolCall(text = "", { botName = globalThis.Bot?.nickname || "" } = {}) {
  const content = normalizeIntentText(text)
  if (!content.includes("三角洲")) return null

  let operation = ""
  if (/(改枪码|改枪方案|方案码|枪码|改枪|方案)/.test(content)) {
    operation = "solution_list"
  } else if (/(价格历史|历史价格|价格走势|价格走向|价格趋势|走势|走向|价格曲线|折线图|趋势图)/.test(content)) {
    operation = "price_history"
  } else if (/(物品价值|价值搜索|查价值|价格|多少钱|卖多少|值多少)/.test(content)) {
    operation = "object_value"
  } else if (/(利润排行|利润榜|收益排行|赚钱排行)/.test(content)) {
    operation = "profit_rank"
  } else if (/(特勤处利润|制造利润|制造收益|特勤处收益)/.test(content)) {
    operation = "place_profit"
  } else if (/(今日密码|每日密码|今天.*密码|密码|口令)/.test(content)) {
    operation = "daily_keyword"
  } else if (/帮助|菜单|怎么用|指令/.test(content)) {
    operation = "help"
  }
  if (!operation) return null

  const params = { operation, prompt: text }
  if (operation === "solution_list" || operation === "object_value" || operation === "price_history") {
    const keyword = extractDeltaForceKeyword(content, operation, botName)
    if (keyword) params.keyword = keyword
  }
  if (operation === "place_profit" || operation === "profit_rank") {
    const place = ["工作台", "技术中心", "制药台", "防具台"].find(name => content.includes(name))
    if (place) params.place = place
  }
  const limitMatch = content.match(/(?:前|top\s*)?(\d{1,2})\s*(?:条|个|名|项)?/i)
  if (limitMatch && !params.keyword) params.limit = Number(limitMatch[1])
  if (operation === "price_history") {
    const daysMatch = content.match(/(\d{1,2})\s*天/)
    if (daysMatch) params.days = Number(daysMatch[1])
    const countMatch = content.match(/(?:前|top\s*)?(\d{1,2})\s*(?:个|件|项|张图)/i)
    if (countMatch) params.limit = Number(countMatch[1])
  }

  return {
    toolName: "deltaForceTool",
    params
  }
}
