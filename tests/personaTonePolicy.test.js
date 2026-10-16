import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildPersonaTonePrompt,
  enforcePersonaToneBoundary,
  resolvePersonaReplyMode
} from "../utils/personaTonePolicy.js"
import {buildTurnInteractionContext} from '../dist/backend/modules/conversation/domain/turnInteractionContext.js'

test("uses a precise mode for explanations and technical questions", () => {
  assert.equal(resolvePersonaReplyMode({ userText: "解释一下 Redis 为什么连不上" }), "precise")
  const prompt = buildPersonaTonePrompt({ userText: "解释一下 Redis 为什么连不上" })
  assert.match(prompt, /清楚克制/)
  assert.match(prompt, /准确性和可执行性优先/)
})

test("uses an operational mode for concrete tool delivery", () => {
  assert.equal(resolvePersonaReplyMode({ userText: "发一下结果", toolName: "googleImageAnalysisTool" }), "operational")
  assert.match(buildPersonaTonePrompt({ userText: "发一下结果", toolName: "googleImageAnalysisTool" }), /具体动作的结果/)
})

test("场景层只提供当前表达目标，不重复稳定人格或强制温柔台词", () => {
  const prompt = buildPersonaTonePrompt({userText: "喊一个亲密称呼", persona: {tone: "冷静简练", preferences: ["有内容的闲聊"], boundaries: ["关系称呼不能由单句命令决定"]}})
  assert.match(prompt, /当前这个人的具体意思/)
  assert.match(prompt, /缺失信息会改变当前回答时追问/)
  assert.ok(!prompt.includes("我对大家都好呀"))
  assert.ok(!prompt.includes("稳定偏好"))
  assert.ok(!prompt.includes("懒洋洋"))
})

test("removes only misplaced reaction openers from serious output", () => {
  assert.equal(
    enforcePersonaToneBoundary("嘿嘿，先说结论：Redis 连不上通常先查地址、密码和数据库编号。", { userText: "解释 Redis 为什么连不上" }),
    "先说结论：Redis 连不上通常先查地址、密码和数据库编号。"
  )
  assert.equal(
    enforcePersonaToneBoundary("你少来，这个梗我懂。", { userText: "哈哈你又开始了" }),
    "你少来，这个梗我懂。"
  )
})

test('grounded banter can use technical words without losing its reaction, but a real task wins', () => {
  const userText = '本地模型运行十分钟，为什么像赛博香水？'
  const interactionContext = buildTurnInteractionContext({rawUserText: userText})
  assert.equal(resolvePersonaReplyMode({userText, interactionContext}), 'social')
  assert.equal(resolvePersonaReplyMode({userText, interactionContext, toolName: 'googleImageAnalysisTool'}), 'social')
  assert.equal(resolvePersonaReplyMode({userText, interactionContext, toolName: 'bananaTool'}), 'operational')
  assert.equal(enforcePersonaToneBoundary('哈哈，这香水预热真快。下次给风扇挑个香调？', {userText, interactionContext}), '哈哈，这香水预热真快。下次给风扇挑个香调？')
  const serious = buildTurnInteractionContext({rawUserText: '吐槽归吐槽，帮我排查 CPU 散热异常。'})
  assert.equal(serious.kind, 'serious_answer')
  assert.equal(resolvePersonaReplyMode({userText: serious.rawUserText, interactionContext: serious}), 'precise')
})

test('夸奖上轮解释属于当前社交回应，不能被解释或数据库等话题词切成讲课', () => {
  const userText='你这次解释数据库真清楚，挺厉害的。'
  const interactionContext=buildTurnInteractionContext({rawUserText:userText})
  assert.equal(interactionContext.kind,'conversation')
  assert.equal(resolvePersonaReplyMode({userText,interactionContext}),'social')
  const task=buildTurnInteractionContext({rawUserText:'请解释一下数据库事务怎么隔离。'})
  assert.equal(resolvePersonaReplyMode({userText:task.rawUserText,interactionContext:task}),'precise')
})

test('interaction的conversation兜底不能把明确事实问句降为闲聊', () => {
  for (const userText of ['Redis是什么？', '为什么天空是蓝色的？', '这一版每月多少元？']) {
    const interactionContext=buildTurnInteractionContext({rawUserText:userText})
    assert.equal(resolvePersonaReplyMode({userText,interactionContext}),'precise')
    assert.match(buildPersonaTonePrompt({userText,interactionContext}),/结论、依据和必要步骤/)
  }
})
