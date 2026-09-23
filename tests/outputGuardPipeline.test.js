// 输出守卫统一管线测试:钉住两条调用路径(主回复 polish / 通用发送)
// 的链式行为与顺序,以及与原分散实现等价的清理效果。
import { test } from "node:test"
import assert from "node:assert/strict"
import { applyOutputPersonaGuards, getOutputGuardStats, resetOutputGuardStats } from "../utils/outputGuardPipeline.js"

function buildRecordingManager() {
  const calls = []
  return {
    calls,
    guardReply(text, config, context) {
      calls.push({ text, config, context })
      return `GUARDED<${text}>`
    }
  }
}

test("主回复路径:polish → 语气边界 → guardReply 顺序执行", () => {
  const manager = buildRecordingManager()
  const output = applyOutputPersonaGuards("（小声）嘿嘿，先说结论：Redis 先查地址。我是不是说得有点多了", {
    userText: "解释一下 Redis 为什么连不上",
    toolName: "",
    botNames: ["希洛"],
    personaGuard: { enabled: true },
    polish: true,
    personaFeedbackManager: manager
  })

  // polish 已去掉舞台指示与自我审稿(句尾标点一并吞掉,与原实现一致);precise 模式再去掉反应词开头
  assert.equal(output, "GUARDED<先说结论：Redis 先查地址>")
  assert.equal(manager.calls.length, 1)
  assert.equal(manager.calls[0].context.userText, "解释一下 Redis 为什么连不上")
  assert.deepEqual(manager.calls[0].context.botNames, ["希洛"])
  assert.equal(typeof manager.calls[0].context.onPatternHit, "function", "坏模式命中回调随 context 传入")
})

test("通用发送路径:默认不做 polish,仅语气边界 + guardReply", () => {
  const manager = buildRecordingManager()
  const output = applyOutputPersonaGuards("（小声）嘿嘿，先说结论：Redis 先查地址。", {
    userText: "解释一下 Redis 为什么连不上",
    botNames: ["希洛"],
    personaGuard: { enabled: true },
    personaFeedbackManager: manager
  })

  // 不 polish:舞台指示仍在行首,语气边界的反应词正则无法命中(与原通用路径行为一致)
  assert.equal(output, "GUARDED<（小声）嘿嘿，先说结论：Redis 先查地址。>")
})

test("社交闲聊场景:语气边界不动正文,链路仍然完整", () => {
  const manager = buildRecordingManager()
  const output = applyOutputPersonaGuards("你少来，这个梗我懂。", {
    userText: "哈哈你又开始了",
    botNames: ["希洛"],
    personaGuard: { enabled: true },
    personaFeedbackManager: manager
  })
  assert.equal(output, "GUARDED<你少来，这个梗我懂。>")
})

test("默认走真实 personaFeedbackManager:客服腔被清理", () => {
  const output = applyOutputPersonaGuards("作为AI，我帮你看了下结果。", {
    userText: "帮我看看结果",
    toolName: "searchInformationTool",
    botNames: ["希洛"],
    personaGuard: { enabled: true }
  })
  assert.ok(!output.includes("作为AI"))
  assert.ok(output.includes("我帮你看了下结果"))
})

test("触发统计:阶段命中与字符删减被记录,坏模式逐条计数", () => {
  resetOutputGuardStats()
  // precise 场景 + 舞台指示 + 客服腔,三个阶段都会动文本
  applyOutputPersonaGuards("（小声）嘿嘿，先说结论。作为AI，我帮你看了下。", {
    userText: "解释一下 Redis 为什么连不上",
    botNames: ["希洛"],
    personaGuard: { enabled: true },
    polish: true
  })
  let stats = getOutputGuardStats()
  assert.equal(stats.applications, 1)
  assert.ok(stats.stageHits.polish >= 1, "润色阶段应记为命中")
  assert.ok(stats.stageHits.toneBoundary >= 1, "语气边界阶段应记为命中")
  assert.ok(stats.stageHits.guardReply >= 1, "坏模式清理阶段应记为命中")
  assert.ok(stats.charsRemoved.polish > 0 && stats.charsRemoved.toneBoundary > 0 && stats.charsRemoved.guardReply > 0)

  // 自定义坏模式(未被 guardReply 早期阶段覆盖)应被逐条计数——这是规则退役依据
  applyOutputPersonaGuards("这个用法绝绝子，就这么配置。", {
    userText: "帮我看看配置",
    botNames: ["希洛"],
    personaGuard: { enabled: true, badPatterns: ["绝绝子"] }
  })
  stats = getOutputGuardStats()
  assert.equal(stats.applications, 2)
  assert.ok(stats.patternHits["绝绝子"] >= 1, "命中的坏模式应逐条计数")

  // 无改动的回合不增加命中计数
  applyOutputPersonaGuards("你少来，这个梗我懂。", {
    userText: "哈哈你又开始了",
    botNames: ["希洛"],
    personaGuard: { enabled: true }
  })
  stats = getOutputGuardStats()
  assert.equal(stats.applications, 3)
  assert.equal(stats.stageHits.polish, 1, "社交闲聊且不 polish 时润色不应再命中")

  resetOutputGuardStats()
  assert.equal(getOutputGuardStats().applications, 0)
  assert.deepEqual(getOutputGuardStats().patternHits, {})
})
