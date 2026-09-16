import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import {
  analyzeModerationRules,
  buildModerationReport,
  normalizeGroupModerationConfig
} from "../domains/group-admin/groupModerationRules.js"
import { GroupModerationManager, getSegmentText, isIgnoredBotUser } from "../domains/group-admin/GroupModerationManager.js"

test("刷屏检测：窗口内满条数触发，窗口外过期不计", () => {
  const manager = new GroupModerationManager()
  const config = normalizeGroupModerationConfig({ floodWindowSeconds: 10, floodMaxMessages: 5, floodMaxLevel: 5 })

  let t = 1000000
  for (let i = 0; i < 4; i++) {
    assert.equal(manager.checkFlood(609235590, 111, 3, config, t + i * 1000), null)
  }
  const hit = manager.checkFlood(609235590, 111, 3, config, t + 4000)
  assert.equal(hit?.count, 5)
  assert.equal(hit?.windowSeconds, 10)

  // 命中后窗口清空，紧接着的下一条不重复触发
  assert.equal(manager.checkFlood(609235590, 111, 3, config, t + 4100), null)

  // 窗口过期：间隔拉长后重新计数
  const t2 = t + 60000
  for (let i = 0; i < 4; i++) {
    assert.equal(manager.checkFlood(609235590, 222, 3, config, t2 + i * 5000), null)
  }
})

test("刷屏检测：超过等级上限的成员与关闭开关时不检测", () => {
  const manager = new GroupModerationManager()
  const config = normalizeGroupModerationConfig({ floodWindowSeconds: 10, floodMaxMessages: 3 })
  const t = 2000000
  for (let i = 0; i < 5; i++) {
    assert.equal(manager.checkFlood(609235590, 333, 9, config, t + i * 100), null, "等级 9 > floodMaxLevel 5")
  }
  const disabled = normalizeGroupModerationConfig({ floodEnabled: false, floodMaxMessages: 3 })
  for (let i = 0; i < 5; i++) {
    assert.equal(manager.checkFlood(609235590, 444, 3, disabled, t + i * 100), null, "开关关闭")
  }
})

