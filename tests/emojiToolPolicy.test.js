import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  EMOJI_REACTION_RULES,
  adaptForcedReplyTextRate,
  classifyEmojiToolExposure,
  pickForcedReplyLayout,
  resolveForcedReactionEmoji, looksLikeDirectPersonalQuestion, resolveEmojiTurnSkips } from "../utils/emojiToolPolicy.js"

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

function readPluginSources() {
  const libDir = new URL("../apps/lib/", import.meta.url)
  const parts = [fs.readFileSync(new URL("../apps/test.js", import.meta.url), "utf8")]
  for (const file of fs.readdirSync(libDir).filter(f => f.endsWith(".js"))) {
    parts.push(fs.readFileSync(new URL(file, libDir), "utf8"))
  }
  return parts.join("\n")
}

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

test("every forced rule carries a reply pool for the fast path", () => {
  const tagRules = EMOJI_REACTION_RULES.filter(rule => rule.tags?.length)
  assert.equal(tagRules.length, 8)
  for (const rule of tagRules) {
    assert.ok(rule.replies?.length >= 2, `规则 ${rule.tags[0]} 缺配文池`)
  }
  assert.deepEqual(resolveForcedReactionEmoji("累死").replies, ["累麻了", "不想动了", "让我躺会儿"])
})

test("forced reply layout samples text from the pool at the configured rate", () => {
  // draw < rate → 带配文；同一 draw 决定选哪句（确定性可测）
  const withText = pickForcedReplyLayout({ replies: ["哈哈哈哈", "笑死"], textRate: 0.4, random: () => 0.2 })
  assert.equal(withText.layout, "text_emoji")
  assert.ok(["哈哈哈哈", "笑死"].includes(withText.leadText))
  const emojiOnly = pickForcedReplyLayout({ replies: ["哈哈哈哈"], textRate: 0.4, random: () => 0.5 })
  assert.equal(emojiOnly.layout, "emoji")
  assert.equal(emojiOnly.leadText, "")
  // 空池/零概率 → 永远纯图
  assert.equal(pickForcedReplyLayout({ replies: [], textRate: 1, random: () => 0 }).layout, "emoji")
  assert.equal(pickForcedReplyLayout({ replies: ["x"], textRate: 0, random: () => 0 }).layout, "emoji")
})

test("forced reply text rate adapts to the group's bare-emoji share", () => {
  assert.equal(adaptForcedReplyTextRate(null, 0.4), 0.4, "无统计用默认")
  assert.equal(adaptForcedReplyTextRate({ samples: 19, emojiOnlyShare: 0.9 }, 0.4), 0.4, "样本不足用默认")
  assert.equal(adaptForcedReplyTextRate({ samples: 100, emojiOnlyShare: 0.9 }, 0.4), 0.15, "裸表情占比 90% → 配文率夹到下限")
  assert.equal(adaptForcedReplyTextRate({ samples: 100, emojiOnlyShare: 0.1 }, 0.4), 0.6, "几乎都带文字 → 夹到上限")
  assert.equal(adaptForcedReplyTextRate({ samples: 100, emojiOnlyShare: 0.6 }, 0.4), 0.4)
})

test("forced fast path wires the reply pool and cooldown respects lead text", () => {
  // 表情强制路已迁入 utils/routeDecision.js;群自适应统计与 emoji-only 判定仍在主链路
  const pluginSource = readPluginSources()
  const routeSrc = fs.readFileSync(path.join(root, "utils/routeDecision.js"), "utf8")
  assert.ok(routeSrc.includes("const forcedLayout = pickForcedReplyLayout({"), "强制路接入配文采样")
  assert.ok(routeSrc.includes("leadText: forcedLayout.leadText"), "配文进入工具参数")
  assert.ok(routeSrc.includes("await ctx.helpers.resolveForcedReplyTextRate(ctx.groupId)"), "配文率走群自适应助手")
  assert.ok(pluginSource.includes("getGroupEmojiLayoutStats?.(groupId)"), "自适应读取表达学习统计")
  assert.ok(
    pluginSource.includes('!validResults.some(r => String(r.result || "").includes("段文字"))'),
    "带 leadText 的回合不得记为 emoji-only 冷却"
  )
})

