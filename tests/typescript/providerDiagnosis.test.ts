import assert from 'node:assert/strict'
import test from 'node:test'
import { createProviderProbe } from '../../src/modules/models/application/aiProviderProbe.js'
import { createChatFailureDiagnosis } from '../../src/modules/models/application/chatFailureDiagnosis.js'

test('provider protocol retries unsupported max_tokens once via injected fetch', async () => {
  const bodies: object[] = []
  const probe = createProviderProbe(async (_url, options) => {
    bodies.push(JSON.parse(String(options.body)))
    return bodies.length === 1
      ? { ok: false, status: 400, text: async () => '{"error":{"message":"max_tokens unsupported"}}' }
      : { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"pong"}}],"usage":{"total_tokens":2}}' }
  })
  const result = await probe.probeProvider({ apiUrl: 'https://fake.invalid/v1', apiKey: 'test', model: 'fake' })
  assert.equal(result.ok, true)
  assert.equal(bodies.length, 2)
  assert.equal('max_tokens' in bodies[1]!, false)
  assert.equal('max_completion_tokens' in bodies[1]!, true)
})

test('malformed provider responses cannot masquerade as generated chat', async () => {
  const probe = createProviderProbe(async () => ({ ok: true, status: 200, text: async () => 'null' }))
  assert.equal((await probe.probeProvider({ apiUrl: 'https://fake.invalid', apiKey: 'test', model: 'fake' })).ok, false)
})

test('diagnosis injects configuration, logging, time and network with throttle/cache expiry', async () => {
  let time = 100000
  let calls = 0
  const logs: string[] = []
  const fetch = async () => { calls++; return { ok: true, status: 200 } }
  const diagnosis = createChatFailureDiagnosis({
    now: () => time, fetch, resolveFetch: async () => fetch,
    readSettings: () => ({ chatAiConfig: { chatApiUrl: 'https://fake.invalid', chatApiKey: 'test', chatApiModel: 'fake' } }),
    logger: { info: message => { logs.push(message) } }
  })
  const first = await diagnosis.runChatFailureDiagnosis()
  assert.equal(first?.backends[0]?.ok, true)
  assert.equal(calls, 1)
  assert.equal(await diagnosis.runChatFailureDiagnosis(), first)
  assert.match(diagnosis.getCachedDiagnosisLine(), /主对话✅/)
  assert.equal(logs.length, 1)
  time += 180001
  assert.equal(diagnosis.getCachedDiagnosisLine(), '')
})
