import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { classifyConfigKind, maskSecrets, probeProvider, probeProviders, summarizeProbes } from "../utils/aiProviderProbe.js"

function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler)
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }))
  })
}

function readBody(req) {
  return new Promise(resolve => {
    let data = ""
    req.on("data", chunk => { data += chunk })
    req.on("end", () => resolve(data))
  })
}

test("classifyConfigKind: chat/embedding/image by config key", () => {
  assert.equal(classifyConfigKind("chatAiConfig"), "chat")
  assert.equal(classifyConfigKey_compat(), "chat")
  assert.equal(classifyConfigKind("embeddingAiConfig"), "embedding")
  assert.equal(classifyConfigKind("imageGenerationAiConfig"), "image")
  assert.equal(classifyConfigKind("imageEditAiConfig"), "image")
})

function classifyConfigKey_compat() { return classifyConfigKind("anythingElse") }

test("probeProvider chat: success reports model, tokens and latency", async () => {
  const { server, port } = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req) || "{}")
    assert.equal(req.headers.authorization, "Bearer sk-test-key")
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({
      choices: [{ message: { content: "pong" } }],
      usage: { total_tokens: 3 },
      seenModel: body.model
    }))
  })
  try {
    const result = await probeProvider({
      name: "主对话", apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "gpt-test", apiKey: "sk-test-key"
    }, "chat")
    assert.equal(result.ok, true)
    assert.match(result.detail, /gpt-test 正常回复「pong」（3 tokens）/)
    assert.ok(result.ms >= 0)
  } finally {
    server.close()
  }
})

test("probeProvider chat: 401 surfaces the upstream message", async () => {
  const { server, port } = await startServer((req, res) => {
    res.statusCode = 401
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ error: { message: "Incorrect API key provided" } }))
  })
  try {
    const result = await probeProvider({
      name: "坏key", apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "gpt-test", apiKey: "sk-bad"
    }, "chat")
    assert.equal(result.ok, false)
    assert.match(result.detail, /HTTP 401 .*Incorrect API key provided/)
  } finally {
    server.close()
  }
})

test("probeProvider chat: max_tokens 400 retries once with max_completion_tokens", async () => {
  let hits = []
  const { server, port } = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req) || "{}")
    hits.push(body)
    if (body.max_tokens !== undefined) {
      res.statusCode = 400
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }))
      return
    }
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }))
  })
  try {
    const result = await probeProvider({
      name: "新模型", apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "o-test", apiKey: "sk-x"
    }, "chat")
    assert.equal(result.ok, true)
    assert.equal(hits.length, 2)
    assert.equal(hits[1].max_completion_tokens, 5)
    assert.equal(hits[1].max_tokens, undefined)
  } finally {
    server.close()
  }
})

test("probeProvider embedding: reports vector dimensions", async () => {
  const { server, port } = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req) || "{}")
    assert.equal(body.input, "ping")
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0) }] }))
  })
  try {
    const result = await probeProvider({
      name: "向量", apiUrl: `http://127.0.0.1:${port}/v1/embeddings`,
      model: "text-embedding-test", apiKey: "sk-e"
    }, "embedding")
    assert.equal(result.ok, true)
    assert.match(result.detail, /1024 维/)
  } finally {
    server.close()
  }
})

test("probeProvider image: probes /models without generating, notes model presence", async () => {
  const seen = []
  const { server, port } = await startServer((req, res) => {
    seen.push(req.url)
    assert.equal(req.headers.authorization, "Bearer sk-img")
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ data: [{ id: "gpt-image-2" }] }))
  })
  try {
    const result = await probeProvider({
      name: "文生图", apiUrl: `http://127.0.0.1:${port}/v1/images/generations`,
      model: "gpt-image-2", apiKey: "sk-img"
    }, "image")
    assert.equal(result.ok, true)
    assert.match(result.detail, /连通且在模型列表中/)
    assert.deepEqual(seen, ["/v1/models"])
  } finally {
    server.close()
  }
})

