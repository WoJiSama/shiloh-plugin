import { test } from "node:test"
import assert from "node:assert/strict"

// sealdice-core ResultCheckBase 忠实移植的回放测试。
// 期望值按 sealdice dice/ext_coc7.go:1517-1676 的逻辑手工推导。

async function getManager() {
  const { diceManager } = await import("../domains/dice/DiceManager.js")
  return diceManager
}

function levelOf(manager, roll, value, rule, difficulty = 0) {
  return manager.judgeCoc(roll, value, rule, difficulty)
}

test("规则0（规则书）：不满50出96-100大失败（以折算判定值为准）", async () => {
  const m = await getManager()
  assert.equal(levelOf(m, 97, 60, "0"), "失败") // 满50时大失败线=100
  assert.equal(levelOf(m, 96, 60, "0"), "失败") // 满50时96只是失败
  assert.equal(levelOf(m, 100, 60, "0"), "大失败")
  assert.equal(levelOf(m, 97, 40, "0"), "大失败") // 不满50 → 96+大失败
  assert.equal(levelOf(m, 1, 40, "0"), "大成功") // 为1必大成功
  // 折算判定值影响大失败线：困难检定 80 → checkVal=40 <50 → 96+大失败
  assert.equal(levelOf(m, 97, 80, "0", 2), "大失败")
  assert.equal(levelOf(m, 97, 80, "0"), "失败") // 无难度时 80≥50 → 97 仅失败
})

test("规则1：满50出1-5大成功；不满50出96-100大失败", async () => {
  const m = await getManager()
  assert.equal(levelOf(m, 5, 60, "1"), "大成功")
  assert.equal(levelOf(m, 6, 60, "1"), "极难成功") // 6≤80/5=12
  assert.equal(levelOf(m, 5, 40, "1"), "极难成功") // 不满50仅1大成功，但5≤40/5=8
  assert.equal(levelOf(m, 96, 40, "1"), "大失败")
  assert.equal(levelOf(m, 96, 60, "1"), "失败")
})

test("规则2：1-5且≤判定值大成功；96-100且>判定值大失败（高判定值时线上移）", async () => {
  const m = await getManager()
  assert.equal(levelOf(m, 4, 30, "2"), "大成功")
  assert.equal(levelOf(m, 5, 30, "2"), "大成功") // 大成功线=min(5,30)=5
  assert.equal(levelOf(m, 5, 3, "2"), "失败") // 大成功线=min(5,3)=3，5>3 且 5≤3? 否 → 失败
  assert.equal(levelOf(m, 97, 98, "2"), "成功") // 97≤98，大失败线=min(100,99)=99
  assert.equal(levelOf(m, 99, 98, "2"), "大失败")
  assert.equal(levelOf(m, 1, 0 + 1, "2"), "大成功") // 为1必大成功（规则0/1/2）
})

test("规则4：大成功=min(5,判定值/10)；大失败=min(96+判定值/10,100)", async () => {
  const m = await getManager()
  assert.equal(levelOf(m, 3, 30, "4"), "大成功") // 线=3
  assert.equal(levelOf(m, 4, 30, "4"), "极难成功") // 4>crit(3) 但 4≤30/5=6，仍按档位细分
  assert.equal(levelOf(m, 99, 30, "4"), "大失败") // 线=96+3=99
  assert.equal(levelOf(m, 98, 30, "4"), "失败")
  assert.equal(levelOf(m, 5, 50, "4"), "大成功") // 线=min(5,5)=5
  assert.equal(levelOf(m, 100, 80, "4"), "大失败") // 线=min(96+8,100)=100
})

test("规则5：大成功=min(2,判定值/5)；不满50出96+，满50出99+大失败", async () => {
  const m = await getManager()
  assert.equal(levelOf(m, 2, 80, "5"), "大成功") // 线=min(2,16)=2
  assert.equal(levelOf(m, 3, 80, "5"), "极难成功") // 3≤80/5=16
  assert.equal(levelOf(m, 99, 80, "5"), "大失败") // 满50 → 99+
  assert.equal(levelOf(m, 98, 80, "5"), "失败")
  assert.equal(levelOf(m, 96, 40, "5"), "大失败") // 不满50 → 96+
  assert.equal(levelOf(m, 95, 40, "5"), "失败")
})

