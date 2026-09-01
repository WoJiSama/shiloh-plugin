import assert from "node:assert/strict"
import { test } from "node:test"
import { containsCodeFence, flattenCodeFences } from "../utils/qqCodeFenceText.js"

test("bash 围栏代码块压平为逐行行内代码", () => {
  const input = "安装完成后输入：\n\n```bash\ngit --version\n```\n\n能看到版本号就装好了。"
  const output = flattenCodeFences(input)
  assert.equal(output, "安装完成后输入：\n\n`git --version`\n\n能看到版本号就装好了。")
  assert.ok(!output.includes("```"))
})

test("截图场景：整段安装教程保留文字与粗体，仅压平代码块", () => {
  const input = [
    "可以，按这个来，Windows 最简单：",
    "",
    "1. 打开官网：https://git-scm.com/downloads 下载 **Git for Windows**，一路默认安装。",
    "",
    "2. 安装完成后，打开 **Git Bash**，输入：",
    "",
    "```bash",
    "git --version",
    "```",
    "能看到类似 `git version 2.x.x` 就说明装好了。",
    "",
    "3. 顺手配置一下身份：",
    "",
    "```bash",
    "git config --global user.name \"你的名字\"",
    "git config --global user.email \"you@example.com\"",
    "```"
  ].join("\n")

  const output = flattenCodeFences(input)
  assert.ok(!output.includes("```"), "不应残留围栏")
  assert.ok(output.includes("**Git for Windows**"), "粗体标记不受影响")
  assert.ok(output.includes("`git --version`"))
  assert.ok(output.includes('`git config --global user.name "你的名字"`'))
  assert.ok(output.includes("`git config --global user.email \"you@example.com\"`"))
  assert.ok(output.includes("能看到类似 `git version 2.x.x` 就说明装好了。"))
})

test("代码行内本身含反引号时不再包裹", () => {
  const input = "```sh\necho `date`\n```"
  assert.equal(flattenCodeFences(input), "echo `date`")
})

test("未闭合围栏按代码处理到结尾", () => {
  const input = "示例如下：\n```bash\ngit clone xxx\n然后手动编译"
  const output = flattenCodeFences(input)
  assert.equal(output, "示例如下：\n`git clone xxx`\n`然后手动编译`")
})

test("波浪线围栏同样压平", () => {
  const input = "~~~python\nprint(1)\n~~~"
  assert.equal(flattenCodeFences(input), "`print(1)`")
})

test("无围栏文本原样返回", () => {
  const input = "普通聊天，含行内 `code` 和 **加粗**"
  assert.equal(flattenCodeFences(input), input)
})

test("闭合围栏后的多余内容不会泄漏成新代码", () => {
  const input = "```bash\nls\n```\n后续说明文本\n```bash\npwd\n```"
  const output = flattenCodeFences(input)
  assert.equal(output, "`ls`\n后续说明文本\n`pwd`")
})

test("containsCodeFence 检测行首围栏", () => {
  assert.equal(containsCodeFence("看这个：\n```bash\nls\n```"), true)
  assert.equal(containsCodeFence("行内 `code` 而已"), false)
  assert.equal(containsCodeFence("```"), true)
})
