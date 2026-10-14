import test from "node:test"
import {looksLikeCodeOrMarkdown} from "../dist/backend/modules/conversation/domain/textPolicy.js"
import {resolveCardPresentation,isEducationalExplanationRequest} from "../dist/backend/modules/conversation/domain/turnPresentation.js"
import { readPluginSources } from "./helpers/pluginSources.js"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"



const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const src = readPluginSources()

test("half-width parens and semicolons no longer count as code signals", () => {
  assert.equal(looksLikeCodeOrMarkdown("今天开心(笑)；明天继续吧"),false)
  assert.equal(looksLikeCodeOrMarkdown("function run() {\n  return 1;\n}"),true)
})

test("knowledge cards require substance in the actual output", () => {
  assert.ok(
    src.includes('looksLikeEducationalExplanation(output) || String(output || "").trim().length >= 260'),
    "knowledge 命中后必须由输出实质确认才转卡，短回答回退纯文本"
  )
})

test("short knowledge questions no longer promise a card", () => {
  assert.equal(resolveCardPresentation("什么是黑洞","knowledge"),"")
  assert.equal(resolveCardPresentation("请系统讲解黑洞是怎么形成的以及有哪些性质","knowledge"),"knowledge")
  for(const text of ["整理一下表情包","解释机器人怎么导入文件","删除插件然后重启"]){assert.equal(isEducationalExplanationRequest(text),false)}
})

test("rhythm wiring consumes up to three planned messages", () => {
  assert.ok(src.includes("planTextReplyMessages(output, {"), "发送路径仍走节奏规划")
  const yaml = fs.readFileSync(path.join(root, "config_default/message.yaml"), "utf8")
  assert.ok(yaml.includes("maxTextMessages: 3"), "配置默认允许拆 3 条")
  assert.ok(yaml.includes("sentenceMaxChars"), "按句拆条的上限可配置")
})
