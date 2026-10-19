import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {TurtleSoupStore, readTurtleSoupConfig} from "../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupStore.js"

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turtle-soup-"))
  return {dir, store: new TurtleSoupStore({cwd: dir, baseDir: "data/turtle_soup"})}
}

const now = 1_700_000_000_000
function makePuzzle(id, overrides = {}) {
  return {id, title: `标题${id}`, surface: "汤面", solution: "汤底", keyPoints: ["关键点"], hints: ["提示一"], difficulty: "normal", tags: ["推理"], source: "ai", createdAt: now, status: "active", ratingSum: 0, ratingCount: 0, ...overrides}
}

test("store starts empty and round-trips puzzles, plays and sessions", async () => {
  const {dir, store} = makeStore()
  try {
    assert.deepEqual(store.readPuzzles(), {puzzles: []})
    await store.savePuzzle(makePuzzle("p1"))
    await store.savePuzzle(makePuzzle("p2"))
    await store.savePuzzle(makePuzzle("p1", {status: "retired", ratingSum: 9, ratingCount: 2}))
    const puzzles = store.readPuzzles().puzzles
    assert.equal(puzzles.length, 2)
    assert.equal(puzzles.find(item => item.id === "p1").status, "retired")
    assert.equal(puzzles.find(item => item.id === "p1").ratingSum, 9)

    const play = {playId: "pl1", puzzleId: "p1", puzzleTitle: "标题p1", groupId: "100", startedAt: now, endedAt: now + 1, endReason: "manual", solved: false, players: ["u1"], qaCount: 3, ratings: [{userId: "u1", score: 5, comment: "好玩", at: now}]}
    await store.upsertPlay(play)
    await store.upsertPlay({...play, solved: true, winnerId: "u1"})
    assert.equal(store.readPlays().plays.length, 1)
    assert.equal(store.readPlays().plays[0].winnerId, "u1")

    const session = {groupId: "100", phase: "playing", puzzleId: "p1", initiatorId: "u1", players: [{userId: "u1", nickname: "甲", joinedAt: now}], createdAt: now, joinDeadlineAt: now, startedAt: now, lastActivityAt: now, qaLog: [], guessLog: [], usedHints: 0, lastGuessAt: {}}
    await store.saveSession(session)
    assert.equal(store.readSessions().sessions["100"].phase, "playing")
    await store.removeSession("100")
    assert.deepEqual(store.readSessions().sessions, {})
    await store.removeSession("100")

    assert.equal(fs.existsSync(path.join(dir, "plugins/shiloh-plugin/data/turtle_soup/puzzles.json")), true)
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
})

test("store rejects corrupted files instead of silently resetting data", async () => {
  const {dir, store} = makeStore()
  try {
    await store.savePuzzle(makePuzzle("p1"))
    fs.writeFileSync(path.join(store.dataDir, "puzzles.json"), "{ broken", "utf8")
    assert.throws(() => store.readPuzzles(), SyntaxError)
    fs.writeFileSync(path.join(store.dataDir, "puzzles.json"), JSON.stringify({puzzles: [{id: "p1"}]}), "utf8")
    assert.throws(() => store.readPuzzles(), /无效/)
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
})

test("readTurtleSoupConfig reads miniGames.turtleSoup with defaults and clamping", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turtle-soup-cfg-"))
  try {
    const configDir = path.join(dir, "plugins/shiloh-plugin/config_default")
    fs.mkdirSync(configDir, {recursive: true})
    let config = readTurtleSoupConfig(dir)
    assert.equal(config.enabled, true)
    assert.equal(config.minPlayers, 1)
    assert.equal(config.similarityHitThreshold, 0.9)
    assert.equal(config.similarityMissThreshold, 0)
    assert.equal(config.freshPoolTarget, 2)
    assert.equal(config.baseDir, "data/turtle_soup")

    fs.writeFileSync(path.join(configDir, "message.yaml"), [
      "pluginSettings:",
      "  miniGames:",
      "    enabled: true",
      "    turtleSoup:",
      "      enabled: true",
      "      minPlayers: 999",
      "      idleTimeoutMinutes: 3",
      "      generationModel: glm-4.7",
      "      contentPolicy: 自定义尺度"
    ].join("\n"), "utf8")
    config = readTurtleSoupConfig(dir)
    assert.equal(config.minPlayers, 50)
    assert.equal(config.idleTimeoutMinutes, 3)
    assert.equal(config.generationModel, "glm-4.7")
    assert.equal(config.contentPolicy, "自定义尺度")
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
})
