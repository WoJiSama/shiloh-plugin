import test from "node:test"
import assert from "node:assert/strict"
import {createTurtleSoupModelHost} from "../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupModelHost.js"
import {buildHostAnswerMessages, parseHostAnswer} from "../dist/backend/modules/games/domain/turtleSoup/turtleSoupPrompts.js"

const keyPoints = ["侧脸是画像", "只有一张正面照", "面部患病变形", "保留体面形象", "遵守遗愿"]
const input = {guess: "老人仅存一张年轻正面照,家人依遗愿绘制侧面画像作遗像", solution: "老人患病变形", keyPoints, literalScore: 0.3}
const hostReturning = body => createTurtleSoupModelHost({callModel: async () => JSON.stringify({reason: "核验结果", ...body})})

test("partial key-point coverage cannot win even when correct is true", async () => {
  const verdict = await hostReturning({coveredIds: ["kp1", "kp2", "kp5"], contradictedIds: [], correct: true}).judgeGuess(input)
  assert.equal(verdict.correct, false)
  assert.equal(verdict.closeness, 60)
})

test("required points can win without optional detail but contradictions block victory", async () => {
  const required = {...input, requiredKeyPointIds: ["kp1", "kp3"]}
  const complete = await hostReturning({coveredIds: ["kp1", "kp3"], contradictedIds: [], correct: true}).judgeGuess(required)
  assert.equal(complete.correct, true)
  assert.equal(complete.closeness, 100)
  const contradictory = await hostReturning({coveredIds: ["kp1", "kp3"], contradictedIds: ["kp5"], correct: true}).judgeGuess(required)
  assert.equal(contradictory.correct, false)
})

test("missing, duplicate, unknown or contradictory IDs are unavailable instead of inferred correctness", async () => {
  for (const body of [
    {correct: true},
    {correct: true, coveredIds: ["kp1", "kp1", "kp1", "kp1", "kp1"], contradictedIds: []},
    {correct: true, coveredIds: ["kp1", "kp2", "kp3", "kp4", "unknown"], contradictedIds: []},
    {correct: true, coveredIds: ["kp1"], contradictedIds: ["kp1"]},
    {correct: true, coveredIds: ["kp1"], contradictedIds: ["kp2", "kp2"]}
  ]) {
    const result = await hostReturning(body).judgeGuess(input)
    assert.equal(result.correct, false)
    assert.equal(result.status, "unavailable")
  }
})

test("host receives surface facts and distinguishes unknown from false without reversing negative questions", () => {
  const messages = buildHostAnswerMessages({question: "他没有离开吗", surface: "信箱是红色的", facts: ["他没有离开"], solution: "他在等待信件", keyPoints: ["信件是误送的"], history: [], asker: "小明"})
  const system = messages[0].content
  assert.match(system, /信箱是红色的/)
  assert.match(system, /他没有离开/)
  assert.match(system, /未知.*无法确定|无法确定.*未知/)
  assert.match(system, /不要机械剥掉/)
  assert.doesNotMatch(system, /没写→一律答"不是"/)
  assert.equal(parseHostAnswer("  是  "), "是")
  assert.equal(parseHostAnswer("不是。"), "不是")
  assert.equal(parseHostAnswer("其实不是否定,答案应该是肯定"), "无法确定")
  assert.equal(parseHostAnswer("是也不是的"), "无法确定")
  assert.equal(parseHostAnswer("无法确定"), "无法确定")
})

test("host cancellation is passed to the model gateway", async () => {
  const controller = new AbortController()
  let received
  const host = createTurtleSoupModelHost({callModel: async (_messages, options) => { received = options.signal; return "无法确定" }})
  assert.equal(await host.answerQuestion({question: "问题？", surface: "汤面", solution: "汤底", keyPoints: [], history: [], asker: "甲", signal: controller.signal}), "无法确定")
  assert.equal(received, controller.signal)
})

test("an internally inconsistent verdict is retried rather than reporting a failed 100 percent match", async () => {
  const result = await hostReturning({coveredIds: ["kp1", "kp2", "kp3", "kp4", "kp5"], contradictedIds: [], correct: false}).judgeGuess(input)
  assert.equal(result.status, "unavailable")
})
