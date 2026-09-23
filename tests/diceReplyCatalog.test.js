import test from "node:test"
import assert from "node:assert/strict"
import {
  BUILTIN_RULES,
  buildDiceReplyPayload,
  pickCheckTemplate,
  mergeDiceReplyConfig
} from "../domains/dice/diceReplyCatalog.js"

test("COC card lists .st inside as an editable command group", () => {
  const coc = BUILTIN_RULES.find(item => item.id === "coc7")
  assert.ok(coc.commands.includes(".st"))
  const st = coc.groups.find(group => group.command === ".st")
  assert.equal(st.title, ".st 人物卡")
  assert.deepEqual(st.templates.map(item => item.key), ["card", "cardSaved"])
  const ra = coc.groups.find(group => group.command === ".ra")
  assert.ok(ra.templates.some(item => item.key === "check_fail" && item.label.includes("失败")))
  assert.ok(ra.templates.some(item => item.key === "check_fumble" && item.label.includes("大失败")))
  const common = BUILTIN_RULES.find(item => item.id === "common")
  assert.ok(common.commands.includes(".nn"))
  assert.ok(common.commands.includes(".sn"))
})

test("payload merges missing check levels and templates from defaults", () => {
  const payload = buildDiceReplyPayload({})
  assert.equal(payload.checkLevels.fail, "失败")
  assert.equal(payload.checkLevels.fumble, "大失败")
  assert.equal(payload.templates.cardSaved, "人物卡已更新：{updates}")
  assert.equal(payload.templates.check_fail, "")
  assert.ok(payload.checkLevelMeta.some(item => item.key === "fail" && item.label === "失败"))
})

test("pickCheckTemplate uses outcome override only when it has text", () => {
  const templates = {
    check: "DEFAULT {level}",
    check_fail: "FAIL {skill}",
    check_fumble: "   "
  }
  assert.equal(pickCheckTemplate(templates, "失败"), "FAIL {skill}")
  assert.equal(pickCheckTemplate(templates, "大失败"), "DEFAULT {level}")
  assert.equal(pickCheckTemplate(templates, "成功"), "DEFAULT {level}")
})

test("custom level names still map to the matching outcome template", () => {
  const merged = mergeDiceReplyConfig({
    checkLevels: { fail: "没过", fumble: "炸了" },
    templates: { check: "DEFAULT {level}", check_fail: "FAIL-MSG", check_fumble: "FUMBLE-MSG" }
  })
  assert.equal(pickCheckTemplate(merged.templates, "没过", merged.checkLevels), "FAIL-MSG")
  assert.equal(pickCheckTemplate(merged.templates, "炸了", merged.checkLevels), "FUMBLE-MSG")
})

test("jrrp 分数段:落段边界与自定义覆盖", async () => {
  const { pickJrrpComment, DEFAULT_JRRP_COMMENTS, mergeDiceReplyConfig } = await import("../domains/dice/diceReplyCatalog.js")
  assert.equal(DEFAULT_JRRP_COMMENTS.length, 6)
  assert.equal(pickJrrpComment(1, ["a", "b", "c", "d", "e", "f"]), "a")
  assert.equal(pickJrrpComment(10, ["a", "b", "c", "d", "e", "f"]), "a")
  assert.equal(pickJrrpComment(11, ["a", "b", "c", "d", "e", "f"]), "b")
  assert.equal(pickJrrpComment(50, ["a", "b", "c", "d", "e", "f"]), "c")
  assert.equal(pickJrrpComment(70, ["a", "b", "c", "d", "e", "f"]), "d")
  assert.equal(pickJrrpComment(90, ["a", "b", "c", "d", "e", "f"]), "e")
  assert.equal(pickJrrpComment(100, ["a", "b", "c", "d", "e", "f"]), "f")
  // 空位回落默认，不整段替换
  const merged = mergeDiceReplyConfig({ jrrpComments: ["自定义凶", "", "", "", "", ""] })
  assert.equal(merged.jrrpComments[0], "自定义凶")
  assert.equal(merged.jrrpComments[1], DEFAULT_JRRP_COMMENTS[1])
})
