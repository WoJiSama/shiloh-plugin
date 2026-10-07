import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { fileURLToPath } from "node:url"

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const SETTINGS = {
  defaultBot: "",
  groups: { "111": "A" },
  masters: ["925640859"]
}

function groupEvent({ groupId = "111", userId = "42", botId = "A", role = "member", isMaster = false } = {}) {
  return { group_id: groupId, user_id: userId, self_id: botId, sender: { user_id: userId, role }, isMaster }
}

function privateEvent({ userId = "42", botId = "A", isMaster = false } = {}) {
  return { user_id: userId, self_id: botId, sender: { user_id: userId }, isMaster }
}

test("perm=master:isMaster 或 masters 白名单命中才放行", async () => {
  const { evaluateCommandGate } = await import("../utils/commandGate.js")
  assert.equal(evaluateCommandGate(SETTINGS, groupEvent({ isMaster: true }), { perm: "master" }).allowed, true)
  assert.equal(evaluateCommandGate(SETTINGS, groupEvent({ userId: "925640859" }), { perm: "master" }).allowed, true)
  assert.equal(evaluateCommandGate(SETTINGS, groupEvent(), { perm: "master" }).reason, "not_master")
})

test("perm=admin:群管理/群主/主人放行,普通成员与私聊拒绝", async () => {
  const { evaluateCommandGate } = await import("../utils/commandGate.js")
  assert.equal(evaluateCommandGate(SETTINGS, groupEvent({ role: "admin" }), { perm: "admin" }).allowed, true)
  assert.equal(evaluateCommandGate(SETTINGS, groupEvent({ role: "owner" }), { perm: "admin" }).allowed, true)
  assert.equal(evaluateCommandGate(SETTINGS, groupEvent(), { perm: "admin" }).reason, "not_admin")
  assert.equal(evaluateCommandGate(SETTINGS, privateEvent(), { perm: "admin" }).reason, "not_admin")
  assert.equal(evaluateCommandGate(SETTINGS, privateEvent({ userId: "925640859" }), { perm: "admin" }).allowed, true)
})

test("scope:group/private 互斥,both 都放", async () => {
  const { evaluateCommandGate } = await import("../utils/commandGate.js")
  assert.equal(evaluateCommandGate(SETTINGS, groupEvent(), { scope: "private" }).reason, "wrong_scope")
  assert.equal(evaluateCommandGate(SETTINGS, privateEvent(), { scope: "group" }).reason, "wrong_scope")
  assert.equal(evaluateCommandGate(SETTINGS, groupEvent(), { scope: "both" }).allowed, true)
  assert.equal(evaluateCommandGate(SETTINGS, privateEvent(), { scope: "both" }).allowed, true)
})

test("账号绑定:绑定的群只放行绑定的号,未绑定群放行所有号", async () => {
  const { evaluateCommandGate } = await import("../utils/commandGate.js")
  assert.equal(evaluateCommandGate(SETTINGS, groupEvent({ botId: "B" }), {}).reason, "wrong_bot")
  assert.equal(evaluateCommandGate(SETTINGS, groupEvent({ botId: "A" }), {}).allowed, true)
  assert.equal(evaluateCommandGate(SETTINGS, groupEvent({ groupId: "999", botId: "B" }), {}).allowed, true)
})

test("defaultBot 兜底:未精确绑定的群也只放行兜底号,私聊不受绑定限制", async () => {
  const { evaluateCommandGate } = await import("../utils/commandGate.js")
  const settings = { ...SETTINGS, defaultBot: "A" }
  assert.equal(evaluateCommandGate(settings, groupEvent({ groupId: "999", botId: "B" }), {}).reason, "wrong_bot")
  assert.equal(evaluateCommandGate(settings, groupEvent({ groupId: "999", botId: "A" }), {}).allowed, true)
  assert.equal(evaluateCommandGate(settings, privateEvent({ botId: "B" }), {}).allowed, true)
})

test("无任何绑定时(单号模式)所有事件放行", async () => {
  const { evaluateCommandGate } = await import("../utils/commandGate.js")
  const empty = { defaultBot: "", groups: {}, masters: [] }
  assert.equal(evaluateCommandGate(empty, groupEvent({ botId: "whatever" }), {}).allowed, true)
  assert.equal(evaluateCommandGate(empty, privateEvent({ botId: "whatever" }), {}).allowed, true)
})

test("guardCommand 语义:wrong_bot 放过(consume=false),权限拒绝吞掉(consume=true)", async () => {
  const { guardCommand } = await import("../utils/commandGate.js")
  const pass = guardCommand(groupEvent({ botId: "A" }), { perm: "all" }, { pluginRoot })
  assert.deepEqual({ proceed: pass.proceed, consume: pass.consume }, { proceed: true, consume: false })

  const wrongBot = guardCommand(groupEvent({ botId: "B" }), { perm: "all" }, { pluginRoot: tempRootWith(SETTINGS) })
  assert.deepEqual({ proceed: wrongBot.proceed, consume: wrongBot.consume }, { proceed: false, consume: false })

  const denied = guardCommand(groupEvent(), { perm: "master" }, { pluginRoot: tempRootWith(SETTINGS) })
  assert.deepEqual({ proceed: denied.proceed, consume: denied.consume }, { proceed: false, consume: true })
})

test("config_default/commandGate.yaml 默认为空绑定(单号零影响)", async () => {
  const { getCommandGateSettings } = await import("../utils/commandGate.js")
  const settings = getCommandGateSettings(pluginRoot, { force: true })
  assert.equal(settings.defaultBot, "")
  assert.deepEqual(settings.groups, {})
  assert.deepEqual(settings.masters, [])
})

test("命令门禁已接入 CommandHelp 应用", async () => {
  const source = await import("node:fs").then(fs => fs.readFileSync(path.join(pluginRoot, "apps/CommandHelp.js"), "utf8"))
  assert.match(source, /guardCommand\(/)
})

// 造一个临时插件根目录,写入指定门禁配置,避免污染仓库 config/
function tempRootWith(settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "command-gate-"))
  fs.mkdirSync(path.join(root, "config_default"), { recursive: true })
  fs.writeFileSync(path.join(root, "config_default", "commandGate.yaml"), `
defaultBot: "${settings.defaultBot}"
groups:
${Object.entries(settings.groups).map(([g, b]) => `  "${g}": "${b}"`).join("\n")}
masters:
${settings.masters.map(m => `  - "${m}"`).join("\n")}
`)
  return root
}
