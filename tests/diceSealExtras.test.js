import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DiceManager } from "../domains/dice/DiceManager.js"
import { executeDiceCommand, getDiceCommandGate } from "../domains/dice/diceCommandGateway.js"

function createRuntime() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dice-extras-test-"))
  const pluginDir = path.join(cwd, "plugins", "shiloh-plugin")
  fs.mkdirSync(path.join(pluginDir, "config_default"), { recursive: true })
  fs.writeFileSync(path.join(pluginDir, "config_default", "message.yaml"), [
    "pluginSettings:",
    "  diceSystem:",
    "    enabled: true",
    "    customRulesEnabled: true",
    "    maxDiceCount: 100",
    "    baseDir: data/dice",
    "    timeZone: Asia/Shanghai"
  ].join("\n"))
  const warnings = []
  const manager = new DiceManager({
    cwd,
    logger: { warn: message => warnings.push(message), error: message => warnings.push(message), info() {} }
  })
  return { cwd, manager, warnings, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) }
}

function event(overrides = {}) {
  return {
    group_id: "10001",
    user_id: "20002",
    sender: { user_id: "20002", card: "调查员", nickname: "Tester", role: "member" },
    ...overrides
  }
}

test("observer mode: obon suppresses dice commands until oboff", async () => {
  const runtime = createRuntime()
  try {
    const e = event()
    assert.match(await runtime.manager.handleObserve(e, "on"), /已进入旁观模式/)
    assert.equal(runtime.manager.isObserver(e), true)

    const replies = []
    let worked = false
    const consumed = await executeDiceCommand({
      manager: runtime.manager,
      e,
      commandName: "roll",
      work: () => { worked = true },
      reply: text => replies.push(text)
    })
    assert.equal(consumed, true)
    assert.equal(worked, false)
    assert.equal(replies.length, 0, "observer roll must be silent")

    assert.match(await runtime.manager.handleObserve(e, "off"), /已退出旁观/)
    assert.equal(runtime.manager.isObserver(e), false)
    const after = getDiceCommandGate({ manager: runtime.manager, e, commandName: "roll" })
    assert.equal(after.allowed, true)
  } finally {
    runtime.cleanup()
  }
})

test("observer mode: list and admin clear, self commands bypass suppression", async () => {
  const runtime = createRuntime()
  try {
    const member = event()
    const admin = event({ user_id: "30003", sender: { user_id: "30003", card: "群主", role: "owner" } })
    await runtime.manager.handleObserve(member, "on")
    await runtime.manager.handleObserve(admin, "on")
    assert.match(await runtime.manager.handleObserve(event(), "list"), /旁观名单（2 人）/)

    // 旁观者自己仍能操作 ob（豁免名单）
    const gate = getDiceCommandGate({ manager: runtime.manager, e: member, commandName: "observer" })
    assert.equal(gate.allowed, true)
    // 普通成员不能清空
    assert.match(await runtime.manager.handleObserve(member, "clr"), /只有主人、群主或管理员/)
    assert.match(await runtime.manager.handleObserve(admin, "clr"), /旁观名单已清空/)
    assert.equal(runtime.manager.isObserver(member), false)
  } finally {
    runtime.cleanup()
  }
})

test("initiative next: advances in order and wraps to a new round", async () => {
  const runtime = createRuntime()
  try {
    const e = event()
    await runtime.manager.handleInitiative(e, "甲 22")
    await runtime.manager.handleInitiative(e, "乙 15")
    await runtime.manager.handleInitiative(e, "丙 9")
    const first = await runtime.manager.handleInitiative(e, "next")
    assert.match(first, /第1轮：轮到 甲（先攻 22）/)
    assert.match(first, /▶ 1\. 甲 22/)
    const second = await runtime.manager.handleInitiative(e, "next")
    assert.match(second, /第1轮：轮到 乙（先攻 15）/)
    const third = await runtime.manager.handleInitiative(e, "next")
    assert.match(third, /第1轮：轮到 丙（先攻 9）/)
    const wrap = await runtime.manager.handleInitiative(e, "下一回合")
    assert.match(wrap, /第2轮：轮到 甲（先攻 22）/)
    // 清空重置轮次
    await runtime.manager.handleInitiative(event({ sender: { role: "owner", card: "群主" } }), "clr")
    const empty = await runtime.manager.handleInitiative(e, "next")
    assert.match(empty, /先攻列表为空/)
  } finally {
    runtime.cleanup()
  }
})

test("buildLogHtml escapes content and keeps entries", () => {
  const runtime = createRuntime()
  try {
    const html = runtime.manager.buildLogHtml(
      { title: "团<script>", startedAt: "2026-09-28T10:00:00Z" },
      [
        { at: "2026-09-28T10:01:00Z", name: "甲<b>", userId: "1", content: "<i>攻击</i>&\"q\"" },
        { at: "2026-09-28T10:02:00Z", name: "乙", userId: "2", content: "两行\n文本" }
      ]
    )
    assert.ok(html.includes("&lt;script&gt;"))
    assert.ok(html.includes("甲&lt;b&gt;"))
    assert.ok(html.includes("&lt;i&gt;攻击&lt;/i&gt;&amp;&quot;q&quot;"))
    assert.ok(html.includes("white-space: pre-wrap"))
    assert.equal((html.match(/class="msg"/g) || []).length, 2)
  } finally {
    runtime.cleanup()
  }
})

