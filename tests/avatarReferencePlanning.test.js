// LLM 头像参考规划:references 的机械校验/落地、路由让路、能力声明。
// 设计原则:模型管语义(谁演什么角色),代码管机械(只认本轮真实提及的成员)。
import { test, before } from "node:test"
import assert from "node:assert/strict"

// Yunzai 运行时全局,单测环境补一个空实现避免 ReferenceError
if (!globalThis.logger) {
  globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
}

const MEMBER_MAP = new Map([
  [11111111, { user_id: 11111111, card: "圣履姬", nickname: "翠月" }],
  [22222222, { user_id: 22222222, card: "", nickname: "杂鱼" }],
  [33333333, { user_id: 33333333, card: "多一律", nickname: "多一律" }]
])

test("resolveMemberAvatarReferences: 被@成员合法指认保留,角色透传", async () => {
  const { resolveMemberAvatarReferences } = await import("../apps/lib/avatarReference.js")
  const resolved = resolveMemberAvatarReferences(
    [
      { qq: "11111111", role: "画面中央的主体" },
      { qq: 22222222, role: "左侧的恶魔" },
      { qq: "33333333", role: "" }
    ],
    { memberMap: MEMBER_MAP, atQq: [11111111, 22222222, 33333333] }
  )
  assert.equal(resolved.length, 3)
  assert.equal(resolved[0].label.includes("圣履姬"), true)
  assert.equal(resolved[0].role, "画面中央的主体")
  assert.equal(resolved[2].role, "画面角色") // 空 role 兜底
  for (const item of resolved) assert.match(item.image, /qlogo\.cn|qq\.com/)
})

test("resolveMemberAvatarReferences: 幻觉 qq(未被提及)一律丢弃", async () => {
  const { resolveMemberAvatarReferences } = await import("../apps/lib/avatarReference.js")
  const resolved = resolveMemberAvatarReferences(
    [
      { qq: "11111111", role: "主体" },
      { qq: "99999999", role: "编造的成员" }
    ],
    { memberMap: MEMBER_MAP, atQq: [11111111] }
  )
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].qq, "11111111")
})

test("resolveMemberAvatarReferences: 候选含发送者与回复目标;无任何提及则空", async () => {
  const { resolveMemberAvatarReferences } = await import("../apps/lib/avatarReference.js")
  const selfAvatar = resolveMemberAvatarReferences([{ qq: "10001", role: "画我自己" }], { currentUserId: 10001 })
  assert.equal(selfAvatar.length, 1)
  const replyAvatar = resolveMemberAvatarReferences([{ qq: "22222222", role: "他" }], { replyTargetUserId: 22222222 })
  assert.equal(replyAvatar.length, 1)
  const none = resolveMemberAvatarReferences([{ qq: "11111111", role: "x" }], {})
  assert.equal(none.length, 0)
})

test("resolveMemberAvatarReferences: 重复指认与非法输入被吞掉", async () => {
  const { resolveMemberAvatarReferences } = await import("../apps/lib/avatarReference.js")
  const resolved = resolveMemberAvatarReferences(
    [{ qq: "11111111", role: "a" }, { qq: "11111111", role: "b" }, null, "garbage", { qq: "", role: "c" }],
    { atQq: [11111111] }
  )
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].role, "a")
})

test("assembleReferenceImages: 清单与数组同源派生,头像前有用户图时编号顺延", async () => {
  const { assembleReferenceImages } = await import("../apps/lib/avatarReference.js")
  const quotedImage = "https://multimedia.nt.qq.com.cn/download?fileid=abc"
  const { images, manifest } = assembleReferenceImages({
    existingImages: [quotedImage],
    resolved: [{ image: "https://q1.qlogo.cn/g?b=qq&nk=853103024", label: "水水水水(QQ:853103024)", role: "画面主体" }]
  })
  assert.equal(images.length, 2)
  assert.equal(images[0], quotedImage, "用户图在前")
  assert.match(manifest, /参考图1~1: 用户提供的图片\(画风\/内容参考\)/)
  assert.match(manifest, /参考图2\(按附加顺序\): 水水水水\(QQ:853103024\) → 角色:画面主体/)
  assert.ok(!/参考图1\(按附加顺序\)/.test(manifest), "头像不再占用参考图1编号")
})

