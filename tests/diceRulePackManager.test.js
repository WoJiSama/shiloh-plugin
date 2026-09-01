import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DiceManager } from "../utils/DiceManager.js"
import { DiceRulePackManager, resolveDiceRuleImportSource } from "../utils/DiceRulePackManager.js"

const examplesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs/dice-rules/examples")

function createRuntime(options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dice-rule-pack-test-"))
  const pluginDir = path.join(cwd, "plugins", "bl-chat-plugin")
  fs.mkdirSync(path.join(pluginDir, "config_default"), { recursive: true })
  fs.writeFileSync(path.join(pluginDir, "config_default", "message.yaml"), [
    "pluginSettings:",
    "  diceSystem:",
    "    enabled: true",
    "    customRulesEnabled: true",
    `    maxDiceCount: ${options.maxDiceCount || 100}`,
    "    baseDir: data/dice"
  ].join("\n"))
  const logger = { warn() {}, info() {}, error() {} }
  const diceManager = new DiceManager({ cwd, logger })
  const manager = new DiceRulePackManager({ diceManager, cwd, logger, random: options.random || (() => 0.99) })
  return { cwd, diceManager, manager, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) }
}

function event(message, overrides = {}) {
  return {
    group_id: "10001",
    user_id: "20002",
    sender: { card: "测试员", nickname: "Tester", role: "member" },
    msg: message,
    ...overrides
  }
}

function eventWithMembers(message, overrides = {}) {
  const members = new Map([
    [20002, { user_id: 20002, card: "测试员", nickname: "Tester", role: overrides.sender?.role || "member" }],
    [30003, { user_id: 30003, card: "目标玩家", nickname: "Target", role: "member" }],
    [40004, { user_id: 40004, card: "主持人", nickname: "Keeper", role: "admin" }]
  ])
  return event(message, { group: { getMemberMap: async () => members }, ...overrides })
}

function memberRuleData(state, userId, packId, groupId = "10001") {
  return state.users[String(userId)].cards["默认"].ruleData[packId].groups[String(groupId)]
}

const statefulRule = `
version: 1
id: state-pack
name: 状态规则
aliases: [state]
compatibility:
  package_version: "1.0.0"
identity:
  display_name: "{attr.name}"
character:
  fields:
    name: { type: string, default: "{sender.card}" }
    hp: { type: integer, default: 10, min: 0, max: 10 }
    injury: { type: integer, default: 0, min: 0, max: 10 }
    effective_hp: { type: integer, formula: "attr.hp - attr.injury" }
commands:
  - id: hit
    aliases: [hit, 受伤]
    arguments:
      - { id: damage, type: integer, required: true, min: 0, max: 10 }
    rolls:
      amount: "arg.damage"
    branches:
      - when: "roll.amount.total > 0"
        result: 受伤
        actions:
          - { op: subtract, field: hp, value: "roll.amount.total" }
          - { op: clamp, field: hp, min: 0, max: 10 }
      - result: 无事
    output: "{actor}：{result}，HP={attr.hp}，有效HP={derived.effective_hp}"
`

const teamRule = `
version: 1
id: team-pack
name: 团务规则
aliases: [team]
compatibility: { package_version: "2.0.0" }
character:
  fields:
    name: { type: string, default: "{sender.card}" }
    hp: { type: integer, default: 10, min: 0, max: 20 }
    mp: { type: integer, default: 3, min: 0, max: 10 }
    secret_note: { type: string, default: hidden, secret: true }
    power: { type: integer, formula: "attr.hp + (inventory.sword.equipped ? 2 : 0)" }
group:
  fields:
    momentum: { type: integer, default: 0, min: 0, max: 20 }
    mana_pool: { type: integer, default: 5, min: 0, max: 10 }
statuses:
  poison:
    label: 中毒
    default_duration: 2
    max_stacks: 3
    tick: turn_end
    on_tick:
      - { op: subtract, field: hp, value: "status.stacks" }
  burn:
    label: 灼烧
    default_duration: 1
    tick: manual
    on_tick:
      - { op: subtract, field: hp, value: 2 }
    on_expire:
      - { op: add, field: hp, value: 1 }
items:
  sword: { label: 长剑, stackable: false, max_quantity: 1, slot: hand }
abilities:
  fireball: { label: 火球术, kind: spell, max_rank: 3, cooldown: 2, resource_scope: actor, resource_field: mp, resource_cost: 2 }
  rally: { label: 战术号令, kind: skill, max_rank: 1, cooldown: 2, resource_scope: group, resource_field: mana_pool, resource_cost: 2 }
events:
  turn_start:
    - { op: add, scope: group, field: momentum, value: 1 }
commands:
  - id: attack
    aliases: [attack, 攻击]
    arguments:
      - { id: victim, type: actor, required: true, allowed: [member, npc] }
      - { id: damage, type: integer, required: true, min: 0, max: 10 }
    actions:
      - { op: subtract, scope: target, target: victim, field: hp, value: "arg.damage" }
    output: "{actor}攻击{target.name}，目标HP={target.attr.hp}"
  - id: secret_roll
    aliases: [secret, 暗骰]
    visibility: gm
    rolls: { check: "1d20" }
    output: "暗骰={roll.check.detail}"
    public_output: "{actor}进行了一次秘密检定。"
  - id: secret_cost
    aliases: [secretcost, 秘密代价]
    visibility: gm
    actions:
      - { op: subtract, field: hp, value: 1 }
    output: "秘密代价后HP={attr.hp}"
    public_output: "{actor}进行了一次秘密行动。"
  - id: gm_only
    aliases: [gmonly, 主持命令]
    permission: gm
    output: "GM命令完成"
  - id: self_hit
    aliases: [selfhit, 自伤]
    arguments:
      - { id: damage, type: integer, required: true, min: 0, max: 10 }
    actions:
      - { op: subtract, field: hp, value: "arg.damage" }
    output: "{actor}当前HP={attr.hp}"
  - id: opposed
    aliases: [duel, 对抗]
    arguments:
      - { id: rival, type: actor, required: true, allowed: [member, npc] }
    opposed:
      target: rival
      actor_value: "1d20 + attr.hp"
      target_value: "1d20 + target.attr.hp"
      mode: higher
      tie: tie
    output: "{actor}对抗{target.name}：{opposed.actor} vs {opposed.target}，胜者={opposed.winner}"
`

