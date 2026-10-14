// 一次性上线验证：用真实 node-redis 客户端连生产 Redis，对临时测试群跑
// applyOps → 读回 prompt → 原始键核对 → 清理。不污染真实群数据。
// 用法（在插件根目录）：node scripts/mem-live-check.mjs
import { createClient } from 'redis'

globalThis.logger = new Proxy({}, { get: () => () => {} })

const client = createClient({ url: 'redis://127.0.0.1:6379' })
client.on('error', () => {})
await client.connect()

const { MemoryManager } = await import('../domains/memory/MemoryManager.js')
const G = '__mem_deploy_check__'
const now = Date.now()
const m = new MemoryManager({ enabled: true }, { redis: client })

// 先清一次，保证干净起点
await m.clearGroupRedis(G)

const res = await m.applyOps(G, [
  { stream: 'alias', qq: '3188163302', text: 'maela', authority: 'teaching', confidence: 0.9, by: ['925640859'], at: now },
  { stream: 'alias', qq: '3188163302', text: '希洛', authority: 'mention', confidence: 0.8, by: ['x'], at: now },
  { stream: 'alias', qq: '925640859', text: '希洛', authority: 'self', confidence: 0.9, by: ['925640859'], at: now + 1 },
  { stream: 'entityFact', qq: '925640859', authority: 'self', fact: { text: '在上海工作', tags: [], refs: [], authority: 'self', confidence: 0.8, at: now, superseded: false } },
  { stream: 'groupFact', authority: 'mention', fact: { text: '群里不要刷屏', tags: ['群规'], refs: [], authority: 'mention', confidence: 0.8, at: now, superseded: false } }
])

const alias = await m.getGroupAliasPrompt(G, 'maela是谁')
const user = await m.getMemoryPromptForUser(G, '925640859', '')
const group = await m.getGroupMemoryPrompt(G, '')
const aliasDoc = JSON.parse((await client.get(`ytbot:mem:g:${G}:alias`)) || '{}')

const checks = {
  written: res.written,
  alias_maela_to_qq: alias.includes('maela') && alias.includes('3188163302'),
  user_fact: user.includes('在上海工作'),
  group_fact: group.includes('群里不要刷屏'),
  // 冲突裁决：希洛 应判给本人自述的 925640859（self > mention），而非 3188163302
  conflict_resolved_self_wins: aliasDoc['希洛']?.qq === '925640859'
}
console.log('CHECKS', JSON.stringify(checks, null, 2))

const cleared = await m.clearGroupRedis(G)
const after = await client.get(`ytbot:mem:g:${G}:alias`)
console.log('cleaned_keys', cleared, 'after_clear_null', after === null)

await client.quit()

const allPass = checks.written === 5 && checks.alias_maela_to_qq && checks.user_fact && checks.group_fact && checks.conflict_resolved_self_wins && after === null
console.log(allPass ? 'LIVE_CHECK_PASS' : 'LIVE_CHECK_FAIL')
process.exit(allPass ? 0 : 1)
