import test from "node:test"
import assert from "node:assert/strict"
import {joiningOutcome, canManualStart, playingTimedOut, revealTimedOut, joinSession, isParticipant, guessCooldownRemainingMs, takeHint, selectPuzzleId, freshPuzzleIds, puzzlePlayStats, upsertRating, shouldRetirePuzzle, ratingAverage, buildMvpBrief, soupCandidatesFor} from "../dist/backend/modules/games/domain/turtleSoup/turtleSoupRules.js"

const now = 1_700_000_000_000
function makeSession(overrides = {}) {
  return {
    groupId: "100",
    phase: "joining",
    puzzleId: "",
    initiatorId: "u1",
    players: [],
    createdAt: now,
    joinDeadlineAt: now + 300_000,
    lastActivityAt: now,
    qaLog: [],
    guessLog: [],
    usedHints: 0,
    lastGuessAt: {},
    ...overrides
  }
}
function makePuzzle(id, overrides = {}) {
  return {id, title: `标题${id}`, surface: "汤面", solution: "汤底", keyPoints: [], hints: ["提示一", "提示二"], difficulty: "normal", tags: [], source: "ai", createdAt: now, status: "active", ratingSum: 0, ratingCount: 0, ...overrides}
}
function makePlay(puzzleId, groupId, overrides = {}) {
  return {playId: `pl_${puzzleId}_${groupId}`, puzzleId, puzzleTitle: "标题", groupId, startedAt: now, endedAt: now + 1000, endReason: "manual", solved: false, players: ["u1"], qaCount: 0, ratings: [], ...overrides}
}

test("joiningOutcome waits before deadline, starts or cancels after it", () => {
  const empty = makeSession()
  assert.equal(joiningOutcome(empty, now + 60_000, 2), "wait")
  assert.equal(joiningOutcome(empty, now + 300_001, 2), "cancel")
  const joined = makeSession({players: [{userId: "u1", nickname: "甲", joinedAt: now}, {userId: "u2", nickname: "乙", joinedAt: now}]})
  assert.equal(joiningOutcome(joined, now + 300_001, 2), "start")
  const solo = makeSession({players: [{userId: "u1", nickname: "甲", joinedAt: now}]})
  assert.equal(joiningOutcome(solo, now + 300_001, 2), "cancel")
})

test("canManualStart requires joining phase and enough players", () => {
  const session = makeSession({players: [{userId: "u1", nickname: "甲", joinedAt: now}]})
  assert.equal(canManualStart(session, 2), false)
  session.players.push({userId: "u2", nickname: "乙", joinedAt: now})
  assert.equal(canManualStart(session, 2), true)
  assert.equal(canManualStart(makeSession({phase: "playing", players: session.players}), 2), false)
})

test("playing/reveal timeouts are judged from injected clocks", () => {
  const playing = makeSession({phase: "playing", startedAt: now, lastActivityAt: now})
  assert.equal(playingTimedOut(playing, now + 299_999, 300_000), false)
  assert.equal(playingTimedOut(playing, now + 300_000, 300_000), true)
  assert.equal(playingTimedOut(makeSession({phase: "joining"}), now + 400_000, 300_000), false)
  const reveal = makeSession({phase: "reveal", reveal: {at: now, ratingDeadlineAt: now + 300_000}})
  assert.equal(revealTimedOut(reveal, now + 299_999), false)
  assert.equal(revealTimedOut(reveal, now + 300_000), true)
})

test("joinSession accepts joining and playing, rejects duplicates and reveal phase", () => {
  const session = makeSession()
  const first = joinSession(session, {userId: "u1", nickname: "甲", nowMs: now + 1000})
  assert.equal(first.status, "joined")
  assert.equal(joinSession(session, {userId: "u1", nickname: "甲", nowMs: now + 2000}).status, "already")
  assert.equal(session.lastActivityAt, now + 1000)
  const playing = makeSession({phase: "playing", startedAt: now})
  assert.equal(joinSession(playing, {userId: "u2", nickname: "乙", nowMs: now}).status, "joined")
  const revealing = makeSession({phase: "reveal", reveal: {at: now, ratingDeadlineAt: now}})
  assert.equal(joinSession(revealing, {userId: "u3", nickname: "丙", nowMs: now}).status, "phase_rejected")
  assert.equal(isParticipant(session, "u1"), true)
  assert.equal(isParticipant(session, "u9"), false)
})