test("rule package lifecycle imports, confirms, enables and executes stateful commands", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  const staged = await runtime.manager.stageImport(statefulRule, "master")
  assert.equal(staged.ok, true, staged.errors?.join("; "))
  assert.match(staged.report, /预检通过/)
  const confirmed = await runtime.manager.confirmImport("state-pack", "master")
  assert.equal(confirmed.version, 1)
  await runtime.manager.enableForGroup("10001", "state-pack", 1)

  const setName = await runtime.manager.handleDynamicCommand(event(".state 设 name=艾琳"))
  assert.equal(setName.matched, true)
  assert.match(setName.text, /艾琳/)

  const hit = await runtime.manager.handleDynamicCommand(event("。state 受伤 3"))
  assert.equal(hit.matched, true)
  assert.equal(hit.text, "艾琳：受伤，HP=7，有效HP=7")

  const card = await runtime.manager.handleDynamicCommand(event(".state 卡"))
  assert.match(card.text, /生命|hp/i)
  assert.match(card.text, /7/)
  const unrelated = await runtime.manager.handleDynamicCommand(event(".not-this-command x"))
  assert.equal(unrelated.matched, false)
})

test("failed action validation does not partially modify character state", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(statefulRule, "master")
  await runtime.manager.confirmImport("state-pack", "master")
  await runtime.manager.enableForGroup("10001", "state-pack")
  await runtime.manager.handleDynamicCommand(event(".state 受伤 3"))
  const failed = await runtime.manager.handleDynamicCommand(event(".state 受伤 11"))
  assert.equal(failed.matched, true)
  assert.match(failed.text, /执行失败/)
  const card = await runtime.manager.handleDynamicCommand(event(".state 查 hp"))
  assert.equal(card.text, "hp(hp)=7")
})

test("new versions are immutable and a group can roll back", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(statefulRule, "master")
  await runtime.manager.confirmImport("state-pack", "master")
  const version2 = statefulRule.replace('package_version: "1.0.0"', 'package_version: "1.1.0"').replace("name: 状态规则", "name: 状态规则新版")
  await runtime.manager.stageImport(version2, "master")
  const confirmed = await runtime.manager.confirmImport("state-pack", "master")
  assert.equal(confirmed.version, 2)
  await runtime.manager.enableForGroup("10001", "state-pack", 2)
  assert.match(runtime.manager.listText("10001"), /当前群启用 @2/)
  await runtime.manager.rollbackForGroup("10001", "state-pack", 1)
  assert.match(runtime.manager.listText("10001"), /当前群启用 @1/)
  assert.ok(fs.existsSync(runtime.manager.getExportFile("state-pack", 2).file))
})

test("invalid imports do not create pending state or package versions", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  const invalid = await runtime.manager.stageImport("version: 1\nid: bad\nname: Bad\naliases: [ra]\ncommands: []", "master")
  assert.equal(invalid.ok, false)
  assert.match(invalid.report, /校验失败/)
  assert.deepEqual(runtime.manager.listPackages(), [])
  assert.equal(fs.existsSync(runtime.manager.getIndexPath()), false)
})

test("import source accepts fenced YAML and archived packages keep character data recoverable", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  const source = await resolveDiceRuleImportSource({}, `\`\`\`yaml\n${statefulRule}\n\`\`\``)
  assert.match(source, /id: state-pack/)
  await runtime.manager.stageImport(source, "master")
  await runtime.manager.confirmImport("state-pack", "master")
  await runtime.manager.enableForGroup("10001", "state-pack")
  await runtime.manager.handleDynamicCommand(event(".state 设 name=归档角色"))
  const archived = await runtime.manager.archivePackage("state-pack")
  assert.equal(archived.affectedGroups, 1)
  const state = runtime.diceManager.readState()
  assert.equal(memberRuleData(state, "20002", "state-pack").values.name, "归档角色")
  assert.ok(fs.readdirSync(path.join(runtime.manager.getRulesDir(), "archived")).some(name => name.startsWith("state-pack-")))
  const restored = await runtime.manager.restoreArchivedPackage("state-pack")
  assert.deepEqual(restored.versions, [1])
  await runtime.manager.enableForGroup("10001", "state-pack", 1)
  assert.match((await runtime.manager.handleDynamicCommand(event(".state 卡"))).text, /归档角色/)
})

test("field migrations preserve values and active rules remain group-scoped", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  const version1 = `
version: 1
id: migration-pack
name: 迁移规则
aliases: [migrate]
compatibility: { package_version: "1.0.0" }
character:
  fields:
    old_score: { type: integer, default: 4, min: 0, max: 20 }
commands:
  - id: show
    aliases: [show]
    output: "旧值={attr.old_score}"
`
  const version2 = `
version: 1
id: migration-pack
name: 迁移规则
aliases: [migrate]
compatibility:
  package_version: "2.0.0"
  migrations:
    - from: "1.0.0"
      rename_fields: { old_score: new_score }
character:
  fields:
    new_score: { type: integer, default: 0, min: 0, max: 20 }
commands:
  - id: show
    aliases: [show]
    output: "新值={attr.new_score}"
`
  await runtime.manager.stageImport(version1, "master")
  await runtime.manager.confirmImport("migration-pack", "master")
  await runtime.manager.enableForGroup("10001", "migration-pack", 1)
  await runtime.manager.handleDynamicCommand(event(".migrate 设 old_score=9"))
  const otherGroup = await runtime.manager.handleDynamicCommand(event(".migrate show", { group_id: "10002" }))
  assert.equal(otherGroup.matched, false)

  await runtime.manager.stageImport(version2, "master")
  await runtime.manager.confirmImport("migration-pack", "master")
  await runtime.manager.enableForGroup("10001", "migration-pack", 2)
  const migrated = await runtime.manager.handleDynamicCommand(event(".migrate show"))
  assert.equal(migrated.text, "新值=9")
  const state = runtime.diceManager.readState()
  const stored = memberRuleData(state, "20002", "migration-pack")
  assert.equal(stored.values.new_score, 9)
  assert.equal(Object.hasOwn(stored.values, "old_score"), false)
})

