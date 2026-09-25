// 卡面 markdown 标题归一化:中文模型常输出 "##2工艺流程设计"(# 后无空格),
// 标准 markdown 语法不认,渲染层统一补空格;围栏代码块不受影响。
import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeMarkdownHeadings, shouldUseDocumentTemplateForTextImage, markdownToDocumentHtml } from "../functions/functions_tools/TextImageTool.js"

test("normalizeMarkdownHeadings: ##/### 后无空格时补一个空格", () => {
  assert.equal(normalizeMarkdownHeadings("##2工艺流程设计"), "## 2工艺流程设计")
  assert.equal(normalizeMarkdownHeadings("###2.1 原料预处理"), "### 2.1 原料预处理")
  assert.equal(
    normalizeMarkdownHeadings("引言\n##1 绪论\n正文\n###1.1 背景\n结尾"),
    "引言\n## 1 绪论\n正文\n### 1.1 背景\n结尾"
  )
})

test("normalizeMarkdownHeadings: 已有空格/单个#/普通文本保持原样", () => {
  assert.equal(normalizeMarkdownHeadings("## 2 工艺流程设计"), "## 2 工艺流程设计")
  assert.equal(normalizeMarkdownHeadings("#无空格的注释形态"), "#无空格的注释形态")
  assert.equal(normalizeMarkdownHeadings("普通段落,没有井号"), "普通段落,没有井号")
  assert.equal(normalizeMarkdownHeadings(""), "")
})

test("normalizeMarkdownHeadings: 围栏代码块内的 ## 不受影响", () => {
  const src = "##1 标题\n```bash\n##这是shell注释\n##another\n```\n###2 小节"
  assert.equal(
    normalizeMarkdownHeadings(src),
    "## 1 标题\n```bash\n##这是shell注释\n##another\n```\n### 2 小节"
  )
})

test("无空格标题也能进入文档模板并渲染为 heading", () => {
  const paper = "##1 绪论\n维生素E工艺流程设计论文正文。\n##2 工艺流程设计\n本章说明工艺路线。"
  assert.equal(shouldUseDocumentTemplateForTextImage(paper), true, "归一化后应识别为 markdown")
  const html = markdownToDocumentHtml(paper)
  assert.match(html, /<h2[^>]*>1 绪论<\/h2>/)
  assert.match(html, /<h2[^>]*>2 工艺流程设计<\/h2>/)
})
