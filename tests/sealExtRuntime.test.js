import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const FIXTURE = `
// ==UserScript==
// @name         测试海豹扩展
// @author       tester
// @version      1.0.0
// ==/UserScript==
let ext = seal.ext.find('mini')
if (!ext) {
  ext = seal.ext.new('mini', 'tester', '1.0.0')
  seal.ext.register(ext)
}
ext.storageSet('counter', '41')
const cmd = seal.ext.newCmdItemInfo()
cmd.name = 'mini'
cmd.help = '.mini - 测试命令'
cmd.solve = (ctx, msg, cmdArgs) => {
  const [hope] = seal.vars.intGet(ctx, '希望')
  const next = hope + 1
  seal.vars.intSet(ctx, '希望', next)
  const roll = seal.format(ctx, '{d20}')
  seal.replyToSender(ctx, msg, 'roll=' + roll + ' hope=' + next + ' args=' + cmdArgs.args.join(',') + ' storage=' + ext.storageGet('counter'))
  return seal.ext.newCmdExecuteResult(true)
}
const cmdProxy = seal.ext.newCmdItemInfo()
cmdProxy.name = 'miniproxy'
cmdProxy.solve = (ctx, msg, cmdArgs) => {
  const proxied = seal.getCtxProxyFirst(ctx, cmdArgs)
  const [hope] = seal.vars.intGet(proxied, '希望')
  seal.replyToSender(ctx, msg, 'proxied hope=' + hope)
  return seal.ext.newCmdExecuteResult(true)
}
ext.cmdMap['mini'] = cmd
ext.cmdMap['miniproxy'] = cmdProxy
console.log('fixture loaded')
`

function tmpStatePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "seal-ext-")), "state.json")
}

test("海豹扩展识别与元数据提取", async () => {
  const { looksLikeSealExtensionSource, extractUserScriptMeta } = await import("../domains/dice/SealExtRuntime.js")
  assert.equal(looksLikeSealExtensionSource(FIXTURE), true)
  assert.equal(looksLikeSealExtensionSource("module.exports = { commands: [] }"), false)
  const meta = extractUserScriptMeta(FIXTURE)
  assert.equal(meta.name, "测试海豹扩展")
  assert.equal(meta.author, "tester")
})

test("沙箱运行：命令注册、vars 读写、format 掷骰、storage 持久、代骰代理", async () => {
  const { SealExtRuntime } = await import("../domains/dice/SealExtRuntime.js")
  const statePath = tmpStatePath()
  const cardStore = { "g1:u1:希望": 5, "g1:u2:希望": 9 }  // 模拟 varsAdapter
  const runtime = new SealExtRuntime({
    packId: "mini",
    statePath,
    varsAdapter: {
      get: (group, userId, name) => {
        const raw = cardStore[`${group}:${userId}:${name}`]
        return raw === undefined ? [0, false] : [raw, true]
      },
      set: (group, userId, name, value) => {
        cardStore[`${group}:${userId}:${name}`] = value
        return true
      }
    }
  })
  const runResult = runtime.run(FIXTURE)
  assert.deepEqual(runResult.extensions, ["mini"])
  assert.deepEqual(runResult.commands.map(c => c.name).sort(), ["mini", "miniproxy"])
  assert.ok(runtime.logs.some(line => line.includes("fixture loaded")), "console.log 被捕获")
  assert.ok(JSON.parse(fs.readFileSync(statePath, "utf-8"))["mini:counter"] === "41", "storage 落盘")

  const dispatch = runtime.dispatch("mini", {
    userId: "u1", userName: "阿明", groupId: "g1",
    args: ["+2", "检定"], rawArgs: "+2 检定"
  })
  assert.equal(dispatch.matched, true)
  assert.equal(dispatch.replies.length, 1)
  const text = dispatch.replies[0].text
  assert.match(text, /roll=\d+/)
  assert.match(text, /hope=6/)
  assert.match(text, /args=\+2,检定/)
  assert.match(text, /storage=41/)

  // 代骰代理：代理到 u2 后读取 u2 的希望值
  const proxy = runtime.dispatch("miniproxy", {
    userId: "u1", userName: "阿明", groupId: "g1",
    at: [{ userId: "u2" }]
  })
  assert.match(proxy.replies[0].text, /proxied hope=9/)
  assert.ok(!proxy.error)
  fs.rmSync(path.dirname(statePath), { recursive: true, force: true })
})

