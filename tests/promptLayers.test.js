import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  CHAT_PROMPT_LAYERS,
  FULL_PROMPT_LAYERS,
  applyPromptLayerProfile,
  resolvePromptLayerProfile
} from "../utils/promptLayers.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("casual chat without any task signal gets the chat-only layer set", () => {
  const profile = resolvePromptLayerProfile({
    responseKind: "chat",
    modelIntent: "",
    requiredToolNames: [],
    hasImages: false,
    hasVideos: false
  })
  assert.equal(profile.profile, "chat")
  assert.equal(profile.reason, "casual")
  assert.deepEqual(profile.layers, CHAT_PROMPT_LAYERS)
  for (const layer of ["workflow", "knowledge", "personProfile", "narrativeWriting", "globalStyle"]) {
    assert.ok(!CHAT_PROMPT_LAYERS.includes(layer), `闲聊不应带 ${layer}`)
  }
})

test("task signals promote the full layer set", () => {
  for (const overrides of [
    { modelIntent: "search" },
    { modelIntent: "image_edit" },
    { responseKind: "knowledge" },
    { requiredToolNames: ["bananaTool"] },
    { hasImages: true },
    { hasVideos: true }
  ]) {
    const profile = resolvePromptLayerProfile({ responseKind: "chat", ...overrides })
    assert.equal(profile.profile, "task", JSON.stringify(overrides))
    assert.deepEqual(profile.layers, FULL_PROMPT_LAYERS)
  }
  // chat/noise 意图不视为任务信号
  assert.equal(resolvePromptLayerProfile({ modelIntent: "chat" }).profile, "chat")
  assert.equal(resolvePromptLayerProfile({ modelIntent: "noise" }).profile, "chat")
})

test("apply keeps declared order and reports omitted layers", () => {
  const profile = resolvePromptLayerProfile({})
  const result = applyPromptLayerProfile(profile, {
    identityBindings: "A",
    emotion: "B",
    knowledge: "C",
    personProfile: "D"
  })
  assert.equal(result.prompt, "A\nB")
  assert.deepEqual(result.omitted, ["knowledge", "personProfile"])
})

test("handleTool resolves the layer profile before assembling prompts", () => {
  const src = fs.readFileSync(path.join(root, "apps/test.js"), "utf8")
  const intentPos = src.indexOf("modelIntentDecision = await this.resolvePrimaryModelIntent(currentIntentText")
  const profilePos = src.indexOf("session.promptLayerProfile = resolvePromptLayerProfile")
  const joinPos = src.indexOf("applyPromptLayerProfile(session.promptLayerProfile")
  assert.ok(intentPos > 0 && profilePos > intentPos && joinPos > profilePos, "意图判定必须先于分层画像，分层画像先于拼接")
  assert.ok(src.includes("profile === \"chat\"\n          ? \"\""), "闲聊回合跳过理解卡片")
  assert.ok(!src.includes("runShadowIntent"), "影子意图已随 P4 转正移除，不再有并行模型调用")
})

test("model image intent outranks conflicting regex routing", () => {
  const src = fs.readFileSync(path.join(root, "apps/test.js"), "utf8")
  assert.ok(
    src.includes("images?.length && (isImageAnalysisRequest(currentIntentText) || modelIntentDecision?.intent === \"image_analysis\")"),
    "识图路由：模型意图路径也要求有图，正则路径并入同一条件"
  )
  assert.ok(
    src.includes("images?.length && (isImageCompositionEditRequest(currentIntentText) || modelIntentDecision?.intent === \"image_edit\")"),
    "改图路由同上"
  )
  assert.ok(
    src.includes("modelImageIntentConflictsGeneration"),
    "高置信改图/识图时生图正则不得抢路由"
  )
  assert.ok(
    src.includes("session.recentImageContinuation?.image && modelIntentDecision?.intent !== \"image_analysis\""),
    "成图续改不得抢走识图意图"
  )
})
