import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildAgentProgressContext,
  buildToolFailureReplyInstruction,
  selectAgentReplyContext
} from "../utils/agentReplyComposer.js"

test("keeps system instructions and the current user turn for an agent follow-up", () => {
  const selected = selectAgentReplyContext([
    { role: "system", content: "你是希洛" },
    { role: "user", content: "旧的群聊上下文" },
    { role: "assistant", content: "我会调用工具" },
    { role: "tool", content: "error: timeout" },
    { role: "user", content: "希洛，看看这张 Steam 截图" }
  ])

  assert.deepEqual(selected.map(item => item.role), ["system", "user"])
  assert.equal(selected.at(-1).content, "希洛，看看这张 Steam 截图")
})

test("provides current and quoted context to delayed progress generation", () => {
  const context = buildAgentProgressContext({
    userContent: "希洛，锐评上面那个方案",
    quotedContext: "WPF 项目要连 S7 PLC",
    messages: [{ role: "user", content: "前面在讨论工业视觉检测" }]
  })

  assert.match(context, /锐评上面那个方案/)
  assert.match(context, /WPF 项目要连 S7 PLC/)
  assert.match(context, /工业视觉检测/)
})

test("failure instruction gives the agent facts without internal-status wording", () => {
  const instruction = buildToolFailureReplyInstruction({
    toolName: "googleImageAnalysisTool",
    factualReply: "图片收到了，不过这次没有读到可用内容。我先不乱猜图里的问题。"
  })

  assert.match(instruction, /唯一确认事实/)
  assert.match(instruction, /不要说模型、系统、接口、API、工具、后台/)
  assert.match(instruction, /不要假装已经查到、看到了、修改了或发送了结果/)
})