test("group enable rejects prefix conflicts and persisted index paths are portable", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(statefulRule, "master")
  await runtime.manager.confirmImport("state-pack", "master")
  await runtime.manager.enableForGroup("10001", "state-pack")
  const conflict = statefulRule.replace("id: state-pack", "id: other-pack").replace("name: 状态规则", "name: 另一规则")
  await runtime.manager.stageImport(conflict, "master")
  await runtime.manager.confirmImport("other-pack", "master")
  await assert.rejects(() => runtime.manager.enableForGroup("10001", "other-pack"), /前缀 state/)
  const index = runtime.manager.readIndex()
  assert.equal(path.isAbsolute(index.packages["state-pack"].versions[0].sourceFile), false)
  assert.ok(fs.existsSync(runtime.manager.getExportFile("state-pack").file))
})

test("confirmed and pending package files reject tampering", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(statefulRule, "master")
  const pending = runtime.manager.readIndex().pending["state-pack"]
  fs.writeFileSync(runtime.manager.resolveRulePath(pending.normalizedFile), fs.readFileSync(runtime.manager.resolveRulePath(pending.normalizedFile), "utf8").replace("状态规则", "篡改规则"))
  await assert.rejects(() => runtime.manager.confirmImport("state-pack", "master"), /完整性校验失败/)

  await runtime.manager.stageImport(statefulRule, "master")
  await runtime.manager.confirmImport("state-pack", "master")
  const record = runtime.manager.getVersionRecord("state-pack", 1)
  assert.equal(runtime.manager.loadPack("state-pack", 1).pack.id, "state-pack")
  fs.writeFileSync(runtime.manager.resolveRulePath(record.normalizedFile), fs.readFileSync(runtime.manager.resolveRulePath(record.normalizedFile), "utf8").replace("状态规则", "合法但被篡改的规则"))
  assert.throws(() => runtime.manager.loadPack("state-pack", 1), /文件损坏或丢失/)
  assert.throws(() => runtime.manager.getExportFile("state-pack", 1), /文件损坏或丢失/)
})

test("pending artifacts are removed after replacement and confirmation", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(statefulRule, "master")
  const first = runtime.manager.readIndex().pending["state-pack"]
  assert.ok(fs.existsSync(runtime.manager.resolveRulePath(first.sourceFile)))
  await runtime.manager.stageImport(statefulRule.replace("name: 状态规则", "name: 状态规则替换"), "master")
  const second = runtime.manager.readIndex().pending["state-pack"]
  assert.notEqual(first.stageId, second.stageId)
  assert.equal(fs.existsSync(runtime.manager.resolveRulePath(first.sourceFile)), false)
  assert.equal(fs.existsSync(runtime.manager.resolveRulePath(first.normalizedFile)), false)
  await runtime.manager.confirmImport("state-pack", "master")
  assert.equal(fs.existsSync(runtime.manager.resolveRulePath(second.sourceFile)), false)
  assert.equal(fs.existsSync(runtime.manager.resolveRulePath(second.normalizedFile)), false)
})

test("transient fields reset on every command and never enter character storage", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  const source = `
version: 1
id: transient-pack
name: 临时字段规则
aliases: [temp]
character:
  fields:
    pulse: { type: integer, default: 0, persistent: false }
commands:
  - id: pulse
    aliases: [pulse, 脉冲]
    actions:
      - { op: add, field: pulse, value: 1 }
    output: "pulse={attr.pulse}"
`
  assert.equal((await runtime.manager.stageImport(source, "master")).ok, true)
  await runtime.manager.confirmImport("transient-pack", "master")
  await runtime.manager.enableForGroup("10001", "transient-pack")
  assert.equal((await runtime.manager.handleDynamicCommand(event("。temp 脉冲"))).text, "pulse=1")
  assert.equal((await runtime.manager.handleDynamicCommand(event(".temp pulse"))).text, "pulse=1")
  const stored = memberRuleData(runtime.diceManager.readState(), "20002", "transient-pack")
  assert.equal(Object.hasOwn(stored.values, "pulse"), false)
  assert.match((await runtime.manager.handleDynamicCommand(event(".temp 设 pulse=9"))).text, /临时字段/)
})

test("identity falls back as a whole when a display field has no current value", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  const source = `
version: 1
id: identity-pack
name: 身份回退
aliases: [identity]
identity:
  display_name: "{attr.call_sign}（测试）"
  fallback: "{sender.card}"
character:
  fields:
    call_sign: { type: string }
commands:
  - { id: show, aliases: [show], output: "actor={actor}" }
`
  await runtime.manager.stageImport(source, "master")
  await runtime.manager.confirmImport("identity-pack", "master")
  await runtime.manager.enableForGroup("10001", "identity-pack")
  assert.equal((await runtime.manager.handleDynamicCommand(event(".identity show"))).text, "actor=测试员")
})

