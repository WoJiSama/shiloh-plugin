import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const FAKE_PAGE = "<!doctype html><html><head></head><body><div id=\"app\"></div></body></html>"

function makeFakeGuoba() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guoba-jump-"))
  const guobaStatic = path.join(root, "Guoba-Plugin", "server", "static")
  fs.mkdirSync(guobaStatic, { recursive: true })
  fs.writeFileSync(path.join(guobaStatic, "index.html"), FAKE_PAGE)
  const pluginRoot = path.join(root, "bl-chat-plugin")
  fs.mkdirSync(pluginRoot, { recursive: true })
  return { root, pluginRoot, index: path.join(guobaStatic, "index.html") }
}

test("守卫注入：自动补按钮、幂等、升级重写后再次补回", async () => {
  const { ensureGuobaJumpLink } = await import("../utils/guobaJumpLink.js")
  const { pluginRoot, index } = makeFakeGuoba()
  try {
    const r1 = ensureGuobaJumpLink({ pluginRoot })
    assert.equal(r1.injected, true, "首次注入")
    assert.ok(fs.readFileSync(index, "utf8").includes("blchat-cmd-jump"))
    assert.ok(fs.existsSync(index + ".bak-blchat-jump"), "留有纯净备份")

    const r2 = ensureGuobaJumpLink({ pluginRoot })
    assert.equal(r2.already, true, "已存在时不重复注入")

    // 模拟锅巴升级重写 index.html
    fs.writeFileSync(index, FAKE_PAGE.replace('<div id="app"></div>', '<div id="app-new"></div>'))
    const r3 = ensureGuobaJumpLink({ pluginRoot })
    assert.equal(r3.injected, true, "升级后自动补回")
    assert.ok(fs.readFileSync(index, "utf8").includes("blchat-cmd-jump"))
    assert.ok(fs.readFileSync(index, "utf8").includes("app-new"), "保留锅巴新版本内容")

    // 没装锅巴时不报错
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "guoba-none-"))
    assert.equal(ensureGuobaJumpLink({ pluginRoot: emptyRoot }).injected, false)
    fs.rmSync(emptyRoot, { recursive: true, force: true })
  } finally {
    fs.rmSync(path.dirname(pluginRoot), { recursive: true, force: true })
  }
})
