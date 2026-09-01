import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import YAML from "yaml"

async function loadTool(t) {
  if (!globalThis.logger) {
    globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
  }
  try {
    return (await import("../functions/functions_tools/GoogleAnalysisTool.js")).GoogleImageAnalysisTool
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip(`runtime dependency is not installed in this checkout: ${error.message}`)
      return null
    }
    throw error
  }
}

test("image analysis progress is generated from the current user request", async t => {
  const GoogleImageAnalysisTool = await loadTool(t)
  if (!GoogleImageAnalysisTool) return

  let progressArgs
  const replies = []
  const tool = new GoogleImageAnalysisTool({
    progressReplyFactory: async args => {
      progressArgs = args
      return "Steam 安装报错这块，我仔细看一眼。"
    }
  })
  const sent = await tool.sendProgress({
    msg: "希洛看一下为什么他装 Steam 老是这样",
    async reply(text) { replies.push(text) }
  }, {
    config: { persona: { name: "希洛" } },
    opts: {
      prompt: "分析 Steam 安装截图",
      progressText: "结合用户问题自然接话"
    },
    signal: new AbortController().signal
  })

  assert.equal(sent, true)
  assert.deepEqual(replies, ["Steam 安装报错这块，我仔细看一眼。"]) 
  assert.equal(progressArgs.taskType, "图片识别")
  assert.match(progressArgs.userText, /Steam 老是这样/)
  assert.equal(progressArgs.suggestedText, "结合用户问题自然接话")
  assert.match(progressArgs.stage, /已收到图片引用/)
})

test("image analysis progress stays silent after the task is cancelled", async t => {
  const GoogleImageAnalysisTool = await loadTool(t)
  if (!GoogleImageAnalysisTool) return

  let called = false
  const controller = new AbortController()
  controller.abort()
  const tool = new GoogleImageAnalysisTool({
    progressReplyFactory: async () => {
      called = true
      return "这句不该发送。"
    }
  })
  const sent = await tool.sendProgress({
    async reply() { throw new Error("cancelled progress must not be sent") }
  }, { signal: controller.signal })

  assert.equal(sent, false)
  assert.equal(called, false)
})

test("image analysis tool exposes an optional contextual progress sentence", async t => {
  const GoogleImageAnalysisTool = await loadTool(t)
  if (!GoogleImageAnalysisTool) return
  const tool = new GoogleImageAnalysisTool()
  assert.equal(tool.parameters.properties.progressText.type, "string")
  assert.doesNotMatch(tool.parameters.properties.progressText.description, /嗯嗯|收到收到/)
})

test("image processing does not wait for a pending progress sentence", async t => {
  const GoogleImageAnalysisTool = await loadTool(t)
  if (!GoogleImageAnalysisTool) return

  let progressSignal
  const tool = new GoogleImageAnalysisTool()
  tool.sendProgress = async (_event, { signal }) => {
    progressSignal = signal
    return await new Promise(() => {})
  }

  const result = await Promise.race([
    tool.func({
      images: ["file:///definitely-missing-image.png"],
      prompt: "看一下图片"
    }, { async reply() {} }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("image handling waited for progress")), 2000))
  ])

  assert.equal(result?.error?.code, "image_download_failed")
  assert.equal(progressSignal?.aborted, true)
})

test("multi-image analysis isolates slow images and preserves successful image order", async t => {
  const GoogleImageAnalysisTool = await loadTool(t)
  if (!GoogleImageAnalysisTool) return

  const originalReadFileSync = fs.readFileSync
  const calls = []
  const tool = new GoogleImageAnalysisTool({
    imageLoader: async url => `data:image/png;base64,${url}`,
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body)
      const image = payload.messages[0].content.find(item => item.type === 'image_url')
      const encoded = image.image_url.url.split(',').at(-1)
      calls.push(encoded)
      if (encoded === 'second') {
        const error = new Error('timed out')
        error.name = 'AbortError'
        throw error
      }
      return {
        ok: true,
        async text() {
          return JSON.stringify({ choices: [{ message: { content: `result-${encoded}` } }] })
        }
      }
    },
    progressReplyFactory: async () => ''
  })

  fs.readFileSync = () => YAML.stringify({
    pluginSettings: {
      analysisAiConfig: { analysisApiUrl: 'https://vision.example/v1', analysisApiKey: 'test', analysisApiModel: 'vision-test', timeoutMs: 1000 }
    }
  })
  try {
    const result = await tool.func({ images: ['first', 'second', 'third'], prompt: '解释图片里的代码' }, { async reply() {} })
    assert.deepEqual(calls, ['first', 'second', 'third'])
    assert.match(result.analysis, /【第1张】[\s\S]*result-first/)
    assert.match(result.analysis, /【第3张】[\s\S]*result-third/)
    assert.doesNotMatch(result.analysis, /result-second/)
    assert.match(result.analysis, /第 2 张本轮未读到内容/)
    assert.deepEqual(result.evidence.analyzedImageIndexes, [1, 3])
    assert.deepEqual(result.evidence.failedImageIndexes, [2])
  } finally {
    fs.readFileSync = originalReadFileSync
  }
})
