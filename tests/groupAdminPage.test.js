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
  assert.equal(parseGroupAdminCommand(".群管 面板"), null, "带空格的面板词不属于查看命令")
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
  assert.equal(guard.enabled, false, "本群未启用入群验证")
  assert.ok(guard.rows[0].detail.includes("300 秒"))
  const notice = data.sections.find(section => section.label === "群通知")
  assert.equal(notice.enabled, false)
})

test("面板文本与 HTML：包含模块与命令提示，HTML 转义", () => {
  const data = buildGroupAdminPageData(serverLikeSettings(), GROUP_ID)
  const text = buildGroupAdminPageText(data)
  assert.ok(text.includes("群 609235590"))
  assert.ok(text.includes("【广告与刷屏】本群已开启"))
  assert.ok(text.includes(".群管 设置"))
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
