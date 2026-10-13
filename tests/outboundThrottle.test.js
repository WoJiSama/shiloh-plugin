import assert from "node:assert/strict"
import { test } from "node:test"
import {
  bucketKeyForHelper,
  censorOutbound,
  computeDelayMs,
  createTokenBuckets,
  isSendAction,
  readRiskControlConfig
} from "../utils/messagePipeline/outboundThrottle.js"

test("仅消息类动作进闸,查询类 API 直通", () => {
  assert.equal(isSendAction("send_group_msg"), true)
  assert.equal(isSendAction("send_private_forward_msg"), true)
  assert.equal(isSendAction("get_group_info"), false)
  assert.equal(isSendAction("get_credentials"), false)
  assert.equal(isSendAction(""), false)
})

test("随机延迟落在配置区间", () => {
  const fixed = () => 0.5
  assert.equal(computeDelayMs({ delayMinMs: 0, delayMaxMs: 400 }, fixed), 200)
  assert.equal(computeDelayMs({ delayMinMs: 0, delayMaxMs: 0 }, fixed), 0)
  assert.equal(computeDelayMs({}, fixed), 200)
  assert.equal(computeDelayMs({ delayMinMs: 300, delayMaxMs: 100 }, fixed), 300)
})

test("令牌桶:突发上限内直过,耗尽后按时补充", async () => {
  let clock = 0
  const buckets = createTokenBuckets({ now: () => clock })
  const opts = { intervalMs: 1000, burst: 2, maxWaitMs: 0 }
  assert.equal(await buckets.acquire("g:1:100", opts), true)
  assert.equal(await buckets.acquire("g:1:100", opts), true)
  assert.equal(await buckets.acquire("g:1:100", opts), false)
  clock = 1000
  assert.equal(await buckets.acquire("g:1:100", opts), true, "1 个间隔后应回满 1 令牌")
  const snap = buckets.snapshot()
  assert.equal(snap["g:1:100"].burst, 2)
})

test("令牌桶:排队等待可在窗口内拿到令牌", async () => {
  let clock = 0
  const buckets = createTokenBuckets({ now: () => clock })
  const opts = { intervalMs: 60, burst: 1, maxWaitMs: 5000 }
  assert.equal(await buckets.acquire("p:1:2", opts), true)
  const second = buckets.acquire("p:1:2", opts)
  const ticker = setInterval(() => { clock += 20 }, 20)
  try {
    assert.equal(await second, true, "等待回令牌后应成功")
  } finally {
    clearInterval(ticker)
  }
})

test("审查替换:重复词与不同长度的替换不会泄漏原词或破坏相邻内容", () => {
  for (const mark of ["*", "[已隐藏]"]) {
    const result = censorOutbound({
      censorReplaceWords: ["秘密", "TOKEN", "a.b"],
      censorBlockWords: [],
      censorMark: mark
    }, { message: "秘密秘密 TOKEN token a.b aXb 结尾" })
    assert.equal(result.params.message, `${mark}${mark} ${mark} ${mark} ${mark} aXb 结尾`)
    assert.equal(result.replaced, 5)
  }
})

test("令牌桶:已有群进入及退出低调模式时立即调整补充间隔", async () => {
  let clock = 0
  const buckets = createTokenBuckets({ now: () => clock })
  const normal = { intervalMs: 1000, burst: 1, maxWaitMs: 0 }
  const quiet = { ...normal, intervalMs: 2000 }
  assert.equal(await buckets.acquire("g:1:100", normal), true)
  assert.equal(await buckets.acquire("g:1:100", quiet), false)
  clock = 1000
  assert.equal(await buckets.acquire("g:1:100", quiet), false, "低调模式下 1 秒不足以补充 1 枚令牌")
  clock = 2000
  assert.equal(await buckets.acquire("g:1:100", quiet), true)
  assert.equal(await buckets.acquire("g:1:100", normal), false)
  clock = 3000
  assert.equal(await buckets.acquire("g:1:100", normal), true, "恢复正常后按 1 秒补充")
})

test("令牌桶:热修改突发容量会收紧已有令牌，增加容量不凭空产生令牌", async () => {
  let clock = 0
  const buckets = createTokenBuckets({ now: () => clock })
  const initial = { intervalMs: 1000, burst: 3, maxWaitMs: 0 }
  const tight = { ...initial, burst: 1 }
  assert.equal(await buckets.acquire("g:1:100", initial), true)
  assert.equal(await buckets.acquire("g:1:100", tight), true)
  assert.equal(await buckets.acquire("g:1:100", tight), false)
  assert.equal(await buckets.acquire("g:1:100", initial), false, "增大容量保留消耗状态")
  clock = 3000
  assert.equal(await buckets.acquire("g:1:100", initial), true)
  assert.equal(await buckets.acquire("g:1:100", initial), true)
  assert.equal(await buckets.acquire("g:1:100", initial), true)
  assert.equal(await buckets.acquire("g:1:100", initial), false)
})

test("配置归一:缺省回落豹骰默认值,非法值夹紧", () => {
  const cfg = readRiskControlConfig(() => ({}))
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.delayMaxMs, 400)
  assert.equal(cfg.groupIntervalMs, 3000)
  assert.equal(cfg.groupBurst, 3)
  assert.equal(cfg.privateBurst, 3)
  assert.equal(cfg.maxWaitMs, 8000)

  const custom = readRiskControlConfig(() => ({
    riskControl: { enabled: true, delayMinMs: 100, delayMaxMs: 50, groupIntervalSeconds: 5, groupBurst: 99, maxWaitSeconds: 0 }
  }))
  assert.equal(custom.enabled, true)
  assert.equal(custom.delayMaxMs, 100, "上限低于下限时抬到下限")
  assert.equal(custom.groupIntervalMs, 5000)
  assert.equal(custom.groupBurst, 50, "突发夹紧到 50")
  assert.equal(custom.maxWaitMs, 8000, "非法等待值回落默认")
})

test("桶键按群/私聊维度生成", () => {
  assert.equal(bucketKeyForHelper("send_group_msg", { group_id: 123 }, "42"), "g:42:123")
  assert.equal(bucketKeyForHelper("send_private_msg", { user_id: 999 }, "42"), "p:42:999")
  assert.equal(bucketKeyForHelper("send_msg", {}, "42"), "")
})
