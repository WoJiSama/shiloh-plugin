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

test("公共人格投影不强制所有人设使用同一口吻或台词", () => {
  const prompt = buildPersonaStyleOverride(DEFAULT_PERSONA)
  assert.equal(prompt.split("\n")[0], "【希洛口吻优先规则】")
  assert.ok(prompt.includes("你现在说话的人格是 希洛"))
  assert.ok(prompt.includes("明确任务照常完成"))
  assert.ok(prompt.includes("示例只供理解语气"))
  assert.ok(!prompt.includes("我对大家都好呀"))
  assert.ok(!prompt.includes("懒要懒得软"))
  assert.ok(!prompt.includes("窝在沙发里"))
})

test("buildPersonaStyleOverride 改名后不残留硬编码希洛(单一数据源)", () => {
  const prompt = buildPersonaStyleOverride({ name: "小白" })
  assert.equal(prompt.split("\n")[0], "【小白口吻优先规则】")
  assert.ok(prompt.includes("你现在说话的人格是 小白"))
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

test("默认 systemContent 留给可选补充，避免重复注入整套人格", () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const yamlText = fs.readFileSync(path.resolve(here, "../config_default/message.yaml"), "utf8")
  assert.match(yamlText, /systemContent: ""/)
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
  assert.deepEqual(chat.layers, ["identityBindings", "emotion", "memory", "midtermMemory", "interaction", "personaTone", "personaFeedback"])

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
