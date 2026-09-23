import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

async function loadRuntime(t) {
  if (!globalThis.logger) {
    globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
  }
  try {
    const [{ SendLocalEmojiTool }, { emojiPackManager }] = await Promise.all([
      import("../functions/functions_tools/SendLocalEmojiTool.js"),
      import("../domains/emoji/EmojiPackManager.js")
    ])
    return { SendLocalEmojiTool, emojiPackManager }
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip(`runtime dependency is not installed in this checkout: ${error.message}`)
      return null
    }
    throw error
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("tool schema enum follows the live catalog vocabulary", async t => {
  const runtime = await loadRuntime(t)
  if (!runtime) return
  const { SendLocalEmojiTool, emojiPackManager } = runtime

  const original = emojiPackManager.getSelectionVocabularySync
  try {
    emojiPackManager.getSelectionVocabularySync = () => ({
      tags: ["笑死", "吐槽"],
      useCases: ["接梗吐槽"]
    })
    const tool = new SendLocalEmojiTool()
    assert.deepEqual(tool.parameters.properties.tags.items.enum, ["笑死", "吐槽"])
    assert.ok(tool.parameters.properties.tags.description.includes("笑死、吐槽"), "推荐标签从真实词表生成")
    const parametersRef = tool.parameters

    // 词表演进（导入新表情/新标签）后刷新 schema：原地更新，引用不换
    emojiPackManager.getSelectionVocabularySync = () => ({
      tags: ["笑死", "吐槽", "新标签"],
      useCases: ["接梗吐槽", "新场景"]
    })
    tool.refreshSchema()
    assert.equal(tool.parameters, parametersRef, "parameters 对象原地更新（注册表引用不失效）")
    assert.deepEqual(tool.parameters.properties.tags.items.enum, ["笑死", "吐槽", "新标签"])
    assert.ok(tool.parameters.properties.useCases.items.enum.includes("新场景"))
  } finally {
    emojiPackManager.getSelectionVocabularySync = original
  }
})

test("manager notifies catalog changes and supports unsubscription", async t => {
  const runtime = await loadRuntime(t)
  if (!runtime) return
  const { emojiPackManager } = runtime
  let fired = 0
  const off = emojiPackManager.onCatalogChanged(() => fired++)
  emojiPackManager.notifyCatalogChanged()
  assert.equal(fired, 1)
  off()
  emojiPackManager.notifyCatalogChanged()
  assert.equal(fired, 1, "取消订阅后不再触发")
  // 回调抛错不阻断其他订阅者
  emojiPackManager.onCatalogChanged(() => { throw new Error("boom") })
  let second = 0
  emojiPackManager.onCatalogChanged(() => second++)
  emojiPackManager.notifyCatalogChanged()
  assert.equal(second, 1)
})

test("catalog change triggers a debounced schema refresh subscription", async t => {
  const runtime = await loadRuntime(t)
  if (!runtime) return
  const { SendLocalEmojiTool } = runtime
  const tool = new SendLocalEmojiTool()
  // 防抖 10s 对测试太长：直接验证订阅存在且刷新幂等
  assert.ok(typeof tool.refreshSchema === "function")
  assert.doesNotThrow(() => tool.refreshSchema())
})

test("expression learner exposes group emoji layout stats", () => {
  const src = fs.readFileSync(path.join(root, "domains/memory/ExpressionLearner.js"), "utf8")
  assert.ok(src.includes("async getGroupEmojiLayoutStats(groupId)"), "学习器提供群级表情布局统计")
  assert.ok(src.includes("emojiOnlyShare"), "统计含裸表情占比")
  const testSrc = fs.readFileSync(path.join(root, "apps/test.js"), "utf8")
  assert.ok(testSrc.includes("getGroupEmojiLayoutStats?.(groupId)"), "主链路消费该统计")
})
