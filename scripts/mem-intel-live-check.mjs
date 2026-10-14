// 一次性上线验证（智能层）：真实 node-redis 客户端 → 临时测试群跑
// applyOps（说话人事实 + 被提及人别名/事实 + 第三方 refs + 待回扣事件）
// → getContextualMemoryPrompt 断言各段就位 → 清理。不污染真实群数据。
import { createClient } from 'redis'

globalThis.logger = new Proxy({}, { get: () => () => {} })

const client = createClient({ url: 'redis://127.0.0.1:6379' })
client.on('error', () => {})
await client.connect()

const { MemoryManager } = await import('../domains/memory/MemoryManager.js')
const G = '__mem_intel_check__'
const now = Date.now()
const m = new MemoryManager({ enabled: true }, { redis: client })
await m.clearGroupRedis(G)

await m.applyOps(G, [
  { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '在上海做后端', authority: 'self', confidence: 0.9, at: now } },
  { stream: 'alias', qq: '222', text: '希洛', authority: 'teaching', confidence: 0.95, by: ['111'], at: now },
  { stream: 'entityFact', qq: '222', authority: 'teaching', fact: { text: '喜欢猫', authority: 'teaching', confidence: 0.8, at: now } },
  { stream: 'entityFact', qq: '333', authority: 'mention', fact: { text: '和 111 是同事', refs: ['111'], authority: 'mention', confidence: 0.7, at: now } },
  { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '下周有考试', authority: 'self', confidence: 0.9, at: now, eventAt: now + 2 * 86400000 } }
])

const prompt = await m.getContextualMemoryPrompt(G, '111', '希洛最近怎么样', now)

const checks = {
  speaker_fact: prompt.includes('在上海做后端'),
  mentioned_section: prompt.includes('【相关的人】') && prompt.includes('喜欢猫'),
  refs_section: prompt.includes('【关联信息】') && prompt.includes('和 111 是同事'),
  pending_callback: prompt.includes('【可自然提起】') && prompt.includes('下周有考试')
}
console.log('PROMPT >>>')
console.log(prompt)
console.log('<<< PROMPT')
console.log('CHECKS', JSON.stringify(checks, null, 2))

const cleared = await m.clearGroupRedis(G)
const after = await client.get(`ytbot:mem:g:${G}:entities`)
await client.quit()

const allPass = Object.values(checks).every(Boolean) && after === null
console.log('cleaned', cleared, allPass ? 'INTEL_LIVE_PASS' : 'INTEL_LIVE_FAIL')
process.exit(allPass ? 0 : 1)
