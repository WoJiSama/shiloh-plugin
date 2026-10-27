import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import YAML from "yaml"
import dice from "../models/configSchemas/dice.js"
import tracking from "../models/configSchemas/tracking.js"
import memory from "../models/configSchemas/memory.js"
import { schemas as guoba } from "../models/Guoba/schemas/index.js"
import { buildSchemaConfigView, getIn, prepareSchemaUpdates, schemaFieldGroups, validateSchemaValue } from "../console/lib/schemaConfig.js"

const defaults = YAML.parse(fs.readFileSync(new URL("../config_default/message.yaml", import.meta.url), "utf8")).pluginSettings
const policies = {
  dice: { title: "骰子基础设置", schema: dice, count: 11 },
  tracking: { title: "对话追踪", schema: tracking, count: 54 },
  memory: { title: "记忆策略", schema: memory, count: 35 }
}
const allFields = entry => schemaFieldGroups(entry.schema).flatMap(group => group.fields)
const policyFields = Object.fromEntries(Object.entries(policies).map(([key, entry]) => [key, allFields(entry)]))
const prepare = (key, values, settings = defaults) => {
  const entry = policies[key]
  const revision = buildSchemaConfigView(key, entry, settings).revision
  return prepareSchemaUpdates(key, entry, settings, { revision, values })
}

test("policy schemas expose 101 unique controls independently of Guoba and deduplicate memory sections", () => {
  assert.equal(fs.existsSync(new URL("../standalone/bl-dice-plugin/guoba.support.js", import.meta.url)), false, "Standalone dice must not import the retired Guoba schema")
  const migrated = []
  for (const [key, entry] of Object.entries(policies)) {
    const names = policyFields[key].map(field => field.field)
    assert.equal(names.length, entry.count, key)
    assert.equal(new Set(names).size, entry.count, key)
    migrated.push(...names)
    assert.equal(fs.existsSync(new URL(`../models/Guoba/schemas/${key}.js`, import.meta.url)), false)
    assert.equal(fs.existsSync(new URL(`../src/modules/config/domain/schemas/guoba/${key}.ts`, import.meta.url)), false)
  }
  assert.equal(new Set(migrated).size, 101)
  const remaining = new Set(guoba.flatMap(item => item.field ? [item.field] : []))
  for (const name of migrated) assert.equal(remaining.has(name), false, name)
  assert.equal(policyFields.tracking.some(field => field.field === "chatTriggerMode"), false)
  for (const [prefix, count] of [["semanticMemory.memoryEvolution.", 4], ["semanticMemory.selfCorrection.", 3], ["midtermMemory.", 5]]) {
    assert.equal(policyFields.memory.filter(field => field.field.startsWith(prefix)).length, count, prefix)
  }
  for (const name of ["messageArchive.enabled", "knowledgeSystem.enabled", "emotionSystem.enabled", "systemContent"]) assert.ok(remaining.has(name), name)
})

test("all policy defaults validate, including fractional tracking frequencies and nested schedules", () => {
  for (const [key, entry] of Object.entries(policies)) {
    const values = {}
    for (const field of policyFields[key]) {
      const value = getIn(defaults, field.field)
      assert.notEqual(value, undefined, `${key}: ${field.field}`)
      values[field.field] = validateSchemaValue(field, value)
    }
    assert.deepEqual(prepare(key, values).updates, {}, key)
    const view = buildSchemaConfigView(key, entry, defaults)
    assert.equal(view.key, key)
    assert.equal(view.groups.flatMap(group => group.fields).length, entry.count)
    assert.equal(typeof view.revision, "string")
    assert.ok(view.revision.length > 10)
  }
  assert.deepEqual(prepare("tracking", { "smartTrigger.talkValue": 0.034 }).updates, { "smartTrigger.talkValue": 0.034 })
  for (const sides of [2, 6, 20, 100000000]) {
    assert.equal(prepare("dice", { "diceSystem.maxDiceSides": sides }).updates["diceSystem.maxDiceSides"], sides)
  }
})

