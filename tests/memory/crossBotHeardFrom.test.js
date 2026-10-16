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

const SCOPE={botId:'b1',personaId:'p1',personaVersion:'version-1234567890',personaName:'希洛'}

test('完整来源要求 bot、人格 ID 与版本一致；同名 bot 和旧来源不会冒认亲历',()=>{
  const fact=makeFact({text:'周五有考试',confidence:0.9,personaSource:SCOPE,heardFrom:'希洛'})
  const own=buildGroupFactsPrompt([fact],'',6,3000,'希洛',SCOPE)
  assert.doesNotMatch(own,/公开记录来源/)
  for(const viewer of [{...SCOPE,botId:'b2'},{...SCOPE,personaId:'p2'},{...SCOPE,personaVersion:'v2'}]){
    const prompt=buildGroupFactsPrompt([fact],'',6,3000,'希洛',viewer)
    assert.match(prompt,/公开记录来源：希洛，bot b1，人格 p1，版本 version-1234/)
    assert.doesNotMatch(prompt,/你当时|你的另一个账号|你另一个账号/)
  }
  const legacy=buildGroupFactsPrompt([makeFact({text:'旧记忆',heardFrom:'希洛'})],'',6,3000,'希洛',SCOPE)
  assert.match(legacy,/旧来源名称：希洛；账号与人格版本未记录/)
})

test('公开事实跨人格共享，事件日期与来源在所有注入分支明确保留',()=>{
  const at=Date.parse('2026-10-17T12:00:00+08:00')
  const facts=[
    makeFact({text:'明天考试',eventAt:at,personaSource:SCOPE,heardFrom:'希洛',confidence:0.9,authority:'self'}),
    makeFact({text:'低置信度消息',eventAt:at,personaSource:SCOPE,confidence:0.5,authority:'mention'}),
    makeFact({text:'群里教学',eventAt:at,personaSource:SCOPE,confidence:0.7,authority:'teaching'})
  ]
  const prompt=buildContextualPrompt({
    speakerEntity:{qq:'111',facts,aliases:[]},mentionedEntities:[{qq:'222',facts:[facts[0]],aliases:[]}],refsFacts:[facts[0]],groupFacts:[facts[0]],pendingFacts:[facts[0]],viewer:{...SCOPE,botId:'b2'},config:{promptMaxChars:10000}
  })
  assert.match(prompt,/明天考试（事件日期：2026-10-17）/)
  assert.match(prompt,/好像 低置信度消息（事件日期：2026-10-17）.*公开记录来源/)
  assert.match(prompt,/据群里教学.*群里教学（事件日期：2026-10-17）.*公开记录来源/)
  assert.equal((prompt.match(/公开记录来源：/g)||[]).length,7)
  assert.match(prompt,/来源不同或未记录时不可说成当前人格亲历/)
  assert.match(prompt,/相对日期以标注的事件日期为准/)
})

test('保存重载保持完整来源，同文本不同日期或人格不能被去重抹掉',async()=>{
  const redis=createFakeRedis()
  const first=new MemoryManager({enabled:true},{redis})
  const eventAt=Date.parse('2026-10-17T12:00:00+08:00')
  const facts=[
    makeFact({text:'明天考试',eventAt,at:1,personaSource:SCOPE,heardFrom:'希洛'}),
    makeFact({text:'明天考试',eventAt:eventAt+86400000,at:2,personaSource:SCOPE,heardFrom:'希洛'}),
    makeFact({text:'明天考试',eventAt,at:3,personaSource:{...SCOPE,botId:'b2'},heardFrom:'希洛'})
  ]
  await first.applyOps('g',facts.map(fact=>({stream:'entityFact',qq:'111',authority:'self',fact})))
  await first.applyOps('g',[{stream:'groupFact',authority:'mention',fact:makeFact({text:'每周三讨论代码',personaSource:SCOPE})}])
  const second=new MemoryManager({enabled:true,promptMaxChars:5000},{redis})
  const loaded=(await second.store.getEntities('g'))['111'].facts
  assert.equal(loaded.length,3)
  assert.deepEqual(loaded.map(fact=>fact.personaSource.botId),['b1','b1','b2'])
  const prompt=await second.getContextualMemoryPrompt('g','111','考试',Date.now(),{viewer:{...SCOPE,botId:'b3'},viewerBotName:'希洛'})
  assert.match(prompt,/2026-10-17/)
  assert.match(prompt,/2026-10-18/)
  assert.match(prompt,/每周三讨论代码/)
  assert.match(prompt,/公开记录来源：希洛，bot b1/)
})
