import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  EMOJI_REACTION_RULES,
  classifyEmojiToolExposure,
  resolveForcedReactionEmoji
} from "../utils/emojiToolPolicy.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// 曾经手工维护在 CASUAL_EMOJI_REACTION_PATTERNS 里的全部情绪词，
// 重构后必须仍然被识别为 casual_reaction（回归基线，防止单一规则源漏词）
const LEGACY_CASUAL_PHRASES = [
  "笑死", "笑不活了", "绷不住", "蚌埠住了", "太逗了", "会谢", "绝了", "真行啊", "还真敢",
  "太离谱了", "无语", "好怪", "有点尴尬", "社死了", "破防了", "认怂", "装无辜", "害羞",
  "有点得意", "救命", "乐死我了", "乐疯了", "哈哈哈哈", "嘿嘿嘿", "卧槽", "我超", "666",
  "寄了", "急了", "典中典", "好好好", "不是吧", "真的假的", "逆天", "我服了", "什么鬼",
  "看傻了", "傻眼了", "看懵了", "懵了", "困死", "累死", "不想动", "烦死", "气死", "裂开",
  "崩溃了", "委屈死", "可怜巴巴", "好耶", "太好了", "牛啊", "哼，", "草了", "摸摸我",
  "安慰一下我", "哄哄我", "啊？"
]

test("legacy casual reaction phrases still classify as casual_reaction", () => {
  for (const phrase of LEGACY_CASUAL_PHRASES) {
    assert.equal(classifyEmojiToolExposure(phrase), "casual_reaction", `漏词: ${phrase}`)
  }
})

test("exposure classification keeps explicit, remote and serious apart", () => {
  assert.equal(classifyEmojiToolExposure("来个表情包"), "explicit")
  assert.equal(classifyEmojiToolExposure("斗图吗"), "explicit")
  assert.equal(classifyEmojiToolExposure("网上搜个表情包"), "none")
  assert.equal(classifyEmojiToolExposure("帮我查一下天气"), "none")
  assert.equal(classifyEmojiToolExposure("这个报错怎么办"), "none")
  assert.equal(classifyEmojiToolExposure("顺便帮我画一张猫猫图"), "none")
  assert.equal(classifyEmojiToolExposure(""), "none")
})

test("forced rules only fire for tag-bearing rules", () => {
  const forced = resolveForcedReactionEmoji("笑死")
  assert.ok(forced?.tags.includes("笑死"))
  assert.deepEqual(resolveForcedReactionEmoji("绝了"), null, "识别型规则（无 tags）不得走强制路径")
  assert.deepEqual(resolveForcedReactionEmoji("来个表情包"), null, "explicit 不走强制路径")
})

test("reaction rules are the single source: casual set derives from the rule array", () => {
  assert.ok(EMOJI_REACTION_RULES.length >= 10)
  const tagRules = EMOJI_REACTION_RULES.filter(rule => rule.tags?.length)
  const detectOnly = EMOJI_REACTION_RULES.filter(rule => !rule.tags?.length)
  assert.equal(tagRules.length, 8, "8 条强制规则保持不变")
  assert.ok(detectOnly.length >= 3, "识别型规则独立存在")
})

test("emoji failures fall silent instead of triggering an apology model call", () => {
  const src = fs.readFileSync(path.join(root, "apps/test.js"), "utf8")
  assert.ok(
    src.includes("if (toolName === LOCAL_EMOJI_TOOL_NAME) {"),
    "表情工具失败必须静默跳过"
  )
  assert.ok(src.includes("发送未完成，本轮静默跳过"), "静默跳过有日志可查")
})

test("selection no longer falls back to a random image on specific misses", () => {
  const managerSrc = fs.readFileSync(path.join(root, "domains/emoji/EmojiPackManager.js"), "utf8")
  assert.ok(managerSrc.includes('strategy: "no_match"'), "有明确诉求未命中时返回 no_match 而不是随机图")
  const toolSrc = fs.readFileSync(path.join(root, "functions/functions_tools/SendLocalEmojiTool.js"), "utf8")
  assert.ok(toolSrc.includes("本轮请用纯文字回复"), "无匹配返回文字引导（非 error 前缀）")
  assert.ok(toolSrc.includes("表情库还没建起来"), "库空返回文字引导")
})

test("clearAll goes through the manager, not external field pokes", () => {
  const appSrc = fs.readFileSync(path.join(root, "domains/emoji/app.js"), "utf8")
  assert.ok(appSrc.includes("emojiPackManager.clearAllData()"), "命令层只调用 manager 方法")
  assert.ok(!appSrc.includes("emojiPackManager.recentPicksByGroup.clear()"), "不再越过封装清内部状态")
})
