import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createOutboundArbiter } from "../utils/messagePipeline/outboundArbiter.js"
import { createTurnTrace } from "../utils/turnTrace.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function recorder() {
  const sent = []
  return { sent, reply: async text => { sent.push(text) } }
}

function readPluginSources() {
  const libDir = new URL("../apps/lib/", import.meta.url)
  const parts = [fs.readFileSync(new URL("../apps/test.js", import.meta.url), "utf8")]
  for (const file of fs.readdirSync(libDir).filter(f => f.endsWith(".js"))) {
    parts.push(fs.readFileSync(new URL(file, libDir), "utf8"))
  }
  return parts.join("\n")
}

test("outbound sends are serialized in enqueue order", async () => {
  const state = { gate: Promise.resolve() }
  const sent = []
  const e = { reply: async text => { await state.gate; sent.push(text) } }
  const arbiter = createOutboundArbiter()
  const wrapped = arbiter.wrapEvent(e)
  let releaseFirst
  state.gate = new Promise(resolve => { releaseFirst = resolve })
  const first = wrapped.reply("a")
  const second = wrapped.reply("b")
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(sent, [], "第一条被门闩卡住时，第二条必须排队等待")
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(sent, ["a", "b"])
})

test("reentrant reply inside a dispatched send does not deadlock", async () => {
  const e = recorder()
  const arbiter = createOutboundArbiter()
  const wrapped = arbiter.wrapEvent(e)
  // 模拟 sendSegmentedMessage：一次出队动作内部连续 reply 多段
  await arbiter.enqueue("default", async () => {
    await wrapped.reply("part1")
    await wrapped.reply("part2")
  })
  assert.deepEqual(e.sent, ["part1", "part2"])
  assert.equal(arbiter.stats.sent, 1, "重入的 reply 不重复计数，按一次出队动作计")
})

test("commitment is held while tool outcomes are pending", async () => {
  const e = recorder()
  const arbiter = createOutboundArbiter()
  arbiter.beginToolOutcomes()
  await arbiter.enqueue("commitment", () => e.reply("好，我整理成一张完整卡片发你。"))
  await arbiter.enqueue("default", () => e.reply("进度"))
  assert.deepEqual(e.sent, ["进度"], "承诺被扣住，普通消息照常有序发送")
  assert.equal(arbiter.stats.deferred, 1)

  arbiter.resolveToolOutcomes()
  await arbiter.enqueue("default", () => e.reply("done"))
  assert.deepEqual(e.sent, ["进度", "好，我整理成一张完整卡片发你。", "done"], "工具成功后承诺按原顺序放行")
})

test("commitment is dropped when a tool outcome fails", async () => {
  const e = recorder()
  const arbiter = createOutboundArbiter()
  arbiter.beginToolOutcomes()
  await arbiter.enqueue("commitment", () => e.reply("好，我整理成一张完整卡片发你。"))
  arbiter.markFailure()
  await arbiter.enqueue("default", () => e.reply("失败事实"))
  assert.deepEqual(e.sent, ["失败事实"], "失败后承诺被丢弃，只出事实")
  assert.equal(arbiter.stats.dropped, 1)
})

test("settle drops held commitments when no tool outcome was recorded", async () => {
  const e = recorder()
  const arbiter = createOutboundArbiter()
  arbiter.beginToolOutcomes()
  await arbiter.enqueue("commitment", () => e.reply("承诺"))
  arbiter.settle([])
  assert.deepEqual(e.sent, [], "没有任何工具结果时承诺视为落空，丢弃")
  arbiter.settle([{ toolName: "x", success: true }])
  assert.deepEqual(e.sent, [], "settle 幂等，已落定不再重复处理")
})

test("a failing send does not break the queue", async () => {
  const e = recorder()
  e.reply = async () => { throw new Error("adapter down") }
  const arbiter = createOutboundArbiter()
  await arbiter.enqueue("default", () => e.reply("boom"))
  const after = recorder()
  const ok = after
  await arbiter.enqueue("default", () => ok.reply("fine"))
  assert.deepEqual(after.sent, ["fine"])
})

test("turn trace assembles one structured record", () => {
  const lines = []
  const logger = { info: line => lines.push(line) }
  const trace = createTurnTrace({ groupId: 1, userId: 2, sessionId: "s", logger })
  trace.setIntent("image_generate", 0.9, "model")
  trace.setRoute("tool", "task", "committed_action")
  trace.addModelCall("initial", 812)
  trace.addTool("bananaTool", true, 4000)
  trace.addFailure("final_tool_summary", "no_choices")
  trace.countOutbound(2)
  const record = trace.finish()
  assert.equal(record.intent.kind, "image_generate")
  assert.equal(record.route.mode, "tool")
  assert.equal(record.tools[0].name, "bananaTool")
  assert.equal(record.outbound, 2)
  assert.equal(record.totalMs >= 0, true)
  assert.ok(lines.some(line => line.startsWith("[TurnTrace] ") && JSON.parse(line.slice("[TurnTrace] ".length)).turnId === record.turnId))
})

test("handleTool wires trace and arbiter into the turn", () => {
  const pluginSource = readPluginSources()
  for (const marker of [
    "const turnTrace = createTurnTrace({",
    "e = outboundArbiter.wrapEvent(e)",
    'outboundArbiter.enqueue("commitment", () => this.sendSegmentedMessage(e, acknowledgement, 0))',
    "session?.outboundArbiter?.resolveToolOutcomes()",
    "context?.session?.outboundArbiter?.markFailure()",
    "outboundArbiter.settle(session.turnPlan?.outcomes || [])",
    "turnTrace.finish()",
    "turnId: e?._turnId"
  ]) {
    assert.ok(pluginSource.includes(marker), `missing wiring: ${marker}`)
  }
})
