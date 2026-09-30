// 违禁词黑名单单测:词表匹配(普通/正则/大小写)、会话中断锚点语义、出站文本提取、出站咽喉拦截
import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  findForbiddenWord,
  markConversationInterrupted,
  getConversationInterruptedAt,
  anchorEventConversation,
  isConversationInterrupted,
  extractReplyText
} from "../utils/forbiddenWordGuard.js"

// replyRendering 引用 Yunzai 全局 logger/Bot,测试环境先垫桩
globalThis.logger = globalThis.logger || { info: () => {}, warn: () => {}, mark: () => {}, error: () => {}, debug: () => {} }
globalThis.Bot = globalThis.Bot || { nickname: "测试Bot", uin: "10000" }

beforeEach(() => {
  // 中断状态是模块级 Map,每个用例用独立群号隔离
})

test("findForbiddenWord:普通词子串命中,大小写不敏感,返回命中词", () => {
  const cfg = { enabled: true, words: ["傻逼", "BadWord"] }
  assert.equal(findForbiddenWord("你就是个傻逼吧", cfg), "傻逼")
  assert.equal(findForbiddenWord("这是个 badWORD 测试", cfg), "badword")
  assert.equal(findForbiddenWord("今天天气不错", cfg), null)
})

test("findForbiddenWord:/正则/ 形式按正则处理,非法正则降级普通词", () => {
  const cfg = { words: ["/傻{2,}逼/", "/[无效/"] }
  assert.equal(findForbiddenWord("真是个傻傻逼啊", cfg), "/傻{2,}逼/")
  assert.equal(findForbiddenWord("包含/[无效/哦", cfg), "/[无效/") // 非法正则降级为完整原词子串匹配
  assert.equal(findForbiddenWord("傻逼", cfg), null) // 单个傻逼不满足傻{2,}
})

test("findForbiddenWord:关闭/空表/空文本直接放行", () => {
  assert.equal(findForbiddenWord("傻逼", { enabled: false, words: ["傻逼"] }), null)
  assert.equal(findForbiddenWord("傻逼", { words: [] }), null)
  assert.equal(findForbiddenWord("", { words: ["傻逼"] }), null)
  assert.equal(findForbiddenWord(null, { words: ["傻逼"] }), null)
})

test("中断锚点:中断晚于锚点才作废;晚到的新回合不受旧中断影响;未锚点事件不受影响", () => {
  markConversationInterrupted("g1") // 旧中断 T1
  const e1 = anchorEventConversation({ group_id: "g1" }) // T1 后开的新回合,锚点=T1
  assert.equal(isConversationInterrupted(e1), false, "锚点晚于中断,不受影响")

  markConversationInterrupted("g1") // 新中断 T2 > T1
  assert.equal(isConversationInterrupted(e1), true, "进行中回合被新中断掐掉")

  const e2 = anchorEventConversation({ group_id: "g1" }) // 中断后再开的新回合
  assert.equal(isConversationInterrupted(e2), false, "新对话不受旧中断影响")

  const unanchored = { group_id: "g1" } // 指令回复等未锚点事件
  assert.equal(isConversationInterrupted(unanchored), false, "未锚点事件永不误杀")

  assert.equal(getConversationInterruptedAt("g-other"), 0, "其他群不受影响")
})

test("anchorEventConversation:只打一次,内部二次进入不复活已中断回合", () => {
  const e = anchorEventConversation({ group_id: "g2" })
  const anchorBefore = e._forbiddenAnchorAt
  markConversationInterrupted("g2")
  anchorEventConversation(e) // handleTool 等内部复锚,不得覆盖原锚点
  assert.equal(e._forbiddenAnchorAt, anchorBefore, "锚点不被二次进入刷新")
  assert.equal(isConversationInterrupted(e), true)
})

test("extractReplyText:字符串/CQ段数组/对象", () => {
  assert.equal(extractReplyText("你好"), "你好")
  assert.equal(extractReplyText([{ type: "text", data: "你" }, { type: "image", data: { url: "x" } }, { type: "text", text: "好" }]), "你 好")
  assert.equal(extractReplyText({ text: "对象文本" }), "对象文本")
  assert.equal(extractReplyText([{ type: "image", data: {} }]), "")
  assert.equal(extractReplyText(null), "")
})

test("出站咽喉:中断后丢弃发送;出站含违禁词拦截并中断后续", async () => {
  const { sendSegmentedMessage, sendObservedReply } = await import("../apps/lib/replyRendering.js")
  const cfg = { enabled: true, words: ["傻逼"], blockOutput: true }
  const sent = []
  const makeHost = () => ({
    config: { forbiddenWords: cfg, personaGuard: {}, smartTrigger: {}, replyRhythm: {} },
    sendObservedReply: async (e, payload) => { sent.push(payload); return { message_id: 1 } },
    claimTurnReply: async () => ({ claimed: true }),
    getPersonaFor: () => ({ name: "希洛" }),
    splitMessage: text => [text],
    convertAtInString: async text => ({ hasAt: false })
  })

  // 场景1:回合锚点早于中断 → 丢弃
  const anchored = anchorEventConversation({ group_id: "gz", group: null, reply: async p => sent.push(p), msg: "hi" })
  markConversationInterrupted("gz")
  const r1 = await sendSegmentedMessage(makeHost(), anchored, "正在生成的回复")
  assert.equal(r1, null)
  assert.equal(sent.length, 0, "中断后不应有任何发送")

  // 场景2:出站内容含违禁词 → 拦截 + 标记中断(后续同回合发送全丢)
  const fresh = anchorEventConversation({ group_id: "gy", group: null, reply: async p => sent.push(p), msg: "hi" })
  const r2 = await sendSegmentedMessage(makeHost(), fresh, "我要说傻逼了")
  assert.equal(r2, null)
  assert.equal(sent.length, 0)
  assert.ok(getConversationInterruptedAt("gy") > 0, "出站命中应标记中断")
  const r3 = await sendObservedReply(makeHost(), fresh, "第二段正常内容")
  assert.equal(r3, null, "同回合后续发送被中断吞掉")
  assert.equal(sent.length, 0)

  // 场景3:正常内容正常发送(sendObservedReply 直接路径)
  const normal = anchorEventConversation({ group_id: "gx", reply: async p => sent.push(p) })
  await sendObservedReply(makeHost(), normal, "普通回复")
  assert.equal(sent.length, 1)
})
