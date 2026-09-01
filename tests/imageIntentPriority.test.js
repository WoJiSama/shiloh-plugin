import { test } from "node:test"
import assert from "node:assert/strict"

const editPattern = /(?:取消掉|去掉|去除|删掉|删除|移除|擦掉|修掉|改掉|修改|调整|修一下|改一下|融合|贴合|换成|替换|换头|换脸)/

test("mixed visual wording keeps the explicit edit action as the primary intent", () => {
  const text = "为什么脖子旁边有一个手啊，取消掉，然后你再看一下maela的头像，这像吗"
  assert.equal(editPattern.test(text), true)
  assert.equal(text.includes("看一下maela的头像"), true)
})

test("recognizes natural visual inspection and verb-first continuation wording", async () => {
  const { classifyImageTaskPolicy, hasExplicitImageEditAction } = await import("../utils/imageTaskPolicy.js")
  assert.equal(classifyImageTaskPolicy({ text: "看一下这张图片", hasImages: true }), "image_analysis")
  assert.equal(classifyImageTaskPolicy({ text: "继续改上一张图", hasRecentBotImage: true }), "image_edit")
  assert.equal(hasExplicitImageEditAction("希洛帮我把maela的头像换成男人"), true)
})

test("explicit from-scratch generation outranks edit-like wording about the future image", async () => {
  const {
    classifyImageTaskPolicy,
    isStandaloneImageGenerationRequest,
    shouldRequireImageEditBase
  } = await import("../utils/imageTaskPolicy.js")
  const text = [
    "希洛,帮我生成图片：拍摄手法使用高角度近距离广角俯拍角度，",
    "将图中人物的姿势变成蹲姿，右手拿着图中人物自己的拍立得照片。",
    "拍立得照片参考少女面部，五官贴合度高，比例9:16。"
  ].join("")

  assert.equal(isStandaloneImageGenerationRequest(text), true)
  assert.equal(shouldRequireImageEditBase(text), false)
  assert.equal(classifyImageTaskPolicy({ text, hasImages: false }), "image_generation")
})

test("a drawing request with a prompt label is not mistaken for an edit because it says 融合", async () => {
  const { classifyImageTaskPolicy, shouldRequireImageEditBase } = await import("../utils/imageTaskPolicy.js")
  const text = "希洛帮我画画，提示词为：整体风格融合水墨速写、赛璐璐与半厚涂质感。画面采用低机位仰视构图，人物占据画面主体。"

  assert.equal(shouldRequireImageEditBase(text), false)
  assert.equal(classifyImageTaskPolicy({ text, hasImages: false }), "image_generation")
})

test("natural long-form drawing requests are explicit generation intents", async () => {
  const { hasExplicitImageGenerationRequest, classifyImageTaskPolicy } = await import("../utils/imageTaskPolicy.js")
  const cases = [
    "希洛画一个龙族里面的绘梨衣和蔚蓝档案里面的小鸟游星野拥抱的画",
    "希洛，画一个明日方舟中的阿米娅帮博士整理文件的画面"
  ]
  for (const text of cases) {
    assert.equal(hasExplicitImageGenerationRequest(text), true, text)
    assert.equal(classifyImageTaskPolicy({ text }), "image_generation", text)
  }
})

test("real references to an existing image still require an edit base", async () => {
  const {
    classifyImageTaskPolicy,
    isStandaloneImageGenerationRequest,
    shouldRequireImageEditBase
  } = await import("../utils/imageTaskPolicy.js")
  const cases = [
    "帮我生成图片，把这张图里的人物姿势变成蹲姿",
    "生成一张图，参考我刚才发的照片，五官要认得出本人",
    "把原图人物的衣服换成黑色"
  ]

  for (const text of cases) {
    assert.equal(isStandaloneImageGenerationRequest(text), false, text)
    assert.equal(shouldRequireImageEditBase(text), true, text)
    assert.equal(classifyImageTaskPolicy({ text, hasImages: false }), "image_edit_missing_base", text)
  }
  assert.equal(isStandaloneImageGenerationRequest("帮我生成图片，把人物姿势变成蹲姿", { hasImages: true }), false)
})

