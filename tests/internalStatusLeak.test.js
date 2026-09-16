import { test } from "node:test"
import assert from "node:assert/strict"
import { containsInternalStatusLeak, detectInternalStatusLeaks, redactInternalStatusLeaks } from "../utils/internalStatusLeak.js"

test("技术讨论与教学回复完全不命中(实锤误杀回归用例)", () => {
  const goodReplies = [
    "零基础别一上来啃复杂框架：先学 Python 基础：变量、函数、列表字典、文件、异常、JSON、简单调试，再学大模型基本用法：API 调用、Prompt、上下文、结构化输出，做两个带工具调用的小项目",
    "建议做成一条兜底链路：1. 先分类：超时、联网搜索失败、模型限流、上下文过长、工具调用失败 2. 轻量重试：同模型重试 1 次，指数退避",
    "模型负责决策，工具负责执行，记忆负责保存状态，函数调用是最核心的能力",
    "这个 API 地址少了 /v1，服务端会把请求打到错误路由，所以才超时。",
    "如果上游服务返回 HTTP 502，先看网关日志，Bad gateway 一般是后段挂了",
    "我来查一下最新消息，稍等"
  ]
  for (const text of goodReplies) {
    assert.deepEqual(detectInternalStatusLeaks(text), [], text.slice(0, 30))
  }
})

test("结构性泄漏被识别:堆栈/错误码/协议JSON/日志行/路径/调用语法", () => {
  const leaks = [
    "at processTicksAndRejections (node:internal/process/task_queues:104:23)",
    "TypeError: fetch failed 连不上",
    "connect ETIMEDOUT 124.223.95.142:80",
    "{\"kind\":\"tool_outcome\",\"status\":\"selection_required\"}",
    "[SmartSkip] group=821466122 reason=below_threshold",
    "文件在 /opt/trss-yunzai/plugins/bl-chat-plugin/config 下",
    "模型输出了 [tool_code] searchInformationTool(查询)",
    "stage=initial elapsed=18627ms"
  ]
  for (const text of leaks) {
    assert.equal(containsInternalStatusLeak(text), true, text.slice(0, 40))
  }
})

test("片段脱敏:正常内容保留,只移除内部片段", () => {
  const mixed = "今天可以按这条线学：\n1. Python 基础和 API 调用\n2. 做两个小项目\n[SmartSkip] group=821466122 reason=below_threshold\n每天一两小时就够。"
  const result = redactInternalStatusLeaks(mixed)
  assert.equal(result.heavy, false)
  assert.match(result.text, /Python 基础/)
  assert.match(result.text, /每天一两小时/)
  assert.doesNotMatch(result.text, /SmartSkip/)
  assert.ok(result.redactedChars > 0)
})

test("重度泄漏回退:通篇内部信息标记 heavy", () => {
  const full = "[SmartSkip] group=821466122 user=925640859 reason=below_threshold msg=test\nstage=initial elapsed=18627ms turn=bd3df263-1234"
  const result = redactInternalStatusLeaks(full)
  assert.equal(result.heavy, true)
})

test("干净文本原样返回", () => {
  const clean = "好的，明天记得带伞。"
  const result = redactInternalStatusLeaks(clean)
  assert.equal(result.text, clean)
  assert.equal(result.redactedChars, 0)
  assert.equal(result.heavy, false)
})
