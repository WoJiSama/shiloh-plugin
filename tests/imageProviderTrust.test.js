import { test } from "node:test"
import assert from "node:assert/strict"
import { createGoogleImageEditTool } from "../dist/backend/modules/toolSupport/infrastructure/GoogleImageEditTool.js"
import { BananaTool as CompiledBananaTool } from "../dist/backend/modules/toolSupport/infrastructure/BananaTool.js"

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

function createImageTools() {
  const unexpectedCall = () => { throw new Error("provider normalization must not perform I/O") }
  const logger = { info() {}, warn() {}, error() {} }
  const GoogleImageEditTool = createGoogleImageEditTool({
    loadConfig: () => CONFIG, logger,
    normalizeImageUrls: unexpectedCall, imageLoader: unexpectedCall,
    progressReplyFactory: unexpectedCall, guardReply: unexpectedCall, callApi: unexpectedCall,
    getRedis: unexpectedCall, getBot: unexpectedCall, sendImageReliably: unexpectedCall,
    mimeTypes: { extension: unexpectedCall, lookup: unexpectedCall }
  })
  class BananaTool extends CompiledBananaTool {
    constructor() { super({ progressFetchImpl: unexpectedCall }, { logger }) }
  }
  return { GoogleImageEditTool, BananaTool }
}

test("image tools discard model-invented providers at the user-text boundary", async () => {
  const classes = createImageTools()

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

test("image edit tool description is provider-neutral", async () => {
  const classes = createImageTools()
  const tool = new classes.GoogleImageEditTool()
  assert.doesNotMatch(tool.description, /Google|Gemini/i)
  assert.match(tool.description, /已配置的图片编辑渠道/)
})
