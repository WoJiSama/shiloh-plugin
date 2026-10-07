// 发送节流测试:耗时感知(处理慢则零延迟)、通道豁免(command/repeat 不节流)、
// 抖动区间、单号覆盖配置、fail-open。
import { test } from "node:test"
import assert from "node:assert/strict"

test("isPacedChannel:仅 agent_* 通道参与节流", async () => {
  const { isPacedChannel } = await import("../utils/sendPacing.js")
  assert.equal(isPacedChannel("agent_text"), true)
  assert.equal(isPacedChannel("agent_text_fallback"), true)
  assert.equal(isPacedChannel("agent_forward"), true)
  assert.equal(isPacedChannel("command"), false)
  assert.equal(isPacedChannel("repeat"), false)
  assert.equal(isPacedChannel(""), false)
})

test("computePacingDelayMs:耗时感知与抖动区间", async () => {
  const { computePacingDelayMs, DEFAULT_SEND_PACING_CONFIG } = await import("../utils/sendPacing.js")
  const config = { enabled: true, minIntervalMs: 3000, jitterMs: 4000, maxWaitMs: 15000 }

  // 首条(无记录)零延迟
  assert.equal(computePacingDelayMs({ channel: "agent_text", config }), 0)
  // 处理耗时已超过最小间隔(生图 20s 场景)零追加
  assert.equal(computePacingDelayMs({ channel: "agent_text", elapsedMs: 20000, config }), 0)
  assert.equal(computePacingDelayMs({ channel: "agent_text", elapsedMs: 3000, config }), 0)
  // 刚发过(0ms 间隔):base=3000 + 抖动[0,4000) → [3000,7000)
  const fixedRandom = () => 0.5
  assert.equal(computePacingDelayMs({ channel: "agent_text", elapsedMs: 0, config, random: fixedRandom }), 5000)
  assert.equal(computePacingDelayMs({ channel: "agent_text", elapsedMs: 1000, config, random: () => 0 }), 2000)
  // 上限截断
  assert.equal(computePacingDelayMs({ channel: "agent_text", elapsedMs: 0, config: { ...config, maxWaitMs: 2500, jitterMs: 0 } }), 2500)
  // 关闭/豁免通道
  assert.equal(computePacingDelayMs({ channel: "agent_text", config: { ...config, enabled: false } }), 0)
  assert.equal(computePacingDelayMs({ channel: "command", elapsedMs: 0, config }), 0)
  assert.equal(DEFAULT_SEND_PACING_CONFIG.minIntervalMs, 3000)
})

test("SendPacer:同会话连发被拉开,不同会话互不影响,命令发送不占间隔", async () => {
  const { SendPacer } = await import("../utils/sendPacing.js")
  let clock = 100000
  const sleeps = []
  const pacer = new SendPacer({ minIntervalMs: 3000, jitterMs: 0 }, {
    now: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms }
  })
  const e = { group_id: 111, self_id: 3094088525 }

  assert.equal(await pacer.before(e, "agent_text"), 0, "首条零延迟")
  pacer.markSent(e, "agent_text")
  assert.equal(await pacer.before(e, "agent_text"), 3000, "紧随的第二条等待最小间隔")
  assert.deepEqual(sleeps, [3000])

  clock += 10000
  assert.equal(await pacer.before(e, "agent_text"), 0, "间隔足够后零延迟")

  const other = { group_id: 222, self_id: 3094088525 }
  pacer.markSent(other, "agent_text")
  assert.equal(await pacer.before(other, "agent_text"), 3000)
  assert.equal(await pacer.before(e, "command"), 0, "命令通道不节流")
  pacer.markSent(e, "command")
  assert.equal(await pacer.before(e, "agent_text"), 0, "命令发送不刷新聊天间隔锚点")
})

test("单号覆盖配置:byBot 优先于全局", async () => {
  const { SendPacer } = await import("../utils/sendPacing.js")
  let clock = 1000
  const sleeps = []
  const pacer = new SendPacer({
    minIntervalMs: 3000, jitterMs: 0,
    byBot: { "111": { minIntervalMs: 8000, jitterMs: 0 } }
  }, { now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms } })
  const botA = { group_id: 9, self_id: 111 }
  const botB = { group_id: 9, self_id: 222 }
  pacer.markSent(botA, "agent_text")
  pacer.markSent(botB, "agent_text")
  assert.equal(await pacer.before(botA, "agent_text"), 8000, "A 号用覆盖画像")
  // A 的等待推进了共享时钟,给 B 重锚后再验 B 的画像
  pacer.markSent(botB, "agent_text")
  assert.equal(await pacer.before(botB, "agent_text"), 3000, "B 号用全局画像")
  assert.deepEqual(sleeps, [8000, 3000])
})

test("节流异常不外抛(fail-open 由调用方兜底)", async () => {
  const { SendPacer } = await import("../utils/sendPacing.js")
  const pacer = new SendPacer({ minIntervalMs: 3000 }, {
    now: () => { throw new Error("clock broken") },
    sleep: async () => {}
  })
  await assert.doesNotReject(() => pacer.before({ group_id: 1 }, "agent_text"))
})
