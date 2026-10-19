import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {TurtleSoupManager} from "../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupManager.js"
import {normalizeSoupText} from "../dist/backend/modules/games/domain/turtleSoup/turtleSoupSimilarity.js"
import {puzzleContentHash} from "../dist/backend/modules/games/domain/turtleSoup/turtleSoupQuality.js"
import {TurtleSoupStore} from "../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupStore.js"

const baseConfig = {enabled: true, minPlayers: 2, joinWindowMinutes: 5, idleTimeoutMinutes: 5, guessCooldownSeconds: 30, similarityHitThreshold: 0.9, similarityMissThreshold: 0, freshPoolTarget: 2, generationModel: "", ratingWindowMinutes: 5, maxHints: 3, contentPolicy: "测试尺度", recapEveryQuestions: 10, chooseWindowSeconds: 60, baseDir: "data/turtle_soup"}
const SOLUTION = "男人是盲人,把伞当拐杖探路"

function makeHarness({hostOverrides = {}, configOverrides = {}, extraPorts = {}} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turtle-soup-mgr-"))
  let currentNow = 1_700_000_000_000
  const state = {replies: [], broadcasts: []}
  const store = new TurtleSoupStore({cwd: dir, baseDir: "data/turtle_soup"})
  const judgeDecisions = new Map()
  const host = {
    answerQuestion: async ({question}) => (/盲|看不见/.test(question) ? "是" : "与此无关"),
    judgeGuess: async ({guess}) => ({correct: judgeDecisions.get(guess) === true || normalizeSoupText(guess) === normalizeSoupText(SOLUTION), reason: judgeDecisions.get(guess) === true ? "语义等价" : "核心事实不符", closeness: 35}),
    selectMvp: async () => null,
    ...hostOverrides
  }
  const generatorStubs = {refills: 0}
  const generator = {
    busy: false,
    ensureFreshPool: async () => { generatorStubs.refills++; return {added: 0, failed: 0, lastError: undefined} },
    seed: async count => ({added: count, failed: 0, lastError: undefined})
  }
  const manager = new TurtleSoupManager({
    sendSmartReply: async (event, message) => { state.replies.push({groupId: String(event?.group_id || ""), message: String(message) }); return null },
    replyGroup: async (groupId, message) => { state.broadcasts.push({groupId, message}) },
    host, generator, logger: undefined, cwd: dir,
    config: () => ({...baseConfig, ...configOverrides}),
    now: () => currentNow,
    ...extraPorts
  })
  const event = (userId, msg, {groupId = "100", isMaster = false, role} = {}) => ({group_id: groupId, user_id: userId, msg, isMaster, sender: {user_id: userId, card: `玩家${userId}`, role}})
  const seedPuzzles = async puzzles => { for (const puzzle of puzzles) await store.savePuzzle(puzzle) }
  return {dir, store, manager, state, host, judgeDecisions, generatorStubs, event, seedPuzzles, advance: ms => { currentNow += ms }, setNow: ms => { currentNow = ms }, getNow: () => currentNow}
}

const puzzleOf = (id, overrides = {}) => ({id, title: `标题${id}`, surface: `汤面${id}:雨夜的他撑伞却撞上了树。`, solution: SOLUTION, keyPoints: ["盲人", "伞当拐杖"], hints: ["注意他为什么撞树", "伞的用法不寻常", "他看不见"], difficulty: "normal", tags: [], source: "manual", createdAt: 1, status: "active", ratingSum: 0, ratingCount: 0, ...overrides})

async function reachPlaying(harness, {groupId = "100", users = ["u1", "u2"]} = {}) {
  await harness.seedPuzzles([puzzleOf("p1")])
  await harness.manager.openGame(harness.event(users[0], ".游戏 海龟汤 开局", {groupId}))
  for (const user of users) await harness.manager.joinGame(harness.event(user, ".游戏 海龟汤 加入", {groupId}))
  return await harness.manager.startGame(harness.event(users[0], ".游戏 海龟汤 开始", {groupId}))
}

