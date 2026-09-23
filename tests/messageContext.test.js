// messageContext / replySanitizer 迁移钉子:这两簇函数从 apps/test.js 原样迁出,
// 此处钉住关键行为,防止后续修改静默改变"谁在说话/伪工具清理"的判定。
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  hasBotTextAnchor,
  messageQuotesUser,
  extractMemberLookupTerms,
  matchGroupMembersByTerms,
  formatMemberLookupPrompt,
  removeBotAnchors,
  formatMemberDisplayName,
  buildQqAvatarUrl
} from "../utils/messageContext.js"
import { sanitizePseudoToolLine, sanitizeFinalReplyText, stripCqMarkup } from "../utils/replySanitizer.js"

test("提及识别:bot 名与前缀锚点", () => {
  assert.equal(hasBotTextAnchor("希洛 在吗", "希洛", []), true)
  assert.equal(hasBotTextAnchor("botbot 帮我", "", ["botbot"]), true)
  assert.equal(hasBotTextAnchor("大家晚上好", "希洛", ["bot"]), false)
})

test("引用判定:引用消息段与多种来源字段都识别", () => {
  assert.equal(messageQuotesUser({ message: [{ type: "reply", sender_id: 10001 }] }, "10001"), true)
  assert.equal(messageQuotesUser({ reply: { sender: { user_id: 10001 } } }, "10001"), true)
  assert.equal(messageQuotesUser({ message: [{ type: "reply", sender_id: 10002 }] }, "10001"), false)
  assert.equal(messageQuotesUser({}, ""), false)
})

test("成员查询:术语抽取与成员匹配、提示词拼装", () => {
  assert.deepEqual(extractMemberLookupTerms("星野是谁"), ["星野"])
  assert.deepEqual(extractMemberLookupTerms("今天天气不错"), [])

  const memberMap = new Map([
    [10001, { user_id: 10001, card: "星野", nickname: "hoshino", role: "admin" }],
    [10002, { user_id: 10002, card: "沃基", nickname: "", role: "member" }]
  ])
  const matches = matchGroupMembersByTerms(memberMap, ["星野"], "10002")
  assert.equal(matches.length, 1)
  assert.equal(matches[0].members[0].userId, 10001)
  assert.equal(matches[0].members[0].isCurrentSpeaker, false)
  assert.ok(matches[0].members[0].avatarUrl.includes("nk=10001"))

  const prompt = formatMemberLookupPrompt(matches)
  assert.ok(prompt.includes("【群成员名称匹配】"))
  assert.ok(prompt.includes("(QQ:10001)[群身份:admin"), "QQ 与群身份格式保持")
  assert.ok(prompt.includes("，头像:https://"), "头像链接随成员条目输出")
  assert.equal(formatMemberLookupPrompt([]), "")
})

test("触发锚点剥离与成员显示名", () => {
  assert.equal(removeBotAnchors("希洛帮我查一下", "bot", ["botbot"]), " 帮我查一下")
  // 原实现怪癖(保持不动):fallback "未知用户" 默认参与显示名拼接
  assert.equal(formatMemberDisplayName({ card: "小明", nickname: "aa" }), "小明（昵称:aa / 未知用户）")
  assert.equal(formatMemberDisplayName({ card: "小明" }, ""), "小明")
  assert.equal(formatMemberDisplayName({}), "未知用户")
  assert.equal(buildQqAvatarUrl("abc123456"), "https://q1.qlogo.cn/g?b=qq&nk=123456&s=640")
})

test("伪工具清理:可读文本被剥出或丢弃,普通文本原样保留", () => {
  // 纯引号参数的 print:剥出可读文本
  assert.equal(sanitizePseudoToolLine("print('在吗')"), "在吗")
  // 嵌套 text= 形态在原实现中不匹配(收尾括号不满足正则),整行判 null 丢弃
  assert.equal(sanitizePseudoToolLine("print(sendMessage(text='在吗'))"), null)
  // 非工具的普通文本原样返回
  assert.equal(sanitizePseudoToolLine("中午好呀~"), "中午好呀~")
  // 整条只剩伪工具调用时,最终清理结果为空(主链路会跳过发送)
  assert.equal(sanitizeFinalReplyText(`print(sendMessage(text="在吗"))`), "")
  assert.equal(sanitizeFinalReplyText("[CQ:image,file=abc.jpg] 中午好呀~"), "中午好呀~")
  assert.equal(stripCqMarkup("[CQ:at,qq=123]  看这里"), "看这里")
})

test("伪工具调用泄漏清洗:<tool_call>块与特殊token不透传", async () => {
  const { sanitizeFinalReplyText } = await import("../utils/replySanitizer.js")
  // 线上事故样本形态:模型把工具调用写进正文(grok 的 <tool_call> 语法 + <|eos|>)
  const leak = "先看你发的图和这条视频在说什么。\n<tool_call>\nanalyzeImageByUrl(image_urls=[\"https://multimedia.nt.qq.com/x.jpg\"])\ngetBilibiliVideoSummary(bvid=\"BV1jGeh6NEzC\")\n</tool_call>\n\n<|eos|>"
  assert.equal(sanitizeFinalReplyText(leak), "先看你发的图和这条视频在说什么。")
  // 纯调用块 → 空(触发空回复重试)
  assert.equal(sanitizeFinalReplyText("<tool_call>\nbananaTool(prompt=\"x\")\n</tool_call><|endoftext|>"), "")
  // 散装函数行(名单外工具名,按形态拦)
  assert.equal(sanitizeFinalReplyText("getBilibiliVideoSummary(bvid=\"BV1xx\")"), "")
  // 正常人话不受影响
  assert.equal(sanitizeFinalReplyText("哈哈哈哈笑死(真的)"), "哈哈哈哈笑死(真的)")
})
