import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildGenericChatFailureReply,
  buildVisibleChatFailureDetail,
  hasMeaningfulUserText,
  isToneCorrectionMessage
} from "../utils/chatFailureReply.js"

test("tone criticism gets an acknowledgement instead of a greeting fallback", () => {
  const text = "你跟哪学的,怎么感觉阴阳怪气的"

  assert.equal(isToneCorrectionMessage(text), true)
  assert.equal(
    buildGenericChatFailureReply(text, { isGreeting: false }),
    "你说得对，刚才那几句有点顶着你说了，听着确实不舒服。我收一下。"
  )
})

test("a complete request is never described as missing or asks the user to repeat it", () => {
  const output = buildGenericChatFailureReply("我刚才说的你认真看一下", { isGreeting: false })

  assert.match(output, /消息没丢/)
  assert.doesNotMatch(output, /没接住|再发一遍|重新(?:发|说|描述)|叫我吗/)
})

test("real short greetings acknowledge receipt without pretending the greeting was lost", () => {
  const output = buildGenericChatFailureReply("希洛在吗", { isGreeting: true })

  assert.match(output, /我在/)
  assert.match(output, /消息本身没问题/)
  assert.doesNotMatch(output, /没接住|再发|叫我吗/)
})

test("only genuinely empty CQ-only input asks for more text", () => {
  assert.equal(hasMeaningfulUserText("[CQ:at,qq=123] 希洛？"), false)
  assert.equal(hasMeaningfulUserText("希洛希洛根据现行国标GB14887中红灯和绿灯对应波长范围是多少呢"), true)

  const output = buildGenericChatFailureReply("[CQ:at,qq=123] 希洛？")
  assert.match(output, /补一句/)
})

test("failure kinds produce truthful complete-request replies", () => {
  for (const failureKind of ["request", "rate_limit", "timeout", "network", "upstream", "empty"]) {
    const output = buildGenericChatFailureReply("请计算红灯蓝移到蓝光所需的速度", { failureKind })
    assert.match(output, /消息|问题|请求/)
    assert.doesNotMatch(output, /没接住|再发一遍|重新(?:发|说|描述)/)
  }
})

test("authentication failures expose a useful sanitized upstream reason", () => {
  const detail = buildVisibleChatFailureDetail(
    'OpenAI API 请求失败：401 Unauthorized - {"error":{"message":"invalid token","type":"unauthorized_error"}} Bearer sk-secret'
  )
  const output = buildGenericChatFailureReply("总结一下刚刚的群聊", {
    failureKind: "auth",
    failureDetail: detail
  })

  assert.match(detail, /401 Unauthorized/)
  assert.match(detail, /invalid token/)
  assert.doesNotMatch(detail, /sk-secret|Bearer/)
  assert.match(output, /原因：401 Unauthorized/)
})

test("upstream overload is explained in Chinese without claiming the message was lost", () => {
  const output = buildGenericChatFailureReply("请用中文回答：1+1等于几", {
    failureKind: "upstream",
    failureDetail: buildVisibleChatFailureDetail("Our servers are currently overloaded. Please try again later.")
  })

  assert.match(output, /回答服务现在有点忙，这次请求没等到结果/)
  assert.match(output, /上游服务当前负载过高，请稍后重试/)
  assert.doesNotMatch(output, /消息没丢|不用重发|Our servers/i)
})