test("assembleReferenceImages: compose 角色文本变化,纯头像时无用户图行", async () => {
  const { assembleReferenceImages } = await import("../apps/lib/avatarReference.js")
  const compose = assembleReferenceImages({
    existingImages: ["https://x/a.jpg"],
    resolved: [{ image: "https://q1.qlogo.cn/g?b=qq&nk=1", label: "甲(QQ:1)", role: "配角" }],
    existingRole: "compose"
  })
  assert.match(compose.manifest, /内容\/主体需保留在画面中/)
  const pureAvatar = assembleReferenceImages({
    resolved: [{ image: "https://q1.qlogo.cn/g?b=qq&nk=2", label: "乙(QQ:2)", role: "主体" }]
  })
  assert.ok(!/用户提供的图片/.test(pureAvatar.manifest))
  assert.match(pureAvatar.manifest, /参考图1\(按附加顺序\): 乙\(QQ:2\) → 角色:主体/)
})

test("normalizeToolDecision: userImagesRole 校验透传,非法值回落 style", async () => {
  const { normalizeToolDecision } = await import("../apps/lib/semanticToolIntent.js")
  const host = {
    buildImageGenerationPrompt: context => `GEN:${context.prompt || ""}`,
    toolInstances: { bananaTool: { normalizeParameters: params => ({ ...params }) } }
  }
  const withRole = normalizeToolDecision(host, {
    intent: "image_generate", confidence: 0.9,
    references: [{ qq: "11111111", role: "主体" }],
    userImagesRole: "ignore"
  }, { args: "画一张图", availableToolNames: ["bananaTool"], atQq: [11111111] })
  assert.equal(withRole.params.userImagesRole, "ignore")

  const badRole = normalizeToolDecision(host, {
    intent: "image_generate", confidence: 0.9,
    references: [{ qq: "11111111", role: "主体" }],
    userImagesRole: "delete-everything"
  }, { args: "画一张图", availableToolNames: ["bananaTool"], atQq: [11111111] })
  assert.ok(!Object.hasOwn(badRole.params, "userImagesRole"), "非法值不透传(执行层按 style 处理)")

  const noRole = normalizeToolDecision(host, {
    intent: "image_generate", confidence: 0.9
  }, { args: "画一张图", availableToolNames: ["bananaTool"] })
  assert.ok(!Object.hasOwn(noRole.params, "userImagesRole"))
})

function buildNormalizeHost() {
  return {
    buildImageGenerationPrompt: context => `GEN:${context.prompt || ""}`,
    buildImageEditPrompt: () => "EDIT",
    toolInstances: {
      bananaTool: {
        normalizeParameters: params => ({ ...params })
      }
    }
  }
}

test("normalizeToolDecision: image_generate + 合法 references → params 携带 references", async () => {
  const { normalizeToolDecision } = await import("../apps/lib/semanticToolIntent.js")
  const decision = normalizeToolDecision(buildNormalizeHost(), {
    intent: "image_generate",
    confidence: 0.9,
    references: [
      { qq: "11111111", role: "画面中央的主体" },
      { qq: "88888888", role: "幻觉" }
    ]
  }, {
    args: "生成一张图片",
    availableToolNames: ["bananaTool"],
    atQq: [11111111]
  })
  assert.equal(decision.toolName, "bananaTool")
  assert.equal(decision.params.references.length, 1)
  assert.equal(decision.params.references[0].qq, "11111111")
})

test("normalizeToolDecision: tool 路径选 bananaTool 时 references 同样注入", async () => {
  const { normalizeToolDecision } = await import("../apps/lib/semanticToolIntent.js")
  const decision = normalizeToolDecision(buildNormalizeHost(), {
    intent: "tool",
    toolName: "bananaTool",
    confidence: 0.9,
    params: { prompt: "画一张恶魔天使图" },
    references: [{ qq: "22222222", role: "左侧的恶魔" }]
  }, {
    availableToolNames: ["bananaTool"],
    atQq: [22222222]
  })
  assert.equal(decision.intent, "tool")
  assert.equal(decision.params.references.length, 1)
  assert.equal(decision.params.references[0].role, "左侧的恶魔")
})

test("normalizeToolDecision: references 全部非法时静默忽略,不影响画图意图", async () => {
  const { normalizeToolDecision } = await import("../apps/lib/semanticToolIntent.js")
  const decision = normalizeToolDecision(buildNormalizeHost(), {
    intent: "image_generate",
    confidence: 0.9,
    references: [{ qq: "77777777", role: "幻觉" }]
  }, { args: "画一张图", availableToolNames: ["bananaTool"] })
  assert.equal(decision.toolName, "bananaTool")
  assert.equal(decision.params.references, undefined)
})

