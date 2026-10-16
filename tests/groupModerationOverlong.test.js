import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeGroupModerationConfig } from "../dist/backend/modules/groupAdmin/domain/groupModerationRules.js"
import { resolveGroupAdminSettings } from "../dist/backend/modules/groupAdmin/domain/groupAdminPolicy.js"
import { GroupModerationManager } from "../dist/backend/modules/groupAdmin/infrastructure/GroupModerationManager.js"

const GROUP_ID = 609235590
const BOT_ID = 10001
const USER_ID = 222
const LONG_TEXT = "今天天气真好。".repeat(20)  // 140 字，超过归一化下限 100

function baseSettings(extra = {}) {
  return {
    groupModeration: {
      enabled: true,
      enabledGroups: [GROUP_ID],
      floodEnabled: false,
      adCorpusAutoCollect: false,
      forwardEvidenceToAdmins: false,
      publicReportEnabled: false,
      overlongMessage: { enabled: true, maxLength: 20 },
      ...extra
    }
  }
}

function createHarness({ settings = baseSettings(), withForward = true, failRecall = false } = {}) {
  const calls = { apis: [], forwards: [], groupMsgs: [], replies: [] }
  const group = {
    getMemberMap: async () => new Map([
      [BOT_ID, { role: "admin" }],
      [USER_ID, { role: "member", level: 3 }]
    ]),
    sendMsg: async message => { calls.groupMsgs.push(message); return { message_id: 900 } },
    ...(withForward
      ? { makeForwardMsg: async nodes => { calls.forwards.push(nodes); return { type: "forward", data: { prompt: "聊天记录" }, nodes } } }
      : {})
  }
  const bot = {
    uin: BOT_ID,
    pickGroup: async () => group,
    sendApi: async (method, params) => {
      calls.apis.push({ method, params })
      if (method === "get_group_member_info") return { data: { role: "member", level: 3 } }
      if (method === "delete_msg" && failRecall) throw new Error("retain failed")
      return {}
    }
  }
  const manager = new GroupModerationManager(
    { readSettings: () => settings, getBot: () => bot, logger: { warn() {}, info() {}, debug() {} } },
    { getTemplateTexts: () => [], addEntry: () => ({}) }
  )
  const makeEvent = (text, extra = {}) => ({
    group_id: GROUP_ID,
    user_id: USER_ID,
    self_id: BOT_ID,
    card: "小明",
    nickname: "小明",
    message_id: 555,
    sender: { nickname: "小明", role: "member", level: 3 },
    msg: text,
    message: [{ type: "text", data: { text } }],
    reply: async message => { calls.replies.push(message); return {} },
    group,
    ...extra
  })
  return { manager, calls, group, bot, makeEvent }
}

test("overlongMessage 配置归一化：默认值、类型与范围钳制", () => {
  assert.deepEqual(normalizeGroupModerationConfig({}).overlongMessage, {
    enabled: false,
    maxLength: 1500,
    forwardEnabled: true
  })
  const custom = normalizeGroupModerationConfig({
    overlongMessage: { enabled: true, maxLength: "2500", forwardEnabled: false }
  })
  assert.deepEqual(custom.overlongMessage, { enabled: true, maxLength: 2500, forwardEnabled: false })
  const clamped = normalizeGroupModerationConfig({ overlongMessage: { enabled: 1, maxLength: 5 } })
  assert.equal(clamped.overlongMessage.enabled, false, "开关必须是显式 true")
  assert.equal(clamped.overlongMessage.maxLength, 100, "字数下限 100")
  const upper = normalizeGroupModerationConfig({ overlongMessage: { enabled: true, maxLength: 999999 } })
  assert.equal(upper.overlongMessage.maxLength, 20000, "字数上限 20000")
})

test("checkOverlongMessage：按码点计数，达到阈值才触发，开关关闭恒不触发", () => {
  const manager = new GroupModerationManager({ readSettings: () => ({}) }, { getTemplateTexts: () => [] })
  const config = normalizeGroupModerationConfig({ overlongMessage: { enabled: true, maxLength: 100 } })
  assert.equal(manager.checkOverlongMessage("a".repeat(99), config), null)
  assert.equal(manager.checkOverlongMessage("", config), null)
  const hit = manager.checkOverlongMessage("a".repeat(100), config)
  assert.equal(hit.length, 100)
  assert.equal(hit.maxLength, 100)
  assert.equal(manager.checkOverlongMessage("😀".repeat(120), config)?.length, 120, "emoji 代理对按 1 个码点计")
  const disabled = normalizeGroupModerationConfig({ overlongMessage: { enabled: false, maxLength: 100 } })
  assert.equal(manager.checkOverlongMessage("a".repeat(200), disabled), null)
})

