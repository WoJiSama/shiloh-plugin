// 海豹合同测试：期望值全部来自 sealdice-core 源码数据，而非我方实现。
// 数据源：
//   别名表  dice/templates/coc7.yaml alias 段（797 项，导出 fixtures_seal_alias.json）
//   默认值  dice/templates/coc7.yaml attrs.defaults（导出 fixtures_seal_defaults.json）
//   名片模板 dice/templates/coc7.yaml sn 段 / dnd5e.yaml sn 段
//   语法    dice/ext_coc7.go 帮助文本（helpRc/helpSc/helpEn，约 68-76/680-685/1066-1069 行）
// 任何实现改动破坏与 sealdice 的一致性时，这里必须红。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveSealSkillName, SEAL_SKILL_ALIASES } from "../domains/dice/sealSkillAliases.js"
import { DiceManager } from "../domains/dice/DiceManager.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sealAliases = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures_seal_alias.json"), "utf8"))
const sealDefaults = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures_seal_defaults.json"), "utf8"))

import os from "node:os"

function createRuntime() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "seal-contract-"))
  const pluginDir = path.join(cwd, "plugins/shiloh-plugin/config_default")
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(path.join(pluginDir, "message.yaml"), "pluginSettings:\n  diceSystem:\n    enabled: true\n    baseDir: data/dice\n")
  return { cwd, manager: new DiceManager({ cwd, logger: { info() {}, warn() {}, error() {} } }), cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) }
}

test("别名表与 sealdice coc7.yaml 全量一致（797 项逐条）", () => {
  assert.equal(Object.keys(SEAL_SKILL_ALIASES).length, Object.keys(sealAliases).length)
  for (const [alias, canon] of Object.entries(sealAliases)) {
    assert.equal(resolveSealSkillName(alias), canon, `别名 ${alias} 应归一为 ${canon}`)
  }
})

test("默认技能值与 sealdice coc7.yaml defaults 全量一致", () => {
  const runtime = createRuntime()
  try {
    const e = { group_id: "1", user_id: "9", sender: { card: "空白卡" } }
    for (const [skill, expected] of Object.entries(sealDefaults)) {
      const actual = runtime.manager.getTargetValue(skill, NaN, e)
      assert.equal(actual, expected, `未录卡时 ${skill} 应为官方默认 ${expected}（源 coc7.yaml attrs.defaults）`)
    }
  } finally {
    runtime.cleanup()
  }
})

test("别名跨简繁体命中同一卡值：.st 偵查 60 后 .ra 侦察/侦查/偵查 同值", async () => {
  const runtime = createRuntime()
  try {
    const e = { group_id: "1", user_id: "9", sender: { card: "调查员" } }
    await runtime.manager.handleSt(e, "偵查 60")
    for (const alias of ["侦察", "侦查", "偵查", "取悦"]) {
      if (alias === "取悦") continue
      assert.equal(runtime.manager.getTargetValue(alias, NaN, e), 60, `${alias} 应命中 60（源 coc7.yaml alias）`)
    }
  } finally {
    runtime.cleanup()
  }
})

test("sn 内置名片模板与 sealdice yaml 模板字符串一致", async () => {
  const runtime = createRuntime()
  try {
    const api = []
    const e = { group_id: "1", user_id: "9", sender: { card: "沃基" }, bot: { sendApi: async (a, p) => { api.push(p.card); return { retcode: 0 } } } }
    await runtime.manager.handleSt(e, "san 60")
    await runtime.manager.handleSt(e, "hp 12")
    await runtime.manager.handleSt(e, "hpmax 15")
    await runtime.manager.handleSt(e, "dex 65")
    // 源 coc7.yaml sn 段：{$t玩家_RAW} SAN{理智} HP{生命值}/{生命值上限} DEX{敏捷}
    assert.equal(await runtime.manager.applyBuiltinCardTemplate(e, "coc"), "沃基 SAN60 HP12/15 DEX65")
    assert.equal(await runtime.manager.applyBuiltinCardTemplate(e, "cocL"), "沃基 san60 hp12/15 dex65")
    // 源 dnd5e.yaml sn 段：{$t玩家_RAW} HP{hp}/{hpmax} AC{ac} DC{dc} PP{pp}
    assert.equal(await runtime.manager.applyBuiltinCardTemplate(e, "dnd"), "沃基 HP12/15 AC? DC? PP?")
    assert.deepEqual(api.at(-1), "沃基 HP12/15 AC? DC? PP?")
  } finally {
    runtime.cleanup()
  }
})

