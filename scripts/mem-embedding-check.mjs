// 一次性：验证语义召回是否真的生效。读运行时 config → 实调 embedding 接口 →
// 验证 applyOps 写入的 fact 真的带上了 embedding 向量。临时测试群,跑完清理。
import fs from 'node:fs'
import { createClient } from 'redis'
import { Embeddings, cosineSimilarity } from '../domains/memory/engine/embeddings.js'
import { MemoryManager } from '../domains/memory/MemoryManager.js'

globalThis.logger = new Proxy({}, { get: () => () => {} })

const yaml = (await import('js-yaml')).default
const doc = yaml.load(fs.readFileSync('config/message.yaml', 'utf8'))
const ps = doc.pluginSettings || doc
const ms = ps.memorySystem || {}
const ec = ps.embeddingAiConfig || {}
const cfg = { ...ms, embeddingAiConfig: ec, memoryAiConfig: ps.memoryAiConfig, enabled: true }

console.log('--- 配置状态 ---')
console.log('semanticRecallEnabled :', ms.semanticRecallEnabled)
console.log('embeddingApiUrl       :', ec.embeddingApiUrl)
console.log('embeddingApiModel     :', ec.embeddingApiModel)
console.log('embeddingApiKey       :', ec.embeddingApiKey ? `[已设置, 长度${String(ec.embeddingApiKey).length}]` : '[空]')

const emb = new Embeddings(cfg)
console.log('canUse()              :', emb.canUse())
if (!emb.canUse()) { console.log('RESULT: NOT_ENABLED (开关或 URL/Key 缺失)'); process.exit(1) }

console.log('\n--- 实调 embedding 接口 ---')
const v = await emb.embed('你好，这是一条语义召回测试句子')
if (!Array.isArray(v) || !v.length) { console.log('RESULT: EMBED_FAILED (接口未返回向量,检查 key/URL/模型/网络)'); process.exit(1) }
console.log('embed("…") → 向量维度:', v.length)

// 相关性演示：相近句 vs 无关句的余弦
const a = await emb.embed('我在上海做后端开发')
const b = await emb.embed('他在上海写服务端代码')
const c = await emb.embed('今天天气真不错适合出去玩')
console.log('cos(相近句)            :', cosineSimilarity(a, b).toFixed(3))
console.log('cos(无关句)            :', cosineSimilarity(a, c).toFixed(3))

console.log('\n--- 写入即带向量(端到端) ---')
const client = createClient({ url: 'redis://127.0.0.1:6379' }); client.on('error', () => {})
await client.connect()
const G = '__emb_check__'
const m = new MemoryManager(cfg, { redis: client })
await m.clearGroupRedis(G)
await m.applyOps(G, [{ stream: 'entityFact', qq: '1', authority: 'self', fact: { text: '喜欢在周末爬山', authority: 'self', confidence: 0.9, at: Date.now() } }])
const ents = await m.store.getEntities(G)
const fact = ents['1']?.facts?.[0]
const hasEmb = Array.isArray(fact?.embedding) && fact.embedding.length > 0
console.log('写入的 fact 带 embedding:', hasEmb, hasEmb ? `(维度 ${fact.embedding.length})` : '')
await m.clearGroupRedis(G)
await client.quit()

console.log('\nRESULT:', hasEmb ? 'SEMANTIC_RECALL_LIVE ✅' : 'PIPELINE_NOT_WIRED ❌')
process.exit(hasEmb ? 0 : 1)
