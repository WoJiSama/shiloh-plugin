import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { shouldSkipIntentModel, shouldSampleSkippedIntent } from "../utils/intentFastPath.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("plain casual chatter skips the intent model", () => {
  assert.equal(shouldSkipIntentModel({ text: "哈哈哈今天好累哦" }), true)
  assert.equal(shouldSkipIntentModel({ text: "刚吃完饭，好撑" }), true)
})

test("any tool signal keeps the classifier in the path", () => {
  assert.equal(shouldSkipIntentModel({ text: "帮我画一张猫猫的图" }), false, "显式工具意图")
  assert.equal(shouldSkipIntentModel({ text: "帮我搜一下今天的新闻" }), false, "显式搜索")
  assert.equal(shouldSkipIntentModel({ text: "现在几点了" }), false, "实时信息")
  assert.equal(shouldSkipIntentModel({ text: "随便聊聊", toolCandidates: ["searchInformationTool"] }), false, "正则工具候选")
  assert.equal(shouldSkipIntentModel({ text: "看看这张图", hasImages: true }), false, "带图")
  assert.equal(shouldSkipIntentModel({ text: "看看这个视频", hasVideos: true }), false, "带视频")
})

test("non-casual text keeps the classifier in the path", () => {
  assert.equal(shouldSkipIntentModel({ text: "为什么天空是蓝色的" }), false, "疑问句")
  assert.equal(shouldSkipIntentModel({ text: "这个报错是怎么回事啊，我配置了好久都没搞定，一直红灯" }), false, "超长文本")
  assert.equal(shouldSkipIntentModel({ text: "" }), false, "空文本走原逻辑")
})

test("skipped turns sample shadow verification at a bounded rate", () => {
  assert.equal(shouldSampleSkippedIntent(0), false, "0% 永不抽样")
  assert.equal(shouldSampleSkippedIntent(1), true, "100% 必抽样")
  assert.equal(shouldSampleSkippedIntent("not-a-number"), false, "非法值按 0 处理不抛错")
  let hits = 0
  for (let i = 0; i < 2000; i++) if (shouldSampleSkippedIntent(0.1)) hits++
  assert.ok(hits > 100 && hits < 300, `2000 次按 10% 抽样应约 200 次，实际 ${hits}`)
})

test("handleTool wires the fast path with shadow sampling", () => {
  const src = fs.readFileSync(path.join(root, "apps/test.js"), "utf8")
  assert.ok(src.includes("const skipIntentModel = shouldSkipIntentModel({"), "快路判定接入")
  assert.ok(src.includes('turnTrace.setIntent("chat", null, "fast_path_skip")'), "快路来源写入 trace")
  // P4 已转正：影子抽样验证随之移除，快路跳过不再并行跑模型
  assert.ok(!src.includes("shouldSampleSkippedIntent"), "影子抽样已随转正移除")
  assert.ok(!src.includes("runShadowIntent"), "不再有并行影子意图调用")
  // 闲聊快路径的层计算裁剪
  assert.ok(src.includes("const chatFastPath = session.promptLayerProfile?.profile === \"chat\""), "层计算按画像裁剪")
  assert.ok(src.includes("this.knowledgeSearcher && e.msg && !chatFastPath"), "知识库检索跳过")
  assert.ok(src.includes("chatFastPath\n          ? null\n          : globalStyleLearnerManager.buildRelevantPrompt"), "语义风格检索跳过")
})
