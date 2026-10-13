import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import YAML from "yaml"
import basic from "../models/configSchemas/basic.js"
import permission from "../models/configSchemas/permission.js"
import aiCore from "../models/configSchemas/aiCore.js"
import reasoning from "../models/configSchemas/reasoning.js"
import triggers from "../models/configSchemas/triggers.js"
import conversation from "../models/configSchemas/conversation.js"
import { buildSchemaConfigView, getIn, prepareSchemaUpdates, schemaFieldGroups, validateSchemaValue } from "../console/lib/schemaConfig.js"

const entry = { title: "对话与权限", schema: conversation }
const defaults = YAML.parse(fs.readFileSync(new URL("../config_default/message.yaml", import.meta.url), "utf8")).pluginSettings
const fields = schemaFieldGroups(conversation).flatMap(group => group.fields)

test("conversation migration covers the source modules once and retains Guoba compatibility", async () => {
  const excluded = new Set(["systemContent", ...reasoning.filter(item => item.field).map(item => item.field)])
  const expected = [...basic, ...permission, ...aiCore, ...triggers].filter(item => item.field && !excluded.has(item.field)).map(item => item.field)
  assert.deepEqual(fields.map(item => item.field).sort(), expected.sort())
  assert.equal(new Set(fields.map(item => item.field)).size, fields.length)
  assert.equal(conversation.every(Boolean), true)
  for (const [name, schema] of [["basic", basic], ["permission", permission], ["aiCore", aiCore], ["reasoning", reasoning]]) {
    assert.equal((await import(`../models/Guoba/schemas/${name}.js`)).default, schema)
  }
  const legacyTracking = (await import("../models/Guoba/schemas/tracking.js")).default
  assert.equal(legacyTracking.find(item => item.field === "chatTriggerMode"), triggers[0])
  assert.equal(legacyTracking.filter(item => item.field === "chatTriggerMode").length, 1)
})

test("conversation fields accept their configured defaults, including thinking token budgets", () => {
  for (const field of fields) validateSchemaValue(field, getIn(defaults, field.field))
  const casualTokens = fields.find(item => item.field === "taskAiConfig.casual.maxOutputTokens")
  assert.equal(validateSchemaValue(casualTokens, 1200), 1200)
  assert.equal(validateSchemaValue(casualTokens, 4096), 4096)
  for (const invalid of [0, 16385, 1200.5]) assert.throws(() => validateSchemaValue(casualTokens, invalid), { status: 400 })
  const concurrent = fields.find(item => item.field === "concurrentLimit")
  assert.throws(() => validateSchemaValue(concurrent, 2.5), { status: 400 })
})

test("conversation Select, secret and apply-time contracts remain explicit", () => {
  const settings = structuredClone(defaults)
  settings.taskAiConfig.casual.apiKey = "fixture-casual-private-key"
  const view = buildSchemaConfigView("conversation", entry, settings)
  const rendered = view.groups.flatMap(group => group.fields)
  assert.equal(JSON.stringify(view).includes("fixture-casual-private-key"), false)
  assert.deepEqual(rendered.filter(field => field.secret).map(field => [field.field, field.value]), [
    ["taskAiConfig.casual.apiKey", ""], ["taskAiConfig.progress.apiKey", ""], ["taskAiConfig.translation.apiKey", ""]
  ])
  assert.equal(rendered.find(field => field.field === "chatTriggerMode").component, "Select")
  assert.equal(rendered.find(field => field.field === "concurrentLimit").applyMode, "hot")
  assert.equal(rendered.find(field => field.field === "groupMaxMessages").applyMode, "restart")
  assert.equal(rendered.find(field => field.field === "groupChatMemoryMinutes").applyMode, "restart")
  for (const [name, value] of [["chatTriggerMode", "automatic"], ["taskAiConfig.casual.maxTokensField", "invalid_parameter"]]) {
    assert.throws(() => prepareSchemaUpdates("conversation", entry, settings, { values: { [name]: value } }), { status: 400 })
  }
  for (const name of ["systemContent", "chatAiConfig.chatReasoningEffort", "taskAiConfig.casual.reasoningEffort", "chatAiConfig.complexReasoningEffort"]) {
    assert.throws(() => prepareSchemaUpdates("conversation", entry, settings, { values: { [name]: "low" } }), { status: 400 })
  }
})

async function startServer(root, t) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../console/server.js", import.meta.url))], {
    env: { ...process.env, CONSOLE_PLUGIN_ROOT: root, CONSOLE_HOST: "127.0.0.1", CONSOLE_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  })
  t.after(async () => {
    if (child.exitCode !== null) return
    child.kill("SIGTERM")
    await new Promise(resolve => child.once("exit", resolve))
  })
  return new Promise((resolve, reject) => {
    let output = ""
    const timeout = setTimeout(() => { child.kill(); reject(new Error("conversation fixture server startup timed out")) }, 5000)
    child.stdout.on("data", chunk => {
      output += chunk.toString()
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) { clearTimeout(timeout); resolve(match[1]) }
    })
    child.stderr.on("data", chunk => { output += chunk.toString() })
    child.once("exit", code => { clearTimeout(timeout); if (code) reject(new Error(`conversation fixture server exited ${code}`)) })
  })
}

