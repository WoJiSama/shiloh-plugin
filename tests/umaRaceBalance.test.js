import { test } from "node:test"
import assert from "node:assert/strict"

globalThis.logger ||= { error() {}, warn() {}, info() {}, debug() {}, mark() {} }
globalThis.segment ||= { image: file => ({ type: "image", file }) }

const { UmaRaceManager } = await import("../domains/games/uma/UmaRaceManager.js")
const manager = new UmaRaceManager({ logger: null })

function attrs(value) {
  return {
    speed: value,
    stamina: value,
    power: value,
    focus: value,
    wisdom: value,
    luck: value
  }
}

test("race balance compresses high total players without mutating original attributes", () => {
  const players = [
    { userId: "low", nickname: "新人", umaName: "小新", attributes: { speed: 7, stamina: 7, power: 7, focus: 7, wisdom: 6, luck: 6 } },
    { userId: "high", nickname: "老玩家", umaName: "老马", attributes: { speed: 20, stamina: 20, power: 20, focus: 15, wisdom: 15, luck: 10 } }
  ]

  const balanced = manager.prepareRacePlayers(players)
  const high = balanced.find(player => player.userId === "high")

  assert.equal(manager.sumAttributes(players[1].attributes), 100)
  assert.equal(high.raceBalance.originalTotal, 100)
  assert.equal(high.raceBalance.effectiveTotal, 70)
  assert.equal(manager.sumAttributes(high.attributes), 70)
  assert.equal(manager.sumAttributes(high.originalAttributes), 100)
})

test("npc totals are based on balanced player totals", () => {
  const players = manager.prepareRacePlayers([
    { userId: "low", nickname: "新人", umaName: "小新", attributes: { speed: 7, stamina: 7, power: 7, focus: 7, wisdom: 6, luck: 6 } },
    { userId: "high", nickname: "老玩家", umaName: "老马", attributes: { speed: 20, stamina: 20, power: 20, focus: 15, wisdom: 15, luck: 10 } }
  ])

  manager.fillNpcPlayers(players, 8)
  const npcTotals = players
    .filter(player => player.isNpc)
    .map(player => manager.sumAttributes(player.attributes))

  assert.equal(npcTotals.length, 6)
  // 区间按当前算法推导:base = 均衡后玩家均值 × 0.88(两人房梯度),NPC 总和在 base±10%
  const base = manager.getNpcBaseAttributeTotal(players)
  assert.ok(base > 44 && base < 53, `两人房的 NPC 基准应锚定在均衡均值附近,实际 ${base}`)
  const min = Math.max(24, Math.floor(base * 0.9))
  const max = Math.max(min, Math.ceil(base * 1.1))
  assert.ok(
    npcTotals.every(total => total >= min && total <= max),
    `NPC 总和应落在 [${min}, ${max}],实际 ${npcTotals.join(",")}`
  )
})

test("race balance does not trigger when totals are close", () => {
  const players = manager.prepareRacePlayers([
    { userId: "a", nickname: "A", umaName: "A", attributes: attrs(8) },
    { userId: "b", nickname: "B", umaName: "B", attributes: { speed: 10, stamina: 10, power: 8, focus: 8, wisdom: 8, luck: 8 } }
  ])

  assert.equal(players[0].raceBalance.enabled, false)
  assert.equal(players[1].raceBalance.enabled, false)
  assert.equal(manager.sumAttributes(players[1].attributes), 52)
})

test("race profile exposes numeric track and environment parameters", () => {
  const profile = manager.buildRaceProfile(
    { id: "uphill_finish", name: "上坡终点" },
    { name: "终点前逆风" },
    { name: "大雨突袭" }
  )

  assert.equal(profile.segments.length, 3)
  assert.ok(profile.distance > 0)
  assert.ok(profile.friction > 1)
  assert.ok(profile.slope[2] > profile.slope[0])
  assert.ok(profile.staminaCostRate > 1)
})

