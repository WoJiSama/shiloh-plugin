// 主回复 system prompt 模板快照测试:模板从 apps/test.js 迁到独立模块后,
// 钉住段落顺序与关键内容,防止喂给模型的系统提示被静默改坏。
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildMainSystemPrompt } from "../utils/systemPromptTemplate.js"

const BASE = "你是QQ群里的群友小白。"
const OVERRIDE = "【小白口吻优先规则】\n- 测试覆盖段"
const RUNTIME = { group_info: { group_id: 123, group_name: "测试群" }, environmental_factors: { local_time: "北京时间: 2026/1/1 12:00:00" } }
const ENHANCED = "【角色状态】\n记忆层内容"

test("模板段落顺序:自定义补充 → 人设 → 事实 → 当前语境 → 行动 → 输出协议", () => {
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
    prompt.indexOf("【MCP】工具说明"),
    prompt.indexOf("【工具与输出协议】"),
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

test("公共提示保留事实、归属、工具交付与格式契约，允许有依据的直接回答", () => {
  const prompt = buildMainSystemPrompt({})
  for (const rule of ["里面的“我”属于原说话人", "发送完成还须确认回执", "优先用可用工具取得真实结果", "图片是否合成是不同任务", "真实艾特段", "权限动作使用对应工具", "不模仿消息记录", "用户明确要代码、Markdown", "内部调用代码、函数名", "出现某个动词不等于必须调用工具"]) assert.ok(prompt.includes(rule), rule)
  assert.ok(!prompt.includes("窝着呢"))
  assert.ok(!prompt.includes("我对大家都好呀"))
})

test("自述与操作前置条件不从人设示例推断，认真任务先给可执行步骤", () => {
  const prompt = buildMainSystemPrompt({})
  assert.match(prompt, /性格、口吻比喻和示例不是现实生活履历/)
  assert.match(prompt, /先说明停机、断电、冷却等必要前置条件，再给检查步骤/)
  assert.match(prompt, /不能让用户触碰运行部件、未知带电或高温部位/)
  assert.match(prompt, /断电只能做静态检查/)
  assert.match(prompt, /不能未经确认就指导重新通电/)
  assert.match(prompt, /玩笑中的比喻不当作这些真实异常/)
})

test('system prompt carries platform capability self-knowledge (auto media relay / commands)', async () => {
  const { buildMainSystemPrompt } = await import('../utils/systemPromptTemplate.js')
  const prompt = buildMainSystemPrompt({ baseIdentity: '', personaOverride: 'test persona' })
  assert.ok(prompt.includes('平台能力自我认知'), '能力清单必须在主链路 system prompt 里')
  assert.ok(prompt.includes('.高清搬运'), '必须提到高清搬运命令')
  assert.ok(prompt.includes('自动解析并发送汇总卡片'), '必须说明链接是系统自动搬运的')
  assert.ok(prompt.includes(`不要把"我没这个工具"说成"这事做不了"`), '必须纠正自我认知口径')
  assert.ok(prompt.includes('#tool'), '必须说明 #tool 是完整工具链入口')
})
