import test from "node:test"
import assert from "node:assert/strict"
import { resolveNaturalDeltaForceToolCall } from "../utils/deltaForceIntent.js"
import { joinIntentParts } from "../utils/messageContext.js"

test("三角洲自然语言解析:指令词清洗后 keyword 只留物品名", () => {
  const call = resolveNaturalDeltaForceToolCall("希洛告诉我三角洲里面 非洲之心 的价格走向", { botName: "希洛" })
  assert.ok(call)
  assert.equal(call.toolName, "deltaForceTool")
  assert.equal(call.params.operation, "price_history")
  assert.equal(call.params.keyword, "非洲之心")
})

test("价格走向映射到 price_history 而不是单点价值", () => {
  const call = resolveNaturalDeltaForceToolCall("三角洲里面非洲之星价格走向", { botName: "希洛" })
  assert.equal(call.params.operation, "price_history")
  assert.equal(call.params.keyword, "非洲之星")
})

test("普通查价仍走 object_value 且 keyword 干净", () => {
  const call = resolveNaturalDeltaForceToolCall("希洛查一下三角洲 曼德尔砖 的价格", { botName: "希洛" })
  assert.equal(call.params.operation, "object_value")
  assert.equal(call.params.keyword, "曼德尔砖")
})

test("改枪码 keyword 不残留指令词", () => {
  const call = resolveNaturalDeltaForceToolCall("三角洲 M7 改枪码 有哪些", { botName: "希洛" })
  assert.equal(call.params.operation, "solution_list")
  assert.equal(call.params.keyword, "M7")
})

test("利润类短语不被走向/走势误判为价格历史", () => {
  const call = resolveNaturalDeltaForceToolCall("三角洲特勤处利润趋势怎么样", { botName: "希洛" })
  assert.equal(call.params.operation, "place_profit")
})

test("joinIntentParts:args 与 msg 相同时不重复拼接", () => {
  const text = "希洛告诉我三角洲里面 非洲之心 的价格走向"
  assert.equal(joinIntentParts(text, text), text)
  assert.equal(joinIntentParts("", text), text)
  // args 是 msg 去掉 #tool 前缀的形态,两者都保留
  assert.equal(joinIntentParts("#tool 查密码", "查密码"), "#tool 查密码\n查密码")
})
