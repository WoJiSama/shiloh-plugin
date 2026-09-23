import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"

async function loadRuntime(t) {
  if (!globalThis.logger) {
    globalThis.logger = {
      info() {}, warn() {}, error() {}, debug() {}, mark() {}
    }
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

test("the model chooses emoji-only or mixed reply through followUpText", async t => {
  const runtime = await loadRuntime(t)
  if (!runtime) return

  const { SendLocalEmojiTool, emojiPackManager } = runtime
  const originalSegment = globalThis.segment
  const originals = {
    config: emojiPackManager.config,
    refreshConfig: emojiPackManager.refreshConfig,
    checkRateLimit: emojiPackManager.checkRateLimit,
    selectEmoji: emojiPackManager.selectEmoji,
    getAbsoluteFilePath: emojiPackManager.getAbsoluteFilePath,
    recordPick: emojiPackManager.recordPick,
    recordSend: emojiPackManager.recordSend,
    markUsed: emojiPackManager.markUsed
  }
  const fixture = fileURLToPath(new URL("../package.json", import.meta.url))

  emojiPackManager.config = {
    enabled: true,
    followUpDelayMinMs: 1,
    followUpDelayMaxMs: 1
  }
  emojiPackManager.refreshConfig = () => {}
  emojiPackManager.checkRateLimit = () => ({ allowed: true })
  const receivedCriteria = []
  emojiPackManager.selectEmoji = async criteria => {
    receivedCriteria.push(criteria)
    return {
    item: { hash: "test-hash", tags: ["无语"] },
      strategy: "test",
      score: 0.9
    }
  }
  emojiPackManager.getAbsoluteFilePath = () => fixture
  emojiPackManager.recordPick = () => {}
  emojiPackManager.recordSend = () => {}
  emojiPackManager.markUsed = async () => {}
  globalThis.segment = { image: file => ({ type: "image", file }) }

  try {
    const tool = new SendLocalEmojiTool()
    const emojiOnlyReplies = []
    const emojiOnlyResult = await tool.func({
      tags: ["无语", "震惊"],
      useCases: ["无言以对", "看到离谱"]
    }, {
      msg: "这也太离谱了",
      group_id: 1,
      reply: async message => emojiOnlyReplies.push(message)
    })

    assert.equal(emojiOnlyReplies.length, 1)
    assert.equal(emojiOnlyReplies[0].type, "image")
    // 默认以表情小图发送（sub_type=1），避免满屏大图
    assert.equal(emojiOnlyReplies[0].sub_type ?? emojiOnlyReplies[0].data?.sub_type, 1)
    assert.match(emojiOnlyResult, /回复模式: emoji_only/)
    assert.deepEqual(receivedCriteria[0].tags, ["无语", "震惊"])

    const withTextReplies = []
    const withTextResult = await tool.func({
      tags: ["认怂", "无奈"],
      useCases: ["认怂求饶"],
      followUpText: "我马上到"
    }, {
      msg: "发个表情包，再跟他说我马上到",
      group_id: 2,
      reply: async message => withTextReplies.push(message)
    })

    assert.deepEqual(withTextReplies.map(item => typeof item === "string" ? item : item.type), ["image", "我马上到"])
    assert.match(withTextResult, /回复模式: emoji_text/)

    const threePartReplies = []
    const threePartResult = await tool.func({
      tags: ["无语", "吐槽"],
      leadText: "你先等一下",
      followUpText: "把前面那句解释清楚"
    }, {
      msg: "这也太离谱了",
      group_id: 3,
      reply: async message => threePartReplies.push(message)
    })
    assert.deepEqual(threePartReplies.map(item => typeof item === "string" ? item : item.type), ["你先等一下", "image", "把前面那句解释清楚"])
    assert.match(threePartResult, /回复模式: text_emoji_text/)
  } finally {
    Object.assign(emojiPackManager, originals)
    globalThis.segment = originalSegment
  }
})