test("reaction rules are the single source: casual set derives from the rule array", () => {
  assert.ok(EMOJI_REACTION_RULES.length >= 10)
  const tagRules = EMOJI_REACTION_RULES.filter(rule => rule.tags?.length)
  const detectOnly = EMOJI_REACTION_RULES.filter(rule => !rule.tags?.length)
  assert.equal(tagRules.length, 8, "8 条强制规则保持不变")
  assert.ok(detectOnly.length >= 3, "识别型规则独立存在")
})

test("emoji failures fall silent instead of triggering an apology model call", () => {
  const pluginSource = fs.readFileSync(path.join(root, "apps/test.js"), "utf8")
  assert.ok(
    pluginSource.includes("if (toolName === LOCAL_EMOJI_TOOL_NAME) {"),
    "表情工具失败必须静默跳过"
  )
  assert.ok(pluginSource.includes("发送未完成，本轮静默跳过"), "静默跳过有日志可查")
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

test("直接个人提问识别:表情包不得独占这类回复", () => {
  assert.equal(looksLikeDirectPersonalQuestion("希洛你现在在干嘛呀"), true)
  assert.equal(looksLikeDirectPersonalQuestion("在吗"), true)
  assert.equal(looksLikeDirectPersonalQuestion("睡了没"), true)
  assert.equal(looksLikeDirectPersonalQuestion("希洛 还好吗"), true)
  // 情感试探问句也算直接个人提问,不能用一张表情包打发
  assert.equal(looksLikeDirectPersonalQuestion("你爱不爱我"), true)
  assert.equal(looksLikeDirectPersonalQuestion("希洛你喜欢我吗"), true)
  assert.equal(looksLikeDirectPersonalQuestion("想不想我"), true)
  // 问的不是 bot 本人,或长文本,不算
  assert.equal(looksLikeDirectPersonalQuestion("大家在干嘛呢"), false)
  assert.equal(looksLikeDirectPersonalQuestion("你们那边在干嘛"), false)
  assert.equal(looksLikeDirectPersonalQuestion("他们在忙吗"), false)
  // 求夸/求表扬是对 bot 的直接请求,不能用一张表情包打发
  assert.equal(looksLikeDirectPersonalQuestion("那你夸啊"), true)
  assert.equal(looksLikeDirectPersonalQuestion("夸夸我"), true)
  assert.equal(looksLikeDirectPersonalQuestion("来点彩虹屁"), true)
  // 夸第三方不算直接个人请求
  assert.equal(looksLikeDirectPersonalQuestion("你夸夸他"), false)
  assert.equal(looksLikeDirectPersonalQuestion("夸她两句"), false)
  assert.equal(looksLikeDirectPersonalQuestion("你爱不爱吃辣"), false)
  assert.equal(looksLikeDirectPersonalQuestion("这个东西的原理是怎么回事,为什么大家都在说这个方案不行,我看不懂而且想弄明白每个细节,能展开讲讲吗"), false)
})

test("表情包每轮上限:一轮并行的重复 emoji 调用只放行第一张", () => {
  assert.deepEqual(
    resolveEmojiTurnSkips(["sendLocalEmojiTool", "sendLocalEmojiTool"]),
    [false, true]
  )
  assert.deepEqual(
    resolveEmojiTurnSkips(["bananaTool", "sendLocalEmojiTool", "sendLocalEmojiTool"]),
    [false, false, true]
  )
  assert.deepEqual(
    resolveEmojiTurnSkips(["sendLocalEmojiTool", "bananaTool"]),
    [false, false]
  )
  // 跨轮沿用 session 计数:本轮已发过,再调用直接跳过
  assert.deepEqual(
    resolveEmojiTurnSkips(["sendLocalEmojiTool"], 1),
    [true]
  )
  // 配置上限可调
  assert.deepEqual(
    resolveEmojiTurnSkips(["sendLocalEmojiTool", "sendLocalEmojiTool"], 0, 2),
    [false, false]
  )
})
