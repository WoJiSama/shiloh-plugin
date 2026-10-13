import assert from "node:assert/strict"
import { test } from "node:test"
import {
  censorOutbound,
  compileWordList,
  installOutboundThrottle,
  readRiskControlConfig
} from "../utils/messagePipeline/outboundThrottle.js"
import { createRiskSignalMonitor, matchRiskResponse } from "../utils/messagePipeline/riskSignalMonitor.js"

const REPLACE_CFG = { censorMark: "*", censorReplaceWords: ["秘密", "/\\d{4}年/"], censorBlockWords: [] }

test("词表编译:普通词小写化,正则识别,非法正则回落普通词", () => {
  const compiled = compileWordList(["敏感", "/\\d+条/", "/([/"])
  assert.deepEqual(compiled.plains, ["敏感", "/([/"])
  assert.equal(compiled.regexes.length, 1)
  assert.equal(compiled.size, 3)
})

test("CQ 字符串审查:只替换文本部分,CQ 码原样保留", () => {
  const { dropped, replaced, params } = censorOutbound(REPLACE_CFG, {
    message: "前缀[CQ:image,file=abc.jpg]这是秘密2026年的事[CQ:at,qq=1]完"
  })
  assert.equal(dropped, false)
  assert.ok(replaced >= 2)
  assert.match(params.message, /\[CQ:image,file=abc\.jpg\]/)
  assert.match(params.message, /\[CQ:at,qq=1\]/)
  assert.ok(!params.message.includes("秘密"))
  assert.ok(!params.message.includes("2026年"))
  assert.match(params.message, /\*\*\*?的?事/)
})

test("segment 数组审查:text 段替换,image 段结构与内容零改动", () => {
  const segments = [
    { type: "text", data: { text: "看这个秘密" } },
    { type: "image", data: { file: "abc.jpg", url: "http://x/秘密.jpg" } },
    { type: "text", data: { text: "结束" } }
  ]
  const { params, replaced } = censorOutbound(REPLACE_CFG, { group_id: 1, message: segments })
  assert.equal(params.group_id, 1)
  assert.ok(replaced >= 1)
  assert.equal(params.message[0].data.text, "看这个*")
  assert.equal(params.message[2].data.text, "结束")
  assert.deepEqual(params.message[1], segments[1])
})

test("拦截级词命中:整条丢弃且不返回改写消息", () => {
  const { dropped } = censorOutbound(
    { censorMark: "*", censorReplaceWords: [], censorBlockWords: ["高危词"] },
    { message: "正常话里带了高危词哦" }
  )
  assert.equal(dropped, true)
})

test("两表皆空或未启用时零改动直通", () => {
  const params = { message: "秘密" }
  assert.deepEqual(censorOutbound({ censorMark: "*", censorReplaceWords: [], censorBlockWords: [] }, params), { dropped: false, replaced: 0, params })
})

test("配置归一:审查与信号字段回落默认", () => {
  const cfg = readRiskControlConfig(() => ({}))
  assert.equal(cfg.censorEnabled, false)
  assert.equal(cfg.censorMark, "*")
  assert.deepEqual(cfg.censorReplaceWords, [])
})

test("闸门集成:拦截级丢弃时原 sendApi 不被调用,返回审查回执并通知管理群", async () => {
  const notify = []
  const adapter = { id: "10001", calls: [], sendApi: async (action, params) => { adapter.calls.push([action, params]); return { retcode: 0 } } }
  const stop = installOutboundThrottle({
    logger: { warn() {}, info() {} },
    getSettings: () => ({ riskControl: { enabled: false, censorEnabled: true, censorBlockWords: ["高危词"] } }),
    getBotRoot: () => ({ bots: { 10001: adapter } }),
    signalMonitor: {
      quietFactor: () => 1,
      detectResponse() {},
      notifyCensorBlock: (botId, groupId, excerpt) => notify.push([botId, groupId, excerpt])
    }
  })
  try {
    const result = await adapter.sendApi("send_group_msg", { group_id: 1, message: "包含高危词的消息" })
    assert.equal(result.retcode, 1201)
    assert.equal(adapter.calls.length, 0, "原发送不应被调用")
    assert.deepEqual(notify, [["10001", "1", "包含高危词的消息"]], "应带截断内容通知管理群")
    const pass = await adapter.sendApi("get_group_info", { group_id: 1 })
    assert.equal(pass.retcode, 0, "非消息类 API 直通")
    assert.equal(adapter.calls.length, 1)
    assert.equal(notify.length, 1, "查询类不应触发通知")
  } finally { stop() }
})

