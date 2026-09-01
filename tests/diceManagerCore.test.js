import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DiceManager } from "../utils/DiceManager.js"
import { executeDiceCommand, getCustomDiceCommandGate, getDiceCommandGate, startsWithMentionOfOtherMember } from "../utils/diceCommandGateway.js"
import { secureDiceInt, secureDiceRandom } from "../utils/diceRandom.js"

function createRuntime(overrides = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dice-core-test-"))
  const pluginDir = path.join(cwd, "plugins", "bl-chat-plugin")
  fs.mkdirSync(path.join(pluginDir, "config_default"), { recursive: true })
  fs.writeFileSync(path.join(pluginDir, "config_default", "message.yaml"), [
    "pluginSettings:",
    "  diceSystem:",
    `    enabled: ${overrides.enabled === false ? "false" : "true"}`,
    "    customRulesEnabled: true",
    "    maxDiceCount: 100",
    "    baseDir: data/dice",
    `    timeZone: ${overrides.timeZone || "Asia/Shanghai"}`
  ].join("\n"))
  const warnings = []
  const manager = new DiceManager({
    cwd,
    logger: { warn: message => warnings.push(message), error: message => warnings.push(message), info() {} }
  })
  return { cwd, manager, warnings, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) }
}

function event(role = "member", overrides = {}) {
  return {
    group_id: "10001",
    user_id: "20002",
    sender: { user_id: "20002", card: "调查员", nickname: "Tester", role },
    ...overrides
  }
}

