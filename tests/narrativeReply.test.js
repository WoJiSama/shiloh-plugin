import { test } from "node:test"
import assert from "node:assert/strict"
import { isNarrativeWritingRequest, splitNarrativeReply } from "../utils/narrativeReply.js"

test("recognizes natural-language fiction requests", () => {
  assert.equal(isNarrativeWritingRequest("写一个校园爱情故事"), true)
  assert.equal(isNarrativeWritingRequest("解释一下校园爱情文学"), false)
})

test("sends a short fiction preface separately from a titled story", () => {
  const response = [
    "好呀，这个设定我写成一个校园小故事。",
    "",
    "# 倒计时与晚风",
    "",
    "第一段正文。",
    "",
    "第二段正文。".repeat(80)
  ].join("\n")
  const result = splitNarrativeReply(response, "帮我写一个校园爱情故事")
  assert.equal(result.lead, "好呀，这个设定我写成一个校园小故事。")
  assert.match(result.story, /^# 倒计时与晚风/)
  assert.match(result.story, /第一段正文。\n\n第二段正文。/)
})

test("splits a title and story body that the model put after an inline transition", () => {
  const response = `这段气势太足了，我就写成一场保卫战——#《水群之地的最后守望》${"黄昏时分，露营地的天空染成了血色。".repeat(10)}`
  const result = splitNarrativeReply(response, "把它写成一个校园故事")
  assert.equal(result.lead, "这段气势太足了，我就写成一场保卫战")
  assert.match(result.story, /^# 《水群之地的最后守望》\n\n黄昏时分/u)
})

test("splits the reported full-width heading and same-line story body", () => {
  const response = `“他说要写一个故事，那……我试试看。”＃五个月 沃基醒来的时候，先是闻到一股草药味，夹杂着篝火和咸肉的气息。${"他盯着洞顶发了很久的呆。".repeat(30)}`
  const result = splitNarrativeReply(response, "针对这个写一个小故事，要有感情戏")
  assert.equal(result.lead, "“他说要写一个故事，那……我试试看。”")
  assert.match(result.story, /^# 五个月\n\n沃基醒来的时候/u)
})

test("normalizes a full-width heading before card rendering", () => {
  const response = ["“他说要写一个故事，那……我试试看。”", "", "＃五个月", "", "沃基醒来的时候，先是闻到一股草药味。", "他慢慢想起了那场雪。".repeat(40)].join("\n")
  const result = splitNarrativeReply(response, "写一个有感情戏的小故事")
  assert.equal(result.lead, "“他说要写一个故事，那……我试试看。”")
  assert.match(result.story, /^# 五个月\n/u)
})
