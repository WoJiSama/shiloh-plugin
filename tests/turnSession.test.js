// 回合会话存储测试:基础语义(TTL 前与裸 Map 等价)、TTL/容量淘汰、工具全量刷新,
// 以及字段注册表漂移防护——apps/test.js 里出现未登记的 session.X 访问时本测试失败,
// 逼着新字段先在 TURN_SESSION_FIELDS 里注明归属。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  createTurnSessionStore,
  TURN_SESSION_FIELDS,
  TURN_SESSION_TTL_MS,
  TURN_SESSION_MAX
} from "../utils/turnSession.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("getOrCreate 基础语义:创建带固定底座字段,重复取用同一对象并刷新活跃时间", () => {
  const store = createTurnSessionStore()
  const a = store.getOrCreate("s1", ["toolA"])
  assert.deepEqual(
    { tools: a.tools, groupUserMessages: a.groupUserMessages, actionOutcomes: a.actionOutcomes },
    { tools: ["toolA"], groupUserMessages: [], actionOutcomes: [] }
  )
  assert.ok(a.__createdAt > 0)
  const b = store.getOrCreate("s1", ["toolB"])
  assert.equal(a, b, "同一 sessionId 必须复用同一会话对象")
  assert.equal(store.get("s1"), a)
  assert.equal(store.get("missing"), undefined)
})

test("clear 与 refreshTools", () => {
  const store = createTurnSessionStore()
  store.getOrCreate("s1", ["old"])
  store.getOrCreate("s2", ["old"])
  store.refreshTools(["new"])
  assert.equal(store.get("s1").tools[0], "new")
  store.clear("s1")
  assert.equal(store.get("s1"), undefined)
  assert.equal(store.stats().sessions, 1)
})

test("sweep 按 TTL 淘汰,活跃会话保留", () => {
  const store = createTurnSessionStore({ ttlMs: 1000 })
  store.getOrCreate("s1", [])
  const now = Date.now()
  // 未过期:不淘汰
  assert.equal(store.sweep(now + 500), 0)
  // 过期:淘汰
  assert.equal(store.sweep(now + 2000), 1)
  assert.equal(store.stats().sessions, 0)
})

test("sweep 超容量时淘汰最不活跃的会话", () => {
  const store = createTurnSessionStore({ maxSessions: 2, ttlMs: TURN_SESSION_TTL_MS })
  const s1 = store.getOrCreate("s1", [])
  store.getOrCreate("s2", [])
  const base = Date.now()
  // s1 活跃时间被刷新到 base+5000, s2 留在创建时刻 → 超容量时应淘汰 s2
  s1.__lastActiveAt = base + 5000
  store.getOrCreate("s3", [])
  const removed = store.sweep(base + 6000)
  assert.ok(removed >= 1)
  assert.equal(store.get("s2"), undefined, "最不活跃的 s2 应被淘汰")
  assert.ok(store.get("s1") || store.get("s3"), "较活跃的会话保留")
  assert.ok(store.stats().sessions <= 2)
})

test("默认上限与 TTL 是有限值", () => {
  assert.ok(TURN_SESSION_TTL_MS > 0 && TURN_SESSION_TTL_MS <= 60 * 60 * 1000)
  assert.ok(TURN_SESSION_MAX > 0 && TURN_SESSION_MAX <= 1000)
})

test("漂移防护:主链路与 utils 里所有 session.X 字段访问都已登记注册表", () => {
  const sources = [
    path.join(root, "apps/test.js"),
    ...fs.readdirSync(path.join(root, "utils"))
      .filter(file => file.endsWith(".js"))
      .map(file => path.join(root, "utils", file))
      .filter(file => path.basename(file) !== "turnSession.js"),
    ...fs.readdirSync(path.join(root, "apps/lib"))
      .filter(file => file.endsWith(".js"))
      .map(file => path.join(root, "apps/lib", file))
  ]
  const registered = new Set(TURN_SESSION_FIELDS.map(field => field.name))
  const accessed = new Set()
  for (const file of sources) {
    const src = fs.readFileSync(file, "utf8")
    for (const match of src.matchAll(/\bsession\??\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      accessed.add(match[1])
    }
  }
  // 元数据字段由存储层维护,不需要主链路登记
  const knownMeta = new Set(["__createdAt", "__lastActiveAt"])
  const unregistered = [...accessed].filter(name => !registered.has(name) && !knownMeta.has(name))
  assert.deepEqual(
    unregistered.sort(),
    [],
    `访问了未登记的 session 字段;请先在 utils/turnSession.js 的 TURN_SESSION_FIELDS 补充归属说明: ${unregistered.join(", ")}`
  )
  // 注册表不允许出现从未被访问的死字段(防止注册表自身腐化)
  const deadFields = TURN_SESSION_FIELDS.filter(field => !accessed.has(field.name)).map(field => field.name)
  assert.deepEqual(deadFields, [], `注册表存在从未被访问的字段,请移除或核实: ${deadFields.join(", ")}`)
})