test("policy revisions are mandatory without changing revision compatibility of other schemas", () => {
  for (const [key, entry] of Object.entries(policies)) {
    for (const revision of [undefined, null, "", 123]) {
      assert.throws(() => prepareSchemaUpdates(key, entry, defaults, { revision, values: {} }), { status: 400 }, key)
    }
    assert.throws(() => prepareSchemaUpdates(key, entry, defaults, { revision: "old-draft", values: {} }), { status: 409 }, key)
  }
})

test("dice validation accepts common dice sides and rejects invalid rules, counts and text configuration", () => {
  for (const values of [
    { "diceSystem.defaultRule": "unknown" },
    { "diceSystem.maxDiceCount": 0 },
    { "diceSystem.maxDiceCount": 100.5 },
    { "diceSystem.maxDiceSides": 2.5 },
    { "diceSystem.maxRounds": 1001 },
    { "diceSystem.logExportMaxMb": 0 },
    { "diceSystem.enabled": "yes" },
    { "diceSystem.timeZone": "Invalid/Time_Zone" },
    { "diceSystem.timeZone": "" },
    { "diceSystem.baseDir": "   " },
    { diceSystem: { enabled: false } },
    { "diceSystem.templates.roll": "must use the existing dice replies endpoint" }
  ]) assert.throws(() => prepare("dice", values), { status: 400 }, JSON.stringify(values))
  const updates = prepare("dice", { "diceSystem.defaultRule": "nofumble", "diceSystem.timeZone": "UTC", "diceSystem.baseDir": "data/custom-dice" }).updates
  assert.equal(updates["diceSystem.defaultRule"], "nofumble")
  assert.equal(updates["diceSystem.timeZone"], "UTC")
  assert.equal(updates["diceSystem.baseDir"], "data/custom-dice")
})

test("tracking subforms validate required identifiers, unique groups, precise values and overnight schedules", () => {
  const values = {
    "smartTrigger.groupTalkValues": [{ group: "123456", value: 0.034 }, { group: "234567", value: 1 }],
    "smartTrigger.talkValueRules": [{ range: "23:00-06:59", value: 0.034 }, { range: "07:00-22:59", value: 0.07 }]
  }
  assert.deepEqual(prepare("tracking", values).updates, values)
  for (const invalid of [
    { "smartTrigger.talkValue": 0 },
    { "smartTrigger.talkValue": 0.0345 },
    { "smartTrigger.gateContextSize": 10.5 },
    { "smartTrigger.attentionDrift.level": "unknown" },
    { "smartTrigger.groupTalkValues": [{ value: 0.1 }] },
    { "smartTrigger.groupTalkValues": [{ group: "123456" }] },
    { "smartTrigger.groupTalkValues": [{ group: "not-a-group", value: 0.1 }] },
    { "smartTrigger.groupTalkValues": [{ group: "123456", value: 0.1 }, { group: "123456", value: 0.2 }] },
    { "smartTrigger.groupTalkValues": [{ group: "123456", value: 0.1, enabled: true }] },
    { "smartTrigger.groupTalkValues": { "123456": 0.1 } },
    { "smartTrigger.talkValueRules": [{ range: "25:00-06:59", value: 0.1 }] },
    { "smartTrigger.talkValueRules": [{ range: "23:60-06:59", value: 0.1 }] },
    { "smartTrigger.talkValueRules": [{ range: "7:00-22:59", value: 0.1 }] },
    { "smartTrigger.talkValueRules": [{ range: "07:00", value: 0.1 }] },
    { "smartTrigger.talkValueRules": [{ range: "07:00-22:59" }] },
    { "smartTrigger.groupTalkValues.0.group": "345678" }
  ]) assert.throws(() => prepare("tracking", invalid), { status: 400 }, JSON.stringify(invalid))
})

