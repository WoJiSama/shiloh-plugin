import test from "node:test"
import assert from "node:assert/strict"
import {normalizeSoupText, levenshteinRatio, bigramDice, literalSoupSimilarity, classifySoupGuess, keyPointCoverage, looksLikeSolutionLeak} from "../dist/backend/modules/games/domain/turtleSoup/turtleSoupSimilarity.js"

test("normalizeSoupText strips CQ codes, punctuation, filler prefixes and tail particles", () => {
  assert.equal(normalizeSoupText("我觉得答案是：男人是盲人！"), "男人是盲人")
  assert.equal(normalizeSoupText("[CQ:at,qq=123] 我猜 他是盲人吧"), "他是盲人")
  assert.equal(normalizeSoupText("答案答案是盲人"), "盲人")
  assert.equal(normalizeSoupText("因为好像大概是因为下雨"), "下雨")
  assert.equal(normalizeSoupText("  "), "")
})

test("levenshteinRatio handles identical, single-edit and empty inputs", () => {
  assert.equal(levenshteinRatio("盲人", "盲人"), 1)
  assert.equal(levenshteinRatio("盲人", "忙人"), 0.5)
  assert.equal(levenshteinRatio("", ""), 1)
  assert.equal(levenshteinRatio("a", ""), 0)
})

test("bigramDice scores overlap and disjoint inputs", () => {
  assert.equal(bigramDice("盲人", "盲人"), 1)
  assert.equal(bigramDice("香蕉", "盲人"), 0)
  assert.ok(bigramDice("男人是盲人", "盲人是男人") > 0 && bigramDice("男人是盲人", "盲人是男人") < 1)
})

test("literalSoupSimilarity reaches 1 for paraphrased-with-filler guesses", () => {
  assert.equal(literalSoupSimilarity("我觉得答案是：男人是盲人！", "男人是盲人"), 1)
  assert.equal(literalSoupSimilarity("", "男人是盲人"), 0)
  assert.equal(literalSoupSimilarity("随便", ""), 0)
})

test("classifySoupGuess splits hit / gray / miss by thresholds", () => {
  const thresholds = {hitThreshold: 0.9, missThreshold: 0.5}
  assert.equal(classifySoupGuess("我觉得答案是：男人是盲人！", "男人是盲人", thresholds).verdict, "hit")
  const gray = classifySoupGuess("男人的身份是盲人", "男人是盲人", thresholds)
  assert.equal(gray.verdict, "gray")
  assert.ok(gray.score >= 0.5 && gray.score < 0.9)
  assert.equal(classifySoupGuess("香蕉", "男人是盲人", thresholds).verdict, "miss")
  assert.equal(classifySoupGuess("   ", "男人是盲人", thresholds).verdict, "miss")
})

test("keyPointCoverage reports matched and missing key points", () => {
  const coverage = keyPointCoverage(["盲人", "把伞当拐杖"], "他其实是盲人")
  assert.deepEqual(coverage.matched, ["盲人"])
  assert.deepEqual(coverage.missing, ["把伞当拐杖"])
})

test("looksLikeSolutionLeak flags replies that echo the solution", () => {
  assert.equal(looksLikeSolutionLeak("汤底就是：男人是盲人，看不见路", "男人是盲人"), true)
  assert.equal(looksLikeSolutionLeak("不是", "男人是盲人"), false)
})