test("invocation prefixes include package ids and longest subcommand aliases win", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(statefulRule, "master")
  await runtime.manager.confirmImport("state-pack", "master")
  await runtime.manager.enableForGroup("10001", "state-pack")

  const conflictingId = statefulRule
    .replace("id: state-pack", "id: state")
    .replace("name: 状态规则", "name: ID 冲突规则")
    .replace("aliases: [state]", "aliases: [other]")
  await runtime.manager.stageImport(conflictingId, "master")
  await runtime.manager.confirmImport("state", "master")
  await assert.rejects(() => runtime.manager.enableForGroup("10001", "state"), /前缀 state/)

  const longest = `
version: 1
id: longest-pack
name: 最长命令
aliases: [longest]
commands:
  - { id: short, aliases: [受], output: "short" }
  - { id: long, aliases: [受伤], output: "long" }
`
  await runtime.manager.stageImport(longest, "master")
  await runtime.manager.confirmImport("longest-pack", "master")
  await runtime.manager.enableForGroup("10001", "longest-pack")
  assert.equal((await runtime.manager.handleDynamicCommand(event("。longest 受伤"))).text, "long")
})

test("import source reads replied YAML text and referenced QQ YAML files with byte limits", async () => {
  const replied = await resolveDiceRuleImportSource({
    getReply: async () => ({ message: [{ type: "text", data: { text: `\`\`\`yaml\n${statefulRule}\n\`\`\`` } }] })
  })
  assert.match(replied, /id: state-pack/)

  const downloaded = await resolveDiceRuleImportSource({
    group_id: "10001",
    message: [{ type: "file", data: { name: "state.yaml", file_id: "file-1" } }],
    group: { getFileUrl: async () => ({ url: "https://files.example/state.yaml" }) }
  }, "", {
    fetchImpl: async url => {
      assert.equal(url, "https://files.example/state.yaml")
      return new Response(statefulRule, { status: 200 })
    }
  })
  assert.match(downloaded, /name: 状态规则/)

  await assert.rejects(() => resolveDiceRuleImportSource({
    group_id: "10001",
    message: [{ type: "file", data: { name: "large.yaml", url: "https://files.example/large.yaml" } }]
  }, "", {
    fetchImpl: async () => new Response("x".repeat(64 * 1024 + 1), { status: 200 })
  }), /超过 65536 字节上限/)
})

test("oversized YAML never creates pending package state", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  const result = await runtime.manager.stageImport(`${statefulRule}\n#${"x".repeat(64 * 1024)}`, "master")
  assert.equal(result.ok, false)
  assert.match(result.report, /超过 65536 字节上限/)
  assert.equal(fs.existsSync(runtime.manager.getIndexPath()), false)
})

test("V2 commands resolve declared member and NPC targets with runtime permissions", async t => {
  const runtime = createRuntime({ random: () => 0.25 })
  t.after(runtime.cleanup)
  const staged = await runtime.manager.stageImport(teamRule, "master")
  assert.equal(staged.ok, true, staged.errors?.join("; "))
  await runtime.manager.confirmImport("team-pack", "master")
  await runtime.manager.enableForGroup("10001", "team-pack")

  const owner = eventWithMembers(".team 权限 设置 gm qq:20002", {
    sender: { card: "测试员", nickname: "Tester", role: "owner" }
  })
  assert.match((await runtime.manager.handleDynamicCommand(owner)).text, /GM/)
  assert.match((await runtime.manager.handleDynamicCommand(eventWithMembers(".team npc 创建 goblin 哥布林"))).text, /哥布林/)

  const attackNpc = await runtime.manager.handleDynamicCommand(eventWithMembers(".team 攻击 npc:goblin 3"))
  assert.equal(attackNpc.text, "测试员攻击哥布林，目标HP=7")
  const npcCard = await runtime.manager.handleDynamicCommand(eventWithMembers(".team 卡 npc:goblin"))
  assert.match(npcCard.text, /hp\).*7/i)

  const attackMember = await runtime.manager.handleDynamicCommand(eventWithMembers(".team 攻击 [CQ:at,qq=30003] 2"))
  assert.match(attackMember.text, /目标玩家.*HP=8/)
  const targetState = memberRuleData(runtime.diceManager.readState(), "30003", "team-pack")
  assert.equal(targetState.values.hp, 8)

  const ordinaryTarget = eventWithMembers(".team 设 qq:20002 hp=1", {
    user_id: "30003",
    sender: { card: "目标玩家", nickname: "Target", role: "member" }
  })
  assert.match((await runtime.manager.handleDynamicCommand(ordinaryTarget)).text, /只有 GM/)
  assert.match((await runtime.manager.handleDynamicCommand(eventWithMembers(".team 查 secret_note", {
    user_id: "30003",
    sender: { card: "目标玩家", nickname: "Target", role: "member" }
  }))).text, /仅 GM 可见/)
  assert.match((await runtime.manager.handleDynamicCommand(eventWithMembers(".team 设 secret_note=伪造", {
    user_id: "30003",
    sender: { card: "目标玩家", nickname: "Target", role: "member" }
  }))).text, /仅 GM 可修改/)
  assert.match((await runtime.manager.handleDynamicCommand(eventWithMembers(".team 主持命令", {
    user_id: "30003",
    sender: { card: "目标玩家", nickname: "Target", role: "member" }
  }))).text, /需要GM权限/)
})

