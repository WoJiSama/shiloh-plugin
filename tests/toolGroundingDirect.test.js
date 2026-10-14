import test from "node:test"
import { readPluginSources } from "./helpers/pluginSources.js"
import assert from "node:assert/strict"
import {replyRenderingFixture} from "./helpers/replyRenderingFixture.js"
import { decideToolContinuation, formatDirectToolResult } from "../utils/toolContinuationPolicy.js"





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

test("rewrite chain no longer re-guards pre-guarded final replies", async () => {
  const {api,host,event,sent,guarded}=replyRenderingFixture()
  await api.sendSegmentedMessage(host,event,"已经守卫的文本",0,{alreadyGuarded:true})
  assert.deepEqual(guarded,[])
  assert.deepEqual(sent,["已经守卫的文本"])
  await api.sendSegmentedMessage(host,event,"原始文本",0)
  assert.deepEqual(guarded,["原始文本"])
  assert.equal(sent[1],"原始文本守卫")
})
