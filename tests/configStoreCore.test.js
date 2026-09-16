import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "config-store-"))
  fs.mkdirSync(path.join(root, "config_default"), { recursive: true })
  fs.writeFileSync(path.join(root, "config_default", "message.yaml"), [
    "pluginSettings:",
    "  enabled: true",
    "  nested:",
    "    a: 1",
    "    b: 2",
    ""
  ].join("\n"))
  return root
}

test("深合并：用户层覆盖标量、补齐缺省（以默认键为准，多余用户键被裁掉——原initConfig语义）", async () => {
  const { mergeDeepConfig } = await import("../core/config/configStore.js")
  const merged = mergeDeepConfig(
    { enabled: true, nested: { a: 1, b: 2 }, list: [1, 2] },
    { enabled: false, nested: { b: 99, c: 3 } }
  )
  assert.equal(merged.enabled, false)
  assert.deepEqual(merged.nested, { a: 1, b: 99 })
  assert.deepEqual(merged.list, [1, 2])
})

test("加载与回写：缺字段自动合并写回用户层", async () => {
  const { createConfigStore } = await import("../core/config/configStore.js")
  const root = makeRoot()
  try {
    fs.mkdirSync(path.join(root, "config"), { recursive: true })
    fs.writeFileSync(path.join(root, "config", "message.yaml"), "pluginSettings:\n  enabled: false\n")
    const store = createConfigStore({ pluginRoot: root })
    const { settings } = store.load()
    assert.equal(settings.enabled, false)
    assert.equal(settings.nested.b, 2, "缺省字段被补齐")
    const written = fs.readFileSync(path.join(root, "config", "message.yaml"), "utf8")
    assert.ok(written.includes("nested"), "合并结果已回写用户层")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("热更新回调：变更防抖后 onChange 收到新 settings", async () => {
  const { createConfigStore } = await import("../core/config/configStore.js")
  const root = makeRoot()
  const callbacks = []
  let fireChange = null
  try {
    const store = createConfigStore({
      pluginRoot: root,
      watchImpl: (file, cb) => { fireChange = cb },
      onChange: settings => callbacks.push(settings)
    })
    store.load()
    store.startWatch()
    // 更新默认配置后手动触发注入的 watch 回调（不依赖真实 fs 事件时序）
    fs.writeFileSync(path.join(root, "config_default", "message.yaml"), [
      "pluginSettings:", "  enabled: true", "  nested:", "    a: 1", "    b: 2", "  extra: hot", ""
    ].join("\n"))
    fireChange()
    fireChange()
    await new Promise(resolve => setTimeout(resolve, 900))
    assert.equal(callbacks.length, 1, "两次连续触发被防抖成一次")
    assert.equal(callbacks[0].extra, "hot")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
