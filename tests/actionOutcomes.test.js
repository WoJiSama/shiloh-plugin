import { test } from "node:test"
import assert from "node:assert/strict"
import { buildCommittedActionReply, recordActionOutcomes } from "../utils/actionOutcomes.js"

test("reports committed group knowledge even when the later chat request fails", () => {
  const session = {}
  recordActionOutcomes(session, "group_knowledge", [{
    kind: "group_file",
    subject: "服务器整合包",
    resource: { fileName: "咖啡建筑档重制版.zip" }
  }])
  assert.equal(buildCommittedActionReply(session), "记住了，“服务器整合包”对应群文件「咖啡建筑档重制版.zip」。")
})

test("formats member definitions and workflow targets from stored entries", () => {
  const session = {}
  recordActionOutcomes(session, "group_knowledge", [{ subject: "星怒", targets: [{ displayName: "星野" }] }])
  recordActionOutcomes(session, "group_workflow", [{ condition: "有人要挂团", targets: [{ displayName: "甲" }, { displayName: "乙" }] }])
  assert.equal(buildCommittedActionReply(session), "记住了：“星怒”指的是星野；遇到“有人要挂团”时通知甲、乙。")
})
