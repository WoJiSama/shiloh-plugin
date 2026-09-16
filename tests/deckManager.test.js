import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

function makeDecksDir(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "decks-"))
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content, "utf8")
  }
  return root
}

const SAMPLE_JSON = JSON.stringify({
  _name: ["测试牌堆"],
  _author: ["希洛"],
  主牌: ["你抽到了【武器】", "你抽到了{%药品}", "平凡的一天"],
  武器: ["木剑", "::5::铁剑", "圣剑"],
  药品: ["红药水", "蓝药水"],
  _隐藏: ["秘密条目"]
})

const SAMPLE_YAML = [
  "_name:",
  "  - YAML牌堆",
  "问候:",
  "  - 你好，{player}！",
  "  - \"{self}向你问好\"",
  ""
].join("\n")

test("牌堆加载：元数据解析、隐藏牌组、YAML 支持", async () => {
  const { DeckManager } = await import("../domains/dice/DeckManager.js")
  const dir = makeDecksDir({ "sample.json": SAMPLE_JSON, "sample.yaml": SAMPLE_YAML })
  const manager = new DeckManager({ decksDir: dir })
  const count = manager.reload()
  if (count !== 2) console.log("DEBUG count:", count, "err:", manager.lastError, "dir:", fs.readdirSync(dir))
  assert.equal(count, 2)
  const deck = manager.findDeck("主牌")
  assert.ok(deck, "主牌可见")
  assert.equal(deck.name, "测试牌堆")
  assert.equal(deck.author, "希洛")
  assert.equal(manager.findDeck("_隐藏"), null, "_ 前缀牌组不可直接抽")
  assert.match(manager.listKeys(""), /主牌/)
  assert.doesNotMatch(manager.listKeys(""), /_隐藏/)
  assert.match(manager.listDecks(), /测试牌堆 作者:希洛/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("抽取语义：{牌组}不放回（单命令内）、{%牌组}放回、::权重、[方括号]嵌套", async () => {
  const { DeckManager } = await import("../domains/dice/DeckManager.js")
  const dir = makeDecksDir({ "sample.json": SAMPLE_JSON })
  const manager = new DeckManager({ decksDir: dir })
  manager.reload()

  // 权重抽验：铁剑权重5/7，多次抽武器应明显偏多
  let iron = 0
  for (let i = 0; i < 140; i += 1) {
    const r = manager.draw("武器", { pools: {} })
    if (r.text === "铁剑") iron += 1
  }
  assert.ok(iron > 60, `权重生效（铁剑 ${iron}/140）`)

  // 嵌套 + 放回：{%药品} 每次独立
  const results = new Set()
  for (let i = 0; i < 20; i += 1) {
    const r = manager.draw("主牌", { pools: {} })
    assert.ok(!r.error, r.error)
    results.add(r.text)
  }
  assert.ok([...results].some(t => t.includes("红药水") || t.includes("蓝药水")), "嵌套抽取生效")

  // 不放回：同一次命令上下文内，主牌池只减不增
  const ctx = { pools: {} }
  const drawn = new Set()
  for (let i = 0; i < 3; i += 1) {
    const r = manager.draw("主牌", ctx)
    assert.ok(!drawn.has(r.text), `同上下文内不重复（第${i + 1}次）`)
    drawn.add(r.text)
  }
  assert.equal(ctx.pools[Object.keys(ctx.pools)[0]].length, 0, "三张抽完池空")
  // 新上下文重新洗牌
  const fresh = manager.draw("主牌", { pools: {} })
  assert.ok(!fresh.error)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("特殊变量与死循环保护", async () => {
  const { DeckManager } = await import("../domains/dice/DeckManager.js")
  const dir = makeDecksDir({
    "loop.json": JSON.stringify({
      循环: ["{循环A}"],
      循环A: ["{循环B}"],
      循环B: ["{循环}"],
      问候: ["你好，{player}，我是{self}"]
    })
  })
  const manager = new DeckManager({ decksDir: dir })
  manager.reload()
  const r = manager.draw("循环", { pools: {}, playerName: "测试者", selfName: "希洛" })
  assert.ok(r.error?.match(/上限|死循环/) || /抽取错误/.test(r.text || ""), `死循环被拦截: ${r.error || r.text}`)
  const g = manager.draw("问候", { pools: {}, playerName: "阿明", selfName: "希洛" })
  assert.equal(g.text, "你好，阿明，我是希洛")
  const miss = manager.draw("不存在的牌组", { pools: {} })
  assert.match(miss.error, /不存在/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("search 与 desc", async () => {
  const { DeckManager } = await import("../domains/dice/DeckManager.js")
  const dir = makeDecksDir({ "sample.json": SAMPLE_JSON })
  const manager = new DeckManager({ decksDir: dir })
  manager.reload()
  assert.match(manager.searchDecks("武"), /测试牌堆\/武器/)
  assert.match(manager.descDeck("测试"), /作者: 希洛/)
  assert.match(manager.descDeck("测试"), /牌组: 主牌\/武器\/药品/)
  fs.rmSync(dir, { recursive: true, force: true })
})