test("V2 session lifecycle ticks statuses, group resources and equipment atomically", async t => {
  const runtime = createRuntime({ random: () => 0.5 })
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(teamRule, "master")
  await runtime.manager.confirmImport("team-pack", "master")
  await runtime.manager.enableForGroup("10001", "team-pack")
  const gm = message => eventWithMembers(message, { sender: { card: "主持人", nickname: "Keeper", role: "admin" }, user_id: "40004" })

  await runtime.manager.handleDynamicCommand(gm(".team npc 创建 slime 史莱姆"))
  await runtime.manager.handleDynamicCommand(gm(".team 状态 添加 npc:slime poison 2 1"))
  await runtime.manager.handleDynamicCommand(gm(".team 物品 添加 npc:slime sword 1"))
  await runtime.manager.handleDynamicCommand(gm(".team 物品 装备 npc:slime sword"))
  await runtime.manager.handleDynamicCommand(gm(".team 技能 学习 npc:slime fireball 1"))
  await runtime.manager.handleDynamicCommand(gm(".team 技能 使用 npc:slime fireball"))
  await runtime.manager.handleDynamicCommand(gm(".team 技能 学习 npc:slime rally 1"))
  await runtime.manager.handleDynamicCommand(gm(".team 技能 使用 npc:slime rally"))
  const cooldownFailure = await runtime.manager.handleDynamicCommand(gm(".team 技能 使用 npc:slime rally"))
  assert.match(cooldownFailure.text, /仍有 2 回合冷却/)
  let state = runtime.diceManager.readState()
  let ruleState = state.groups["10001"].diceRuleSessions["team-pack"]
  assert.equal(ruleState.group.values.mana_pool, 3)
  assert.equal(ruleState.npcs.slime.ruleData.abilities.rally.cooldown, 2)
  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 卡 npc:slime"))).text, /power\).*12/i)

  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 团务 开始 测试团"))).text, /团录已开启/)
  await runtime.manager.handleDynamicCommand(gm(".team npc 创建 scout 斥候"))
  await runtime.manager.handleDynamicCommand(gm(".team 先攻 添加 npc:slime 10"))
  await runtime.manager.handleDynamicCommand(gm(".team 先攻 添加 npc:scout 5"))
  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 先攻 开始"))).text, /史莱姆.*行动/)
  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 先攻 下一回合"))).text, /斥候.*行动/)
  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 先攻 下一回合"))).text, /第 2 轮.*史莱姆/s)

  state = runtime.diceManager.readState()
  ruleState = state.groups["10001"].diceRuleSessions["team-pack"]
  assert.equal(ruleState.npcs.slime.ruleData.values.hp, 9)
  assert.equal(ruleState.npcs.slime.ruleData.statuses.poison.duration, 1)
  assert.equal(ruleState.group.values.momentum, 3)
  assert.equal(ruleState.npcs.slime.ruleData.inventory.sword.equipped, true)
  assert.equal(ruleState.npcs.slime.ruleData.values.mp, 1)
  assert.equal(ruleState.npcs.slime.ruleData.abilities.fireball.cooldown, 0)
  assert.equal(ruleState.npcs.slime.ruleData.abilities.fireball.uses, 1)
  assert.equal(ruleState.npcs.slime.ruleData.abilities.rally.cooldown, 0)
  assert.equal(ruleState.group.values.mana_pool, 3)
  assert.ok(ruleState.audit.length >= 4)
  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 审计 3"))).text, /种子/)
  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 团务 结束"))).text, /团录已停止/)
})

test("V2 status expiry runs on_expire and removes the status atomically", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(teamRule, "master")
  await runtime.manager.confirmImport("team-pack", "master")
  await runtime.manager.enableForGroup("10001", "team-pack")
  const gm = message => eventWithMembers(message, { sender: { card: "主持人", nickname: "Keeper", role: "admin" }, user_id: "40004" })
  await runtime.manager.handleDynamicCommand(gm(".team npc 创建 ember 余烬"))
  await runtime.manager.handleDynamicCommand(gm(".team 状态 添加 npc:ember burn 1 1"))
  await runtime.manager.handleDynamicCommand(gm(".team 状态 结算 npc:ember"))
  const npc = runtime.diceManager.readState().groups["10001"].diceRuleSessions["team-pack"].npcs.ember
  assert.equal(npc.ruleData.values.hp, 9)
  assert.equal(npc.ruleData.statuses.burn, undefined)
})

test("V2 private commands without recipients do not commit actions or audit", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(teamRule, "master")
  await runtime.manager.confirmImport("team-pack", "master")
  await runtime.manager.enableForGroup("10001", "team-pack")
  const members = new Map([[20002, { user_id: 20002, card: "测试员", nickname: "Tester", role: "member" }]])
  const result = await runtime.manager.handleDynamicCommand(event(".team 秘密代价", { group: { getMemberMap: async () => members } }))
  assert.match(result.text, /没有找到可接收私密结果的 GM 或管理员/)
  const state = runtime.diceManager.readState()
  assert.equal(state.users["20002"], undefined)
  assert.equal(state.groups["10001"]?.diceRuleSessions?.["team-pack"], undefined)
})

test("V2 private and opposed commands produce structured audit without exposing private output", async t => {
  const runtime = createRuntime({ random: () => 0.1 })
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(teamRule, "master")
  await runtime.manager.confirmImport("team-pack", "master")
  await runtime.manager.enableForGroup("10001", "team-pack")
  await runtime.manager.handleDynamicCommand(eventWithMembers(".team 权限 设置 gm qq:20002", { sender: { card: "测试员", nickname: "Tester", role: "owner" } }))
  await runtime.manager.handleDynamicCommand(eventWithMembers(".team npc 创建 rival 对手"))

  const hidden = await runtime.manager.handleDynamicCommand(eventWithMembers(".team 暗骰"))
  assert.equal(hidden.text, "测试员进行了一次秘密检定。")
  assert.equal(hidden.privateMessages.length, 2)
  assert.match(hidden.privateMessages[0].text, /暗骰=1D20\[3\]/)
  assert.doesNotMatch(hidden.text, /1D20/)

  const opposed = await runtime.manager.handleDynamicCommand(eventWithMembers(".team 对抗 npc:rival"))
  assert.match(opposed.text, /测试员对抗对手：13 vs 13，胜者=平手/)
  const audit = runtime.diceManager.readState().groups["10001"].diceRuleSessions["team-pack"].audit
  assert.equal(audit.at(-2).visibility, "gm")
  assert.equal(audit.at(-1).opposed.result, "tie")
  assert.equal(audit.at(-1).seed, "external")
})

