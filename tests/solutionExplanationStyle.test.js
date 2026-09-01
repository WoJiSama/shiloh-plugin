import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildSolutionExplanationStylePrompt,
  classifySolutionExplanationRequest
} from "../utils/solutionExplanationStyle.js"

test("technical architecture requests receive a deliverable-first explanation style", () => {
  const request = "帮我搭一个 WPF 工业视觉检测系统，要接 S7 PLC、SQL Server 和机械臂，架构怎么设计？"

  assert.equal(classifySolutionExplanationRequest(request), "solution")
  const prompt = buildSolutionExplanationStylePrompt(request)
  assert.match(prompt, /第一行先给明确的交付或结论/)
  assert.match(prompt, /结论或选择、前置条件、核心模块或步骤、关键接口\/数据流、最小验证/)
  assert.match(prompt, /短代码示例/)
  assert.match(prompt, /结构化知识卡/)
})

test("technical diagnostics distinguish facts, causes, fixes, and verification", () => {
  const prompt = buildSolutionExplanationStylePrompt("Spring Boot 服务部署后报错，帮我排查为什么连不上 Redis")

  assert.match(prompt, /现象与结论 -> 可验证原因 -> 修复动作 -> 验证方式/)
  assert.match(prompt, /确认的事实和推测/)
})

test("short references inherit the technical subject from forwarded context", () => {
  const prompt = buildSolutionExplanationStylePrompt([
    "这个怎么做？",
    "转发了合并聊天记录: 需要做 Prism + WPF 的视觉检测项目，预留 PLC 和 EF 数据库接口"
  ].join("\n"))

  assert.match(prompt, /方案式技术解释/)
})

test("MC mod onboarding receives concrete compatibility and implementation boundaries", () => {
  const prompt = buildSolutionExplanationStylePrompt("希洛给我解释一下，做一个 MC 的 mod 都需要什么")

  assert.match(prompt, /版本、加载器或运行平台/)
  assert.match(prompt, /代码与资源目录/)
  assert.match(prompt, /运行侧边界/)
  assert.match(prompt, /必须先确定/)
  assert.match(prompt, /兼容关系、取舍/)
})

test("ordinary chat does not become a technical template", () => {
  assert.equal(classifySolutionExplanationRequest("希洛你今天怎么这么冷漠"), "")
  assert.equal(buildSolutionExplanationStylePrompt("笑死，这也太离谱了"), "")
})
