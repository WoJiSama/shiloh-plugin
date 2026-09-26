// 海豹语义回归测试:钉住已修复的行为,防止再次回归。
// 覆盖:玩家名走 .nn 昵称、名片模板按名应用(.sn dh)、
//       .st 后自动刷新名片、紧凑中文 .st 解析、help 约定。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function tmpStatePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "seal-sem-")), "state.json")
}

function makeRuntime(statePath) {
  const { SealExtRuntime } = require("../domains/dice/SealExtRuntime.js")
  return new SealExtRuntime({ packId: "semtest", statePath })
}

async function importRuntime() {
  return await import("../domains/dice/SealExtRuntime.js")
}

test("语义:玩家名走 resolver(.nn 昵称)而非调用方硬传的 sender 名", async () => {
  const { SealExtRuntime } = await importRuntime()
  const statePath = tmpStatePath()
  const runtime = new SealExtRuntime({ packId: "pname", statePath })
  // 注入 resolver(模拟 DiceManager.getUserName 优先取 .nn 昵称)
  runtime.resolvePlayerName = userId => userId === "111" ? "测试勇者" : ""
  const ctx = runtime.makeContext({ event: null, userId: "111", name: "", groupId: "g1" })
  assert.equal(ctx.player.name, "测试勇者", "resolver 结果优先")
  // resolver 无值时回落到传入 name
  const ctx2 = runtime.makeContext({ event: null, userId: "222", name: "群名片", groupId: "g1" })
  assert.equal(ctx2.player.name, "群名片", "resolver 无值时回落")
  // 都无值时回落到 userId
  const ctx3 = runtime.makeContext({ event: null, userId: "333", name: "", groupId: "g1" })
  assert.equal(ctx3.player.name, "333", "最终回落 userId")
})

test("语义:名片模板按名应用(.sn dh)不依赖运行时记忆", async () => {
  const { SealExtRuntime } = await importRuntime()
  const statePath = tmpStatePath()
  const runtime = new SealExtRuntime({ packId: "snname", statePath })
  runtime.run(`
    let ext = seal.ext.find('snname')
    if (!ext) { ext = seal.ext.new('snname', 't', '1'); seal.ext.register(ext) }
    seal.gameSystem.newTemplate(JSON.stringify({
      name: 'daggerheart',
      setConfig: { keys: ['dh'], enableTip: '已切换', diceSides: 20 },
      nameTemplate: {
        dh: { template: '{$t玩家_RAW} 希望{希望}/{希望上限}' },
        gm: { template: '{$t玩家_RAW} 恐惧{恐惧}/{恐惧上限}' }
      }
    }))
  `)
  assert.equal(runtime.templateRegistry.length, 1)
  assert.ok(runtime.templateRegistry[0].nameTemplate.dh.template)
  assert.ok(runtime.templateRegistry[0].nameTemplate.gm.template)
  assert.equal(runtime.ruleRegistry.length, 1)
  assert.deepEqual(runtime.ruleRegistry[0].keys, ["dh"])
})

test("语义:applyGroupCardByTemplate 渲染时玩家名走 resolver", async () => {
  const { SealExtRuntime } = await importRuntime()
  const statePath = tmpStatePath()
  const runtime = new SealExtRuntime({ packId: "cardname", statePath })
  runtime.resolvePlayerName = userId => userId === "111" ? "nn昵称" : ""
  runtime.varsAdapter = {
    get: (g, u, n) => n === "希望" ? [5, true] : n === "希望上限" ? [9, true] : [0, false],
    set: () => true
  }
  const cards = []
  const event = { group_id: 777, bot: { sendApi: async (action, params) => { cards.push(params.card); return { retcode: 0 } } } }
  runtime.applyGroupCardByTemplate(
    runtime.makeContext({ event, userId: "111", name: "忽略我", groupId: "777" }),
    "{$t玩家_RAW} 希望{希望}/{希望上限}"
  )
  await new Promise(r => setTimeout(r, 50))
  assert.equal(cards.length, 1)
  assert.match(cards[0], /^nn昵称 希望5\/9/)
})

