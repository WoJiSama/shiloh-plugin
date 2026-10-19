import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import os from "os"
import path from "path"
import http from "http"
import YAML from "yaml"
import { TurtleSoupStore, readTurtleSoupConfig } from "../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupStore.js"
import { TurtleSoupManager } from "../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupManager.js"
import { puzzleContentHash } from "../dist/backend/modules/games/domain/turtleSoup/turtleSoupQuality.js"

// 海龟汤控制台管理 API:题库列表/过审/删除/生成任务(隔离 fixture + 本地模型桩)
const serverFile = path.resolve("console/server.js")

async function stopFixtureChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve, reject) => {
    let timeout
    const finish = error => {
      clearTimeout(timeout)
      child.off("exit", onExit)
      child.off("error", onError)
      if (error) reject(error)
      else resolve()
    }
    const onExit = () => finish()
    const onError = error => finish(error)
    child.once("exit", onExit)
    child.once("error", onError)
    timeout = setTimeout(() => {
      timeout = setTimeout(() => finish(new Error(`fixture child ${child.pid} did not exit after SIGKILL`)), 1000)
      child.kill("SIGKILL")
    }, 750)
    child.kill("SIGTERM")
  })
}

async function fixture(t, settingsBuilder = () => ({}), modelHandler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turtle-soup-console-"))
  fs.mkdirSync(path.join(root, "config"), { recursive: true })
  fs.writeFileSync(path.join(root, "config", "console.json"), JSON.stringify({ token: "isolated-turtle-soup-fixture" }))

  const calls = []
  const requests = []
  let child
  // Only this local model stub is reachable from the fixture.
  const modelStub = http.createServer((req, res) => {
    let body = ""
    req.on("data", chunk => { body += chunk })
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body)
        calls.push(payload)
        requests.push({path:req.url, authorization:req.headers.authorization})
        const content = modelHandler ? await modelHandler(payload, calls) : modelReply(payload)
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({choices: [{message: {content: typeof content === "string" ? content : JSON.stringify(content)}}]}))
      } catch (error) { res.writeHead(500); res.end(String(error)) }
    })
  })
  // One ordered teardown also handles startup failures and assertions while a request is pending.
  t.after(async () => {
    try { await stopFixtureChild(child) }
    finally {
      child?.stdout?.destroy()
      child?.stderr?.destroy()
      child?.unref()
      modelStub.closeAllConnections()
      await new Promise(resolve => modelStub.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  await new Promise((resolve, reject) => {
    modelStub.once("error", reject)
    modelStub.listen(0, "127.0.0.1", () => { modelStub.off("error", reject); resolve() })
  })
  const stubPort = modelStub.address().port
  fs.writeFileSync(path.join(root, "config", "message.yaml"), YAML.stringify({ pluginSettings: settingsBuilder(stubPort) }))

  const { spawn } = await import("node:child_process")
  child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, CONSOLE_PLUGIN_ROOT: root, CONSOLE_HOST: "127.0.0.1", CONSOLE_PORT: "0", CONSOLE_YUNZAI_HOST: "127.0.0.1", CONSOLE_YUNZAI_PORT: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  })
  const base = await new Promise((resolve, reject) => {
    let output = ""
    let settled = false
    const finish = (error, address) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.off("error", onError)
      child.off("exit", onExit)
      if (error) reject(error)
      else resolve(address)
    }
    const onError = error => finish(new Error(`fixture could not start: ${error.message}\n${output}`))
    const onExit = (code, signal) => finish(new Error(`fixture exited before listening (code=${code}, signal=${signal}): ${output}`))
    const timeout = setTimeout(() => finish(new Error(`fixture startup timed out: ${output}`)), 8000)
    child.once("error", onError)
    child.once("exit", onExit)
    child.stdout.on("data", chunk => {
      if (settled) return
      output = (output + chunk.toString()).slice(-16 * 1024)
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) finish(undefined, match[1])
    })
    child.stderr.on("data", chunk => { if (!settled) output = (output + chunk.toString()).slice(-16 * 1024) })
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode)
  })
  const headers = { "x-console-token": "isolated-turtle-soup-fixture" }
  const request = (pathname, init = {}) => fetch(`${base}${pathname}`, { headers, ...init })
  return { root, base, request, stubPort, calls, requests }
}

function seedStore(root, puzzles, plays = [], sessions = {}) {
  const dir = path.join(root, "data", "turtle_soup")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "puzzles.json"), JSON.stringify({ puzzles }))
  fs.writeFileSync(path.join(dir, "plays.json"), JSON.stringify({ plays }))
  fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify({ sessions }))
}

const puzzleOf = (id, overrides = {}) => ({
  id, title: `标题${id}`, status: "active", difficulty: "normal", tags: [], source: "ai",
  surface: "汤面".repeat(40), solution: "汤底".repeat(30), keyPoints: ["点一", "点二", "点三"],
  hints: ["a", "b", "c"], ratingSum: 0, ratingCount: 0, createdAt: 1, ...overrides
})

