import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const src = fs.readFileSync(path.join(root, "apps/test.js"), "utf8")

test("half-width parens and semicolons no longer count as code signals", () => {
  // 此前 /\\[{}();\\]/ 让含 "(笑)" 颜文字或英文缩写的普通回复被判成代码 → 整条变文档卡面
  assert.ok(!src.includes("/[{}();]/.test(line)"), "宽泛的括号/分号信号必须移除")
  assert.ok(src.includes("/[{}]/.test(line)"), "花括号保留为代码信号")
})

test("knowledge cards require substance in the actual output", () => {
  assert.ok(
    src.includes('looksLikeEducationalExplanation(output) || String(output || "").trim().length >= 260'),
    "knowledge 命中后必须由输出实质确认才转卡，短回答回退纯文本"
  )
})

test("short knowledge questions no longer promise a card", () => {
  assert.ok(
    src.includes('responseKind === "knowledge" && normalizeIntentText(userText).length >= 12'),
    "短问句（如\"什么是黑洞\"）不再发\"整理成卡片\"承诺"
  )
  assert.ok(
    /表情包\|表情\|插件\|机器人\|文件\|导入\|删除\|重启\|禁言\|群名片/.test(src),
    "运营/管理类内容（\"整理一下表情包\"）不再误判为知识讲解"
  )
})

test("rhythm wiring consumes up to three planned messages", () => {
  assert.ok(src.includes("planTextReplyMessages(output, {"), "发送路径仍走节奏规划")
  const yaml = fs.readFileSync(path.join(root, "config_default/message.yaml"), "utf8")
  assert.ok(yaml.includes("maxTextMessages: 3"), "配置默认允许拆 3 条")
  assert.ok(yaml.includes("sentenceMaxChars"), "按句拆条的上限可配置")
})
