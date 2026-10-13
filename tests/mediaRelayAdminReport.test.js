import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  buildFailureRows,
  buildHealthReportView,
  extractEventFailures,
  extractRelayFailures,
  extractSendFailures,
  parseLoginState,
  healthReportImageMessage,
  renderHealthReportCard
} from "../utils/messagePipeline/mediaRelayAdminReport.js"

const NOW = new Date("2026-10-10T15:00:00+08:00").getTime()
const HOUR = 60 * 60 * 1000

function delivery(overrides = {}) {
  return {
    id: "v1:bilibili:bot:100:1",
    platform: "bilibili",
    groupId: "100",
    botId: "1",
    state: "sent",
    updatedAt: NOW - HOUR,
    timings: { total: 12000 },
    media: { title: "测试视频" },
    lastError: "",
    ...overrides
  }
}

function eventJob(overrides = {}) {
  return {
    id: "v1:bot:message:group:100:1",
    envelope: { eventId: "e1", groupId: "100" },
    state: "pending",
    updatedAt: NOW - HOUR,
    lastError: "",
    ...overrides
  }
}

test("登录态按最后命中的日志特征判定", () => {
  assert.equal(parseLoginState("二维码已保存到 /app/napcat/cache/qrcode.png\n发送 -> abc"), "已登录")
  assert.equal(parseLoginState("发送 -> abc\n[Core] [Login] Login Error,ErrType:  1  ErrCode: 3"), "掉线")
  assert.equal(parseLoginState("随便的日志"), "未知")
  assert.equal(parseLoginState(""), "未知")
})

test("搬运失败提取只要最终失败，成功与重试中都不进清单", () => {
  const failures = extractRelayFailures(
    [
      delivery({ state: "sent" }),
      delivery({ id: "r1", state: "retry_wait", lastError: "还在重试" }),
      delivery({ id: "f1", state: "failed", lastError: "B站播放接口要求登录后才能提供资源" }),
      delivery({ id: "f2", platform: "douyin", groupId: "200", state: "failed", lastError: "分享页解析失败", uncertain: true })
    ],
    { now: NOW }
  )
  assert.equal(failures.length, 2)
  assert.equal(failures[0].source, "搬运")
  assert.equal(failures[0].location, "群100")
  assert.match(failures[0].detail, /B站：.*要求登录/)
  assert.equal(failures[0].uncertain, false)
  assert.equal(failures[1].uncertain, true)
})

test("搬运失败窗口外与超上限的被丢弃", () => {
  const old = delivery({ id: "old", state: "failed", lastError: "旧失败", updatedAt: NOW - 30 * HOUR })
  const many = Array.from({ length: 12 }, (_, index) =>
    delivery({ id: `f${index}`, state: "failed", lastError: `失败${index}`, updatedAt: NOW - index * 60000 }))
  const failures = extractRelayFailures([old, ...many], { now: NOW })
  assert.equal(failures.length, 10)
  assert.ok(!failures.some(item => item.detail.includes("旧失败")))
})

test("事件失败按窗口提取并带上群号", () => {
  const failures = extractEventFailures(
    [
      eventJob({ state: "failed", lastError: "archive: NDJSON 写入失败" }),
      eventJob({ id: "e2", envelope: { eventId: "e2", groupId: "200" }, state: "failed", lastError: "media: 元数据刷新失败", updatedAt: NOW - 2 * HOUR }),
      eventJob({ id: "ok", state: "completed" }),
      eventJob({ id: "old", state: "failed", lastError: "旧失败", updatedAt: NOW - 30 * HOUR })
    ],
    { now: NOW }
  )
  assert.equal(failures.length, 2)
  assert.equal(failures[0].source, "事件")
  assert.equal(failures[0].location, "群100")
  assert.match(failures[0].detail, /NDJSON 写入失败/)
})

test("发送失败按错误码聚合排序并取前几名", () => {
  const rows = extractSendFailures({
    "2086656280": { failCodes: { "send_api_error": 3, "missing_bot:123": 1 } },
    "3492690171": { failCodes: { "media_forward:send_api_error": 7 } },
    "999": { failCodes: {}, fail: 5 }
  })
  assert.deepEqual(rows.map(row => `${row.code}:${row.count}`), [
    "media_forward:send_api_error:7",
    "send_api_error:3",
    "missing_bot:123:1"
  ])
  assert.equal(extractSendFailures({}).length, 0)
})

test("三类失败合并为统一展示行", () => {
  const rows = buildFailureRows({
    relayFailures: [{ source: "搬运", location: "群1", detail: "下载失败", uncertain: true }],
    eventFailures: [{ source: "事件", location: "群2", detail: "归档失败", uncertain: false }],
    sendFailures: [{ botId: "2086656280", code: "send_api_error", count: 4 }],
    nicknameOf: botId => (botId === "2086656280" ? "希洛" : "")
  })
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map(row => row.source), ["搬运", "事件", "发送"])
  assert.equal(rows[2].location, "希洛 · QQ 2086656280")
  assert.match(rows[2].detail, /消息发送接口失败 ×4（今日）/)
})