function approvedPuzzle(id, overrides = {}) {
  const puzzle = puzzleOf(id, overrides)
  const contentHash = puzzleContentHash(puzzle)
  return {...puzzle, contentHash, audits: ["structure", "playability", "logic", "simulation"].map(domain => ({domain, pass:true, reason:"已复核", holes:[], at:1, contentHash}))}
}
function modelReply(payload) {
  const system = String(payload.messages?.[0]?.content || "")
  const user = String(payload.messages?.[1]?.content || "")
  if (system.includes("出题人")) return {
    title: "深夜的琴房", surface: "汉".repeat(100), solution: "底".repeat(60),
    keyPoints:["点一", "点二", "点三"], hints:["a", "b", "c"],
    difficulty:user.match(/难度定为:(easy|normal|hard)/)?.[1] || "normal", tags:["悬疑"]
  }
  if (system.includes("修复师")) {
    const puzzle=JSON.parse(user).puzzle
    return {...puzzle, hints:(puzzle.hints.length===3?puzzle.hints:["先看时间", "再想原因", "考虑演奏者"]).map(hint=>hint+"，再核对线索"), difficulty:system.match(/难度必须:(easy|normal|hard)/)?.[1] || "normal"}
  }
  return {pass:true, holes:[], reason:"固定事实可解释线索", repairable:true,
    ...(system.includes("试玩审核员") ? {probes:[1,2,3].map(i => ({question:`问题${i}`, answer:"是", basis:`明确事实${i}`}))} : {})}
}
const modelSettings = port => ({chatAiConfig:{chatApiUrl:`http://127.0.0.1:${port}`,chatApiKey:"stub-key",chatApiModel:"stub"}})
async function waitForJob(request) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const overview = await (await request("/api/games/turtle-soup/overview")).json()
    if (!overview.generating.running) return overview
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error("model stub job did not finish")
}

test("overview 列出题库/在局/统计,状态修改与删除生效", async t => {
  const { root, request } = await fixture(t)
  seedStore(root, [
    puzzleOf("p1", { ratingSum: 9, ratingCount: 2 }),
    approvedPuzzle("p2", { status: "pending" }),
    puzzleOf("p3", { status: "retired" })
  ], [{ playId: "x", puzzleId: "p1", puzzleTitle: "标题p1", groupId: "1", startedAt: 1, solved: false, players: [], qaCount: 0, ratings: [] }],
  { "100": { groupId: "100", phase: "playing", puzzleId: "p1", players: [{ userId: "u1" }], startedAt: 1, lastActivityAt: 2 } })

  const overview = await (await request("/api/games/turtle-soup/overview")).json()
  assert.equal(overview.puzzles.length, 3)
  assert.equal(overview.puzzles.find(z => z.id === "p1").ratingAverage, 4.5)
  assert.equal(overview.puzzles.find(z => z.id === "p1").plays, 1)
  assert.equal(overview.sessions.length, 1)
  assert.equal(overview.sessions[0].phase, "playing")
  assert.equal(overview.generating.running, false)

  const approve = await request("/api/games/turtle-soup/puzzles/p2/status", { method: "PUT", body: JSON.stringify({ status: "active", reason: "人工复核内容完整", contentHash: puzzleContentHash(puzzleOf("p2", {status:"pending"})) }) })
  assert.equal(approve.status, 200)
  const after = await (await request("/api/games/turtle-soup/overview")).json()
  assert.equal(after.puzzles.find(z => z.id === "p2").status, "active")

  const badStatus = await request("/api/games/turtle-soup/puzzles/p2/status", { method: "PUT", body: JSON.stringify({ status: "bogus" }) })
  assert.equal(badStatus.status, 400)

  const deletePlayed = await request("/api/games/turtle-soup/puzzles/p1", { method: "DELETE" })
  assert.equal(deletePlayed.status, 400, "玩过的汤拒绝删除")
  const deleteFresh = await request("/api/games/turtle-soup/puzzles/p3", { method: "DELETE" })
  assert.equal(deleteFresh.status, 200)
  const final = await (await request("/api/games/turtle-soup/overview")).json()
  assert.equal(final.puzzles.length, 2)
})

test("生成任务走四道审核,产物以 pending 入库", async t => {
  const { root, request } = await fixture(t, stubPort => ({
    chatAiConfig: { chatApiUrl: `http://127.0.0.1:${stubPort}`, chatApiKey: "stub-key", chatApiModel: "stub" }
  }))
  seedStore(root, [])
  const start = await request("/api/games/turtle-soup/generate", { method: "POST", body: JSON.stringify({ count: 1 }) })
  assert.equal(start.status, 202)
  let overview
  for (let index = 0; index < 30; index++) {
    await new Promise(resolve => setTimeout(resolve, 300))
    overview = await (await request("/api/games/turtle-soup/overview")).json()
    if (!overview.generating.running) break
  }
  assert.equal(overview.generating.running, false)
  assert.equal(overview.generating.added, 1, "生成 1 道成功")
  assert.equal(overview.puzzles.length, 1)
  assert.equal(overview.puzzles[0].status, "pending", "入库即待审")
  assert.equal(overview.puzzles[0].title, "深夜的琴房")
  // 重复启动在运行中会被 409 拦(任务已结束,此处验证未配置时 400 分支不可达,只校验幂等成功)
  const restart = await request("/api/games/turtle-soup/generate", { method: "POST", body: JSON.stringify({ count: 1 }) })
  assert.equal(restart.status, 202)
})

