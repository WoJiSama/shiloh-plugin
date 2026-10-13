import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import YAML from "yaml"

const serverFile = fileURLToPath(new URL("../console/server.js", import.meta.url))

async function startFixtureServer(root, t, envOverrides = {}) {
  const child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, CONSOLE_PLUGIN_ROOT: root, CONSOLE_HOST: "127.0.0.1", CONSOLE_PORT: "0", ...envOverrides },
    stdio: ["ignore", "pipe", "pipe"]
  })
  t.after(async () => {
    if (child.exitCode !== null) return
    child.kill("SIGTERM")
    await new Promise(resolve => child.once("exit", resolve))
  })
  return await new Promise((resolve, reject) => {
    let output = ""
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`fixture server startup timed out: ${output}`)) }, 5000)
    child.stdout.on("data", chunk => {
      output += chunk.toString()
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) { clearTimeout(timeout); resolve(match[1]) }
    })
    child.stderr.on("data", chunk => { output += chunk.toString(); t.diagnostic(chunk.toString()) })
    child.once("exit", code => { clearTimeout(timeout); if (code) reject(new Error(`fixture server exited ${code}: ${output}`)) })
  })
}

test("isolated console HTTP saves safely, preserves YAML and credentials, and probes redacted providers", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-http-fixture-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, "config"), { recursive: true })
  fs.mkdirSync(path.join(root, "console", "frontend", "dist", "assets"), { recursive: true })
  fs.writeFileSync(path.join(root, "console", "frontend", "dist", "index.html"), "<!doctype html><title>Console Fixture</title>")
  const token = "console-fixture-token-only"
  fs.writeFileSync(path.join(root, "config", "console.json"), JSON.stringify({ token }))
  const pageToken = "fixture-page-secret-only"
  const observeToken = "fixture-observe-secret-only"
  fs.writeFileSync(path.join(root, "config", "commands-web.json"), JSON.stringify({ token: pageToken, observeToken }))
  let observedAuthorization = ""
  let groupMetadataAvailable = true
  let identityRequests = 0
  const upstream = http.createServer((req, res) => {
    observedAuthorization = req.headers.authorization || ""
    req.resume()
    req.on("end", () => {
      if (req.url === "/bl-chat/commands/api/identities") {
        identityRequests++
        assert.equal(req.headers["x-commands-token"], pageToken)
        res.writeHead(groupMetadataAvailable ? 200 : 503, { "content-type": "application/json" })
        res.end(JSON.stringify(groupMetadataAvailable
          ? { bots: [{ id: "300003", name: "机器人昵称" }], groups: [{ id: "100001", name: "当前群名" }, { id: "999999", name: "其他群" }] }
          : { error: "fixture-unavailable" }))
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(req.url.startsWith("/bl-chat/")
        ? { path: req.url, headers: req.headers }
        : { choices: [{ message: { content: "pong" } }], usage: { total_tokens: 2 } }))
    })
  })
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  const apiUrl = `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`
  const configFile = path.join(root, "config", "message.yaml")
  fs.writeFileSync(configFile, `# keep this comment\npluginSettings:\n  unrelated: keep-this-value\n` + YAML.stringify({
    allowedGroups: [100001, 200002],
    messagePipeline: { eventConcurrency: 8 }, youtubeRelay: { cookieHeader: "fixture-cookie", poToken: "fixture-po" },
    chatAiConfig: { providers: [
      { name: "a", apiUrl, model: "model-a", apiKey: "fixture-provider-a-secret", priority: 1 },
      { name: "b", apiUrl, model: "model-b", apiKey: "fixture-provider-b-secret", priority: 2 }
    ] }
  }).split("\n").filter(Boolean).map(line => `  ${line}\n`).join(""))
  fs.mkdirSync(path.join(root, "data"), { recursive: true })
  fs.writeFileSync(path.join(root, "data", "group_names.json"), JSON.stringify({ "100001": "缓存旧名", "200002": "缓存群名" }))
  const base = await startFixtureServer(root, t, { CONSOLE_YUNZAI_PORT: String(upstream.address().port), CONSOLE_YUNZAI_HOST: "127.0.0.1" })
  const request = async (pathname, { method = "GET", body } = {}) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: { "x-console-token": token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie") }
  }
  assert.equal((await fetch(base)).status, 200)
  assert.equal((await fetch(`${base}/api/config/pipeline`)).status, 401)
  const apps = (await request("/api/apps")).data
  const namedGroups = (await request("/api/groups")).data.groups
  assert.equal(namedGroups.find(group => group.id === "100001").name, "当前群名")
  assert.equal(namedGroups.find(group => group.id === "200002").name, "缓存群名")
  assert.equal(namedGroups.some(group => group.id === "999999"), false, "群名元数据不扩展白名单和活动列表")
  groupMetadataAvailable = false
  assert.equal((await request("/api/groups")).data.groups.find(group => group.id === "100001").name, "当前群名")
  const directory = (await request("/api/identities")).data
  assert.deepEqual(directory.bots, [{ id: "300003", name: "机器人昵称" }])
  assert.equal(directory.groups.find(group => group.id === "200002").name, "缓存群名")
  assert.equal(identityRequests, 1, "Concurrent page reads reuse the short identity cache")
  assert.equal((await fetch(`${base}/api/identities`)).status, 401)
  const offlineBase = await startFixtureServer(root, t, { CONSOLE_YUNZAI_PORT: String(upstream.address().port), CONSOLE_YUNZAI_HOST: "127.0.0.1" })
  const offlineDirectory = await (await fetch(`${offlineBase}/api/identities`, { headers: { "x-console-token": token } })).json()
  assert.equal(offlineDirectory.groups.find(group => group.id === "100001").name, "缓存旧名")
  assert.deepEqual(offlineDirectory.bots, [])
  groupMetadataAvailable = true
  assert.equal(JSON.stringify(apps).includes(pageToken), false)
  assert.equal(JSON.stringify(apps).includes(observeToken), false)
  assert.equal(JSON.stringify(apps).includes("?token="), false)
  const nativeProxy = await request("/bl-chat/semantic-memory/api/stats")
  assert.equal(nativeProxy.status, 200)
  assert.equal(nativeProxy.data.headers["x-commands-token"], observeToken)
  assert.equal(nativeProxy.data.headers["x-console-token"], undefined)
  const commandProxy = await request("/bl-chat/commands/api/settings")
  assert.equal(commandProxy.data.headers["x-commands-token"], pageToken)
  const setup = await request("/api/auth/setup", { method: "POST", body: { username: "fixture", password: "fixture-password-only" } })
  assert.equal(setup.status, 200)
  const cookie = setup.cookie.split(";")[0]
  const cookieProxy = await fetch(`${base}/bl-chat/semantic-memory/api/stats`, { headers: { cookie } })
  assert.equal(cookieProxy.status, 200)
  const cookieProxyData = await cookieProxy.json()
  assert.equal(cookieProxyData.headers["x-commands-token"], observeToken)
  assert.equal(cookieProxyData.headers.cookie, undefined)
  const queryConsoleProxy = await fetch(`${base}/bl-chat/semantic-memory/api/stats?token=${token}`)
  const queryConsoleData = await queryConsoleProxy.json()
  assert.equal(queryConsoleData.path.includes(token), false)
  assert.equal(queryConsoleData.headers["x-commands-token"], observeToken)
  const legacyProxy = await fetch(`${base}/bl-chat/commands/api/settings?token=${pageToken}`)
  assert.equal(legacyProxy.status, 200)
  assert.equal((await legacyProxy.json()).path.includes(pageToken), true)
  assert.equal((await fetch(`${base}/bl-chat/commands/api/settings?token=invalid-fixture`)).status, 401)
  const schema = (await request("/api/config/pipeline")).data
  assert.equal(JSON.stringify(schema).includes("fixture-cookie"), false)
  const invalid = await request("/api/config/pipeline", { method: "PUT", body: { revision: schema.revision, values: { "messagePipeline.eventConcurrency": "" } } })
  assert.equal(invalid.status, 400)
  assert.equal(fs.readdirSync(path.join(root, "config")).some(name => name.includes("bak-console")), false)
  const saved = await request("/api/config/pipeline", { method: "PUT", body: { revision: schema.revision, values: { "messagePipeline.eventConcurrency": 10 }, secrets: { "youtubeRelay.cookieHeader": { action: "keep" } } } })
  assert.equal(saved.status, 200)
  assert.equal(saved.data.changed, 1)
  assert.equal(saved.data.applyMode, "restart")
  assert.ok(saved.data.backup)
  assert.notEqual(saved.data.revision, schema.revision)
  assert.equal(fs.readFileSync(configFile, "utf8").includes("# keep this comment"), true)
  let stored = YAML.parse(fs.readFileSync(configFile, "utf8")).pluginSettings
  assert.equal(stored.unrelated, "keep-this-value")
  assert.equal(stored.youtubeRelay.cookieHeader, "fixture-cookie")
  assert.equal((await request("/api/config/pipeline", { method: "PUT", body: { revision: schema.revision, values: { "messagePipeline.eventConcurrency": 12 } } })).status, 409)
  const reasoning = await request("/api/config/reasoning")
  assert.equal(reasoning.status, 200)
  const reasoningSaved = await request("/api/config/reasoning", { method: "PUT", body: { revision: reasoning.data.revision, values: { "taskAiConfig.casual.reasoningEffort": "low" } } })
  assert.equal(reasoningSaved.status, 200)
  assert.equal((await request("/api/config/reasoning")).data.groups[0].fields.find(field => field.field === "taskAiConfig.casual.reasoningEffort").value, "low")
  const ai = (await request("/api/ai/config")).data
  const providers = ai.sections.chatAiConfig.reverse()
  assert.equal(JSON.stringify(ai).includes("fixture-provider-a-secret"), false)
  const aiSaved = await request("/api/ai/config", { method: "PUT", body: { configKey: "chatAiConfig", providers, revision: ai.revisions.chatAiConfig } })
  assert.equal(aiSaved.status, 200)
  stored = YAML.parse(fs.readFileSync(configFile, "utf8")).pluginSettings
  assert.deepEqual(stored.chatAiConfig.providers.map(provider => provider.apiKey), ["fixture-provider-b-secret", "fixture-provider-a-secret"])
  assert.deepEqual(aiSaved.data.providers.map(provider => provider._consoleId), providers.map(provider => provider._consoleId))
  const probe = await request("/api/ai/probe-provider", { method: "POST", body: { configKey: "chatAiConfig", provider: { ...aiSaved.data.providers[0], apiKey: "", apiKeyAction: "keep" } } })
  assert.equal(probe.status, 200)
  assert.equal(probe.data.results[0].ok, true)
  assert.equal(observedAuthorization, "Bearer fixture-provider-b-secret")
  assert.equal((await request("/api/pipeline/jobs?limit=999")).status, 400)
  const library = (await request("/api/persona/library")).data
  const librarySaved = await request("/api/persona/library", { method: "PUT", body: { personas: [{ id: "fixture", name: "测试", identity: "测试人设" }], groupBindings: {}, accountBindings: {}, privateBinding: "", revision: library.revision } })
  assert.equal(librarySaved.status, 200)
  assert.notEqual(librarySaved.data.revision, library.revision)
  assert.equal((await request("/api/persona/library", { method: "PUT", body: { personas: [], revision: library.revision } })).status, 409)
})