test("extractVisibleText：只取消息段文本，不与 e.msg 重复拼接，无消息段时回退", () => {
  const manager = new GroupModerationManager({ readSettings: () => ({}) }, { getTemplateTexts: () => [] })
  assert.equal(manager.extractVisibleText({
    msg: "hello world",
    message: [{ type: "text", data: { text: "hello" } }, { type: "text", data: { text: " world" } }]
  }), "hello world")
  assert.equal(manager.extractVisibleText({ msg: "fallback" }), "fallback")
  assert.equal(manager.extractVisibleText({ raw_message: "raw" }), "raw")
  assert.equal(manager.extractVisibleText({ message: [{ type: "forward", id: "x" }] }), "[合并转发]")
})

test("超长普通消息：撤回原消息并把内容转成合并聊天记录", async () => {
  const { manager, calls, makeEvent } = createHarness()
  const longText = LONG_TEXT
  const handled = await manager.handleMessage(makeEvent(longText))

  assert.equal(handled, true)
  assert.deepEqual(calls.apis.find(call => call.method === "delete_msg"), {
    method: "delete_msg",
    params: { message_id: 555 }
  })
  assert.equal(calls.forwards.length, 1, "应生成一条合并转发")
  const nodes = calls.forwards[0]
  assert.equal(nodes[0].user_id, BOT_ID)
  assert.ok(nodes[0].message.includes("已撤回 小明 的超长消息（约 140 字）"), "首节点为机器人说明")
  assert.equal(nodes[1].user_id, USER_ID)
  assert.equal(nodes[1].nickname, "小明")
  assert.equal(nodes[1].message, longText, "原内容归属原发送者")
  assert.equal(calls.groupMsgs.length, 1, "合并转发应通过 group.sendMsg 发出")
  assert.equal(calls.replies.length, 0)
})

test("超长内容按 1000 字分片为多个聊天记录节点", async () => {
  const { manager, calls, makeEvent } = createHarness()
  const longText = "好".repeat(2500)
  await manager.handleMessage(makeEvent(longText))

  const nodes = calls.forwards[0]
  assert.equal(nodes.length, 4, "1 个说明节点 + 3 个分片节点")
  assert.equal(nodes[1].message.length, 1000)
  assert.equal(nodes[2].message.length, 1000)
  assert.equal(nodes[3].message.length, 500)
  assert.ok(nodes.every(node => node.nickname === "小明" || node.user_id === BOT_ID))
})

test("撤回失败时不转发，避免原消息与转发卡片重复", async () => {
  const { manager, calls, makeEvent } = createHarness({ failRecall: true })
  const handled = await manager.handleMessage(makeEvent(LONG_TEXT))

  assert.equal(handled, false)
  assert.equal(calls.forwards.length, 0)
  assert.equal(calls.groupMsgs.length, 0)
  assert.equal(calls.replies.length, 0)
})

test("适配器缺少 makeForwardMsg 时退回 OneBot send_group_forward_msg 直发", async () => {
  const { manager, calls, makeEvent } = createHarness({ withForward: false })
  const handled = await manager.handleMessage(makeEvent(LONG_TEXT))

  assert.equal(handled, true)
  const forward = calls.apis.find(call => call.method === "send_group_forward_msg")
  assert.ok(forward, "应调用 OneBot 合并转发接口")
  assert.equal(forward.params.group_id, GROUP_ID)
  assert.deepEqual(forward.params.messages.map(node => node.type), ["node", "node"])
  assert.equal(forward.params.messages[1].data.uin, String(USER_ID))
  assert.equal(forward.params.messages[1].data.name, "小明")
  assert.equal(calls.groupMsgs.length, 0, "不应再走 group.sendMsg")
})

test("forwardEnabled 关闭时只撤回、不转发", async () => {
  const { manager, calls, makeEvent } = createHarness({
    settings: baseSettings({ overlongMessage: { enabled: true, maxLength: 20, forwardEnabled: false } })
  })
  const handled = await manager.handleMessage(makeEvent(LONG_TEXT))

  assert.equal(handled, true)
  assert.ok(calls.apis.some(call => call.method === "delete_msg"))
  assert.equal(calls.forwards.length, 0)
  assert.equal(calls.groupMsgs.length, 0)
})