test("ordinary dice use the crypto-backed source and keep injected test randoms", () => {
  const runtime = createRuntime()
  const originalRandom = Math.random
  try {
    Math.random = () => { throw new Error("ordinary dice must not use Math.random") }
    const result = runtime.manager.rollExpression("2d6", runtime.manager.getConfig())
    assert.match(result.detail, /^2D6\[/)
    assert.equal(runtime.manager.rollExpression("1d6", runtime.manager.getConfig(), () => 0).total, 1)
    assert.ok(secureDiceRandom() >= 0 && secureDiceRandom() < 1)
    assert.ok(secureDiceInt(12) >= 1 && secureDiceInt(12) <= 12)
  } finally {
    Math.random = originalRandom
    runtime.cleanup()
  }
})

test("shared command gateway enforces the master switch and catches syntax errors", async () => {
  const disabled = createRuntime({ enabled: false })
  const replies = []
  let called = false
  try {
    const consumed = await executeDiceCommand({
      manager: disabled.manager,
      e: event(),
      commandName: "roll",
      work: () => { called = true },
      reply: text => replies.push(text)
    })
    assert.equal(consumed, true)
    assert.equal(called, false)
    assert.deepEqual(replies, ["骰娘模块现在没开。"])
  } finally {
    disabled.cleanup()
  }

  const enabled = createRuntime()
  try {
    const errors = []
    await executeDiceCommand({
      manager: enabled.manager,
      e: event(),
      commandName: "roll",
      work: () => { throw new Error("骰点表达式在「abc」附近格式不正确") },
      reply: text => errors.push(text)
    })
    assert.match(errors[0], /这条骰娘命令没能执行/)
    assert.match(errors[0], /abc/)
    assert.match(errors[0], /数据不会按成功处理/)
  } finally {
    enabled.cleanup()
  }
})

test("a leading @ other member never lets dice commands consume the message", async () => {
  const runtime = createRuntime()
  try {
    const replies = []
    let called = false
    const addressedToOther = event("admin", {
      msg: ".bot off",
      bot: { uin: "3094088525" },
      message: [
        { type: "at", data: { qq: "30003" } },
        { type: "text", data: { text: " .bot off" } }
      ]
    })

    assert.equal(startsWithMentionOfOtherMember(addressedToOther), true)
    assert.deepEqual(
      getDiceCommandGate({ manager: runtime.manager, e: addressedToOther, commandName: "botControl" }),
      { allowed: false, consume: false, response: "" }
    )
    const consumed = await executeDiceCommand({
      manager: runtime.manager,
      e: addressedToOther,
      commandName: "botControl",
      work: () => { called = true },
      reply: message => replies.push(message)
    })
    assert.equal(consumed, false)
    assert.equal(called, false)
    assert.deepEqual(replies, [])

    const commandThenTarget = event("admin", {
      msg: ".st 力量=60",
      bot: { uin: "3094088525" },
      message: [
        { type: "text", data: { text: ".st " } },
        { type: "at", data: { qq: "30003" } }
      ]
    })
    assert.equal(startsWithMentionOfOtherMember(commandThenTarget), false)
    assert.equal(getDiceCommandGate({ manager: runtime.manager, e: commandThenTarget, commandName: "st" }).allowed, true)

    const ruleManager = { findInvocation: () => ({ pack: { id: "team" } }) }
    assert.deepEqual(
      getCustomDiceCommandGate({ manager: runtime.manager, ruleManager, e: addressedToOther }),
      { matched: false, allowed: false, consume: false, response: "" }
    )
  } finally {
    runtime.cleanup()
  }
})

test("custom rules obey the same master, custom-rule and reply gates", () => {
  const invocation = { pack: { id: "team" } }
  const ruleManager = { findInvocation: (_groupId, message) => message === ".team show" ? invocation : null }
  const disabled = {
    getConfig: () => ({ enabled: false, customRulesEnabled: true }),
    isReplyEnabled: () => true
  }
  assert.deepEqual(
    getCustomDiceCommandGate({ manager: disabled, ruleManager, e: { group_id: "1", msg: ".team show" } }),
    { matched: true, allowed: false, consume: true, response: "骰娘模块现在没开。" }
  )
  const customDisabled = {
    getConfig: () => ({ enabled: true, customRulesEnabled: false }),
    isReplyEnabled: () => true
  }
  assert.match(getCustomDiceCommandGate({ manager: customDisabled, ruleManager, e: { msg: ".team show" } }).response, /自定义骰娘规则包当前没有启用/)
  const silent = {
    getConfig: () => ({ enabled: true, customRulesEnabled: true }),
    isReplyEnabled: () => false
  }
  assert.equal(getCustomDiceCommandGate({ manager: silent, ruleManager, e: { msg: ".team show" } }).consume, true)
  assert.equal(getCustomDiceCommandGate({ manager: silent, ruleManager, e: { msg: ".unknown" } }).matched, false)
})

test("reply off silences commands while reply on remains reachable", async () => {
  const runtime = createRuntime()
  try {
    const admin = event("admin")
    assert.match(await runtime.manager.handleReplyControl(admin, "off"), /已关闭/)
    assert.equal(getDiceCommandGate({ manager: runtime.manager, e: event(), commandName: "roll" }).allowed, false)
    assert.equal(getDiceCommandGate({ manager: runtime.manager, e: admin, commandName: "replyControl" }).allowed, true)
    assert.match(await runtime.manager.handleReplyControl(admin, "on"), /已开启/)
    assert.equal(getDiceCommandGate({ manager: runtime.manager, e: event(), commandName: "roll" }).allowed, true)
  } finally {
    runtime.cleanup()
  }
})

test("ordinary members cannot mutate group-wide dice state", async () => {
  const runtime = createRuntime()
  try {
    const member = event("member")
    assert.match(await runtime.manager.handleReplyControl(member, "off"), /只有主人、群主或管理员/)
    assert.match(await runtime.manager.handleSetOption(member, "d20"), /只有主人、群主或管理员/)
    assert.match(await runtime.manager.handleSetCoc(member, "1"), /只有主人、群主或管理员/)
    assert.match(await runtime.manager.handleInitiative(member, "clear"), /只有主人、群主或管理员/)
    assert.match(await runtime.manager.startLog(member, "测试团"), /只有主人、群主或管理员/)

    const admin = event("admin")
    assert.match(await runtime.manager.handleSetOption(admin, "d20"), /d20/)
    assert.match(await runtime.manager.handleSetCoc(admin, "1"), /已设置/)
    assert.match(await runtime.manager.startLog(admin, "测试团"), /已开启/)
  } finally {
    runtime.cleanup()
  }
})

test("card locks protect edits and deletion without blocking reads", async () => {
  const runtime = createRuntime()
  try {
    const e = event()
    assert.match(await runtime.manager.handleSt(e, "侦查=60"), /人物卡已更新/)
    assert.match(await runtime.manager.handlePc(e, "lock"), /已锁定/)
    assert.match(await runtime.manager.handleSt(e, "侦查=70"), /已锁定/)
    assert.match(await runtime.manager.handlePc(e, "del 默认"), /已锁定/)
    assert.match(await runtime.manager.handleSt(e, "show"), /侦查:60/)
    assert.match(await runtime.manager.handlePc(e, "unlock"), /已解锁/)
    assert.match(await runtime.manager.handleSt(e, "侦查=70"), /侦查=70/)
  } finally {
    runtime.cleanup()
  }
})

test("successful growth writes back only when using the active card value", async () => {
  const runtime = createRuntime()
  try {
    const e = event()
    await runtime.manager.handleSt(e, "侦查=60")
    runtime.manager.rollD100 = () => ({ value: 80, diceText: "1D100" })
    const originalRollExpression = runtime.manager.rollExpression.bind(runtime.manager)
    runtime.manager.rollExpression = expr => expr === "1d10" ? { total: 5, expr: "1D10", detail: "5" } : originalRollExpression(expr)
    const result = await runtime.manager.handleEn(e, "侦查")
    assert.match(result, /60→65/)
    assert.match(result, /已写入人物卡/)
    assert.equal(runtime.manager.getActiveCard(e).skills.侦查, 65)

    const temporary = await runtime.manager.handleEn(e, "急救 20")
    assert.match(temporary, /未修改人物卡/)
    assert.equal(runtime.manager.getActiveCard(e).skills.急救, undefined)
  } finally {
    runtime.cleanup()
  }
})

test("state corruption restores a verified backup instead of overwriting with empty state", async () => {
  const runtime = createRuntime()
  try {
    const config = runtime.manager.getConfig()
    await runtime.manager.writeState({ version: 1, users: { first: { value: 1 } }, groups: {} }, config)
    await runtime.manager.writeState({ version: 1, users: { second: { value: 2 } }, groups: {} }, config)
    const file = runtime.manager.getDataPath(config)
    fs.writeFileSync(file, "{broken", "utf8")
    const recovered = runtime.manager.readState(config)
    assert.equal(recovered.users.first.value, 1)
    assert.equal(recovered.users.second, undefined)
    await runtime.manager.writeState(recovered, config)
    assert.equal(runtime.manager.readState(config).users.first.value, 1)
    assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.startsWith("state.json.corrupt-")), true)
  } finally {
    runtime.cleanup()
  }
})