test("V2 secret builtins use recoverable private delivery and never expose values in group text", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(teamRule, "master")
  await runtime.manager.confirmImport("team-pack", "master")
  await runtime.manager.enableForGroup("10001", "team-pack")
  const admin = eventWithMembers(".team 查 secret_note", { sender: { card: "主持人", nickname: "Keeper", role: "admin" }, user_id: "40004" })
  const result = await runtime.manager.handleDynamicCommand(admin)
  assert.match(result.text, /已私聊发送/)
  assert.doesNotMatch(result.text, /hidden/)
  assert.equal(result.privateMessages.length, 1)
  assert.match(result.privateMessages[0].text, /secret_note\)=hidden/)
  let ruleState = runtime.diceManager.readState().groups["10001"].diceRuleSessions["team-pack"]
  assert.equal(ruleState.privateDeliveries.length, 1)
  await runtime.manager.settlePrivateDeliveries("10001", "team-pack", [{ deliveryId: result.privateMessages[0].deliveryId, ok: false, error: "好友限制" }])
  ruleState = runtime.diceManager.readState().groups["10001"].diceRuleSessions["team-pack"]
  assert.equal(ruleState.privateDeliveries[0].attempts, 1)
  const retry = await runtime.manager.handleDynamicCommand({ ...admin, msg: ".team 投递 重试" })
  assert.equal(retry.privateMessages[0].deliveryId, result.privateMessages[0].deliveryId)
  await runtime.manager.settlePrivateDeliveries("10001", "team-pack", [{ deliveryId: result.privateMessages[0].deliveryId, ok: true }])
  assert.equal(runtime.diceManager.readState().groups["10001"].diceRuleSessions["team-pack"].privateDeliveries.length, 0)
})

test("V2 explicit targets and private GM recipients must still belong to the current group", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(teamRule, "master")
  await runtime.manager.confirmImport("team-pack", "master")
  await runtime.manager.enableForGroup("10001", "team-pack")
  const owner = message => eventWithMembers(message, { sender: { card: "群主", nickname: "Owner", role: "owner" }, user_id: "40004" })
  assert.match((await runtime.manager.handleDynamicCommand(owner(".team 设 qq:99999 hp=1"))).text, /不在当前群/)
  await runtime.manager.handleDynamicCommand(owner(".team 权限 设置 gm qq:30003"))

  const currentMembers = new Map([
    [20002, { user_id: 20002, card: "测试员", nickname: "Tester", role: "member" }],
    [40004, { user_id: 40004, card: "群主", nickname: "Owner", role: "owner" }]
  ])
  const hidden = await runtime.manager.handleDynamicCommand(event(".team 暗骰", { group: { getMemberMap: async () => currentMembers } }))
  assert.deepEqual(hidden.privateMessages.map(item => item.userId), ["40004"])
})

test("V2 sessions preserve manual logs and reject implicit or duplicate initiative starts", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(teamRule, "master")
  await runtime.manager.confirmImport("team-pack", "master")
  await runtime.manager.enableForGroup("10001", "team-pack")
  const gm = message => eventWithMembers(message, { sender: { card: "主持人", nickname: "Keeper", role: "admin" }, user_id: "40004" })

  await runtime.manager.handleDynamicCommand(gm(".team 先攻 添加 self 10"))
  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 先攻 开始"))).text, /正式团务尚未开始/)
  assert.match(await runtime.diceManager.startLog(gm(""), "手工团录"), /已开启/)
  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 团务 开始 安全团"))).text, /沿用已有团录/)
  await runtime.manager.handleDynamicCommand(gm(".team 先攻 添加 self 10"))
  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 先攻 开始"))).text, /战斗开始/)
  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 先攻 开始"))).text, /重复开始会重复结算/)
  await runtime.manager.handleDynamicCommand(gm(".team 先攻 结束"))
  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 团务 结束"))).text, /保持开启/)
  assert.equal(runtime.diceManager.isLogActive("10001"), true)
  const ruleState = runtime.diceManager.readState().groups["10001"].diceRuleSessions["team-pack"]
  assert.equal(ruleState.sessions.length, 1)
  assert.equal(ruleState.session.logOwned, false)
})

test("V2 rollback refuses missing reverse migrations before changing the active version", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  const v1 = `
version: 1
id: safe-rollback
name: 安全回滚
aliases: [saferoll]
compatibility: { package_version: "1.0.0" }
character:
  fields:
    score: { type: integer, default: 1 }
commands:
  - { id: show, aliases: [show], output: "score={attr.score}" }
`
  const v2 = `
version: 1
id: safe-rollback
name: 安全回滚
aliases: [saferoll]
compatibility:
  package_version: "2.0.0"
  migrations:
    - { from: "1.0.0", rename_fields: { score: points } }
character:
  fields:
    points: { type: integer, default: 0 }
commands:
  - { id: show, aliases: [show], output: "points={attr.points}" }
`
  await runtime.manager.stageImport(v1, "master")
  await runtime.manager.confirmImport("safe-rollback", "master")
  await runtime.manager.enableForGroup("10001", "safe-rollback", 1)
  await runtime.manager.handleDynamicCommand(event(".safe-rollback show"))
  await runtime.manager.stageImport(v2, "master")
  await runtime.manager.confirmImport("safe-rollback", "master")
  await runtime.manager.enableForGroup("10001", "safe-rollback", 2)
  await runtime.manager.handleDynamicCommand(event(".safe-rollback show"))
  await assert.rejects(() => runtime.manager.rollbackForGroup("10001", "safe-rollback", 1), /没有从该版本出发的迁移/)
  assert.equal(runtime.manager.readIndex().groups["10001"].active["safe-rollback"], 2)
})