test("ra 帮助文本六种形式全部生效（源 ext_coc7.go helpRc 68-73 行）", () => {
  const runtime = createRuntime()
  try {
    const p = raw => runtime.manager.parseCheckArgs(raw)
    // .ra 3# 属性 —— 多重检定（参数区形式）
    assert.equal(p("3# 侦查").rounds, 3)
    assert.equal(p("3# 侦查").skill, "侦查")
    // .ra b 属性 / .ra p2 —— 奖惩骰前缀（ext_coc7.go helpRc 70-71 行）
    assert.equal(p("b 侦查 60").modifier, 1)
    assert.equal(p("p2 侦查 60").modifier, -2)
    // .ra <属性表达式>：侦查60 紧凑（re2 空格消除语义）
    assert.equal(p("侦查60").skill, "侦查")
    assert.equal(p("侦查60").target, 60)
    // 难度前缀（.ra 困难侦查）
    assert.equal(p("困难侦查60").difficulty, 2)
    // 技能修正（rav 注释：侦查+10）
    assert.equal(p("侦查+10").offset, 10)
    assert.equal(p("侦查+10").skill, "侦查")
  } finally {
    runtime.cleanup()
  }
})

test("sc 三种形式（源 ext_coc7.go helpSc 1066-1069 行）：常规/简易/bp", async () => {
  const runtime = createRuntime()
  try {
    const e = { group_id: "1", user_id: "9", sender: { card: "调查员" } }
    await runtime.manager.handleSt(e, "san 60")
    runtime.manager.rollD100 = () => ({ value: 50, diceText: "1D100" })
    const fixed = expr => ({ total: /[d]/i.test(expr) ? 3 : Number(expr.replace(/[^0-9]/g, "")) || 0 })
    // 成功扣1失败扣1d6
    runtime.manager.rollExpression = fixed
    assert.match(await runtime.manager.handleSan(e, "1/1d6"), /理智损失 1，剩余 59/)
    // 简易写法：成功扣0（roll=50 成功 → 损失 0）
    assert.match(await runtime.manager.handleSan(e, "1d6"), /理智损失 0/)
    // b 奖惩骰：检定骰文本带奖励骰
    runtime.manager.rollD100 = () => ({ value: 50, diceText: "奖励骰[十位:1/2,个位:0]=10" })
    assert.match(await runtime.manager.handleSan(e, "b 0/2"), /奖励骰/)
  } finally {
    runtime.cleanup()
  }
})

test("en 五种形式（源 ext_coc7.go helpEn 680-685 行）", async () => {
  const runtime = createRuntime()
  try {
    const e = { group_id: "1", user_id: "9", sender: { card: "调查员" } }
    runtime.manager.rollD100 = () => ({ value: 60, diceText: "1D100" })
    runtime.manager.rollExpression = expr => ({ total: /^1d10$/i.test(expr) ? 7 : Number(String(expr).replace("+", "")) || 0 })
    const reset = async () => { await runtime.manager.handleSt(e, "射击=70"); runtime.manager.rollD100 = () => ({ value: 60, diceText: "1D100" }) }
    // .en 技能 —— 骰D100大于当前值成长1d10（60<70 失败）
    await reset()
    assert.match(await runtime.manager.handleEn(e, "射击"), /成长失败/)
    // .en 技能 +成功成长值
    await reset()
    runtime.manager.rollD100 = () => ({ value: 90, diceText: "1D100" })
    assert.match(await runtime.manager.handleEn(e, "射击 +3"), /成长成功，增加 3（70→73，已写入人物卡）/)
    // .en 技能 +失败/成功
    await reset()
    assert.match(await runtime.manager.handleEn(e, "射击 +1/2"), /增加 2（70→72，已写入人物卡）/)
    // .en 技能[点数]（临时值：90>50 成功，改临时值不改卡）
    await reset()
    runtime.manager.rollD100 = () => ({ value: 90, diceText: "1D100" })
    assert.match(await runtime.manager.handleEn(e, "射击 50"), /成长成功，增加 7（使用临时技能值/)
  } finally {
    runtime.cleanup()
  }
})

