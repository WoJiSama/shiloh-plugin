// turnPromptComposer 单元测试:用假依赖驱动 19 层取数与拼装,
// 验证闲聊/任务两档裁剪、取数文本语义(记忆层不回退 args)、单层失败降级、
// 以及 report 观测输出的正确性。
import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { composeTurnPromptLayers } from "../utils/turnPromptComposer.js"
import { FULL_PROMPT_LAYERS, CHAT_PROMPT_LAYERS, resolvePromptLayerProfile } from "../utils/promptLayers.js"
import { clearPromptLayerCache } from "../utils/promptLayerCache.js"

// 层缓存是模块级全局状态,测试间必须隔离
beforeEach(() => clearPromptLayerCache())

function buildDeps(overrides = {}) {
  const calls = { memory: [], workflow: [], knowledge: [], semantic: [] }
  const deps = {
    emotionManager: {
      getEmotionPromptForGroup: async () => "【情绪】E"
    },
    memoryManager: {
      getContextualMemoryPrompt: async (groupId, userId, text) => {
        calls.memory.push({ groupId, userId, text })
        return "【记忆】M"
      },
      getGroupWorkflowPrompt: async (groupId, text) => {
        calls.workflow.push({ groupId, text })
        return "【工作流】W"
      },
      getGroupKnowledgePrompt: async () => "【群知识】K"
    },
    expressionLearner: {
      getExpressionPromptForGroup: async () => "【表达】X"
    },
    knowledgeSearcher: {
      search: async () => ({ knowledgeContext: "KC" })
    },
    personaFeedbackManager: {
      buildFeedbackPrompt: () => "【反馈】F"
    },
    globalStyleLearnerManager: {
      buildPrompt: () => "【全局风格】G",
      buildRelevantPrompt: async () => {
        calls.semantic.push(Date.now())
        return "【语义风格】S"
      }
    },
    personProfileInjector: {
      build: async () => "【画像】P"
    },
    calls,
    ...overrides
  }
  return deps
}

const CONFIG = {
  persona: { name: "希洛" },
  personaGuard: { enabled: true },
  emotionSystem: { enabled: true },
  memorySystem: { enabled: true },
  expressionLearning: { enabled: true },
  personProfileInjection: { enabled: true },
  globalStyleLearning: { semanticPromptWaitMs: 350 }
}

const TURN = {
  groupId: "g1",
  userId: "u1",
  event: { id: "evt" },
  messageText: "查一下这个",
  memoryText: "查一下这个",
  rawMessageText: "查一下这个",
  toneText: "查一下这个",
  cardText: "查一下这个",
  cardResponseKind: "chat"
}

const PRECOMPUTED = {
  identityBindings: "【身份绑定】I",
  workflowTeaching: "【工作流教学】WT",
  knowledgeTeaching: "【知识教学】KT",
  memberLookup: "【成员】ML",
  mergedTrigger: "【触发】T"
}

function layerValue(name) {
  return {
    identityBindings: "【身份绑定】I",
    workflowTeaching: "【工作流教学】WT",
    knowledgeTeaching: "【知识教学】KT",
    workflow: "【工作流】W",
    groupKnowledge: "【群知识】K",
    mergedTrigger: "【触发】T",
    emotion: "【情绪】E",
    memory: "【记忆】M",
    expression: "【表达】X",
    personaTone: null, // 动态生成,单独断言
    narrativeWriting: "",
    solutionExplanation: null, // 视文本而定
    cardBody: "",
    personaFeedback: "【反馈】F",
    globalStyle: "【全局风格】G",
    semanticStyle: "【语义风格】S",
    knowledge: "【知识库参考】\n以下是与当前话题相关的参考知识，请在回复时自然融入（不要生硬引用）：\nKC",
    memberLookup: "【成员】ML",
    personProfile: "【画像】P"
  }[name]
}

