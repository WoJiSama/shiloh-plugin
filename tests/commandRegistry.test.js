import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("命令总表加载并覆盖核心模块", async () => {
  const { getCommandRegistry } = await import("../utils/commandRegistry.js")
  const registry = getCommandRegistry(pluginRoot, { force: true })
  assert.ok(!registry.loadError, `yaml 解析失败: ${registry.loadError}`)
  assert.ok(registry.commandCount >= 70, `命令数量异常: ${registry.commandCount}`)
  const keys = registry.domains.map(domain => domain.key)
  for (const expected of ["memory", "tools", "dice", "deltaforce", "uma", "emoji", "chatlog", "knowledge", "system"]) {
    assert.ok(keys.includes(expected), `缺少模块 ${expected}`)
  }
})

test("帮助菜单与分模块渲染", async () => {
  const { getCommandRegistry, findCommandDomain, renderHelpMenu, renderDomainHelp } = await import("../utils/commandRegistry.js")
  const registry = getCommandRegistry(pluginRoot)
  const menu = renderHelpMenu(registry)
  assert.match(menu, /命令总表/)
  assert.match(menu, /\.命令 /)

  const memory = findCommandDomain(registry, "memory")
  assert.ok(memory)
  const memoryHelp = renderDomainHelp(memory)
  assert.match(memoryHelp, /记忆与表达/)
  assert.match(memoryHelp, /#记忆状态/)

  assert.equal(findCommandDomain(registry, "不存在模块xyz"), null)
})

test("markdown 快照生成", async () => {
  const { getCommandRegistry, renderCommandsMarkdown } = await import("../utils/commandRegistry.js")
  const registry = getCommandRegistry(pluginRoot)
  const markdown = renderCommandsMarkdown(registry)
  assert.match(markdown, /# 命令总表/)
  assert.match(markdown, /## 🧠 记忆与表达/)
  assert.match(markdown, /\| `\.命令 \[域名\] \/ \.帮助`/)
})

test("骰娘命令总表覆盖 log 家族与常用命令", async () => {
  const { getCommandRegistry } = await import("../utils/commandRegistry.js")
  const registry = getCommandRegistry(pluginRoot)
  const usages = new Set(registry.domains.flatMap(domain => domain.commands.map(command => command.usage)))
  // .log 命令曾整族缺失：开启提示让用户发 .log off，命令管理页里却查不到
  for (const required of [
    ".log on <团名>",
    ".log off [团名]",
    ".log end [团名]",
    ".log export",
    ".log [status]",
    ".r <表达式>",
    ".ri <表达式> / .init <list|clear>"
  ]) {
    assert.ok(usages.has(required), `命令总表缺少：${required}`)
  }
})
