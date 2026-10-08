import { test } from "node:test"
import assert from "node:assert/strict"
import { isResponsibleBot, isFederationSibling, markBotOnline, onlineBotList } from "../utils/botFederation.js"

const BOTS = ["10001", "20002", "30003"]

test("单 bot:一切放行", async () => {
  assert.equal(await isResponsibleBot({ groupId: "111", selfId: "10001", atBotQqs: [], knownBots: ["10001"] }), true)
})

test("私聊:收到事件的 bot 自己负责", async () => {
  assert.equal(await isResponsibleBot({ groupId: "", selfId: "20002", atBotQqs: [], knownBots: BOTS }), true)
})

test("@优先:@了谁谁负责,@别人则让位", async () => {
  assert.equal(await isResponsibleBot({ groupId: "111", selfId: "20002", atBotQqs: ["20002"], knownBots: BOTS }), true)
  assert.equal(await isResponsibleBot({ groupId: "111", selfId: "20002", atBotQqs: ["10001"], knownBots: BOTS }), false)
})

test("无@时按(群+bot列表)稳定选主:每群恒定,且恰好一个 bot 负责", async () => {
  const groups = ["111", "222", "333", "444", "555", "666", "777"]
  for (const g of groups) {
    const verdicts = []
    for (const bot of BOTS) {
      verdicts.push(await isResponsibleBot({ groupId: g, selfId: bot, atBotQqs: [], knownBots: BOTS }))
    }
    assert.equal(verdicts.filter(Boolean).length, 1, `群 ${g} 应恰好一个责任 bot: ${verdicts}`)
    // 稳定性:重复判定结果一致
    const again = await isResponsibleBot({ groupId: g, selfId: BOTS[0], atBotQqs: [], knownBots: BOTS })
    assert.equal(again, verdicts[0])
  }
  // 不同群的责任 bot 不全相同(哈希分布)
  const leaders = []
  for (const g of groups) {
    for (const bot of BOTS) {
      if (await isResponsibleBot({ groupId: g, selfId: bot, atBotQqs: [], knownBots: BOTS })) leaders.push(bot)
    }
  }
  assert.equal(leaders.length, groups.length)
  // 7 个群至少覆盖 2 个不同的责任 bot(分布性)
  assert.ok(new Set(leaders).size >= 2, `选主过于集中: ${leaders}`)
})

test("未登记账号保守放行(刚上线心跳未同步)", async () => {
  assert.equal(await isResponsibleBot({ groupId: "111", selfId: "99999", atBotQqs: [], knownBots: BOTS }), true)
})

test("兄弟判定:在线列表里的其他 bot 是兄弟,自己/陌生人不是", async () => {
  assert.equal(await isFederationSibling("10001", "20002"), false) // 单 bot 列表(未心跳)不判兄弟
  // 本地心跳注入三个号
  markBotOnline("10001"); markBotOnline("20002"); markBotOnline("30003")
  await new Promise(r => setTimeout(r, 50))
  assert.equal(await isFederationSibling("10001", "20002"), true)
  assert.equal(await isFederationSibling("10001", "10001"), false)
  assert.equal(await isFederationSibling("10001", "88888"), false)
})

test("心跳后选主仍恒定", async () => {
  const list = await onlineBotList()
  assert.deepEqual(list, BOTS)
  const v1 = await isResponsibleBot({ groupId: "111", selfId: "10001", atBotQqs: [], knownBots: BOTS })
  const v2 = await isResponsibleBot({ groupId: "111", selfId: "10001", atBotQqs: [] })
  assert.equal(v1, v2)
})
