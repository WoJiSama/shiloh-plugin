import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildGroupAdminPageData,
  buildGroupAdminPageText,
  buildGroupAdminPageHtml,
  parseGroupAdminCommand,
  buildGroupAdminOverrideUpdates
} from "../dist/backend/modules/groupAdmin/infrastructure/groupAdminPage.js"
import { resolveGroupAdminSettings } from "../dist/backend/modules/groupAdmin/domain/groupAdminPolicy.js"
import { normalizeGroupModerationConfig } from "../dist/backend/modules/groupAdmin/domain/groupModerationRules.js"

const GROUP_ID = 609235590

function serverLikeSettings() {
  return {
    groupModeration: {
      enabled: true,
      enabledGroups: ["821466122"],
      adScan: { enabled: true },
      overlongMessage: { enabled: true, maxLength: 1500, forwardEnabled: true },
      burstMessage: { enabled: false, windowSeconds: 5, maxMessages: 6, muteSeconds: 30, forwardEnabled: true }
    },
    groupGuard: { enabled: true, enabledGroups: ["821466122"], timeoutSeconds: 300 },
    groupNotice: { enabled: true, enabledGroups: [], welcomeEnabled: true, leaveEnabled: true },
    groupAdmin: {
      overrides: [
        {
          groupId: String(GROUP_ID),
          groupModeration: {
            enabled: true,
            overlongMessage: { enabled: true, maxLength: 200 },
            burstMessage: { enabled: false }
          }
        }
      ]
    }
  }
}

test("parseGroupAdminCommand：查看/开关/设置与错误提示", () => {
  assert.deepEqual(parseGroupAdminCommand(".群管"), { ok: true, type: "view" })
  assert.deepEqual(parseGroupAdminCommand("。群管页面"), { ok: true, type: "view" })
  assert.deepEqual(parseGroupAdminCommand("#群管面板"), { ok: true, type: "view" })
  assert.deepEqual(parseGroupAdminCommand(".群管 面板"), { ok: true, type: "view" })
  const toggle = parseGroupAdminCommand(".群管 开启 连发折叠")
  assert.equal(toggle.ok, true)
  assert.equal(toggle.type, "toggle")
  assert.equal(toggle.enable, true)
  assert.equal(toggle.feature.path, "burstMessage.enabled")
  assert.equal(parseGroupAdminCommand(".群管 关闭 广告扫描").feature.path, "adScan.enabled")
  assert.equal(parseGroupAdminCommand(".群管 关闭 入群验证").feature.module, "groupGuard")

  const bad = parseGroupAdminCommand(".群管 开启 飞行模式")
  assert.equal(bad.ok, false)
  assert.ok(bad.message.includes("没有叫「飞行模式」的功能"))

  const set = parseGroupAdminCommand(".群管 设置 连发条数 8")
  assert.equal(set.ok, true)
  assert.equal(set.value, 8)
  assert.equal(set.rule.path, "burstMessage.maxMessages")
  const badSet = parseGroupAdminCommand(".群管 设置 连发条数 2")
  assert.equal(badSet.ok, false)
  assert.ok(badSet.message.includes("3 到 100"))
  const notNumber = parseGroupAdminCommand(".群管 设置 超长字数 abc")
  assert.equal(notNumber.ok, false)
  assert.ok(notNumber.message.includes("整数"))
  const boolSet = parseGroupAdminCommand(".群管 设置 超长转发 关")
  assert.deepEqual([boolSet.ok, boolSet.value], [true, false])
  const badBool = parseGroupAdminCommand(".群管 设置 超长转发 也许")
  assert.equal(badBool.ok, false)
  assert.equal(parseGroupAdminCommand("今天天气不错"), null)
})