test("tracking partial updates validate deferred intervals and repeat thresholds against retained values", () => {
  const shorterInterval = structuredClone(defaults)
  shorterInterval.smartTrigger.minDeferredMs = 30000
  shorterInterval.smartTrigger.maxDeferredMs = 60000
  assert.throws(() => prepare("tracking", { "smartTrigger.minDeferredMs": 90000 }, shorterInterval), { status: 400 })
  assert.throws(() => prepare("tracking", { "smartTrigger.maxDeferredMs": 60000 }), { status: 400 })
  assert.deepEqual(prepare("tracking", { "smartTrigger.minDeferredMs": 60000, "smartTrigger.maxDeferredMs": 60000 }).updates, {
    "smartTrigger.minDeferredMs": 60000, "smartTrigger.maxDeferredMs": 60000
  })
  assert.throws(() => prepare("tracking", { "smartTrigger.repeatDetectionWindow": 2 }), { status: 400 })
  assert.throws(() => prepare("tracking", { "smartTrigger.repeatMinCount": 6 }), { status: 400 })
  assert.deepEqual(prepare("tracking", { "smartTrigger.repeatDetectionWindow": 3, "smartTrigger.repeatMinCount": 3 }).updates, { "smartTrigger.repeatDetectionWindow": 3 })
  const legacy = structuredClone(defaults)
  legacy.smartTrigger.minDeferredMs = 960000
  legacy.smartTrigger.repeatMinCount = 10
  assert.deepEqual(prepare("tracking", { "smartTrigger.talkValue": 0.1 }, legacy).updates, { "smartTrigger.talkValue": 0.1 })
})

test("hand-written group frequency maps display every row, participate in revisions and survive unrelated saves", () => {
  const settings = structuredClone(defaults)
  settings.smartTrigger.groupTalkValues = { "123456": 0.034, "234567": 0.07 }
  const before = structuredClone(settings)
  const view = buildSchemaConfigView("tracking", policies.tracking, settings)
  const rows = view.groups.flatMap(group => group.fields).find(field => field.field === "smartTrigger.groupTalkValues").value
  assert.deepEqual(rows, [{ group: "123456", value: 0.034 }, { group: "234567", value: 0.07 }])
  assert.deepEqual(prepare("tracking", { "smartTrigger.groupTalkValues": rows }, settings).updates, {})
  assert.deepEqual(prepare("tracking", { "smartTrigger.talkValue": 0.1 }, settings).updates, { "smartTrigger.talkValue": 0.1 })
  assert.deepEqual(settings, before)
  const changedElsewhere = structuredClone(settings)
  changedElsewhere.smartTrigger.groupTalkValues["123456"] = 0.1
  assert.notEqual(buildSchemaConfigView("tracking", policies.tracking, changedElsewhere).revision, view.revision)
  assert.throws(() => prepareSchemaUpdates("tracking", policies.tracking, changedElsewhere, {
    revision: view.revision, values: { "smartTrigger.talkValue": 0.1 }
  }), { status: 409 })
  const editedRows = [{ group: " 123456 ", value: 0.1 }, { group: "234567", value: 0.07 }]
  assert.deepEqual(prepare("tracking", { "smartTrigger.groupTalkValues": editedRows }, settings).updates, {
    "smartTrigger.groupTalkValues": [{ group: "123456", value: 0.1 }, { group: "234567", value: 0.07 }]
  })
  assert.throws(() => prepare("tracking", { "smartTrigger.groupTalkValues": [{ group: "123456", value: 0.1 }, { group: " 123456 ", value: 0.2 }] }), { status: 400 })
})

