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
  const src = fs.readFileSync(path.join(root, "apps/test.js"), "utf8")
  for (const marker of [
    "async handleRandomReplySmart(e) {\n    if (!isAiConversationEnabled(this.config)) return false",
    "async joinRepeat(e, state, text) {\n    if (!isAiConversationEnabled(this.config)) return false",
    "if (!isAiConversationEnabled(this.config)) return\n        if (!this.checkGroupPermission(e))",
    "插件总开关已关闭，取消续话",
    "error: 'plugin_disabled'",
    "async handleTool(e) {\n    if (!isAiConversationEnabled(this.config)) return false"
  ]) {
    assert.ok(src.includes(marker.replaceAll("\\n", "\n")), `missing guard: ${marker.split("\n")[0]}`)
  }
})