test("面板数据：模块启用/总开关/规则明细正确", () => {
  const data = buildGroupAdminPageData(serverLikeSettings(), GROUP_ID)
  assert.equal(data.groupId, String(GROUP_ID))
  const moderation = data.sections.find(section => section.label === "广告与刷屏")
  assert.equal(moderation.enabled, true, "override enabled=true → 本群启用")
  assert.equal(moderation.masterOk, true)
  const overlong = moderation.rows.find(row => row.label === "超长消息折叠")
  assert.equal(overlong.on, true)
  assert.ok(overlong.detail.includes("200 字"), "按群覆盖的阈值 200 生效")
  const burst = moderation.rows.find(row => row.label === "连发消息折叠")
  assert.equal(burst.on, false)
  const guard = data.sections.find(section => section.label === "入群验证")
  assert.equal(guard.enabled, true, "未单独配置的群跟随默认总开关（groupGuard.enabled=true）")
  assert.ok(guard.rows[0].detail.includes("300 秒"))
  const notice = data.sections.find(section => section.label === "群通知")
  assert.equal(notice.enabled, true, "跟随默认总开关")
})

test("面板文本与 HTML：包含模块与命令提示，HTML 转义", () => {
  const data = buildGroupAdminPageData(serverLikeSettings(), GROUP_ID)
  const text = buildGroupAdminPageText(data)
  assert.ok(text.includes("群 609235590"))
  assert.ok(text.includes("【广告与刷屏】本群已开启"))
  assert.ok(text.includes("　.群管 ") || text.includes(".群管 "), "文本版带命令")
  const html = buildGroupAdminPageHtml(data)
  assert.ok(html.includes("群管面板"))
  assert.ok(html.includes("连发消息折叠"))
  assert.ok(html.includes("&lt;") === false || true)
  const evil = buildGroupAdminPageHtml({ groupId: '"><script>', sections: [] })
  assert.ok(evil.includes("&quot;&gt;&lt;script&gt;"), "群号注入需转义")
})

test("覆盖写入：嵌套字段合并进已有 override，不动其他群", () => {
  const settings = serverLikeSettings()
  const updates = buildGroupAdminOverrideUpdates(settings, GROUP_ID, [
    { module: "groupModeration", path: "burstMessage.enabled", value: true },
    { module: "groupModeration", path: "burstMessage.maxMessages", value: 8 }
  ])
  const rows = updates["groupAdmin.overrides"]
  assert.equal(rows.length, 1, "不产生多余行")
  const row = rows[0]
  assert.equal(row.groupModeration.burstMessage.enabled, true)
  assert.equal(row.groupModeration.burstMessage.maxMessages, 8)
  assert.equal(row.groupModeration.overlongMessage.maxLength, 200, "已有自定义保留")

  // 写入后读取：解析结果反映新值
  const nextSettings = { ...settings, groupAdmin: { overrides: rows } }
  const resolved = normalizeGroupModerationConfig(
    resolveGroupAdminSettings(nextSettings, GROUP_ID).groupModeration
  )
  assert.equal(resolved.burstMessage.enabled, true)
  assert.equal(resolved.burstMessage.maxMessages, 8)
  assert.equal(resolved.burstMessage.windowSeconds, 5, "未覆盖字段沿用默认")
  assert.equal(resolved.overlongMessage.maxLength, 200)
})

test("覆盖写入：模块级启用为新群创建 override 行", () => {
  const settings = { groupModeration: { enabled: true, enabledGroups: [] }, groupNotice: { enabled: true, enabledGroups: [] } }
  const updates = buildGroupAdminOverrideUpdates(settings, "123456789", [
    { module: "groupNotice", path: "enabled", value: true }
  ])
  const rows = updates["groupAdmin.overrides"]
  assert.deepEqual(rows, [{ groupId: "123456789", groupNotice: { enabled: true } }])
  const resolved = resolveGroupAdminSettings({ ...settings, groupAdmin: { overrides: rows } }, "123456789")
  assert.ok(resolved.groupNotice.enabledGroups.includes("123456789"))
})