test("exportLog: html token selects the html renderer, selector still works", async () => {
  const runtime = createRuntime()
  try {
    const e = event({ sender: { user_id: "20002", card: "调查员", role: "owner" } })
    await runtime.manager.startLog(e, "html团")
    await runtime.manager.recordLogMessage({ msg: "你好", raw_message: "你好", group_id: "10001", user_id: "20002", sender: { card: "调查员" } })
    const uploads = []
    e.bot = { sendApi: async (action, params) => { uploads.push({ action, name: params?.name }); return { retcode: 0, status: "ok" } } }
    await runtime.manager.exportLog(e, "html")
    assert.equal(uploads.length, 1)
    assert.match(uploads[0].name, /\.html$/)
    // 开第二份团录后，序号选择 + html 组合生效
    await runtime.manager.stopLog(e)
    await runtime.manager.startLog(e, "文本团")
    await runtime.manager.recordLogMessage({ msg: "第二团", raw_message: "第二团", group_id: "10001", user_id: "20002", sender: { card: "调查员" } })
    await runtime.manager.exportLog(e, "1 html")
    assert.match(uploads[1]?.name || "", /\.html$/)
    // 不带格式仍是 txt
    await runtime.manager.exportLog(e, "")
    assert.match(uploads[2]?.name || "", /\.txt$/)
  } finally {
    runtime.cleanup()
  }
})

test("handleLogList shows current and history with counts", async () => {
  const runtime = createRuntime()
  try {
    const e = event({ sender: { role: "owner", card: "群主" } })
    await runtime.manager.startLog(e, "第一章")
    await runtime.manager.recordLogMessage({ msg: "a", raw_message: "a", group_id: "10001", user_id: "20002", sender: { card: "调查员" } })
    await runtime.manager.stopLog(e)
    await runtime.manager.startLog(e, "第二章")
    await runtime.manager.recordLogMessage({ msg: "b", raw_message: "b", group_id: "10001", user_id: "20002", sender: { card: "调查员" } })
    await runtime.manager.stopLog(e)
    const text = runtime.manager.handleLogList(e)
    assert.match(text, /▶ 当前：第二章（已结束，1 条/)
    assert.match(text, /1\. 第一章（已结束，1 条/)
  } finally {
    runtime.cleanup()
  }
})

test("st fmt: group template drives .st show and only admins can set it", async () => {
  const runtime = createRuntime()
  try {
    const member = event()
    const admin = event({ sender: { user_id: "20002", card: "调查员", role: "owner" } })
    await runtime.manager.handleSt(member, "hp 12")
    await runtime.manager.handleSt(member, "san 60")
    assert.match(await runtime.manager.handleSt(member, "fmt HP:{hp} SAN:{san}"), /只有主人、群主或管理员/)
    assert.match(await runtime.manager.handleSt(admin, "fmt HP:{hp} SAN:{san}"), /人物卡模板已保存/)
    assert.match(await runtime.manager.handleSt(member, "show"), /HP:12 SAN:60/)
    assert.ok(!(await runtime.manager.handleSt(member, "show")).includes("技能："), "fmt replaces default card layout")
    assert.match(await runtime.manager.handleSt(member, "fmt"), /当前群人物卡模板：HP:\{hp\} SAN:\{san\}/)
    assert.match(await runtime.manager.handleSt(admin, "fmt clr"), /恢复默认/)
    assert.match(await runtime.manager.handleSt(member, "show"), /属性：/)
  } finally {
    runtime.cleanup()
  }
})

test("en batch: grows each listed skill from the card and reports misses", async () => {
  const runtime = createRuntime()
  try {
    const e = event()
    await runtime.manager.handleSt(e, "侦查 99")
    await runtime.manager.handleSt(e, "斗殴 1")
    runtime.manager.rollD100 = () => ({ value: 50, diceText: "1D100" })
    runtime.manager.rollExpression = () => ({ total: 7 })
    const text = await runtime.manager.handleEn(e, "侦查 斗殴 不存在技能")
    assert.match(text, /侦查 成长检定：1D100=50\/99 成长失败/)
    assert.match(text, /斗殴 成长检定：1D100=50\/1 成长成功，增加 7（1→8，已写入人物卡）/)
    assert.match(text, /不存在技能：找不到技能值/)
    const state = runtime.manager.readState()
    const card = runtime.manager.getActiveCard(e, state)
    assert.equal(card.skills["斗殴"], 8)
    // 带数值的批量应提示不支持而不是乱结算
    assert.match(await runtime.manager.handleEn(e, "侦查 斗殴 60"), /批量成长按人物卡数值结算/)
  } finally {
    runtime.cleanup()
  }
})

test("name: zh/en/jp banks with count cap", async () => {
  const runtime = createRuntime()
  try {
    const zh = runtime.manager.handleName(event(), "")
    assert.match(zh, /随机姓名（中文）：[\u4e00-\u9fa5]{2,3}(、[\u4e00-\u9fa5]{2,3}){4}/)
    const en = runtime.manager.handleName(event(), "en 3")
    assert.match(en, /随机姓名（英文）：[A-Za-z]+ [A-Za-z]+(、[A-Za-z]+ [A-Za-z]+){2}/)
    const jp = runtime.manager.handleName(event(), "jp 2")
    assert.match(jp, /随机姓名（日文）：/)
    const capped = runtime.manager.handleName(event(), "99")
    assert.equal((capped.match(/、/g) || []).length, 19, "count capped at 20")
  } finally {
    runtime.cleanup()
  }
})