test("路由让路:显式生图但提及了成员 → 不抢快路,语义规划器获得决策权", async () => {
  const { resolveToolRoute } = await import("../utils/routeDecision.js")
  let plannerContext = null
  const session = {
    tools: [],
    groupUserMessages: [{ role: "user", content: "生成一张图片" }],
    atQq: [11111111, 22222222, 33333333],
    memberMap: MEMBER_MAP,
    groupContextAssets: {}
  }
  const route = await resolveToolRoute({
    intentText: "生成一张图片中间是@翠月 的头像，两边恶魔和天使分别是@杂鱼 和@多一律",
    args: "生成一张图片",
    modelIntent: "image_generate",
    images: [],
    videos: [],
    groupId: "g1",
    userId: "10001",
    botName: "测试bot",
    config: {},
    session,
    availableTools: ["bananaTool", "searchInformationTool"],
    promptContext: () => ({}),
    imageGenerationReferenceImages: () => [],
    applyTools: names => {
      session.tools = names.map(name => ({ type: "function", function: { name } }))
      return session.tools
    },
    log: () => {},
    helpers: {
      resolveSingularOwnerMention: () => null,
      resolveForcedReplyTextRate: async () => 0.4,
      buildForcedToolCall: (name, params) => ({ type: "function", function: { name, arguments: JSON.stringify(params) } }),
      buildToolCallFromDecision: decision => ({
        tools: [{ type: "function", function: { name: decision.toolName } }],
        toolName: decision.toolName,
        toolCall: { type: "function", function: { name: decision.toolName, arguments: "{}" } },
        intent: decision.intent || ""
      }),
      buildImageEditPrompt: () => "EDIT",
      buildImageGenerationPrompt: () => "GEN",
      resolveContextualDrawGeneration: () => null,
      classifySemanticToolIntent: async context => {
        plannerContext = context
        return {
          intent: "image_generate",
          toolName: "bananaTool",
          params: { prompt: "GEN", images: [], references: [{ qq: "11111111", role: "画面中央的主体" }] }
        }
      },
      semanticSessionTools: () => session.tools
    }
  })
  assert.equal(route.toolChoice.function.name, "bananaTool")
  assert.ok(plannerContext, "语义规划器应被调用")
  assert.equal(plannerContext.atQq?.length, 3, "规划器应收到被@名单")
  assert.equal(plannerContext.memberMap, MEMBER_MAP, "规划器应收到成员表")
})

test("路由让路:无提及时显式生图保持快路,规划器不被调用", async () => {
  const { resolveToolRoute } = await import("../utils/routeDecision.js")
  let plannerCalled = false
  const session = { tools: [], groupUserMessages: [{ role: "user", content: "生成一张猫图" }] }
  const route = await resolveToolRoute({
    intentText: "生成一张猫图",
    modelIntent: "image_generate",
    images: [],
    videos: [],
    groupId: "g1",
    userId: "10001",
    botName: "测试bot",
    config: {},
    session,
    availableTools: ["bananaTool"],
    promptContext: () => ({}),
    imageGenerationReferenceImages: () => [],
    applyTools: names => {
      session.tools = names.map(name => ({ type: "function", function: { name } }))
      return session.tools
    },
    log: () => {},
    helpers: {
      resolveSingularOwnerMention: () => null,
      resolveForcedReplyTextRate: async () => 0.4,
      buildForcedToolCall: (name, params) => ({ type: "function", function: { name, arguments: JSON.stringify(params) } }),
      buildToolCallFromDecision: () => null,
      buildImageEditPrompt: () => "EDIT",
      buildImageGenerationPrompt: () => "GEN",
      resolveContextualDrawGeneration: () => null,
      classifySemanticToolIntent: async () => {
        plannerCalled = true
        return null
      },
      semanticSessionTools: () => session.tools
    }
  })
  assert.equal(route.toolChoice.function.name, "bananaTool")
  assert.equal(plannerCalled, false)
})

test("能力声明: bananaTool 的 disclosure 进入主模型可见清单", async () => {
  await import("../utils/toolManifestRegistry.js")
  const { buildToolIntentDisclosure } = await import("../utils/toolIntentManifests.js")
  const disclosure = buildToolIntentDisclosure(["bananaTool"])
  assert.match(disclosure, /群友头像参考/)
  assert.match(disclosure, /references/)
})