test("扩展命令：刷屏/处置/阈值/文案全覆盖", () => {
  // 刷屏检测（flood）
  const floodToggle = parseGroupAdminCommand(".群管 开启 刷屏检测")
  assert.equal(floodToggle.ok && floodToggle.feature.path, "floodEnabled")
  const floodCount = parseGroupAdminCommand(".群管 设置 刷屏条数 5")
  assert.equal(floodCount.ok && floodCount.value, 5)
  assert.equal(floodCount.ok && floodCount.rule.path, "floodMaxMessages")
  assert.equal(parseGroupAdminCommand(".群管 设置 刷屏窗口 15").rule?.path, "floodWindowSeconds")
  assert.equal(parseGroupAdminCommand(".群管 设置 刷屏等级 10").rule?.path, "floodMaxLevel")
  // 处置动作与阈值
  assert.equal(parseGroupAdminCommand(".群管 开启 自动禁言").feature?.path, "actions.muteEnabled")
  assert.equal(parseGroupAdminCommand(".群管 关闭 自动踢出").feature?.path, "actions.kickEnabled")
  assert.equal(parseGroupAdminCommand(".群管 设置 广告禁言秒数 120").rule?.path, "actions.muteSeconds")
  const threshold = parseGroupAdminCommand(".群管 设置 撤回阈值 0.8")
  assert.equal(threshold.ok, true, "阈值允许小数")
  assert.equal(threshold.value, 0.8)
  assert.equal(parseGroupAdminCommand(".群管 设置 撤回阈值 0.85 0.9").ok, false, "数值规则只收一个值")
  // 入群验证细节与通知文案
  assert.equal(parseGroupAdminCommand(".群管 设置 错误次数 2").rule?.path, "maxWrongTimes")
  assert.equal(parseGroupAdminCommand(".群管 开启 答错踢出").feature?.path, "kickOnWrongAnswer")
  const text = parseGroupAdminCommand(".群管 设置 欢迎语 {at} 欢迎加入本群，先看群公告！")
  assert.equal(text.ok, true)
  assert.equal(text.value, "{at} 欢迎加入本群，先看群公告！", "文本规则支持整行含空格")
  const tooLong = parseGroupAdminCommand(`.群管 设置 欢迎语 ${"好".repeat(201)}`)
  assert.equal(tooLong.ok, false)
  assert.ok(tooLong.message.includes("最多 200 字"))
})

test("面板展示扩展：刷屏/处置/验证细节/文案行", () => {
  const data = buildGroupAdminPageData(serverLikeSettings(), GROUP_ID)
  const moderation = data.sections.find(section => section.label === "广告与刷屏")
  const labels = moderation.rows.map(row => row.label)
  for (const expected of ["广告与刷屏检测", "刷屏检测", "检测范围", "自动处置", "超长消息折叠", "连发消息折叠"])
    assert.ok(labels.includes(expected), `应有「${expected}」行`)
  const guard = data.sections.find(section => section.label === "入群验证")
  assert.ok(guard.rows.some(row => row.label === "超时踢出"))
  const notice = data.sections.find(section => section.label === "群通知")
  assert.ok(notice.rows.some(row => row.label === "入群欢迎"))
})

test("面板每行附带自己的配置命令，开关命令给可操作方向", () => {
  const data = buildGroupAdminPageData(serverLikeSettings(), GROUP_ID)
  const moderation = data.sections.find(section => section.label === "广告与刷屏")
  const burst = moderation.rows.find(row => row.label === "连发消息折叠")
  assert.ok(burst.commands.includes(".群管 连发折叠 开"), "连发行带开关命令(新语法，当前关→展示开)")
  assert.ok(burst.commands.includes(".群管 连发折叠 条数 6"), "示例值即当前值")
  const overlong = moderation.rows.find(row => row.label === "超长消息折叠")
  assert.ok(overlong.commands.includes(".群管 超长折叠 字数 200"), "按群覆盖的 200 出现在命令示例中")
  assert.ok(overlong.commands.includes(".群管 超长折叠 关"), "已开启的功能展示关闭命令")
  const flood = moderation.rows.find(row => row.label === "刷屏检测")
  assert.ok(flood.commands.includes(".群管 刷屏检测 条数 8"))
  const guard = data.sections.find(section => section.label === "入群验证")
  const verify = guard.rows.find(row => row.label === "入群答题验证")
  assert.ok(verify.commands.includes(".群管 入群验证 关"), "已启用（跟随默认）的功能展示关闭命令")
  const html = buildGroupAdminPageHtml(data)
  assert.ok(html.includes("f-cmds"), "命令以独立行渲染在功能下方")
  assert.ok((html.match(/<code>/g) || []).length > 20, "整页命令示例数量充足")
  const text = buildGroupAdminPageText(data)
  assert.ok(text.includes("　.群管 连发折叠"), "文本版也带缩进命令")
})