test("V2 campaigns provide registration, chapters, records, pause, snapshots and session history", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(teamRule, "master")
  await runtime.manager.confirmImport("team-pack", "master")
  await runtime.manager.enableForGroup("10001", "team-pack")
  const gm = message => eventWithMembers(message, { sender: { card: "主持人", nickname: "Keeper", role: "admin" }, user_id: "40004" })

  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 战役 创建 ark 魔法战役"))).text, /已创建并选中/)
  assert.match((await runtime.manager.handleDynamicCommand(eventWithMembers(".team 战役 登记 self 调查员"))).text, /已登记.*调查员/)
  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 战役 登记 qq:30003 星术师"))).text, /星术师/)
  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 战役 章节 开始 序章"))).text, /章节已开始/)
  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 战役 记录 clue 古老钥匙"))).text, /已记录线索/)
  await runtime.manager.handleDynamicCommand(gm(".team 团务 开始 第一场"))
  await runtime.manager.handleDynamicCommand(gm(".team 团务 暂停"))
  await runtime.manager.handleDynamicCommand(gm(".team 团务 快照 基线"))
  await runtime.manager.handleDynamicCommand(gm(".team 群设 momentum=5"))
  assert.equal(runtime.diceManager.readState().groups["10001"].diceRuleSessions["team-pack"].group.values.momentum, 5)
  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 团务 回退 1"))).text, /已回退/)
  assert.equal(runtime.diceManager.readState().groups["10001"].diceRuleSessions["team-pack"].group.values.momentum, 0)
  await runtime.manager.handleDynamicCommand(gm(".team 团务 恢复"))
  await runtime.manager.handleDynamicCommand(gm(".team 团务 结束"))
  await runtime.manager.handleDynamicCommand(gm(".team 战役 章节 结束"))

  const state = runtime.diceManager.readState()
  const ruleState = state.groups["10001"].diceRuleSessions["team-pack"]
  assert.equal(ruleState.campaigns.ark.members["30003"].character, "星术师")
  assert.equal(ruleState.campaigns.ark.records[0].type, "clue")
  assert.equal(ruleState.campaigns.ark.sessions.length, 1)
  assert.equal(ruleState.sessions.length, 1)
  assert.match((await runtime.manager.handleDynamicCommand(gm(".team 团务 历史"))).text, /第一场/)
})

test("V2 item and ability definitions can execute atomic on-use and equipment effects", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  const effects = `
version: 1
id: effect-pack
name: 效果规则
aliases: [fx]
compatibility: { package_version: "1.0.0" }
character:
  fields:
    hp: { type: integer, default: 5, min: 0, max: 20 }
    mp: { type: integer, default: 3, min: 0, max: 10 }
items:
  potion:
    label: 药水
    consumable: true
    on_use:
      - { op: add, field: hp, value: 5 }
      - { op: clamp, field: hp, min: 0, max: 20 }
  sword:
    label: 长剑
    stackable: false
    max_quantity: 1
    slot: hand
    on_equip:
      - { op: add, field: hp, value: 2 }
    on_unequip:
      - { op: subtract, field: hp, value: 2 }
abilities:
  heal:
    label: 治疗术
    resource_field: mp
    resource_cost: 1
    on_use:
      - { op: add, field: hp, value: 3 }
      - { op: clamp, field: hp, min: 0, max: 20 }
commands:
  - { id: show, aliases: [show], output: "HP={attr.hp},MP={attr.mp}" }
`
  assert.equal((await runtime.manager.stageImport(effects, "master")).ok, true)
  await runtime.manager.confirmImport("effect-pack", "master")
  await runtime.manager.enableForGroup("10001", "effect-pack")
  const admin = message => eventWithMembers(message, { sender: { card: "主持人", nickname: "Keeper", role: "admin" }, user_id: "40004" })
  await runtime.manager.handleDynamicCommand(admin(".fx 物品 添加 qq:20002 potion 1"))
  await runtime.manager.handleDynamicCommand(eventWithMembers(".fx 物品 使用 self potion"))
  await runtime.manager.handleDynamicCommand(admin(".fx 物品 添加 qq:20002 sword 1"))
  await runtime.manager.handleDynamicCommand(eventWithMembers(".fx 物品 装备 self sword"))
  await runtime.manager.handleDynamicCommand(eventWithMembers(".fx 物品 卸下 self sword"))
  await runtime.manager.handleDynamicCommand(admin(".fx 技能 学习 qq:20002 heal 1"))
  await runtime.manager.handleDynamicCommand(eventWithMembers(".fx 技能 使用 heal"))
  const stored = memberRuleData(runtime.diceManager.readState(), "20002", "effect-pack")
  assert.equal(stored.values.hp, 13)
  assert.equal(stored.values.mp, 2)
  assert.equal(stored.inventory.potion, undefined)
  assert.equal(stored.inventory.sword.equipped, false)
  assert.equal(stored.abilities.heal.uses, 1)
})

test("V2 identity can request opt-in group-card synchronization without exposing a platform action in YAML", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  const source = `
version: 1
id: identity-sync
name: 名片同步
aliases: [idsync]
compatibility: { package_version: "1.0.0" }
identity:
  display_name: "{attr.name}"
  group_card: "{attr.name}"
  sync_group_card: true
character:
  fields:
    name: { type: string, default: "{sender.card}" }
commands:
  - { id: show, aliases: [show], output: "角色={actor}" }
`
  assert.equal((await runtime.manager.stageImport(source, "master")).ok, true)
  await runtime.manager.confirmImport("identity-sync", "master")
  await runtime.manager.enableForGroup("10001", "identity-sync")
  const result = await runtime.manager.handleDynamicCommand(event(".idsync show"))
  assert.deepEqual(result.groupCardUpdates, [{ userId: "20002", name: "测试员" }])
})