test("能力声明: 触发词语义保持原样——banana 不因画图措辞成为候选,提及成员才放行规划器", async () => {
  await import("../utils/toolManifestRegistry.js")
  const { selectToolIntentCandidates } = await import("../utils/toolIntentManifests.js")
  const { shouldRunSemanticToolPlanner } = await import("../utils/semanticToolPolicy.js")
  const tools = ["bananaTool", "searchInformationTool"]
  assert.deepEqual(selectToolIntentCandidates("生成一张图片中间是@翠月 的头像", tools), [])
  assert.deepEqual(selectToolIntentCandidates("画一张恶魔和天使", tools), [])
  assert.deepEqual(selectToolIntentCandidates("看看他的头像", tools), [])
  assert.deepEqual(selectToolIntentCandidates("你画啥呢", tools), [])
  // 提及成员是结构性信号:即使画图措辞不进候选,规划器也获得判定权
  assert.equal(shouldRunSemanticToolPlanner({ hasMemberMentions: true }), true)
  assert.equal(shouldRunSemanticToolPlanner({ hasMemberMentions: false }), false)
})

test("回复自带的 @ 不再被当成指名入画:注解渲染为回复前缀并给出成员名", async () => {
  const { buildAnnotatedClassifierText } = await import("../apps/lib/semanticToolIntent.js")
  const memberMap = new Map([[3188163302, { user_id: 3188163302, card: "maela", nickname: "霜落" }]])
  const raw = "[CQ:reply,id=1444852582][CQ:at,qq=3188163302] 希洛保留原图的设计风格和感觉,画一张博丽灵梦的图"
  const { userText, replyPrefixName } = buildAnnotatedClassifierText(raw, { memberMap })
  assert.equal(replyPrefixName.includes("maela"), true)
  assert.match(userText, /^\(回复了 @maela[^)]* 的消息\) 希洛保留原图/)
  assert.ok(!userText.startsWith("@maela"), "开头的回复@不应再以普通@形态出现")

  const plain = "希洛帮我生成一张图片中间是[CQ:at,qq=11111111] 的头像"
  const plainResult = buildAnnotatedClassifierText(plain, { memberMap })
  assert.equal(plainResult.replyPrefixName, "")
  assert.match(plainResult.userText, /中间是@QQ:11111111 的头像/)
})

test("extractEmbeddedToolCalls: 解析降级模型的文本型工具调用并给出剩余文本", async () => {
  const { extractEmbeddedToolCalls } = await import("../utils/toolIntentManifests.js")
  const content = "先查一下规则。\n```json\n{\"name\":\"searchInformationTool\",\"params\":{\"query\":\"CoC7 临时疯狂\"}}\n```\n```json\n{\"name\":\"bananaTool\",\"prompt\":\"x\"}\n```"
  const { calls, remainder } = extractEmbeddedToolCalls(content)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].name, "searchInformationTool")
  assert.equal(calls[0].params.query, "CoC7 临时疯狂")
  assert.equal(calls[1].name, "bananaTool")
  assert.equal(remainder, "先查一下规则。")

  const plain = extractEmbeddedToolCalls("普通回复,没有工具调用")
  assert.equal(plain.calls.length, 0)
  assert.equal(plain.remainder, "普通回复,没有工具调用")

  const notTool = extractEmbeddedToolCalls("数据:\n```json\n{\"foo\":1}\n```")
  assert.equal(notTool.calls.length, 0, "非工具形状的 JSON 块不解析")
  assert.ok(notTool.remainder.includes("foo"))
})

test("looksLikeCodeOrMarkdown: 中文规则式 markdown(粗体/行内码/列表)判为卡面", async () => {
  const { looksLikeCodeOrMarkdown } = await import("../apps/lib/textPolicy.js")
  const cocReply = "CoC 7版里，调查员**一次性损失5点或以上理智**时，要立刻进行一次**智力检定**：\n- **成功**：理解了恐怖真相，陷入临时疯狂，持续 `1D10` 小时。\n- **失败**：大脑暂时压下了这段认知，不会临时疯狂。\n临时疯狂开始时会先触发一次**疯狂发作**，持续 `1D10` 轮。"
  assert.equal(looksLikeCodeOrMarkdown(cocReply), true)
  assert.equal(looksLikeCodeOrMarkdown("哈哈今天天气不错\n出去走走\n买了杯奶茶"), false)
  assert.equal(looksLikeCodeOrMarkdown("就一句**强调**的话\n第二行\n第三行"), false, "单个粗体不触发")
  assert.equal(looksLikeCodeOrMarkdown("如下:\n```js\nconst a = 1\n```"), true, "围栏代码仍触发")
})
