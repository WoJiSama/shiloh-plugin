import { test } from "node:test"
import assert from "node:assert/strict"

async function loadTool(t) {
  if (!globalThis.logger) {
    globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
  }
  try {
    return (await import("../functions/functions_tools/GoogleImageEditTool.js")).GoogleImageEditTool
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip(`runtime dependency is not installed in this checkout: ${error.message}`)
      return null
    }
    throw error
  }
}

test("image edit progress is generated from the current edit request", async t => {
  const GoogleImageEditTool = await loadTool(t)
  if (!GoogleImageEditTool) return
  let progressArgs
  const sent = []
  const tool = new GoogleImageEditTool({
    progressReplyFactory: async args => {
      progressArgs = args
      return "文字颜色我按你说的改。"
    }
  })

  const ok = await tool.sendProgress({
    msg: "把这张图里的文字改成红色",
    reply: async message => { sent.push(message) }
  }, {
    config: {},
    opts: { prompt: "把文字改成红色" }
  })

  assert.equal(ok, true)
  assert.equal(progressArgs.taskMode, "image_edit")
  assert.match(progressArgs.userText, /文字改成红色/)
  assert.deepEqual(sent, ["文字颜色我按你说的改。"])
})

test("image edit completion aborts a pending contextual progress reply", async t => {
  const GoogleImageEditTool = await loadTool(t)
  if (!GoogleImageEditTool) return
  let progressSignal
  let progressSettled = false

  class NonBlockingEditProgressTool extends GoogleImageEditTool {
    loadConfig() {
      return {
        imageEditAiConfig: {
          imageEditApiUrl: "https://image.example/v1/images/edits",
          imageEditApiKey: "test-key",
          imageEditApiModel: "test-model"
        }
      }
    }
    async sendProgress(_e, context) {
      progressSignal = context.signal
      await new Promise(resolve => context.signal.addEventListener("abort", resolve, { once: true }))
      progressSettled = true
      return false
    }
    async generateConfiguredImageEdit() { return "" }
  }

  const tool = new NonBlockingEditProgressTool()
  const result = await tool.performImageEdit({
    prompt: "把背景改成夜晚",
    images: ["https://img.example/base.png"]
  }, {
    msg: "希洛，把这张图的背景改成夜晚",
    reply: async () => ({ message_id: 1 })
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.match(result.error, /未接收到有效图片/)
  assert.equal(progressSignal?.aborted, true)
  assert.equal(progressSettled, true)
})

test("unsupported named edit provider fails before sending a progress reply", async t => {
  const GoogleImageEditTool = await loadTool(t)
  if (!GoogleImageEditTool) return
  class UnsupportedProviderTool extends GoogleImageEditTool {
    loadConfig() {
      return {
        imageGenerationAiConfig: {
          providers: [
            { name: "Grok", apiUrl: "https://grok.example/v1", model: "grok-imagine", apiKey: "grok-key" },
            { name: "Krill", apiUrl: "https://krill.example/v1", model: "gpt-image-2", apiKey: "krill-key" }
          ]
        }
      }
    }
    async sendProgress() {
      throw new Error("progress should not be sent")
    }
  }

  const tool = new UnsupportedProviderTool()
  const result = await tool.performImageEdit({
    prompt: "改成夜景",
    images: ["https://img.example/base.png"],
    provider: "Grok"
  }, {
    msg: "希洛，用 Grok 改一下这张图的背景",
    reply: async () => ({ message_id: 1 })
  })

  assert.match(result.error, /未找到可用于图片编辑的指定图片渠道“Grok”/)
  assert.match(result.error, /不会自动改用其他渠道/)
})