test("guessCooldownRemainingMs tracks per-player cooldown windows", () => {
  const session = makeSession({phase: "playing", startedAt: now, lastGuessAt: {u1: now}})
  assert.equal(guessCooldownRemainingMs(session, "u1", now + 10_000, 30_000), 20_000)
  assert.equal(guessCooldownRemainingMs(session, "u1", now + 30_000, 30_000), 0)
  assert.equal(guessCooldownRemainingMs(session, "u2", now, 30_000), 0)
})

test("takeHint consumes quota in order and stops when exhausted", () => {
  const session = makeSession({phase: "playing", startedAt: now})
  assert.equal(takeHint(session, ["提示一", "提示二"], 3), "提示一")
  assert.equal(takeHint(session, ["提示一", "提示二"], 3), "提示二")
  assert.equal(takeHint(session, ["提示一", "提示二"], 3), null)
  assert.equal(takeHint(makeSession({phase: "reveal"}), ["提示一"], 3), null)
})

test("selectPuzzleId prefers fresh puzzles, never replays for the same group", () => {
  const p1 = makePuzzle("p1"), p2 = makePuzzle("p2"), p3 = makePuzzle("p3", {status: "retired"})
  const plays = [makePlay("p1", "200"), makePlay("p1", "300")]
  assert.equal(selectPuzzleId([p1, p2, p3], plays, "100", () => 0), "p2")
  assert.equal(selectPuzzleId([p1, p2, p3], plays, "200", () => 0), "p2")
  assert.deepEqual(freshPuzzleIds([p1, p2, p3], puzzlePlayStats(plays)).sort(), ["p2"])
  const allPlayed = [makePlay("p1", "100"), makePlay("p2", "100")]
  assert.equal(selectPuzzleId([p1, p2], allPlayed, "100", () => 0), null)
  assert.equal(selectPuzzleId([p1, p2, p3], allPlayed, "100", () => 0), null)
})

test("selectPuzzleId falls back to the least-played puzzle not played here", () => {
  const p1 = makePuzzle("p1"), p2 = makePuzzle("p2"), p3 = makePuzzle("p3")
  const plays = [makePlay("p1", "200"), makePlay("p1", "300"), makePlay("p1", "400"), makePlay("p2", "200"), makePlay("p3", "200"), makePlay("p3", "300")]
  assert.equal(selectPuzzleId([p1, p2, p3], plays, "100", () => 0), "p2")
})

test("upsertRating enforces participants, score range and finished plays", () => {
  const puzzle = makePuzzle("p1")
  const play = makePlay("p1", "100", {players: ["u1", "u2"], endedAt: now})
  assert.throws(() => upsertRating(play, puzzle, {userId: "u9", score: 5, atMs: now}), /参与者/)
  assert.throws(() => upsertRating(play, puzzle, {userId: "u1", score: 0, atMs: now}), /1-5/)
  assert.throws(() => upsertRating({...play, endedAt: undefined}, puzzle, {userId: "u1", score: 5, atMs: now}), /尚未结束/)
  const first = upsertRating(play, puzzle, {userId: "u1", score: 5, atMs: now})
  assert.equal(first.puzzle.ratingSum, 5)
  assert.equal(first.puzzle.ratingCount, 1)
  const second = upsertRating(first.play, first.puzzle, {userId: "u1", score: 3, atMs: now + 1})
  assert.equal(second.puzzle.ratingSum, 3)
  assert.equal(second.puzzle.ratingCount, 1)
  assert.equal(second.play.ratings.length, 1)
})

test("shouldRetirePuzzle retires only low-rated puzzles with enough votes", () => {
  assert.equal(shouldRetirePuzzle(makePuzzle("p1", {ratingSum: 6, ratingCount: 3})), true)
  assert.equal(shouldRetirePuzzle(makePuzzle("p1", {ratingSum: 9, ratingCount: 3})), false)
  assert.equal(shouldRetirePuzzle(makePuzzle("p1", {ratingSum: 1, ratingCount: 2})), false)
  assert.equal(shouldRetirePuzzle(makePuzzle("p1", {ratingSum: 0, ratingCount: 0})), false)
  assert.equal(ratingAverage(makePuzzle("p1", {ratingSum: 0, ratingCount: 0})), null)
})

