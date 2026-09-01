import { test } from "node:test"
import assert from "node:assert/strict"
import { createTurnPlan, deriveTurnPlanRequest } from "../utils/turnPlan.js"

test("short casual turns retain local emoji as an optional tool", () => {
  const plan = createTurnPlan({
    responseKind: "chat",
    intentText: "你看他俩",
    availableCapabilities: ["sendLocalEmojiTool"],
    requiredCapabilities: ["sendLocalEmojiTool"]
  })

  assert.equal(plan.execution.mode, "tool")
  assert.equal(plan.execution.modelProfile, "casual")
  assert.deepEqual(plan.capabilities.required, [])
  assert.deepEqual(plan.capabilities.optional, ["sendLocalEmojiTool"])
  assert.equal(plan.observability.routeReason, "optional_reaction")
  assert.equal(deriveTurnPlanRequest(plan).toolChoice, "auto")
})