test("命中广告风控的超长消息优先走风控流程，不撤回也不转发内容", async () => {
  const { manager, calls, makeEvent } = createHarness()
  const adText = `长期招募兼职代理，日结佣金，加微信 abc12345，详情看 https://example.com/${"详情".repeat(30)}`
  const handled = await manager.handleMessage(makeEvent(adText))

  assert.equal(handled, true, "风控流程接管")
  assert.ok(!calls.apis.some(call => call.method === "delete_msg"), "未开启自动撤回，不应撤回")
  assert.equal(calls.forwards.length, 0, "广告内容绝不能再转发")
})

test("开关关闭或未超长时不做任何处理", async () => {
  const disabled = createHarness({
    settings: baseSettings({ overlongMessage: { enabled: false, maxLength: 20 } })
  })
  assert.equal(await disabled.manager.handleMessage(disabled.makeEvent(LONG_TEXT)), false)
  assert.equal(disabled.calls.forwards.length, 0)

  const short = createHarness()
  assert.equal(await short.manager.handleMessage(short.makeEvent("今天天气真好。")), false)
  assert.equal(short.calls.apis.length, 0)
})

test("按群覆盖对 overlongMessage 做浅合并，未覆盖字段沿用默认", () => {
  const resolved = resolveGroupAdminSettings({
    groupModeration: { overlongMessage: { enabled: true, maxLength: 1500, forwardEnabled: true } },
    groupAdmin: { overrides: [{ groupId: String(GROUP_ID), groupModeration: { overlongMessage: { maxLength: 800 } } }] }
  }, GROUP_ID)
  const config = normalizeGroupModerationConfig(resolved.groupModeration)
  assert.deepEqual(config.overlongMessage, { enabled: true, maxLength: 800, forwardEnabled: true })
})

test("burstMessage 配置归一化：默认值与范围钳制", () => {
  assert.deepEqual(normalizeGroupModerationConfig({}).burstMessage, {
    enabled: false,
    windowSeconds: 5,
    maxMessages: 6,
    muteSeconds: 30,
    forwardEnabled: true
  })
  const custom = normalizeGroupModerationConfig({
    burstMessage: { enabled: true, windowSeconds: "10", maxMessages: 4, muteSeconds: 60, forwardEnabled: false }
  })
  assert.deepEqual(custom.burstMessage, {
    enabled: true,
    windowSeconds: 10,
    maxMessages: 4,
    muteSeconds: 60,
    forwardEnabled: false
  })
  const clamped = normalizeGroupModerationConfig({
    burstMessage: { enabled: true, windowSeconds: 1, maxMessages: 2, muteSeconds: -5 }
  })
  assert.deepEqual(
    { windowSeconds: clamped.burstMessage.windowSeconds, maxMessages: clamped.burstMessage.maxMessages, muteSeconds: clamped.burstMessage.muteSeconds },
    { windowSeconds: 2, maxMessages: 3, muteSeconds: 0 }
  )
})

test("trackBurstMessage：窗口内累计触发并清空，窗口过期重新计数，开关关闭不跟踪", () => {
  const manager = new GroupModerationManager({ readSettings: () => ({}) }, { getTemplateTexts: () => [] })
  const config = normalizeGroupModerationConfig({
    burstMessage: { enabled: true, windowSeconds: 5, maxMessages: 3 }
  })
  const event = id => ({ group_id: GROUP_ID, user_id: USER_ID, message_id: id, msg: `第${id}条` })
  assert.equal(manager.trackBurstMessage(event(1), config, 0), null)
  assert.equal(manager.trackBurstMessage(event(2), config, 1000), null)
  const hit = manager.trackBurstMessage(event(3), config, 2000)
  assert.equal(hit.messages.length, 3, "第 3 条达到阈值返回整批")
  assert.deepEqual(hit.messages.map(item => item.text), ["第1条", "第2条", "第3条"])
  assert.equal(hit.windowSeconds, 5)
  assert.equal(manager.trackBurstMessage(event(4), config, 2100), null, "触发后窗口清空重新计数")

  // 窗口过期：前两条过期后不计入
  assert.equal(manager.trackBurstMessage(event(5), config, 10000), null)
  assert.equal(manager.burstTrackers.get(`${GROUP_ID}:${USER_ID}`).length, 1, "过期的两条被清掉")

  const disabled = normalizeGroupModerationConfig({ burstMessage: { enabled: false } })
  assert.equal(manager.trackBurstMessage(event(6), disabled, 0), null)
})