test("markdown 卡片取可见文本且剥掉链接，不再误触外链规则", () => {
  const card = "[](https://qqbot.ugcimg.cn/version2) [@某人](mqqapi://markdown/mention?at_type=1) 💕老婆图片收集系统 ![](https://qqbot.ugcimg.cn/x.png)"
  const text = getSegmentText({ type: "markdown", content: card })
  assert.ok(!/https?:\/\/|mqqapi:\/\//i.test(text), "卡片文本不应残留链接")
  assert.ok(text.includes("老婆图片收集系统"), "可见文本应保留")
})

test("纯链接卡片折叠成占位符，json/xml 卡片不进规则", () => {
  assert.equal(getSegmentText({ type: "markdown", content: "[](https://a.b/c.png)" }), "[卡片消息]")
  assert.equal(getSegmentText({ type: "json", data: { data: "{\"qq\":\"x\"}" } }), "[卡片消息]")
})

test("官方群管与配置名单内的 bot 被豁免", () => {
  assert.equal(isIgnoredBotUser("2854196310", normalizeGroupModerationConfig({})), true)
  assert.equal(isIgnoredBotUser("3858854713", normalizeGroupModerationConfig({})), true)
  const config = normalizeGroupModerationConfig({ ignoredBotIds: [3889045760, " 123 "] })
  assert.equal(isIgnoredBotUser(3889045760, config), true)
  assert.equal(isIgnoredBotUser("123", config), true)
  assert.equal(isIgnoredBotUser("999", config), false)
})

test("normalizes group moderation admin and threshold config", () => {
  const config = normalizeGroupModerationConfig({
    enabledGroups: [609235590, " 123 "],
    globalAdmins: [925640859],
    groupAdmins: [
      { groupId: 609235590, admins: [111, " 222 "] },
      { groupId: "", admins: [333] }
    ],
    minActiveLevel: "5",
    thresholds: { report: "1.5", mute: "-1" }
  })

  assert.deepEqual(config.enabledGroups, ["609235590", "123"])
  assert.deepEqual(config.globalAdmins, ["925640859"])
  assert.deepEqual(config.groupAdmins, [{ groupId: "609235590", admins: ["111", "222"] }])
  assert.equal(config.minActiveLevel, 5)
  assert.equal(config.thresholds.report, 1)
  assert.equal(config.thresholds.mute, 0)
  assert.equal(config.mentionConfiguredAdminsInGroup, true)
})

test("allows group admin mentions to be disabled explicitly", () => {
  const config = normalizeGroupModerationConfig({ mentionConfiguredAdminsInGroup: false })
  assert.equal(config.mentionConfiguredAdminsInGroup, false)
})

test("detects low-level external recruitment text", () => {
  const config = normalizeGroupModerationConfig({ minActiveLevel: 5 })
  const result = analyzeModerationRules({
    memberLevel: 3,
    text: "长期招募兼职代理，日结佣金，加微信 abc12345，详情看 https://example.com",
    imageCount: 0,
    atCount: 0
  }, config)

  assert.ok(result.rules.includes("低活跃等级"))
  assert.ok(result.rules.includes("包含外链"))
  assert.ok(result.rules.includes("疑似招募话术"))
  assert.ok(result.rules.includes("包含联系方式"))
  assert.ok(result.confidence >= 0.7)
})

test("detects group invite qr and add-v promotion patterns", () => {
  const config = normalizeGroupModerationConfig({ minActiveLevel: 5 })
  const qrResult = analyzeModerationRules({
    memberLevel: 1,
    text: "扫码进群，长按识别二维码，进群领取福利",
    imageCount: 1,
    atCount: 0
  }, config)
  const addVResult = analyzeModerationRules({
    memberLevel: 1,
    text: "推广合作，加V abc12345 私聊领取，名额有限",
    imageCount: 0,
    atCount: 0
  }, config)

  assert.ok(qrResult.rules.includes("疑似二维码引流"))
  assert.ok(qrResult.confidence >= 0.7)
  assert.ok(addVResult.rules.includes("疑似招募话术"))
  assert.ok(addVResult.rules.includes("包含联系方式"))
  assert.ok(addVResult.confidence >= 0.7)
})

test("detects authorization promotion and low-level forwarded ads", () => {
  const config = normalizeGroupModerationConfig({ minActiveLevel: 5 })
  const authResult = analyzeModerationRules({
    memberLevel: 1,
    text: "[🔗🍀一念成仙](https://qm.qq.com/q/cSHh9UTFyo) | [✨免@授权](mqqapi://aio/inlinecmd?command=全量申请) 请点击B站关注按钮查阅详细",
    imageCount: 0,
    atCount: 0
  }, config)
  const forwardResult = analyzeModerationRules({
    memberLevel: 1,
    text: "[合并转发]",
    imageCount: 0,
    atCount: 0,
    forwardCount: 1
  }, config)

  assert.ok(authResult.rules.includes("疑似授权推广"))
  assert.ok(authResult.confidence >= 0.7)
  assert.ok(forwardResult.rules.includes("低活跃合并转发"))
  assert.ok(forwardResult.confidence >= 0.7)
})

test("renders natural-language moderation report instead of json object", () => {
  const config = normalizeGroupModerationConfig()
  const text = buildModerationReport({
    rules: ["低活跃等级", "包含外链", "疑似招募话术"],
    confidence: 0.864,
    action: "report",
    evidenceForwarded: true
  }, config)

  assert.equal(text, '群管检测：命中规则["低活跃等级", "包含外链", "疑似招募话术"],置信度:0.86。证据已转发到群管理员私聊')
})

test("group guard schema exposes composite moderation settings", async () => {
  const { default: groupGuardSchema } = await import("../models/Guoba/schemas/groupGuard.js")
  const fields = groupGuardSchema.map(item => item.field).filter(Boolean)
  const labels = groupGuardSchema.map(item => item.label).filter(Boolean)

  assert.ok(labels.includes("广告扫描"))
  assert.ok(fields.includes("groupModeration.globalAdmins"))
  assert.ok(fields.includes("groupModeration.groupAdmins"))
  assert.ok(fields.includes("groupModeration.thresholds.report"))
  assert.ok(fields.includes("groupModeration.actions.muteEnabled"))
  assert.ok(fields.includes("groupModeration.mentionConfiguredAdminsInGroup"))
})

test("group report mentions only configured recipients", async () => {
  const manager = new GroupModerationManager()
  const config = normalizeGroupModerationConfig({
    publicReportEnabled: true,
    mentionConfiguredAdminsInGroup: true,
    globalAdmins: [10001, 10002],
    groupAdmins: [{ groupId: 30001, admins: [10002, 10003] }]
  })
  let received = null
  await manager.sendGroupReport({
    group_id: 30001,
    user_id: 20001,
    self_id: 10002,
    reply: async message => { received = message }
  }, config, {
    rules: ["包含外链"],
    confidence: 0.8,
    action: "report",
    evidenceForwarded: false
  })

  assert.deepEqual(received.slice(0, 4), [
    { type: "at", data: { qq: "10001" } },
    { type: "text", data: { text: " " } },
    { type: "at", data: { qq: "10003" } },
    { type: "text", data: { text: " " } }
  ])
  assert.match(received.at(-1).data.text, /包含外链/)
})

test("notification recipients come exclusively from configured QQ lists", () => {
  const manager = new GroupModerationManager()
  const config = normalizeGroupModerationConfig({
    globalAdmins: [10001],
    groupAdmins: [{ groupId: 30001, admins: [10002] }]
  })

  // Native group roles are deliberately absent from this source of truth.
  assert.deepEqual(
    manager.getNotificationAdmins(config, 30001, [20001]),
    ["10001", "10002"]
  )
})

test("group moderation checks bot admin permission before content extraction", () => {
  const source = fs.readFileSync(new URL("../domains/group-admin/GroupModerationManager.js", import.meta.url), "utf8")
  const configCheck = source.indexOf("if (!this.isGroupEnabled(config, groupId)) return false")
  const botAdminCheck = source.indexOf("if (!await this.isBotAdmin(e, groupId)) return false")
  const extractContent = source.indexOf("const content = await this.extractContent(e, config)")

  assert.ok(source.includes("async isBotAdmin(e, groupId)"))
  assert.ok(configCheck >= 0)
  assert.ok(botAdminCheck > configCheck)
  assert.ok(extractContent > botAdminCheck)
})