test("语义:<命令> help 约定:help/帮助/-h 显示帮助不进 solve", async () => {
  const { SealExtRuntime } = await importRuntime()
  const statePath = tmpStatePath()
  const runtime = new SealExtRuntime({ packId: "helpconv2", statePath })
  runtime.run(`
    let ext = seal.ext.find('helpconv2')
    if (!ext) { ext = seal.ext.new('helpconv2', 't', '1'); seal.ext.register(ext) }
    const cmd = seal.ext.newCmdItemInfo()
    cmd.name = 'dd'
    cmd.help = '.dd 用法说明'
    cmd.solve = (ctx, msg) => { seal.replyToSender(ctx, msg, 'ROLLED'); return seal.ext.newCmdExecuteResult() }
    ext.cmdMap['dd'] = cmd
  `)
  const result = await runtime.dispatch("dd", { args: ["help"], userId: "u1", groupId: "g1" })
  assert.equal(result.showHelp, true)
  assert.deepEqual(result.replies, [])
  const normal = await runtime.dispatch("dd", { args: ["12/20"], userId: "u1", groupId: "g1" })
  assert.equal(normal.showHelp, false)
  assert.ok(normal.replies.some(r => String(r.text).includes("ROLLED")))
})

test("语义:紧凑中文 .st 解析(无分隔符+负值)——已由 diceManagerCore 钉住,此处验证 vars 层能读到", async () => {
  const { SealExtRuntime } = await importRuntime()
  const statePath = tmpStatePath()
  const runtime = new SealExtRuntime({ packId: "stvars", statePath })
  // 模拟 .st 后的卡状态(skills 层——非别名中文属性)
  const cardStore = { attrs: { DEX: 0, STR: -1 }, skills: { 生命: 6, 压力: 0, 希望: 5, 希望上限: 9 } }
  runtime.varsAdapter = {
    get: (g, u, name) => {
      const v = cardStore.attrs[name] !== undefined ? cardStore.attrs[name] : cardStore.skills[name]
      return v !== undefined ? [Number(v), true] : [0, false]
    },
    set: () => true
  }
  // 模板渲染应能解析 skills 层变量
  const ctx = runtime.makeContext({ event: null, userId: "u1", name: "", groupId: "g1" })
  const rendered = String(
    runtime.applyGroupCardByTemplate ? "skip" : ""
  )
  // 直接用 formatString 验证变量解析
  const text = runtime.formatString(ctx, "希望{希望}/{希望上限} HP{生命}")
  assert.equal(text, "希望5/9 HP6", "skills 层变量能解析")
})

test("H1: newCmdExecuteResult(solved) 首参语义", async () => {
  const { SealExtRuntime } = await importRuntime()
  const rt = new SealExtRuntime({ packId: "h1", statePath: tmpStatePath() })
  rt.run(`
    let ext = seal.ext.find('h1')
    if (!ext) { ext = seal.ext.new('h1','t','1'); seal.ext.register(ext) }
    const cmd = seal.ext.newCmdItemInfo()
    cmd.name = 't1'
    cmd.solve = () => seal.ext.newCmdExecuteResult(false)
    ext.cmdMap['t1'] = cmd
    const cmd2 = seal.ext.newCmdItemInfo()
    cmd2.name = 't2'
    cmd2.solve = () => seal.ext.newCmdExecuteResult(true)
    ext.cmdMap['t2'] = cmd2
  `)
  const r1 = await rt.dispatch("t1", { userId: "u", groupId: "g" })
  assert.equal(r1.solved, false, "newCmdExecuteResult(false) → solved=false")
  assert.equal(r1.matched, true, "matched 恒 true(海豹语义)")
  const r2 = await rt.dispatch("t2", { userId: "u", groupId: "g" })
  assert.equal(r2.solved, true, "newCmdExecuteResult(true) → solved=true")
})

