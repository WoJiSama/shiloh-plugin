import { randomUUID, createHash } from 'node:crypto'
import type { CharacterScope } from '../../../contracts/character.js'
import { characterKey, validateCharacterScope } from '../domain/characterState.js'
import { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'
import { createScopedStateStore } from './scopedStateStore.js'
import { createCharacterStore, type CharacterRedis } from './characterStore.js'

interface SharedEntry { id: string; kind: 'opinion' | 'interest'; content: string; sourceScope: CharacterScope; sourceMemoryId: string; createdAt: number; approved: boolean }
interface SharedState { schemaVersion: 1; botId: string; personaId: string; entries: SharedEntry[] }
export interface SharedSelfProjection { id: string; kind: 'opinion' | 'interest'; content: string; createdAt: number }

export function createCharacterSharedSelf({ redis, scope, now = Date.now }: { redis: CharacterRedis; scope: CharacterScope; now?: () => number }) {
  validateCharacterScope(scope)
  const characters = createCharacterStore({ redis, now })
  const key = `shiloh:shared-self:v1:${encodeURIComponent(scope.botId)}:${encodeURIComponent(scope.personaId)}`
  const store = createScopedStateStore<SharedState>({ redis, key,
    empty: () => ({ schemaVersion: 1, botId: scope.botId, personaId: scope.personaId, entries: [] }),
    validate(value) {
      const state = value as SharedState
      if (!state || state.schemaVersion !== 1 || state.botId !== scope.botId || state.personaId !== scope.personaId || !Array.isArray(state.entries) || state.entries.length > 32 || Object.keys(state).some(k => !['schemaVersion', 'botId', 'personaId', 'entries'].includes(k))) throw new Error('共享自我状态无效')
      const ids = new Set<string>()
      for (const entry of state.entries) {
        if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || !['opinion', 'interest'].includes(entry.kind) || typeof entry.content !== 'string' || !entry.content.trim() || entry.content.length > 600 || typeof entry.sourceMemoryId !== 'string' || !entry.sourceMemoryId || typeof entry.approved !== 'boolean' || !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0 || Object.keys(entry).some(k => !['id','kind','content','sourceScope','sourceMemoryId','createdAt','approved'].includes(k))) throw new Error('共享自我条目无效')
        validateCharacterScope(entry.sourceScope)
        if (entry.sourceScope.botId !== scope.botId || entry.sourceScope.personaId !== scope.personaId) throw new Error('共享自我身份不匹配')
        ids.add(entry.id)
      }
      return state
    },
  })
  async function sourceAlive(entry: SharedEntry, entries: SharedEntry[], visited = new Set<string>()): Promise<boolean> {
    if (visited.has(entry.id)) return false
    const path = new Set([...visited,entry.id])
    const source = await characters.load(entry.sourceScope)
    const memory = source.memories.find(m => m.id === entry.sourceMemoryId && m.kind === entry.kind && !source.memories.some(next => next.supersedes === m.id))
    if (!memory) return false
    for (const id of memory.sharedSources || []) {
      const parent = entries.find(item => item.id === id && item.approved)
      if (!parent || !await sourceAlive(parent, entries, path)) return false
    }
    return true
  }
  async function liveEntries() {
    const entries = (await store.load()).entries
    const alive = await Promise.all(entries.map(entry => sourceAlive(entry, entries)))
    return entries.filter((_entry, index) => alive[index])
  }
  async function projection(): Promise<SharedSelfProjection[]> {
    return (await liveEntries()).filter(e => e.approved).map(({ id, kind, content, createdAt }) => ({ id, kind, content, createdAt }))
  }
  async function pending() { return (await liveEntries()).filter(e => !e.approved && e.sourceScope.groupId === scope.groupId).map(({ id, content, kind, sourceMemoryId, createdAt }) => ({ id, content, kind, sourceMemoryId, createdAt })) }
  async function propose(memoryId: string) {
    const source = await characters.load(scope)
    const memory = source.memories.find(m => m.id === memoryId && ['opinion', 'interest'].includes(m.kind) && !source.memories.some(next => next.supersedes === m.id))
    if (!memory || memory.content.length > 600) throw new Error('只能提议本群当前有效的短观点或兴趣')
    const live = new Set((await liveEntries()).map(e => e.id))
    const result = await store.update(state => {
      state.entries = state.entries.filter(e => live.has(e.id))
      if (state.entries.some(e => characterKey(e.sourceScope) === characterKey(scope) && e.sourceMemoryId === memoryId)) throw new Error('已存在相同共享提议')
      if (state.entries.length >= 32) throw new Error('共享自我容量已满')
      state.entries.push({ id: randomUUID(), content: memory.content, kind: memory.kind as 'opinion'|'interest', sourceScope: scope, sourceMemoryId: memoryId, createdAt: now(), approved: false })
      return state
    })
    return result.entries.at(-1)!.id
  }
  async function approve(id: string) {
    const live = new Set((await liveEntries()).map(e => e.id))
    await store.update(state => {
      const entry = state.entries.find(e => e.id === id && e.sourceScope.groupId === scope.groupId && live.has(e.id))
      if (!entry) throw new Error('本群提议不存在或来源已失效')
      entry.approved = true
      return state
    })
  }
  async function remove(id: string) { await store.update(state => { if (!state.entries.some(e => e.id === id)) throw new Error('共享偏好不存在'); state.entries = state.entries.filter(e => e.id !== id); return state }) }
  async function fingerprint() { return createHash('sha256').update(JSON.stringify(await projection())).digest('hex') }
  return { projection, pending, propose, approve, remove, fingerprint }
}

export function createSharedSelfTools({ shared, ensureActive, visibleEvidenceRefs }: {
  shared: ReturnType<typeof createCharacterSharedSelf>; ensureActive(): Promise<void>; visibleEvidenceRefs(): string[]
}): AbstractTool[] {
  class SharedSelfTool extends AbstractTool {
    constructor() {
      super(); this.name = 'simSharedSelf'; this.description = '查看本机器人同一人设的已批准共享偏好，或提议把本群自己的观点/兴趣共享。只接受已可见的当前memoryId；提议须主人在控制台确认后跨群生效。群友资料、私密经历和聊天全文不共享；来源删除/修正即失效。'
      this.parameters = { type: 'object', properties: { action: { type: 'string', enum: ['list','propose'] }, memoryId: { type: 'string' }, offset: { type: 'number', minimum: 0 } }, required: ['action'], additionalProperties: false }
    }
    override async func(args: Record<string, unknown>) {
      await ensureActive()
      if (Object.keys(args).some(k => !['action','memoryId','offset'].includes(k))) throw new Error('不支持的共享参数')
      if (args.action === 'list' && args.memoryId === undefined) {
        const offset = args.offset ?? 0
        if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error('offset无效')
        const all = await shared.projection(), selected = all.slice(Number(offset), Number(offset) + 4)
        return { ok: true, shared: selected, hasMore: Number(offset) + selected.length < all.length, nextOffset: Number(offset) + selected.length }
      }
      if (args.action !== 'propose' || args.offset !== undefined || typeof args.memoryId !== 'string' || !visibleEvidenceRefs().includes(`memory:${args.memoryId}`)) throw new Error('仅可提议本轮可见的观点/兴趣')
      return { ok: true, pendingId: await shared.propose(args.memoryId), status: 'pending_admin_review' }
    }
  }
  return [new SharedSelfTool()]
}