test("沙箱安全：无 require/fs，脚本崩了不伤宿主", async () => {
  const { SealExtRuntime } = await import("../domains/dice/SealExtRuntime.js")
  const runtime = new SealExtRuntime({ packId: "evil", statePath: tmpStatePath() })
  assert.throws(() => runtime.run("require('fs')"), /require is not defined/)
  assert.throws(() => runtime.run("process.exit(1)"), /process is not defined/)
  const runtime2 = new SealExtRuntime({ packId: "crash", statePath: tmpStatePath() })
  const badCmd = seal => {}
  const runResult = runtime2.run(`
    let ext = seal.ext.new('crash', 'x', '1')
    seal.ext.register(ext)
    const cmd = seal.ext.newCmdItemInfo()
    cmd.name = 'boom'
    cmd.solve = () => { throw new Error('爆炸') }
    ext.cmdMap['boom'] = cmd
  `)
  assert.equal(runResult.commands.length, 1)
  const result = runtime2.dispatch("boom", { userId: "u", groupId: "g" })
  assert.equal(result.matched, true)
  assert.match(result.error, /爆炸/)
})

test("群名片模板：变量渲染 + set_group_card 调用 + 无群权限静默", async () => {
  const { SealExtRuntime } = await import("../domains/dice/SealExtRuntime.js")
  const runtime = new SealExtRuntime({ packId: "cardtest", statePath: tmpStatePath() })
  const cardStore = { "g1:u1:希望": 3, "g1:u1:希望上限": 6 }
  runtime.varsAdapter = {
    get: (g, u, n) => { const raw = cardStore[`${g}:${u}:${n}`]; return raw === undefined ? [0, false] : [raw, true] },
    set: () => true
  }
  const calls = []
  const fakeBot = { sendApi: async (api, params) => { calls.push({ api, params }); return { retcode: 0 } } }
  const event = { group_id: 888, user_id: 111, bot: fakeBot }
  const ctx = runtime.makeContext({ event, userId: "u1", name: "阿明", groupId: "g1" })
  runtime.applyGroupCardByTemplate(ctx, "{$t玩家_RAW} 希望{希望}/{希望上限}")
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(calls.length, 1, "set_group_card 被调用")
  assert.equal(calls[0].api, "set_group_card")
  assert.equal(calls[0].params.group_id, 888)
  assert.equal(calls[0].params.card, "阿明 希望3/6")
  // 私聊上下文直接跳过
  const privateCtx = runtime.makeContext({ userId: "u1", groupId: "" })
  assert.equal(runtime.applyGroupCardByTemplate(privateCtx, "x"), false)
  assert.equal(calls.length, 1)
})

test("真实 Daggerheart 扩展可加载并注册全部命令", async () => {
  const { SealExtRuntime } = await import("../domains/dice/SealExtRuntime.js")
  const source = fs.readFileSync(new URL("../docs/dice-rules/examples/daggerheart-seal-ext.js", import.meta.url), "utf-8")
  const runtime = new SealExtRuntime({ packId: "daggerheart", statePath: tmpStatePath() })
  const runResult = runtime.run(source)
  const names = runResult.commands.map(c => c.name).sort()
  assert.deepEqual(names, ["cook", "dd", "ddr", "dh", "dhalias", "gm", "gmfearupdate", "test"])
  // 分发 .dd（无 .st 数据也能出结果）
  const dispatch = runtime.dispatch("dd", { userId: "u1", userName: "阿明", groupId: "g1", args: [], rawArgs: "" })
  assert.equal(dispatch.matched, true)
  assert.ok(dispatch.replies.length >= 1)
  assert.match(dispatch.replies[0].text, /希望骰|恐惧骰/)
  // 固定 12/12 触发关键成功的属性更新路径（群名片 API 现已真实现，不再降级）
  const critical = runtime.dispatch("test", { userId: "u1", userName: "阿明", groupId: "g1", args: ["12", "12"], rawArgs: "12 12" })
  assert.match(critical.replies[0].text, /关键成功|总点数/)
  assert.equal(runtime.unsupportedCalls.length, 0, "调用的 API 均已支持")
})
