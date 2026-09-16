import { test } from "node:test"
import assert from "node:assert/strict"

test("画一个+角色名（句中无“图”字）是显式生图请求", async () => {
  const { hasExplicitImageGenerationRequest, classifyImageTaskPolicy, shouldPreferImageGeneration } = await import("../utils/imageTaskPolicy.js")
  const cases = [
    "希洛画一个惨兮兮的上学回不了玩游戏的星野",
    "画个委屈巴巴的星野",
    "帮我画只戴帽子的猫",
    "绘制一幅海边日落",
    "画一张流泪的少女"
  ]
  for (const text of cases) {
    assert.equal(hasExplicitImageGenerationRequest(text), true, text)
    assert.equal(classifyImageTaskPolicy({ text }), "image_generation", text)
    assert.equal(shouldPreferImageGeneration(text), true, text)
  }
})

test("画图请求不会被降级成表情包闲聊", async () => {
  const { classifyEmojiToolExposure, filterToolsForEmojiExposure } = await import("../utils/emojiToolPolicy.js")
  const text = "希洛画一个惨兮兮的上学回不了玩游戏的星野"
  assert.equal(classifyEmojiToolExposure(text), "none")
  assert.equal(filterToolsForEmojiExposure([{ function: { name: "bananaTool" } }, { function: { name: "sendLocalEmojiTool" } }], text), null)
})

test("含“画”字的普通词不误判为生图请求", async () => {
  const { hasExplicitImageGenerationRequest } = await import("../utils/imageTaskPolicy.js")
  const cases = [
    "这个字笔画一个比一个复杂",
    "计划一个周末出行方案",
    "比划一下那个动作",
    "漫画一部比一部贵",
    "油画展览什么时候开门"
  ]
  for (const text of cases) {
    assert.equal(hasExplicitImageGenerationRequest(text), false, text)
  }
})

test("画图失败标记：记录、消费、过期与清理", async () => {
  const { recordDrawTextFallback, takeDrawFailureNote, clearDrawFailureNote, buildDrawFailureNoteMessage, isImageDeliveryToolName } = await import("../utils/drawFailureNote.js")
  const now = Date.now()
  recordDrawTextFallback(953676639, "希洛画一个星野")
  const note = takeDrawFailureNote(953676639, { now })
  assert.equal(note.requestText, "希洛画一个星野")
  assert.equal(takeDrawFailureNote(953676639, { now }), null, "读取即消费")

  recordDrawTextFallback("g1", "画只猫")
  assert.equal(takeDrawFailureNote("g1", { now: now + 11 * 60 * 1000 }), null, "过期自动失效")

  recordDrawTextFallback("g2", "画只猫")
  clearDrawFailureNote("g2")
  assert.equal(takeDrawFailureNote("g2", { now }), null, "手动清理")

  const message = buildDrawFailureNoteMessage({ at: now, requestText: "希洛画一个星野" })
  assert.match(message, /【系统提示】/)
  assert.match(message, /没有生成图片/)
  assert.match(message, /人物指认/)
  assert.equal(buildDrawFailureNoteMessage(null), "")
  assert.equal(isImageDeliveryToolName("bananaTool"), true)
  assert.equal(isImageDeliveryToolName("googleImageEditTool"), true)
  assert.equal(isImageDeliveryToolName("sendLocalEmojiTool"), false)
})

test("findRecentBotImage 不依赖续改话术即可扫到机器人近期图片", async () => {
  const { findRecentBotImage } = await import("../utils/recentImageContinuation.js")
  const now = Date.now()
  const event = {
    group: {
      getChatHistory: async () => [
        { time: now - 5000, sender: { user_id: 111 }, message: [{ type: "text", data: { text: "草啊" } }] },
        { time: now - 3000, sender: { user_id: 999 }, message: [{ type: "image", url: "https://example.com/gen.png" }] }
      ]
    }
  }
  const result = await findRecentBotImage(event, { botId: 999, now, maxAgeMs: 90000 })
  assert.equal(result?.image, "https://example.com/gen.png")

  const empty = await findRecentBotImage({ group: { getChatHistory: async () => [] } }, { botId: 999, now })
  assert.equal(empty, null)
})