test("V2 same-group concurrent commands remain serial and do not lose updates", async t => {
  const runtime = createRuntime({ random: () => 0.5 })
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(teamRule, "master")
  await runtime.manager.confirmImport("team-pack", "master")
  await runtime.manager.enableForGroup("10001", "team-pack")
  const gm = message => eventWithMembers(message, { sender: { card: "主持人", nickname: "Keeper", role: "admin" }, user_id: "40004" })
  await runtime.manager.handleDynamicCommand(gm(".team npc 创建 dummy 木桩"))
  await Promise.all([
    runtime.manager.handleDynamicCommand(eventWithMembers(".team 攻击 npc:dummy 2")),
    runtime.manager.handleDynamicCommand(eventWithMembers(".team 攻击 npc:dummy 3"))
  ])
  const npc = runtime.diceManager.readState().groups["10001"].diceRuleSessions["team-pack"].npcs.dummy
  assert.equal(npc.ruleData.values.hp, 5)
})

test("V2 state transaction isolates the same character between different groups", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(teamRule, "master")
  await runtime.manager.confirmImport("team-pack", "master")
  await runtime.manager.enableForGroup("10001", "team-pack")
  await runtime.manager.enableForGroup("10002", "team-pack")
  await Promise.all([
    runtime.manager.handleDynamicCommand(event(".team 自伤 2", { group_id: "10001" })),
    runtime.manager.handleDynamicCommand(event(".team 自伤 3", { group_id: "10002" }))
  ])
  const state = runtime.diceManager.readState()
  assert.equal(memberRuleData(state, "20002", "team-pack", "10001").values.hp, 8)
  assert.equal(memberRuleData(state, "20002", "team-pack", "10002").values.hp, 7)
})

test("V2 stale runtime locks are reclaimed and owned locks are released", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(teamRule, "master")
  await runtime.manager.confirmImport("team-pack", "master")
  await runtime.manager.enableForGroup("10001", "team-pack")
  const lock = path.join(runtime.manager.getRulesDir(), "locks", "runtime-10001.lock")
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  fs.writeFileSync(lock, "stale")
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(lock, old, old)
  const result = await runtime.manager.handleDynamicCommand(event(".team 卡"))
  assert.doesNotMatch(result.text, /执行失败/)
  assert.equal(fs.existsSync(lock), false)
  assert.equal(fs.existsSync(path.join(runtime.diceManager.getDataDir(), "locks", "state.lock")), false)
})

test("archive and restore roll back directory moves when index commit fails", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  await runtime.manager.stageImport(statefulRule, "master")
  await runtime.manager.confirmImport("state-pack", "master")
  const indexPath = runtime.manager.getIndexPath()
  const packageDir = path.join(runtime.manager.getRulesDir(), "packages", "state-pack")
  const originalRename = fs.renameSync
  let moved = false
  fs.renameSync = (from, to) => {
    if (String(to).includes(`${path.sep}archived${path.sep}state-pack-`)) moved = true
    if (moved && String(to) === indexPath) throw Object.assign(new Error("forced index failure"), { code: "EIO" })
    return originalRename(from, to)
  }
  try {
    await assert.rejects(() => runtime.manager.archivePackage("state-pack"), /forced index failure/)
  } finally {
    fs.renameSync = originalRename
  }
  assert.equal(fs.existsSync(packageDir), true)
  assert.ok(runtime.manager.readIndex().packages["state-pack"])
  assert.equal(fs.readdirSync(path.join(runtime.manager.getRulesDir(), "archived")).some(name => name.startsWith("state-pack-")), false)
  assert.equal(fs.readdirSync(runtime.manager.getRulesDir()).some(name => name.endsWith(".tmp")), false)

  await runtime.manager.archivePackage("state-pack")
  const archiveRoot = path.join(runtime.manager.getRulesDir(), "archived")
  const archiveName = fs.readdirSync(archiveRoot).find(name => name.startsWith("state-pack-"))
  const archiveDir = path.join(archiveRoot, archiveName)
  moved = false
  fs.renameSync = (from, to) => {
    if (String(to) === packageDir) moved = true
    if (moved && String(to) === indexPath) throw Object.assign(new Error("forced restore index failure"), { code: "EIO" })
    return originalRename(from, to)
  }
  try {
    await assert.rejects(() => runtime.manager.restoreArchivedPackage("state-pack"), /forced restore index failure/)
  } finally {
    fs.renameSync = originalRename
  }
  assert.equal(fs.existsSync(packageDir), false)
  assert.equal(fs.existsSync(archiveDir), true)
  assert.equal(runtime.manager.readIndex().packages["state-pack"], undefined)
  assert.equal(fs.readdirSync(runtime.manager.getRulesDir()).some(name => name.endsWith(".tmp")), false)
  const restored = await runtime.manager.restoreArchivedPackage("state-pack")
  assert.deepEqual(restored.versions, [1])
})

test("every documented example can be previewed, enabled and execute its first command", async t => {
  const runtime = createRuntime()
  t.after(runtime.cleanup)
  for (const file of fs.readdirSync(examplesDir).filter(name => name.endsWith(".yaml")).sort()) {
    const source = fs.readFileSync(path.join(examplesDir, file), "utf8")
    const staged = await runtime.manager.stageImport(source, "master")
    assert.equal(staged.ok, true, `${file}: ${staged.errors?.join("; ")}`)
    assert.match(runtime.manager.previewPackage(staged.pack.id), /预检通过/, file)
    await runtime.manager.confirmImport(staged.pack.id, "master")
    await runtime.manager.enableForGroup("10001", staged.pack.id)

    const command = staged.pack.commands[0]
    const args = (command.arguments || []).filter(argument => argument.required).map(argument => {
      if (argument.type === "boolean") return "true"
      if (argument.type === "enum") return String(argument.enum[0])
      if (argument.type === "string") return "示例"
      return String(Math.max(0, Number(argument.min) || 0))
    })
    const message = `.${staged.pack.aliases[0]} ${command.aliases[0]}${args.length ? ` ${args.join(" ")}` : ""}`
    const result = await runtime.manager.handleDynamicCommand(event(message))
    assert.equal(result.matched, true, file)
    assert.doesNotMatch(result.text, /执行失败/, `${file}: ${result.text}`)
    assert.ok(result.text.length > 0, file)
  }
})