test("memory partial updates enforce knowledge decision timing and retain unexposed semantic settings", () => {
  assert.throws(() => prepare("memory", { "memorySystem.knowledgeDecisionInlineWaitMs": 1000 }), { status: 400 })
  const settings = structuredClone(defaults)
  settings.memorySystem.knowledgeDecisionInlineWaitMs = 600
  assert.throws(() => prepare("memory", { "memorySystem.knowledgeDecisionTimeoutMs": 500 }, settings), { status: 400 })
  assert.deepEqual(prepare("memory", { "memorySystem.knowledgeDecisionTimeoutMs": 600, "memorySystem.knowledgeDecisionInlineWaitMs": 600 }, settings).updates, {
    "memorySystem.knowledgeDecisionTimeoutMs": 600
  })
  for (const values of [
    { "memorySystem.maxEntitiesPerGroup": 10.5 },
    { "memorySystem.saveStrictness": "unsafe" },
    { "memorySystem.semanticDupCosine": 1.1 },
    { "semanticMemory.memoryEvolution.freezeThreshold": 0.6 },
    { "midtermMemory.minMessages": 3 },
    { "semanticMemory.enabled": true },
    { "semanticMemory.retentionDays": 1 },
    { "midtermMemory.debounceMs": 1000 }
  ]) assert.throws(() => prepare("memory", values), { status: 400 }, JSON.stringify(values))
  settings.memorySystem.knowledgeDecisionTimeoutMs = 300
  assert.deepEqual(prepare("memory", { "memorySystem.enabled": true }, settings).updates, { "memorySystem.enabled": true })
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
    const timeout = setTimeout(() => { child.kill(); reject(new Error("policy fixture server startup timed out")) }, 5000)
    child.stdout.on("data", chunk => {
      output += chunk.toString()
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) { clearTimeout(timeout); resolve(match[1]) }
    })
    child.stderr.on("data", chunk => { output += chunk.toString() })
    child.once("exit", code => { clearTimeout(timeout); if (code) reject(new Error(`policy fixture server exited ${code}: ${output}`)) })
  })
}

