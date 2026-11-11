import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveCharacterConsistencyRoute } from '../dist/backend/modules/simulation/infrastructure/characterConsistencyRouting.js'
import { modelExecutor } from './helpers/modelExecutor.js'

const existing = {
  providers: 'oneapi', useTools: true,
  chatAiConfig: { chatApiUrl: 'https://chat.invalid/v1', chatApiModel: 'chat', chatApiKey: 'chat-fixture' },
  toolsAiConfig: { toolsAiUrl: 'https://tools.invalid/v1', toolsAiModel: 'main', toolsAiApikey: 'tools-fixture' },
  taskAiConfig: { memory: { apiUrl: 'https://memory.invalid/v1', model: 'memory', apiKey: 'memory-fixture' } },
}
const request = { messages: [{ role: 'system', content: 'Review only' }, { role: 'user', content: '{}' }], temperature: 0, max_tokens: 900 }

test('independent review route requires a complete explicit backend and never borrows memory, main or chat', () => {
  for (const task of [undefined, {}, { model: 'review' }, { apiUrl: 'https://review.invalid', model: 'review', apiKey: '' }, { apiUrl: ' ', model: 'review', apiKey: 'fixture' }, { apiUrl: 'https://review.invalid', model: ' ', apiKey: [''] }]) {
    const config = { ...existing, taskAiConfig: { ...existing.taskAiConfig, ...(task === undefined ? {} : { characterConsistency: task }) } }
    assert.throws(() => resolveCharacterConsistencyRoute(config), /独立.*characterConsistency.*未配置/)
  }
})

test('explicit review backend executes text-only using its own credentials without mutating caller config', async () => {
  const config = { ...existing, taskAiConfig: { ...existing.taskAiConfig, characterConsistency: { apiUrl: 'https://review.invalid/v1', model: 'review', apiKey: ['review-fixture'], reasoningEffort: 'low' } } }
  const before = structuredClone(config), calls = [], route = resolveCharacterConsistencyRoute(config)
  const { YTapi } = modelExecutor(async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) })
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"accept","issues":[]}' } }] }))
  })
  const controller = new AbortController()
  const result = await YTapi(request, route.config, undefined, undefined, { taskBackend: route.taskBackend, signal: controller.signal, generation: { maxOutputTokens: 900 } })
  assert.equal(route.taskBackend, 'characterConsistency')
  assert.equal(route.config.useTools, false)
  assert.equal(result.choices[0].message.content, '{"verdict":"accept","issues":[]}')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://review.invalid/v1/chat/completions')
  assert.equal(calls[0].body.model, 'review')
  assert.equal(calls[0].headers.Authorization, 'Bearer review-fixture')
  assert.equal(calls[0].body.tools, undefined)
  assert.equal(calls[0].body.max_tokens, 900)
  assert.deepEqual(config, before)
})

test('review backend failure stays on the chosen backend instead of switching to a permissive reviewer', async () => {
  const route = resolveCharacterConsistencyRoute({ ...existing, taskAiConfig: { ...existing.taskAiConfig, characterConsistency: { apiUrl: 'https://review.invalid/v1', model: 'review', apiKey: 'review-fixture' } } })
  const urls = []
  const { YTapi } = modelExecutor(async url => { urls.push(url); return new Response('review unavailable', { status: 503 }) })
  const result = await YTapi(request, route.config, undefined, undefined, { taskBackend: route.taskBackend })
  assert.match(result.error, /503/)
  assert.deepEqual(urls, ['https://review.invalid/v1/chat/completions'])
})
