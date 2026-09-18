import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  LONG_TASK_FEEDBACK_POLICIES,
  classifyLongTaskFeedback,
  resolveLongTaskFeedbackPolicy,
  sendLongTaskOpening
} from "../utils/longTaskFeedbackPolicy.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("classifies long task kinds by message text", () => {
  assert.equal(classifyLongTaskFeedback("帮我画一张猫猫的图"), "image_generate")
  assert.equal(classifyLongTaskFeedback("帮我修一下这张图"), "image_edit")
  assert.equal(classifyLongTaskFeedback("看看这张图里是什么"), "image_analysis")
  assert.equal(classifyLongTaskFeedback("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=test"), "media_link")
  assert.equal(classifyLongTaskFeedback("https://www.bilibili.com/video/BV1abc123"), "media_link")
  assert.equal(classifyLongTaskFeedback("https://b23.tv/abc123"), "media_link")
  assert.equal(classifyLongTaskFeedback("https://example.com/post/123"), "web")
  assert.equal(classifyLongTaskFeedback("www.example.com/post/123"), "web")
  assert.equal(classifyLongTaskFeedback("今天天气真不错"), null)
  assert.equal(classifyLongTaskFeedback(""), null)
})

test("video and magnet links are media_link, not generic web", () => {
  // 磁链/B站/抖音必须先于通用网页判定，否则会被 web 规则吃掉拿错开场策略
  assert.notEqual(classifyLongTaskFeedback("https://www.bilibili.com/video/BV1abc123"), "web")
})

test("image analysis and plain web links now release the smart lock", () => {
  // 修复点：识图（同步视觉调用）和普通网页（puppeteer 30s+）此前都不释放 smart 锁，
  // 任务跑的整段时间该群其他触发全部排队
  assert.equal(resolveLongTaskFeedbackPolicy("看看这张图里是什么")?.releaseSmartLock, true)
  assert.equal(resolveLongTaskFeedbackPolicy("https://example.com/post/123")?.releaseSmartLock, true)
  assert.equal(resolveLongTaskFeedbackPolicy("帮我画一张猫猫的图")?.releaseSmartLock, true)
  assert.equal(resolveLongTaskFeedbackPolicy("今天天气真不错")?.releaseSmartLock, undefined)
})

test("only the silent web path carries a local opening", () => {
  assert.equal(LONG_TASK_FEEDBACK_POLICIES.web.openingMode, "local")
  assert.ok(LONG_TASK_FEEDBACK_POLICIES.web.openingText)
  for (const kind of ["image_generate", "image_edit", "image_analysis", "media_link"]) {
    assert.equal(LONG_TASK_FEEDBACK_POLICIES[kind].openingMode, "tool", `${kind} 开场仍由工具自己负责`)
  }
})

test("local opening sends once per event and never blocks the task", async () => {
  const replies = []
  const e = { reply: async text => { replies.push(text) } }
  const sent = await sendLongTaskOpening(e, "web")
  assert.equal(sent, LONG_TASK_FEEDBACK_POLICIES.web.openingText)
  await sendLongTaskOpening(e, "web")
  assert.deepEqual(replies, [LONG_TASK_FEEDBACK_POLICIES.web.openingText])

  // openingMode=tool 的类型不发本地开场
  assert.equal(await sendLongTaskOpening(e, "image_generate"), "")
  assert.equal(replies.length, 1)

  // 发送失败必须吞掉，不中断工具执行
  const broken = { reply: async () => { throw new Error("send failed") } }
  await assert.doesNotReject(() => sendLongTaskOpening(broken, "web"))
})

test("smart lock release path consumes the policy table", () => {
  const testJs = fs.readFileSync(path.join(root, "apps/test.js"), "utf8")
  assert.ok(
    testJs.includes("const longTaskPolicy = resolveLongTaskFeedbackPolicy(String(e?.msg || \"\"))"),
    "release call site must resolve policy (and log task kind)"
  )
  assert.ok(
    testJs.includes("resolveLongTaskFeedbackPolicy(String(e?.msg || \"\"))?.releaseSmartLock === true"),
    "shouldReleaseSmartLockForLongTask must delegate to the policy table"
  )
  assert.ok(!testJs.includes("isLongRunningTaskLinkRequest(text)"), "old inline predicate chain should be gone")
})

test("web parser sends the local opening before fetching", () => {
  const source = fs.readFileSync(path.join(root, "functions/functions_tools/webParserTool.js"), "utf8")
  assert.ok(
    source.includes("await sendLongTaskOpening(e, 'web')"),
    "webParserTool must send the policy opening after URL validation"
  )
})
