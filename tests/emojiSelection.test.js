import test from "node:test"
import assert from "node:assert/strict"
import {
  buildEmojiCandidatePool,
  filterEmojiSelectionCriteriaToCatalog,
  normalizeEmojiSelectionCriteria,
  structuredEmojiRelevanceScore
} from "../domains/emoji/emojiSelection.js"

// 组合来自 2026-07-14 线上 200 条库的脱敏 tags/useCases 分布，不复制图片、描述或 embedding。
const catalog = [
  { id: "laugh", tags: ["笑死", "嘲讽", "得意", "吐槽"], useCases: ["群友翻车", "接梗吐槽", "轻微嘲讽"] },
  { id: "speechless", tags: ["震惊", "无语", "尴尬", "呆滞"], useCases: ["看到离谱", "无言以对", "场面尴尬"] },
  { id: "tired", tags: ["无奈", "摆烂", "敷衍", "疲惫"], useCases: ["累到躺平", "拒绝加班", "被现实打败"] },
  { id: "hurt", tags: ["委屈", "崩溃", "破防", "难过"], useCases: ["被戳痛点", "委屈诉苦", "突然破防"] },
  { id: "comfort", tags: ["卖萌", "安慰", "得意", "调侃"], useCases: ["安慰对方", "接梗摸头"] },
  { id: "innocent", tags: ["卖萌", "无辜", "惊讶", "害羞"], useCases: ["想装无辜", "求原谅", "被人夸奖"] }
]

function topId(criteria) {
  return catalog
    .map(item => ({ id: item.id, score: structuredEmojiRelevanceScore(item, criteria) }))
    .sort((a, b) => b.score - a.score)[0]
}

test("normalizes ordered structured tags and use cases into a compact fallback query", () => {
  assert.deepEqual(normalizeEmojiSelectionCriteria({
    tags: ["无语", "震惊", "无语"],
    useCases: ["无言以对", "看到离谱"]
  }), {
    query: "无语 震惊 无言以对 看到离谱",
    tags: ["无语", "震惊"],
    useCases: ["无言以对", "看到离谱"]
  })
})

test("filters model-invented fields against the current catalog vocabulary", () => {
  assert.deepEqual(filterEmojiSelectionCriteriaToCatalog({
    tags: ["安慰", "温暖", "卖萌"],
    useCases: ["安慰对方", "群友晚安"]
  }, catalog), {
    query: "安慰 温暖 卖萌 安慰对方 群友晚安",
    tags: ["安慰", "卖萌"],
    useCases: ["安慰对方"]
  })
})

test("ordered exact fields rank the intended online tag cluster first", () => {
  const cases = [
    [{ tags: ["笑死", "吐槽"], useCases: ["群友翻车", "接梗吐槽"] }, "laugh"],
    [{ tags: ["无语", "震惊"], useCases: ["无言以对", "看到离谱"] }, "speechless"],
    [{ tags: ["疲惫", "摆烂"], useCases: ["累到躺平", "拒绝加班"] }, "tired"],
    [{ tags: ["委屈", "破防"], useCases: ["委屈诉苦", "突然破防"] }, "hurt"],
    [{ tags: ["安慰", "卖萌"], useCases: ["安慰对方", "接梗摸头"] }, "comfort"],
    [{ tags: ["无辜", "卖萌"], useCases: ["想装无辜", "求原谅"] }, "innocent"]
  ]

  for (const [criteria, expected] of cases) {
    const top = topId(criteria)
    assert.equal(top.id, expected, JSON.stringify(criteria))
    assert.ok(top.score >= 0.72, JSON.stringify(criteria))
  }
})

test("primary tags carry more weight than later fallback tags", () => {
  const primary = structuredEmojiRelevanceScore(catalog[1], { tags: ["无语", "尴尬"] })
  const secondaryOnly = structuredEmojiRelevanceScore(catalog[0], { tags: ["无语", "吐槽"] })
  assert.ok(primary > secondaryOnly)
})

test("a single strong structured match is not diluted with weak fallback candidates", () => {
  const ranked = catalog
    .map(item => ({ item, score: structuredEmojiRelevanceScore(item, {
      tags: ["安慰", "卖萌"],
      useCases: ["安慰对方", "接梗摸头"]
    }) }))
    .filter(candidate => candidate.score >= 0.18)

  const pool = buildEmojiCandidatePool(ranked, { preserveStrongMatch: true })
  assert.equal(pool.length, 1)
  assert.equal(pool[0].item.id, "comfort")
})
