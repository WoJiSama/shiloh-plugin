import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { test } from "node:test"

// configWriter 在模块加载时以 process.cwd() 定位配置文件,
// 所以每个用例必须先 chdir 到临时工程再用带 query 的动态导入拿新实例
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
let importSeq = 0
async function importFresh() {
  globalThis.logger ||= { info() {}, warn() {}, error() {}, debug() {} }
  const stamp = `?roundtrip=${++importSeq}`
  const writer = await import(pathToFileURL(path.join(REPO_ROOT, "utils/configWriter.js")).href + stamp)
  const providers = await import(pathToFileURL(path.join(REPO_ROOT, "utils/guobaAiProviderConfig.js")).href + stamp)
  return { writer, providers }
}

function makeTmpProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "guoba-provider-roundtrip-"))
  const configDir = path.join(cwd, "plugins/shiloh-plugin/config")
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, "message.yaml"), [
    "pluginSettings:",
    "  imageGenerationAiConfig:",
    "    providers:",
    "      - name: krill",
    "        apiUrl: https://api.krill-ai.net/v1",
    "        model: gpt-image-2",
    "        apiKey: nb-key",
    "        priority: 4",
    "        autoResolve: true",
    "      - name: grok",
    "        apiUrl: https://www.souimagery.fun/v1/images/generations",
    "        model: grok-imagine",
    "        apiKey: sk-key",
    "        priority: 2",
    "        autoResolve: false"
  ].join("\n"))
  return cwd
}

async function withTmpProject(fn) {
  const cwd = makeTmpProject()
  const previousCwd = process.cwd()
  process.chdir(cwd)
  try {
    return await fn(await importFresh())
  } finally {
    process.chdir(previousCwd)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

test("有效载荷:两行都保留,优先级与 autoResolve 原样落盘", async t => {
  await withTmpProject(async ({ writer, providers }) => {
    const payload = providers.normalizeAiProviderUpdates({
      "imageGenerationAiConfig.providers": [
        { name: "krill", apiUrl: "https://api.krill-ai.net/v1", autoResolve: true, model: "gpt-image-2", apiKey: "nb-key", priority: 4 },
        { name: "grok", apiUrl: "https://www.souimagery.fun/v1/images/generations", autoResolve: false, model: "grok-imagine", apiKey: "sk-key", priority: 2 }
      ]
    })
    writer.applyFlatUpdates(payload)
    const cfg = writer.readUserSettings().imageGenerationAiConfig
    assert.equal(cfg.providers.length, 2)
    assert.deepEqual(cfg.providers.map(item => item.priority).sort(), [2, 4])
    assert.equal(cfg.providers.find(item => item.name === "krill").autoResolve, true)
    assert.equal(cfg.providers.find(item => item.name === "grok").autoResolve, false)
    // 扁平字段同步到最高优先级(grok, priority 2)
    assert.equal(cfg.imageGenerationPriority, 2)
    assert.equal(cfg.imageGenerationApiModel, "grok-imagine")
  })
})

test("空载荷不再抹掉已保存渠道:undefined / 空数组 / 全空行一律保留原状", async t => {
  for (const emptyValue of [undefined, [], [{}], [{ name: "" }]]) {
    await withTmpProject(async ({ writer, providers }) => {
      const payload = providers.normalizeAiProviderUpdates({
        "imageGenerationAiConfig.providers": emptyValue,
        "chatAiConfig.chatReasoningEffort": "low"
      })
      writer.applyFlatUpdates(payload)
      const cfg = writer.readUserSettings().imageGenerationAiConfig
      assert.equal(cfg.providers?.length, 2, `载荷 ${JSON.stringify(emptyValue)} 不应清空渠道`)
      assert.equal(cfg.providers[0].priority, 4)
      assert.equal(writer.readUserSettings().chatAiConfig.chatReasoningEffort, "low", "其余字段正常写入")
    })
  }
})

test("applyFlatUpdates 直接防御:undefined/null 值不落盘", async t => {
  await withTmpProject(async ({ writer }) => {
    writer.applyFlatUpdates({ "imageGenerationAiConfig.providers": undefined, "imageGenerationAiConfig.name": null })
    const cfg = writer.readUserSettings().imageGenerationAiConfig
    assert.equal(cfg.providers.length, 2)
    assert.equal(cfg.name, undefined)
  })
})

test("面板默认值迁移:legacy 扁平单渠道转 providers 后 priority 不丢", async t => {
  await withTmpProject(async ({ writer, providers }) => {
    const settings = writer.readUserSettings()
    // 模拟 imageEditAiConfig 只有扁平字段(服务器现状),读面板时迁移
    settings.imageEditAiConfig = {
      imageEditApiUrl: "https://www.souimagery.fun/v1/images/generations",
      imageEditApiModel: "grok-imagine-image-quality",
      imageEditApiKey: "sk-key",
      imageEditPriority: 3
    }
    const migrated = providers.withAiProviderPanelDefaults(settings)
    const rows = migrated.imageEditAiConfig.providers
    assert.equal(rows.length, 1)
    assert.equal(rows[0].priority, 3, "扁平字段里的优先级迁移时不重置为 1")
  })
})
