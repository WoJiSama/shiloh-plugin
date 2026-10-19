import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import os from "os"
import path from "path"
import http from "http"
import YAML from "yaml"

// 海龟汤控制台管理 API:题库列表/过审/删除/生成任务(隔离 fixture + 本地模型桩)
const serverFile = path.resolve("console/server.js")

async function fixture(t, settingsBuilder = () => ({})) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turtle-soup-console-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, "config"), { recursive: true })
  fs.writeFileSync(path.join(root, "config", "console.json"), JSON.stringify({ token: "isolated-turtle-soup-fixture" }))

  // 本地模型桩:按 system 角色返回 出题/审题/审计 三种应答
  const modelStub = http.createServer((req, res) => {
    let body = ""
    req.on("data", chunk => { body += chunk })
    req.on("end", () => {
      const payload = JSON.parse(body)
      const system = String(payload.messages?.[0]?.content || "")
      res.setHeader("content-type", "application/json")
      if (system.includes("出题人")) {
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          title: "深夜的琴房", surface: "汉".repeat(100), solution: "底".repeat(60),
          keyPoints: ["点一", "点二", "点三"], hints: ["a", "b", "c"], difficulty: "normal", tags: ["悬疑"]
        }) } }] }))
      } else if (system.includes("审题人")) {
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ pass: true, reason: "自洽" }) } }] }))
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ pass: true, holes: [], reason: "无漏洞" }) } }] }))
      }
    })
  })
  await new Promise(resolve => modelStub.listen(0, "127.0.0.1", resolve))
  const stubPort = modelStub.address().port
  t.after(() => modelStub.close())
  fs.writeFileSync(path.join(root, "config", "message.yaml"), YAML.stringify({ pluginSettings: settingsBuilder(stubPort) }))

  const { spawn } = await import("node:child_process")
  const child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, CONSOLE_PLUGIN_ROOT: root, CONSOLE_HOST: "127.0.0.1", CONSOLE_PORT: "0", CONSOLE_YUNZAI_HOST: "127.0.0.1", CONSOLE_YUNZAI_PORT: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  })
  t.after(async () => {
    if (child.exitCode !== null) return
    child.kill("SIGTERM")
    await new Promise(resolve => child.once("exit", resolve))
  })
  const base = await new Promise((resolve, reject) => {
    let output = ""
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`fixture startup timed out: ${output}`)) }, 8000)
    child.stdout.on("data", chunk => {
      output += chunk.toString()
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) { clearTimeout(timeout); resolve(match[1]) }
    })
    child.stderr.on("data", chunk => { output += chunk.toString() })
  })
  const headers = { "x-console-token": "isolated-turtle-soup-fixture" }
  const request = (pathname, init = {}) => fetch(`${base}${pathname}`, { headers, ...init })
  return { root, base, request, stubPort }
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

test("overview 列出题库/在局/统计,状态修改与删除生效", async t => {
  const { root, request } = await fixture(t)
  seedStore(root, [
    puzzleOf("p1", { ratingSum: 9, ratingCount: 2 }),
    puzzleOf("p2", { status: "pending" }),
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

  const approve = await request("/api/games/turtle-soup/puzzles/p2/status", { method: "PUT", body: JSON.stringify({ status: "active" }) })
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

test("生成任务走三道审核,产物以 pending 入库", async t => {
  const { root, request } = await fixture(t, stubPort => ({
    chatAiConfig: { chatApiUrl: `http://127.0.0.1:${stubPort}`, chatApiKey: "stub-key", chatApiModel: "stub" }
  }))
  seedStore(root, [])
  const start = await request("/api/games/turtle-soup/generate", { method: "POST", body: JSON.stringify({ count: 1 }) })
  assert.equal(start.status, 200)
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
  assert.equal(restart.status, 200)
})

test("未配置模型时生成接口返回 400", async t => {
  const { root, request } = await fixture(t)
  seedStore(root, [])
  const response = await request("/api/games/turtle-soup/generate", { method: "POST", body: JSON.stringify({ count: 1 }) })
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.ok(String(body.error).includes("未配置"))
})

test("重新审计接口:三域结论追加到题目记录", async t => {
  const { root, request } = await fixture(t, stubPort => ({
    chatAiConfig: { chatApiUrl: `http://127.0.0.1:${stubPort}`, chatApiKey: "stub-key", chatApiModel: "stub" }
  }))
  seedStore(root, [puzzleOf("p1", { status: "active" })])
  const response = await request("/api/games/turtle-soup/puzzles/p1/audit", { method: "POST", body: JSON.stringify({}) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.audits.length, 3, "结构/审题/逻辑三域")
  assert.deepEqual(body.audits.map(audit => audit.domain), ["structure", "playability", "logic"])
  assert.ok(body.audits.every(audit => audit.pass), "桩模型全过")
  const overview = await (await request("/api/games/turtle-soup/overview")).json()
  assert.equal(overview.puzzles[0].audits.length, 3, "审计结果随题持久化")
})
