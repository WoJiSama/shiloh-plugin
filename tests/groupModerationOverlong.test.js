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