test("任务回合:全部层按 FULL_PROMPT_LAYERS 顺序拼装,report 统计正确", async () => {
  const deps = buildDeps()
  const profile = resolvePromptLayerProfile({ responseKind: "chat", modelIntent: "search" })
  const result = await composeTurnPromptLayers({
    config: CONFIG,
    profile,
    turn: TURN,
    precomputed: PRECOMPUTED,
    deps
  })

  const expectedStatic = FULL_PROMPT_LAYERS
    .map(name => layerValue(name))
    .filter(value => typeof value === "string" && value)
  // personaTone 与 solutionExplanation 动态生成,验证存在性
  assert.ok(result.layerValues.personaTone.includes("【希洛场景口吻】"))
  assert.equal(typeof result.layerValues.solutionExplanation, "string")

  const promptLines = result.prompt.split("\n")
  for (const value of expectedStatic) {
    assert.ok(result.prompt.includes(value), `缺少层: ${value}`)
  }
  assert.equal(result.report.profile, "task")
  assert.equal(result.report.totalChars, result.prompt.length)
  assert.deepEqual(result.report.omitted, [])
  assert.ok(result.report.included.some(item => item.name === "personaTone" && item.chars > 0))
  assert.ok(promptLines.length > 0)
})

test("闲聊回合:只保留保底层,知识库与语义风格不取数", async () => {
  const deps = buildDeps()
  const profile = resolvePromptLayerProfile({ responseKind: "chat", modelIntent: "" })
  const result = await composeTurnPromptLayers({
    config: CONFIG,
    profile,
    turn: { ...TURN, messageText: "哈哈", memoryText: "哈哈", rawMessageText: "哈哈", toneText: "哈哈", cardText: "哈哈" },
    precomputed: PRECOMPUTED,
    deps
  })

  assert.equal(result.report.profile, "chat")
  assert.deepEqual(result.report.ommitted_backup, undefined)
  // 闲聊保底五层都在
  for (const name of CHAT_PROMPT_LAYERS) {
    assert.ok(result.layerValues[name], `闲聊保底层 ${name} 不应为空`)
  }
  assert.ok(!result.prompt.includes("【知识库参考】"), "闲聊不应注入知识库层")
  assert.equal(result.layerValues.semanticStyle, "", "闲聊不应有语义风格层")
  assert.equal(result.layerValues.workflow, "【工作流】W", "层值仍会取数,由画像裁剪决定是否注入")
})

test("记忆层取数使用 memoryText(不回退 args),工作流使用 messageText", async () => {
  const deps = buildDeps()
  const profile = resolvePromptLayerProfile({ responseKind: "chat", modelIntent: "search" })
  await composeTurnPromptLayers({
    config: CONFIG,
    profile,
    turn: { ...TURN, messageText: "e.msg || args", memoryText: "e.msg" },
    precomputed: PRECOMPUTED,
    deps
  })
  assert.deepEqual(deps.calls.memory, [{ groupId: "g1", userId: "u1", text: "e.msg" }])
  assert.deepEqual(deps.calls.workflow, [{ groupId: "g1", text: "e.msg || args" }])
})

test("单层失败降级为空,不拖垮其他层", async () => {
  const deps = buildDeps({
    emotionManager: {
      getEmotionPromptForGroup: async () => { throw new Error("boom") }
    }
  })
  const profile = resolvePromptLayerProfile({ responseKind: "chat", modelIntent: "search" })
  const result = await composeTurnPromptLayers({
    config: CONFIG,
    profile,
    turn: TURN,
    precomputed: PRECOMPUTED,
    deps
  })
  assert.equal(result.layerValues.emotion, "")
  assert.ok(result.prompt.includes("【记忆】M"))
  assert.ok(result.prompt.includes("【工作流】W"))
})