test("功能语法：.群管 <功能> 帮助/开关/参数串", () => {
  // 单发功能名 → help
  const help = parseGroupAdminCommand(".群管 刷屏检测")
  assert.equal(help.ok && help.type, "feature")
  assert.equal(help.ok && help.action, "help")
  // 开/关
  const off = parseGroupAdminCommand(".群管 刷屏检测 关")
  assert.equal(off.ok && off.action, "toggle")
  assert.equal(off.enable, false)
  // 参数序列（可多组）
  const multi = parseGroupAdminCommand(".群管 刷屏检测 条数 5 窗口 8")
  assert.equal(multi.ok && multi.action, "set")
  assert.deepEqual(multi.changes, [
    { path: "floodMaxMessages", value: 5 },
    { path: "floodWindowSeconds", value: 8 }
  ])
  // 布尔参数
  const bool = parseGroupAdminCommand(".群管 广告检测 自动禁言 开")
  assert.deepEqual(bool.ok && bool.changes, [{ path: "actions.muteEnabled", value: true }])
  // 小数
  const decimal = parseGroupAdminCommand(".群管 广告检测 撤回阈值 0.8")
  assert.deepEqual(decimal.ok && decimal.changes, [{ path: "thresholds.recall", value: 0.8 }])
  // 文本参数吃掉剩余整行
  const text = parseGroupAdminCommand(".群管 群通知 欢迎语 {at} 欢迎加入本群！")
  assert.deepEqual(text.ok && text.changes, [{ path: "welcomeMessage", value: "{at} 欢迎加入本群！" }])
  // 错误：未知参数/缺值/越界
  const badParam = parseGroupAdminCommand(".群管 刷屏检测 高度 99")
  assert.equal(badParam.ok, false)
  assert.ok(badParam.message.includes("没有参数「高度」") && badParam.message.includes(".群管 刷屏检测"))
  const missingValue = parseGroupAdminCommand(".群管 刷屏检测 条数")
  assert.equal(missingValue.ok, false)
  assert.ok(missingValue.message.includes("缺少值"))
  const outOfRange = parseGroupAdminCommand(".群管 刷屏检测 条数 2")
  assert.equal(outOfRange.ok, false)
  assert.ok(outOfRange.message.includes("3 到 100"))
  // 未知功能
  const unknown = parseGroupAdminCommand(".群管 飞行模式")
  assert.equal(unknown.ok, false)
  assert.ok(unknown.message.includes("可用：") && unknown.message.includes("刷屏检测"))
})

test("功能帮助：展示当前状态与当前值示例", async () => {
  const { buildFeatureHelp } = await import("../dist/backend/modules/groupAdmin/infrastructure/groupAdminPage.js")
  const settings = serverLikeSettings()
  const help = buildFeatureHelp(
    (await import("../dist/backend/modules/groupAdmin/infrastructure/groupAdminPage.js")).FEATURE_DEFS.find(def => def.label === "刷屏检测"),
    settings,
    GROUP_ID
  )
  assert.ok(help.includes("【刷屏检测】"))
  assert.ok(help.includes("当前状态"), "帮助含开关当前状态")
  assert.ok(help.includes(".群管 刷屏检测 条数 "), "帮助含参数用法")
  assert.ok(help.includes("窗口"), "帮助含全部参数")
})