test("闸门集成:替换级改写后照发", async () => {
  const adapter = { id: "10001", calls: [], sendApi: async (action, params) => { adapter.calls.push([action, params]); return { retcode: 0 } } }
  const stop = installOutboundThrottle({
    logger: { warn() {}, info() {} },
    getSettings: () => ({ riskControl: { enabled: false, censorEnabled: true, censorReplaceWords: ["秘密"], censorMark: "x" } }),
    getBotRoot: () => ({ bots: { 10001: adapter } }),
    signalMonitor: { quietFactor: () => 1, detectResponse() {} }
  })
  try {
    await adapter.sendApi("send_group_msg", { group_id: 1, message: "这是秘密内容" })
    assert.equal(adapter.calls.length, 1)
    assert.equal(adapter.calls[0][1].message, "这是x内容")
  } finally { stop() }
})

test("风控信号:响应特征识别", () => {
  assert.match(matchRiskResponse({ retcode: 100 }), /风控码/)
  assert.match(matchRiskResponse({ retcode: 1, wording: "账号可能被风控" }), /风控/)
  assert.match(matchRiskResponse({ retcode: 1, msg: "发送频率过高" }), /频率/)
  assert.match(matchRiskResponse({ retcode: 1, wording: "你已被禁言" }), /禁言/)
  assert.equal(matchRiskResponse({ retcode: 0, wording: "ok" }), "")
  assert.equal(matchRiskResponse({ retcode: 1, wording: "普通错误" }), "")
})

test("风控信号:低调模式进入与期满恢复,告警走管理群", async () => {
  let clock = 1_000_000
  const sent = []
  const prevBot = globalThis.Bot
  globalThis.Bot = { bots: { 20002: { sendApi: async (_a, p) => { sent.push(p) } }, 10001: { sendApi: async (_a, p) => { sent.push(p) } } } }
  const monitor = createRiskSignalMonitor({
    logger: { warn() {}, info() {} },
    now: () => clock,
    getSettings: () => ({
      riskControl: { signalMonitorEnabled: true, signalQuietMinutes: 30 },
      mediaRelayAdminReport: { groupId: "888888" }
    })
  })
  try {
    assert.equal(monitor.quietFactor("10001"), 1)
    monitor.detectResponse("10001", "send_group_msg", { retcode: 100 })
    assert.equal(monitor.quietFactor("10001"), 2, "疑似风控后应进入低调模式")
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(sent.length >= 1, "应推送加急告警")
    assert.match(sent[0].message, /疑似风控信号/)
    assert.equal(sent[0].group_id, 888888)
    clock += 31 * 60 * 1000
    assert.equal(monitor.quietFactor("10001"), 1, "期满自动恢复")
    monitor.handleNotice({ notice_type: "group_ban", sub_type: "ban", self_id: "10001", user_id: "10001", group_id: "777" })
    assert.equal(monitor.quietFactor("10001"), 2, "被禁言也应触发低调模式")
    monitor.handleNotice({ notice_type: "group_ban", sub_type: "ban", self_id: "10001", user_id: "999", group_id: "777" })
    assert.equal(monitor.snapshot()["10001"].count, 2, "禁言他人不算该号信号")
  } finally {
    globalThis.Bot = prevBot
  }
})

test("拦截通知:首条即推、冷却期聚合、期满报出累计", async () => {
  let clock = 5_000_000
  const sent = []
  const prevBot = globalThis.Bot
  globalThis.Bot = { bots: { 10001: { sendApi: async (_a, p) => { sent.push(p) } } } }
  const monitor = createRiskSignalMonitor({
    logger: { warn() {}, info() {} },
    now: () => clock,
    getSettings: () => ({
      riskControl: { signalMonitorEnabled: true, signalQuietMinutes: 30 },
      mediaRelayAdminReport: { groupId: "888888" }
    })
  })
  try {
    monitor.notifyCensorBlock("10001", "123", "第一条带敏感词的内容")
    monitor.notifyCensorBlock("10001", "123", "第二条")
    monitor.notifyCensorBlock("10001", "124", "第三条")
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(sent.length, 1, "冷却期内只推第一条")
    assert.match(sent[0].message, /出站内容拦截/)
    assert.match(sent[0].message, /第一条带敏感词的内容/)
    clock += 11 * 60_000
    monitor.notifyCensorBlock("10001", "125", "冷却后的新拦截")
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(sent.length, 2)
    assert.match(sent[1].message, /冷却期内另有 2 条被拦截/)
    assert.match(sent[1].message, /冷却后的新拦截/)
  } finally {
    globalThis.Bot = prevBot
  }
})
