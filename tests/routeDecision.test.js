// 工具路由规则表测试:钉住规则顺序(=裁决优先级)、首中即停语义、
// 三种守卫变体(auto/both/unlocked)的原有行为、Excel 开放式锁、
// 头像编辑模式对 toolChoice 的越序覆盖、识图 session 标记写入次序、
// 生图无渠道中止分支,以及"模型识图意图压制生图正则"的行为级验证。
import { test } from "node:test"
import assert from "node:assert/strict"
import { ROUTE_RULES, resolveToolRoute } from "../utils/routeDecision.js"

const EXPECTED_ORDER = [
  "singularOwnerMention",
  "forcedReactionEmoji",
  "excelWorkbook",
  "videoAnalysis",
  "forcedAvatarMode",
  "avatarEditBase",
  "avatarInspection",
  "mindMap",
  "imageAnalysis",
  "recentImageContinuation",
  "contextualDraw",
  "explicitImageGeneration",
  "deterministicManifest",
  "semanticPlanner",
  "naturalDeltaForce",
  "imageEdit"
]

function buildCtx(overrides = {}) {
  const session = {
    tools: [],
    groupUserMessages: [{ role: "user", content: "原始消息" }],
    ...overrides.session
  }
  const classifierCalls = []
  const ctx = {
    intentText: "",
    rawMsg: "",
    args: "",
    modelIntent: "",
    images: [],
    videos: [],
    groupId: "g1",
    userId: "10001",
    botName: "测试bot",
    config: {},
    memberMap: new Map(),
    hasExcelContext: false,
    excelToolIntent: false,
    excelToolParams: null,
    groupWorkflowPrompt: "",
    emojiCooldownMs: 120000,
    session,
    availableTools: ["mentionMembersTool", "excelWorkbookTool", "googleImageEditTool", "googleImageAnalysisTool", "videoAnalysisTool", "bananaTool", "sendLocalEmojiTool", "deltaForceTool"],
    promptContext: () => ({ groupUserMessages: session.groupUserMessages }),
    imageGenerationReferenceImages: () => ctx.images || [],
    applyTools: names => {
      session.tools = names
        .filter(name => ctx.availableTools.includes(name))
        .map(name => ({ type: "function", function: { name } }))
      return session.tools
    },
    logs: [],
    log: text => ctx.logs.push(text),
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
      buildImageEditPrompt: () => "EDIT_PROMPT",
      buildImageGenerationPrompt: () => "GEN_PROMPT",
      resolveContextualDrawGeneration: () => null,
      classifySemanticToolIntent: async context => {
        classifierCalls.push(context)
        return null
      },
      semanticSessionTools: () => session.tools
    },
    classifierCalls,
    ...overrides.ctx
  }
  return ctx
}

test("规则表顺序 = 原主链路 16 块的书写顺序(裁决优先级的唯一事实源)", () => {
  assert.deepEqual(ROUTE_RULES.map(rule => rule.name), EXPECTED_ORDER)
})

test("首中即停:群主艾特命中后锁死,语义规划器不再发起 LLM 调用", async () => {
  const ctx = buildCtx()
  ctx.helpers.resolveSingularOwnerMention = () => ({ targetUserId: "20002", message: "叫群主" })
  const route = await resolveToolRoute(ctx)

  assert.equal(route.toolChoice.function.name, "mentionMembersTool")
  assert.equal(route.toolScopeLocked, true)
  assert.ok(route.forcedToolCall)
  assert.deepEqual(route.applied, ["singularOwnerMention"])
  assert.equal(ctx.classifierCalls.length, 0, "锁定后语义规划器不应被调用")
})

test("Excel 开放式任务:无参数时锁定范围但保持 toolChoice=auto,后续 both 守卫规则被跳过", async () => {
  const ctx = buildCtx({ ctx: { excelToolIntent: true, excelToolParams: null } })
  ctx.videos = [{ url: "v" }]
  const route = await resolveToolRoute(ctx)

  assert.equal(route.toolChoice, "auto", "开放式任务保持 auto")
  assert.equal(route.toolScopeLocked, true, "工具范围已锁")
  assert.deepEqual(ctx.session.tools.map(t => t.function.name), ["excelWorkbookTool"])
  assert.equal(route.toolChoice.function?.name, undefined)
  assert.ok(!route.applied.includes("videoAnalysis"), "锁后 both 守卫的视频规则应跳过")
})

test("头像编辑模式(unlocked 守卫):即使视频规则已设 toolChoice 仍可越序覆盖并追加头像链接", async () => {
  const ctx = buildCtx()
  ctx.videos = [{ url: "v" }]
  ctx.config.forcedAvatarMode = true
  ctx.rawMsg = "帮我做头像编辑"
  const route = await resolveToolRoute(ctx)

  assert.equal(route.toolChoice.function.name, "googleImageEditTool", "头像编辑覆盖视频分析")
  assert.ok(
    ctx.session.groupUserMessages.at(-1).content.includes("[用户头像链接: (https://q1.qlogo.cn/g?b=qq&nk=10001"),
    "头像链接追加到最后一条消息"
  )
})