test("系统开关关闭时对应层不取数", async () => {
  const deps = buildDeps()
  const profile = resolvePromptLayerProfile({ responseKind: "chat", modelIntent: "search" })
  const result = await composeTurnPromptLayers({
    config: {
      ...CONFIG,
      emotionSystem: { enabled: false },
      memorySystem: { enabled: false },
      expressionLearning: { enabled: false },
      personProfileInjection: { enabled: false }
    },
    profile,
    turn: TURN,
    precomputed: PRECOMPUTED,
    deps
  })
  assert.equal(result.layerValues.emotion, "")
  assert.equal(result.layerValues.memory, "")
  assert.equal(result.layerValues.workflow, "")
  assert.equal(result.layerValues.expression, "")
  assert.equal(result.layerValues.personProfile, "")
  assert.equal(deps.calls.memory.length, 0)
})

function buildCountingDeps() {
  const counts = { emotion: 0, memory: 0, expression: 0, globalStyle: 0, personaFeedback: 0, personProfile: 0 }
  return {
    counts,
    emotionManager: { getEmotionPromptForGroup: async () => { counts.emotion += 1; return "【情绪】E" } },
    memoryManager: {
      getContextualMemoryPrompt: async () => { counts.memory += 1; return "【记忆】M" },
      getGroupWorkflowPrompt: async () => "【工作流】W",
      getGroupKnowledgePrompt: async () => "【群知识】K"
    },
    expressionLearner: { getExpressionPromptForGroup: async () => { counts.expression += 1; return "【表达】X" } },
    knowledgeSearcher: { search: async () => ({ knowledgeContext: "KC" }) },
    personaFeedbackManager: { buildFeedbackPrompt: () => { counts.personaFeedback += 1; return "【反馈】F" } },
    globalStyleLearnerManager: {
      buildPrompt: () => { counts.globalStyle += 1; return "【全局风格】G" },
      buildRelevantPrompt: async () => "【语义风格】S"
    },
    personProfileInjector: { build: async () => { counts.personProfile += 1; return "【画像】P" } }
  }
}

test("慢变化层按 TTL 缓存:同一群连续两轮,情绪/表达/全局风格/反馈/画像只取数一次,记忆仍每轮取", async () => {
  clearPromptLayerCache()
  const deps = buildCountingDeps()
  const profile = resolvePromptLayerProfile({ responseKind: "chat", modelIntent: "search" })
  const options = {
    config: CONFIG,
    profile,
    turn: { ...TURN, messageText: "第一轮", memoryText: "第一轮", rawMessageText: "第一轮", toneText: "第一轮", cardText: "第一轮" },
    precomputed: PRECOMPUTED,
    deps
  }
  await composeTurnPromptLayers(options)
  await composeTurnPromptLayers({
    ...options,
    turn: { ...TURN, messageText: "第二轮", memoryText: "第二轮", rawMessageText: "第二轮", toneText: "第二轮", cardText: "第二轮" }
  })

  assert.equal(deps.counts.emotion, 1, "情绪层应命中缓存")
  assert.equal(deps.counts.expression, 1, "表达层应命中缓存")
  assert.equal(deps.counts.globalStyle, 1, "全局风格层应命中缓存")
  assert.equal(deps.counts.personaFeedback, 1, "人设反馈层应命中缓存")
  assert.equal(deps.counts.personProfile, 1, "画像层应命中缓存")
  assert.equal(deps.counts.memory, 2, "记忆层随消息变化,不缓存")
})

test("promptLayerCache.enabled=false 时全部层直读", async () => {
  clearPromptLayerCache()
  const deps = buildCountingDeps()
  const profile = resolvePromptLayerProfile({ responseKind: "chat", modelIntent: "search" })
  const options = {
    config: { ...CONFIG, promptLayerCache: { enabled: false } },
    profile,
    turn: TURN,
    precomputed: PRECOMPUTED,
    deps
  }
  await composeTurnPromptLayers(options)
  await composeTurnPromptLayers(options)
  assert.equal(deps.counts.emotion, 2)
  assert.equal(deps.counts.globalStyle, 2)
  assert.equal(deps.counts.personProfile, 2)
})
