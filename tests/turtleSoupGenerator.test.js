import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {TurtleSoupStore} from "../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupStore.js"
import {TurtleSoupGenerator} from "../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupGenerator.js"

const now = 1_700_000_000_000
function makePuzzle(id, overrides = {}) {
  return {id, title: `标题${id}`, surface: "独立汤面" + id + "。", solution: "独立汤底" + id, keyPoints: ["要点"], hints: ["提示一", "提示二", "提示三"], difficulty: "normal", tags: [], source: "manual", createdAt: now, status: "active", ratingSum: 0, ratingCount: 0, ...overrides}
}
const config = {enabled: true, minPlayers: 2, joinWindowMinutes: 5, idleTimeoutMinutes: 5, guessCooldownSeconds: 30, similarityHitThreshold: 0.9, similarityMissThreshold: 0, freshPoolTarget: 2, generationModel: "", ratingWindowMinutes: 5, maxHints: 3, contentPolicy: "测试尺度", baseDir: "data/turtle_soup"}

function makeGenerator(callModel, {target = 2} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turtle-soup-gen-"))
  const store = new TurtleSoupStore({cwd: dir, baseDir: "data/turtle_soup"})
  const generator = new TurtleSoupGenerator({store, config: () => ({...config, freshPoolTarget: target}), callModel, logger: undefined, now: () => now, random: () => 0.5})
  return {dir, store, generator}
}

const stories = [
  "一个男人走进餐厅点了一碗汤，尝了一口就跳海了。",
  "女人每晚都给隔壁送一份晚餐，某天邻居搬走后她却报了警。",
  "男孩在生日当天收到自己寄出的信，看完后立刻收拾行李远走他乡。",
  "值班护士查房时发现3床空了，却笑着帮病人掖好了被子。"
]
const soupJson = (title, storyIndex = 0) => [
  "```json",
  JSON.stringify({title, surface: stories[storyIndex % stories.length], solution: "男人曾在海难中靠人肉汤幸存，如今尝出汤的味道和当年一样，明白当年喝的是同伴的肉，绝望跳海。", keyPoints: ["海难幸存者", "喝过人肉汤", "味觉触发真相"], hints: ["他之前经历过一场灾难", "当年他靠某种东西活了下来", "他认出了汤里的味道"], difficulty: "normal", tags: ["经典", "悬疑"]}),
  "```"
].join("\n")
const reviewJson = pass => JSON.stringify({pass, reason: pass ? "逻辑自洽" : "汤面泄露汤底"})

test("generateOne parses fenced JSON, self-reviews and saves the puzzle", async () => {
  const calls = []
  const {dir, store, generator} = makeGenerator(async (messages, options) => {
    calls.push({messages, options})
    return messages[0].role === "system" && String(messages[0].content).includes("出题人") ? soupJson("一碗海龟汤") : reviewJson(true)
  })
  try {
    const puzzle = await generator.generateOne()
    assert.match(puzzle.id, /^ts_/)
    assert.equal(puzzle.source, "ai")
    assert.equal(puzzle.status, "active")
    assert.equal(puzzle.hints.length, 3)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].options.temperature, 0.9)
    assert.equal(calls[1].options.temperature, 0.2)
    const saved = store.readPuzzles().puzzles
    assert.equal(saved.length, 1)
    assert.equal(saved[0].title, "一碗海龟汤")
  } finally { fs.rmSync(dir, {recursive: true, force: true}) }
})

test("ensureFreshPool tops the fresh pool up to target and stops", async () => {
  let generated = 0
  const {dir, store, generator} = makeGenerator(async messages => {
    if (String(messages[0].content).includes("出题人")) { generated++; return soupJson(`鲜汤${generated}`, generated) }
    return reviewJson(true)
  })
  try {
    const outcome = await generator.ensureFreshPool()
    assert.equal(outcome.added, 2)
    assert.equal(generator.freshCount(), 2)
    assert.equal(store.readPuzzles().puzzles.length, 2)
    const again = await generator.ensureFreshPool()
    assert.equal(again.added, 0)
    assert.equal(generated, 2)
  } finally { fs.rmSync(dir, {recursive: true, force: true}) }
})

