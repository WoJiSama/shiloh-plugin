import test from "node:test"
import assert from "node:assert/strict"
import {
  buildToolGroundingInstruction,
  buildUnavailableToolReply,
  classifyToolResult,
  hasUsableToolResult
} from "../utils/toolResultGrounding.js"

test("classifies empty structured tool payloads as unusable", () => {
  for (const result of ["", "{}", "[]", "null", '{"analysis":null}', '{"analysis":""}', { success: true }]) {
    assert.equal(classifyToolResult(result).kind, "empty", JSON.stringify(result))
  }
})
test("distinguishes errors, not-found results and grounded success", () => {
  assert.equal(classifyToolResult('error: 图片分析失败').kind, "error")
  assert.equal(classifyToolResult('匹配数量: 0\n没有找到匹配项').kind, "not_found")
  assert.equal(classifyToolResult('{"analysis":"图片里写着测试"}').kind, "success")
})

test("preserves structured tool outcomes and gives image-specific unavailable replies", () => {
  const timeout = [{
    toolName: "googleImageAnalysisTool",
    result: JSON.stringify({ kind: "tool_outcome", status: "error", tool: "googleImageAnalysisTool", error: { code: "vision_timeout" } })
  }]
  const expired = [{
    toolName: "googleImageAnalysisTool",
    result: JSON.stringify({ kind: "tool_outcome", status: "error", tool: "googleImageAnalysisTool", error: { code: "image_link_expired" } })
  }]
  assert.equal(classifyToolResult(timeout[0].result).kind, "error")
  assert.match(buildUnavailableToolReply(timeout), /看图等太久/)
  assert.match(buildUnavailableToolReply(expired), /重新发一次原图/)
  assert.doesNotMatch(buildUnavailableToolReply(timeout), /Steam/i)
})

test("explains image provider HTTP failures without leaking an unrelated topic", () => {
  const failure = status => [{
    toolName: "googleImageAnalysisTool",
    result: JSON.stringify({
      kind: "tool_outcome",
      status: "error",
      tool: "googleImageAnalysisTool",
      error: { code: "vision_http", status }
    })
  }]
  assert.match(buildUnavailableToolReply(failure(401)), /授权没有通过/)
  assert.match(buildUnavailableToolReply(failure(429)), /请求太多/)
  assert.match(buildUnavailableToolReply(failure(503)), /临时出错/)
  assert.doesNotMatch(buildUnavailableToolReply(failure(404)), /Steam|Minecraft/i)
})

test("forbids filling empty results from chat history", () => {
  const empty = [{ toolName: "googleImageAnalysisTool", result: "{}" }]
  assert.equal(hasUsableToolResult(empty), false)
  assert.match(buildUnavailableToolReply(empty), /不乱猜/)
  assert.match(buildToolGroundingInstruction(empty), /聊天历史.*绝不能/)
  assert.match(buildToolGroundingInstruction(empty), /googleImageAnalysisTool=empty/)
})

test("keeps generic tool failures honest without falling back to service-status wording", () => {
  const failed = [{ toolName: "searchInformationTool", result: "查询失败: upstream timeout" }]
  const missing = [{ toolName: "modrinthTool", result: "没有找到相关结果" }]
  assert.match(buildUnavailableToolReply(failed), /没查成/)
  assert.doesNotMatch(buildUnavailableToolReply(failed), /查询没有成功|可靠结果/)
  assert.match(buildUnavailableToolReply(missing), /确实没找到/)
  assert.doesNotMatch(buildUnavailableToolReply(missing), /现有结果里没有依据/)
})

test("allows mixed tool rounds to continue only from their usable results", () => {
  const mixed = [
    { toolName: "googleImageAnalysisTool", result: '{"analysis":"标题是测试公告"}' },
    { toolName: "searchInformationTool", result: "未找到相关搜索结果" }
  ]
  assert.equal(hasUsableToolResult(mixed), true)
  const instruction = buildToolGroundingInstruction(mixed)
  assert.match(instruction, /googleImageAnalysisTool=success/)
  assert.match(instruction, /searchInformationTool=not_found/)
})
