// 调皮情绪时刻单测:掷骰概率/冷却/格式化/无效条目过滤/composer 接入
import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  rollPersonaMood,
  formatMoodPrompt,
  normalizeMoods,
  getMoodCooldownState,
  __resetPersonaMoodsForTest
} from "../utils/personaMoods.js"

beforeEach(() => __resetPersonaMoodsForTest())

const MOODS = [
  { name: "活泼", hint: "语速快一点、爱接梗", probability: 0.5 },
  { name: "腹黑", hint: "轻轻拆台、坏笑", probability: 0.2 }
]

test("normalizeMoods:过滤无效条目,概率封顶 1", () => {
  const moods = normalizeMoods([
    { name: "A", hint: "a", probability: 0.1 },
    { name: "", hint: "x", probability: 0.1 },
    { name: "B", hint: "", probability: 0.1 },
    { name: "C", hint: "c", probability: 9 },
    "垃圾",
    null
  ])
  assert.deepEqual(moods.map(m => m.name), ["A", "C"])
  assert.equal(moods[1].probability, 1, "概率封顶 1")
})

test("掷骰:概率 1 必中,概率 0 必不中", () => {
  const hit = rollPersonaMood({ moods: [{ name: "必中", hint: "x", probability: 1 }] }, "g1")
  assert.equal(hit.name, "必中")
  __resetPersonaMoodsForTest()
  const miss = rollPersonaMood({ moods: [{ name: "必不中", hint: "x", probability: 0 }] }, "g1")
  assert.equal(miss, null)
})

test("冷却:命中后群级冷却期内不再掷出,冷却过期恢复", () => {
  let seed = 0.01 // 恒命中
  const rand = () => seed
  let now = 1000000
  const first = rollPersonaMood({ moods: MOODS }, "g1", { rand, now: () => now })
  assert.equal(first.name, "活泼")
  seed = 0.01
  const second = rollPersonaMood({ moods: MOODS }, "g1", { rand, now: () => now + 60_000 })
  assert.equal(second, null, "冷却期内不掷出")
  seed = 0.01
  const third = rollPersonaMood({ moods: MOODS }, "g1", { rand, now: () => now + 11 * 60_000 })
  assert.equal(third.name, "活泼", "冷却过期恢复")
  // 其他群不受冷却影响
  seed = 0.01
  const other = rollPersonaMood({ moods: MOODS }, "g2", { rand, now: () => now + 60_000 })
  assert.equal(other.name, "活泼")
})

test("formatMoodPrompt:三行结构,空条目返回空", () => {
  const prompt = formatMoodPrompt({ name: "腹黑", hint: "坏笑一下" })
  assert.ok(prompt.startsWith("【本回合心情:腹黑】"))
  assert.ok(prompt.includes("坏笑一下"))
  assert.ok(prompt.includes("只影响这一次回复"))
  assert.equal(formatMoodPrompt(null), "")
  assert.equal(formatMoodPrompt({ name: "x" }), "")
})

test("composer 接入:moodHint 拼进 personaTone 层,未命中不拼", async () => {
  const { composeTurnPromptLayers } = await import("../utils/turnPromptComposer.js")
  const base = {
    config: { persona: { name: "希洛" } },
    turn: { groupId: "g1", userId: "u1", messageText: "哈哈", toneText: "哈哈" },
    deps: {}
  }
  const withMood = await composeTurnPromptLayers({
    ...base,
    turn: { ...base.turn, moodHint: { name: "活泼", hint: "爱接梗", prompt: formatMoodPrompt({ name: "活泼", hint: "爱接梗" }) } }
  })
  assert.ok(withMood.layerValues.personaTone.includes("【本回合心情:活泼】"))
  const withoutMood = await composeTurnPromptLayers(base)
  assert.ok(!withoutMood.layerValues.personaTone.includes("本回合心情"))
})

test("人设库透传 moods(库内人设可带自己的心情时刻)", async () => {
  const { createPersonaLibrary } = await import("../utils/personaLibrary.js")
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mood-lib-")), "persona-library.yaml")
  const lib = createPersonaLibrary({
    libraryPath: tmp,
    getBasePersona: () => ({ name: "希洛", moods: [{ name: "默认心情", hint: "h", probability: 0.01 }] }),
    logger: { error: () => {} }
  })
  lib.upsert({ name: "夜巡", moods: [{ name: "夜话", hint: "更慢更轻", probability: 0.2 }] })
  const resolved = lib.resolve({ messageType: "group", groupId: "111" })
  // 未绑定群 → 默认人设的 moods
  assert.equal(resolved.persona.moods[0].name, "默认心情")
  const saved = lib.detail("夜巡")
  assert.equal(saved.persona.moods[0].name, "夜话", "库内人设 moods 透传")
})