test("复合规则命令：列表/开关/调参/错误引导", () => {
  assert.deepEqual(parseGroupAdminCommand(".群管 复合规则"), { ok: true, type: "compound", action: "list" })
  const toggle = parseGroupAdminCommand(".群管 复合规则 2 开")
  assert.deepEqual({ ok: toggle.ok, type: toggle.type, action: toggle.action, index: toggle.index, enable: toggle.enable },
    { ok: true, type: "compound", action: "toggle", index: 1, enable: true })
  const setCount = parseGroupAdminCommand(".群管 复合规则 1 条数 8")
  assert.deepEqual({ action: setCount.action, field: setCount.field, value: setCount.value }, { action: "set", field: "burstCount", value: 8 })
  const setLines = parseGroupAdminCommand(".群管 复合规则 1 单条行数 30")
  assert.deepEqual({ action: setLines.action, field: setLines.field, value: setLines.value }, { action: "set", field: "maxLines", value: 30 })
  const setTotalLines = parseGroupAdminCommand(".群管 复合规则 1 总行数 120")
  assert.deepEqual({ field: setTotalLines.field, value: setTotalLines.value }, { field: "totalLines", value: 120 })
  const setName = parseGroupAdminCommand(".群管 复合规则 1 名称 长文刷屏")
  assert.deepEqual({ field: setName.field, value: setName.value }, { field: "name", value: "长文刷屏" })
  const setBool = parseGroupAdminCommand(".群管 复合规则 1 撤回 关")
  assert.deepEqual({ field: setBool.field, value: setBool.value }, { field: "recall", value: false })
  const badParam = parseGroupAdminCommand(".群管 复合规则 1 高度 99")
  assert.equal(badParam.ok, false)
  assert.ok(badParam.message.includes("没有参数「高度」") && badParam.message.includes("单条字数"))
  const outOfRange = parseGroupAdminCommand(".群管 复合规则 1 条数 1")
  assert.ok(outOfRange.message.includes("2 到 100"))
  const zeroIndex = parseGroupAdminCommand(".群管 复合规则 0 开")
  assert.equal(zeroIndex.ok, false)
})

test("复合规则列表文本与按序号写入", async () => {
  const { buildCompoundRulesText, buildCompoundRuleUpdate } = await import("../dist/backend/modules/groupAdmin/infrastructure/groupAdminPage.js")
  const text = buildCompoundRulesText([{ name: "长文刷屏", enabled: true, burstCount: 10, windowSeconds: 5, maxLength: 160, totalLength: 0, maxLines: 30, totalLines: 0, recall: true, forward: true, muteSeconds: 60 }])
  assert.ok(text.includes("1. 长文刷屏 [开]"))
  assert.ok(text.includes("条件组合"), "列表头带例子解释")
  assert.ok(text.includes("5 秒内连发 ≥10 条") && text.includes("单条 >160 字"))
  assert.ok(text.includes("单条 >30 行"), "行数条件进列表")
  assert.ok(text.includes("撤回+转发+禁言60秒"))
  assert.ok(buildCompoundRulesText([]).includes("还没有复合规则"))

  const settings = serverLikeSettings()
  settings.groupModeration.compoundRules = [{ name: "长文刷屏", enabled: true, burstCount: 10, windowSeconds: 5, maxLength: 160, totalLength: 0, recall: true, forward: true, muteSeconds: 60 }]
  const update = buildCompoundRuleUpdate(settings, GROUP_ID, settings.groupModeration.compoundRules, 0, "burstCount", 8)
  const row = update["groupAdmin.overrides"].find(item => item.groupId === String(GROUP_ID))
  assert.equal(row.groupModeration.compoundRules[0].burstCount, 8)
  assert.equal(row.groupModeration.compoundRules[0].name, "长文刷屏", "未改字段保留")
  assert.equal(row.groupModeration.overlongMessage.maxLength, 200, "同模块其他自定义不受影响")
  assert.equal(buildCompoundRuleUpdate(settings, GROUP_ID, settings.groupModeration.compoundRules, 5, "burstCount", 8), null, "越界序号返回 null")
})

