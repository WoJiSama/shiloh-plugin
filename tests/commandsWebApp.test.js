import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("命令表校验：非法输入被拒绝", async () => {
  const { validateRegistryInput } = await import("../utils/commandRegistry.js")
  assert.ok(validateRegistryInput({}).errors.length >= 1)

  const dup = validateRegistryInput({
    domains: [
      { key: "a", name: "A", commands: [{ usage: "#x" }] },
      { key: "a", name: "B", commands: [] }
    ]
  })
  assert.ok(dup.errors.some(e => e.includes("重复")))

  const badPerm = validateRegistryInput({
    domains: [{ key: "a", name: "A", commands: [{ usage: "#x", perm: "hacker" }] }]
  })
  assert.equal(badPerm.value.domains[0].commands[0].perm, "all", "非法权限回退为 all")
})

test("命令表写入与热加载 roundtrip", async () => {
  const { getCommandRegistry, writeRegistryConfig } = await import("../utils/commandRegistry.js")
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "commands-web-"))
  try {
    const target = writeRegistryConfig({
      domains: [
        {
          key: "testdom",
          name: "测试模块",
          icon: "🧪",
          desc: "写入测试",
          commands: [{ usage: "#测试命令", desc: "说明文字", perm: "master", src: "apps/x.js fn" }]
        }
      ]
    }, tmpRoot)
    assert.ok(fs.existsSync(target))
    const registry = getCommandRegistry(tmpRoot, { force: true })
    assert.equal(registry.commandCount, 1)
    assert.equal(registry.domains[0].name, "测试模块")
    assert.equal(registry.domains[0].commands[0].perm, "master")

    // 非法写入被拒绝且不落盘覆盖
    let rejected = false
    try { writeRegistryConfig({ domains: [] }, tmpRoot) } catch { rejected = true }
    assert.ok(rejected)
    assert.equal(getCommandRegistry(tmpRoot, { force: true }).commandCount, 1)
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test("管理页 HTML 包含核心交互元素", async () => {
  const fs2 = await import("node:fs")
  const src = fs2.readFileSync(path.join(pluginRoot, "utils/commandsWebApp.js"), "utf8")
  const htmlMatch = src.match(/return `<!doctype html>[\s\S]*?<\/html>`/)
  assert.ok(htmlMatch, "页面模板存在")
  const html = htmlMatch[0]
  for (const marker of ["命令管理", "api/data", "api/save", "访问令牌", "新增模块", "新增命令", "删除整个模块"]) {
    assert.ok(html.includes(marker), `页面缺少 ${marker}`)
  }
})

test("骰子面板按命令展示 .st 和失败/大失败发送文案", async () => {
  const fs2 = await import("node:fs")
  const src = fs2.readFileSync(path.join(pluginRoot, "utils/commandsWebApp.js"), "utf8")
  assert.ok(src.includes("buildDiceReplyPayload"), "管理页应从回复目录加载内置规则")
  assert.ok(src.includes("await loadDiceExtras()"), "骰子数据必须在渲染前加载完")
  assert.ok(src.includes("cmd-group"), "卡片内应按命令分组")
  assert.ok(src.includes("g.title"), "分组标题来自规则目录")
  assert.ok(src.includes("失败/大失败整句发送") || src.includes("整句发送"), "失败/大失败应能改整句发送")
  assert.ok(src.includes("命令帮助（只改说明书，不改群里实际发送的话）"), "骰子帮助表应标成说明书，避免和发送文案混淆")
  assert.ok(src.indexOf("内置规则") < src.indexOf("box.appendChild(table)"), "骰子卡片应排在命令帮助表前面")
})