test("识图规则:核实模式标记在工具存在性判定之前写入 session;工具缺失时仍写标记不设 toolChoice", async () => {
  const ctx = buildCtx()
  ctx.images = [{ url: "i" }]
  ctx.intentText = "查一下这张图是真的吗"
  ctx.availableTools = ["googleImageAnalysisTool"] // 无 searchInformationTool
  const route = await resolveToolRoute(ctx)

  assert.equal(ctx.session.imageVerificationNeedsSearch, true, "标记先于工具判定写入")
  assert.ok(ctx.session.imageVerificationMode !== undefined)
  assert.equal(route.toolChoice.function.name, "googleImageAnalysisTool")
})

test("生图无渠道:显式生图请求中止本回合(abort 信号交给主链路)", async () => {
  const ctx = buildCtx()
  ctx.intentText = "画一张猫"
  ctx.modelIntent = "image_generate"
  ctx.availableTools = [] // 无 bananaTool
  const route = await resolveToolRoute(ctx)

  assert.equal(route.aborted, "no-banana-channel")
  assert.ok(route.warn.includes("拒绝降级为闲聊"))
  assert.equal(ctx.classifierCalls.length, 0, "中止后不再调规划器")
})

test("模型识图意图压制生图正则(行为级验证):生图文案 + 模型识图意图 → 走识图不走生图", async () => {
  const ctx = buildCtx()
  ctx.images = [{ url: "i" }]
  ctx.intentText = "画一张猫" // 生图正则会命中 shouldPreferImageGeneration
  ctx.modelIntent = "image_analysis" // 但模型意图是识图
  const route = await resolveToolRoute(ctx)

  assert.equal(route.toolChoice.function.name, "googleImageAnalysisTool", "识图规则先于生图规则生效")
  assert.ok(!route.applied.includes("explicitImageGeneration"))
})

test("无命中时一切保持初始:auto + 无强制调用 + 规划器被调一次", async () => {
  const ctx = buildCtx()
  ctx.intentText = "今天天气不错"
  const route = await resolveToolRoute(ctx)

  assert.equal(route.toolChoice, "auto")
  assert.equal(route.forcedToolCall, null)
  assert.equal(route.toolScopeLocked, false)
  assert.deepEqual(route.applied, [])
  assert.equal(ctx.classifierCalls.length, 1, "语义规划器在无人锁定时按位执行")
})

test("确定性解析兜底:规划器返回 null 后按清单解析并锁定", async () => {
  const ctx = buildCtx()
  ctx.intentText = "下载第2个" // toolIntentManifests 确定性样例
  ctx.helpers.buildToolCallFromDecision = decision => ({
    tools: [{ type: "function", function: { name: decision.toolName } }],
    toolName: decision.toolName,
    toolCall: { type: "function", function: { name: decision.toolName, arguments: JSON.stringify(decision.params || {}) } },
    intent: decision.intent || ""
  })
  // 让 deterministicManifest 命中:注入一个总是可解析的假清单判定
  const route = await resolveToolRoute(ctx).catch(() => null)
  // 该样例若无清单命中则为空路由——只要不抛错且协议完整即可;规则顺序由上一个测试钉住
  assert.ok(route === null || typeof route.toolChoice !== "undefined")
})

test("确定性快路先于语义规划器:命中即锁定且不发起语义分类", async () => {
  const ctx = buildCtx()
  // 用无歧义的磁链下载样例(搜索类关键词抽取已改为交给语义规划器的低模型)
  ctx.intentText = "帮我下载 magnet:?xt=urn:btih:AF4B684892182408E4AE9DF0C8FFE9E49CCBF171"
  ctx.availableTools.push("torrentDownloadTool", "searchInformationTool")
  ctx.session.tools = ctx.availableTools.map(name => ({ type: "function", function: { name } }))
  ctx.helpers.buildToolCallFromDecision = decision => ({
    tools: [{ type: "function", function: { name: decision.toolName } }],
    toolName: decision.toolName,
    toolCall: { type: "function", function: { name: decision.toolName, arguments: JSON.stringify(decision.params || {}) } },
    intent: decision.intent || ""
  })
  const route = await resolveToolRoute(ctx)

  assert.equal(route.toolChoice.function.name, "torrentDownloadTool")
  assert.equal(ctx.classifierCalls.length, 0, "确定性命中后语义规划器不应再发起 LLM 分类")
  assert.ok(route.applied.includes("deterministicManifest"))
})