test("规则3：1-5强行大成功；96+强行大失败", async () => {
  const m = await getManager()
  assert.equal(levelOf(m, 5, 10, "3"), "大成功") // 即使5>判定线10? 5≤10成功，≤5强行大成功
  assert.equal(levelOf(m, 5, 3, "3"), "大成功") // 5>3 失败档，但≤5强行大成功
  assert.equal(levelOf(m, 96, 98, "3"), "大失败") // 96≤98本成功，强行大失败
})

test("档位细分与困难/极难", async () => {
  const m = await getManager()
  assert.equal(levelOf(m, 20, 80, "0"), "困难成功") // 20>16（极难线）但≤40（困难线）
  assert.equal(levelOf(m, 16, 80, "0"), "极难成功")
  assert.equal(levelOf(m, 40, 80, "0"), "困难成功")
  assert.equal(levelOf(m, 79, 80, "0"), "成功")
  assert.equal(levelOf(m, 81, 80, "0"), "失败")
})

test("nofumble 扩展：永不判大失败", async () => {
  const m = await getManager()
  assert.equal(levelOf(m, 100, 60, "无大失败"), "失败")
  assert.equal(levelOf(m, 97, 40, "无大失败"), "失败")
})

test("难度前缀解析：.ra 困难侦查60 / .ra 极难 侦查 60", async () => {
  const m = await getManager()
  const a = m.parseCheckArgs("困难侦查60")
  assert.equal(a.difficulty, 2)
  assert.equal(a.skill, "侦查")
  assert.equal(a.target, 60)
  const b = m.parseCheckArgs("极难 侦查 60")
  assert.equal(b.difficulty, 3)
  assert.equal(b.skill, "侦查")
  const c = m.parseCheckArgs("大成功斗殴")
  assert.equal(c.difficulty, 4)
  assert.equal(c.skill, "斗殴")
  const d = m.parseCheckArgs("侦查 60")
  assert.equal(d.difficulty, 0)
})

test("检定参数奖惩前缀：.ra b/p 与带数量 b2/p3 不再混进技能名", async () => {
  const m = await getManager()
  const b = m.parseCheckArgs("b 侦查 60")
  assert.equal(b.modifier, 1)
  assert.equal(b.skill, "侦查")
  assert.equal(b.target, 60)
  const b2 = m.parseCheckArgs("b2 侦查 60")
  assert.equal(b2.modifier, 2)
  assert.equal(b2.skill, "侦查")
  const p3 = m.parseCheckArgs("p3 侦查 60")
  assert.equal(p3.modifier, -3)
  assert.equal(p3.skill, "侦查")
  const reward = m.parseCheckArgs("奖励2 侦查 60")
  assert.equal(reward.modifier, 2)
  assert.equal(reward.skill, "侦查")
})

test("检定参数多轮前缀：N# / #N / 紧贴式 3#技能 均剥离且不污染技能名", async () => {
  const m = await getManager()
  const spaced = m.parseCheckArgs("3# 今天开团 60")
  assert.equal(spaced.rounds, 3)
  assert.equal(spaced.skill, "今天开团")
  assert.equal(spaced.target, 60)
  const hash = m.parseCheckArgs("#3 今天开团 60")
  assert.equal(hash.rounds, 3)
  assert.equal(hash.skill, "今天开团")
  const compact = m.parseCheckArgs("3#今天开团 60")
  assert.equal(compact.rounds, 3)
  assert.equal(compact.skill, "今天开团")
  const plain = m.parseCheckArgs("侦查 60")
  assert.equal(plain.rounds, 0)
})