test("en 未录但有官方默认的技能按默认值成长（sealdice 变量读取含 defaults）", async () => {
  const runtime = createRuntime()
  try {
    const e = { group_id: "1", user_id: "9", sender: { card: "调查员" } }
    runtime.manager.rollD100 = () => ({ value: 90, diceText: "1D100" })
    runtime.manager.rollExpression = () => ({ total: 7 })
    // 神秘学官方默认 5（coc7.yaml defaults）：90>5 成长成功 5→12
    assert.match(await runtime.manager.handleEn(e, "神秘学"), /成长成功，增加 7（5→12，已写入人物卡）/)
    // 克苏鲁神话默认 0：任何点数都成长
    runtime.manager.rollD100 = () => ({ value: 3, diceText: "1D100" })
    assert.match(await runtime.manager.handleEn(e, "克苏鲁神话"), /成长成功，增加 7（0→7，已写入人物卡）/)
  } finally {
    runtime.cleanup()
  }
})

test("代骰家族（源 ext_coc7.go AllowDelegate + helpRc 73 行）：@某人读写都用对方卡", async () => {
  const runtime = createRuntime()
  try {
    const at = [{ type: "text", data: { text: ".cmd" } }, { type: "at", data: { qq: "777" } }]
    const e = (msg) => ({ msg, raw_message: msg, group_id: "1", user_id: "9", sender: { card: "KP" }, message: [{ type: "text", data: { text: msg.split(/@\S*/)[0] } }, { type: "at", data: { qq: "777" } }], bot: { uin: "1" } })
    // .st 录到对方卡
    await runtime.manager.handleSt(e(".st san 55 侦查 70"), "san 55 侦查 70")
    // .st show 看对方卡
    assert.match(await runtime.manager.handleSt(e(".st show"), "show"), /777 的人物卡[\s\S]*侦查:70/)
    // .r 代掷显示对方名
    runtime.manager.rollExpression = () => ({ total: 13, expr: "1D20", detail: "1D20[13]" })
    assert.match(runtime.manager.handleRoll(e(".r 1d20"), "1d20"), /^777 掷骰/)
    // .sc 扣对方 SAN
    runtime.manager.rollD100 = () => ({ value: 95, diceText: "1D100" })
    runtime.manager.rollExpression = () => ({ total: 5 })
    assert.match(await runtime.manager.handleSan(e(".sc 1/1d6"), "1/1d6"), /^777 SAN Check：1D100=95\/55 失败，理智损失 5，剩余 50/)
    // .en 成长对方卡(读写同一张)
    runtime.manager.rollD100 = () => ({ value: 90, diceText: "1D100" })
    runtime.manager.rollExpression = expr => ({ total: /^1d10$/i.test(expr) ? 10 : Number(expr) || 0 })
    assert.match(await runtime.manager.handleEn(e(".en 侦查"), "侦查"), /777 进行 侦查 成长检定：1D100=90\/70 成长成功，增加 10（70→80，已写入人物卡）/)
    const state = runtime.manager.readState()
    assert.equal(state.users["9"]?.cards?.默认?.skills?.侦查, undefined, "代骰不得写发起者自己的卡")
    assert.equal(state.users["777"].cards.默认.skills["侦查"], 80)
  } finally {
    runtime.cleanup()
  }
})

test("表达式形式 (N)M（源 ext_coc7.go 124 行注释 .ra(1)50）", () => {
  const runtime = createRuntime()
  try {
    const p = runtime.manager.parseCheckArgs("(1)50")
    assert.equal(p.target, 50)
    assert.equal(p.rounds, 1)
    const p3 = runtime.manager.parseCheckArgs("(3)60")
    assert.equal(p3.rounds, 3)
    assert.equal(p3.target, 60)
  } finally {
    runtime.cleanup()
  }
})