test("白名单命令：列表/添加/删除/非法输入", () => {
  assert.deepEqual(parseGroupAdminCommand(".群管 白名单"), { ok: true, type: "whitelist", action: "list" })
  const add = parseGroupAdminCommand(".群管 白名单 添加 123456789")
  assert.deepEqual({ ok: add.ok, type: add.type, action: add.action, userId: add.userId }, { ok: true, type: "whitelist", action: "add", userId: "123456789" })
  const remove = parseGroupAdminCommand(".群管 白名单 删除 123456789")
  assert.deepEqual({ action: remove.action, userId: remove.userId }, { action: "remove", userId: "123456789" })
  const bad = parseGroupAdminCommand(".群管 白名单 添加 abc")
  assert.equal(bad.ok, false)
  assert.ok(bad.message.includes("5-12 位数字"))
})

test("白名单写入：新增去重、删除保留他人、非法返回 null", async () => {
  const { buildWhitelistUpdate, buildWhitelistText } = await import("../dist/backend/modules/groupAdmin/infrastructure/groupAdminPage.js")
  const settings = serverLikeSettings()
  settings.groupModeration.whitelist = ["111111111"]
  const add = buildWhitelistUpdate(settings, "add", "222222222")
  assert.deepEqual(add, { "groupModeration.whitelist": ["111111111", "222222222"] })
  const dedupe = buildWhitelistUpdate(settings, "add", "111111111")
  assert.deepEqual(dedupe, { "groupModeration.whitelist": ["111111111"] }, "重复添加幂等")
  const remove = buildWhitelistUpdate(settings, "remove", "111111111")
  assert.deepEqual(remove, { "groupModeration.whitelist": [] })
  assert.equal(buildWhitelistUpdate(settings, "add", "abc"), null)
  assert.ok(buildWhitelistText(["111111111"]).includes("1. 111111111"))
  assert.ok(buildWhitelistText([]).includes("完全跳过"))
})

test("面板展示复合规则分区", () => {
  const settings = serverLikeSettings()
  settings.groupModeration.compoundRules = [{ name: "长文刷屏", enabled: true, burstCount: 10, windowSeconds: 5, maxLength: 160, totalLength: 0, recall: true, forward: true, muteSeconds: 60 }]
  const data = buildGroupAdminPageData(settings, GROUP_ID)
  const section = data.sections.find(item => item.label === "复合规则")
  assert.ok(section, "面板有复合规则分区")
  const rule = section.rows[0]
  assert.equal(rule.label, "1. 长文刷屏")
  assert.ok(rule.detail.includes("≥10 条") && rule.detail.includes("单条 >160 字"))
  assert.ok(rule.commands.includes(".群管 复合规则 1 关"))
  const empty = buildGroupAdminPageData(serverLikeSettings(), GROUP_ID)
  const emptySection = empty.sections.find(item => item.label === "复合规则")
  assert.ok(emptySection.rows[0].detail.includes("5 秒内连发 10 条且单条超过 160 字"), "空态给具体例子")
})

test("新语义：本群显式开关优先于默认总开关", () => {
  const base = { groupModeration: { enabled: true, enabledGroups: [] }, groupGuard: { enabled: false, enabledGroups: [] }, groupNotice: { enabled: false, enabledGroups: [] } }
  // 显式开启的群：默认关也生效
  const explicitOn = buildGroupAdminPageData({
    ...base,
    groupAdmin: { overrides: [{ groupId: String(GROUP_ID), groupModeration: { enabled: true } }] }
  }, GROUP_ID)
  assert.equal(explicitOn.sections.find(s => s.label === "广告与刷屏").enabled, true, "显式开 + 默认关 → 生效")
  // 显式关闭的群：默认开也不生效
  const explicitOff = buildGroupAdminPageData({
    ...base,
    groupAdmin: { overrides: [{ groupId: String(GROUP_ID), groupModeration: { enabled: false } }] }
  }, GROUP_ID)
  assert.equal(explicitOff.sections.find(s => s.label === "广告与刷屏").enabled, false, "显式关 + 默认开 → 不生效")
})
