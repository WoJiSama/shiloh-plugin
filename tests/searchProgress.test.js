import test from "node:test"
import assert from "node:assert/strict"
import { SearchInformationTool } from "../functions/functions_tools/SearchInformationTool.js"

const CONFIG = {
  searchAiConfig: {
    searchApiUrl: "https://search.example.com/v1",
    searchApiModel: "search-model",
    searchApiKey: "search-key",
    timeoutMs: 3000
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test("delayed search uses contextual model text instead of a fixed status sentence", async () => {
  const replies = []
  let progressArgs
  const tool = new SearchInformationTool({
    progressDelayMs: 500,
    configLoader: () => CONFIG,
    progressReplyFactory: async args => {
      progressArgs = args
      return "这个版本范围有点杂，我再对一下。"
    },
    fetchImpl: async url => {
      assert.equal(url, "https://search.example.com/v1/chat/completions")
      await wait(650)
      return {
        ok: true,
        status: 200,
        async json() { return { choices: [{ message: { content: "可靠搜索结果" } }] } }
      }
    }
  })
  const result = await tool.func(
    { query: "最近更新的魔法模组" },
    { msg: "希洛，查一下最近更新的魔法模组", async reply(text) { replies.push(text) } }
  )
  assert.match(result, /可靠搜索结果/)
  assert.equal(replies[0], "这个版本范围有点杂，我再对一下。")
  assert.match(progressArgs.userText, /最近更新的魔法模组/)
})

test("suppresses a generated progress reply when the search finishes first", async () => {
  const replies = []
  const tool = new SearchInformationTool({
    progressDelayMs: 500,
    configLoader: () => CONFIG,
    progressReplyFactory: async () => {
      await wait(250)
      return "这句已经迟到了，不该发。"
    },
    fetchImpl: async () => {
      await wait(550)
      return {
        ok: true,
        status: 200,
        async json() { return { choices: [{ message: { content: "搜索完成" } }] } }
      }
    }
  })
  await tool.func({ query: "测试" }, { msg: "查一下测试", async reply(text) { replies.push(text) } })
  await wait(300)
  assert.deepEqual(replies, [])
})

test("surfaced upstream error message on quota-exhausted 403", async () => {
  const tool = new SearchInformationTool({
    configLoader: () => CONFIG,
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      async json() {
        return { error: { message: "token quota is not enough, token remain quota: ＄0.001656, need quota: ＄0.001966" } }
      }
    })
  })
  const result = await tool.func({ query: "claude 最新模型" }, { msg: "查一下 claude 最新模型" })
  assert.match(result, /搜索失败：搜索服务返回 403：token quota is not enough/)
})

test("non-JSON error body still reports the status code", async () => {
  const tool = new SearchInformationTool({
    configLoader: () => CONFIG,
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      async json() { throw new SyntaxError("Unexpected token < in JSON") }
    })
  })
  const result = await tool.func({ query: "测试" }, { msg: "查一下" })
  assert.match(result, /搜索失败：搜索服务返回 502$/)
})

test("does not send another progress reply after an earlier tool stage used the turn budget", async () => {
  const replies = []
  const tool = new SearchInformationTool({
    progressDelayMs: 500,
    configLoader: () => CONFIG,
    progressReplyFactory: async () => "搜索阶段不该再追加这句。",
    fetchImpl: async () => {
      await wait(650)
      return {
        ok: true,
        status: 200,
        async json() { return { choices: [{ message: { content: "搜索完成" } }] } }
      }
    }
  })
  const event = {
    msg: "识图后再查一下",
    _progressReplyState: { sent: true, reserved: false },
    async reply(text) { replies.push(text) }
  }

  await tool.func({ query: "核实图片内容" }, event)
  assert.deepEqual(replies, [])
})
