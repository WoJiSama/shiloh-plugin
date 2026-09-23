// 提示词层 TTL 缓存单元测试。
import { test } from "node:test"
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import {
  cachedPromptLayer,
  clearPromptLayerCache,
  isPromptLayerCacheEnabled,
  promptLayerCacheStats,
  LAYER_CACHE_TTL_MS
} from "../utils/promptLayerCache.js"

test("TTL 内命中缓存,过期后重新加载", async () => {
  clearPromptLayerCache()
  let loads = 0
  const loader = async () => { loads += 1; return `v${loads}` }

  assert.equal(await cachedPromptLayer("k", 50, loader), "v1")
  assert.equal(await cachedPromptLayer("k", 50, loader), "v1", "TTL 内应命中缓存")
  assert.equal(loads, 1)

  await sleep(60)
  assert.equal(await cachedPromptLayer("k", 50, loader), "v2", "过期后重新加载")
  assert.equal(loads, 2)
})

test("loader 抛错不缓存,下次仍会重试", async () => {
  clearPromptLayerCache()
  let attempts = 0
  const failing = async () => { attempts += 1; throw new Error("boom") }
  await assert.rejects(() => cachedPromptLayer("err", 1000, failing))
  await assert.rejects(() => cachedPromptLayer("err", 1000, failing))
  assert.equal(attempts, 2, "失败结果不应被缓存")
})

test("clearPromptLayerCache 清空后重新加载", async () => {
  clearPromptLayerCache()
  let loads = 0
  const loader = async () => { loads += 1; return "x" }
  await cachedPromptLayer("c", 60_000, loader)
  clearPromptLayerCache()
  await cachedPromptLayer("c", 60_000, loader)
  assert.equal(loads, 2)
  assert.equal(promptLayerCacheStats().entries, 1)
})

test("容量上限触发最旧淘汰", async () => {
  clearPromptLayerCache()
  const stats = promptLayerCacheStats()
  for (let i = 0; i <= stats.maxEntries; i++) {
    await cachedPromptLayer(`evict:${i}`, 60_000, async () => `v${i}`)
  }
  const after = promptLayerCacheStats()
  assert.equal(after.entries, stats.maxEntries, "容量不超上限")
  // 最旧的 evict:0 应已被淘汰:重新加载会得到新值
  let reloaded = false
  await cachedPromptLayer("evict:0", 60_000, async () => { reloaded = true; return "fresh" })
  assert.ok(reloaded, "最旧条目应被淘汰")
})

test("各慢变化层均有合理 TTL,且总开关默认开启", () => {
  for (const layer of ["emotion", "expression", "globalStyle", "personaFeedback", "personProfile"]) {
    assert.ok(Number(LAYER_CACHE_TTL_MS[layer]) >= 30_000, `${layer} TTL 过短失去缓存意义`)
    assert.ok(Number(LAYER_CACHE_TTL_MS[layer]) <= 600_000, `${layer} TTL 过长会明显陈旧`)
  }
  assert.equal(isPromptLayerCacheEnabled({}), true, "未配置时默认开启")
  assert.equal(isPromptLayerCacheEnabled({ promptLayerCache: { enabled: false } }), false)
})
