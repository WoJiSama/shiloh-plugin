import assert from "node:assert/strict"
import { test } from "node:test"
import { buildSchemaConfigView, prepareSchemaUpdates, schemaFieldGroups, validateSchemaValue } from "../console/lib/schemaConfig.js"
import pipelineSchema from "../models/Guoba/schemas/messagePipeline.js"
import personaSchema from "../models/Guoba/schemas/persona.js"
import riskSchema from "../models/Guoba/schemas/riskControl.js"

const entry = { title: "管道", schema: pipelineSchema }
const settings = {
  messagePipeline: { eventConcurrency: 8, eventTtlMinutes: 360 },
  youtubeRelay: { cookieHeader: "fake-cookie-secret", poToken: "fake-po-secret" },
  mediaRelayAdminReport: { intervalHours: 24 }
}

test("schema view never exposes password fields and declares correct application timing", () => {
  const view = buildSchemaConfigView("pipeline", entry, settings)
  const fields = view.groups.flatMap(group => group.fields)
  const cookie = fields.find(field => field.field === "youtubeRelay.cookieHeader")
  assert.deepEqual([cookie.value, cookie.secret, cookie.configured], ["", true, true])
  assert.equal(JSON.stringify(view).includes("fake-cookie-secret"), false)
  assert.equal(fields.find(field => field.field === "messagePipeline.eventConcurrency").applyMode, "restart")
  assert.equal(fields.find(field => field.field === "mediaRelayAdminReport.intervalHours").applyMode, "next-cycle")
  assert.equal(fields.find(field => field.field === "bilibiliQualityRelay.autoUseAuthorizedForMemberOnly").applyMode, "restart")
})

test("schema revision detects changes but not unrelated settings", () => {
  const initial = buildSchemaConfigView("pipeline", entry, settings).revision
  assert.equal(buildSchemaConfigView("pipeline", entry, { ...settings, unrelated: 42 }).revision, initial)
  const modified = { ...settings, youtubeRelay: { ...settings.youtubeRelay, poToken: "changed" } }
  assert.notEqual(buildSchemaConfigView("pipeline", entry, modified).revision, initial)
  assert.throws(() => prepareSchemaUpdates("pipeline", entry, modified, { revision: initial, values: {} }), { status: 409 })
})

test("explicit secret replace, clear, keep and legacy masks have distinct meanings", () => {
  const field = "youtubeRelay.cookieHeader"
  assert.equal(prepareSchemaUpdates("pipeline", entry, settings, { secrets: { [field]: { action: "replace", value: "next-secret" } } }).updates[field], "next-secret")
  assert.equal(prepareSchemaUpdates("pipeline", entry, settings, { secrets: { [field]: { action: "clear" } } }).updates[field], "")
  assert.equal(prepareSchemaUpdates("pipeline", entry, settings, { secrets: { [field]: { action: "keep" } } }).changed, 0)
  for (const value of ["", "****", "prefix…suffix"]) assert.equal(prepareSchemaUpdates("pipeline", entry, settings, { values: { [field]: value } }).changed, 0)
  for (const value of ["", "****", "prefix…suffix"]) assert.throws(() => prepareSchemaUpdates("pipeline", entry, settings, { secrets: { [field]: { action: "replace", value } } }), { status: 400 })
  assert.throws(() => prepareSchemaUpdates("pipeline", entry, settings, { values: { [field]: "plain-secret" } }), { status: 400 })
})

test("numbers reject empty, nonfinite, out of bounds and invalid increments before updates", () => {
  const name = "messagePipeline.eventTtlMinutes"
  for (const value of ["", " ", null, "bad", Infinity, false, 29, 1441, 31]) {
    assert.throws(() => prepareSchemaUpdates("pipeline", entry, settings, { values: { [name]: value } }), { status: 400 })
  }
  assert.equal(prepareSchemaUpdates("pipeline", entry, settings, { values: { [name]: "390" } }).updates[name], 390)
  assert.equal(prepareSchemaUpdates("pipeline", entry, settings, { values: { [name]: 360 } }).changed, 0)
})

test("subforms enforce required fields and child numeric constraints", () => {
  const moods = schemaFieldGroups(personaSchema).flatMap(group => group.fields).find(field => field.field === "persona.moods")
  assert.deepEqual(validateSchemaValue(moods, [{ name: "开心", hint: "轻快", probability: 0.12 }]), [{ name: "开心", hint: "轻快", probability: 0.12 }])
  for (const rows of [[{ hint: "提示" }], [{ name: " ", hint: "提示" }], [{ name: "A", hint: "B", probability: "" }], [{ name: "A", hint: "B", probability: 1.01 }], [{ name: "A", hint: "B", probability: 0.125 }], [{ name: "A", hint: "B", unknown: true }]]) {
    assert.throws(() => validateSchemaValue(moods, rows), { status: 400 })
  }
})

test("schema rejects unknown fields, credentials on normal fields, and inverted delay intervals", () => {
  assert.throws(() => prepareSchemaUpdates("pipeline", entry, settings, { values: { unexpected: "value" } }), { status: 400 })
  assert.throws(() => prepareSchemaUpdates("pipeline", entry, settings, { secrets: { "messagePipeline.eventConcurrency": { action: "clear" } } }), { status: 400 })
  assert.throws(() => prepareSchemaUpdates("riskControl", { schema: riskSchema }, { riskControl: { delayMinMs: 0, delayMaxMs: 400 } }, { values: { "riskControl.delayMinMs": 450 } }), { status: 400 })
})


test("reasoning selections preserve inheritance, validate supported choices, and declare hot application", async () => {
  const { default: schema } = await import("../models/Guoba/schemas/reasoning.js")
  const entry = { schema }
  const current = { chatAiConfig: { chatReasoningEffort: "low", complexReasoningEffort: "high" }, taskAiConfig: { casual: { reasoningEffort: "none" } } }
  const view = buildSchemaConfigView("reasoning", entry, current)
  assert.equal(view.groups[0].fields.length, 3)
  const result = prepareSchemaUpdates("reasoning", entry, current, { revision: view.revision, values: { "taskAiConfig.casual.reasoningEffort": "low", "chatAiConfig.complexReasoningEffort": "max" } })
  assert.equal(result.updates["taskAiConfig.casual.reasoningEffort"], "low")
  assert.ok(result.apply.every(item => item.applyMode === "hot"))
  assert.equal(prepareSchemaUpdates("reasoning", entry, current, { values: { "taskAiConfig.casual.reasoningEffort": "" } }).updates["taskAiConfig.casual.reasoningEffort"], "")
  assert.throws(() => prepareSchemaUpdates("reasoning", entry, current, { values: { "taskAiConfig.casual.reasoningEffort": "invalid" } }), { status: 400 })
})