test("conversation HTTP persists only validated changes, preserves credentials and rejects stale drafts", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-conversation-fixture-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, "config"), { recursive: true })
  const token = "fixture-conversation-token"
  fs.writeFileSync(path.join(root, "config", "console.json"), JSON.stringify({ token }))
  const settings = structuredClone(defaults)
  settings.unrelated = "must-preserve"
  settings.taskAiConfig.casual.apiKey = "fixture-casual-key"
  settings.taskAiConfig.progress.apiKey = "fixture-progress-key"
  settings.taskAiConfig.translation.apiKey = "fixture-translation-key"
  settings.chatAiConfig.providers = [{ name: "fixture", apiUrl: "https://example.invalid/v1", model: "fixture-model", apiKey: "fixture-provider-key" }]
  const yamlFile = path.join(root, "config", "message.yaml")
  fs.writeFileSync(yamlFile, "# retain the original comment\n" + YAML.stringify({ pluginSettings: settings }))
  const base = await startServer(root, t)
  const request = async ({ method = "GET", body, authorized = true } = {}) => {
    const response = await fetch(`${base}/api/config/conversation`, {
      method, headers: { "content-type": "application/json", ...(authorized ? { "x-console-token": token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    return { status: response.status, data: await response.json() }
  }
  assert.equal((await request({ authorized: false })).status, 401)
  assert.equal((await request({ authorized: false, method: "PUT", body: { values: { enabled: false } } })).status, 401)
  assert.equal((await request({ method: "POST" })).status, 405)
  const initial = (await request()).data
  assert.equal(initial.key, "conversation")
  assert.equal(initial.groups.flatMap(group => group.fields).length, fields.length)
  for (const secret of ["fixture-casual-key", "fixture-progress-key", "fixture-translation-key", "fixture-provider-key"]) assert.equal(JSON.stringify(initial).includes(secret), false)
  const before = fs.readFileSync(yamlFile, "utf8")
  for (const values of [{ concurrentLimit: 1.5 }, { chatTriggerMode: "invalid" }, { unknown: true }, { "taskAiConfig.casual.apiKey": "unsafe-plain-key" }, { "taskAiConfig.casual.maxOutputTokens": 16385 }]) {
    assert.equal((await request({ method: "PUT", body: { revision: initial.revision, values } })).status, 400)
    assert.equal(fs.readFileSync(yamlFile, "utf8"), before)
  }
  assert.equal(fs.readdirSync(path.join(root, "config")).some(name => name.includes("bak-console")), false)
  const saved = await request({ method: "PUT", body: {
    revision: initial.revision,
    values: { enabled: false, chatTriggerMode: "smart", "privateChat.allowedUsers": ["100001", "100002"], "taskAiConfig.casual.maxOutputTokens": 4096 },
    secrets: { "taskAiConfig.casual.apiKey": { action: "keep" } }
  } })
  assert.equal(saved.status, 200)
  assert.equal(saved.data.changed, 4)
  assert.equal(saved.data.applyMode, "hot")
  assert.ok(saved.data.backup)
  let stored = YAML.parse(fs.readFileSync(yamlFile, "utf8")).pluginSettings
  assert.equal(stored.enabled, false)
  assert.equal(stored.chatTriggerMode, "smart")
  assert.deepEqual(stored.privateChat.allowedUsers, ["100001", "100002"])
  assert.equal(stored.taskAiConfig.casual.maxOutputTokens, 4096)
  for (const task of ["casual", "progress", "translation"]) assert.equal(stored.taskAiConfig[task].apiKey, settings.taskAiConfig[task].apiKey)
  assert.deepEqual(stored.chatAiConfig.providers, settings.chatAiConfig.providers)
  assert.equal(stored.unrelated, "must-preserve")
  assert.equal(fs.readFileSync(yamlFile, "utf8").startsWith("# retain the original comment"), true)
  const current = (await request()).data
  assert.notEqual(current.revision, initial.revision)
  const afterSave = fs.readFileSync(yamlFile, "utf8")
  assert.equal((await request({ method: "PUT", body: { revision: initial.revision, values: { enabled: true } } })).status, 409)
  assert.equal(fs.readFileSync(yamlFile, "utf8"), afterSave)
  const changedElsewhere = YAML.parse(afterSave)
  changedElsewhere.pluginSettings.taskAiConfig.translation.apiKey = "fixture-changed-elsewhere"
  fs.writeFileSync(yamlFile, YAML.stringify(changedElsewhere))
  assert.equal((await request({ method: "PUT", body: { revision: current.revision, values: { enabled: true } } })).status, 409)
  const latest = (await request()).data
  const changedSecret = await request({ method: "PUT", body: { revision: latest.revision, secrets: { "taskAiConfig.progress.apiKey": { action: "replace", value: "fixture-new-progress-key" } } } })
  assert.equal(changedSecret.status, 200)
  assert.equal(JSON.stringify(changedSecret).includes("fixture-new-progress-key"), false)
  stored = YAML.parse(fs.readFileSync(yamlFile, "utf8")).pluginSettings
  assert.equal(stored.taskAiConfig.progress.apiKey, "fixture-new-progress-key")
  assert.equal(stored.taskAiConfig.casual.apiKey, "fixture-casual-key")
  assert.equal(stored.taskAiConfig.translation.apiKey, "fixture-changed-elsewhere")
})