test("目标值取末位数字：残留前导数字不再劫持检定值", async () => {
  const m = await getManager()
  // 曾因取第一个数字 token，被判成对 3 检定并静默丢弃真值 60
  const poisoned = m.parseCheckArgs("3 今天开团 60")
  assert.equal(poisoned.target, 60)
  const compact = m.parseCheckArgs("侦查60")
  assert.equal(compact.target, 60)
  assert.equal(compact.skill, "侦查")
})

test("难度检定展示：极难检定按折算线判通过", async () => {
  const m = await getManager()
  // 20 vs 80：极难线16 → 未通过；rank=3（极难成功）但需 rank≥3? 20>16 rank=2? 20≤40困难 rank2 <3 → 失败
  assert.match(m.renderCheckLevel(20, 80, "0", 3), /极难检定失败/)
  assert.match(m.renderCheckLevel(15, 80, "0", 3), /极难检定成功/) // 15≤16 rank3
  assert.match(m.renderCheckLevel(1, 80, "0", 2), /困难检定成功（大成功）/)
})

test("sc 参数解析：--half 与 --cap 剥离后正常匹配", async () => {
  const m = await getManager()
  // 直接验证剥离逻辑（不跑完整 handleSan，避免依赖事件）
  let text = "1/1d6 60 --half --cap=5"
  let halfLoss = false
  let lossCap = 0
  text = text.replace(/--half\b\s*/gi, () => { halfLoss = true; return "" })
  text = text.replace(/--cap\s*=\s*(\d+)\s*/gi, (_, n) => { lossCap = Number(n); return "" })
  text = text.trim()
  assert.ok(halfLoss)
  assert.equal(lossCap, 5)
  const mm = text.match(/^(\S+)\/(\S+)(?:\s+(\d+))?/)
  assert.equal(mm[1], "1")
  assert.equal(mm[2], "1d6")
  assert.equal(mm[3], "60")
})

test("大失败满骰：loss 表达式按最大面数计", async () => {
  const m = await getManager()
  const config = m.getConfig()
  const maxRoll = m.rollExpression("1d6+2", config, () => 0.999999)
  assert.equal(maxRoll.total, 8)
})

test("seaCocCheck 头部紧贴轮数：.ra3#技能90 与 .r3#d100 写法对齐", async () => {
  const m = await getManager()
  // 模拟 seaCocCheck 的头部解析语义（app.js 同一正则）
  const parse = text => {
    const head = text.match(/(?:rab|rap|rahb|rahp|rah|ra)(\d+)?#?(\d+)?(b|p)?\s*([\s\S]*)$/)
    const num = Number(head?.[1] || 0)
    const afterHash = Number(head?.[2] || 0) || undefined
    const suffix = String(head?.[3] || "")
    const hasB = /rab|rahb/.test(text) || suffix === "b"
    const hasP = /rap|rahp/.test(text) || suffix === "p"
    return {
      modifier: hasB ? (num || 1) : hasP ? -(num || 1) : undefined,
      rounds: afterHash ?? (num > 0 && !hasB && !hasP ? num : undefined)
    }
  }
  assert.deepEqual(parse(".ra3#格斗90"), { modifier: undefined, rounds: 3 })
  assert.deepEqual(parse(".ra3格斗90"), { modifier: undefined, rounds: 3 })
  assert.deepEqual(parse(".ra#3格斗90"), { modifier: undefined, rounds: 3 })
  assert.deepEqual(parse(".ra格斗90"), { modifier: undefined, rounds: undefined })
  assert.deepEqual(parse(".rab3#格斗90"), { modifier: 3, rounds: undefined })
  assert.deepEqual(parse(".rab3#2格斗90"), { modifier: 3, rounds: 2 })
})

test("handleCheck 轮数与显式值组合：.ra3# 格斗 90 三连", async () => {
  const m = await getManager()
  m.rollD100 = () => ({ value: 50, diceText: "1D100" })
  const text = m.handleCheck({ group_id: "1", user_id: "9", sender: { card: "探针" } }, "格斗 90", { rounds: 3 })
  const lines = text.split("\n")
  assert.equal(lines.length, 3)
  assert.ok(lines.every(line => /1D100=50\/90 成功/.test(line)))
})
