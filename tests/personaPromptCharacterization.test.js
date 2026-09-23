// 人设提示词特征快照(characterization)测试:
// 钉住"默认人设(希洛)"下各提示词投影的当前行为,保证重构不悄悄改变喂给模型的内容;
// 同时钉住"改名后不再残留希洛"的目标行为(人设单一数据源)。
// 以及 personaGuard 坏模式表在代码默认值与 yaml 配置之间的漂移防护。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildPersonaStyleOverride, resolvePersonaName, renderPersonaTemplate } from "../utils/personaSource.js"
import { buildPersonaTonePrompt } from "../utils/personaTonePolicy.js"
import { FULL_PROMPT_LAYERS, CHAT_PROMPT_LAYERS, resolvePromptLayerProfile, applyPromptLayerProfile } from "../utils/promptLayers.js"
import { PersonaFeedbackManager, DEFAULT_BAD_PATTERNS } from "../domains/memory/PersonaFeedbackManager.js"

const DEFAULT_PERSONA = { name: "希洛" }

test("buildPersonaStyleOverride 默认人设输出保持稳定(特征快照)", () => {
  const prompt = buildPersonaStyleOverride(DEFAULT_PERSONA)
  const lines = prompt.split("\n")

  assert.equal(lines[0], "【希洛口吻优先规则】")
  assert.equal(lines[1], "你现在说话的人格是 希洛：有点话痨、会害羞、带点慵懒、会接梗拆台、熟人感强，不是客服、助手或说明书。")
  assert.equal(lines.length, 19)
  // 关键规则逐字钉住(事故驱动累积的规则不允许在重构中静默丢失)
  assert.ok(prompt.includes("- 禁止在回复结尾自我审稿或道歉式收尾"))
  assert.ok(prompt.includes("- 谐音套话陷阱：算术、数量、翻译、常识题的答案若裸着读会构成称呼或恶俗谐音"))
  assert.ok(prompt.includes("仍保持口语和希洛口吻"))
  // 慵懒守卫:语气层面的松弛必须与"任务照常接住"绑定,防止懒散渗入执行力
  assert.ok(prompt.includes("懒是语气不是态度，该接的话题和任务要照常接住"))
  // 软度守卫:懒必须是软的,防止"话少+推开"叠加成冷漠
  assert.ok(prompt.includes("懒要懒得软：话可以少、语气不能冷"))
  assert.ok(prompt.includes("禁止“别自己加戏”“又怎么了我”“我哪有”这类干巴巴的推开话"))
  // 坦然守卫:善意被点破要大方承认,防止一律防御性否认
  assert.ok(prompt.includes("善意被点破时大大方方承认"))
  assert.ok(prompt.includes("“我对大家都好呀”"))
  // 光明正大守卫(与坦然守卫合并后保留核心句):温柔与慵懒都摆在明面上,不藏不心虚
  assert.ok(prompt.includes("不藏心思、不绕弯子、不心虚"))
  assert.ok(prompt.includes("懒也是光明正大的懒，想歇就歇、不愧疚不找借口"))
  // 调皮守卫:熟人接梗拆台是维度不是默认,边界(损梗不损人/低落收起)必须与能力绑定
  assert.ok(prompt.includes("熟人之间可以调皮：接梗、轻轻拆台、慢半拍地反打一下"))
  assert.ok(prompt.includes("调皮损的是梗不是人，对方在认真提问或情绪低落时立刻收起"))
})

test("buildPersonaStyleOverride 改名后不残留硬编码希洛(单一数据源)", () => {
  const prompt = buildPersonaStyleOverride({ name: "小白" })
  assert.equal(prompt.split("\n")[0], "【小白口吻优先规则】")
  assert.ok(prompt.includes("你现在说话的人格是 小白"))
  assert.ok(prompt.includes("仍保持口语和小白口吻"))
  assert.ok(!prompt.includes("希洛"), "改名后提示词不应残留默认人设名")
})

test("resolvePersonaName 空值回退默认名", () => {
  assert.equal(resolvePersonaName(), "希洛")
  assert.equal(resolvePersonaName({ name: "   " }), "希洛")
  assert.equal(resolvePersonaName({ name: "小白" }), "小白")
})

test("buildPersonaStyleOverride 身份句派生自 persona.identity(单一数据源)", () => {
  // 有 identity:剥掉"QQ群里的X"前缀后作为身份句,补句号
  const withIdentity = buildPersonaStyleOverride({
    name: "希洛",
    identity: "QQ 群里的希洛，有点话痨但会害羞，不是客服，也不是说明书"
  })
  assert.ok(withIdentity.includes("你现在说话的人格是 希洛：有点话痨但会害羞，不是客服，也不是说明书。"))

  // identity 不带群前缀时直接使用
  const bare = buildPersonaStyleOverride({ name: "小白", identity: "冷静的观察者，偶尔毒舌" })
  assert.ok(bare.includes("你现在说话的人格是 小白：冷静的观察者，偶尔毒舌。"))

  // 改名 + 自定义 identity 后不残留默认人设名
  assert.ok(!bare.includes("希洛"))
})