test("race condition participates in profile and tags", () => {
  const fast = manager.buildRaceProfile(
    { id: "short_sprint", name: "短距离冲刺" },
    { name: "慢节奏" },
    { name: "观众欢呼" },
    { name: "干燥高速", tags: ["dry", "speed"] }
  )
  const soft = manager.buildRaceProfile(
    { id: "short_sprint", name: "短距离冲刺" },
    { name: "慢节奏" },
    { name: "观众欢呼" },
    { name: "松软吃力", tags: ["soft", "stamina"] }
  )
  const tags = manager.getRaceTags(
    { tags: ["sprint"] },
    { tags: ["chaotic"] },
    { tags: ["cheering"] },
    { tags: ["soft", "stamina"] }
  )

  assert.ok(fast.speedCarry > soft.speedCarry)
  assert.ok(soft.staminaCostRate > fast.staminaCostRate)
  assert.ok(tags.has("soft"))
  assert.ok(tags.has("stamina"))
})

test("race tags drive trait affinity bonus", () => {
  const tags = manager.getRaceTags(
    { tags: ["adverse", "wet"] },
    { tags: ["chaotic"] },
    { tags: ["corner"] }
  )
  const trait = manager.inferPersonalityTrait("普通小马", "均衡")

  assert.ok(tags.has("adverse"))
  assert.ok(tags.has("chaotic"))
  assert.equal(manager.getTraitTagBonus(trait, tags), 2)
})

test("trait tag affinity includes weaknesses", () => {
  const trait = manager.inferPersonalityTrait("热血小马", "不服输，喜欢拼一把")
  const badTags = manager.getRaceTags(
    { tags: ["adverse", "wet", "long"] },
    { tags: ["pace_slow"] },
    { tags: [] }
  )

  assert.ok(manager.getTraitTagBonus(trait, badTags) < 0)
})

test("action proficiency gains are capped per race", () => {
  const runner = {
    race: {
      actionUses: [
        { actionKey: "burst", grade: "critical" },
        { actionKey: "burst", grade: "hard" },
        { actionKey: "burst", grade: "fumble" }
      ]
    }
  }

  assert.deepEqual(manager.calculateProficiencyGains(runner), [{ actionKey: "burst", gain: 10 }])
})

test("action proficiency level gives small check bonus", () => {
  assert.equal(manager.getActionProficiencyBonus({ proficiency: { burst: 99 } }, "burst"), 0)
  assert.equal(manager.getActionProficiencyBonus({ proficiency: { burst: 100 } }, "burst"), 1)
  assert.equal(manager.getActionProficiencyBonus({ proficiency: { burst: 800 } }, "burst"), 4)
})

test("stage action advances numeric race state and reports visible deltas", () => {
  const track = { id: "short_sprint", name: "短距离冲刺", fit: {}, description: "", events: ["{name} 冲过终点。"] }
  const twist = { name: "观众欢呼", fit: {} }
  const scene = { name: "起跑失误", fit: {} }
  const players = [
    { userId: "a", nickname: "A", umaName: "A", attributes: attrs(12), strategyKey: "burst", strategyLabel: "拼一把" },
    { userId: "b", nickname: "B", umaName: "B", attributes: attrs(8), strategyKey: "steady", strategyLabel: "稳一点" }
  ]
  const room = {
    groupId: "test",
    phase: "race",
    track,
    twist,
    scene,
    raceProfile: manager.buildRaceProfile(track, twist, scene),
    runners: manager.initializeStageRunners(players, track, twist, scene)
  }
  const runner = room.runners[0]
  const beforeDistance = runner.race.distance
  const result = manager.applyRaceAction(runner, { key: "burst", label: "爆发" }, { key: "finish", label: "冲刺阶段" }, 2, room)

  assert.ok(runner.race.distance > beforeDistance)
  assert.ok(Number.isFinite(runner.race.velocity))
  assert.ok(result.line.includes("速度"))
  assert.ok(result.line.includes("体力"))
  assert.ok(result.line.includes("推进"))
})
