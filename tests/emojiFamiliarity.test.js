// 表情包认识感单测:认识度推导/选择偏置/首用标记
import { test } from "node:test"
import assert from "node:assert/strict"
import { emojiFamiliarity } from "../domains/emoji/EmojiPackManager.js"

test("emojiFamiliarity:0 次=新表情,用过即脱离新,5 次封顶", () => {
  assert.equal(emojiFamiliarity({ usedCount: 0 }), 0)
  assert.ok(Math.abs(emojiFamiliarity({ usedCount: 1 }) - 0.44) < 1e-9)
  assert.ok(Math.abs(emojiFamiliarity({ usedCount: 3 }) - 0.72) < 1e-9)
  assert.equal(emojiFamiliarity({ usedCount: 5 }), 1)
  assert.equal(emojiFamiliarity({ usedCount: 99 }), 1, "封顶")
  assert.equal(emojiFamiliarity({}), 0, "无字段按新表情")
  assert.equal(emojiFamiliarity(null), 0)
})

test("选择偏置:bias=1 时真实抽样几乎只选熟悉图,bias=0 回到纯多样性(统计验证)", async () => {
  const { EmojiPackManager } = await import("../domains/emoji/EmojiPackManager.js")
  const manager = Object.create(EmojiPackManager.prototype)
  const pool = [
    { item: { hash: "familiar", usedCount: 6, lastUsedAt: null }, score: 0.8 },
    { item: { hash: "fresh", usedCount: 0, lastUsedAt: null }, score: 0.8 }
  ]
  // bias=1:新表情认识度 0 → 权重归零,200 次抽样应全部命中熟悉图
  manager.config = { familiarityBias: 1 }
  let familiarPicks = 0
  for (let i = 0; i < 200; i++) {
    const picked = manager.weightedSampleByUsage(pool)
    if (picked.item.hash === "familiar") familiarPicks++
  }
  assert.ok(familiarPicks >= 198, `bias=1 应几乎全选熟悉图,实际 ${familiarPicks}/200`)

  // bias=0:认识感不参与,新表情靠 usageFactor(2×)优势应显著占优
  manager.config = { familiarityBias: 0 }
  let freshPicks = 0
  for (let i = 0; i < 200; i++) {
    const picked = manager.weightedSampleByUsage(pool)
    if (picked.item.hash === "fresh") freshPicks++
  }
  assert.ok(freshPicks >= 150, `bias=0 应回到多样性偏好(新图占优),实际 ${freshPicks}/200`)
})

test("withFamiliarity:选择结果带 firstUse 与认识度", async () => {
  const { EmojiPackManager } = await import("../domains/emoji/EmojiPackManager.js")
  const manager = Object.create(EmojiPackManager.prototype)
  const fresh = manager.withFamiliarity({ item: { usedCount: 0 }, strategy: "tag_scene" })
  assert.equal(fresh.firstUse, true)
  assert.equal(fresh.familiarity, 0)
  const familiar = manager.withFamiliarity({ item: { usedCount: 4 }, strategy: "tag_scene" })
  assert.equal(familiar.firstUse, false)
  assert.ok(familiar.familiarity > 0.5)
  const empty = manager.withFamiliarity({ item: null, strategy: "empty" })
  assert.equal(empty.item, null)
  assert.equal(empty.firstUse, undefined)
})
