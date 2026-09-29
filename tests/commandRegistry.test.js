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
    ".log export [序号|团名] [html]",
    ".log list",
    ".log [status]",
    ".r <表达式>",
    ".ri <表达式> / .init <list|next|clear>",
    ".obon / .oboff / .ob list",
    ".name [zh|en|jp] [数量]"
  ]) {
    assert.ok(usages.has(required), `命令总表缺少：${required}`)
  }
})

test("renderTopicHelp: 模块别名/命令前缀/中文主题/未知主题", async () => {
  const { renderTopicHelp } = await import("../utils/commandRegistry.js")
  const fixture = {
    domains: [
      {
        key: "memory", name: "记忆与表达", icon: "🧠", desc: "长期记忆", order: 1,
        commands: [
          { usage: "#记忆状态", desc: "查看记忆系统运行状态", perm: "all", src: "x" }
        ]
      },
      {
        key: "dice", name: "骰子", icon: "🎲", desc: "COC7/DND 骰娘", order: 3,
        commands: [
          { usage: ".ra <技能> <值>", desc: "COC 检定（含 #N 多轮）", perm: "all", src: "x" },
          { usage: ".log on <团名>", desc: "开启跑团日志", perm: "admin", src: "x" },
          { usage: ".sc <成功/失败>", desc: "SAN Check", perm: "all", src: "x" }
        ]
      }
    ]
  }
  const coc = renderTopicHelp(fixture, "coc")
  assert.match(coc, /骰子（3 条）/)
  assert.match(coc, /COC 检定（含 #N 多轮）/)
  assert.match(coc, /SAN Check/)
  const ra = renderTopicHelp(fixture, "ra")
  assert.match(ra, /【ra 相关命令】/)
  assert.match(ra, /\.ra <技能> <值> —— /)
  assert.ok(!ra.includes(".log"), "ra 主题不应包含 log 命令")
  const log = renderTopicHelp(fixture, "log")
  assert.match(log, /\.log on <团名> —— 开启跑团日志［群管理］/)
  const zh = renderTopicHelp(fixture, "记忆")
  assert.match(zh, /记忆与表达（1 条）/)
  assert.equal(renderTopicHelp(fixture, "不存在xyz"), null)
  assert.equal(renderTopicHelp(fixture, ""), null)
})

test("命令总表 desc 不被 YAML # 注释截断（.ra 描述完整）", async () => {
  const { getCommandRegistry } = await import("../utils/commandRegistry.js")
  const registry = getCommandRegistry(pluginRoot)
  const ra = registry.domains.flatMap(d => d.commands).find(c => c.usage.startsWith(".ra "))
  assert.ok(ra, "应存在 .ra 命令")
  assert.match(ra.desc, /#N 多轮/)
  assert.match(ra.desc, /判档）$/)
})
