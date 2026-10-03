import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isAiConversationEnabled } from "../utils/aiConversationGate.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("plugin master switch treats false-like values as off", () => {
  assert.equal(isAiConversationEnabled({ enabled: true }), true)
  assert.equal(isAiConversationEnabled({ enabled: false }), false)
  assert.equal(isAiConversationEnabled({ enabled: "false" }), false)
  assert.equal(isAiConversationEnabled({ enabled: "off" }), false)
  assert.equal(isAiConversationEnabled({ enabled: 0 }), false)
  assert.equal(isAiConversationEnabled({}), false)
  assert.equal(isAiConversationEnabled(null), false)
})

test("AI conversation entries re-check the master switch", () => {
  // 主链路已拆 apps/lib(P 重构):守卫随方法迁走,聚合两个新家断言
  const libDir = path.join(root, "apps/lib")
  const joined = [path.join(root, "apps/test.js"),
    ...fs.readdirSync(libDir).filter(f => f.endsWith(".js")).map(f => path.join(libDir, f))]
    .map(file => fs.readFileSync(file, "utf8")).join("\n")
  for (const marker of [
    "async handleRandomReplySmart(e) {", // 类内委托仍在
    "export async function handleRandomReplySmart(host, e) {\n    if (!isAiConversationEnabled(host.config)) return false",
    "export async function joinRepeat(host, e, state, text) {\n    if (!isAiConversationEnabled(host.config)) return false",
    "if (!isAiConversationEnabled(this.config)) return\n        if (!this.checkGroupPermission(e))",
    "插件总开关已关闭，取消续话",
    "error: 'plugin_disabled'",
    "async handleToolInner(e) {", // 类内委托仍在
    "export async function handleToolInner(host, e) {\n    if (!isAiConversationEnabled(host.config)) return false"
  ]) {
    assert.ok(joined.includes(marker.replaceAll("\\n", "\n")), `missing guard: ${marker.split("\n")[0]}`)
  }
})