test("未配置模型时生成接口返回 400", async t => {
  const { root, request } = await fixture(t)
  seedStore(root, [])
  const response = await request("/api/games/turtle-soup/generate", { method: "POST", body: JSON.stringify({ count: 1 }) })
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.ok(String(body.error).includes("未配置"))
})

test("完整模型接口地址与数组 API key 生成时保持正确请求", async t => {
  const {root, request, requests} = await fixture(t, port => ({
    chatAiConfig:{chatApiUrl:`http://127.0.0.1:${port}/v1/chat/completions/`, chatApiKey:[null, 42, " ", "sk-xxx", " stub-key "], chatApiModel:"stub"}
  }))
  seedStore(root, [])
  const response = await request("/api/games/turtle-soup/generate", {method:"POST", body:JSON.stringify({count:1})})
  assert.equal(response.status, 202)
  const overview = await waitForJob(request)
  assert.equal(overview.generating.added, 1)
  assert.ok(requests.length > 0)
  assert.ok(requests.every(request => request.path === "/v1/chat/completions"))
  assert.ok(requests.every(request => request.authorization === "Bearer stub-key"))
})

test("重新审计接口:四域结论追加到题目记录", async t => {
  const { root, request } = await fixture(t, stubPort => ({
    chatAiConfig: { chatApiUrl: `http://127.0.0.1:${stubPort}`, chatApiKey: "stub-key", chatApiModel: "stub" }
  }))
  seedStore(root, [puzzleOf("p1", { status: "active" })])
  const response = await request("/api/games/turtle-soup/puzzles/p1/audit", { method: "POST", body: JSON.stringify({}) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.audits.length, 4, "结构/审题/逻辑/试玩四域")
  assert.deepEqual(body.audits.map(audit => audit.domain), ["structure", "playability", "logic", "simulation"])
  assert.ok(body.audits.every(audit => audit.pass), "桩模型全过")
  const overview = await (await request("/api/games/turtle-soup/overview")).json()
  assert.equal(overview.puzzles[0].audits.length, 4, "审计结果随题持久化")
})

test("手动标记分:设置/清除/影响出题反馈", async t => {
  const { root, request } = await fixture(t)
  seedStore(root, [puzzleOf("p1", { status: "active" }), puzzleOf("p2", { status: "active" })])
  // 设置
  const set = await request("/api/games/turtle-soup/puzzles/p1/score", { method: "PUT", body: JSON.stringify({ score: 5 }) })
  assert.equal(set.status, 200)
  const overview = await (await request("/api/games/turtle-soup/overview")).json()
  assert.equal(overview.puzzles.find(z => z.id === "p1").manualScore, 5)
  // 非法值
  const bad = await request("/api/games/turtle-soup/puzzles/p1/score", { method: "PUT", body: JSON.stringify({ score: 6 }) })
  assert.equal(bad.status, 400)
  // 清除
  const clear = await request("/api/games/turtle-soup/puzzles/p1/score", { method: "DELETE" })
  assert.equal(clear.status, 200)
  const after = await (await request("/api/games/turtle-soup/overview")).json()
  assert.equal(after.puzzles.find(z => z.id === "p1").manualScore, null)
})

test("海龟汤配置字段与自定义目录贯穿生成、库存和审核模型", async t => {
  const {root, request, calls} = await fixture(t, port => ({...modelSettings(port), miniGames:{turtleSoup:{freshPoolTarget:9, baseDir:"data/custom-soup", generationModel:"writer-model", reviewModel:"review-model", contentPolicy:"仅日常推理"}}}))
  const view = await (await request("/api/config/turtleSoup")).json()
  const fields = view.groups.flatMap(group => group.fields)
  assert.equal(fields.find(field => field.field === "miniGames.turtleSoup.freshPoolTarget").value, 9)
  assert.ok(fields.every(field => field.field === "miniGames.enabled" || field.field.startsWith("miniGames.turtleSoup.")))
  const save = await request("/api/config/turtleSoup", {method:"PUT", body:JSON.stringify({revision:view.revision, values:{"miniGames.turtleSoup.freshPoolTarget":7}})})
  assert.equal(save.status, 200)
  const configured = YAML.parse(fs.readFileSync(path.join(root, "config/message.yaml"), "utf8")).pluginSettings
  assert.equal(configured.miniGames.turtleSoup.freshPoolTarget, 7)
  assert.equal(configured.turtleSoup, undefined)
  assert.equal((await request("/api/games/turtle-soup/generate", {method:"POST", body:JSON.stringify({count:1})})).status, 202)
  const overview = await waitForJob(request)
  assert.equal(overview.freshPoolTarget, 7)
  assert.equal(overview.generating.added, 1)
  assert.equal(overview.inventory.fresh, 0)
  assert.equal(overview.inventory.pending, 1)
  assert.equal(new TurtleSoupStore({cwd:root,baseDir:"data/custom-soup"}).readPuzzles().puzzles.length, 1)
  assert.equal(fs.existsSync(path.join(root, "data/turtle_soup/puzzles.json")), false)
  assert.equal(calls[0].model, "writer-model")
  assert.ok(calls.slice(1).every(call => call.model === "review-model"))
  assert.ok(calls[0].messages[0].content.includes("仅日常推理"))
})

const turtleConfigValues = view => Object.fromEntries(view.groups.flatMap(group => group.fields).map(field => [field.field, field.value]))
const readSettings = root => YAML.parse(fs.readFileSync(path.join(root, "config/message.yaml"), "utf8")).pluginSettings

test("海龟汤表单展示运行时默认值，原样保存不物化默认配置", async t => {
  const {root, request} = await fixture(t)
  const file = path.join(root, "config/message.yaml")
  const before = fs.readFileSync(file, "utf8")
  const view = await (await request("/api/config/turtleSoup")).json()
  const values = turtleConfigValues(view)
  const runtime = readTurtleSoupConfig(root)
  assert.equal(values["miniGames.enabled"], true)
  assert.equal(values["miniGames.turtleSoup.enabled"], true)
  for (const [field, value] of Object.entries(values)) {
    if (field.startsWith("miniGames.turtleSoup.")) assert.equal(value, runtime[field.slice("miniGames.turtleSoup.".length)], field)
  }
  const save = await request("/api/config/turtleSoup", {method:"PUT", body:JSON.stringify({revision:view.revision, values})})
  assert.equal(save.status, 200)
  assert.equal((await save.json()).changed, 0)
  assert.equal(fs.readFileSync(file, "utf8"), before)
})

test("旧海龟汤配置按运行时规则读取，修改只写规范路径并保留无关配置", async t => {
  const settings = {
    turtleSoup:{enabled:false, minPlayers:7, freshPoolTarget:3, generationCallBudget:3, generationModel:" legacy-writer ", hintCooldownSeconds:8},
    miniGames:{enabled:true, turtleSoup:{freshPoolTarget:9}, customGame:{enabled:false}},
    customPlugin:{keep:["alpha", "beta"]}
  }
  const {root, request} = await fixture(t, () => settings)
  const file = path.join(root, "config/message.yaml")
  fs.writeFileSync(file, `# unrelated comment\n${fs.readFileSync(file, "utf8")}`)
  const view = await (await request("/api/config/turtleSoup")).json()
  const values = turtleConfigValues(view)
  assert.equal(values["miniGames.turtleSoup.enabled"], false)
  assert.equal(values["miniGames.turtleSoup.minPlayers"], 7)
  assert.equal(values["miniGames.turtleSoup.freshPoolTarget"], 9)
  assert.equal(values["miniGames.turtleSoup.maxPending"], 18)
  assert.equal(values["miniGames.turtleSoup.generationModel"], "legacy-writer")
  assert.equal(values["miniGames.turtleSoup.generationCallBudget"], 4)
  const save = await request("/api/config/turtleSoup", {method:"PUT", body:JSON.stringify({revision:view.revision, values:{"miniGames.turtleSoup.minPlayers":8, "miniGames.turtleSoup.enabled":true}})})
  assert.equal(save.status, 200)
  const after = readSettings(root)
  assert.deepEqual(after.turtleSoup, settings.turtleSoup)
  assert.deepEqual(after.customPlugin, settings.customPlugin)
  assert.deepEqual(after.miniGames.customGame, settings.miniGames.customGame)
  assert.deepEqual(after.miniGames.turtleSoup, {freshPoolTarget:9, minPlayers:8, enabled:true})
  assert.match(fs.readFileSync(file, "utf8"), /^# unrelated comment/m)
  assert.equal(readTurtleSoupConfig(root).enabled, true)
  assert.equal(readTurtleSoupConfig(root).minPlayers, 8)
  assert.equal(readTurtleSoupConfig(root).hintCooldownSeconds, 8)
  assert.equal(readTurtleSoupConfig(root).generationCallBudget, 4)
})

test("根层旧配置和 nested 覆盖与运行时一致，规范保存保留原节点且检测根层冲突", async t => {
  const {root, request} = await fixture(t)
  const file = path.join(root, "config/message.yaml")
  const document = {
    turtleSoup:{minPlayers:7, freshPoolTarget:3, hintCooldownSeconds:8},
    miniGames:{enabled:false, turtleSoup:{guessCooldownSeconds:900}},
    rootUnrelated:{keep:true},
    pluginSettings:{unrelated:{keep:"nested"}, miniGames:{enabled:true, turtleSoup:{freshPoolTarget:9}}}
  }
  fs.writeFileSync(file, `# keep root-level comment\n${YAML.stringify(document)}`)
  const view = await (await request("/api/config/turtleSoup")).json()
  const values = turtleConfigValues(view), runtime = readTurtleSoupConfig(root)
  assert.equal(values["miniGames.enabled"], true, "nested miniGames 覆盖根层对象")
  assert.equal(values["miniGames.turtleSoup.minPlayers"], 7)
  assert.equal(values["miniGames.turtleSoup.freshPoolTarget"], 9)
  assert.equal(values["miniGames.turtleSoup.guessCooldownSeconds"], 30, "被整体遮蔽的 root miniGames 不再继承")
  for (const [field, value] of Object.entries(values)) {
    if (field.startsWith("miniGames.turtleSoup.")) assert.equal(value, runtime[field.slice("miniGames.turtleSoup.".length)], field)
  }
  const save = await request("/api/config/turtleSoup", {method:"PUT", body:JSON.stringify({revision:view.revision, values:{"miniGames.turtleSoup.minPlayers":8}})})
  assert.equal(save.status, 200)
  const after = YAML.parse(fs.readFileSync(file, "utf8"))
  assert.deepEqual(after.turtleSoup, document.turtleSoup)
  assert.deepEqual(after.miniGames, document.miniGames)
  assert.deepEqual(after.rootUnrelated, document.rootUnrelated)
  assert.deepEqual(after.pluginSettings.unrelated, document.pluginSettings.unrelated)
  assert.equal(after.pluginSettings.miniGames.turtleSoup.minPlayers, 8)
  assert.match(fs.readFileSync(file, "utf8"), /^# keep root-level comment/m)
  assert.equal(readTurtleSoupConfig(root).minPlayers, 8)
  const current = await (await request("/api/config/turtleSoup")).json()
  after.turtleSoup.hintCooldownSeconds = 9
  fs.writeFileSync(file, YAML.stringify(after))
  const stale = await request("/api/config/turtleSoup", {method:"PUT", body:JSON.stringify({revision:current.revision, values:{"miniGames.turtleSoup.minPlayers":10}})})
  assert.equal(stale.status, 409)
  assert.equal(readTurtleSoupConfig(root).minPlayers, 8)
})

test("首次写规范 miniGames 路径会保留根层继承项与小游戏禁用状态", async t => {
  const {root, request} = await fixture(t)
  const file = path.join(root, "config/message.yaml")
  const document = {
    miniGames:{enabled:false, turtleSoup:{enabled:true, minPlayers:7, freshPoolTarget:6, generationModel:"legacy-writer"}, anotherGame:{enabled:false, rounds:3}},
    pluginSettings:{unrelated:{keep:"nested"}}
  }
  fs.writeFileSync(file, `# preserve legacy group\n${YAML.stringify(document)}`)
  const before = readTurtleSoupConfig(root)
  const view = await (await request("/api/config/turtleSoup")).json()
  const values = turtleConfigValues(view)
  assert.equal(values["miniGames.enabled"], false)
  assert.equal(values["miniGames.turtleSoup.enabled"], true)
  assert.equal(values["miniGames.turtleSoup.freshPoolTarget"], 6)
  const response = await request("/api/config/turtleSoup", {method:"PUT", body:JSON.stringify({revision:view.revision, values:{"miniGames.turtleSoup.minPlayers":8}})})
  assert.equal(response.status, 200)
  const after = YAML.parse(fs.readFileSync(file, "utf8"))
  assert.deepEqual(after.miniGames, document.miniGames)
  assert.deepEqual(after.pluginSettings.unrelated, document.pluginSettings.unrelated)
  assert.deepEqual(after.pluginSettings.miniGames, {...document.miniGames, turtleSoup:{...document.miniGames.turtleSoup, minPlayers:8}})
  assert.deepEqual(readTurtleSoupConfig(root), {...before, minPlayers:8})
  assert.match(fs.readFileSync(file, "utf8"), /^# preserve legacy group/m)
})

test("小游戏总开关和海龟汤独立开关分别保存，必须同时开启才启用", async t => {
  const {root, request} = await fixture(t, () => ({miniGames:{enabled:false, turtleSoup:{enabled:true}}}))
  const getView = async () => (await request("/api/config/turtleSoup")).json()
  const save = async values => {
    const view = await getView()
    const response = await request("/api/config/turtleSoup", {method:"PUT", body:JSON.stringify({revision:view.revision, values})})
    assert.equal(response.status, 200)
    return turtleConfigValues(await getView())
  }
  const initial = turtleConfigValues(await getView())
  assert.equal(initial["miniGames.enabled"], false)
  assert.equal(initial["miniGames.turtleSoup.enabled"], true)
  assert.equal(readTurtleSoupConfig(root).enabled, false)
  await save({"miniGames.turtleSoup.freshPoolTarget":5})
  assert.equal(readSettings(root).miniGames.enabled, false)
  assert.equal(readSettings(root).miniGames.turtleSoup.enabled, true)
  await save({"miniGames.turtleSoup.enabled":false})
  const globalOnly = await save({"miniGames.enabled":true})
  assert.equal(globalOnly["miniGames.enabled"], true)
  assert.equal(globalOnly["miniGames.turtleSoup.enabled"], false)
  assert.equal(readTurtleSoupConfig(root).enabled, false)
  await save({"miniGames.turtleSoup.enabled":true})
  assert.equal(readTurtleSoupConfig(root).enabled, true)
})

test("海龟汤表单约束与运行时一致，拒绝小数和不足四次的生成预算", async t => {
  const {root, request} = await fixture(t)
  const view = await (await request("/api/config/turtleSoup")).json()
  const fields = view.groups.flatMap(group => group.fields)
  for (const field of fields.filter(field => field.component === "InputNumber")) {
    assert.equal(field.props.step, 1, field.field)
  }
  for (const values of [{"miniGames.turtleSoup.minPlayers":1.5}, {"miniGames.turtleSoup.generationCallBudget":3}, {"miniGames.turtleSoup.guessCooldownSeconds":3601}]) {
    const response = await request("/api/config/turtleSoup", {method:"PUT", body:JSON.stringify({revision:view.revision, values})})
    assert.equal(response.status, 400)
  }
  const save = await request("/api/config/turtleSoup", {method:"PUT", body:JSON.stringify({revision:view.revision, values:{"miniGames.turtleSoup.minPlayers":50, "miniGames.turtleSoup.idleTimeoutMinutes":240, "miniGames.turtleSoup.guessCooldownSeconds":3600, "miniGames.turtleSoup.generationCallBudget":4}})})
  assert.equal(save.status, 200)
  const runtime = readTurtleSoupConfig(root)
  assert.equal(runtime.minPlayers, 50)
  assert.equal(runtime.idleTimeoutMinutes, 240)
  assert.equal(runtime.guessCooldownSeconds, 3600)
  assert.equal(runtime.generationCallBudget, 4)
})

test("有效配置 revision 检测旧路径变化，允许无关改动并拒绝丢失版本或并发覆盖", async t => {
  const {root, request} = await fixture(t, () => ({turtleSoup:{minPlayers:2}, unrelated:{value:"initial"}}))
  const file = path.join(root, "config/message.yaml")
  const initial = await (await request("/api/config/turtleSoup")).json()
  const changed = readSettings(root)
  changed.turtleSoup.minPlayers = 3
  fs.writeFileSync(file, YAML.stringify({pluginSettings:changed}))
  const stale = await request("/api/config/turtleSoup", {method:"PUT", body:JSON.stringify({revision:initial.revision, values:{"miniGames.turtleSoup.freshPoolTarget":4}})})
  assert.equal(stale.status, 409)
  assert.equal((await request("/api/config/turtleSoup", {method:"PUT", body:JSON.stringify({values:{"miniGames.turtleSoup.minPlayers":4}})})).status, 400)
  const current = await (await request("/api/config/turtleSoup")).json()
  changed.unrelated.value = "keep-new-value"
  fs.writeFileSync(file, YAML.stringify({pluginSettings:changed}))
  const concurrent = await Promise.all([4, 5].map(minPlayers => request("/api/config/turtleSoup", {method:"PUT", body:JSON.stringify({revision:current.revision, values:{"miniGames.turtleSoup.minPlayers":minPlayers}})})))
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409])
  assert.equal(readSettings(root).unrelated.value, "keep-new-value")
  assert.ok([4, 5].includes(readTurtleSoupConfig(root).minPlayers))
})

test("配置在准备和持久化之间被其他进程修改时，底层 snapshot revision 仍拒绝写入", async t => {
  const {root, request} = await fixture(t)
  const file = path.join(root, "config/message.yaml"), lock = `${file}.lock`
  const view = await (await request("/api/config/turtleSoup")).json()
  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock, "owner"), String(process.pid))
  const pending = request("/api/config/turtleSoup", {method:"PUT", body:JSON.stringify({revision:view.revision, values:{"miniGames.turtleSoup.minPlayers":3}})})
  let external
  try {
    const started = Date.now()
    while (!fs.readdirSync(path.dirname(file)).some(name => name.startsWith("message.yaml.bak-console-"))) {
      assert.ok(Date.now() - started < 3000, "控制台应先准备更新和备份，再等待配置写锁")
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    external = YAML.stringify({pluginSettings:{unrelated:{changedDuringWrite:true}}})
    fs.writeFileSync(file, external)
  } finally { fs.rmSync(lock, {recursive:true, force:true}) }
  const response = await pending
  assert.equal(response.status, 409)
  assert.equal(fs.readFileSync(file, "utf8"), external)
})

test("不能用旧审核直接恢复投放，低分和状态改变必须记录理由", async t => {
  const {root, request} = await fixture(t)
  seedStore(root, [puzzleOf("p1", {status:"retired"})])
  const noReason = await request("/api/games/turtle-soup/puzzles/p1/status", {method:"PUT",body:JSON.stringify({status:"pending"})})
  assert.equal(noReason.status, 400)
  const blocked = await request("/api/games/turtle-soup/puzzles/p1/status", {method:"PUT",body:JSON.stringify({status:"active",reason:"恢复"})})
  assert.equal(blocked.status, 409)
  const score = await request("/api/games/turtle-soup/puzzles/p1/score", {method:"PUT",body:JSON.stringify({score:2})})
  assert.equal(score.status, 400)
  const fractional = await request("/api/games/turtle-soup/puzzles/p1/score", {method:"PUT",body:JSON.stringify({score:4.6})})
  assert.equal(fractional.status, 400)
  const pending = await request("/api/games/turtle-soup/puzzles/p1/status", {method:"PUT",body:JSON.stringify({status:"pending",reason:"修复后重新审核"})})
  assert.equal(pending.status, 200)
  const overview = await (await request("/api/games/turtle-soup/overview")).json()
  assert.equal(overview.puzzles[0].statusHistory.at(-1).reason, "修复后重新审核")
  assert.equal(overview.puzzles[0].statusHistory.at(-1).actor, "console-token")
})

test("当前题重新审核失败后暂停投放，保留失败证据", async t => {
  const {root, request} = await fixture(t, modelSettings, payload => {
    const answer = modelReply(payload)
    return String(payload.messages[0].content).includes("审题人") ? {...answer,pass:false,holes:["入口线索不足"],reason:"无法合理推进"} : answer
  })
  seedStore(root, [approvedPuzzle("p1")])
  const audit = await request("/api/games/turtle-soup/puzzles/p1/audit", {method:"POST",body:"{}"})
  assert.equal(audit.status, 200)
  const body = await audit.json()
  assert.equal(body.status, "pending")
  assert.equal(body.eligible, false)
  const overview = await (await request("/api/games/turtle-soup/overview")).json()
  assert.equal(overview.inventory.available, 0)
  assert.equal(overview.puzzles[0].statusHistory.at(-1).reason, "重新审核未通过，暂缓投放")
  assert.equal((await request("/api/games/turtle-soup/puzzles/p1/status", {method:"PUT",body:JSON.stringify({status:"active",reason:"尝试直接投放"})})).status, 409)
})

test("异步重审不会覆盖期间的出池和管理员评分", async t => {
  let release, entered
  const gate = new Promise(resolve => {release=resolve})
  const started = new Promise(resolve => {entered=resolve})
  const {root, request} = await fixture(t, modelSettings, async payload => {
    if (String(payload.messages[0].content).includes("审题人")) { entered(); await gate }
    return modelReply(payload)
  })
  seedStore(root, [approvedPuzzle("p1")])
  const audit = request("/api/games/turtle-soup/puzzles/p1/audit", {method:"POST",body:"{}"})
  await started
  try {
    assert.equal((await request("/api/games/turtle-soup/puzzles/p1/status", {method:"PUT",body:JSON.stringify({status:"retired",reason:"管理员主动出池"})})).status, 200)
    assert.equal((await request("/api/games/turtle-soup/puzzles/p1/score", {method:"PUT",body:JSON.stringify({score:1,reason:"核心反转需要重写"})})).status, 200)
  } finally {release()}
  assert.equal((await audit).status, 200)
  const overview = await (await request("/api/games/turtle-soup/overview")).json()
  assert.equal(overview.puzzles[0].status, "retired")
  assert.equal(overview.puzzles[0].manualScore, 1)
  assert.equal(overview.puzzles[0].manualScoreReason, "核心反转需要重写")
})

test("模型等待期间内容变更会拒绝写入旧版本审核", async t => {
  let release, entered
  const gate = new Promise(resolve => {release=resolve})
  const started = new Promise(resolve => {entered=resolve})
  const {root, request} = await fixture(t, modelSettings, async payload => {
    if (String(payload.messages[0].content).includes("审题人")) { entered(); await gate }
    return modelReply(payload)
  })
  seedStore(root, [puzzleOf("p1")])
  const audit = request("/api/games/turtle-soup/puzzles/p1/audit", {method:"POST",body:"{}"})
  await started
  try {await new TurtleSoupStore({cwd:root,baseDir:"data/turtle_soup"}).updatePuzzle("p1", puzzle => ({...puzzle,solution:puzzle.solution+"新增事实"}))}
  finally {release()}
  assert.equal((await audit).status, 409)
  const overview = await (await request("/api/games/turtle-soup/overview")).json()
  assert.equal(overview.puzzles[0].audits.length, 0)
})

test("同时启动只接受一项任务，任务有独立id", async t => {
  let release
  const gate = new Promise(resolve => {release=resolve})
  const {root, request, calls} = await fixture(t, modelSettings, async payload => {
    if (String(payload.messages[0].content).includes("出题人")) await gate
    return modelReply(payload)
  })
  seedStore(root, [])
  try {
    const responses = await Promise.all([1,2].map(() => request("/api/games/turtle-soup/generate", {method:"POST",body:JSON.stringify({count:1})})))
    assert.deepEqual(responses.map(response => response.status).sort(), [202,409])
    const job = await responses.find(response => response.status === 202).json()
    assert.match(job.generating.id, /^[a-f0-9-]{36}$/)
  } finally {release()}
  const overview = await waitForJob(request)
  assert.equal(overview.generating.added, 1)
  assert.equal(calls.filter(call => call.messages[0].content.includes("出题人")).length, 1)
})

test("串行批量任务在全部结束前公开已完成进度", async t => {
  let release, entered, generated=0
  const gate = new Promise(resolve => {release=resolve})
  const secondStarted = new Promise(resolve => {entered=resolve})
  const {root, request} = await fixture(t, modelSettings, async payload => {
    const answer = modelReply(payload)
    if (String(payload.messages[0].content).includes("出题人")) {
      generated++
      if (generated === 2) { entered(); await gate }
      return {...answer,title:generated===1?"甲谜":"乙谜",surface:(generated===1?"山":"河").repeat(100),solution:(generated===1?"船":"树").repeat(60)}
    }
    return answer
  })
  seedStore(root, [])
  assert.equal((await request("/api/games/turtle-soup/generate", {method:"POST",body:JSON.stringify({count:2})})).status, 202)
  await secondStarted
  try {
    const overview = await (await request("/api/games/turtle-soup/overview")).json()
    assert.equal(overview.generating.running, true)
    assert.equal(overview.generating.added, 1)
    assert.equal(overview.puzzles.length, 1)
  } finally {release()}
  const overview = await waitForJob(request)
  assert.equal(overview.generating.added, 2)
  assert.equal(overview.puzzles.length, 2)
})

test("历史被拒记录可以修复恢复为待审题，原有出池题修复保留版本关系", async t => {
  const {root, request} = await fixture(t, modelSettings)
  seedStore(root, [])
  fs.writeFileSync(path.join(root,"data/turtle_soup/rejected.jsonl"), JSON.stringify({...puzzleOf("old"),hints:undefined,holes:["缺少提示"],at:1})+"\n")
  const candidates = await (await request("/api/games/turtle-soup/candidates")).json()
  assert.equal(candidates.candidates.length, 1)
  assert.equal((await request(`/api/games/turtle-soup/candidates/${candidates.candidates[0].id}/recover`, {method:"POST",body:"{}"})).status, 202)
  let overview = await waitForJob(request)
  assert.equal(overview.generating.added, 1)
  const original = overview.puzzles[0]
  assert.equal(original.status, "pending")
  assert.equal((await request(`/api/games/turtle-soup/puzzles/${original.id}/status`, {method:"PUT",body:JSON.stringify({status:"retired",reason:"需进一步调整难度"})})).status, 200)
  assert.equal((await request(`/api/games/turtle-soup/puzzles/${original.id}/repair`, {method:"POST",body:JSON.stringify({reason:"让提示更循序渐进"})})).status, 202)
  overview = await waitForJob(request)
  assert.equal(overview.generating.added, 1)
  assert.equal(overview.puzzles.length, 2)
  const repaired = overview.puzzles.find(puzzle => puzzle.parentPuzzleId === original.id)
  assert.ok(repaired)
  assert.equal(repaired.familyId, original.familyId)
  assert.ok(repaired.version > original.version)
  assert.equal(repaired.status, "pending")
  assert.equal(overview.puzzles.find(puzzle => puzzle.id === original.id).status, "retired")
})

test("批准修复版会原子出池旧版，旧版正在进行的游戏仍能收局", async t => {
  const {root, request} = await fixture(t)
  const original = approvedPuzzle("p1", {familyId:"family",version:1,ratingCount:3,ratingSum:12})
  const revised = approvedPuzzle("p2", {familyId:"family",parentPuzzleId:"p1",version:2,status:"pending"})
  const now=Date.now()
  const play = {playId:"pl1",puzzleId:"p1",familyId:"family",puzzleTitle:original.title,groupId:"g1",startedAt:now,solved:false,players:["u1"],qaCount:0,ratings:[]}
  const session = {groupId:"g1",sessionId:"session1",playId:"pl1",phase:"playing",puzzleId:"p1",initiatorId:"u1",players:[{userId:"u1",nickname:"甲",joinedAt:now}],createdAt:now,joinDeadlineAt:now,lastActivityAt:now,startedAt:now,qaLog:[],guessLog:[],usedHints:0,lastGuessAt:{},surrendered:{}}
  seedStore(root,[original,revised],[play],{g1:session})
  const manager = new TurtleSoupManager({cwd:root,config:()=>readTurtleSoupConfig(root),host:{answerQuestion:async()=>"是",judgeGuess:async()=>({correct:false,reason:"未完整",closeness:0}),selectMvp:async()=>null},generator:{ensureFreshPool:async()=>({added:0,failed:0})}})
  const approve = await request("/api/games/turtle-soup/puzzles/p2/status", {method:"PUT",body:JSON.stringify({status:"active",reason:"新版本提示更公平",contentHash:puzzleContentHash(revised)})})
  assert.equal(approve.status,200)
  const overview=await (await request("/api/games/turtle-soup/overview")).json()
  assert.equal(overview.puzzles.find(item=>item.id==='p1').status,'retired')
  assert.equal(overview.puzzles.find(item=>item.id==='p1').ratingSum,12)
  assert.match(overview.puzzles.find(item=>item.id==='p1').statusHistory.at(-1).reason,/由第 2 版替代/)
  assert.equal(overview.inventory.available,1)
  assert.equal(overview.inventory.fresh,0,'新版本共享旧版曝光史')
  const reveal=await manager.endGame({group_id:'g1',user_id:'u1'})
  assert.ok(reveal.includes(original.solution))
  assert.equal(new TurtleSoupStore({cwd:root,baseDir:'data/turtle_soup'}).readPlays().plays[0].endReason,'manual')
})

test("模型服务故障停止批量后续任务，避免逐题重复消耗", async t => {
  const {root, request, calls} = await fixture(t, modelSettings, () => {throw new Error("local model unavailable")})
  seedStore(root, [])
  assert.equal((await request("/api/games/turtle-soup/generate", {method:"POST",body:JSON.stringify({count:3})})).status, 202)
  const overview = await waitForJob(request)
  assert.equal(overview.generating.failed,1)
  assert.equal(overview.generating.skipped,2)
  assert.equal(calls.length,2,'只重试当前调用一次，不继续余下两道')
  const candidates = await (await request("/api/games/turtle-soup/candidates")).json()
  assert.equal(candidates.candidates.length,1)
  assert.equal(candidates.candidates[0].failureKind,'technical')
})
