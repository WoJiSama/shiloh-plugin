// 锅巴支持：独立骰子插件的配置页。
// schema 与读写直接复用 shiloh-plugin（同一份 message.yaml，单数据源，不会漂移）。
import diceSchema from "../shiloh-plugin/models/Guoba/schemas/dice.js"
import { getConfigData, setConfigData } from "../shiloh-plugin/models/Guoba/schemas/index.js"

export function supportGuoba() {
  return {
    pluginInfo: {
      name: "bl-dice-plugin",
      title: "骰子（独立版）",
      author: ["shiqi"],
      version: "1.0.0",
      description: "COC/DND 骰娘 + 自定义规则包 + 海豹扩展兼容 + 牌堆（从 shiloh-plugin 物理拆分）",
      icon: "ph:dice-five-bold"
    },
    configInfo: {
      schemas: diceSchema,
      getConfigData,
      setConfigData
    }
  }
}