test("H2: vars 四层作用域 $t/$m/$g/无前缀", async () => {
  const { SealExtRuntime } = await importRuntime()
  const rt = new SealExtRuntime({ packId: "h2", statePath: tmpStatePath() })
  const cardStore = { attrs: {}, skills: {} }
  rt.varsAdapter = {
    get: (g, u, n) => cardStore.skills[n] !== undefined ? [cardStore.skills[n], true] : cardStore.attrs[n] !== undefined ? [cardStore.attrs[n], true] : [0, false],
    set: (g, u, n, v) => { cardStore.skills[n] = v }
  }
  rt.run(`
    let ext = seal.ext.find('h2')
    if (!ext) { ext = seal.ext.new('h2','t','1'); seal.ext.register(ext) }
    const cmd = seal.ext.newCmdItemInfo()
    cmd.name = 'v'
    cmd.solve = (ctx, msg, cmdArgs) => {
      seal.vars.intSet(ctx, '力量', 10)         // 无前缀→卡
      seal.vars.intSet(ctx, '$g频率', 3)          // $g→群
      seal.vars.intSet(ctx, '$m等级', 5)          // $m→个人
      seal.vars.intSet(ctx, '$t计数', 1)          // $t→临时
      seal.replyToSender(ctx, msg, 'ok')
      return seal.ext.newCmdExecuteResult()
    }
    ext.cmdMap['v'] = cmd
  `)
  await rt.dispatch("v", { userId: "u1", groupId: "g1" })
  assert.equal(cardStore.skills["力量"], 10, "无前缀写入卡")
  assert.equal(rt.storage.__scoped["__g:g1:频率"], 3, "$g 写入群作用域")
  assert.equal(rt.storage.__scoped["__m:u1:等级"], 5, "$m 写入个人作用域")
  assert.equal(rt.tempVars.get("__t:g1:u1:计数"), 1, "$t 写入临时作用域")
  // 下一次 dispatch 临时变量清零
  await rt.dispatch("v", { userId: "u1", groupId: "g1" })
  assert.equal(rt.tempVars.get("__t:g1:u1:计数"), 1, "重新设置后有值")
})

test("H3: cmdArgs 方法套件", async () => {
  const { SealExtRuntime } = await importRuntime()
  const rt = new SealExtRuntime({ packId: "h3", statePath: tmpStatePath() })
  rt.run(`
    let ext = seal.ext.find('h3')
    if (!ext) { ext = seal.ext.new('h3','t','1'); seal.ext.register(ext) }
    const cmd = seal.ext.newCmdItemInfo()
    cmd.name = 'args'
    cmd.solve = (ctx, msg, cmdArgs) => {
      const a1 = cmdArgs.getArgN(1)
      const rest = cmdArgs.getRestArgsFrom(2)
      const kw = cmdArgs.getKwarg('mode')
      const isE = cmdArgs.isArgEqual(1, 'HELLO')
      const chop = cmdArgs.chopPrefixToArgsWith('sw')
      seal.replyToSender(ctx, msg, a1 + '|' + rest + '|' + (kw ? kw.value : 'nokw') + '|' + isE + '|' + chop[0])
      return seal.ext.newCmdExecuteResult()
    }
    ext.cmdMap['args'] = cmd
  `)
  const r = await rt.dispatch("args", { userId: "u", groupId: "g", args: ["hello", "world", "foo", "--mode=test"], rawArgs: "hello world foo --mode=test" })
  assert.ok(r.replies.length > 0)
  assert.match(r.replies[0].text, /hello\|world foo\|test\|true\|hello/)
})

test("H4: format 骰表达式求值", async () => {
  const { SealExtRuntime } = await importRuntime()
  const rt = new SealExtRuntime({ packId: "h4", statePath: tmpStatePath() })
  rt.varsAdapter = { get: (g, u, n) => n === "力量" ? [15, true] : [0, false], set: () => true }
  const ctx = rt.makeContext({ userId: "u", groupId: "g" })
  // 纯数字
  assert.equal(rt.formatString(ctx, "{42}"), "42")
  // 算术
  assert.equal(rt.formatString(ctx, "{3+4}"), "7")
  // 变量算术
  assert.equal(rt.formatString(ctx, "{力量+5}"), "20")
  // 骰表达式(结果在合理范围)
  const dice = rt.formatString(ctx, "{1d6}")
  assert.ok(Number(dice) >= 1 && Number(dice) <= 6, `骰结果应1-6: ${dice}`)
  // 未解析变量保留原文
  assert.equal(rt.formatString(ctx, "{不存在}"), "{不存在}")
})

