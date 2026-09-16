// 锅巴支持：独立骰子插件的配置页。
// schema 与读写直接复用 bl-chat-plugin（同一份 message.yaml，单数据源，不会漂移）。
import diceSchema from "../bl-chat-plugin/models/Guoba/schemas/dice.js"
import { getConfigData, setConfigData } from "../bl-chat-plugin/models/Guoba/schemas/index.js"

export function supportGuoba() {
  return {
    pluginInfo: {
      name: "bl-dice-plugin",
      title: "骰子（独立版）",
      author: ["shiqi"],
      version: "1.0.0",
      description: "COC/DND 骰娘 + 自定义规则包 + 海豹扩展兼容 + 牌堆（从 bl-chat-plugin 物理拆分）",
      icon: "ph:dice-five-bold"
    },
    configInfo: {
      schemas: diceSchema,
      getConfigData,
      setConfigData
    }
  }
}