test("renderPersonaTemplate 渲染 systemContent 占位符,旧配置原样保留", () => {
  assert.equal(
    renderPersonaTemplate("你是QQ群里的群友{personaName}。", { name: "小白" }),
    "你是QQ群里的群友小白。"
  )
  assert.equal(
    renderPersonaTemplate("你是QQ群里的群友希洛。", { name: "小白" }),
    "你是QQ群里的群友希洛。",
    "旧配置写死名字时不做替换(用户显式文本优先)"
  )
  assert.equal(renderPersonaTemplate("", { name: "小白" }), "")
  assert.equal(renderPersonaTemplate("{personaName}和{personaName}", { name: "小白" }), "小白和小白")
})

test("config_default 的 systemContent 使用 {personaName} 占位符而非写死人设名", () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const yamlText = fs.readFileSync(path.resolve(here, "../config_default/message.yaml"), "utf8")
  assert.ok(
    yamlText.includes("你是QQ群里的群友{personaName}。"),
    "默认 systemContent 应使用占位符,改名时自动跟随"
  )
})

test("buildPersonaTonePrompt 三种模式与默认人设头(特征快照)", () => {
  const social = buildPersonaTonePrompt({ userText: "哈哈今天好累", persona: DEFAULT_PERSONA })
  assert.ok(social.startsWith("【希洛场景口吻】\n"))
  assert.ok(social.includes("本轮是普通群聊"))

  const precise = buildPersonaTonePrompt({ userText: "解释一下 Redis 为什么连不上", persona: DEFAULT_PERSONA })
  assert.ok(precise.startsWith("【希洛场景口吻】\n"))
  assert.ok(precise.includes("本轮是科普、技术、事实或需要准确性的解释"))

  const operational = buildPersonaTonePrompt({ userText: "发一下结果", toolName: "googleImageAnalysisTool", persona: DEFAULT_PERSONA })
  assert.ok(operational.includes("本轮是在交付或说明一个具体动作的结果"))
})

test("buildPersonaTonePrompt 改名后头衔跟随(单一数据源)", () => {
  const prompt = buildPersonaTonePrompt({ userText: "在吗", persona: { name: "小白" } })
  assert.ok(prompt.startsWith("【小白场景口吻】"))
  assert.ok(!prompt.includes("希洛"))
})

test("PersonaFeedbackManager.buildFeedbackPrompt 支持人设名注入", () => {
  const manager = new PersonaFeedbackManager({ logger: null })
  // 无历史反馈数据时输出为空,不涉及名字;这里只验证传参路径不抛错
  assert.equal(typeof manager.buildFeedbackPrompt({ enabled: true, maxPromptItems: 4 }, { personaName: "小白" }), "string")
})

test("分层画像:闲聊保底层与任务全量层的选取与顺序(特征快照)", () => {
  const chat = resolvePromptLayerProfile({ responseKind: "chat", modelIntent: "", requiredToolNames: [] })
  assert.equal(chat.profile, "chat")
  assert.deepEqual(chat.layers, ["identityBindings", "emotion", "memory", "personaTone", "personaFeedback"])

  const task = resolvePromptLayerProfile({ responseKind: "chat", modelIntent: "image_generate" })
  assert.equal(task.profile, "task")
  assert.equal(task.reason, "intent:image_generate")
  assert.deepEqual(task.layers, FULL_PROMPT_LAYERS)

  // 拼装顺序必须保持 FULL_PROMPT_LAYERS 定义序
  const layerMap = Object.fromEntries(FULL_PROMPT_LAYERS.map(name => [name, `<${name}>`]))
  const applied = applyPromptLayerProfile(task, layerMap)
  assert.equal(applied.prompt, FULL_PROMPT_LAYERS.map(name => `<${name}>`).join("\n"))
  assert.deepEqual(applied.omitted, [])

  const chatApplied = applyPromptLayerProfile(chat, layerMap)
  assert.equal(chatApplied.prompt, CHAT_PROMPT_LAYERS.map(name => `<${name}>`).join("\n"))
})

test("漂移防护:personaGuard 坏模式表 yaml 与代码默认值一致", () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const yamlPath = path.resolve(here, "../config_default/message.yaml")
  const yamlText = fs.readFileSync(yamlPath, "utf8")

  // 粗解析 personaGuard.badPatterns 列表(避免引入 yaml 依赖差异)
  const section = yamlText.split("personaGuard:")[1]?.split("globalStyleLearning:")[0] || ""
  const patterns = [...section.matchAll(/^\s*-\s*(.+)$/gm)].map(match => match[1].trim())
  assert.ok(patterns.length >= DEFAULT_BAD_PATTERNS.length, "yaml 坏模式表不应少于代码默认值")
  for (const pattern of DEFAULT_BAD_PATTERNS) {
    assert.ok(patterns.includes(pattern), `yaml personaGuard.badPatterns 缺少代码默认项: ${pattern}`)
  }
})
