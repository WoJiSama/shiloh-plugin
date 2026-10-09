import { test } from "node:test"
import assert from "node:assert/strict"
import { makeFact } from "../../domains/memory/engine/entityModel.js"
import { buildGroupFactsPrompt, buildContextualPrompt } from "../../domains/memory/engine/retriever.js"
import { createFakeRedis } from "./helpers/fakeRedis.js"
import { MemoryManager } from "../../domains/memory/MemoryManager.js"

function mgrWithExtract(ops) {
  const m = new MemoryManager({ enabled: true, userExtractMaxBatchMessages: 1, groupExtractMinIntervalMinutes: 0 }, { redis: createFakeRedis() })
  m.extractor.extract = async () => ops
  return m
}

test("makeFact: heardFrom 透传与截断", () => {
  const f = makeFact({ text: "星野下周考试", heardFrom: "希洛" })
  assert.equal(f.heardFrom, "希洛")
  assert.equal(makeFact({ text: "x" }).heardFrom, undefined, "无来源不落字段")
  assert.equal(makeFact({ text: "x", heardFrom: "a".repeat(40) }).heardFrom.length, 24)
})

test("群共识注入:他 bot 来源标注 + 引用提示,本 bot 来源不标", () => {
  const facts = [
    { text: "星野下周考试", tags: ["日程"], heardFrom: "希洛", confidence: 0.9 },
    { text: "归尘在写插件", tags: ["动态"], heardFrom: "星彩", confidence: 0.9 }
  ]
  const asXingcai = buildGroupFactsPrompt(facts, "", 6, 1200, "星彩")
  assert.match(asXingcai, /星野下周考试（听希洛说的）/)
  assert.doesNotMatch(asXingcai, /归尘在写插件（听/, "本 bot 听来的不标注")
  assert.match(asXingcai, /我听XX说过/, "带引用方式提示")

  const asXiluo = buildGroupFactsPrompt(facts, "", 6, 1200, "希洛")
  assert.match(asXiluo, /归尘在写插件（听星彩说的）/)
  assert.doesNotMatch(asXiluo, /星野下周考试（听/)

  const noViewer = buildGroupFactsPrompt(facts, "", 6, 1200, "")
  assert.doesNotMatch(noViewer, /听.*说的/, "无注入对象信息时不标注(旧行为)")
})

test("contextual 注入:实体/refs 段同样按 viewer 标注", () => {
  const prompt = buildContextualPrompt({
    speakerEntity: { canonicalName: "归尘", facts: [{ text: "在准备面试", heardFrom: "希洛", confidence: 0.9 }] },
    refsFacts: [{ text: "和星野是朋友", heardFrom: "希洛", confidence: 0.9 }],
    groupFacts: [{ text: "每周三团建", heardFrom: "希洛", confidence: 0.9 }],
    viewerBotName: "星彩",
    config: { promptMaxChars: 2000, promptMaxGroupFacts: 6, promptMaxEntityFacts: 6 }
  })
  assert.match(prompt, /在准备面试（听希洛说的）/)
  assert.match(prompt, /和星野是朋友（听希洛说的）/)
  assert.match(prompt, /每周三团建（听希洛说的）/)
})

test("提取盖源:缓冲携带 heardFrom 并写入 fact", async () => {
  const manager = mgrWithExtract([{ stream: "groupFact", fact: { text: "测试事实A", confidence: 0.9 } }])
  await manager.extractAndSaveMemories("g1", "10001", "星野说他下周考试", "", {
    source: "user", heardFrom: "希洛"
  })
  const facts = await manager.store.getFacts("g1")
  assert.equal(facts.length, 1)
  assert.equal(facts[0].heardFrom, "希洛", "事实带上在场 bot 人设名")
})

test("群提取盖源与用户提取盖源一致", async () => {
  const manager = mgrWithExtract([{ stream: "groupFact", fact: { text: "群事实B", confidence: 0.9 } }])
  await manager.extractAndSaveGroupMemories("g2", [
    { role: "user", content: "归尘说他在写插件" },
    { role: "assistant", content: "星彩: 哦?" }
  ], { heardFrom: "星彩" })
  const facts = await manager.store.getFacts("g2")
  assert.equal(facts[0]?.heardFrom, "星彩")
})