test("probeProvider: timeout and missing fields produce clear failures", async () => {
  const { server, port } = await startServer((req, res) => {
    setTimeout(() => res.end("{}"), 500)
  })
  try {
    const result = await probeProvider({
      name: "慢", apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "m", apiKey: "k"
    }, "chat", { timeoutMs: 60 })
    assert.equal(result.ok, false)
    assert.match(result.detail, /超时/)
  } finally {
    server.close()
  }
  assert.match((await probeProvider({ name: "x", apiUrl: "", model: "m", apiKey: "k" }, "chat")).detail, /缺少 URL/)
  assert.match((await probeProvider({ name: "x", apiUrl: "http://a", model: "", apiKey: "k" }, "chat")).detail, /缺少模型名/)
  assert.match((await probeProvider({ name: "x", apiUrl: "http://a", model: "m", apiKey: "" }, "chat")).detail, /缺少 API Key/)
})

test("maskSecrets and summarizeProbes formatting", () => {
  assert.equal(maskSecrets("key sk-abcdef123456 leaked"), "key sk-*** leaked")
  assert.equal(maskSecrets("Bearer tok_12345678"), "Bearer ***")
  const summary = summarizeProbes([
    { name: "A", ok: true, ms: 812, detail: "gpt 正常回复" },
    { name: "B", ok: false, ms: 40, detail: "HTTP 401 无效" }
  ])
  assert.equal(summary.allOk, false)
  assert.match(summary.text, /✅A 812ms gpt 正常回复；❌B 40ms HTTP 401 无效/)
  assert.equal(summarizeProbes([{ name: "A", ok: true, ms: 5, detail: "ok" }]).allOk, true)
  assert.equal(summarizeProbes([]).allOk, false)
})

test("probeProviders caps the number of probes", async () => {
  const providers = Array.from({ length: 12 }, (_, i) => ({ name: `p${i}`, apiUrl: "http://a", model: "m", apiKey: "" }))
  const results = await probeProviders(providers, "chat")
  assert.equal(results.length, 8)
})

test("base URLs are normalized the same way production resolves them", async () => {
  const hits = []
  const { server, port } = await startServer(async (req, res) => {
    hits.push(req.url)
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }))
  })
  try {
    const base = `http://127.0.0.1:${port}`
    await probeProvider({ name: "v1-base", apiUrl: `${base}/v1`, model: "m", apiKey: "k" }, "chat")
    await probeProvider({ name: "bare", apiUrl: base, model: "m", apiKey: "k" }, "chat")
    await probeProvider({ name: "full", apiUrl: `${base}/v1/chat/completions`, model: "m", apiKey: "k" }, "chat")
    await probeProvider({ name: "emb-base", apiUrl: `${base}/v1`, model: "m", apiKey: "k" }, "embedding")
    await probeProvider({ name: "emb-full", apiUrl: `${base}/v1/embeddings`, model: "m", apiKey: "k" }, "embedding")
    assert.deepEqual(hits, [
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/embeddings",
      "/v1/embeddings"
    ])
  } finally {
    server.close()
  }
})

test("chat 200 with empty reply and zero usage is reported as a broken channel", async () => {
  const { server, port } = await startServer((req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({
      choices: [{ message: { content: "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }))
  })
  try {
    const result = await probeProvider({
      name: "空渠道", apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "glm-test", apiKey: "sk-x"
    }, "chat")
    assert.equal(result.ok, false)
    assert.match(result.detail, /HTTP 200 但空回复且 0 tokens/)
  } finally {
    server.close()
  }
})

test("chat empty reply with real token usage stays ok (thinking-only small budget)", async () => {
  const { server, port } = await startServer((req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({
      choices: [{ message: { content: "", reasoning_content: "思考中..." }, finish_reason: "length" }],
      usage: { total_tokens: 7 }
    }))
  })
  try {
    const result = await probeProvider({
      name: "思考型", apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "o-test", apiKey: "sk-x"
    }, "chat")
    assert.equal(result.ok, true)
    assert.match(result.detail, /7 tokens 全部用于思考/)
  } finally {
    server.close()
  }
})
