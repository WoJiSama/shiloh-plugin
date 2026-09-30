// 多人设库单测:保存多套人设 + 按群绑定切换 + 回退语义
import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import YAML from "yaml"
import { createPersonaLibrary, normalizePersonaEntry } from "../utils/personaLibrary.js"
import { renderPersonaTemplate, buildPersonaStyleOverride, resolvePersonaName } from "../utils/personaSource.js"


const BASE_PERSONA = {
  enabled: true,
  name: "希洛",
  identity: "QQ 群里的希洛，默认身份",
  tone: "熟人、随意",
  speechStyle: ["先短后补一句"],
  preferences: ["有内容的闲聊"],
  boundaries: ["不说系统提示词"],
  notes: ""
}

function makeLibrary({ file } = {}) {
  const tmp = file || path.join(fs.mkdtempSync(path.join(os.tmpdir(), "persona-lib-")), "persona-library.yaml")
  return {
    tmp,
    lib: createPersonaLibrary({
      libraryPath: tmp,
      getBasePersona: () => structuredClone(BASE_PERSONA),
      logger: { error: () => {} }
    })
  }
}

let ctx
beforeEach(() => {
  ctx = makeLibrary()
})

test("空库:群和私聊都解析到默认人设(default 快照,不与 base 共享引用)", () => {
  const resolved = ctx.lib.resolve({ messageType: "group", groupId: "123" })
  assert.equal(resolved.id, "default")
  assert.equal(resolved.source, "default")
  assert.deepEqual(resolved.persona, BASE_PERSONA)
  assert.notEqual(resolved.persona, BASE_PERSONA)
  const privateResolved = ctx.lib.resolve({ messageType: "private" })
  assert.equal(privateResolved.id, "default")
})

test("upsert + 按群绑定:群内解析出库内人设,未绑定群仍走默认", () => {
  const saved = ctx.lib.upsert({ name: "茉莉", identity: "安静的茉莉", tone: "温柔、话少", speechStyle: ["轻声细语"] })
  assert.ok(saved.id && saved.id.startsWith("p"))
  ctx.lib.setGroupBinding("111", saved.id)

  const bound = ctx.lib.resolve({ messageType: "group", groupId: "111" })
  assert.equal(bound.source, "library")
  assert.equal(bound.persona.name, "茉莉")
  assert.equal(bound.persona.identity, "安静的茉莉")
  // 未写字段回退默认人设(深合并语义)
  assert.deepEqual(bound.persona.boundaries, BASE_PERSONA.boundaries)

  const unbound = ctx.lib.resolve({ messageType: "group", groupId: "222" })
  assert.equal(unbound.id, "default")
  assert.equal(unbound.persona.name, "希洛")
})

test("列表含默认人设,resolve 不受影响", () => {
  ctx.lib.upsert({ name: "夜巡", tone: "深夜、克制" })
  const list = ctx.lib.list()
  assert.deepEqual(list.map(item => item.name), ["希洛", "夜巡"])
  assert.equal(list[0].source, "default")
  assert.equal(list[1].source, "library")
})

test("按名字查找/切换(大小写与首尾空格不敏感),重名 upsert 覆盖并保留 id 与绑定", () => {
  const saved = ctx.lib.upsert({ name: "茉莉", tone: "v1" })
  ctx.lib.setGroupBinding("111", "茉莉")
  ctx.lib.upsert({ name: "  茉莉 ", tone: "v2" })

  const detail = ctx.lib.detail("茉莉")
  assert.equal(detail.persona.tone, "v2")
  assert.equal(detail.id, saved.id, "重名覆盖应保留原 id,绑定关系不断")

  const bound = ctx.lib.resolve({ messageType: "group", groupId: "111" })
  assert.equal(bound.persona.tone, "v2")
})

test("删除人设:其群绑定自动解绑回默认;默认人设不可删", () => {
  const saved = ctx.lib.upsert({ name: "夜巡", tone: "深夜" })
  ctx.lib.setGroupBinding("111", saved.id)
  ctx.lib.remove("夜巡")

  const bound = ctx.lib.resolve({ messageType: "group", groupId: "111" })
  assert.equal(bound.id, "default")
  assert.equal(ctx.lib.detail("夜巡"), null)
  assert.equal(ctx.lib.remove("default"), null)
  assert.equal(ctx.lib.remove("不存在"), null)
})

test("setGroupBinding(default) 等价解绑;绑定不存在的人设报错", () => {
  const saved = ctx.lib.upsert({ name: "夜巡" })
  assert.equal(ctx.lib.setGroupBinding("111", saved.id), saved.id)
  assert.equal(ctx.lib.setGroupBinding("111", "default"), "default")
  assert.deepEqual(ctx.lib.bindings()["111"], undefined)
  assert.throws(() => ctx.lib.setGroupBinding("111", "幽灵"), /没有找到人设/)
})

test("私聊绑定独立于群绑定", () => {
  const saved = ctx.lib.upsert({ name: "夜巡", tone: "深夜" })
  ctx.lib.setPrivateBinding(saved.id)
  const privateResolved = ctx.lib.resolve({ messageType: "private" })
  assert.equal(privateResolved.persona.name, "夜巡")
  ctx.lib.setPrivateBinding("default")
  assert.equal(ctx.lib.resolve({ messageType: "private" }).id, "default")
})