test("buildMvpBrief aggregates questions, yes answers and closest guesses per player", () => {
  const session = makeSession({
    phase: "playing", startedAt: now,
    players: [{userId: "u1", nickname: "甲", joinedAt: now}, {userId: "u2", nickname: "乙", joinedAt: now}],
    qaLog: [
      {userId: "u1", question: "他是盲人吗", answer: "是", at: now},
      {userId: "u1", question: "他有钱吗", answer: "不是", at: now},
      {userId: "u2", question: "下雨了吗", answer: "是", at: now}
    ],
    guessLog: [
      {userId: "u2", guess: "瞎子", literalScore: 0.2, final: "miss", at: now},
      {userId: "u2", guess: "盲人走路", literalScore: 0.5, final: "miss", at: now},
      {userId: "u1", guess: "香蕉", literalScore: 0, final: "miss", at: now}
    ]
  })
  const brief = buildMvpBrief(session, "u2")
  const byUser = new Map(brief.players.map(player => [player.userId, player]))
  assert.equal(byUser.get("u1").questions, 2)
  assert.equal(byUser.get("u1").yesAnswers, 1)
  assert.equal(byUser.get("u2").closestGuess.score, 0.5)
  assert.equal(brief.winnerId, "u2")
  assert.equal(brief.totalQuestions, 3)
  assert.equal(brief.totalGuesses, 3)
})

test("选题按参与人跨群排除：A群玩过的汤,含其参与者的新群不再随机到", () => {
  const p1 = {id: "p1", status: "active", title: "t1", difficulty: "easy", tags: [], surface: "", solution: "", keyPoints: [], ratingSum: 0, ratingCount: 0}
  const p2 = {id: "p2", status: "active", title: "t2", difficulty: "easy", tags: [], surface: "", solution: "", keyPoints: [], ratingSum: 0, ratingCount: 0}
  // u1 在 B 群玩过 p1
  const plays = [{playId: "x", puzzleId: "p1", puzzleTitle: "t1", groupId: "200", startedAt: 1, solved: false, players: ["u1"], qaCount: 0, ratings: []}]
  const stats = puzzlePlayStats(plays)
  assert.equal(stats.get("p1").users.has("u1"), true, "stats 记录参与人")
  // A 群新局,u1 参与 → strict 排除 p1
  const forA = soupCandidatesFor([p1, p2], stats, "100", ["u1"])
  assert.deepEqual(forA.strict.map(p => p.id), ["p2"])
  // 没有交集参与者的群不受影响
  const forC = soupCandidatesFor([p1, p2], stats, "300", ["u9"])
  assert.deepEqual(forC.strict.map(p => p.id), ["p1", "p2"])
  // 全被排除时退回按群排除,仍能开局
  const only = soupCandidatesFor([p1], stats, "100", ["u1"])
  assert.deepEqual(only.strict, [])
  assert.deepEqual(only.groupOnly.map(p => p.id), ["p1"])
  assert.equal(selectPuzzleId([p1], plays, "100", () => 0, ["u1"]), "p1", "退回兜底")
  assert.equal(selectPuzzleId([p1, p2], plays, "100", () => 0, ["u1"]), "p2")
})


test("纯表情/符号不算提问,带文字的表情照常放行", async () => {
  const { looksLikeSoupQuestion } = await import("../dist/backend/modules/games/domain/turtleSoup/turtleSoupRules.js")
  assert.equal(looksLikeSoupQuestion("🤔"), false, "纯 emoji 拦截")
  assert.equal(looksLikeSoupQuestion("？？"), false, "纯问号拦截")
  assert.equal(looksLikeSoupQuestion("😀🤔😅"), false, "多 emoji 拦截")
  assert.equal(looksLikeSoupQuestion("男人犯法了吗🤔"), true, "文字+表情放行")
  assert.equal(looksLikeSoupQuestion("妻子受伤了吗？🤔"), true, "文字+问号+表情放行")
})
