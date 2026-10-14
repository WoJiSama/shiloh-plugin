import {hostError} from './hostMessageTypes.js'
import type {HostPluginBase,HostEvent,HostLogger} from './hostMessageTypes.js'
import path from "path"
import {
  getCommandRegistry,
  findCommandDomain,
  renderHelpMenu,
  renderDomainHelp,
  writeCommandsMarkdown
} from "../../platform/infrastructure/commandRegistry.js"

import { guardCommand } from "../../platform/infrastructure/commandGate.js"

const _path = process.cwd()

export function createCommandHelp(Plugin:HostPluginBase,ports:{registerCommandsWebApp(root:string):unknown;logger?:HostLogger}) {
const {registerCommandsWebApp}=ports
return class CommandHelp extends Plugin {
  pluginRoot:string
  constructor() {
    super({
      name: "shiloh-plugin命令总表",
      dsc: ".命令 / .帮助 查看全部命令；.命令 <模块> 看分模块；.命令 导出 生成文档；网页管理页同步挂载",
      event: "message",
      priority: 500,
      rule: [
        { reg: "^[.。#]命令导出$", fnc: "exportDoc", permission: "master" },
        { reg: "^[.。#]命令\\s+导出$", fnc: "exportDoc", permission: "master" },
        { reg: "^[.。#]命令\\s+([A-Za-z\\u4e00-\\u9fa5]+)\\s*$", fnc: "showDomain" },
        { reg: "^[.。#](命令|命令列表|命令帮助)\\s*$", fnc: "showMenu" },
        { reg: "^[.。#]帮助\\s*$", fnc: "showMenu" }
      ]
    })
    this.pluginRoot = path.join(_path, "plugins/shiloh-plugin")
    try {
      registerCommandsWebApp(this.pluginRoot)
    } catch (error) {
      ports.logger?.warn?.(`[命令管理页] 挂载失败：${hostError(error)}`)
    }
  }

  async showMenu(e:HostEvent) {
    const gate = guardCommand(e, { perm: "all", scope: "both" }, { pluginRoot: this.pluginRoot })
    if (!gate.proceed) return gate.consume
    const registry = getCommandRegistry(this.pluginRoot)
    await e.reply(renderHelpMenu(registry))
    return true
  }

  async showDomain(e:HostEvent) {
    const gate = guardCommand(e, { perm: "all", scope: "both" }, { pluginRoot: this.pluginRoot })
    if (!gate.proceed) return gate.consume
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

  async exportDoc(e:HostEvent) {
    const gate = guardCommand(e, { perm: "master", scope: "both" }, { pluginRoot: this.pluginRoot })
    if (!gate.proceed) return gate.consume
    try {
      const registry = getCommandRegistry(this.pluginRoot, { force: true })
      const target = writeCommandsMarkdown(registry, this.pluginRoot)
      await e.reply(`命令文档已重新生成：${path.relative(this.pluginRoot, target)}（${registry.commandCount} 条）`)
    } catch (error) {
      await e.reply(`命令文档生成失败：${hostError(error)}`)
    }
    return true
  }

}

}
