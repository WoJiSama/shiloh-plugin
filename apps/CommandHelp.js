import path from "path"
import {
  getCommandRegistry,
  findCommandDomain,
  renderHelpMenu,
  renderDomainHelp,
  writeCommandsMarkdown
} from "../utils/commandRegistry.js"
import { registerCommandsWebApp } from "../utils/commandsWebApp.js"
import { getShadowStats } from "../core/intent/modelIntentClassifier.js"

const _path = process.cwd()

export class CommandHelp extends plugin {
  constructor() {
    super({
      name: "bl-chat-plugin命令总表",
      dsc: ".命令 / .帮助 查看全部命令；.命令 <模块> 看分模块；.命令 导出 生成文档；网页管理页同步挂载",
      event: "message",
      priority: 500,
      rule: [
        { reg: "^[.。#]命令导出$", fnc: "exportDoc", permission: "master" },
        { reg: "^[.。#]命令\\s+导出$", fnc: "exportDoc", permission: "master" },
        { reg: "^[.。#]意图影子(\\s+统计)?$", fnc: "showShadowStats", permission: "master" },
        { reg: "^[.。#]命令\\s+([A-Za-z\\u4e00-\\u9fa5]+)\\s*$", fnc: "showDomain" },
        { reg: "^[.。#](命令|命令列表|命令帮助)\\s*$", fnc: "showMenu" },
        { reg: "^[.。#]帮助\\s*$", fnc: "showMenu" }
      ]
    })
    this.pluginRoot = path.join(_path, "plugins/bl-chat-plugin")
    try {
      registerCommandsWebApp(this.pluginRoot)
    } catch (error) {
      globalThis.logger?.warn?.(`[命令管理页] 挂载失败：${error?.message || error}`)
    }
  }

  async showMenu(e) {
    const registry = getCommandRegistry(this.pluginRoot)
    await e.reply(renderHelpMenu(registry))
    return true
  }

  async showDomain(e) {
    const query = String(e.msg || "").replace(/^[.。#]命令\s*/, "").trim()
    const registry = getCommandRegistry(this.pluginRoot)
    const domain = findCommandDomain(registry, query)
    if (!domain) {
      await e.reply(`没有找到「${query}」模块。发送 .命令 查看全部模块。`)
      return true
    }
    await e.reply(renderDomainHelp(domain))
    return true
  }

  async exportDoc(e) {
    try {
      const registry = getCommandRegistry(this.pluginRoot, { force: true })
      const target = writeCommandsMarkdown(registry, this.pluginRoot)
      await e.reply(`命令文档已重新生成：${path.relative(this.pluginRoot, target)}（${registry.commandCount} 条）`)
    } catch (error) {
      await e.reply(`命令文档生成失败：${error?.message || error}`)
    }
    return true
  }

  async showShadowStats(e) {
    const stats = getShadowStats()
    if (!stats.total) {
      await e.reply("影子判定还没有数据（需要 toolsAiConfig 已配置且有消息经过意图路由）")
      return true
    }
    const lines = [
      `影子判定统计：样本 ${stats.total}，模型不可用 ${stats.unavailable}（${(stats.unavailable / stats.total * 100).toFixed(0)}%）`,
      `与正则路径一致率：${(stats.agreeRate * 100).toFixed(1)}%（含等价类合并）`,
      `模型意图分布：${Object.entries(stats.intentCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("、") || "无"}`,
      `分歧样本（最近 ${Math.min(5, stats.disagreementSamples.length)} 条 / 共 ${stats.disagreementSamples.length}）：`
    ]
    for (const sample of stats.disagreementSamples.slice(-5).reverse()) {
      lines.push(`[${sample.at}] regex=${sample.regex} → model=${sample.model} (${sample.confidence})「${sample.text}」`)
    }
    await e.reply(lines.join("\n"))
    return true
  }
}
