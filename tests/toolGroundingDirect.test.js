import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { decideToolContinuation, formatDirectToolResult } from "../utils/toolContinuationPolicy.js"

function readPluginSources() {
  const libDir = path.join(root, "apps/lib")
  const parts = [fs.readFileSync(path.join(root, "apps/test.js"), "utf8")]
  for (const file of fs.readdirSync(libDir).filter(f => f.endsWith(".js"))) {
    parts.push(fs.readFileSync(path.join(libDir, file), "utf8"))
  }
  return parts.join("\n")
}


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("member info is a known-fact tool that bypasses the polish model", () => {
  assert.equal(decideToolContinuation([{ toolName: "memberInfoTool" }]), "direct_result")
  assert.equal(decideToolContinuation([{ toolName: "excelWorkbookTool" }]), "direct_result")
})

test("failed known-fact results are not sent raw to the group", () => {
  assert.equal(
    decideToolContinuation([{ toolName: "memberInfoTool", result: "error: 获取成员信息失败" }]),
    "tool_loop",
    "失败结果必须走失败路径，不能直发原文"
  )
  assert.equal(
    decideToolContinuation([{ toolName: "excelWorkbookTool", result: "error: 文件解析失败" }]),
    "tool_loop"
  )
})

test("member info direct result is formatted as readable facts without a model", () => {
  const serialized = JSON.stringify({
    action: "member_info",
    success: true,
    data: {
      user_id: 123456,
      nickname: "小明",
      card: "无群名片",
      role: "群主",
      level: 12,
      title: "无头衔",
      join_time: "2024-01-01 10:00",
      last_sent_time: "2026-09-17 09:00",
      shut_up_timestamp: "未被禁言",
      sex: "男",
      age: "未知",
      area: "未知"
    }
  })
  const text = formatDirectToolResult("memberInfoTool", serialized)
  assert.ok(text.includes("QQ 123456"))
  assert.ok(!text.includes("{"), "不应直出 JSON")
  assert.ok(text.includes("身份 群主"))
  // 非结构化结果原样透传（去掉 error 前缀）
  assert.equal(formatDirectToolResult("excelWorkbookTool", "error: x\nA1: 3"), "x\nA1: 3")
})

test("rewrite chain no longer re-guards pre-guarded final replies", () => {
  const src = readPluginSources()
  assert.ok(src.includes("{ alreadyGuarded = false } = {}"), "sendSegmentedMessage 需要已守卫标记")
  assert.ok(src.includes("typeof output === \"string\" && !alreadyGuarded"), "守卫只在未预处理文本上执行")
  assert.ok(src.includes("this.sendSegmentedMessage(e, output, 0.5, { alreadyGuarded: true })"), "handleTextResponse 最终发送必须声明已守卫")
  assert.ok(!src.includes("formatToolResult(content, toolName)"), "死代码 formatToolResult 应已删除")
})
