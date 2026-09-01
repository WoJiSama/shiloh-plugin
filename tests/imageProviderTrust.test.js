import { test } from "node:test"
import assert from "node:assert/strict"

const CONFIG = {
  imageGenerationAiConfig: {
    providers: [
      { name: "Grok", apiUrl: "https://grok.example/v1", model: "grok-imagine", apiKey: "grok-key" },
      { name: "Krill", apiUrl: "https://krill.example/v1", model: "gpt-image-2", apiKey: "krill-key" }
    ]
  },
  imageEditAiConfig: {
    imageEditApiUrl: "https://edit.example/v1/images/edits",
    imageEditApiModel: "gpt-image-2",
    imageEditApiKey: "edit-key"
  }
}

async function loadImageTools(t) {
  if (!globalThis.logger) {
    globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
  }
  try {
    const [{ GoogleImageEditTool }, { BananaTool }] = await Promise.all([
      import("../functions/functions_tools/GoogleImageEditTool.js"),
      import("../functions/functions_tools/BananaTool.js")
    ])
    return { GoogleImageEditTool, BananaTool }
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip(`runtime dependency is not installed in this checkout: ${error.message}`)
      return null
    }
    throw error
  }
}

test("image tools discard model-invented providers at the user-text boundary", async t => {
  const classes = await loadImageTools(t)
  if (!classes) return

  for (const ToolClass of [classes.GoogleImageEditTool, classes.BananaTool]) {
    class ConfiguredTool extends ToolClass {
      loadConfig() { return CONFIG }
    }
    const tool = new ConfiguredTool()

    assert.deepEqual(tool.normalizeParameters({
      prompt: "去掉手机",
      images: ["image"],
      provider: "gemini"
    }, {
      userText: "希洛帮我去掉这个图手里的手机"
    }), {
      prompt: "去掉手机",
      images: ["image"]
    })

    assert.equal(tool.normalizeParameters({
      prompt: "去掉手机",
      images: ["image"],
      provider: "Grok"
    }, {
      userText: "希洛帮我用 Grok 去掉这个图手里的手机"
    }).provider, "Grok")

    assert.equal(tool.resolveRequestedProvider(CONFIG, {
      prompt: "模型擅自写了：用 Gemini 编辑"
    }, {
      msg: "希洛帮我去掉这个图手里的手机"
    }), "")
  }
})

test("image edit tool description is provider-neutral", async t => {
  const classes = await loadImageTools(t)
  if (!classes) return
  const tool = new classes.GoogleImageEditTool()
  assert.doesNotMatch(tool.description, /Google|Gemini/i)
  assert.match(tool.description, /已配置的图片编辑渠道/)
})
