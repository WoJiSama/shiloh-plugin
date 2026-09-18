import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createTurnTrace } from "../utils/turnTrace.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("turn trace carries trigger provenance", () => {
  const trace = createTurnTrace({ logger: { info: () => {} } })
  trace.setTrigger("smart_gate", { gateDecision: "continue", gateReason: "user asked bot directly", phase: "focus" })
  assert.equal(trace.record.trigger.mode, "smart_gate")
  assert.equal(trace.record.trigger.gateDecision, "continue")
  assert.equal(trace.record.trigger.phase, "focus")
})

test("timing gate shares the persona and trigger decisions flow into the turn", () => {
  const src = fs.readFileSync(path.join(root, "apps/test.js"), "utf8")
  assert.ok(src.includes("gatePersonaTone"), "Gate prompt 需要注入人设语气")
  assert.ok(src.includes("触发决策与主链路共享同一份人设"), "Gate 与主链路共享人设的说明")
  for (const marker of [
    'e._triggerContext = { mode: "smart_gate", gateDecision: "continue"',
    'e._triggerContext = { mode: "auto_media" }',
    'e._triggerContext = { mode: "red_bag" }',
    'e._triggerContext = { mode: "strict_trigger" }',
    'e._triggerContext = { mode: "conversation_tracking" }'
  ]) {
    assert.ok(src.includes(marker), `missing trigger context: ${marker}`)
  }
  assert.ok(src.includes("if (e?._triggerContext) turnTrace.setTrigger"), "触发来源必须进入 turn trace")
})
