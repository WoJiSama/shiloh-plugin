import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import os from "os"
import path from "path"
import sharp from "sharp"
import { EmojiPackManager } from "../dist/backend/modules/emoji/infrastructure/EmojiPackManager.js"

// 双维审核：同一次 VLM 调用输出 is_emoji + safe + confidence，任一不过或低置信拒收
function verdictJson(fields) {
  return JSON.stringify({ choices: [{ message: { content: JSON.stringify(fields) } }] })
}

async function createManager(verdictBody, options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emoji-dual-"))
  const fetchCalls = []
  const manager = new EmojiPackManager({
    fetch: async (url, init) => {
      fetchCalls.push({ url, body: JSON.parse(String(init?.body || "{}")) })
      return {
        ok: true,
        json: async () => JSON.parse(verdictBody)
      }
    },
    logger: { info() {}, warn() {}, error() {} }
  })
  manager.config = {
    ...manager.config,
    dbPath: path.join(tmp, "emoji.ndjson"),
    storeDir: path.join(tmp, "emoji_files"),
    contentFiltration: true,
    contentSafetyFilter: options.contentSafetyFilter !== false,
    contentFilterMinConfidence: options.minConfidence ?? 0.75,
    visionTagOnAdd: false,
    useEmbedding: false,
    maxItems: 50,
    doReplace: false
  }
  manager.analysisAiConfig = {
    analysisApiUrl: "https://api.example.com/v1",
    analysisApiKey: "test-key",
    analysisApiModel: "test-vlm"
  }
  return { manager, fetchCalls, tmp }
}

async function testImageBuffer() {
  // 随机噪点图：确保压不出纯色那种超小文件，能通过 ≥1KB 的物理预检查
  const width = 300, height = 300
  const raw = Buffer.alloc(width * height * 3)
  for (let index = 0; index < raw.length; index++) raw[index] = Math.floor(Math.random() * 256)
  return await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 80 }).toBuffer()
}

test("双维审核通过：is_emoji + safe + 高置信 → 入库", async () => {
  const { manager, fetchCalls, tmp } = await createManager(verdictJson({ is_emoji: true, safe: true, confidence: 0.9, reason: "典型梗图" }))
  const result = await manager.addFromBuffer(await testImageBuffer(), { autoTag: false, autoEmbed: false })
  assert.equal(result.added, true)
  assert.equal(fetchCalls.length, 1, "只调用一次 VLM，不额外消耗")
  const prompt = fetchCalls[0].body.messages[0].content[0].text
  assert.ok(prompt.includes("判定一"), "prompt 含表情包判定")
  assert.ok(prompt.includes("判定二"), "prompt 含内容安全判定")
  assert.ok(prompt.includes("confidence"), "prompt 要求置信度")
  assert.ok(prompt.includes("辱骂"), "prompt 覆盖图内辱骂文字")
  fs.rmSync(tmp, { recursive: true, force: true })
})

test("安全不通过：低俗/政治内容拒收并给出来由", async () => {
  const { manager, tmp } = await createManager(verdictJson({ is_emoji: true, safe: false, confidence: 0.95, reason: "图内文字含辱骂" }))
  const result = await manager.addFromBuffer(await testImageBuffer(), { autoTag: false, autoEmbed: false })
  assert.equal(result.added, false)
  assert.equal(result.reason, "content_unsafe")
  assert.equal(result.filterReason, "图内文字含辱骂")
  fs.rmSync(tmp, { recursive: true, force: true })
})

test("非表情包拒收保持原有行为", async () => {
  const { manager, tmp } = await createManager(verdictJson({ is_emoji: false, safe: true, confidence: 0.9, reason: "普通宠物照" }))
  const result = await manager.addFromBuffer(await testImageBuffer(), { autoTag: false, autoEmbed: false })
  assert.equal(result.added, false)
  assert.equal(result.reason, "content_filtered")
  fs.rmSync(tmp, { recursive: true, force: true })
})

test("低置信度拒收：拿不准的一律不收", async () => {
  const { manager, tmp } = await createManager(verdictJson({ is_emoji: true, safe: true, confidence: 0.6, reason: "画风边缘" }))
  const result = await manager.addFromBuffer(await testImageBuffer(), { autoTag: false, autoEmbed: false })
  assert.equal(result.added, false)
  assert.equal(result.reason, "content_low_confidence")
  assert.equal(result.confidence, 0.6)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test("fail-closed：模型漏掉 safe/confidence 字段按不通过处理", async () => {
  const { manager, tmp } = await createManager(verdictJson({ is_emoji: true, reason: "旧格式回复" }))
  const result = await manager.addFromBuffer(await testImageBuffer(), { autoTag: false, autoEmbed: false })
  assert.equal(result.added, false)
  assert.equal(result.reason, "content_unsafe", "safe 缺失视为不安全，宁可漏收")
  fs.rmSync(tmp, { recursive: true, force: true })
})

test("关闭安全维度后只判是否表情包", async () => {
  const { manager, tmp } = await createManager(
    verdictJson({ is_emoji: true, safe: false, confidence: 0.9, reason: "边缘梗图" }),
    { contentSafetyFilter: false }
  )
  const result = await manager.addFromBuffer(await testImageBuffer(), { autoTag: false, autoEmbed: false })
  assert.equal(result.added, true, "safe=false 但安全维度已关闭，放行")
  fs.rmSync(tmp, { recursive: true, force: true })
})

test("置信度阈值可调：0.5 阈值下 0.6 通过", async () => {
  const { manager, tmp } = await createManager(
    verdictJson({ is_emoji: true, safe: true, confidence: 0.6, reason: "还行" }),
    { minConfidence: 0.5 }
  )
  const result = await manager.addFromBuffer(await testImageBuffer(), { autoTag: false, autoEmbed: false })
  assert.equal(result.added, true)
  fs.rmSync(tmp, { recursive: true, force: true })
})