function burstSettings(overrides = {}) {
  return baseSettings({
    overlongMessage: { enabled: false },
    burstMessage: { enabled: true, windowSeconds: 5, maxMessages: 3, muteSeconds: 30, ...overrides }
  })
}

async function sendBurstMessages(manager, makeEvent, count) {
  const handled = []
  for (let index = 1; index <= count; index++) {
    handled.push(await manager.handleMessage(makeEvent(`第${index}条`, { message_id: 500 + index })))
  }
  return handled
}

test("连发达到阈值：整批撤回、合并转发、禁言 30 秒", async () => {
  const { manager, calls, makeEvent } = createHarness({ settings: burstSettings() })
  const handled = await sendBurstMessages(manager, makeEvent, 3)

  assert.deepEqual(handled, [false, false, true], "前两条不触发，第三条触发折叠")
  const deletions = calls.apis.filter(call => call.method === "delete_msg")
  assert.deepEqual(deletions.map(call => call.params.message_id), [501, 502, 503], "窗口内全部撤回")
  const ban = calls.apis.find(call => call.method === "set_group_ban")
  assert.deepEqual(ban, { method: "set_group_ban", params: { group_id: GROUP_ID, user_id: USER_ID, duration: 30 } })
  assert.equal(calls.forwards.length, 1)
  const nodes = calls.forwards[0]
  assert.equal(nodes.length, 4, "1 条说明 + 3 条原文")
  assert.ok(nodes[0].message.includes("连发 3 条消息"), "说明节点带条数")
  assert.ok(nodes[0].message.includes("禁言 30 秒"), "说明节点带禁言信息")
  assert.deepEqual(nodes.slice(1).map(node => node.message), ["第1条", "第2条", "第3条"])
  assert.equal(nodes[1].nickname, "小明", "原文节点归属原发送者")
  assert.equal(calls.groupMsgs.length, 1)
})

test("muteSeconds 为 0 时只折叠不禁言", async () => {
  const { manager, calls, makeEvent } = createHarness({
    settings: burstSettings({ muteSeconds: 0 })
  })
  await sendBurstMessages(manager, makeEvent, 3)
  assert.ok(!calls.apis.some(call => call.method === "set_group_ban"), "不应禁言")
  assert.equal(calls.forwards.length, 1)
  assert.ok(calls.forwards[0][0].message.includes("已全部撤回并折叠："), "无禁言时说明不含禁言字样")
})

test("全部撤回失败时不禁言不转发", async () => {
  const { manager, calls, makeEvent } = createHarness({ settings: burstSettings(), failRecall: true })
  const handled = await sendBurstMessages(manager, makeEvent, 3)
  assert.equal(handled[2], false)
  assert.ok(!calls.apis.some(call => call.method === "set_group_ban"))
  assert.equal(calls.forwards.length, 0)
})

test("连发折叠优先于刷屏风控，不重复禁言", async () => {
  // 打开刷屏检测（3 条/10 秒即命中），连发 3 条同时满足两个规则
  const settings = burstSettings()
  settings.groupModeration.floodEnabled = true
  settings.groupModeration.floodMaxMessages = 3
  settings.groupModeration.floodWindowSeconds = 10
  const harness = createHarness({ settings })
  const handled = await sendBurstMessages(harness.manager, harness.makeEvent, 3)
  assert.equal(handled[2], true, "由连发折叠接管")
  const bans = harness.calls.apis.filter(call => call.method === "set_group_ban")
  assert.equal(bans.length, 1, "只有连发折叠的一次禁言，刷屏不再叠加")
  assert.equal(harness.calls.forwards.length, 1)
})

test("连发窗口外的不计入：分两条慢速消息不触发", async () => {
  const { manager, calls, makeEvent } = createHarness({ settings: burstSettings() })
  await manager.handleMessage(makeEvent("慢速一", { message_id: 601 }))
  await new Promise(resolve => setTimeout(resolve, 20))
  // 窗口 5 秒内连发仍会触发，这里只验证不会因单条误触发
  await manager.handleMessage(makeEvent("慢速二", { message_id: 602 }))
  assert.equal(calls.apis.filter(call => call.method === "delete_msg").length, 0)
  assert.equal(calls.forwards.length, 0)
})
