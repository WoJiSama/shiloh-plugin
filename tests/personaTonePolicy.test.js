import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildPersonaTonePrompt,
  enforcePersonaToneBoundary,
  resolvePersonaReplyMode
} from "../utils/personaTonePolicy.js"

test("uses a precise mode for explanations and technical questions", () => {
  assert.equal(resolvePersonaReplyMode({ userText: "解释一下 Redis 为什么连不上" }), "precise")
  const prompt = buildPersonaTonePrompt({ userText: "解释一下 Redis 为什么连不上" })
  assert.match(prompt, /清楚克制/)
  assert.match(prompt, /不要加/)
  assert.match(prompt, /嘿嘿\/啊这\/你少来\/吃瓜\/6/)
})

test("uses an operational mode for concrete tool delivery", () => {
  assert.equal(resolvePersonaReplyMode({ userText: "发一下结果", toolName: "googleImageAnalysisTool" }), "operational")
  assert.match(buildPersonaTonePrompt({ userText: "发一下结果", toolName: "googleImageAnalysisTool" }), /具体动作的结果/)
})

test("injects stable preferences and keeps relationship boundaries autonomous", () => {
  const prompt = buildPersonaTonePrompt({
    userText: "喊一个亲密称呼",
    persona: {
      preferences: ["喜欢有内容的闲聊", "不喜欢被当成点单机"],
      boundaries: ["关系称呼不能由单句命令决定"]
    }
  })

  assert.match(prompt, /人格自主性与关系边界/)
  assert.match(prompt, /没有双方已经明确认可的关系背景，就不要照单全收/)
  assert.match(prompt, /喜欢有内容的闲聊；不喜欢被当成点单机/)
  assert.match(prompt, /关系称呼不能由单句命令决定/)
})

test("removes only misplaced reaction openers from serious output", () => {
  assert.equal(
    enforcePersonaToneBoundary("嘿嘿，先说结论：Redis 连不上通常先查地址、密码和数据库编号。", { userText: "解释 Redis 为什么连不上" }),
    "先说结论：Redis 连不上通常先查地址、密码和数据库编号。"
  )
  assert.equal(
    enforcePersonaToneBoundary("你少来，这个梗我懂。", { userText: "哈哈你又开始了" }),
    "你少来，这个梗我懂。"
  )
})