test("卡面视图包含机器人行与失败汇总行，且值已转义", () => {
  const view = buildHealthReportView({
    now: NOW,
    windowStart: NOW - 24 * HOUR,
    bots: [
      { account: "2086656280", nickname: "希洛<script>", loginState: "已登录", memory: "358MiB/2.00GiB" },
      { account: "3492690171", nickname: "（未连接）", loginState: "掉线", memory: "" }
    ],
    statsByBot: { "2086656280": { recv: 1234, send: 987, fail: 12 } },
    failures: [
      { source: "搬运", location: "群100", detail: "下载失败<b>", uncertain: true },
      { source: "发送", location: "希洛", detail: "send_api_error ×4（今日）", uncertain: false }
    ]
  })
  assert.match(view.botsHtml, /2086656280/)
  assert.match(view.botsHtml, /希洛&lt;script&gt;/)
  assert.match(view.botsHtml, /state-pill state-ok">已登录/)
  assert.match(view.botsHtml, /state-pill state-bad">掉线/)
  assert.match(view.botsHtml, /今日收信<\/span><strong>1,234/ )
  assert.match(view.botsHtml, /今日发送<\/span><strong>987/)
  assert.equal(view.onlineCount, 1)
  assert.equal(view.attentionCount, 1)
  assert.equal(view.recvTotal, "1,234")
  assert.equal(view.statusLabel, "有失败需要排查")
  assert.match(view.failuresHtml, /class="source">搬运/)
  assert.doesNotMatch(view.failuresHtml, /class="source">发送/)
  assert.match(view.sendAggregatesHtml, /不重复计为任务故障/)
  assert.equal(view.failureCount, 1)
  assert.match(view.failuresHtml, /下载失败&lt;b&gt;/)
  assert.match(view.failuresHtml, /结果不确定/)
  assert.match(view.statsLabel, /今日累计/)
  assert.equal(view.healthErrorHtml, "")
})

test("无失败时卡面展示空状态，采集异常时有提示行", () => {
  const view = buildHealthReportView({ now: NOW, bots: [], statsByBot: {}, failures: [] })
  assert.match(view.failuresHtml, /未发现失败记录/)
  assert.match(view.botsHtml, /未采集到机器人容器/)

  const errored = buildHealthReportView({ now: NOW, bots: [], statsByBot: {}, failures: [], healthError: "docker not found" })
  assert.match(errored.healthErrorHtml, /容器状态采集不可用/)
})

test("统计不可用、未登录与连接不完整不会被报告为健康正常", () => {
  const bot = { account: "100001", nickname: "昵称未获取", loginState: "已登录", connected: false }
  const disconnected = buildHealthReportView({ bots: [bot] })
  assert.equal(disconnected.onlineCount, 0)
  assert.equal(disconnected.attentionCount, 1)
  assert.match(disconnected.botsHtml, /服务未连接/)
  const unavailable = buildHealthReportView({ bots: [bot], statsError: "redis unavailable" })
  assert.equal(unavailable.recvTotal, "—")
  assert.match(unavailable.failuresHtml, /暂时无法确认/)
  assert.doesNotMatch(unavailable.failuresHtml, /今日发送无失败/)
  assert.equal(unavailable.statusLabel, "部分数据待确认")
  const missingCodes = buildHealthReportView({ bots: [], statsByBot: { "100001": { fail: 2 } } })
  assert.match(missingCodes.failuresHtml, /今日发送失败 2 次/)
  assert.equal(missingCodes.statusTone, "danger")
})

test("failure locations retain names and full IDs together", () => {
  const rows = buildFailureRows({ relayFailures: extractRelayFailures([delivery({ state: "failed" })], { now: NOW }), groupNameOf: () => "桌游交流" })
  assert.equal(rows[0].location, "桌游交流 · 群 100")
})

test("rendered bytes, typed arrays, image segments and files produce NapCat-readable base64", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "health-image-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9zQAAAAASUVORK5CYII=", "base64")
  const file = path.join(directory, "image.png")
  fs.writeFileSync(file, bytes)
  const image = `base64://${bytes.toString("base64")}`
  for (const value of [bytes, new Uint8Array(bytes), { type: "image", data: { file: bytes } }, { type: "image", file: image }, file, `data:image/png;base64,${bytes.toString("base64")}`]) {
    assert.deepEqual(await healthReportImageMessage(value), [{ type: "image", data: { file: image } }])
  }
  assert.equal(await healthReportImageMessage(false), null)
  assert.equal(await healthReportImageMessage(Buffer.alloc(0)), null)
  let renderedData
  const message = await renderHealthReportCard(buildHealthReportView(), { render: async (name, data) => {
    assert.equal(name, "healthReport")
    renderedData = data
    return new Uint8Array(bytes)
  } })
  assert.equal(fs.existsSync(renderedData.tplFile), true)
  assert.equal(renderedData.imgType, "png")
  assert.equal(message[0].data.file, image)
  await assert.rejects(renderHealthReportCard({}, { render: async () => false }), /未返回可用图片/)
})


test("资源失败用明确说明，降级记录保留时间且不增加失败详情数", () => {
  const rows = buildFailureRows({ relayFailures: extractRelayFailures([
    delivery({ state: "failed", lastError: "上传转发消息资源失败:1/2" }),
    delivery({ id: "fallback", state: "sent", fallbackStatus: "link_sent", fallbackReason: "video_thumbnail_missing" })
  ], { now: NOW }), sendFailures: [{ botId: "1", code: "send_api_error", count: 1 }] })
  const view = buildHealthReportView({ now: NOW, failures: rows, statsByBot: { "1": { fail: 1 } } })
  assert.equal(view.failureCount, 1)
  assert.equal(view.degradedCount, 1)
  assert.match(view.failuresHtml, /转发中的图片或视频资源上传失败/)
  assert.match(view.failuresHtml, /视频封面文件缺失/)
  assert.match(view.failuresHtml, /已降级发送/)
  assert.match(view.failuresHtml, /已发送原视频链接/)
  assert.match(view.failuresHtml, /10\/10/)
  assert.match(view.sendAggregatesHtml, /消息发送接口失败 ×1/)
})