test("dice date buckets use the configured group timezone", () => {
  const shanghai = createRuntime({ timeZone: "Asia/Shanghai" })
  const utc = createRuntime({ timeZone: "UTC" })
  const instant = new Date("2026-07-24T16:30:00.000Z")
  try {
    assert.equal(shanghai.manager.getTodayKey(instant), "2026-07-25")
    assert.equal(utc.manager.getTodayKey(instant), "2026-07-24")
  } finally {
    shanghai.cleanup()
    utc.cleanup()
  }
})

test("jrrp uses the configured timezone date bucket", () => {
  const runtime = createRuntime({ timeZone: "Pacific/Kiritimati" })
  try {
    let seenConfig = null
    runtime.manager.getTodayKey = (_date, config) => {
      seenConfig = config
      return "2026-07-25"
    }
    assert.match(runtime.manager.handleJrrp(event()), /今日人品/)
    assert.equal(seenConfig.timeZone, "Pacific/Kiritimati")
  } finally {
    runtime.cleanup()
  }
})

test("complete file delivery uses a file URI and never substitutes truncated text", async () => {
  const runtime = createRuntime()
  try {
    const file = path.join(runtime.cwd, "rule.yaml")
    fs.writeFileSync(file, "version: 1\nid: complete-rule\n", "utf8")
    const calls = []
    await runtime.manager.sendCompleteFile({
      friend: { sendFile: async (...args) => calls.push(args) }
    }, file)
    assert.deepEqual(calls, [[`file://${file}`, "rule.yaml"]])
    await assert.rejects(
      runtime.manager.sendCompleteFile({}, file),
      /没有可用的完整文件上传接口/
    )
  } finally {
    runtime.cleanup()
  }
})

