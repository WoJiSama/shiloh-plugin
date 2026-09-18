import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  recordEmojiOnlySend, emojiCooldownActive, suppressEmojiByCooldown,
  filterToolsForEmojiExposure, resetEmojiCooldownForTests
} from "../utils/emojiToolPolicy.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("emoji-only 回复后进入冷却，explicit 请求不受限", () => {
  resetEmojiCooldownForTests()
  assert.equal(emojiCooldownActive("g1"), false)
  recordEmojiOnlySend("g1", 60000)
  assert.equal(emojiCooldownActive("g1"), true, "冷却开启")
  assert.equal(suppressEmojiByCooldown("哈哈哈哈", "g1"), true, "casual 反应被抑制")
  assert.equal(suppressEmojiByCooldown("来个表情包", "g1"), false, "explicit 永远放行")
  assert.equal(emojiCooldownActive("g2"), false, "冷却按群隔离")
})

test("冷却为 0 表示关闭", () => {
  resetEmojiCooldownForTests()
  recordEmojiOnlySend("g1", 0)
  assert.equal(emojiCooldownActive("g1"), false)
})

test("冷却期间 casual 暴露返回空工具列表", () => {
  resetEmojiCooldownForTests()
  const emojiTool = { function: { name: "sendLocalEmojiTool" } }
  const searchTool = { function: { name: "searchInformationTool" } }
  recordEmojiOnlySend("g1", 60000)
  assert.deepEqual(filterToolsForEmojiExposure([emojiTool, searchTool], "哈哈哈哈", { groupId: "g1" }), [])
  assert.deepEqual(filterToolsForEmojiExposure([emojiTool, searchTool], "来个表情包", { groupId: "g1" }), [emojiTool], "explicit 仍能拿到工具")
})

test("test.js 已接线：终态表情后记录冷却、暴露过滤传冷却参数", () => {
  const src = fs.readFileSync(path.join(root, "apps/test.js"), "utf8")
  assert.ok(src.includes("recordEmojiOnlySend(e.group_id"), "终态表情回复记录冷却")
  assert.ok(src.includes("emojiCooldownMs: Number(this.config?.emojiSystem?.emojiCooldownMs"), "暴露过滤带冷却配置")
  assert.ok(src.includes("!suppressEmojiByCooldown(currentIntentText, groupId, emojiCooldownMs)"), "强制快路尊重冷却")
})
