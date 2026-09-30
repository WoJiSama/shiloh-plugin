import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DiceManager } from "../domains/dice/DiceManager.js"
import { executeDiceCommand, getCustomDiceCommandGate, getDiceCommandGate, startsWithMentionOfOtherMember } from "../domains/dice/diceCommandGateway.js"
import { secureDiceInt, secureDiceRandom } from "../utils/diceRandom.js"

function createRuntime(overrides = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dice-core-test-"))
  const pluginDir = path.join(cwd, "plugins", "shiloh-plugin")
  fs.mkdirSync(path.join(pluginDir, "config_default"), { recursive: true })
  fs.writeFileSync(path.join(pluginDir, "config_default", "message.yaml"), [
    "pluginSettings:",
    "  diceSystem:",
    `    enabled: ${overrides.enabled === false ? "false" : "true"}`,
    `    logAiSilent: ${overrides.logAiSilent === false ? "false" : "true"}`,
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
    // 开启提示必须告诉群友怎么结束，否则静默期间无从恢复 AI 对话
    const logStartedText = await runtime.manager.startLog(admin, "测试团")
    assert.match(logStartedText, /已开启/)
    assert.match(logStartedText, /\.log end|\.log off/)
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
    assert.equal(runtime.manager.isLogRecording(e.group_id), true)
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

test("active log remains detectable for text preservation when AI silence is disabled", async () => {
  const runtime = createRuntime({ logAiSilent: false })
  try {
    const e = event("admin", { msg: ".log new 文本团录" })
    await runtime.manager.startLog(e, "文本团录")
    assert.equal(runtime.manager.isLogActive(e.group_id), false, "AI 对话不因 log 静默")
    assert.equal(runtime.manager.isLogRecording(e.group_id), true, "回复仍需保留为可记录文本")
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

test("st and check outcome templates control the sent text", async () => {
  const runtime = createRuntime()
  try {
    const pluginDir = path.join(runtime.cwd, "plugins", "shiloh-plugin")
    fs.mkdirSync(path.join(pluginDir, "config"), { recursive: true })
    fs.writeFileSync(path.join(pluginDir, "config", "message.yaml"), [
      "pluginSettings:",
      "  diceSystem:",
      "    enabled: true",
      "    templates:",
      '      check: "DEFAULT {level}"',
      '      check_fail: "FAIL {roll}/{target} {skill}"',
      '      check_fumble: "FUMBLE {skill}"',
      '      cardSaved: "SAVED {updates}"',
      '      card: "CARD {name}"'
    ].join("\n"))
    const e = event()
    assert.match(await runtime.manager.handleSt(e, "侦查=60"), /SAVED 侦查=60/)
    assert.match(await runtime.manager.handleSt(e, "show"), /CARD 调查员/)

    runtime.manager.rollD100 = () => ({ value: 80, diceText: "1D100" })
    assert.match(runtime.manager.handleCheck(e, "侦查 60"), /FAIL 80\/60 侦查/)

    runtime.manager.rollD100 = () => ({ value: 100, diceText: "1D100" })
    assert.match(runtime.manager.handleCheck(e, "侦查 60"), /FUMBLE 侦查/)

    runtime.manager.rollD100 = () => ({ value: 40, diceText: "1D100" })
    assert.match(runtime.manager.handleCheck(e, "侦查 60"), /DEFAULT 成功/)
  } finally {
    runtime.cleanup()
  }
})

test("empty outcome templates fall back to the default check template", () => {
  const runtime = createRuntime()
  try {
    const pluginDir = path.join(runtime.cwd, "plugins", "shiloh-plugin")
    fs.mkdirSync(path.join(pluginDir, "config"), { recursive: true })
    fs.writeFileSync(path.join(pluginDir, "config", "message.yaml"), [
      "pluginSettings:",
      "  diceSystem:",
      "    enabled: true",
      "    templates:",
      '      check: "DEFAULT {level} {roll}"',
      '      check_fail: ""'
    ].join("\n"))
    runtime.manager.rollD100 = () => ({ value: 80, diceText: "1D100" })
    assert.match(runtime.manager.handleCheck(event(), "侦查 60"), /DEFAULT 失败 80/)
  } finally {
    runtime.cleanup()
  }
})

test("multi-round checks render one line per round with the base template and cap at maxRounds", () => {
  const runtime = createRuntime()
  try {
    const pluginDir = path.join(runtime.cwd, "plugins", "shiloh-plugin")
    fs.mkdirSync(path.join(pluginDir, "config"), { recursive: true })
    fs.writeFileSync(path.join(pluginDir, "config", "message.yaml"), [
      "pluginSettings:",
      "  diceSystem:",
      "    enabled: true",
      "    maxRounds: 5",
      "    templates:",
      '      check: "{name} {skill} {roll}/{target} {level}"',
      '      check_fail: "FAIL {roll}/{target} {skill}"'
    ].join("\n"))
    let seq = 0
    runtime.manager.rollD100 = () => { seq += 1; return { value: 10 * seq, diceText: "1D100" } }
    const three = runtime.manager.handleCheck(event(), "今天开团 60", { rounds: 3 })
    const lines = three.split("\n")
    assert.equal(lines.length, 3)
    assert.match(lines[0], /调查员 今天开团 10\/60/)
    assert.match(lines[2], /调查员 今天开团 30\/60/)
    // 多轮必须用基础模板，不逐轮套 check_fail 吐槽
    assert.ok(lines.every(line => !line.includes("FAIL")))
    // 轮数超过 maxRounds 被封顶
    const capped = runtime.manager.handleCheck(event(), "侦查 60", { rounds: 99 })
    assert.equal(capped.split("\n").length, 5)
    // 参数区 3# 前缀同样进入多轮，且不污染技能名
    const fromArgs = runtime.manager.handleCheck(event(), "3# 今天开团 60")
    assert.equal(fromArgs.split("\n").length, 3)
    assert.ok(fromArgs.includes("今天开团"))
  } finally {
    runtime.cleanup()
  }
})

test("check parsing resists stray leading numbers hijacking the target", () => {
  const runtime = createRuntime()
  try {
    const parsed = runtime.manager.parseCheckArgs("3 今天开团 60")
    assert.equal(parsed.target, 60)
    assert.equal(parsed.skill, "3 今天开团")
  } finally {
    runtime.cleanup()
  }
})

test("custom level names still drive SAN success and fumble logic", async () => {
  const runtime = createRuntime()
  try {
    const pluginDir = path.join(runtime.cwd, "plugins", "shiloh-plugin")
    fs.mkdirSync(path.join(pluginDir, "config"), { recursive: true })
    fs.writeFileSync(path.join(pluginDir, "config", "message.yaml"), [
      "pluginSettings:",
      "  diceSystem:",
      "    enabled: true",
      "    checkLevels:",
      "      success: 过了",
      "      fail: 没过",
      "      fumble: 炸了",
      "      critical: 神了",
      "      extreme: 极难过了",
      "      hard: 困难过了"
    ].join("\n"))
    await runtime.manager.handleSt(event(), "SAN=60")
    runtime.manager.rollD100 = () => ({ value: 80, diceText: "1D100" })
    const fail = await runtime.manager.handleSan(event(), "1/1d3")
    assert.match(fail, /没过/)
    runtime.manager.rollD100 = () => ({ value: 100, diceText: "1D100" })
    const fumble = await runtime.manager.handleSan(event(), "1/1d3")
    assert.match(fumble, /炸了/)
  } finally {
    runtime.cleanup()
  }
})

test("跑团 log 提示文案走模板，可在配置里改实际发送的话", async () => {
  const runtime = createRuntime()
  const admin = event("admin")
  try {
    const started = await runtime.manager.startLog(admin, "模板团")
    assert.match(started, /跑团 log 已开启：模板团/)
    assert.match(started, /\.log end|\.log off/)
    // 覆盖模板后，群里实际发送的就是覆盖后的文案
    const base = runtime.manager.getConfig()
    runtime.manager.getConfig = () => ({
      ...base,
      enabled: true,
      templates: { ...base.templates, logStarted: "开团啦：{title}，AI 先闭嘴咯", logStopped: "收工：{title}" }
    })
    await runtime.manager.stopLog(admin)
    assert.equal(await runtime.manager.startLog(admin, "自定义团"), "开团啦：自定义团，AI 先闭嘴咯")
    assert.equal(await runtime.manager.stopLog(admin), "收工：自定义团")
  } finally {
    runtime.cleanup()
  }
})

test("海豹扩展顶级命令(.dd)能过门禁：启用回执宣传的短名必须可用", () => {
  const ruleManager = {
    findInvocation: () => null,
    matchesSealExtCommand: (groupId, message) => String(message || "").startsWith(".dd")
  }
  const manager = {
    getConfig: () => ({ enabled: true, customRulesEnabled: true }),
    isReplyEnabled: () => true
  }
  const gate = getCustomDiceCommandGate({ manager, ruleManager, e: { group_id: "1", msg: ".dd help" } })
  assert.equal(gate.matched, true, "seal-ext 顶级命令应视为规则包命令")
  assert.equal(gate.allowed, true)
  assert.equal(gate.consume, true)
  // 未注册的命令仍然不吞消息
  assert.equal(getCustomDiceCommandGate({ manager, ruleManager, e: { group_id: "1", msg: ".zzz" } }).matched, false)
  // 两段式包名调用仍走 findInvocation 原路径
  assert.equal(getCustomDiceCommandGate({ manager, ruleManager, e: { group_id: "1", msg: ".team show" } }).matched, false)
  // 模块关闭时顶级命令也要被拦下并提示
  const disabled = { getConfig: () => ({ enabled: false, customRulesEnabled: true }), isReplyEnabled: () => true }
  assert.equal(getCustomDiceCommandGate({ manager: disabled, ruleManager, e: { group_id: "1", msg: ".dd help" } }).response, "骰娘模块现在没开。")
})

test("jrrp 分数段评语按分值落段，模板带 {comment}", async () => {
  const runtime = createRuntime()
  try {
    const text = runtime.manager.handleJrrp({ user_id: 42, sender: { nickname: "阿七" } })
    assert.match(text, /阿七 今日人品：\d+\n.+/)
    // 自定义段文案会出现在实际发送里
    const base = runtime.manager.getConfig()
    runtime.manager.getConfig = () => ({
      ...base,
      templates: { ...base.templates, jrrp: "{name} 人品 {value} 「{comment}」" },
      jrrpComments: ["a", "b", "c", "d", "e", "f"]
    })
    const custom = runtime.manager.handleJrrp({ user_id: 42, sender: { nickname: "阿七" } })
    assert.match(custom, /人品 \d+ 「[a-f]」/)
  } finally {
    runtime.cleanup()
  }
})

test("紧凑中文 .st(无分隔符)逐段解析:敏捷0力量-1生命6 全部正确落卡", async () => {
  const runtime = createRuntime()
  try {
    const e = event()
    const text = "敏捷0力量-1本能0知识2风度3灵巧1生命6生命上限6压力0压力上限6希望0希望上限6护甲0护甲上限3"
    const reply = await runtime.manager.handleSt(e, text)
    const card = runtime.manager.readState(runtime.manager.getConfig()).users[String(e.user_id)]
    const active = card.cards[card.activeCard]
    const all = { ...active.attrs, ...active.skills }
    assert.equal(all["DEX"], 0, "敏捷走别名 DEX")
    assert.equal(all["STR"], -1, "力量负值紧凑格式正确(别名 STR)")
    assert.equal(all["本能"], 0)
    assert.equal(all["知识"], 2)
    assert.equal(all["风度"], 3)
    assert.equal(all["灵巧"], 1)
    assert.equal(all["生命"], 6, "非别名中文属性记入 skills")
    assert.equal(all["生命上限"], 6)
    assert.equal(all["压力"], 0)
    assert.equal(all["压力上限"], 6)
    assert.equal(all["希望"], 0)
    assert.equal(all["希望上限"], 6)
    assert.equal(all["护甲"], 0)
    assert.equal(all["护甲上限"], 3)
    assert.match(String(reply), /更新|人物卡/)
  } finally {
    runtime.cleanup()
  }
})

test("comparison suffix counts per-die successes with marks", () => {
  const runtime = createRuntime()
  try {
    const roll = (expr, values) => {
      const it = values[Symbol.iterator]()
      return runtime.manager.rollExpression(expr, runtime.manager.getConfig(), () => it.next().value)
    }
    const under = roll("3d100<60", [0.22, 0.71, 0.45])
    assert.equal(under.total, "成功 2/3")
    assert.equal(under.expr, "3D100<60")
    assert.equal(under.detail, "3D100[23✓+72✗+46✓]")

    const over = roll("6d6>4", [0.16, 0.83, 0.66, 0.99, 0.0, 0.5])
    assert.equal(over.total, "成功 2/6")
    assert.equal(over.detail, "6D6[1✗+5✓+4✗+6✓+1✗+4✗]")

    // <= 边界：60 算成功，61 算失败
    assert.equal(roll("1d100<=60", [0.599]).total, "成功 1/1")
    assert.equal(roll("1d100<=60", [0.6]).total, "成功 0/1")

    // kh 修饰：判定作用在保留的骰子上
    const kept = roll("4d6kh3>=4", [0.66, 0.83, 0.16, 0.5])
    assert.equal(kept.total, "成功 3/3")
    assert.match(kept.detail, /=>4✓\+4✓\+5✓/)

    // 无骰子时对总数判定一次
    assert.equal(roll("10<60", []).total, "成功 1/1")
    // 普通表达式不受影响
    assert.equal(roll("1d100", [0.42]).total, 43)
    assert.equal(roll("1d100", [0.42]).detail, "1D100[43]")
  } finally {
    runtime.cleanup()
  }
})

test("aN suffix sugar counts dice above N and full-width operators normalize", () => {
  const runtime = createRuntime()
  try {
    const roll = (expr, values) => {
      const it = values[Symbol.iterator]()
      return runtime.manager.rollExpression(expr, runtime.manager.getConfig(), () => it.next().value)
    }
    const sugar = roll("6d6a4", [0.16, 0.83, 0.66, 0.99, 0.0, 0.5])
    assert.equal(sugar.total, "成功 2/6")
    assert.equal(sugar.expr, "6D6>4")
    assert.equal(sugar.detail, "6D6[1✗+5✓+4✗+6✓+1✗+4✗]")

    // 全角＜（手机输入法）经归一化后同样可用
    const fullwidth = roll("3d100＜60", [0.22, 0.71, 0.45])
    assert.equal(fullwidth.total, "成功 2/3")
    assert.equal(fullwidth.expr, "3D100<60")

    // 比较符后无数字仍是格式错误；糖不吞 kh 等既有修饰符
    assert.throws(() => runtime.manager.rollExpression("1d100<", runtime.manager.getConfig()), /格式不正确/)
    const plain = roll("2d6kh1", [0.9, 0.1])
    assert.equal(plain.detail, "2D6KH1[6+1=>6]")
  } finally {
    runtime.cleanup()
  }
})

test("handleWw rejects sub-8 again thresholds with counting guidance instead of rolling", () => {
  const runtime = createRuntime()
  try {
    const e = { group_id: "1", user_id: "9", sender: { card: "探针" } }
    const mislead = runtime.manager.handleWw(e, "6a4")
    assert.ok(!mislead.includes("WoD 骰池"), "无效再骰线不应掷骰")
    assert.match(mislead, /WoD 没有 4-again/)
    assert.match(mislead, /\.r 6d10>4/)
    assert.match(mislead, /\.help ww/)
    const normal = runtime.manager.handleWw(e, "10a10")
    assert.match(normal, /WoD 骰池/)
  } finally {
    runtime.cleanup()
  }
})

test("showHelp supports topic filtering with extended system docs", () => {
  const runtime = createRuntime()
  try {
    const ww = runtime.manager.showHelp("ww")
    assert.match(ww, /WoD 黑暗世界骰池/)
    assert.ok(!ww.includes(".r[表达式]"), "主题帮助不应混入全量内容")
    const dx = runtime.manager.showHelp("dx")
    assert.match(dx, /DX 暴击链/)
    const alias = runtime.manager.showHelp("WOD")
    assert.match(alias, /WoD 黑暗世界骰池/)
    const ra = runtime.manager.showHelp("ra")
    assert.match(ra, /【ra 相关命令】/)
    assert.match(ra, /COC 检定/)
    assert.ok(!ra.includes(".log new"), "ra 主题不应包含 log 行")
    const unknown = runtime.manager.showHelp("不存在的主题xyz")
    assert.match(unknown, /没有找到「不存在的主题xyz」/)
    assert.match(unknown, /COC 骰娘/, "未知主题回退全量帮助")
    const full = runtime.manager.showHelp("")
    assert.match(full, /COC 骰娘/)
  } finally {
    runtime.cleanup()
  }
})

test("official default skills judge without recording; unknown skills roll with a hint", async () => {
  const runtime = createRuntime()
  try {
    runtime.manager.rollD100 = () => ({ value: 42, diceText: "1D100" })
    // sealdice coc7 内置默认值：侦查 25、格斗 5——未录卡也按默认判档
    assert.match(runtime.manager.handleCheck(event(), "侦查"), /42\/25 失败/)
    assert.match(runtime.manager.handleCheck(event(), "格斗"), /42\/5 失败/)
    // 卡值优先于默认值
    const e = event()
    await runtime.manager.handleSt(e, "格斗=90")
    runtime.manager.rollD100 = () => ({ value: 42, diceText: "1D100" })
    assert.match(runtime.manager.handleCheck(e, "格斗"), /42\/90 困难成功/)
    // 完全未知的自造技能：照掷不判档，并提示录入
    const rolled = runtime.manager.handleCheck(event(), "自创魂印")
    assert.match(rolled, /进行 自创魂印 检定：1D100=42（未录卡值，不判档位；录入：\.st 自创魂印 60/)
    const bare = runtime.manager.handleCheck(event(), "")
    assert.match(bare, /进行 检定：1D100=42/)
    assert.ok(!bare.includes("进行 检定 检定"), "空参不应出现重复的检定词")
    // 派生默认：闪避=敏捷/2（录了 DEX 才生效）；修正后缀 侦查+10=25+10
    await runtime.manager.handleSt(e, "DEX 70")
    runtime.manager.rollD100 = () => ({ value: 42, diceText: "1D100" })
    assert.match(runtime.manager.handleCheck(e, "闪避"), /42\/35 失败/)
    assert.match(runtime.manager.handleCheck(event(), "侦查+10"), /42\/35 失败/)
    assert.match(runtime.manager.handleCheck(event(), "侦查 20+10"), /42\/30 失败/)
  } finally {
    runtime.cleanup()
  }
})

test("bot quit requires a leading @bot mention plus admin permission", async () => {
  const runtime = createRuntime()
  try {
    const api = []
    const base = {
      group_id: "4321",
      user_id: "55",
      sender: { card: "群主", role: "owner" },
      bot: { uin: "10001", sendApi: async (action, params) => { api.push({ action, params }); return { retcode: 0 } } },
      reply: async text => text
    }
    const atBot = [{ type: "at", data: { qq: "10001" } }, { type: "text", data: { text: ".bot off" } }]
    const atOther = [{ type: "at", data: { qq: "99999" } }, { type: "text", data: { text: ".bot off" } }]

    // 裸命令：不退群，给引导
    const bare = await runtime.manager.handleBotControl({ ...base, msg: ".bot off" }, "off")
    assert.match(bare, /退群命令需要先艾特我/)
    assert.equal(api.length, 0)

    // @机器人 + 管理员：告别并调用退群 API
    const quit = await runtime.manager.handleBotControl({ ...base, msg: ".bot off", message: atBot }, "off")
    assert.equal(quit, "")
    assert.deepEqual(api, [{ action: "set_group_leave", params: { group_id: 4321 } }])

    // @机器人但普通成员：权限拒绝且不退
    api.length = 0
    const denied = await runtime.manager.handleBotControl({ ...base, msg: ".bot off", message: atBot, sender: { card: "路人", role: "member" } }, "off")
    assert.match(denied, /只有主人或群主\/管理员/)
    assert.equal(api.length, 0)

    // 艾特别人：不构成退群指令
    api.length = 0
    const other = await runtime.manager.handleBotControl({ ...base, msg: ".bot off", message: atOther }, "off")
    assert.match(other, /退群命令需要先艾特我/)
    assert.equal(api.length, 0)
  } finally {
    runtime.cleanup()
  }
})

test("dice results are recorded into the active log and styled in html export", async () => {
  const runtime = createRuntime()
  try {
    const e = event("owner")
    // 未开 log：不记录
    await runtime.manager.recordDiceResult(e, "调查员 进行 侦查 检定：1D100=10/60 大成功")
    // 开 log：命令消息 + 结果成对入档
    await runtime.manager.startLog(e, "结果团")
    await runtime.manager.recordLogMessage({ msg: ".ra 侦查 60", group_id: "10001", user_id: "20002", sender: { card: "调查员" } })
    await runtime.manager.recordDiceResult(e, "调查员 进行 侦查 检定：1D100=10/60 大成功")
    await runtime.manager.recordDiceResult(e, "调查员 掷骰：1D100=100")
    await runtime.manager.stopLog(e)
    const state = runtime.manager.readState()
    const file = state.groups["10001"].logs?.[0]?.file || state.groups["10001"].log?.file
    const lines = runtime.manager.readLogLines(file)
    assert.equal(lines.length, 3)
    assert.equal(lines[0].content, ".ra 侦查 60")
    assert.equal(lines[1].type, "dice_result")
    assert.equal(lines[1].name, "调查员")
    assert.match(lines[1].content, /大成功/)
    assert.equal(lines[2].type, "dice_result")
    // HTML 染色
    const html = runtime.manager.buildLogHtml({ title: "t", startedAt: "x" }, lines)
    assert.ok(html.includes("dice-crit"), "大成功应绿色高亮")
    assert.ok(html.includes("🎲 调查员"), "结果行带骰子标记")
    const fumble = runtime.manager.buildLogHtml({ title: "t" }, [{ at: "2026-09-28T00:00:00Z", name: "甲", userId: "1", type: "dice_result", content: "SAN Check 大失败" }])
    assert.ok(fumble.includes("dice-fumble"), "大失败应红色高亮")
  } finally {
    runtime.cleanup()
  }
})

test("sn with a non-template name sets the dice nickname and syncs the group card", async () => {
  const runtime = createRuntime()
  try {
    const api = []
    const e = event("member", {
      group_id: "10001",
      bot: { sendApi: async (action, params) => { api.push({ action, params }); return { retcode: 0 } } }
    })
    const reply = await runtime.manager.handleSn(e, "coc")
    assert.match(reply, /骰娘昵称已设置为：coc，群名片已同步/)
    assert.deepEqual(api, [{ action: "set_group_card", params: { group_id: 10001, user_id: 20002, card: "coc" } }])
    const state = runtime.manager.readState()
    assert.equal(state.users["20002"].nickname, "coc")
    // on/off 语义不变
    const status = await runtime.manager.handleSn(e, "")
    assert.match(status, /自动群名片：关闭/)
  } finally {
    runtime.cleanup()
  }
})

test("sealdice sc/en/rav parity: single arg, bp dice, custom growth, two-skill opposed", async () => {
  const runtime = createRuntime()
  try {
    const api = []
    const e = event("owner", {
      group_id: "10001",
      bot: { sendApi: async (action, params) => { api.push({ action, params }); return { retcode: 0 } } }
    })
    await runtime.manager.handleSt(e, "san 60")
    // .sc 1d6 单参：成功扣0失败扣1d6；.sc b 0/2 带奖励骰
    runtime.manager.rollD100 = () => ({ value: 90, diceText: "1D100" })
    runtime.manager.rollExpression = expr => ({ total: expr.includes("d") ? 4 : Number(expr) || 0 })
    assert.match(await runtime.manager.handleSan(e, "1d6"), /SAN Check：1D100=90\/60 失败，理智损失 4/)
    runtime.manager.rollD100 = () => ({ value: 10, diceText: "1D100" })
    assert.match(await runtime.manager.handleSan(e, "1d6"), /理智损失 0/)
    // .en 技能 +失败/成功：失败也按设定成长
    await runtime.manager.handleSt(e, "射击=70")
    runtime.manager.rollD100 = () => ({ value: 60, diceText: "1D100" })
    assert.match(await runtime.manager.handleEn(e, "射击 +1/2"), /成长失败，按 \+失败\/成功 设定增加 2（70→72，已写入人物卡）/)
    runtime.manager.rollD100 = () => ({ value: 80, diceText: "1D100" })
    assert.match(await runtime.manager.handleEn(e, "射击 +1/2"), /成长成功，增加 1（72→73，已写入人物卡）/)
    runtime.manager.rollD100 = () => ({ value: 90, diceText: "1D100" })
    assert.match(await runtime.manager.handleEn(e, "射击 +3"), /成长成功，增加 3（73→76，已写入人物卡）/)
    // .pc rename
    await runtime.manager.handleSt(e, "侦查=60")
    const pc = await runtime.manager.handlePc(e, "new 备用")
    assert.match(await runtime.manager.handlePc(e, "rename 备用 主线卡"), /人物卡已改名：备用 → 主线卡/)
    assert.match(await runtime.manager.handlePc(e, "list"), /主线卡/)
  } finally {
    runtime.cleanup()
  }
})

test("builtin sn templates coc/cocL/dnd build card summary", async () => {
  const runtime = createRuntime()
  try {
    const api = []
    const e = event("member", {
      group_id: "10001",
      bot: { sendApi: async (action, params) => { api.push({ action, params }); return { retcode: 0 } } }
    })
    await runtime.manager.handleSt(e, "san 60")
    await runtime.manager.handleSt(e, "hp 12")
    await runtime.manager.handleSt(e, "hpmax 15")
    await runtime.manager.handleSt(e, "dex 65")
    const applied = await runtime.manager.applyBuiltinCardTemplate(e, "coc")
    assert.equal(applied, "调查员 SAN60 HP12/15 DEX65")
    assert.deepEqual(api.at(-1), { action: "set_group_card", params: { group_id: 10001, user_id: 20002, card: "调查员 SAN60 HP12/15 DEX65" } })
    const lower = await runtime.manager.applyBuiltinCardTemplate(e, "cocL")
    assert.equal(lower, "调查员 san60 hp12/15 dex65")
    const dnd = await runtime.manager.applyBuiltinCardTemplate(e, "dnd")
    assert.equal(dnd, "调查员 HP12/15 AC? DC? PP?")
    assert.equal(await runtime.manager.applyBuiltinCardTemplate(e, "unknown"), null)
  } finally {
    runtime.cleanup()
  }
})

test("组队 system: add/del/ra batch check/draw/call; stat from log; who/ping", async () => {
  const runtime = createRuntime()
  try {
    const e = event("owner", {
      group_id: "10001",
      message: [{ type: "text", data: { text: ".team" } }, { type: "at", data: { qq: "111" } }, { type: "at", data: { qq: "222" } }],
      bot: { uin: "10001" }
    })
    assert.match(await runtime.manager.handleTeam(e, "小队 add"), /已添加 2 名玩家至团队 小队/)
    runtime.manager.rollD100 = () => ({ value: 10, diceText: "1D100" })
    const batch = await runtime.manager.handleTeam(e, "小队 ra 侦查")
    assert.match(batch, /团队 小队 检定 侦查/)
    assert.match(batch, /1D100=10\/25 困难成功/)
    assert.equal((batch.match(/1D100/g) || []).length, 2, "全队每人一次检定")
    assert.match(await runtime.manager.handleTeam(e, "小队 call"), /呼叫 小队：\[CQ:at,qq=111\] \[CQ:at,qq=222\]/)
    assert.match(await runtime.manager.handleTeam(e, "小队 draw 1"), /随机抽取到：\[CQ:at,qq=(111|222)\]/)
    assert.match(await runtime.manager.handleTeam(e, "小队 clear"), /清空了团队 小队/)
    // stat：先造一份带 dice_result 的团录
    await runtime.manager.startLog(e, "统计团")
    await runtime.manager.recordDiceResult(e, "调查员 进行 侦查 检定：1D100=10/60 大成功")
    await runtime.manager.recordDiceResult(e, "调查员 进行 斗殴 检定：1D100=50/60 成功")
    await runtime.manager.recordDiceResult(e, "调查员 SAN Check：1D100=95/60 大失败")
    await runtime.manager.stopLog(e)
    const stat = runtime.manager.handleStat(e, "")
    assert.match(stat, /团录「统计团」检定统计/)
    assert.match(stat, /调查员：检定 3 次，成功 2，大成功 1，大失败 1/)
    // who / ping
    assert.match(runtime.manager.handleWho(e, "甲 乙 丙"), /随机分配结果/)
    assert.match(runtime.manager.handlePing(e), /pong！希洛在线/)
  } finally {
    runtime.cleanup()
  }
})

test("梨骰算符与命运骰（源 dicescript roll.peg _dicePearMod / roll_func.go RollFate）", () => {
  const runtime = createRuntime()
  try {
    const roll = (expr, values) => {
      const it = values[Symbol.iterator]()
      return runtime.manager.rollExpression(expr, runtime.manager.getConfig(), () => it.next().value)
    }
    // d20优势 = 2d20kh1：取两骰中高者
    const adv = roll("d20优势", [0.9, 0.2])
    assert.equal(adv.total, 19)
    assert.equal(adv.detail, "2D20KH1[19+5=>19]")
    // d20劣势 = 2d20kl1：取低者（繁体亦支持）
    const dis = roll("d20劣势", [0.9, 0.2])
    assert.equal(dis.total, 5)
    const advTw = roll("d20優勢", [0.5, 0.8])
    assert.equal(advTw.total, 17)
    // 优势+算术组合
    assert.equal(roll("d20优势+3", [0.9, 0.2]).total, 22)
    // XdYkh 不被优势替换误伤
    assert.equal(roll("3d20kh1", [0.9, 0.2, 0.5]).detail, "3D20KH1[19+5+11=>19]")
    // f：每颗 roll3-2 ∈ {-1,0,1}，符号 -/0/+，默认 4 颗
    const fate = roll("f", [0.0, 0.4, 0.7, 1.0])
    assert.equal(fate.detail, "4F[-0++]")
    assert.equal(fate.total, 1)
    // 3f 支持数量前缀
    const fate3 = roll("3f", [0.7, 0.0, 0.4])
    assert.equal(fate3.detail, "3F[+-0]")
    assert.equal(fate3.total, 0)
    // f 参与算术
    assert.equal(roll("f+1", [0, 0, 0, 0]).total, -3)
  } finally {
    runtime.cleanup()
  }
})
