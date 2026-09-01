import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

function startServer() {
  const hits = { tools: 0, chat: 0 }
  const bodies = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    bodies.push(body)
    const isTools = req.url.startsWith('/tools/')
    hits[isTools ? 'tools' : 'chat']++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: isTools ? `pro:${body.model}` : `fast:${body.model}`
        },
        finish_reason: 'stop'
      }]
    }))
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, bodies, port: server.address().port }))
  })
}

function startFailingToolsServer() {
  const hits = { tools: 0, chat: 0 }
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    const isTools = req.url.startsWith('/tools/')
    hits[isTools ? 'tools' : 'chat']++
    if (isTools || req.url.startsWith('/bad/')) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid token' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'chat fallback answered' } }] }))
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port }))
  })
}

test('YTapi preserves planner text and adaptively routes complex no-tool replies', async t => {
  let YTapi
  try {
    globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
    ;({ YTapi } = await import('../utils/apiClient.js'))
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      t.skip(`runtime dependency is not installed in this checkout: ${error.message}`)
      return
    }
    throw error
  }

  const { server, hits, bodies, port } = await startServer()
  t.after(() => server.close())
  const config = {
    providers: 'oneapi',
    useTools: true,
    agentIntelligence: { enabled: true, complexModelRouting: true },
    toolsAiConfig: {
      toolsAiUrl: `http://127.0.0.1:${port}/tools/chat/completions`,
      toolsAiModel: 'pro-model',
      toolsAiApikey: 'pro-key'
    },
    chatAiConfig: {
      chatApiUrl: `http://127.0.0.1:${port}/chat/chat/completions`,
      chatApiModel: 'flash-model',
      chatApiKey: ['fast-key']
    },
    taskAiConfig: {
      casual: {
        apiUrl: `http://127.0.0.1:${port}/chat/chat/completions`,
        model: 'casual-model',
        apiKey: 'casual-key',
        maxOutputTokens: 280
      }
    }
  }

  const plannerText = await YTapi({
    messages: [{ role: 'user', content: '普通聊天，但当前允许模型选择表情包' }],
    tools: [{ type: 'function', function: { name: 'sendLocalEmojiTool', parameters: { type: 'object', properties: {} } } }],
    tool_choice: 'auto'
  }, config)
  assert.equal(plannerText.choices[0].message.content, 'pro:pro-model')
  assert.deepEqual(hits, { tools: 1, chat: 0 })

  const complex = await YTapi({
    messages: [
      { role: 'user', content: '【当前群聊上下文】\nA说他一直找项目，B说他又开始了' },
      { role: 'user', content: '锐评一下他上面一直找项目这件事' }
    ],
    tool_choice: 'none'
  }, config)
  assert.equal(complex.choices[0].message.content, 'pro:pro-model')
  assert.deepEqual(hits, { tools: 2, chat: 0 })

  const simple = await YTapi({
    messages: [{ role: 'user', content: '希洛在吗' }],
    tool_choice: 'none'
  }, config)
  assert.equal(simple.choices[0].message.content, 'fast:flash-model')
  assert.deepEqual(hits, { tools: 2, chat: 1 })

  const casual = await YTapi({
    messages: [{ role: 'user', content: '希洛也是ai吗' }],
    tool_choice: 'none'
  }, config, undefined, undefined, {
    taskBackend: 'casual',
    routeLabel: '短闲聊模型'
  })
  assert.equal(casual.choices[0].message.content, 'fast:casual-model')
  assert.deepEqual(hits, { tools: 2, chat: 2 })
  assert.equal(bodies.at(-1).max_tokens, 280)

  const compact = await YTapi({
    messages: [
      { role: 'system', content: '只翻译 Modrinth 项目块。' },
      { role: 'user', content: '【Modrinth 模组排名】\\n#1 Sodium' }
    ],
    tool_choice: 'none',
    temperature: 0
  }, config, undefined, undefined, {
    taskBackend: 'translation',
    routeLabel: 'Modrinth 紧凑翻译',
    generation: { temperature: 0, maxOutputTokens: 1200 }
  })
  assert.equal(compact.choices[0].message.content, 'fast:flash-model')
  assert.deepEqual(hits, { tools: 2, chat: 3 })
  assert.equal(bodies.at(-1).temperature, 0)
  assert.equal(bodies.at(-1).max_tokens, 1200)
})

