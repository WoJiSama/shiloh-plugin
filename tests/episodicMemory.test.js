import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  recordEpisode, recallEpisodes, buildEpisodicPrompt, hasTemporalDeixis,
  resetEpisodicMemoryForTests
} from "../utils/episodicMemory.js"

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-test-"))

test("时间指代识别", () => {
  assert.equal(hasTemporalDeixis("上次说的那个画好了吗"), true)
  assert.equal(hasTemporalDeixis("昨天那件事"), true)
  assert.equal(hasTemporalDeixis("今天天气不错"), false)
})

test("情节记录与关键词召回", () => {
  resetEpisodicMemoryForTests()
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000
  recordEpisode({ groupId: "g1", userId: "1", userName: "阿明", summary: "让希洛画了一张猫图", reply: "画好了", at: twoDaysAgo, baseDir })
  recordEpisode({ groupId: "g1", userId: "2", userName: "小蓝", summary: "问了三角洲排行榜", reply: "查到了", at: Date.now() - 3600000, baseDir })
  const hits = recallEpisodes({ groupId: "g1", terms: ["猫", "画"], days: 7, baseDir })
  assert.equal(hits.length >= 1, true)
  assert.equal(hits[0].summary.includes("猫图"), true, "关键词命中的排最前")
  const prompt = buildEpisodicPrompt(hits)
  assert.ok(prompt.includes("【近期情节】"))
  assert.ok(prompt.includes("阿明"))
  assert.ok(prompt.includes("2天前"), "时间描述贴近自然语言")
})

test("超出召回天数的不返回", () => {
  resetEpisodicMemoryForTests()
  recordEpisode({ groupId: "g2", userId: "1", summary: "很老的事", at: Date.now() - 30 * 24 * 60 * 60 * 1000, baseDir })
  assert.equal(recallEpisodes({ groupId: "g2", terms: [], days: 7, baseDir }).length, 0)
})
