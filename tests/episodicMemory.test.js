import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  recordEpisode, recallEpisodes, recallUserEpisodes, buildEpisodicPrompt, buildUserCallbackPrompt, hasTemporalDeixis,
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


test("记忆回勾:按用户召回旧情节,新鲜的不要", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-callback-"))
  const day = 24 * 60 * 60 * 1000
  const now = Date.now()
  resetEpisodicMemoryForTests()
  recordEpisode({ groupId: "g1", userId: "u1", userName: "阿七", summary: "说要早睡", reply: "早点睡呀", at: now - 2 * day, baseDir: dir })
  recordEpisode({ groupId: "g1", userId: "u2", userName: "别人", summary: "查了mod", at: now - 3 * day, baseDir: dir })
  recordEpisode({ groupId: "g1", userId: "u1", userName: "阿七", summary: "刚问完天气", reply: "晴", at: now - 5 * 60 * 1000, baseDir: dir })

  const recalled = recallUserEpisodes({ groupId: "g1", userId: "u1", days: 7, limit: 2, minAgeMs: 30 * 60 * 1000, baseDir: dir })
  // 只剩跨天的旧账:半小时内的(聊天历史已有)和别人(u2)都被排除
  assert.equal(recalled.length, 1)
  assert.match(recalled[0].summary, /早睡/)

  const card = buildUserCallbackPrompt(recalled, { userName: "阿七" })
  assert.match(card, /阿七的旧话题/)
  assert.match(card, /早睡/)
  assert.match(card, /禁止刻意汇报/)
  // 空列表不出卡
  assert.equal(buildUserCallbackPrompt([], { userName: "阿七" }), "")
  // 没记录的用户返回空
  assert.deepEqual(recallUserEpisodes({ groupId: "g1", userId: "u3", baseDir: dir }), [])
})

const personaA = { botId: "bot-a", personaId: "shiloh", personaVersion: "v1", personaName: "希洛" }
const personaB = { ...personaA, botId: "bot-b", personaName: "另一个希洛" }
const oldAt = () => Date.now() - 24 * 60 * 60 * 1000
function ownershipDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-ownership-"))
  t.after(() => { resetEpisodicMemoryForTests(); fs.rmSync(dir, { recursive: true, force: true }) })
  resetEpisodicMemoryForTests()
  return dir
}
function episodeLine(prompt, summary) {
  const line = prompt.split("\n").find(item => item.startsWith("- ") && item.includes(summary))
  assert.ok(line, `保留公开话题：${summary}`)
  return line
}

test("情节来源落盘并在重载后按 bot 归属，公开用户话题仍共享", t => {
  const dir = ownershipDir(t)
  const source = { ...personaA }
  recordEpisode({ groupId: "shared", userId: "u1", userName: "阿七", summary: "阿七说要考试", reply: "我给你准备考试清单", source, at: oldAt(), baseDir: dir })
  recordEpisode({ groupId: "shared", userId: "u1", userName: "阿七", summary: "阿七问睡前故事", reply: "我讲一只小猫的故事", source: personaB, at: oldAt(), baseDir: dir })
  source.botId = "mutated"
  const stored = fs.readFileSync(path.join(dir, "shared.ndjson"), "utf8").trim().split("\n").map(JSON.parse)
  assert.deepEqual(stored[0].source, personaA, "保存来源副本，不引用可变的调用方配置")
  assert.equal(stored.some(item => "replyAttribution" in item), false, "读者归属不可写成群共享事实")

  resetEpisodicMemoryForTests()
  const hitsA = recallEpisodes({ groupId: "shared", viewer: personaA, baseDir: dir })
  assert.equal(hitsA.length, 2, "不同 bot 都能召回群友公开话题")
  const promptA = buildEpisodicPrompt(hitsA)
  assert.match(episodeLine(promptA, "阿七说要考试"), /你回了：「我给你准备考试清单」/)
  const fromB = episodeLine(promptA, "阿七问睡前故事")
  assert.match(fromB, /另一个希洛（bot bot-b，人设 shiloh，版本 v1）当时回复/)
  assert.doesNotMatch(fromB, /你回了|你当时回/)

  const hitsB = recallUserEpisodes({ groupId: "shared", userId: "u1", viewer: personaB, baseDir: dir })
  const promptB = buildUserCallbackPrompt(hitsB, { userName: "阿七" })
  assert.match(episodeLine(promptB, "阿七问睡前故事"), /你当时回：「我讲一只小猫的故事」/)
  assert.doesNotMatch(episodeLine(promptB, "阿七说要考试"), /你回了|你当时回/)
})

