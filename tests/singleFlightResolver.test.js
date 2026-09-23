import assert from "node:assert/strict"
import { test } from "node:test"
import { createSingleFlightResolver } from "../utils/singleFlightResolver.js"

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test("同 key 并发调用共享一次执行", async () => {
  let runs = 0
  const gate = deferred()
  const resolve = createSingleFlightResolver(async value => {
    runs += 1
    await gate.promise
    return { value }
  })

  const first = resolve("video-1", "a")
  const second = resolve("video-1", "a")
  gate.resolve()
  const [a, b] = await Promise.all([first, second])
  assert.equal(runs, 1)
  assert.deepEqual(a, { value: "a" })
  assert.deepEqual(b, { value: "a" })
})

test("不同 key 全局串行执行,不并发", async () => {
  const events = []
  const resolve = createSingleFlightResolver(async value => {
    events.push(`start:${value}`)
    await new Promise(r => setTimeout(r, 30))
    events.push(`end:${value}`)
    return value
  })

  const all = await Promise.all([resolve("a", "a"), resolve("b", "b")])
  assert.deepEqual(all, ["a", "b"])
  // 串行:第一个跑完第二个才开始
  assert.deepEqual(events, ["start:a", "end:a", "start:b", "end:b"])
})

test("成功结果在 TTL 内复用,不再执行", async () => {
  let runs = 0
  const resolve = createSingleFlightResolver(async () => {
    runs += 1
    return { ok: true }
  }, { ttlMs: 60_000 })

  assert.deepEqual(await resolve("k"), { ok: true })
  assert.deepEqual(await resolve("k"), { ok: true })
  assert.equal(runs, 1)
})

test("空结果不缓存,可立即重试", async () => {
  let runs = 0
  const resolve = createSingleFlightResolver(async () => {
    runs += 1
    return runs === 1 ? null : { ok: true }
  })

  assert.equal(await resolve("k"), null)
  assert.deepEqual(await resolve("k"), { ok: true })
  assert.equal(runs, 2)
})

test("任务异常不缓存且不阻塞后续排队任务", async () => {
  let runs = 0
  const resolve = createSingleFlightResolver(async () => {
    runs += 1
    if (runs === 1) throw new Error("boom")
    return { ok: true }
  })

  await assert.rejects(() => resolve("bad"), /boom/)
  assert.deepEqual(await resolve("bad"), { ok: true })
  assert.deepEqual(await resolve("next"), { ok: true })
  assert.equal(runs, 3)
})
