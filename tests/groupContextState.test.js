import test from "node:test"
import assert from "node:assert/strict"
import {
  updateGroupTopic, getGroupTopicPrompt,
  updateGroupSocial, getGroupSocialPrompt,
  resetGroupContextStateForTests
} from "../utils/groupContextState.js"

test("话题关键词滚动更新并过期淘汰", () => {
  resetGroupContextStateForTests()
  for (let i = 0; i < 5; i++) updateGroupTopic({ groupId: "g1", text: "今晚吃什么 火锅还是烧烤" })
  updateGroupTopic({ groupId: "g1", text: "明天要交报告了" })
  const prompt = getGroupTopicPrompt("g1")
  assert.ok(prompt.includes("【群话题】"), "有话题前缀")
  assert.ok(prompt.includes("火锅") || prompt.includes("烧烤"), "高频词进入话题")
  assert.ok(!getGroupTopicPrompt("g-other"), "别的群没有状态")
})

test("互动状态识别对话对与话题中心", () => {
  resetGroupContextStateForTests()
  for (let i = 0; i < 3; i++) {
    updateGroupSocial({ groupId: "g2", fromUserId: "1001", atTargetIds: ["2002"] })
    updateGroupSocial({ groupId: "g2", fromUserId: "2002", atTargetIds: ["1001"] })
  }
  const prompt = getGroupSocialPrompt("g2")
  assert.ok(prompt.includes("【群互动】"), "有互动前缀")
  assert.ok(prompt.includes("话题中心"), "@得最多的人是话题中心")
})

test("reset 清空全部状态", () => {
  resetGroupContextStateForTests()
  updateGroupTopic({ groupId: "g3", text: "测试" })
  resetGroupContextStateForTests()
  assert.equal(getGroupTopicPrompt("g3"), "")
})
