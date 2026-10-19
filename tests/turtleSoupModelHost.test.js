import test from "node:test"
import assert from "node:assert/strict"
import {createTurtleSoupModelHost} from "../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupModelHost.js"

const keyPoints = ["侧脸是画像", "只有一张正面照", "面部患病变形", "保留体面形象", "遵守遗愿"]

function hostReturning(judgeJson) {
  return createTurtleSoupModelHost({callModel: async messages => {
    if (String(messages[0].content).includes("判题员")) return judgeJson
    if (String(messages[0].content).includes("解说")) return JSON.stringify({userId: "u1", reason: "x"})
    return "是"
  }})
}

test("partial key-point coverage is not a win and closeness equals coverage ratio", async () => {
  const host = hostReturning(JSON.stringify({covered: ["画像", "一张正面照", "遵守遗愿"], correct: true, reason: "差不多"}))
  const verdict = await host.judgeGuess({guess: "老人仅存一张年轻正面照、家人依遗愿另绘制侧面画像作遗像", solution: "老人患病变形...", keyPoints, literalScore: 0.3})
  assert.equal(verdict.correct, false)
  assert.equal(verdict.closeness, 60)
})

test("full coverage wins with closeness 100 even if the model is stingy", async () => {
  const host = hostReturning(JSON.stringify({covered: keyPoints, correct: false, reason: "措辞不同"}))
  const verdict = await host.judgeGuess({guess: "完整真相等价表述", solution: "老人患病变形...", keyPoints, literalScore: 0.2})
  assert.equal(verdict.correct, false)
  assert.equal(verdict.closeness, 100)
})

test("no covered list falls back to the model verdict", async () => {
  const host = hostReturning(JSON.stringify({correct: false, closeness: 42, reason: "方向不对"}))
  const verdict = await host.judgeGuess({guess: "x", solution: "y", keyPoints, literalScore: 0.1})
  assert.equal(verdict.correct, false)
  assert.equal(verdict.closeness, 42)
})

test("主持人答题提示词接地：关键点清单入 prompt、未提及事实禁止推测", async () => {
  const { buildHostAnswerMessages, parseHostAnswer } = await import("../dist/backend/modules/games/domain/turtleSoup/turtleSoupPrompts.js")
  const messages = buildHostAnswerMessages({
    question: "他回家的时候是不是刻意隐藏这个伞与妻子之间的关系",
    solution: "伞是失踪妻子的遗物;他不敢撑开是怕破坏证据",
    keyPoints: ["伞是遗物", "不敢撑开是怕破坏证据"],
    history: [],
    asker: "小明"
  })
  const system = messages[0].content
  assert.ok(system.includes("关键点"), "prompt 提供关键点清单")
  assert.ok(system.includes("伞是遗物"), "关键点内容接地")
  assert.ok(system.includes("不得推测"), "明确禁止脑补未提及事实")
  assert.ok(system.includes("没提隐瞒"), "给出与本案同型的反例(隐瞒类问题→与此无关)")
  // 模糊解析长词优先
  assert.equal(parseHostAnswer("是也不是的"), "是也不是", "不能截断成'是'")
  assert.equal(parseHostAnswer("答案:不是"), "不是")
  assert.equal(parseHostAnswer("  是  "), "是")
  assert.equal(parseHostAnswer("随便说点什么"), "与此无关")
})