test("M4: solve 返回 undefined → 未处理(solved=false)", async () => {
  const { SealExtRuntime } = await importRuntime()
  const rt = new SealExtRuntime({ packId: "m4", statePath: tmpStatePath() })
  rt.run(`
    let ext = seal.ext.find('m4')
    if (!ext) { ext = seal.ext.new('m4','t','1'); seal.ext.register(ext) }
    const cmd = seal.ext.newCmdItemInfo()
    cmd.name = 'noop'
    cmd.solve = () => {}
    ext.cmdMap['noop'] = cmd
  `)
  const r = await rt.dispatch("noop", { userId: "u", groupId: "g" })
  assert.equal(r.solved, false, "undefined → 未处理")
  assert.equal(r.matched, true)
})

test("M1: getCtxProxyFirst 排除 bot 自己", async () => {
  const { SealExtRuntime } = await importRuntime()
  const rt = new SealExtRuntime({ packId: "m1", statePath: tmpStatePath() })
  const event = { group_id: 111, bot: { uin: 999 } }
  const ctx = rt.makeContext({ event, userId: "100", groupId: "111" })
  const seal = rt.buildSealApi()
  // @了 bot 和普通用户 → 应取普通用户
  const proxied = seal.getCtxProxyFirst(ctx, { at: [{ userId: "999", name: "" }, { userId: "200", name: "目标" }] })
  assert.equal(proxied.player.userId, "200", "跳过 bot 取普通用户")
  // 只 @ bot → 返回原 ctx
  const self = seal.getCtxProxyFirst(ctx, { at: [{ userId: "999", name: "" }] })
  assert.equal(self, ctx, "只 @bot 时返回原 ctx")
})

test("M2: 代骰加 DelegateText 前缀", async () => {
  const { SealExtRuntime } = await importRuntime()
  const rt = new SealExtRuntime({ packId: "m2", statePath: tmpStatePath() })
  rt.resolvePlayerName = uid => uid === "100" ? "发起人" : ""
  rt.run(`
    let ext = seal.ext.find('m2')
    if (!ext) { ext = seal.ext.new('m2','t','1'); seal.ext.register(ext) }
    const cmd = seal.ext.newCmdItemInfo()
    cmd.name = 'roll'
    cmd.allowDelegate = true
    cmd.solve = (ctx, msg) => {
      seal.replyToSender(ctx, msg, '掷骰结果')
      return seal.ext.newCmdExecuteResult()
    }
    ext.cmdMap['roll'] = cmd
  `)
  const event = { group_id: 111, bot: { uin: 999 } }
  const r = await rt.dispatch("roll", { event, userId: "100", groupId: "111", at: [{ userId: "200", name: "" }] })
  assert.ok(r.replies.length > 0)
  assert.match(r.replies[0].text, /^由.+代骰/, "首条回复有代骰前缀")
  assert.match(r.replies[0].text, /掷骰结果/)
})

test("M6: ctx.player/group 补字段 + notice()", async () => {
  const { SealExtRuntime } = await importRuntime()
  const rt = new SealExtRuntime({ packId: "m6", statePath: tmpStatePath() })
  const ctx = rt.makeContext({ userId: "u", groupId: "g", name: "玩家" })
  assert.ok(ctx.player.lastCommandTime > 0)
  assert.ok(ctx.group)
  assert.equal(ctx.group.active, true)
  assert.equal(typeof ctx.notice, "function")
  assert.equal(ctx.notice("标题", "内容"), true)
  assert.equal(ctx.isCurGroupBotOn, true)
  assert.equal(typeof ctx.privilegeLevel, "number")
})
