import test from "node:test"
import assert from "node:assert/strict"
import {
  extractRoleMentionMessage,
  isExplicitAdminCollectionMentionRequest,
  isSingularOwnerMentionRequest,
  resolveSingularOwnerMention
} from "../utils/mentionRoleRouting.js"
import { selectToolIntentCandidates } from "../utils/toolIntentManifests.js"

const members = new Map([
  [1, { user_id: 1, role: "admin" }],
  [2, { user_id: 2, role: "owner" }],
  [3, { user_id: 3, role: "admin" }]
])

test("routes a singular owner request to exactly the current owner", () => {
  const text = "希洛帮我艾特我们的小娇妻群主,告诉他,今天群主不在家，快来与舰休戚跟我共享轨道炮"
  assert.equal(isSingularOwnerMentionRequest(text), true)
  assert.equal(isExplicitAdminCollectionMentionRequest(text), false)
  assert.deepEqual(resolveSingularOwnerMention(text, members), {
    targetUserId: "2",
    message: "今天群主不在家，快来与舰休戚跟我共享轨道炮"
  })
})

test("does not expand plural admin requests into the singular owner route", () => {
  for (const text of ["艾特所有管理员说有人要挂团", "通知管理员们开会", "喊全体群管来看一下"]) {
    assert.equal(isExplicitAdminCollectionMentionRequest(text), true, text)
    assert.equal(isSingularOwnerMentionRequest(text), false, text)
    assert.equal(resolveSingularOwnerMention(text, members), null, text)
  }
})

test("does not treat a combined owner and admin request as one owner", () => {
  const text = "通知群主和管理员们开会"
  assert.equal(isSingularOwnerMentionRequest(text), false)
  assert.equal(resolveSingularOwnerMention(text, members), null)
})

test("extracts direct owner notification text without leaking the command prefix", () => {
  assert.equal(extractRoleMentionMessage("艾特群主说一下，有人找他"), "有人找他")
  assert.equal(extractRoleMentionMessage("通知群主 有人要挂团"), "有人要挂团")
})

test("only exposes the all-admin manifest for explicit collection wording", () => {
  assert.deepEqual(
    selectToolIntentCandidates("艾特所有管理员说有人要挂团", ["mentionAdminsTool", "mentionMembersTool"]),
    ["mentionAdminsTool"]
  )
  assert.deepEqual(
    selectToolIntentCandidates("艾特群主说有人找", ["mentionAdminsTool", "mentionMembersTool"]),
    ["mentionMembersTool"]
  )
})