test("policy HTTP endpoints require authentication and revisions, persist scoped YAML and reject invalid saves atomically", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-policy-fixture-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, "config"), { recursive: true })
  const token = "fixture-policy-token"
  fs.writeFileSync(path.join(root, "config", "console.json"), JSON.stringify({ token }))
  const settings = structuredClone(defaults)
  settings.unrelated = { keep: true }
  settings.smartTrigger.futureTuning = { retained: true }
  settings.smartTrigger.groupTalkValues = { "345678": 0.034 }
  settings.diceSystem.futureDice = ["retained"]
  settings.memorySystem.futureMemory = "retained"
  settings.chatAiConfig.providers = [{ apiUrl: "https://fixture.invalid", model: "fixture", apiKey: "fixture-private-key" }]
  const document = new YAML.Document({ pluginSettings: settings, envelopeExtension: { retained: true } })
  const comments = [
    { keys: ["pluginSettings", "smartTrigger", "futureTuning"], text: " keep future tracking" },
    { keys: ["pluginSettings", "diceSystem", "templates", "roll"], text: " keep dice reply" },
    { keys: ["pluginSettings", "memorySystem", "futureMemory"], text: " keep future memory" },
    { keys: ["pluginSettings", "chatAiConfig", "providers", 0, "apiKey"], text: " keep provider secret" }
  ]
  for (const { keys, text } of comments) document.getIn(keys, true).comment = text
  const yamlFile = path.join(root, "config", "message.yaml")
  fs.writeFileSync(yamlFile, "# keep policy document\n" + document.toString())
  const base = await startServer(root, t)
  const request = async (key, { method = "GET", body, authorized = true } = {}) => {
    const response = await fetch(`${base}/api/config/${key}`, {
      method, headers: { "content-type": "application/json", ...(authorized ? { "x-console-token": token } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
    return { status: response.status, data: await response.json() }
  }
  const saves = {
    dice: { "diceSystem.maxDiceSides": 20, "diceSystem.allowHiddenRoll": false },
    tracking: { "smartTrigger.talkValue": 0.034, "smartTrigger.groupTalkValues": [{ group: "123456", value: 0.07 }] },
    memory: { "memorySystem.maxFactsPerEntity": 25, "midtermMemory.model": "fixture-summary-model" }
  }
  const initialText = fs.readFileSync(yamlFile, "utf8")
  for (const [key, entry] of Object.entries(policies)) {
    assert.equal((await request(key, { authorized: false })).status, 401, key)
    assert.equal((await request(key, { authorized: false, method: "PUT", body: { values: saves[key] } })).status, 401, key)
    assert.equal((await request(key, { method: "POST" })).status, 405, key)
    const initial = (await request(key)).data
    assert.equal(initial.key, key)
    assert.equal(initial.groups.flatMap(group => group.fields).length, entry.count)
    if (key === "tracking") {
      assert.deepEqual(initial.groups.flatMap(group => group.fields).find(field => field.field === "smartTrigger.groupTalkValues").value, [{ group: "345678", value: 0.034 }])
    }
    assert.equal(JSON.stringify(initial).includes("fixture-private-key"), false)
    const before = fs.readFileSync(yamlFile, "utf8")
    const filesBefore = fs.readdirSync(path.join(root, "config")).sort()
    for (const body of [
      { values: saves[key] },
      { revision: initial.revision, values: { unknownSetting: true } },
      { revision: initial.revision, values: { [Object.keys(saves[key])[0]]: {} } }
    ]) {
      assert.equal((await request(key, { method: "PUT", body })).status, 400, `${key}: ${JSON.stringify(body)}`)
      assert.equal(fs.readFileSync(yamlFile, "utf8"), before)
      assert.deepEqual(fs.readdirSync(path.join(root, "config")).sort(), filesBefore)
    }
    const saved = await request(key, { method: "PUT", body: { revision: initial.revision, values: saves[key] } })
    assert.equal(saved.status, 200, `${key}: ${JSON.stringify(saved.data)}`)
    assert.equal(saved.data.changed, Object.keys(saves[key]).length, key)
    assert.equal(saved.data.applyMode, key === "memory" ? "mixed" : "hot", key)
    assert.ok(saved.data.backup, key)
    const after = fs.readFileSync(yamlFile, "utf8")
    assert.equal((await request(key, { method: "PUT", body: { revision: initial.revision, values: saves[key] } })).status, 409, key)
    assert.equal(fs.readFileSync(yamlFile, "utf8"), after)
    const current = (await request(key)).data
    assert.notEqual(current.revision, initial.revision, key)
    const noChange = await request(key, { method: "PUT", body: { revision: current.revision, values: saves[key] } })
    assert.equal(noChange.status, 200, key)
    assert.equal(noChange.data.changed, 0, key)
    assert.equal(fs.readFileSync(yamlFile, "utf8"), after)
    if (key === "dice") assert.deepEqual(YAML.parse(after).pluginSettings.smartTrigger.groupTalkValues, settings.smartTrigger.groupTalkValues)
  }
  const storedDocument = YAML.parseDocument(fs.readFileSync(yamlFile, "utf8"))
  const stored = storedDocument.toJS().pluginSettings
  const expected = structuredClone(settings)
  expected.diceSystem.maxDiceSides = 20
  expected.diceSystem.allowHiddenRoll = false
  expected.smartTrigger.talkValue = 0.034
  expected.smartTrigger.groupTalkValues = [{ group: "123456", value: 0.07 }]
  expected.memorySystem.maxFactsPerEntity = 25
  expected.midtermMemory.model = "fixture-summary-model"
  assert.deepEqual(stored, expected)
  assert.deepEqual(storedDocument.toJS().envelopeExtension, { retained: true })
  assert.ok(fs.readFileSync(yamlFile, "utf8").startsWith("# keep policy document"))
  for (const { keys, text } of comments) assert.equal(storedDocument.getIn(keys, true).comment, text)
  assert.notEqual(fs.readFileSync(yamlFile, "utf8"), initialText)
})
