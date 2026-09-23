import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
  installObservabilityLog,
  readObservabilityTail,
  resetObservabilityForTest,
  getObservabilityState
} from "../utils/obsLog.js"

const sleep = ms => new Promise(r => setTimeout(r, ms))

test("tee:匹配标签的 info 落盘,不匹配/彩色前缀不落盘", async () => {
  resetObservabilityForTest()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-test-"))
  const fake = {
    info: (...args) => `orig:${args.length}`,
    calls: 0
  }
  const logger = { info: (...a) => { fake.calls += 1; return fake.info(...a) } }
  installObservabilityLog({ cwd: dir, logger })
  assert.equal(getObservabilityState().installed, true)

  const ansiPrefix = "\u001b[34m[TRSSYz]\u001b[39m"
  logger.info(ansiPrefix, "[工具调用] 第 1 轮，共 1 个工具")
  logger.info(ansiPrefix, "[模型耗时] group=g1 stage=initial elapsed=1200ms")
  logger.info(ansiPrefix, "[抖音] 浏览器解析成功 aweme=123")
  logger.info(ansiPrefix, "[普通闲聊] 这条不该落盘")
  logger.info("[无前缀直接说] 也不该落盘")

  await sleep(800)
  const lines = await readObservabilityTail(50)
  assert.equal(lines.length, 3, `应只落盘 3 条标签行,实际 ${lines.length}: ${lines.join("|")}`)
  assert.ok(lines[0].includes("[工具调用]"))
  assert.ok(lines[1].includes("[模型耗时]"))
  assert.ok(lines[2].includes("[抖音]"))
  assert.ok(!lines.some(l => l.includes("不该落盘")))
  // 原行为保持:返回值透传
  assert.ok(fake.calls >= 5)
  fs.rmSync(dir, { recursive: true, force: true })
  resetObservabilityForTest()
})

test("enabled:false 不安装,重复安装幂等", async () => {
  resetObservabilityForTest()
  const logger = { info: () => {} }
  const r1 = installObservabilityLog({ enabled: false, logger })
  assert.equal(r1.installed, false)
  assert.equal(logger.infoCalls, undefined)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-test2-"))
  installObservabilityLog({ cwd: dir, logger })
  const wrapped = logger.info
  installObservabilityLog({ cwd: dir, logger })
  assert.equal(logger.info, wrapped, "二次安装不重复包装")
  fs.rmSync(dir, { recursive: true, force: true })
  resetObservabilityForTest()
})
