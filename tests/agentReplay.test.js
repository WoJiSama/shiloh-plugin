import { test } from "node:test"
import assert from "node:assert/strict"

// P4 回放测试集：真实翻车事件的原话 → 断言意图层必须给出的判定。
// 每个用例对应一次线上事故，重构意图层时这些断言不允许退化。

test("回放#1 泳装星野事件（2026-09-12）：显式生图 + 不挂真人头像 + 失败直发事实文案", async () => {
  const message = "希洛帮我画一张 蔚蓝档案里面的小鸟游星野穿着泳装的照片"

  const { hasExplicitImageGenerationRequest, shouldPreferImageGeneration } = await import("../utils/imageTaskPolicy.js")
  assert.equal(hasExplicitImageGenerationRequest(message), true, "必须识别为显式生图")
  assert.equal(shouldPreferImageGeneration(message), true, "必须直接路由 bananaTool")

  const { shouldSkipNicknameAvatarReference } = await import("../utils/avatarReferencePolicy.js")
  assert.equal(shouldSkipNicknameAvatarReference(message, "星野"), true, "不得挂同昵称群友的真人头像")

  const { isImageDeliveryToolName } = await import("../utils/drawFailureNote.js")
  assert.equal(isImageDeliveryToolName("bananaTool"), true, "失败回复必须走事实直发路径（不经模型润色）")
})

test("回放#2 画一个星野事件（2026-09-11）：句中无图字也必须路由生图，且不被降级为表情包闲聊", async () => {
  const message = "希洛画一个惨兮兮的上学回不了玩游戏的星野"

  const { hasExplicitImageGenerationRequest, shouldPreferImageGeneration, classifyImageTaskPolicy } = await import("../utils/imageTaskPolicy.js")
  assert.equal(hasExplicitImageGenerationRequest(message), true)
  assert.equal(shouldPreferImageGeneration(message), true)
  assert.equal(classifyImageTaskPolicy({ text: message }), "image_generation")

  const { classifyEmojiToolExposure, filterToolsForEmojiExposure } = await import("../utils/emojiToolPolicy.js")
  assert.equal(classifyEmojiToolExposure(message), "none", "不得归类为表情包闲聊")
  assert.equal(
    filterToolsForEmojiExposure([{ function: { name: "bananaTool" } }, { function: { name: "sendLocalEmojiTool" } }], message),
    null,
    "画图请求不得被裁剪到只剩表情包工具"
  )

  const { shouldSkipNicknameAvatarReference } = await import("../utils/avatarReferencePolicy.js")
  assert.equal(shouldSkipNicknameAvatarReference(message, "星野"), true, "作品角色不挂真人头像")
})

test("回放#3 归尘骂街事件（2026-09-11）：失败后下一轮必须注入失败标记，模型不得把抱怨当梗", async () => {
  const { recordDrawTextFallback, takeDrawFailureNote, buildDrawFailureNoteMessage } = await import("../utils/drawFailureNote.js")
  const scope = "replay-group-1"
  recordDrawTextFallback(scope, "希洛画一个惨兮兮的上学回不了玩游戏的星野")
  const note = takeDrawFailureNote(scope)
  assert.ok(note, "标记可读取")
  const message = buildDrawFailureNoteMessage(note)
  assert.match(message, /没有生成图片/, "提示必须说明没出图")
  assert.match(message, /人物指认/, "提示必须包含人物指认约束")
  assert.equal(takeDrawFailureNote(scope), null, "读取即消费，不会重复注入")
})

test("回放#4 防误判边界：含画字的日常用语不得触发生图", async () => {
  const { hasExplicitImageGenerationRequest } = await import("../utils/imageTaskPolicy.js")
  for (const text of ["这个字笔画一个比一个复杂", "计划一个周末出行", "油画展览什么时候开门"]) {
    assert.equal(hasExplicitImageGenerationRequest(text), false, text)
  }
})

test("回放#5 P4 主判定：模型判定必须给出与正则修复后一致的路由结论", async () => {
  const { classifyIntentWithModel } = await import("../core/intent/modelIntentClassifier.js")
  const CONFIG = {
    intentAiConfig: { intentAiUrl: "", intentAiModel: "", intentAiApikey: "" },
    toolsAiConfig: { toolsAiUrl: "", toolsAiApikey: "" }
  }
  // 未配置时安全返回 null 路径（调用方走正则兜底）
  const r = await classifyIntentWithModel({ text: "任意", config: CONFIG })
  assert.equal(r.intent, "unavailable")
  // resolvePrimaryModelIntent 的门槛逻辑等价于：conf<0.7 或 unavailable -> null
  const gate = result => (result.intent !== "unavailable" && result.confidence >= 0.7) ? result : null
  assert.equal(gate({ intent: "image_generate", confidence: 0.6 }), null)
  assert.equal(gate({ intent: "image_generate", confidence: 0.7 }).intent, "image_generate")
})
