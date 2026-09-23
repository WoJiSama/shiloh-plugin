// 主回复 system prompt 模板快照测试:模板从 apps/test.js 迁到独立模块后,
// 钉住段落顺序与关键内容,防止喂给模型的系统提示被静默改坏。
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildMainSystemPrompt } from "../utils/systemPromptTemplate.js"

const BASE = "你是QQ群里的群友小白。"
const OVERRIDE = "【小白口吻优先规则】\n- 测试覆盖段"
const RUNTIME = { group_info: { group_id: 123, group_name: "测试群" }, environmental_factors: { local_time: "北京时间: 2026/1/1 12:00:00" } }
const ENHANCED = "【角色状态】\n记忆层内容"

test("模板段落顺序:初始化 → 身份 → 人设覆盖 → 实时数据 → 角色状态 → 工具规则 → 消息记录", () => {
  const prompt = buildMainSystemPrompt({
    baseIdentity: BASE,
    personaOverride: OVERRIDE,
    runtimeData: RUNTIME,
    enhancedPrompts: ENHANCED,
    mcpPrompts: "【MCP】工具说明",
    personaName: "小白"
  })

  const order = [
    prompt.indexOf("【认知系统初始化】"),
    prompt.indexOf(BASE),
    prompt.indexOf(OVERRIDE),
    prompt.indexOf("【核心身份原则】"),
    prompt.indexOf('"local_time"'),
    prompt.indexOf("【角色状态】"),
    prompt.indexOf(ENHANCED),
    prompt.indexOf("【行动规划】"),
    prompt.indexOf("【工具调用优先级 - 最高原则】"),
    prompt.indexOf("【MCP】工具说明"),
    prompt.indexOf("【工具使用隐藏规则】"),
    prompt.indexOf("【回复格式规则 - 极其重要】"),
    prompt.indexOf("【群聊消息记录】")
  ]
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], `段落顺序错误: 位置${i}`)
    assert.ok(order[i - 1] > 0, "所有段落必须存在")
  }
  assert.ok(prompt.endsWith("【群聊消息记录】\n"))
})

test("人设名经参数注入,模板文本不硬编码", () => {
  const prompt = buildMainSystemPrompt({ personaName: "小白" })
  assert.ok(prompt.includes("再组织成小白会说的话"))
  assert.ok(!prompt.includes("希洛"), "模板本体不得硬编码默认人设名")
})

test("enhancedPrompts 为空时不输出角色状态段", () => {
  const withState = buildMainSystemPrompt({ enhancedPrompts: ENHANCED })
  const withoutState = buildMainSystemPrompt({ enhancedPrompts: "" })
  assert.ok(withState.includes("【角色状态】"))
  assert.ok(!withoutState.includes("【角色状态】"))
})

test("关键规则内容在迁移后逐字保留", () => {
  const prompt = buildMainSystemPrompt({})
  assert.ok(prompt.includes("4.【事实边界 - 禁止幻想】"))
  assert.ok(prompt.includes("5.【人物指认 - 严禁张冠李戴】"))
  assert.ok(prompt.includes("6.【语义理解框架 - 内部使用，不要输出】"))
  assert.ok(prompt.includes("- 只能把系统明确给出的字段当事实"))
  assert.ok(prompt.includes("绝对禁止在任何回复中显示工具调用代码、函数名称或任何内部执行细节"))
  assert.ok(prompt.includes("你的回复必须是纯文本内容，绝对禁止模仿消息记录的格式"))
  assert.ok(prompt.includes("判断原则：先看\"用户是不是要我做事\"——是 → 调工具"))
})