test("full flow: open, join, start, ask, miss, cooldown, hit, reveal, rate, archive", async () => {
  const harness = makeHarness({hostOverrides: {selectMvp: async ({brief}) => ({userId: brief.players[0].userId, reason: "关键提问"})}})
  try {
    const openMessage = await reachPlaying(harness)
    assert.match(openMessage, /汤面p1:|汤面p2:/)
    assert.match(openMessage, /是 \/ 不是 \/ 是也不是 \/ 与此无关/)

    const answer = await harness.manager.handleChat(harness.event("u1", "他是盲人吗"))
    assert.deepEqual(answer, {reply: "是"})

    assert.equal(await harness.manager.handleChat(harness.event("stranger", "聊点别的")), null)

    const missReply = await harness.manager.guessSoup(harness.event("u1", ".游戏 海龟汤 猜 完全无关的答案"))
    assert.match(missReply, /没猜中/)

    const cooldownReply = await harness.manager.guessSoup(harness.event("u1", ".游戏 海龟汤 猜 另一个答案"))
    assert.match(cooldownReply, /冷却中/)

    harness.advance(31_000)
    const grayGuess = "那个男人眼睛看不见东西"
    harness.judgeDecisions.set(grayGuess, false)
    const grayReply = await harness.manager.guessSoup(harness.event("u2", `.游戏 海龟汤 猜 ${grayGuess}`))
    assert.match(grayReply, /没猜中——关键事实覆盖约35%/)
    assert.doesNotMatch(grayReply, /核心事实不符/)
    assert.doesNotMatch(grayReply, /汤底核心/)

    const hintReply = await harness.manager.useHint(harness.event("u2", ".游戏 海龟汤 提示"))
    assert.match(hintReply, /注意他为什么撞树/)

    harness.advance(31_000)
    const hitReply = await harness.manager.guessSoup(harness.event("u2", `.游戏 海龟汤 猜 我觉得答案是:${SOLUTION}`))
    assert.match(hitReply, /恭喜 玩家u2 猜中汤底/)
    assert.match(hitReply, /—— 汤面 ——/)
    assert.match(hitReply, /汤面p[12]/)
    assert.match(hitReply, new RegExp(SOLUTION))
    assert.doesNotMatch(hitReply, /本局未评选出MVP/)
    await harness.manager.waitForBackgroundTasks()
    assert.match(harness.state.broadcasts.at(-1).message, /MVP:玩家u1/)
    assert.match(hitReply, /评分/)

    const play = harness.store.readPlays().plays[0]
    assert.equal(play.solved, true)
    assert.equal(play.winnerId, "u2")
    assert.equal(play.mvp.userId, "u1")
    assert.deepEqual(play.players, ["u1", "u2"])
    assert.equal(play.qaCount, 1)

    assert.match(await harness.manager.rateGame(harness.event("u1", ".游戏 海龟汤 评分 5 好玩")), /已记录评分:5星/)
    assert.match(await harness.manager.rateGame(harness.event("u2", ".游戏 海龟汤 评分 4")), /已记录评分:4星/)
    const ratedPuzzle = harness.store.readPuzzles().puzzles.find(item => item.id === play.puzzleId)
    assert.equal(ratedPuzzle.ratingSum, 9)
    assert.equal(ratedPuzzle.ratingCount, 2)

    harness.advance(5 * 60_000 + 1000)
    await harness.manager.sweep()
    assert.equal(harness.manager.getSession("100"), undefined)
    assert.match(harness.state.broadcasts.at(-1).message, /评分窗口结束/)
    assert.match(harness.state.broadcasts.at(-1).message, /4\.5分\(2人\)/)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("sweep auto-starts a full lobby when the join window expires", async () => {
  const harness = makeHarness()
  try {
    await harness.seedPuzzles([puzzleOf("p1")])
    await harness.manager.openGame(harness.event("u1", ".游戏 海龟汤 开局"))
    await harness.manager.joinGame(harness.event("u1", ".游戏 海龟汤 加入"))
    await harness.manager.joinGame(harness.event("u2", ".游戏 海龟汤 加入"))
    harness.advance(5 * 60_000 + 1000)
    await harness.manager.sweep()
    assert.equal(harness.manager.getSession("100").phase, "playing")
    assert.match(harness.state.broadcasts.at(-1).message, /汤面p1/)
    assert.equal(harness.generatorStubs.refills, 1)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("sweep cancels an empty lobby and leaves no session behind", async () => {
  const harness = makeHarness()
  try {
    await harness.manager.openGame(harness.event("u1", ".游戏 海龟汤 开局"))
    harness.advance(5 * 60_000 + 1000)
    await harness.manager.sweep()
    assert.equal(harness.manager.getSession("100"), undefined)
    assert.match(harness.state.broadcasts.at(-1).message, /人数不足,本局取消/)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("manual start requires the initiator and enough players", async () => {
  const harness = makeHarness()
  try {
    await harness.seedPuzzles([puzzleOf("p1")])
    const opened = await harness.manager.openGame(harness.event("u1", ".游戏 海龟汤 开局"))
    assert.match(opened, /发起人:玩家u1已自动上桌/)
    assert.match(await harness.manager.startGame(harness.event("u3", ".游戏 海龟汤 开始")), /人数还不够/)
    await harness.manager.joinGame(harness.event("u2", ".游戏 海龟汤 加入"))
    assert.match(await harness.manager.startGame(harness.event("u3", ".游戏 海龟汤 开始")), /只有发起人或群管理/)
    assert.match(await harness.manager.startGame(harness.event("u1", ".游戏 海龟汤 开始")), /汤面p1/)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("idle timeout sweep reveals the soup and opens the rating window", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    harness.advance(5 * 60_000 + 1000)
    await harness.manager.sweep()
    const session = harness.manager.getSession("100")
    assert.equal(session.phase, "reveal")
    assert.match(harness.state.broadcasts.at(-1).message, /自动结束/)
    assert.match(harness.state.broadcasts.at(-1).message, new RegExp(SOLUTION))
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("mid-game joiners receive a catch-up with the surface and Q&A log", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    await harness.manager.handleChat(harness.event("u1", "他是盲人吗"))
    const catchUp = await harness.manager.joinGame(harness.event("u3", ".游戏 海龟汤 加入"))
    assert.match(catchUp, /玩家u3中途加入/)
    assert.match(catchUp, /汤面p[12]/)
    assert.match(catchUp, /他是盲人吗 → 是/)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("gray-zone guess confirmed by the host judge wins immediately", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    const paraphrase = "他看不见路,拿伞探着走"
    harness.judgeDecisions.set(paraphrase, true)
    const reply = await harness.manager.guessSoup(harness.event("u1", `.游戏 海龟汤 猜 ${paraphrase}`))
    assert.match(reply, /猜中汤底/)
    assert.equal(harness.manager.getSession("100").phase, "reveal")
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("hints are capped and non-participants cannot guess or use hints", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    assert.match(await harness.manager.useHint(harness.event("u9", ".游戏 海龟汤 提示")), /先 .游戏 海龟汤 加入/)
    assert.match(await harness.manager.guessSoup(harness.event("u9", ".游戏 海龟汤 猜 什么")), /先 .游戏 海龟汤 加入/)
    assert.match(await harness.manager.useHint(harness.event("u1", ".游戏 海龟汤 提示")), /提示\(1\/3\)/)
    assert.match(await harness.manager.useHint(harness.event("u1", ".游戏 海龟汤 提示")), /先一起讨论/)
    harness.advance(16_000)
    assert.match(await harness.manager.useHint(harness.event("u1", ".游戏 海龟汤 提示")), /提示\(2\/3\)/)
    harness.advance(16_000)
    assert.match(await harness.manager.useHint(harness.event("u1", ".游戏 海龟汤 提示")), /提示\(3\/3\)/)
    assert.match(await harness.manager.useHint(harness.event("u1", ".游戏 海龟汤 提示")), /本局提示已用完/)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("low-rated puzzles pause for review after three independent ratings", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness, {users: ["u1", "u2", "u3"]})
    await harness.manager.guessSoup(harness.event("u1", `.游戏 海龟汤 猜 ${SOLUTION}`))
    const session = harness.manager.getSession("100")
    for (const user of ["u1", "u2"]) {
      assert.match(await harness.manager.rateGame(harness.event(user, ".游戏 海龟汤 评分 1")), /已记录评分:1星/)
    }
    const retiring = await harness.manager.rateGame(harness.event("u3", ".游戏 海龟汤 评分 1"))
    assert.match(retiring, /暂缓投放/)
    const puzzle = harness.store.readPuzzles().puzzles.find(item => item.id === session.puzzleId)
    assert.equal(puzzle.status, "pending")
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("manual end reveals; inventory and generation are admin-only", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    assert.match(await harness.manager.endGame(harness.event("u9", ".游戏 海龟汤 结束")), /只有发起人或群管理/)
    const ended = await harness.manager.endGame(harness.event("u1", ".游戏 海龟汤 结束"))
    assert.match(ended, /汤底/)
    assert.equal(harness.manager.getSession("100").phase, "reveal")
    assert.match(await harness.manager.inventory(harness.event("u1", ".游戏 海龟汤 库存")), /仅管理员/)
    assert.match(await harness.manager.generateMore(harness.event("u1", ".游戏 海龟汤 生成 3")), /仅管理员/)
    assert.match(await harness.manager.inventory(harness.event("admin", ".游戏 海龟汤 库存", {isMaster: true})), /题库:共1个版本/)
    assert.match(await harness.manager.generateMore(harness.event("admin", ".游戏 海龟汤 生成 3", {isMaster: true})), /成功3道/)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("puzzle already played by this group is never re-selected", async () => {
  const harness = makeHarness()
  try {
    await harness.seedPuzzles([puzzleOf("p1"), puzzleOf("p2")])
    await harness.manager.openGame(harness.event("u1", ".游戏 海龟汤 开局"))
    for (const user of ["u1", "u2"]) await harness.manager.joinGame(harness.event(user, ".游戏 海龟汤 加入"))
    const menu = await harness.manager.startGame(harness.event("u1", ".游戏 海龟汤 开始"))
    assert.match(menu, /三选一:/)
    const picked = await harness.manager.choosePuzzle(harness.event("u1", ".游戏 海龟汤 选 1"))
    assert.match(picked, /就吃【标题p[12]】!/)
    const firstId = harness.manager.getSession("100").puzzleId
    await harness.manager.guessSoup(harness.event("u1", `.游戏 海龟汤 猜 ${SOLUTION}`))
    harness.advance(6 * 60_000)
    await harness.manager.sweep()

    await harness.manager.openGame(harness.event("u1", ".游戏 海龟汤 开局"))
    for (const user of ["u1", "u2"]) await harness.manager.joinGame(harness.event(user, ".游戏 海龟汤 加入"))
    const second = await harness.manager.startGame(harness.event("u1", ".游戏 海龟汤 开始"))
    assert.match(second, /汤面p[12]/)
    const plays = harness.store.readPlays().plays
    assert.equal(plays.length, 2)
    assert.notEqual(firstId, plays[1].puzzleId)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("openGame refuses when another heavy game is active in the group", async () => {
  const harness = makeHarness()
  try {
    const gatedManager = new TurtleSoupManager({
      sendSmartReply: async () => null,
      host: harness.host,
      generator: {ensureFreshPool: async () => ({added: 0, failed: 0, lastError: undefined}), seed: async n => ({added: n, failed: 0, lastError: undefined})},
      cwd: harness.dir,
      config: () => ({...baseConfig}),
      now: harness.getNow,
      isOtherGameActive: groupId => groupId === "777"
    })
    assert.match(await gatedManager.openGame(harness.event("u1", ".游戏 海龟汤 开局", {groupId: "777"})), /赛马娘比赛/)
    assert.equal(gatedManager.getSession("777"), undefined)
    assert.match(await gatedManager.openGame(harness.event("u1", ".游戏 海龟汤 开局", {groupId: "888"})), /报名开始/)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("parenthesized asides are off-table: ignored, unrecorded, no activity refresh", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    const before = harness.manager.getSession("100").lastActivityAt
    assert.equal(await harness.manager.handleChat(harness.event("u1", "(歪着头沉思)")), null)
    assert.equal(await harness.manager.handleChat(harness.event("u1", "（摸了摸下巴）")), null)
    assert.equal(await harness.manager.handleChat(harness.event("u1", "(举手)（我猜是鬼故事）")), null)
    const session = harness.manager.getSession("100")
    assert.equal(session.qaLog.length, 0)
    assert.equal(session.lastActivityAt, before)

    const mixed = await harness.manager.handleChat(harness.event("u1", "(歪着头)他是盲人吗(对吧)"))
    assert.deepEqual(mixed, {reply: "是"})
    assert.equal(session.qaLog.at(-1).question, "他是盲人吗")
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("a recap card fires on every 10th question and contains surface plus four buckets", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    let recapSeen = 0
    for (let index = 1; index <= 12; index++) {
      const output = await harness.manager.handleChat(harness.event(index % 2 ? "u1" : "u2", `第${index}个问题:他是盲人吗`))
      if (output.recap !== undefined) {
        recapSeen++
        assert.equal(output.reply, "是")
        assert.match(output.recap, /—— 海龟汤进度卡 ——/)
        assert.match(output.recap, /汤面p[12]/)
        assert.match(output.recap, /【是的】\(10\)/)
        assert.match(output.recap, /【不是】\(0\)/)
        assert.match(output.recap, /【是也不是】\(0\)/)
        assert.match(output.recap, /【这不重要】\(0\)/)
        assert.match(output.recap, /玩家u1:第1个问题/)
        assert.match(output.recap, /玩家u2:第2个问题/)
        assert.match(output.recap, /已提问 10 次/)
        assert.match(output.recap, /想玩随时 \.游戏 海龟汤 加入,上车即补发汤面和已问答记录/)
        assert.match(output.recap, /场外,我不会回应/)
        assert.match(output.recap, /投降 —— 汤底私发给你并退场/)
        assert.match(output.recap, /结束 —— 发起人或群管理可提前揭晓/)
      }
    }
    assert.equal(recapSeen, 1)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("solo play: a single player can start and finish alone when minPlayers is 1", async () => {
  const harness = makeHarness()
  const soloManager = new TurtleSoupManager({
    sendSmartReply: async () => null,
    host: harness.host,
    generator: {ensureFreshPool: async () => ({added: 0, failed: 0, lastError: undefined}), seed: async n => ({added: n, failed: 0, lastError: undefined})},
    cwd: harness.dir,
    config: () => ({...baseConfig, minPlayers: 1}),
    now: harness.getNow,
    replyGroup: async () => null
  })
  try {
    await harness.seedPuzzles([puzzleOf("p1")])
    await soloManager.openGame(harness.event("u1", ".游戏 海龟汤 开局"))
    await soloManager.joinGame(harness.event("u1", ".游戏 海龟汤 加入"))
    const started = await soloManager.startGame(harness.event("u1", ".游戏 海龟汤 开始"))
    assert.match(started, /汤面p1/)
    const answer = await soloManager.handleChat(harness.event("u1", "他是盲人吗"))
    assert.deepEqual(answer, {reply: "是"})
    const reveal = await soloManager.guessSoup(harness.event("u1", `.游戏 海龟汤 猜 ${SOLUTION}`))
    assert.match(reveal, /恭喜 玩家u1 猜中汤底/)
    assert.equal(soloManager.getSession("100").phase, "reveal")
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("surrender removes the player, sends the answer privately and blocks further play", async () => {
  const privateMessages = []
  const harness = makeHarness()
  const soloManager = new TurtleSoupManager({
    sendSmartReply: async (event, message) => { harness.state.replies.push({groupId: String(event?.group_id || ""), message: String(message)}); return null },
    replyGroup: async () => null,
    host: harness.host, generator: {ensureFreshPool: async () => ({added: 0, failed: 0, lastError: undefined}), seed: async n => ({added: n, failed: 0, lastError: undefined})},
    cwd: harness.dir, config: () => ({...baseConfig}), now: harness.getNow,
    sendPrivate: async (userId, message, groupId) => { privateMessages.push({userId, message, groupId}) }
  })
  try {
    await harness.seedPuzzles([puzzleOf("p1")])
    await soloManager.openGame(harness.event("u1", ".游戏 海龟汤 开局"))
    for (const user of ["u1", "u2"]) await soloManager.joinGame(harness.event(user, ".游戏 海龟汤 加入"))
    await soloManager.startGame(harness.event("u1", ".游戏 海龟汤 开始"))
    const reply = await soloManager.surrender(harness.event("u1", ".游戏 海龟汤 投降"))
    assert.match(reply, /玩家u1已投降并退场,汤底已私发。剩余1人继续/)
    assert.equal(privateMessages.length, 1)
    assert.equal(privateMessages[0].userId, "u1")
    assert.equal(privateMessages[0].groupId, "100", "私发需带群号供临时会话通道使用")
    assert.match(privateMessages[0].message, new RegExp(SOLUTION))
    assert.match(privateMessages[0].message, /请勿在群里剧透/)
    const session = soloManager.getSession("100")
    assert.deepEqual(session.players.map(player => player.userId), ["u2"])
    assert.equal(session.surrendered.u1.delivered, true)
    assert.equal(await soloManager.handleChat(harness.event("u1", "他是盲人吗")), null)
    assert.match(await soloManager.guessSoup(harness.event("u1", ".游戏 海龟汤 猜 盲人")), /先 .游戏 海龟汤 加入/)

    assert.match(await soloManager.surrender(harness.event("u9", ".游戏 海龟汤 投降")), /你不在本局中/)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("surrender delivery failure keeps the retry path and everyone-surrendered ends the game", async () => {
  let deliverFails = true
  const privateMessages = []
  const harness = makeHarness()
  const manager = new TurtleSoupManager({
    sendSmartReply: async () => null,
    replyGroup: async (groupId, message) => { harness.state.broadcasts.push({groupId, message}) },
    host: harness.host, generator: {ensureFreshPool: async () => ({added: 0, failed: 0, lastError: undefined}), seed: async n => ({added: n, failed: 0, lastError: undefined})},
    cwd: harness.dir, config: () => ({...baseConfig}), now: harness.getNow,
    sendPrivate: async (userId, message) => {
      if (deliverFails) throw new Error("not friend")
      privateMessages.push({userId, message})
    }
  })
  try {
    await harness.seedPuzzles([puzzleOf("p1")])
    await manager.openGame(harness.event("u1", ".游戏 海龟汤 开局"))
    for (const user of ["u1", "u2"]) await manager.joinGame(harness.event(user, ".游戏 海龟汤 加入"))
    await manager.startGame(harness.event("u1", ".游戏 海龟汤 开始"))

    const failed = await manager.surrender(harness.event("u1", ".游戏 海龟汤 投降"))
    assert.match(failed, /私发失败/)
    assert.match(failed, /可加机器人为好友后再发一次/)
    assert.equal(manager.getSession("100").surrendered.u1.delivered, false)

    deliverFails = false
    const retried = await manager.surrender(harness.event("u1", ".游戏 海龟汤 投降"))
    assert.match(retried, /剩余1人继续/)
    assert.equal(privateMessages.length, 1)
    assert.equal(manager.getSession("100").surrendered.u1.delivered, true)

    const ended = await manager.surrender(harness.event("u2", ".游戏 海龟汤 投降"))
    assert.match(ended, /所有玩家均已投降/)
    assert.match(ended, new RegExp(SOLUTION))
    assert.equal(manager.getSession("100").phase, "reveal")
    const play = harness.store.readPlays().plays[0]
    assert.equal(play.endReason, "all_surrendered")
    // 投降者拿过汤底也计入参与名单（跨群按参与人排除剧透用）
    assert.deepEqual(play.players, ["u1", "u2"])
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("non-question chatter (interjections, laughter, letter spam) gets silence", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    const before = harness.manager.getSession("100").lastActivityAt
    for (const noise of ["欧不", "wq", "哈哈哈哈", "草", "233", "awsl", "asdjkhaskjdhaskjdh", "6"]) {
      assert.equal(await harness.manager.handleChat(harness.event("u1", noise)), null, `should ignore: ${noise}`)
    }
    const session = harness.manager.getSession("100")
    assert.equal(session.qaLog.length, 0)
    assert.equal(session.lastActivityAt, before)

    assert.deepEqual(await harness.manager.handleChat(harness.event("u1", "他是盲人吗")), {reply: "是"})
    assert.deepEqual(await harness.manager.handleChat(harness.event("u1", "他肯定是盲人")), {reply: "是"})
    const shortWithMark = await harness.manager.handleChat(harness.event("u1", "他看不见?"))
    assert.equal(typeof shortWithMark?.reply, "string")
    const longStatement = await harness.manager.handleChat(harness.event("u1", "这个人雨夜出门一定有原因吧我想想"))
    assert.equal(typeof longStatement?.reply, "string")
    assert.equal(session.qaLog.length, 4)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("identical repeated questions by the same player are answered once", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    const first = await harness.manager.handleChat(harness.event("u1", "他是盲人吗?"))
    assert.deepEqual(first, {reply: "是"})
    assert.equal(await harness.manager.handleChat(harness.event("u1", "他是盲人吗?")), null)
    assert.equal(await harness.manager.handleChat(harness.event("u1", "我觉得他是盲人吗")), null)
    const session = harness.manager.getSession("100")
    assert.equal(session.qaLog.length, 1)

    const other = await harness.manager.handleChat(harness.event("u2", "他是盲人吗?"))
    assert.deepEqual(other, {reply: "是"})
    assert.equal(session.qaLog.length, 2)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("meta talk quoting the command (telling others to type it) gets silence", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    assert.equal(await harness.manager.handleChat(harness.event("u1", "你发\n.游戏 海龟汤 加入 这个也会被回复")), null)
    assert.equal(await harness.manager.handleChat(harness.event("u1", "@墨玉 你发 .游戏 海龟汤 加入")), null)
    assert.equal(await harness.manager.handleChat(harness.event("u1", "卡住了就发。游戏 海龟汤 提示 啊")), null)
    assert.equal(harness.manager.getSession("100").qaLog.length, 0)
    assert.deepEqual(await harness.manager.handleChat(harness.event("u1", "他是盲人吗")), {reply: "是"})
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("playingGroupIds tracks only groups with an active Q&A session", async () => {
  const harness = makeHarness()
  try {
    await harness.seedPuzzles([puzzleOf("p1")])
    await harness.manager.openGame(harness.event("u1", ".游戏 海龟汤 开局"))
    assert.equal(harness.manager.playingGroupIds().has("100"), false)
    for (const user of ["u1", "u2"]) await harness.manager.joinGame(harness.event(user, ".游戏 海龟汤 加入"))
    await harness.manager.startGame(harness.event("u1", ".游戏 海龟汤 开始"))
    assert.equal(harness.manager.playingGroupIds().has("100"), true)
    await harness.manager.guessSoup(harness.event("u1", `.游戏 海龟汤 猜 ${SOLUTION}`))
    assert.equal(harness.manager.playingGroupIds().has("100"), false)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("after reveal, archiving leaves the independent rating window available", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    await harness.manager.guessSoup(harness.event("u1", `.游戏 海龟汤 猜 ${SOLUTION}`))
    assert.equal(harness.manager.getSession("100").phase, "reveal")

    assert.match(await harness.manager.endGame(harness.event("u9", ".游戏 海龟汤 结束")), /发起人或群管理可发/)
    const closed = await harness.manager.endGame(harness.event("u1", ".游戏 海龟汤 结束"))
    assert.match(closed, /评分窗口保留至原截止时间/)
    assert.match(closed, /本局归档/)
    assert.equal(harness.manager.getSession("100"), undefined)

    assert.match(await harness.manager.openGame(harness.event("u2", ".游戏 海龟汤 开局")), /报名开始/)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("openGame during the rating window immediately opens a new lobby", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    await harness.manager.guessSoup(harness.event("u1", `.游戏 海龟汤 猜 ${SOLUTION}`))
    assert.match(await harness.manager.openGame(harness.event("u2", ".游戏 海龟汤 开局")), /报名开始/)
    assert.match(await harness.manager.rateGame(harness.event("u1", ".游戏 海龟汤 评分 上一局 5")), /已记录评分:5星/)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("surrendered players cannot rejoin the same game", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness, {users: ["u1", "u2"]})
    await harness.manager.surrender(harness.event("u1", ".游戏 海龟汤 投降"))
    assert.match(await harness.manager.joinGame(harness.event("u1", ".游戏 海龟汤 加入")), /已投降并看过汤底,本局不能再加入/)
    const session = harness.manager.getSession("100")
    assert.deepEqual(session.players.map(player => player.userId), ["u2"])
    assert.equal(session.surrendered.u1 !== undefined, true)
    assert.match(await harness.manager.joinGame(harness.event("u3", ".游戏 海龟汤 加入")), /中途加入/)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("the initiator can cancel a lobby immediately instead of waiting out the window", async () => {
  const harness = makeHarness()
  try {
    await harness.manager.openGame(harness.event("u1", ".游戏 海龟汤 开局"))
    assert.equal(harness.manager.getSession("100").phase, "joining")
    assert.match(await harness.manager.cancelGame(harness.event("u9", ".游戏 海龟汤 取消")), /只有发起人或群管理/)
    assert.match(await harness.manager.cancelGame(harness.event("u1", ".游戏 海龟汤 取消")), /报名已取消,本局作废/)
    assert.equal(harness.manager.getSession("100"), undefined)
    assert.match(await harness.manager.openGame(harness.event("u2", ".游戏 海龟汤 开局")), /报名开始/)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("cancel during play delegates to end and reveals the soup", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    const reply = await harness.manager.cancelGame(harness.event("u1", ".游戏 海龟汤 取消"))
    assert.match(reply, new RegExp(SOLUTION))
    assert.equal(harness.manager.getSession("100").phase, "reveal")
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("unclosed single paren and leading-comma asides are ignored entirely", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    const before = harness.manager.getSession("100").lastActivityAt
    for (const aside of ["(歪着头沉思", "（摸了摸下巴", ",歪头", "，若有所思", "(举手 ", "(思考)(点头"]) {
      assert.equal(await harness.manager.handleChat(harness.event("u1", aside)), null, `should ignore: ${aside}`)
    }
    const session = harness.manager.getSession("100")
    assert.equal(session.qaLog.length, 0)
    assert.equal(session.lastActivityAt, before)
    assert.deepEqual(await harness.manager.handleChat(harness.event("u1", "(举手)他是盲人吗")), {reply: "是"})
    assert.deepEqual(await harness.manager.handleChat(harness.event("u1", "他是不是盲人,还是聋了")), {reply: "是"})
    assert.equal(session.qaLog.length, 2)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("ultra-short utterances with a question mark are still ignored", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    for (const noise of ["单?", "？", "??? ", "雨夜?", "他吗?", "wq?"]) {
      assert.equal(await harness.manager.handleChat(harness.event("u1", noise)), null, `should ignore: ${noise}`)
    }
    assert.equal(harness.manager.getSession("100").qaLog.length, 0)
    assert.deepEqual(await harness.manager.handleChat(harness.event("u1", "他看不见吗?")), {reply: "是"})
    const whereReply = await harness.manager.handleChat(harness.event("u1", "他在哪里?"))
    assert.equal(typeof whereReply?.reply, "string")
    assert.equal(harness.manager.getSession("100").qaLog.length, 2)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("choosing phase: menu, first-pick wins, timeout auto-random, cancel", async () => {
  const harness = makeHarness()
  try {
    await harness.seedPuzzles([puzzleOf("p1"), puzzleOf("p2"), puzzleOf("p3")])
    await harness.manager.openGame(harness.event("u1", ".游戏 海龟汤 开局"))
    for (const user of ["u1", "u2"]) await harness.manager.joinGame(harness.event(user, ".游戏 海龟汤 加入"))
    const menu = await harness.manager.startGame(harness.event("u1", ".游戏 海龟汤 开始"))
    assert.match(menu, /三选一:/)
    assert.match(menu, /1\.【标题p[123]】/)
    assert.match(menu, /2\.【标题p[123]】/)
    assert.match(menu, /3\.【标题p[123]】/)
    assert.equal(harness.manager.getSession("100").phase, "choosing")
    assert.match(await harness.manager.choosePuzzle(harness.event("u9", ".游戏 海龟汤 选 2")), /先 .游戏 海龟汤 加入 才能选汤/)
    const picked = await harness.manager.choosePuzzle(harness.event("u2", ".游戏 海龟汤 选 2"))
    assert.match(picked, /就吃【标题p[123]】!/)
    assert.match(picked, /汤面p[123]/)
    assert.equal(harness.manager.getSession("100").phase, "playing")
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("choosing phase: nobody picks, sweep auto-randoms; join and cancel work mid-choose", async () => {
  const harness = makeHarness()
  try {
    await harness.seedPuzzles([puzzleOf("p1"), puzzleOf("p2")])
    await harness.manager.openGame(harness.event("u1", ".游戏 海龟汤 开局"))
    for (const user of ["u1", "u2"]) await harness.manager.joinGame(harness.event(user, ".游戏 海龟汤 加入"))
    await harness.manager.startGame(harness.event("u1", ".游戏 海龟汤 开始"))
    assert.match(await harness.manager.joinGame(harness.event("u3", ".游戏 海龟汤 加入")), /正在选汤,开局后一起玩/)
    assert.equal(harness.manager.playingGroupIds().has("100"), true)
    assert.match(await harness.manager.cancelGame(harness.event("u9", ".游戏 海龟汤 取消")), /只有发起人或群管理/)
    assert.match(await harness.manager.cancelGame(harness.event("u1", ".游戏 海龟汤 取消")), /报名已取消/)

    await harness.manager.openGame(harness.event("u1", ".游戏 海龟汤 开局"))
    for (const user of ["u1", "u2"]) await harness.manager.joinGame(harness.event(user, ".游戏 海龟汤 加入"))
    await harness.manager.startGame(harness.event("u1", ".游戏 海龟汤 开始"))
    harness.advance(61_000)
    await harness.manager.sweep()
    assert.match(harness.state.broadcasts.at(-1).message, /无人选汤,自动随机/)
    assert.equal(harness.manager.getSession("100").phase, "playing")
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("结束 during joining drops the lobby instead of leaving it to auto-start", async () => {
  const harness = makeHarness()
  try {
    await harness.seedPuzzles([puzzleOf("p1")])
    await harness.manager.openGame(harness.event("u1", ".游戏 海龟汤 开局"))
    await harness.manager.joinGame(harness.event("u1", ".游戏 海龟汤 加入"))
    await harness.manager.joinGame(harness.event("u2", ".游戏 海龟汤 加入"))
    // 报名期发"结束"：必须真的取消，不能只回一句"本局已结束"留着会话
    const reply = await harness.manager.endGame(harness.event("u1", ".游戏 海龟汤 结束"))
    assert.match(reply, /报名期已结束,本局取消/)
    assert.equal(harness.manager.getSession("100"), undefined, "报名期会话必须删除")
    // 到点 sweep 不能再把这局"复活"上菜
    harness.advance(5 * 60_000 + 1000)
    await harness.manager.sweep()
    assert.equal(harness.manager.getSession("100"), undefined)
    assert.equal(harness.state.broadcasts.length, 0, "不应再出现上菜/开局播报")
    // 非发起人在报名期结束依然被拦
    await harness.manager.openGame(harness.event("u1", ".游戏 海龟汤 开局"))
    await harness.manager.joinGame(harness.event("u1", ".游戏 海龟汤 加入"))
    assert.match(await harness.manager.endGame(harness.event("u9", ".游戏 海龟汤 结束")), /只有发起人或群管理/)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("三选一随机池同样按参与人跨群排除", async () => {
  const harness = makeHarness()
  try {
    await harness.seedPuzzles([puzzleOf("p1"), puzzleOf("p2"), puzzleOf("p3")])
    // 历史记录：u1 在群 200 玩过 p1；剩两道才走三选一
    await harness.store.upsertPlay({playId: "hist", puzzleId: "p1", puzzleTitle: "t1", groupId: "200", startedAt: 1, solved: false, players: ["u1"], qaCount: 0, ratings: []})
    await harness.manager.openGame(harness.event("u1", ".游戏 海龟汤 开局"))
    await harness.manager.joinGame(harness.event("u1", ".游戏 海龟汤 加入"))
    await harness.manager.joinGame(harness.event("u2", ".游戏 海龟汤 加入"))
    harness.advance(5 * 60_000 + 1000)
    await harness.manager.sweep()
    const session = harness.manager.getSession("100")
    assert.equal(session.phase, "choosing", "进入三选一")
    assert.ok(!session.choosing.candidates.includes("p1"), "u1 玩过的 p1 不进候选")
    assert.ok(session.choosing.candidates.includes("p2"))
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("题库审核命令:待审列表/过审进入投放/淘汰出池", async () => {
  const harness = makeHarness()
  try {
    await harness.seedPuzzles([
      puzzleOf("pA"),
      { ...puzzleOf("pB"), status: "pending" },
      { ...puzzleOf("pC"), status: "pending" }
    ])
    const manager = harness.manager
    const admin = harness.event("u1", ".游戏 海龟汤 待审", { isMaster: true })
    assert.match(manager.listPending(admin), /待审海龟汤 2 道/)
    assert.match(manager.listPending(admin), /2\.【标题pC/)
    // 非管理员被拦
    assert.match(await manager.reviewPuzzle(harness.event("u9", ".游戏 海龟汤 过审 1"), "approve"), /仅管理员/)
    assert.match(await manager.reviewPuzzle(harness.event("u1", ".游戏 海龟汤 过审 1", { isMaster: true }), "approve"), /当前版本尚未通过完整审核/)
    const reviewed = harness.store.readPuzzles().puzzles.find(puzzle => puzzle.id === "pB")
    reviewed.audits = ["structure", "playability", "logic", "simulation"].map(domain => ({domain, pass: true, reason: "通过", holes: [], at: harness.getNow(), contentHash: puzzleContentHash(reviewed)}))
    await harness.store.savePuzzle(reviewed)
    // 过审 1 号(pB) → active 进入投放
    assert.match(await manager.reviewPuzzle(harness.event("u1", ".游戏 海龟汤 过审 1", { isMaster: true }), "approve"), /标题pB.*已过审/)
    assert.equal(harness.store.readPuzzles().puzzles.find(z => z.title.includes("pB")).status, "active")
    // 淘汰 pC
    assert.match(await manager.reviewPuzzle(harness.event("u1", ".游戏 海龟汤 淘汰 pC", { isMaster: true }), "reject"), /标题pC.*已淘汰/)
    assert.equal(harness.store.readPuzzles().puzzles.find(z => z.title.includes("pC")).status, "retired")
    assert.equal(manager.listPending(admin), "没有待审的海龟汤")
    // 库存显示过待审数
    assert.ok(manager.inventory(admin).includes("题库"))
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("换汤:当局废弃原班人马直接新开,旧题不再随机到", async () => {
  const harness = makeHarness()
  try {
    await harness.seedPuzzles([puzzleOf("p1"), puzzleOf("p2"), puzzleOf("p3")])
    await harness.manager.openGame(harness.event("u1", ".游戏 海龟汤 开局"))
    await harness.manager.joinGame(harness.event("u1", ".游戏 海龟汤 加入"))
    await harness.manager.joinGame(harness.event("u2", ".游戏 海龟汤 加入"))
    await harness.manager.startGame(harness.event("u1", ".游戏 海龟汤 开始"))
    await harness.manager.choosePuzzle(harness.event("u1", ".游戏 海龟汤 选 1"))
    const session = harness.manager.getSession("100")
    const oldPuzzleId = session.puzzleId
    // 非发起人被拦
    assert.match(await harness.manager.switchPuzzle(harness.event("u9", ".游戏 海龟汤 换汤")), /只有发起人或群管理/)
    const reply = await harness.manager.switchPuzzle(harness.event("u1", ".游戏 海龟汤 换汤"))
    assert.match(reply, /换汤不换人,原班2人继续/)
    assert.match(reply, /上菜!三选一/)
    const next = harness.manager.getSession("100")
    assert.equal(next.phase, "choosing", "新局直接进入选汤")
    assert.ok(!next.choosing.candidates.includes(oldPuzzleId), "旧题不再出现在候选")
    assert.equal(next.players.length, 2, "原班人马保留")
    // 旧局按 switched 归档
    const play = harness.store.readPlays().plays.find(item => item.puzzleId === oldPuzzleId)
    assert.equal(play.endReason, "switched")
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("排行榜:按评分展示 x人评分x星,永久记录", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness, { users: ["u1", "u2"] })
    await harness.manager.endGame(harness.event("u1", ".游戏 海龟汤 结束"))
    await harness.manager.rateGame(harness.event("u1", ".游戏 海龟汤 评分 5 好玩"))
    await harness.manager.rateGame(harness.event("u2", ".游戏 海龟汤 评分 4"))
    const text = harness.manager.rankings()
    assert.match(text, /🏆 海龟汤榜单/)
    assert.match(text, /2人评分4\.5星/)
    const empty = makeHarness()
    try {
      assert.match(empty.manager.rankings(), /还没有汤被评过分/)
    } finally { fs.rmSync(empty.dir, {recursive: true, force: true}) }
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return {promise, resolve} }

test("slow Q&A cannot resurrect the previous puzzle after switching", async () => {
  const entered = deferred(), answer = deferred()
  const harness = makeHarness({hostOverrides: {answerQuestion: async () => { entered.resolve(); return answer.promise }}})
  try {
    await reachPlaying(harness)
    await harness.seedPuzzles([puzzleOf("p2")])
    const pending = harness.manager.handleChat(harness.event("u1", "男人是不是盲人？"))
    await entered.promise
    const before = harness.manager.getSession("100").playId
    assert.match(await harness.manager.switchPuzzle(harness.event("u1", ".游戏 海龟汤 换汤 卡住了")), /换汤不换人/)
    const next = harness.manager.getSession("100").playId
    assert.notEqual(next, before)
    answer.resolve("是")
    assert.equal(await pending, null)
    assert.equal(harness.manager.getSession("100").puzzleId, "p2")
    assert.equal(harness.manager.getSession("100").qaLog.length, 0)
    assert.equal(harness.store.readPlays().plays.find(play => play.playId === next).endedAt, undefined)
  } finally { answer.resolve("是"); fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("slow guess cannot solve a replacement game and does not block switching", async () => {
  const entered = deferred(), verdict = deferred()
  const harness = makeHarness({hostOverrides: {judgeGuess: async () => { entered.resolve(); return verdict.promise }}})
  try {
    await reachPlaying(harness)
    await harness.seedPuzzles([puzzleOf("p2")])
    const pending = harness.manager.guessSoup(harness.event("u1", `.游戏 海龟汤 猜 ${SOLUTION}`))
    await entered.promise
    await harness.manager.switchPuzzle(harness.event("u1", ".游戏 海龟汤 换汤"))
    verdict.resolve({correct: true, reason: "覆盖", closeness: 100})
    assert.match(await pending, /对局已变更/)
    assert.equal(harness.manager.getSession("100").puzzleId, "p2")
    assert.equal(harness.manager.getSession("100").phase, "playing")
    assert.equal(harness.store.readPlays().plays.find(play => play.puzzleId === "p2").solved, false)
  } finally { verdict.resolve({correct: false}); fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("a high literal overlap never bypasses semantic contradiction checking", async () => {
  const calls = []
  const solution = "男人是盲人，他每天下班都沿着同一条路回家。那天雨很大，他把长柄伞当拐杖探路，却因路边新出现的障碍物摔倒。他拒绝旁人的帮助，是因为害怕让家人发现自己失明。"
  const harness = makeHarness({hostOverrides: {judgeGuess: async input => { calls.push(input); return {correct: false, reason: "核心矛盾", closeness: 90} }}})
  try {
    await harness.seedPuzzles([puzzleOf("long", {solution})])
    await harness.manager.openGame(harness.event("u1", ""))
    await harness.manager.joinGame(harness.event("u2", ""))
    await harness.manager.startGame(harness.event("u1", ""))
    const reply = await harness.manager.guessSoup(harness.event("u1", `.游戏 海龟汤 猜 ${solution.replace("是盲人", "不是盲人")}`))
    assert.match(reply, /没猜中/)
    assert.equal(calls.length, 1)
    assert.ok(calls[0].literalScore > 0.9)
    assert.equal(harness.manager.getSession("100").phase, "playing")
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("unavailable judging is retryable without recording a wrong guess or cooldown", async () => {
  const harness = makeHarness({hostOverrides: {judgeGuess: async () => ({correct: false, closeness: 0, reason: "schema", status: "unavailable"})}})
  try {
    await reachPlaying(harness)
    assert.match(await harness.manager.guessSoup(harness.event("u1", ".游戏 海龟汤 猜 男人是盲人")), /不计失败和冷却/)
    assert.match(await harness.manager.guessSoup(harness.event("u1", ".游戏 海龟汤 猜 男人是盲人")), /不计失败和冷却/)
    assert.equal(harness.manager.getSession("100").guessLog.length, 0)
    assert.equal(harness.manager.getSession("100").lastGuessAt.u1, undefined)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("simultaneous participant ratings both persist and aggregate correctly", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    await harness.manager.endGame(harness.event("u1", ""))
    const responses = await Promise.all([harness.manager.rateGame(harness.event("u1", ".游戏 海龟汤 评分 5")), harness.manager.rateGame(harness.event("u2", ".游戏 海龟汤 评分 1"))])
    assert.ok(responses.every(response => response.includes("已记录评分")))
    assert.equal(harness.store.readPlays().plays[0].ratings.length, 2)
    const puzzle = harness.store.readPuzzles().puzzles[0]
    assert.equal(puzzle.ratingCount, 2)
    assert.equal(puzzle.ratingSum, 6)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("switched games retain diagnostics and a classified rating window while the next game runs", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    await harness.manager.handleChat(harness.event("u1", "男人是盲人吗"))
    const previous = harness.manager.getSession("100").playId
    await harness.seedPuzzles([puzzleOf("p2")])
    await harness.manager.switchPuzzle(harness.event("u1", ".游戏 海龟汤 换汤 主持回答前后矛盾"))
    const current = harness.manager.getSession("100").playId
    assert.match(await harness.manager.rateGame(harness.event("u1", `.游戏 海龟汤 评分 ${previous} 2 主持 回答矛盾`)), /已记录评分:2星/)
    const old = harness.store.readPlays().plays.find(play => play.playId === previous)
    assert.equal(old.switchReason, "主持回答前后矛盾")
    assert.equal(old.qaLog.length, 1)
    assert.equal(old.ratings[0].category, "host")
    assert.equal(old.ratings[0].comment, "回答矛盾")
    assert.equal(harness.manager.getSession("100").playId, current)
    assert.match(await harness.manager.rateGame(harness.event("u9", `.游戏 海龟汤 评分 ${previous} 1`)), /仅本局参与者/)
    harness.advance(301_000)
    assert.match(await harness.manager.rateGame(harness.event("u1", `.游戏 海龟汤 评分 ${previous} 5`)), /评分窗口已结束/)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("family exposure blocks late joining and active players are recorded immediately", async () => {
  const harness = makeHarness()
  try {
    const revised = puzzleOf("p1", {familyId: "story", version: 2})
    revised.audits = ["structure", "playability", "logic", "simulation"].map(domain => ({domain, pass: true, reason: "通过", holes: [], at: harness.getNow(), contentHash: puzzleContentHash(revised)}))
    await harness.seedPuzzles([revised])
    await harness.store.upsertPlay({playId: "old", puzzleId: "old-version", familyId: "story", puzzleTitle: "旧版", groupId: "200", startedAt: 1, endedAt: 2, solved: false, players: ["seen"], qaCount: 0, ratings: []})
    await harness.manager.openGame(harness.event("u1", ""))
    await harness.manager.joinGame(harness.event("u2", ""))
    await harness.manager.startGame(harness.event("u1", ""))
    assert.match(await harness.manager.joinGame(harness.event("seen", "")), /已看过这道汤或其旧版本/)
    const playId = harness.manager.getSession("100").playId
    assert.deepEqual(harness.store.readPlays().plays.find(play => play.playId === playId).players, ["u1", "u2"])
    assert.match(await harness.manager.joinGame(harness.event("u3", "")), /中途加入/)
    assert.ok(harness.store.readPlays().plays.find(play => play.playId === playId).players.includes("u3"))
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("actual opening prioritizes a fresh soup over three previously exposed candidates", async () => {
  const harness = makeHarness()
  try {
    await harness.seedPuzzles([puzzleOf("fresh"), ...[1, 2, 3].map(index => puzzleOf(`old${index}`))])
    for (const index of [1, 2, 3]) await harness.store.upsertPlay({playId: `oldplay${index}`, puzzleId: `old${index}`, puzzleTitle: "旧汤", groupId: "200", startedAt: index, solved: false, players: ["other"], qaCount: 0, ratings: []})
    await harness.manager.openGame(harness.event("u1", ""))
    await harness.manager.joinGame(harness.event("u2", ""))
    await harness.manager.startGame(harness.event("u1", ""))
    assert.equal(harness.manager.getSession("100").puzzleId, "fresh")
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("the last surrender closes immediately even when private delivery is unavailable", async () => {
  const harness = makeHarness({configOverrides: {minPlayers: 1}, extraPorts: {sendPrivate: async () => { throw new Error("offline") }}})
  try {
    await reachPlaying(harness, {users: ["u1"]})
    const result = await harness.manager.surrender(harness.event("u1", ""))
    assert.match(result, /所有玩家均已投降/)
    assert.equal(harness.manager.getSession("100").phase, "reveal")
    assert.equal(harness.store.readPlays().plays[0].endReason, "all_surrendered")
    assert.match(await harness.manager.surrender(harness.event("u1", "")), /已揭晓/)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("late joiners receive used hints and the host receives surface and fixed facts", async () => {
  let received
  const harness = makeHarness({hostOverrides: {answerQuestion: async input => { received = input; return "无法确定" }}})
  try {
    await reachPlaying(harness)
    await harness.store.updatePuzzle("p1", puzzle => ({...puzzle, facts: ["信箱是红色"]}))
    await harness.manager.useHint(harness.event("u1", ""))
    const catchup = await harness.manager.joinGame(harness.event("u3", ""))
    assert.match(catchup, /注意他为什么撞树/)
    assert.deepEqual(await harness.manager.handleChat(harness.event("u1", "男人喜欢下雨吗")), {reply: "无法确定"})
    assert.match(received.surface, /汤面p1/)
    assert.deepEqual(received.facts, ["信箱是红色"])
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("MVP is based on actual contributions including surrenderers and never delays reveal", async () => {
  const entered = deferred(), award = deferred()
  let brief
  const harness = makeHarness({hostOverrides: {selectMvp: async input => { brief = input.brief; entered.resolve(); return award.promise }}})
  try {
    await reachPlaying(harness)
    await harness.manager.handleChat(harness.event("u1", "男人是盲人吗"))
    await harness.manager.surrender(harness.event("u1", ""))
    const reply = await harness.manager.endGame(harness.event("u1", ""))
    assert.match(reply, /—— 汤底 ——/)
    const oldPlayId = harness.manager.getSession("100").playId
    assert.ok(harness.store.readPlays().plays[0].endedAt)
    await entered.promise
    assert.ok(brief.players.some(player => player.userId === "u1"))
    assert.equal(brief.qaLog[0].question, "男人是盲人吗")
    assert.equal(brief.solution, SOLUTION)
    await harness.manager.openGame(harness.event("u2", ""))
    award.resolve({userId: "u1", reason: "锁定关键事实"})
    await harness.manager.waitForBackgroundTasks()
    assert.equal(harness.manager.getSession("100").phase, "joining")
    assert.equal(harness.store.readPlays().plays.find(play => play.playId === oldPlayId).mvp.userId, "u1")
  } finally { award.resolve(null); await harness.manager.waitForBackgroundTasks(); fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("failed finish transaction leaves the game playable and can be retried", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    const actual = harness.manager.store.transaction.bind(harness.manager.store)
    harness.manager.store.transaction = async () => { throw new Error("disk fault") }
    await assert.rejects(harness.manager.endGame(harness.event("u1", "")), /disk fault/)
    assert.equal(harness.manager.getSession("100").phase, "playing")
    assert.equal(harness.store.readPlays().plays[0].endedAt, undefined)
    harness.manager.store.transaction = actual
    assert.match(await harness.manager.endGame(harness.event("u1", "")), /—— 汤底 ——/)
    assert.equal(harness.manager.getSession("100").phase, "reveal")
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("approving a reviewed revision retires its prior family version while preserving old ratings", async () => {
  const harness = makeHarness()
  try {
    const old = puzzleOf("old", {familyId: "story", ratingSum: 5, ratingCount: 1})
    const next = puzzleOf("next", {familyId: "story", version: 2, status: "pending"})
    next.audits = ["structure", "playability", "logic", "simulation"].map(domain => ({domain, pass: true, reason: "通过", holes: [], at: harness.getNow(), contentHash: puzzleContentHash(next)}))
    await harness.seedPuzzles([old, next])
    assert.match(await harness.manager.reviewPuzzle(harness.event("admin", ".游戏 海龟汤 过审 next", {isMaster: true}), "approve"), /已过审/)
    const puzzles = harness.store.readPuzzles().puzzles
    assert.equal(puzzles.find(puzzle => puzzle.id === "old").status, "retired")
    assert.equal(puzzles.find(puzzle => puzzle.id === "old").ratingSum, 5)
    assert.equal(puzzles.find(puzzle => puzzle.id === "next").status, "active")
    assert.match(puzzles.find(puzzle => puzzle.id === "old").statusHistory.at(-1).reason, /新版本next替代/)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("approving an old revision cannot retire a newer active family version", async () => {
  const harness = makeHarness()
  try {
    const old = puzzleOf("old", {familyId: "story", version: 1, status: "pending"})
    old.audits = ["structure", "playability", "logic", "simulation"].map(domain => ({domain, pass: true, reason: "通过", holes: [], at: harness.getNow(), contentHash: puzzleContentHash(old)}))
    const current = puzzleOf("current", {familyId: "story", version: 2})
    await harness.seedPuzzles([old, current])
    const before = harness.store.readPuzzles().puzzles
    assert.match(await harness.manager.reviewPuzzle(harness.event("admin", ".游戏 海龟汤 过审 old", {isMaster: true}), "approve"), /已有更新版本投放/)
    assert.deepEqual(harness.store.readPuzzles().puzzles, before)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("a restored legacy playing session finishes and rates its existing play with participant exposure", async () => {
  const harness = makeHarness()
  try {
    await reachPlaying(harness)
    const playId = harness.manager.getSession("100").playId
    await harness.store.transaction(state => {
      const session = state.sessions["100"]
      delete session.playId
      delete session.sessionId
      delete session.revision
      delete session.participantHistory
      const play = state.plays.find(item => item.playId === playId)
      play.players = []
      delete play.familyId
      delete play.participantHistory
    })
    const restored = new TurtleSoupManager(harness.manager.ports)
    assert.equal(restored.getSession("100").playId, playId)
    assert.match(await restored.endGame(harness.event("u1", ".游戏 海龟汤 结束")), /—— 汤底 ——/)
    assert.equal(harness.store.readPlays().plays.length, 1)
    const play = harness.store.readPlays().plays[0]
    assert.equal(play.playId, playId)
    assert.equal(play.endReason, "manual")
    assert.deepEqual(play.players, ["u1", "u2"])
    assert.match(await restored.rateGame(harness.event("u1", ".游戏 海龟汤 评分 4")), /已记录评分:4星/)
    assert.equal(harness.store.readPlays().plays[0].ratings[0].score, 4)
    await restored.openGame(harness.event("u1", "", {groupId: "200"}))
    await restored.joinGame(harness.event("u3", "", {groupId: "200"}))
    assert.match(await restored.startGame(harness.event("u1", "", {groupId: "200"})), /没有本群及当前玩家都没看过的汤/)
    assert.equal(harness.store.readPlays().plays.length, 1)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})

test("simultaneous starts cannot expose the same family to one player in two groups", async () => {
  const harness = makeHarness({configOverrides: {minPlayers: 1}})
  try {
    await harness.seedPuzzles([puzzleOf("p1")])
    await harness.manager.openGame(harness.event("u1", "", {groupId: "100"}))
    await harness.manager.openGame(harness.event("u1", "", {groupId: "200"}))
    await Promise.all([harness.manager.startGame(harness.event("u1", "", {groupId: "100"})), harness.manager.startGame(harness.event("u1", "", {groupId: "200"}))])
    assert.equal(harness.store.readPlays().plays.length, 1)
    assert.equal(harness.manager.playingGroupIds().size, 1)
  } finally { fs.rmSync(harness.dir, {recursive: true, force: true}) }
})