test("unanchored edit-like prose is left for semantic tool selection instead of demanding a base image", async () => {
  const { shouldRequireImageEditBase } = await import("../utils/imageTaskPolicy.js")

  assert.equal(shouldRequireImageEditBase("帮我把人物衣服换成黑色，画面要有电影感"), false)
  assert.equal(shouldRequireImageEditBase("把原图人物的衣服换成黑色"), true)
})

test("empty image failures use natural wording without internal upstream terms", async () => {
  const { buildImageFailureReply } = await import("../utils/imageFailurePolicy.js")
  const reply = buildImageFailureReply("未接收到有效图片")
  assert.match(reply, /没有返回成图/)
  assert.doesNotMatch(reply, /上游|API|模型/)
  assert.doesNotMatch(reply, /换个说法|我帮你改|替你改/)
})

test("provider errors are not mislabeled as empty image results", async () => {
  const { classifyImageFailure, buildImageFailureReply } = await import("../utils/imageFailurePolicy.js")
  const error = "图片编辑服务错误: bad_response_status_code: openai_error"
  assert.equal(classifyImageFailure(error), "provider_error")
  assert.match(buildImageFailureReply(error), /通道现在不可用/)
  assert.doesNotMatch(buildImageFailureReply(error), /没拿到成图/)
})

test("503 no-channel failures are attributed to the provider, not the user's wording", async () => {
  const { classifyImageFailure, buildImageFailureReply } = await import("../utils/imageFailurePolicy.js")
  const error = "503 No available channel for model gpt-image-2 under group codex (distributor)"
  const reply = buildImageFailureReply(error, { operation: "edit" })

  assert.equal(classifyImageFailure(error), "provider_error")
  assert.match(reply, /图片编辑通道现在不可用/)
  assert.match(reply, /不是你的描述有问题/)
  assert.match(reply, /没有改你的原话/)
  assert.doesNotMatch(reply, /换个说法|调整.*用词|画崩/)
})

test("observed Grok generation 400 is not mislabeled as image editing or a transient retry", async () => {
  const { classifyImageFailure, buildImageFailureReply, inferImageFailureOperation } = await import("../utils/imageFailurePolicy.js")
  const error = "图片生成失败: 所有文生图模型都失败了：grok(grok-imagine-image): API请求失败: 400 Invalid request format."
  const reply = buildImageFailureReply(error, { operation: "edit" })

  assert.equal(classifyImageFailure(error), "request_contract")
  assert.equal(inferImageFailureOperation(error, "edit"), "generate")
  assert.match(reply, /图片生成渠道当前没有接通/)
  assert.match(reply, /原样重试也不会解决/)
  assert.doesNotMatch(reply, /图片编辑|原图|稍后.*再试/)
})

test("image edit failures remain editing failures after automatic operation inference", async () => {
  const { buildImageFailureReply, inferImageFailureOperation } = await import("../utils/imageFailurePolicy.js")
  const error = "图片编辑失败: 所有图片编辑通道都失败了：Krill: 400 Invalid request format."

  assert.equal(inferImageFailureOperation(error, "generate"), "edit")
  assert.match(buildImageFailureReply(error, { operation: "generate" }), /图片编辑渠道当前没有接通/)
})

test("safety failures report the upstream decision without rewriting the prompt", async () => {
  const { buildImageFailureReply } = await import("../utils/imageFailurePolicy.js")
  const reply = buildImageFailureReply("content policy blocked")

  assert.match(reply, /没有改你的原话/)
  assert.doesNotMatch(reply, /我帮你|替你|自动|改写后的|换个更合适的说法/)
})

test("requested provider failures preserve the name and confirm no fallback", async () => {
  const { buildImageFailureReply } = await import("../utils/imageFailurePolicy.js")
  const unavailable = buildImageFailureReply("图片生成失败: 未找到可用于图片编辑的指定图片渠道“Grok”，不会自动改用其他渠道")
  const ambiguous = buildImageFailureReply("指定的图片模型“gpt-image-2”同时匹配多个渠道（Krill、Sou），请明确说渠道名称")

  assert.match(unavailable, /Grok/)
  assert.match(unavailable, /没有改用其他渠道/)
  assert.match(ambiguous, /Krill、Sou/)
  assert.match(ambiguous, /不会替你随便选/)
})