test("同 bot 的人格切换和版本修改都不能继承第一人称经历", t => {
  const dir = ownershipDir(t)
  const changedPersona = { ...personaA, personaId: "saria", personaName: "萨莉亚" }
  const changedVersion = { ...personaA, personaVersion: "v2" }
  for (const [summary, reply, source] of [
    ["旧版答应帮忙", "旧版会帮你整理", personaA],
    ["另一人格聊过", "萨莉亚偏爱红茶", changedPersona],
    ["新版刚聊过", "新版喜欢咖啡", changedVersion]
  ]) recordEpisode({ groupId: "switch", userId: "u1", summary, reply, source, at: oldAt(), baseDir: dir })
  resetEpisodicMemoryForTests()

  const recalled = recallUserEpisodes({ groupId: "switch", userId: "u1", viewer: changedVersion, limit: 3, baseDir: dir })
  const prompt = buildUserCallbackPrompt(recalled, { viewer: changedVersion })
  const oldLine = episodeLine(prompt, "旧版答应帮忙")
  assert.match(oldLine, /人设 shiloh，版本 v1/)
  assert.doesNotMatch(oldLine, /你当时回/)
  const otherPersona = episodeLine(prompt, "另一人格聊过")
  assert.match(otherPersona, /萨莉亚（bot bot-a，人设 saria，版本 v1）/)
  assert.doesNotMatch(otherPersona, /你当时回/)
  assert.match(episodeLine(prompt, "新版刚聊过"), /你当时回：「新版喜欢咖啡」/)
})

test("legacy 和不完整来源保留正文，但不冒认回复且不信任磁盘归属标记", t => {
  const dir = ownershipDir(t)
  const at = oldAt()
  const legacy = { at, date: new Date(at).toISOString().slice(0, 10), userId: "u1", userName: "阿七", summary: "旧日志说有点紧张", reply: "无法确认是谁的安慰", replyAttribution: { kind: "self", viewer: personaA } }
  const incomplete = { ...legacy, summary: "缺版本的旧话题", reply: "缺版本来源的承诺", source: { botId: personaA.botId, personaId: personaA.personaId, personaName: personaA.personaName } }
  fs.writeFileSync(path.join(dir, "legacy.ndjson"), [legacy, incomplete].map(item => JSON.stringify(item)).join("\n") + "\n")
  const recalled = recallEpisodes({ groupId: "legacy", viewer: personaA, baseDir: dir })
  assert.equal(recalled.length, 2)
  const prompt = buildEpisodicPrompt(recalled, { viewer: personaA })
  assert.ok(episodeLine(prompt, legacy.summary))
  assert.ok(episodeLine(prompt, incomplete.summary))
  assert.doesNotMatch(prompt, /无法确认是谁的安慰|缺版本来源的承诺/)
  const callback = buildUserCallbackPrompt(recalled, { viewer: personaA })
  assert.doesNotMatch(callback, /无法确认是谁的安慰|缺版本来源的承诺/)
})

test("显式读者覆盖旧召回视图，无读者调用也不会把来源当成自己", t => {
  const dir = ownershipDir(t)
  recordEpisode({ groupId: "viewer", userId: "u1", summary: "A 的公开话题", reply: "A 的旧回复", source: personaA, at: oldAt(), baseDir: dir })
  recordEpisode({ groupId: "viewer", userId: "u1", summary: "B 的公开话题", reply: "B 的旧回复", source: personaB, at: oldAt(), baseDir: dir })
  const seenByA = recallEpisodes({ groupId: "viewer", viewer: personaA, baseDir: dir })
  const switched = buildEpisodicPrompt(seenByA, { viewer: personaB })
  assert.doesNotMatch(episodeLine(switched, "A 的公开话题"), /你回了/)
  assert.match(episodeLine(switched, "B 的公开话题"), /你回了：「B 的旧回复」/)

  const withoutViewer = buildEpisodicPrompt(recallEpisodes({ groupId: "viewer", baseDir: dir }))
  assert.doesNotMatch(episodeLine(withoutViewer, "A 的公开话题"), /你回了/)
  assert.doesNotMatch(episodeLine(withoutViewer, "B 的公开话题"), /你回了/)
  const withoutViewerCallback = buildUserCallbackPrompt(recallUserEpisodes({ groupId: "viewer", userId: "u1", baseDir: dir }))
  assert.doesNotMatch(episodeLine(withoutViewerCallback, "A 的公开话题"), /你当时回/)
})
