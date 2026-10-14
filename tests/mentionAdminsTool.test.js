import test from "node:test"
import assert from "node:assert/strict"
import { MentionAdminsTool } from "../functions/functions_tools/MentionAdminsTool.js"

function event() {
  const sent = []
  return {
    group_id: 100,
    bot: { uin: 1 },
    group: {
      async getMemberMap() {
        return new Map([
          [1, { user_id: 1, role: "admin" }],
          [2, { user_id: 2, role: "admin", card: "小明" }],
          [3, { user_id: 3, role: "owner", card: "小红" }],
          [4, { user_id: 4, role: "member" }]
        ])
      },
      async sendMsg(segments) { sent.push(segments); return {message_id:sent.length} }
    },
    sent
  }
}

test("mentions current admins in one message and excludes the bot", async () => {
  const e = event()
  const tool = new MentionAdminsTool()
  const result = JSON.parse(await tool.execute({ message: "有人要挂团" }, e))
  assert.equal(result.count, 1)
  assert.deepEqual(e.sent[0].filter(item => item.type === "at").map(item => item.data.qq), ["2"])
  assert.equal(e.sent[0].at(-1).data.text, "有人要挂团")
})

test("includes the owner only when explicitly requested", async () => {
  const e = event()
  const tool = new MentionAdminsTool()
  await tool.execute({ includeOwner: true }, e)
  assert.deepEqual(e.sent[0].filter(item => item.type === "at").map(item => item.data.qq), ["2", "3"])
})

test("resolves names and QQ numbers before excluding administrators", async () => {
  const e = event()
  const tool = new MentionAdminsTool()
  const result = await tool.execute({ includeOwner: true, excludeTargets: ["2", "小红"] }, e)
  assert.match(result, /没有可艾特/)
  assert.equal(e.sent.length, 0)
})
