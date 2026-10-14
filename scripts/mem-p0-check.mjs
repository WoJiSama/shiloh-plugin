// 一次性验证 P0 修复(真实 Redis,临时测试群,跑完清理)。
import { createClient } from 'redis'
import { factShortId } from '../domains/memory/engine/entityModel.js'
globalThis.logger = new Proxy({}, { get: () => () => {} })

const client = createClient({ url: 'redis://127.0.0.1:6379' }); client.on('error', () => {})
await client.connect()
const { MemoryManager } = await import('../domains/memory/MemoryManager.js')
const G = '__mem_p0_check__'
const now = Date.now()
const m = new MemoryManager({ enabled: true }, { redis: client })
await m.clearGroupRedis(G)

// 准备:用户A、用户B 各有事实 + 一条群事实 + 一个别名
await m.applyOps(G, [
  { stream: 'entityFact', qq: 'A', authority: 'self', fact: { text: 'A在上海', authority: 'self', confidence: 0.9, at: now } },
  { stream: 'entityFact', qq: 'A', authority: 'self', fact: { text: 'A喜欢咖啡', authority: 'self', confidence: 0.9, at: now } },
  { stream: 'entityFact', qq: 'B', authority: 'self', fact: { text: 'B在北京', authority: 'self', confidence: 0.9, at: now } },
  { stream: 'groupFact', authority: 'mention', fact: { text: '群里不要刷屏', tags: ['群规'], authority: 'mention', confidence: 0.8, at: now } },
  { stream: 'alias', qq: 'B', text: '老北', authority: 'teaching', confidence: 0.9, by: ['A'], at: now }
])

// ---- P0-1: 清空我的记忆只删自己 ----
await m.clearUserMemory(G, 'A')
let ents = await m.store.getEntities(G)
let gfacts = await m.store.getFacts(G)
let alias = await m.store.getAlias(G)
const p01 = {
  A_gone: !ents['A'],
  B_kept: !!ents['B'] && ents['B'].facts.some(f => f.text === 'B在北京'),
  groupFact_kept: gfacts.some(f => f.text === '群里不要刷屏'),
  alias_kept: !!alias['老北']
}

// ---- P0-2: 禁用真的停抽取 ----
m.config.userExtractMaxBatchMessages = 1 // 让抽取立即触发,便于断言
m.extractor.extract = async () => ([{ stream: 'entityFact', qq: 'B', authority: 'self', fact: { text: '不该被写入', authority: 'self', confidence: 0.9, at: now } }])
await m.adminSetUserMemoryEnabled({ groupId: G, userId: 'B', enabled: false })
const disabledRet = await m.extractAndSaveMemories(G, 'B', '我说点什么')
await m.adminSetUserMemoryEnabled({ groupId: G, userId: 'B', enabled: true })
const enabledRet = await m.extractAndSaveMemories(G, 'B', '我再说点什么')
const p02 = {
  disabled_skipped: disabledRet.queued === false && disabledRet.reason === 'opted-out',
  enabled_works: !!(enabledRet && (enabledRet.written >= 1 || enabledRet.queued))
}

// ---- P0-3: 列表渲染/搜索/按id软删 ----
const list = await m.adminListMemories({ scope: 'user', groupId: G, userId: 'B' })
const bFact = (await m.store.getEntities(G))['B'].facts.find(f => f.text === 'B在北京')
const sid = bFact ? factShortId(bFact.text) : null
const del = sid ? await m.adminDeleteMemory({ groupId: G, userId: 'B', id: `my:${sid}` }) : { deleted: false }
const afterDel = (await m.store.getEntities(G))['B'].facts.find(f => f.text === 'B在北京')
const queryList = await m.adminListMemories({ scope: 'group', groupId: G, query: '刷屏' })
const p03 = {
  list_has_real_fields: Array.isArray(list.facts) && list.facts.every(f => typeof f.text === 'string'),
  shortId_stable: sid === factShortId('B在北京'),
  my_delete_soft: del.deleted === true && afterDel?.superseded === true,
  query_filter_works: queryList.facts.some(f => f.text.includes('刷屏'))
}

console.log('P0-1 清空只删自己:', JSON.stringify(p01))
console.log('P0-2 禁用真停抽取:', JSON.stringify(p02))
console.log('P0-3 列表/搜索/删除:', JSON.stringify(p03))

await m.clearGroupRedis(G)
await client.quit()
const allPass = Object.values({ ...p01, ...p02, ...p03 }).every(Boolean)
console.log(allPass ? 'P0_LIVE_PASS ✅' : 'P0_LIVE_FAIL ❌')
process.exit(allPass ? 0 : 1)
