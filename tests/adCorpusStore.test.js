import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import os from "os"
import path from "path"
import { AdCorpusStore } from "../domains/group-admin/adCorpusStore.js"
import { analyzeModerationRules, findAdTemplateMatch, normalizeGroupModerationConfig } from "../domains/group-admin/groupModerationRules.js"

function tempStore({ maxEntries } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-corpus-"))
  const store = new AdCorpusStore({ filePath: path.join(dir, "ad_corpus.jsonl"), maxEntries, logger: null })
  return { store, dir }
}

test("广告入库后持久化并可重新加载", () => {
  const { store, dir } = tempStore()
  try {
    const added = store.addEntry({ text: "三角洲行动今日密码freesync 改枪码6y3f5s 利润排行特勤处制造曼德尔砖", groupId: 123, userId: 456, addedBy: 789 })
    assert.equal(added.ok, true)
    assert.match(added.entry.id, /^[a-z0-9]+$/)

    const reloaded = new AdCorpusStore({ filePath: path.join(dir, "ad_corpus.jsonl"), logger: null })
    assert.deepEqual(reloaded.getTemplateTexts(), [added.entry.text])
    assert.equal(reloaded.readEntries()[0].groupId, "123")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("空白差异的同一条广告判重不入库", () => {
  const { store, dir } = tempStore()
  try {
    store.addEntry({ text: "扫码进群 领取福利 兼职日结" })
    const again = store.addEntry({ text: "  扫码进群   领取福利  兼职日结  " })
    assert.equal(again.ok, false)
    assert.equal(again.duplicate, true)
    assert.equal(store.getStats().total, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("过短内容拒绝入库，按编号可删除", () => {
  const { store, dir } = tempStore()
  try {
    assert.equal(store.addEntry({ text: "加v" }).ok, false)
    const added = store.addEntry({ text: "这是一条足够长的广告样本内容用于测试删除" })
    const removed = store.removeEntry(added.entry.id)
    assert.equal(removed.ok, true)
    assert.equal(store.getStats().total, 0)
    assert.equal(store.removeEntry(added.entry.id).ok, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("达到上限时淘汰最旧样本", () => {
  const { store, dir } = tempStore({ maxEntries: 2 })
  try {
    const first = store.addEntry({ text: "第一条广告样本内容足够长一号样本" })
    store.addEntry({ text: "第二条广告样本内容足够长二号样本" })
    const third = store.addEntry({ text: "第三条广告样本内容足够长三号样本" })
    assert.equal(third.ok, true)
    assert.equal(third.droppedCount, 1)
    const texts = store.getTemplateTexts()
    assert.equal(texts.length, 2)
    assert.ok(!texts.includes(first.entry.text), "最旧样本应被淘汰")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("配置种子模板可导入样本库且幂等", () => {
  const { store, dir } = tempStore()
  try {
    const templates = [
      "扫码进群 加群二维码 群聊邀请 长按识别二维码 进群领取福利",
      "推广加V 加微信 私聊领取 名额有限 免费带 兼职副业 日结佣金"
    ]
    assert.equal(store.importSeedTemplates(templates), 2)
    assert.equal(store.importSeedTemplates(templates), 0, "重复导入应全部跳过")
    assert.equal(store.getStats().total, 2)
    assert.ok(store.readEntries().every(entry => entry.source === "seed"))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("自动入库的样本标记 source=auto 且可按原文定位删除", () => {
  const { store, dir } = tempStore()
  try {
    const autoAdd = store.addEntry({ text: "免费送皮肤 点击链接领取 限时三天", addedBy: "auto-detect", source: "auto" })
    assert.equal(autoAdd.ok, true)
    assert.equal(store.readEntries()[0].source, "auto")

    // .广告出库 的定位逻辑：先精确
    const direct = store.findByText("免费送皮肤 点击链接领取 限时三天")
    assert.ok(direct)
    assert.equal(store.removeEntry(direct.id).ok, true)
    assert.equal(store.getStats().total, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("adCorpusAutoCollect 默认开启且可显式关闭", () => {
  assert.equal(normalizeGroupModerationConfig({}).adCorpusAutoCollect, true)
  assert.equal(normalizeGroupModerationConfig({ adCorpusAutoCollect: false }).adCorpusAutoCollect, false)
})

test("入库后的样本参与判重：变体消息命中广告样本库规则", () => {
  const config = normalizeGroupModerationConfig({ minActiveLevel: 5 })
  const corpusText = "三角洲行动烽火地带今日密码freesync改枪码6y3f5s利润排行特勤处波比克哈夫币制造曼德尔砖"
  const variantMessage = "三角洲行动烽火地带今日密码freesync改枪码6y3f5s利润排行特勤处制造曼德尔砖价格表"

  const noCorpus = analyzeModerationRules({ memberLevel: 3, text: variantMessage }, config)
  assert.ok(!noCorpus.rules.includes("命中广告样本库"), "无样本时不应命中")

  const withCorpus = analyzeModerationRules({ memberLevel: 3, text: variantMessage }, config, { extraTemplates: [corpusText] })
  assert.ok(withCorpus.rules.includes("命中广告样本库"), "样本库应命中变体")
  assert.ok(withCorpus.confidence > noCorpus.confidence)
})

test("findAdTemplateMatch 标注命中来源且种子模板仍可用", () => {
  const config = normalizeGroupModerationConfig({
    adTemplates: ["推广加V 加微信 私聊领取 名额有限 免费带 兼职副业 日结佣金"]
  })
  const seedHit = findAdTemplateMatch("推广加v 加微信 私聊领取 名额有限 免费带 兼职副业 佣金日结", config)
  assert.equal(seedHit?.origin, "seed")

  const corpusHit = findAdTemplateMatch("三角洲改枪码资源今日密码利润排行一手更新", config, ["三角洲改枪码资源今日密码利润排行一手更新请联系"])
  assert.equal(corpusHit?.origin, "corpus")
})
