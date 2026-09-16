import { test } from "node:test"
import assert from "node:assert/strict"

test("意图层核心模块：分类函数行为锁定（从 apps/test.js 迁出后的回归锚点）", async () => {
  const intent = await import("../core/intent/messageIntent.js")

  // 生图意图
  assert.equal(intent.isImageGenerationRequest("希洛画一个惨兮兮的上学回不了玩游戏的星野"), true)
  assert.equal(intent.isImageGenerationRequest("希洛帮我画一张 蔚蓝档案里面的小鸟游星野穿着泳装的照片"), true)
  assert.equal(intent.isImageGenerationRequest("帮我画张猫猫壁纸"), true)
  assert.equal(intent.isImageGenerationRequest("这个字笔画一个比一个复杂"), false)

  // 识图 vs 生图互斥
  assert.equal(intent.isImageAnalysisRequest("看看这张图片里有什么"), true)
  assert.equal(intent.isImageAnalysisRequest("帮我画一张猫"), false)

  // 编辑意图
  assert.equal(intent.isImageEditRequest("帮我把这张图的背景换成海边"), true)
  assert.equal(intent.isImageCompositionEditRequest("把一只猫放到这张图里"), true)

  // 检索/工具意图
  assert.equal(intent.isRealtimeInfoRequest("今天天气怎么样"), true)
  assert.equal(intent.isExplicitSearchRequest("搜一下最新的新闻"), true)
  assert.equal(intent.isExplicitToolIntent("帮我生成语音"), true)
  assert.equal(intent.isExplicitToolIntent("帮我生成一张图片"), false)

  // 问句/反馈/问候
  assert.equal(intent.isQuestionMessage("你是谁？"), true)
  assert.equal(intent.isQuestionMessage("今天天气怎么样"), true)
  assert.equal(intent.isQuestionMessage("好的收到"), false)
  assert.equal(intent.isFeedbackMessage("没错，就是这样"), true)
  assert.equal(intent.isFeedbackMessage("帮我写个脚本"), false)
  assert.equal(intent.isCasualBotGreeting("希洛在吗"), true)
  assert.equal(intent.isCasualBotGreeting("帮我写个脚本"), false)

  // 紧凑历史选择
  assert.equal(intent.shouldUseCompactHistory({ text: "哈哈哈哈" }), true)
  assert.equal(intent.shouldUseCompactHistory({ text: "看看他刚才说的那段话" }), false)

  // 画图状态追问与续改（明确编辑动词的句子走编辑路径，不算续改）
  assert.equal(intent.isDrawTaskStatusInquiry("我的图好了没"), true)
  assert.equal(intent.isDrawContextContinuationRequest("继续画"), true)
  assert.equal(intent.isDrawContextContinuationRequest("把人物的头发换成蓝色"), false)

  // 关键词提取（2-gram 滑窗）
  assert.deepEqual(intent.extractChatKeywords("今天天气不错", 3), ["今天", "天天", "天气"])

  // 群上下文注入（群事实类问题才注入）
  assert.equal(intent.shouldInjectGroupContext("谁是管理员"), true)
  assert.equal(intent.shouldInjectGroupContext("他说了什么"), false)

  // 伪工具标记
  assert.equal(intent.isPseudoToolMarker("tool"), true)
  assert.equal(intent.isPseudoToolMarker("banana"), true)
  assert.equal(intent.isPseudoToolMarker("weathertool"), true)
  assert.equal(intent.isPseudoToolMarker("普通词"), false)

  // 语义工具意图集合
  assert.equal(intent.SEMANTIC_TOOL_INTENTS.has("image_generate"), true)
  assert.equal(intent.TERMINAL_TOOL_NAMES.has("bananaTool"), true)
  assert.equal(intent.BACKGROUND_TERMINAL_TOOL_NAMES.has("bananaTool"), true)
})