test('YTapi falls back to the chat backend when an optional tools planner is unauthorized', async t => {
  let YTapi
  try {
    globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
    ;({ YTapi } = await import('../utils/apiClient.js'))
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      t.skip(`runtime dependency is not installed in this checkout: ${error.message}`)
      return
    }
    throw error
  }

  const { server, hits, port } = await startFailingToolsServer()
  t.after(() => server.close())
  const config = {
    providers: 'oneapi',
    useTools: true,
    agentIntelligence: { enabled: true, complexModelRouting: true },
    toolsAiConfig: {
      toolsAiUrl: `http://127.0.0.1:${port}/tools/chat/completions`,
      toolsAiModel: 'pro-model',
      toolsAiApikey: 'bad-key'
    },
    chatAiConfig: {
      chatApiUrl: `http://127.0.0.1:${port}/chat/chat/completions`,
      chatApiModel: 'flash-model',
      chatApiKey: 'chat-key'
    }
  }

  const response = await YTapi({
    messages: [{ role: 'user', content: '总结一下刚刚大家说了什么' }],
    tools: [{ type: 'function', function: { name: 'chatHistoryTool', parameters: { type: 'object' } } }],
    tool_choice: 'auto'
  }, config)

  assert.equal(response.choices[0].message.content, 'chat fallback answered')
  assert.deepEqual(hits, { tools: 1, chat: 1 })
})

test('YTapi uses the configured lightweight backend after tools and chat credentials both fail', async t => {
  let YTapi
  try {
    globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
    ;({ YTapi } = await import('../utils/apiClient.js'))
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      t.skip(`runtime dependency is not installed in this checkout: ${error.message}`)
      return
    }
    throw error
  }

  const { server, hits, port } = await startFailingToolsServer()
  t.after(() => server.close())
  const config = {
    providers: 'oneapi',
    useTools: true,
    toolsAiConfig: {
      toolsAiUrl: `http://127.0.0.1:${port}/tools/chat/completions`,
      toolsAiModel: 'pro-model',
      toolsAiApikey: 'bad-key'
    },
    chatAiConfig: {
      chatApiUrl: `http://127.0.0.1:${port}/bad/chat/completions`,
      chatApiModel: 'chat-model',
      chatApiKey: 'also-bad'
    },
    trackAiConfig: {
      trackAiUrl: `http://127.0.0.1:${port}/chat/chat/completions`,
      trackAiModel: 'flash-model',
      trackAiApikey: 'working-key'
    }
  }

  const response = await YTapi({
    messages: [{ role: 'user', content: '总结一下刚刚大家说了什么' }],
    tools: [{ type: 'function', function: { name: 'chatHistoryTool', parameters: { type: 'object' } } }],
    tool_choice: 'auto'
  }, config)

  assert.equal(response.choices[0].message.content, 'chat fallback answered')
  assert.deepEqual(hits, { tools: 1, chat: 2 })
})

test('YTapi falls back from a plain chat request when the configured chat backend is unauthorized', async t => {
  let YTapi
  try {
    globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
    ;({ YTapi } = await import('../utils/apiClient.js'))
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      t.skip(`runtime dependency is not installed in this checkout: ${error.message}`)
      return
    }
    throw error
  }

  const { server, hits, port } = await startFailingToolsServer()
  t.after(() => server.close())
  const response = await YTapi({
    messages: [{ role: 'user', content: '希洛你在吗' }],
    tool_choice: 'none'
  }, {
    providers: 'oneapi',
    useTools: true,
    chatAiConfig: {
      chatApiUrl: `http://127.0.0.1:${port}/bad/chat/completions`,
      chatApiModel: 'chat-model',
      chatApiKey: 'bad-key'
    },
    trackAiConfig: {
      trackAiUrl: `http://127.0.0.1:${port}/chat/chat/completions`,
      trackAiModel: 'track-model',
      trackAiApikey: 'working-key'
    }
  })

  assert.equal(response.choices[0].message.content, 'chat fallback answered')
  assert.deepEqual(hits, { tools: 0, chat: 2 })
})