test("duplicate generations are rejected and retried, then counted as failure", async () => {
  const {dir, store, generator} = makeGenerator(async messages => {
    if (String(messages[0].content).includes("出题人")) return soupJson("一碗海龟汤")
    return reviewJson(true)
  })
  try {
    await generator.generateOne()
    await assert.rejects(() => generator.generateOne(), /重复/)
    const outcome = await generator.ensureFreshPool()
    assert.equal(outcome.failed, 6)
    assert.match(outcome.lastError, /重复/)
    assert.equal(store.readPuzzles().puzzles.length, 1)
  } finally { fs.rmSync(dir, {recursive: true, force: true}) }
})

test("failed review consumes retry attempts and surfaces the reason", async () => {
  const {dir, generator} = makeGenerator(async messages => {
    if (String(messages[0].content).includes("出题人")) return soupJson("审题不过")
    return reviewJson(false)
  })
  try {
    await assert.rejects(() => generator.generateOne(), /审题未通过/)
  } finally { fs.rmSync(dir, {recursive: true, force: true}) }
})

test("generation lock rejects concurrent refill and seeding", async () => {
  let release
  let generated = 0
  const gate = new Promise(resolve => { release = resolve })
  const {dir, generator} = makeGenerator(async messages => {
    if (String(messages[0].content).includes("出题人")) { await gate; return soupJson(`锁测试${++generated}`, generated) }
    return reviewJson(true)
  })
  try {
    const pending = generator.ensureFreshPool()
    assert.equal(generator.busy, true)
    assert.deepEqual(await generator.seed(3), {added: 0, failed: 0, lastError: "busy"})
    assert.deepEqual(await generator.ensureFreshPool(), {added: 0, failed: 0, lastError: "busy"})
    release()
    const outcome = await pending
    assert.equal(outcome.added, 2)
    assert.equal(generator.busy, false)
  } finally { release?.(); fs.rmSync(dir, {recursive: true, force: true}) }
})

test("seed generates the requested count and reports failures", async () => {
  let genCalls = 0
  const {dir, store, generator} = makeGenerator(async messages => {
    if (String(messages[0].content).includes("出题人")) {
      genCalls++
      if (genCalls === 2 || genCalls === 3) return "不是JSON"
      return soupJson(`种子${genCalls}`, genCalls)
    }
    return reviewJson(true)
  })
  try {
    const outcome = await generator.seed(3)
    assert.equal(outcome.added, 2)
    assert.equal(outcome.failed, 1)
    assert.match(outcome.lastError, /合法汤面JSON/)
    assert.equal(store.readPuzzles().puzzles.length, 2)
  } finally { fs.rmSync(dir, {recursive: true, force: true}) }
})

test("generation prompt carries rating feedback from the library", async () => {
  const {dir, store, generator} = makeGenerator(async messages => {
    if (String(messages[1].content).includes("评分反馈")) captured = String(messages[1].content)
    if (String(messages[0].content).includes("出题人")) return soupJson("反馈汤", 3)
    return reviewJson(true)
  })
  let captured = ""
  try {
    // 高分汤:均分4.5(带好评);低分汤:均分2.0(带差评)
    await store.savePuzzle({...makePuzzle("good1", {ratingSum: 9, ratingCount: 2})})
    await store.savePuzzle({...makePuzzle("bad1", {ratingSum: 2, ratingCount: 1})})
    await store.upsertPlay({playId: "pl1", puzzleId: "good1", puzzleTitle: "", groupId: "1", startedAt: 1, endedAt: 2, endReason: "solved", solved: true, players: ["u1"], qaCount: 0, ratings: [{userId: "u1", score: 5, comment: "反转精彩", at: 1}]})
    await store.upsertPlay({playId: "pl2", puzzleId: "bad1", puzzleTitle: "", groupId: "1", startedAt: 1, endedAt: 2, endReason: "manual", solved: false, players: ["u1"], qaCount: 0, ratings: [{userId: "u1", score: 2, comment: "汤底太牵强", at: 1}]})
    await generator.generateOne()
    assert.match(captured, /评分反馈/)
    assert.match(captured, /高分题.*标题good1\(4\.5分\)/)
    assert.match(captured, /低分题/)
    assert.match(captured, /标题bad1\(2\.0分\)/)
    assert.match(captured, /批评:"汤底太牵强"/)
  } finally { fs.rmSync(dir, {recursive: true, force: true}) }
})