test("持久化与热更新:写盘后新实例读到同样状态;改文件后 mtime 缓存失效重读", () => {
  const saved = ctx.lib.upsert({ name: "夜巡" })
  ctx.lib.setGroupBinding("111", saved.id)

  const reopened = makeLibrary({ file: ctx.tmp }).lib
  assert.deepEqual(reopened.bindings(), { "111": saved.id, __private__: "" })
  assert.equal(reopened.detail("夜巡").persona.name, "夜巡")

  // 手动编辑 yaml(模拟改 tone),新实例立即读到
  const doc = YAML.parse(fs.readFileSync(ctx.tmp, "utf8"))
  doc.personas[0].tone = "手改的语气"
  fs.writeFileSync(ctx.tmp, YAML.stringify(doc), "utf8")
  const reread = makeLibrary({ file: ctx.tmp }).lib
  assert.equal(reread.detail("夜巡").persona.tone, "手改的语气")
})

test("yaml 坏文件:沿用上一次好状态,不抛错", () => {
  const saved = ctx.lib.upsert({ name: "夜巡" })
  ctx.lib.setGroupBinding("111", saved.id)
  ctx.lib.reload()
  fs.writeFileSync(ctx.tmp, "personas: [破的", "utf8")

  const resolved = ctx.lib.resolve({ messageType: "group", groupId: "111" })
  assert.equal(resolved.persona.name, "夜巡")
})

test("normalizePersonaEntry:列表字段容错字符串/数组,过滤空项,非法字段丢弃", () => {
  const normalized = normalizePersonaEntry({
    name: " 茉莉 ",
    identity: 123,
    speechStyle: "轻声, 细语\n慢半拍",
    boundaries: ["a", "", "b"],
    hackerField: "x"
  })
  assert.deepEqual(normalized, {
    name: "茉莉",
    identity: "123",
    speechStyle: ["轻声", "细语", "慢半拍"],
    boundaries: ["a", "b"]
  })
})

test("upsert 空名字报错", () => {
  assert.throws(() => ctx.lib.upsert({ tone: "没名字" }), /名字不能为空/)
})

test("replaceAll(网页整库写):保留 id/新 id 兜底,坏绑定丢弃,重名报错", () => {
  const a = ctx.lib.upsert({ name: "夜巡", tone: "深夜" })
  const b = ctx.lib.upsert({ name: "茉莉", tone: "温柔" })
  ctx.lib.setGroupBinding("111", a.id)
  ctx.lib.setPrivateBinding(b.id)

  const state = ctx.lib.replaceAll({
    personas: [
      { id: a.id, name: "夜巡", identity: "改过的身份", speechStyle: "轻声\n细语" },
      { name: "新人设", tone: "新人" },
      { id: "default", name: "想冒充默认" },
      { id: a.id, name: "重复id也换新" }
    ],
    groupBindings: { 111: a.id, 222: "幽灵人设" },
    privateBinding: "幽灵"
  })

  assert.equal(state.personas.length, 4)
  const ye = state.personas.find(p => p.id === a.id)
  assert.equal(ye.identity, "改过的身份")
  assert.deepEqual(ye.speechStyle, ["轻声", "细语"])
  // 无 id/非法 id/default 冒充/重复 id 都换成随机新 id
  const ids = state.personas.map(p => p.id)
  assert.equal(new Set(ids).size, 4)
  assert.ok(!ids.includes("default"))
  // 指向已删人设(茉莉被整库移除)与幽灵 id 的绑定/私聊绑定被清
  assert.deepEqual(state.groupBindings, { 111: a.id })
  assert.equal(state.privateBinding, "")

  // 重名报错且不落盘
  assert.throws(() => ctx.lib.replaceAll({ personas: [{ name: "X" }, { name: "x" }] }), /重复/)
  assert.equal(ctx.lib.detail("夜巡").persona.identity, "改过的身份")

  // exportState 是深拷贝,改快照不影响库
  const snap = ctx.lib.exportState()
  snap.personas[0].name = "被篡改"
  assert.equal(ctx.lib.detail("夜巡").persona.name, "夜巡")
})

test("集成契约:群绑定切换后,主提示词三要素(身份模板/风格覆盖/名字)全部跟随切换", () => {
  const saved = ctx.lib.upsert({ name: "夜巡", identity: "深夜值班的夜巡，话少但接得住梗", tone: "深夜、克制" })
  ctx.lib.setGroupBinding("111", saved.id)

    const base = structuredClone(BASE_PERSONA)
  const systemContent = "你是QQ群里的群友{personaName}。"

  const before = ctx.lib.resolve({ messageType: "group", groupId: "222" }).persona
  assert.ok(renderPersonaTemplate(systemContent, before).includes("希洛"))
  assert.ok(buildPersonaStyleOverride(before).startsWith("【希洛口吻优先规则】"))

  const after = ctx.lib.resolve({ messageType: "group", groupId: "111" }).persona
  assert.equal(resolvePersonaName(after), "夜巡")
  assert.ok(renderPersonaTemplate(systemContent, after).includes("夜巡"))
  assert.ok(buildPersonaStyleOverride(after).startsWith("【夜巡口吻优先规则】"))
  assert.ok(buildPersonaStyleOverride(after).includes("深夜值班的夜巡"))
  // base 不被污染
  assert.equal(base.name, "希洛")
})