test("automatic group cards only report enabled after a verified QQ receipt", async () => {
  const runtime = createRuntime()
  try {
    const calls = []
    const e = event("member", {
      bot: {
        sendApi: async (action, payload) => {
          calls.push({ action, payload })
          return { status: "ok", retcode: 0 }
        }
      }
    })
    assert.match(await runtime.manager.handlePc(e, "new 艾琳"), /艾琳/)
    assert.match(await runtime.manager.handleSn(e, "on"), /已开启/)
    assert.equal(calls[0].action, "set_group_card")
    assert.equal(calls[0].payload.card, "艾琳")
    assert.match(await runtime.manager.handleNn(e, "调查员A"), /群名片已同步/)
    assert.equal(calls.at(-1).payload.card, "调查员A")

    const failed = event("member", { bot: { sendApi: async () => ({ status: "failed", wording: "权限不足" }) } })
    await runtime.manager.handleSn(e, "off")
    assert.match(await runtime.manager.handleSn(failed, "on"), /没有开启.*权限不足/)
    assert.equal(runtime.manager.isAutoCardNameEnabled(runtime.manager.readState(), failed), false)
  } finally {
    runtime.cleanup()
  }
})

test("log export uploads complete text by base64 and keeps historical sessions addressable", async () => {
  const runtime = createRuntime()
  try {
    const uploads = []
    const e = event("admin", {
      message_id: "m1",
      msg: "第一条",
      bot: {
        sendApi: async (action, payload) => {
          uploads.push({ action, payload })
          return { status: "ok", retcode: 0 }
        }
      }
    })
    await runtime.manager.startLog(e, "第一团")
    await runtime.manager.recordLogMessage(e)
    await runtime.manager.stopLog(e)
    await runtime.manager.startLog({ ...e, msg: "第二条" }, "第二团")
    await runtime.manager.recordLogMessage({ ...e, msg: "第二条", message_id: "m2" })
    await runtime.manager.stopLog(e)

    assert.match(runtime.manager.getLogStatus(e), /第一团/)
    const exported = await runtime.manager.exportLog(e, "1")
    assert.equal(exported, "", "成功导出只发送文件，不再补发普通聊天")
    assert.equal(uploads[0].action, "upload_group_file")
    assert.match(uploads[0].payload.file, /^base64:\/\//)
    const decoded = Buffer.from(uploads[0].payload.file.slice("base64://".length), "base64").toString("utf8")
    assert.match(decoded, /# 第一团/)
    assert.match(decoded, /第一条/)
  } finally {
    runtime.cleanup()
  }
})

test("failed log delivery is explicit and never pretends a truncated message is an export", async () => {
  const runtime = createRuntime()
  try {
    const e = event("admin", {
      msg: "需要完整保存的内容",
      bot: { sendApi: async () => { throw new Error("上传通道不可用") } },
      group: { sendFile: async () => { throw new Error("识别URL失败") } }
    })
    await runtime.manager.startLog(e, "失败团")
    await runtime.manager.recordLogMessage(e)
    await runtime.manager.stopLog(e)
    const result = await runtime.manager.exportLog(e)
    assert.match(result, /文件发送失败/)
    assert.match(result, /没有把截断内容当作完整导出/)
    assert.doesNotMatch(result, /需要完整保存的内容/)
  } finally {
    runtime.cleanup()
  }
})

test("DND runtime belongs to the active card and long rest restores recorded slot maxima", async () => {
  const runtime = createRuntime()
  try {
    const e = event()
    assert.match(await runtime.manager.handleDndUtility(e, "ss", "1 1/4"), /1环:1\/4/)
    assert.match(await runtime.manager.handleDndUtility(e, "cast", "1"), /剩余 0\/4/)
    assert.match(await runtime.manager.handleDndUtility(e, "longrest", ""), /恢复到上限/)
    assert.match(await runtime.manager.handleDndUtility(e, "ss", ""), /1环:4\/4/)
    await runtime.manager.handlePc(e, "new 第二角色")
    assert.match(await runtime.manager.handleDndUtility(e, "ss", ""), /未记录/)
    await runtime.manager.handlePc(e, "use 默认")
    assert.match(await runtime.manager.handleDndUtility(e, "ss", ""), /1环:4\/4/)
  } finally {
    runtime.cleanup()
  }
})

test("initiative rolls enter the fixed initiative list instead of requiring manual copy", async () => {
  const runtime = createRuntime()
  try {
    const e = event()
    const result = await runtime.manager.handleInitiativeRoll(e, "+3")
    assert.match(result, /已写入当前群先攻列表/)
    assert.match(await runtime.manager.handleInitiative(e, "list"), /调查员/)
  } finally {
    runtime.cleanup()
  }
})
