// utils/MemoryManager.js
import { RedisStore } from './engine/redisStore.js'
import { MemoryExtractor } from './engine/extractor.js'
import { upsertAlias, resolveAlias, listAliasesForQQ } from './engine/aliasRegistry.js'
import { makeEntity, makeFact, slimGroupFacts, factShortId, normalizePersonaSource, personaSourceKey } from './engine/entityModel.js'
import { resolveClaim } from './engine/conflictResolver.js'
import { classifyBoundary } from './engine/boundary.js'
import { buildAliasPrompt, buildEntityPrompt, buildGroupFactsPrompt, buildContextualPrompt } from './engine/retriever.js'
import { resolveMentions } from './engine/mentionResolver.js'
import { Embeddings, cosineSimilarity } from './engine/embeddings.js'
import { Reflector } from './engine/reflector.js'
import { clamp, compactText, normalizeAlias, authorityRank } from './engine/constants.js'
import { memStats } from './engine/stats.js'
import { formatGroupWorkflowExecutionPrompt, selectRelevantGroupWorkflowRules } from './engine/groupWorkflow.js'
import { describeGroupKnowledgeEntry, findGroupKnowledgeDeletionCandidates, formatGroupKnowledgePrompt, parseSemanticGroupMemoryOutput, selectRelevantGroupKnowledge } from './engine/groupKnowledge.js'

import type { MemoryId, MemoryRedisClient, MemoryLlmConfig, MemoryLlmPorts, MemoryFact, MemoryEntity, GroupMember, KnowledgeEntry, WorkflowRule, MemoryOperation, MemoryExtractionMessage, MemoryExtractionMeta, MemoryExtractionResult, PendingMemoryExtraction } from '../../../contracts/memoryEngine.js'
import type { PersonaScope } from '../../../contracts/persona.js'
import { memoryRecord } from '../../../contracts/memoryEngine.js'
import {finiteTimestamp,memoryDate} from './engine/temporalContext.js'
type Fact = MemoryFact
type EntityMap = Record<string, MemoryEntity>
type Operation = MemoryOperation
interface ExtractionBuffer {groupId:MemoryId;userId:MemoryId;messages:MemoryExtractionMessage[];timer:ReturnType<typeof setTimeout>|null;heardFrom:string;personaSource?:PersonaScope;attempts:number;retryAt:number;retryExhausted:boolean;running:boolean;lastFailure?:string}

interface ReflectTargets { entityQQs: string[]; groupOverThreshold: boolean }
interface AdminOptions { groupId?: MemoryId; userId?: MemoryId; scope?: string | null; query?: string; limit?: number; id?: string; requesterQQ?: MemoryId; requesterIsGroupManager?: boolean; enabled?: boolean }
interface ManagerPorts { llm: MemoryLlmPorts; logger?: { warn?(...args: unknown[]): void; error?(...args: unknown[]): void }; defaultRedis: MemoryRedisClient }
export function createMemoryManagerClass(ports: ManagerPorts) {
const DAY_MS = 86400000

const DEFAULT_CONFIG = {
  enabled: true,
  maxEntitiesPerGroup: 200,
  maxFactsPerGroup: 50,
  maxFactsPerEntity: 20,
  saveStrictness: 'normal',          // off | normal | strict
  userExtractDebounceSeconds: 90,
  userExtractMaxBatchMessages: 6,
  groupExtractMinIntervalMinutes: 10,
  groupExtractMaxBatchMessages: 12,
  extractRetryMaxAttempts: 3,
  extractRetryBaseMs: 15000,
  extractPendingMaxMessages: 60,
  extractPendingMaxBatches: 200,
  promptMaxGroupFacts: 6,
  promptMaxEntityFacts: 6,
  promptMaxChars: 1200,
  memoryAiConfig: {} as NonNullable<MemoryLlmConfig["memoryAiConfig"]>,
  embeddingAiConfig: {} as { embeddingApiUrl?: string; embeddingApiKey?: string; embeddingApiModel?: string },
  semanticRecallEnabled: false,
  reflectEntityThreshold: 15,
  reflectGroupThreshold: 30,
  proactiveCallback: true,
  recallMaxMentionedEntities: 3,
  proactiveWindowDaysBefore: 3,
  proactiveWindowDaysAfter: 7,
  semanticDupCosine: 0.88,
  maxGroupWorkflows: 50,
  workflowPromptMaxRules: 12,
  maxGroupKnowledge: 100,
  knowledgePromptMaxEntries: 8,
  knowledgeDecisionTimeoutMs: 900,
  knowledgeDecisionMaxTokens: 400,
  knowledgeDecisionInlineWaitMs: 180
}

function nowMs() { return Date.now() }

function membersFromContext(memberMap: Map<unknown, GroupMember> | undefined, { text = '', messageSegments = [], creatorQQ = '' }: { text?: string; messageSegments?: Record<string, unknown>[]; creatorQQ?: MemoryId } = {}) {
  if (!memberMap?.values) return []
  const query = String(text || '').toLowerCase()
  const mentionedIds = new Set([String(creatorQQ || '')])
  for (const segment of Array.isArray(messageSegments) ? messageSegments : []) {
    if (segment?.type !== 'at') continue
    const id = String(segment?.qq ?? segment?.user_id ?? memoryRecord(segment.data).qq ?? memoryRecord(segment.data).user_id ?? '').trim()
    if (/^\d+$/.test(id)) mentionedIds.add(id)
  }
  return Array.from(memberMap.values())
    .filter(member => member?.user_id)
    .filter(member => {
      const name = String(member.card || member.nickname || '').trim().toLowerCase()
      return mentionedIds.has(String(member.user_id)) || (name.length >= 2 && query.includes(name))
    })
    .map(member => ({ userId: String(member.user_id), displayName: compactText(member.card || member.nickname || member.user_id, 80) }))
    .slice(0, 12)
}

function normalizeSharedKey(value: unknown = '') {
  return String(value || '').toLowerCase().replace(/[\s，,。；;：:！!？?、@"“”']/g, '')
}

function uniqueNumericIds(values: unknown[] = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim())
    .filter(value => /^\d+$/.test(value)))]
}

function sameIdList(left: unknown[] = [], right: unknown[] = []) {
  const a = uniqueNumericIds(left)
  const b = uniqueNumericIds(right)
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sharedRecordOwner(record: { createdBy?: MemoryId; by?: string[] } = {}) {
  return String(record?.createdBy || record?.by?.[0] || '').trim()
}

function mayChangeSharedRecord(record: { createdBy?: MemoryId; by?: string[] }, requesterQQ: MemoryId, isGroupManager: boolean) {
  const requester = String(requesterQQ || '').trim()
  const owner = sharedRecordOwner(record)
  return Boolean(isGroupManager || (requester && owner && requester === owner))
}

class MemoryManager {
 config: typeof DEFAULT_CONFIG & MemoryLlmConfig; store: RedisStore; extractor: MemoryExtractor; embeddings: Embeddings; reflector: Reflector; REDIS_PREFIX: string;
 userBuffers = new Map<string, ExtractionBuffer>();
 pendingRestoreTasks = new Map<string, Promise<void>>();
 groupBuffers = new Map<string, ExtractionBuffer>(); lastGroupExtractAt = new Map<MemoryId, number>(); scopeQueues = new Map<MemoryId, Promise<unknown>>(); optedOutCache = new Map<MemoryId, Set<string>>();
  constructor(config: Partial<typeof DEFAULT_CONFIG> & MemoryLlmConfig = {}, { redis = ports.defaultRedis }: { redis?: MemoryRedisClient } = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.store = new RedisStore({ redis })
    this.extractor = new MemoryExtractor(this.config, ports.llm)
    this.embeddings = new Embeddings(this.config)
    this.reflector = new Reflector(this.config, ports.llm)
    this.REDIS_PREFIX = 'ytbot:mem:g:'
    // §0.2 opt-out 进程内缓存：groupId -> Set<QQ>。写入侧热路径需同步判断，
    // 故用缓存避免每条消息都 await 读 meta。adminSetUserMemoryEnabled 写 meta 时同步刷新；
    // 首次遇到未知群时惰性后台预热。
  }

  setAiConfig(aiConfig: NonNullable<MemoryLlmConfig["memoryAiConfig"]>) {
    this.config.memoryAiConfig = aiConfig
    this.extractor.config = this.config
    this.reflector.config = this.config
  }

  updateConfig(config: Partial<typeof DEFAULT_CONFIG> & MemoryLlmConfig = {}) {
    this.config = { ...this.config, ...config }
    this.extractor.config = this.config
    this.embeddings.config = this.config
    this.reflector.config = this.config
  }

  // ---- 串行队列（每群一个，保证 read-modify-write 安全）----
  enqueueGroup<T>(groupId: MemoryId, task: () => Promise<T>): Promise<T> {
    const groupKey = String(groupId)
    const prev = this.scopeQueues.get(groupKey) || Promise.resolve()
    const next = prev.catch(() => {}).then(task).finally(() => {
      if (this.scopeQueues.get(groupKey) === next) this.scopeQueues.delete(groupKey)
    })
    this.scopeQueues.set(groupKey, next)
    return next
  }

  // ---- 写入：把 parseAndRoute 的 ops 落库 ----
  async applyOps(groupId: MemoryId, ops: Operation[] = [], {isCurrent}: {isCurrent?:()=>boolean} = {}) {
    if (!ops.length) return { written: 0 }
    const result = await this.enqueueGroup(groupId, async () => {
      const meta = await this.store.getMeta(groupId)
      if (meta.disabled || (isCurrent && !isCurrent())) return { written: 0 }

      let entities = await this.store.getEntities(groupId)
      let aliasDoc = await this.store.getAlias(groupId)
      let facts = await this.store.getFacts(groupId)
      let written = 0

      for (const op of ops) {
        if (op.stream === 'alias') {
          const res = upsertAlias(aliasDoc, { text: op.text, qq: op.qq, authority: op.authority, confidence: op.confidence, by: op.by, createdBy: op.createdBy || "", sourceMessageId: op.sourceMessageId || "", proposalId: op.proposalId || "", at: op.at })
          if (res.changed) {
            aliasDoc = res.doc
            entities = this._ensureEntityAlias(entities, op)
            written++
          }
        } else if (op.stream === 'entityFact') {
          entities = await this._addEntityFact(entities, op)
          written++
        } else if (op.stream === 'groupFact') {
          facts = await this._addGroupFact(facts, op.fact)
          written++
        }
      }

      entities = this._trimEntities(entities)
      facts = this._trimFacts(facts)
      await this.store.saveEntities(groupId, entities)
      await this.store.saveAlias(groupId, aliasDoc)
      await this.store.saveFacts(groupId, facts)
      // 反思目标在锁内计算，但反思本身在锁外独立 enqueue（见 _maybeReflect）。
      const reflectTargets = this._collectReflectTargets(ops, entities, facts)
      return { written, reflectTargets }
    })

    // 复刻已修死锁的教训：反思绝不嵌套在 applyOps 自身的 enqueue task 内，
    // 必须新起一次 enqueueGroup。fire-and-forget，失败仅 log。
    this._maybeReflect(groupId, ("reflectTargets" in result ? result.reflectTargets : null))
    return { written: result.written }
  }

  _ensureEntityAlias(entities: EntityMap, op: Extract<Operation, {stream: 'alias'}>) {
    const next = { ...entities }
    const e = makeEntity(next[op.qq] || { qq: op.qq })
    if (!e.aliases.some(a => a.text === op.text && !a.superseded)) {
      e.aliases = [...e.aliases, { text: op.text, authority: op.authority, confidence: op.confidence, by: op.by || [], at: op.at, superseded: false }]
    }
    e.updatedAt = nowMs()
    next[op.qq] = e
    return next
  }

  async _addEntityFact(entities: EntityMap, op: Extract<Operation, {stream: 'entityFact'}>) {
    const next = { ...entities }
    const e = makeEntity(next[op.qq] || { qq: op.qq })
    const incoming = await this._withEmbedding(makeFact(op.fact))
    const dupIdx = this._findDupFactIndex(e.facts, incoming)
    if (dupIdx >= 0) {
      const { winner } = resolveClaim(e.facts[dupIdx], incoming)
      e.facts = e.facts.map((f, i) => (i === dupIdx ? winner : f))
    } else {
      e.facts = [...e.facts, incoming]
    }
    e.updatedAt = nowMs()
    next[op.qq] = e
    return next
  }

  async _addGroupFact(facts: Fact[], fact: Fact) {
    const incoming = await this._withEmbedding(makeFact(fact))
    const dupIdx = this._findDupFactIndex(facts, incoming)
    if (dupIdx >= 0) {
      const { winner } = resolveClaim(facts[dupIdx], incoming)
      return facts.map((f, i) => (i === dupIdx ? winner : f))
    }
    return [...facts, incoming]
  }

  // semanticRecall 开启时为 fact 补 embedding（失败/未启用 → 原样返回，embedding 保持 null）。
  async _withEmbedding(fact: Fact) {
    if (!this.embeddings.canUse()) return fact
    const vector = await this.embeddings.embed(fact.text)
    return vector ? { ...fact, embedding: vector } : fact
  }

  // 同一来源和事件日期内去重。相似句子不能抹掉另一次事件，
  // 也不能把另一人格的观察换成当前人格自己的来源。
  _findDupFactIndex(facts: Fact[], incoming: Fact) {
    const list = facts || []
    const sameContext = (fact:Fact) => (fact.eventAt ?? null) === (incoming.eventAt ?? null)
      && personaSourceKey(fact.personaSource) === personaSourceKey(incoming.personaSource)
      && (fact.heardFrom || '') === (incoming.heardFrom || '')
    const exact = list.findIndex(f => f.text === incoming.text && sameContext(f))
    if (exact >= 0) return exact
    if (!this.embeddings.canUse() || !Array.isArray(incoming.embedding)) return -1
    const threshold = Number.isFinite(this.config.semanticDupCosine) ? this.config.semanticDupCosine : 0.88
    for (let i = 0; i < list.length; i++) {
      const f = list[i]!
      if (f.superseded || !sameContext(f) || !Array.isArray(f.embedding)) continue
      if (cosineSimilarity(incoming.embedding, f.embedding) >= threshold) return i
    }
    return -1
  }

  // ---- 反思触发（阈值，锁外独立 enqueue，fire-and-forget）----
  // 收集本次写入后越过阈值的反思目标：受影响的实体 QQ 集合 + 群是否越阈。
  _collectReflectTargets(ops: Operation[], entities: EntityMap, facts: Fact[]) {
    if (!this.reflector.canUse()) return null
    const entityThreshold = Number.isFinite(this.config.reflectEntityThreshold) ? this.config.reflectEntityThreshold : 15
    const groupThreshold = Number.isFinite(this.config.reflectGroupThreshold) ? this.config.reflectGroupThreshold : 30

    const touchedQQs = new Set<string>()
    for (const op of ops || []) {
      if ((op.stream === 'entityFact' || op.stream === 'alias') && op.qq) touchedQQs.add(String(op.qq))
    }
    const entityQQs = []
    for (const qq of touchedQQs) {
      const e = entities[qq]
      const activeCount = (e?.facts || []).filter(f => !f.superseded).length
      if (activeCount > entityThreshold) entityQQs.push(qq)
    }
    const activeGroupFacts = (facts || []).filter(f => !f.superseded).length
    const groupOverThreshold = activeGroupFacts > groupThreshold

    if (!entityQQs.length && !groupOverThreshold) return null
    return { entityQQs, groupOverThreshold }
  }

  // 新起一次 enqueueGroup（绝不嵌套在 applyOps 的 task 内）。失败仅 log，不阻塞主流程。
  _maybeReflect(groupId: MemoryId, targets: ReflectTargets | null | undefined) {
    if (!targets || !this.reflector.canUse()) return
    this.enqueueGroup(groupId, () => this._runReflection(groupId, targets))
      .catch(err => {
        ports.logger?.warn?.(`[Memory] 反思失败 group=${groupId}: ${err?.message || err}`)
        memStats.inc('reflect.failed')
      })
  }

  // 锁内只做 read → consolidate/reflect → store.save*，绝不再调 applyOps。
  async _runReflection(groupId: MemoryId, targets: ReflectTargets) {
    const meta = await this.store.getMeta(groupId)
    if (meta.disabled) return

    if (targets.entityQQs?.length) {
      const entities = await this.store.getEntities(groupId)
      let changedAny = false
      for (const qq of targets.entityQQs) {
        const entity = entities[qq]
        if (!entity) continue
        const { facts, changed } = await this.reflector.consolidateEntity(entity)
        if (changed) {
          entities[qq] = { ...entity, facts, updatedAt: nowMs() }
          changedAny = true
        }
      }
      if (changedAny) await this.store.saveEntities(groupId, this._trimEntities(entities))
    }

    if (targets.groupOverThreshold) {
      const facts = await this.store.getFacts(groupId)
      const recentTexts = facts.filter(f => !f.superseded).slice(-this.config.groupExtractMaxBatchMessages).map(f => f.text)
      const { insights } = await this.reflector.reflectGroup({ groupId, facts, recentTexts })
      if (insights.length) {
        let merged = facts
        for (const insight of insights) merged = await this._addGroupFact(merged, insight)
        await this.store.saveFacts(groupId, this._trimFacts(merged))
      }
    }

    // Reflection is a separate task. It cannot clear an extraction failure or
    // claim that a skipped/failed extraction completed successfully.
  }

  _trimEntities(entities: EntityMap) {
    const ids = Object.keys(entities)
    if (ids.length <= this.config.maxEntitiesPerGroup) {
      for (const id of ids) entities[id]!.facts = this._capFacts(entities[id]!.facts, this.config.maxFactsPerEntity)
      return entities
    }
    const sorted = ids.sort((a, b) => (entities[b]!.updatedAt || 0) - (entities[a]!.updatedAt || 0))
    const keep = sorted.slice(0, this.config.maxEntitiesPerGroup)
    const out: EntityMap = {}
    for (const id of keep) { out[id] = entities[id]!; out[id]!.facts = this._capFacts(out[id]!.facts, this.config.maxFactsPerEntity) }
    return out
  }

  _capFacts(facts: Fact[], max: number) {
    const active = (facts || []).filter(f => !f.superseded)
    if (active.length <= max) return facts
    active.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || (b.at ?? 0) - (a.at ?? 0))
    return active.slice(0, max)
  }

  _trimFacts(facts: Fact[]) {
    return this._capFacts(slimGroupFacts(facts), this.config.maxFactsPerGroup)
  }

  // ---- 语境化注入（mention 感知 / 语义召回 / refs 反查 / 时间回扣）----
  // 一次性读 entities/alias/facts，解析提及，组装六段语境提示。disabled 群返回 ''。
  async getContextualMemoryPrompt(groupId: MemoryId, speakerQQ: MemoryId, message: string, now = Date.now(), { viewerBotName = "", viewer }: {viewerBotName?:string;viewer?:PersonaScope} = {}) {
    if (!this.config.enabled) return ''
    await this.restorePendingExtractions(groupId)
    const meta = await this.store.getMeta(groupId)
    if (meta.disabled) return ''

    const [entities, aliasDoc, facts] = await Promise.all([
      this.store.getEntities(groupId),
      this.store.getAlias(groupId),
      this.store.getFacts(groupId)
    ])

    const speaker = String(speakerQQ)
    const query = String(message || '')

    const { qqs: mentionedQQs } = resolveMentions(query, {
      aliasDoc,
      entities,
      speakerQQ: speaker,
      max: this.config.recallMaxMentionedEntities
    })

    // §0.2 读取侧 opt-out：speaker 在 optedOut → 不注入其自身记忆（speakerEntity 视为 null）。
    // 被提及人不受影响（opt-out 只关"对我的记忆"）。
    const optedOut = new Set((meta.optedOut || []).map(String))
    const rawSpeakerEntity = optedOut.has(speaker) ? null : (entities[speaker] || null)
    const rawMentionedEntities = mentionedQQs.map(qq => entities[qq]).filter(Boolean)

    // §0.4 query embedding 只算一次，实体排序与群事实排序共用，避免重复 embed。
    const queryEmb = await this._queryEmbedding(query)

    const speakerEntity = this._rankEntityForPrompt(rawSpeakerEntity, query, queryEmb) ?? null
    const mentionedEntities = rawMentionedEntities.map(e => this._rankEntityForPrompt(e, query, queryEmb)).filter((entity): entity is MemoryEntity => entity != null)

    const relevantQQs = new Set([speaker, ...mentionedQQs])
    const refsFacts = this._collectRefsFacts(entities, relevantQQs)
    const groupFacts = this._rankGroupFacts(facts, queryEmb)
    // pending 用未截断的原始实体 facts（回扣窗口与排序无关），避免被实体排序截断漏掉。
    const pendingFacts = this._collectPendingFacts([rawSpeakerEntity, ...rawMentionedEntities], now)

    return buildContextualPrompt({
      speakerEntity,
      mentionedEntities,
      refsFacts,
      groupFacts,
      aliasDoc,
      pendingFacts,
      query,
      config: this.config,
      viewerBotName: String(viewerBotName || "").slice(0, 24),
      ...(viewer ? {viewer} : {})
    })
  }

  // ---- 语义群记忆统一提交 ----
  // 语义裁决只产出提案；这里才是唯一的共享状态写入口。一次队列内读取并写回三个
  // 文档，确保 alias / knowledge / workflow 使用相同来源且不会发生跨文档的半覆盖。
  async commitGroupMemoryDecision(groupId: MemoryId, decision: { knowledgeEntries?: KnowledgeEntry[]; workflowRules?: WorkflowRule[]; aliasMappings?: Record<string, unknown>[] } = {}, context: Record<string, unknown> = {}) {
    if (!this.config.enabled || !groupId) {
      return { status: 'ignored', written: 0, knowledgeEntries: [], workflowRules: [], aliasMappings: [], rejected: [] }
    }
    const requesterQQ = String(context.requesterQQ || context.creatorQQ || '').trim()
    const isGroupManager = context.isGroupManager === true
    const sourceMessageId = String(context.sourceMessageId || '').trim()
    const proposalId = compactText(context.proposalId || sourceMessageId || `proposal_${nowMs().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, 120)
    const at = Number(context.now) || nowMs()

    return this.enqueueGroup(groupId, async () => {
      const meta = await this.store.getMeta(groupId)
      if (meta.disabled) {
        return { status: 'ignored', written: 0, knowledgeEntries: [], workflowRules: [], aliasMappings: [], rejected: [{ reason: 'disabled' }] }
      }

      let [aliasDoc, knowledge, workflows] = await Promise.all([
        this.store.getAlias(groupId),
        this.store.getKnowledge(groupId),
        this.store.getWorkflows(groupId)
      ])
      const nextKnowledge = Array.isArray(knowledge) ? [...knowledge] : []
      const nextWorkflows = Array.isArray(workflows) ? [...workflows] : []
      let nextAliasDoc = { ...(aliasDoc || {}) }
      const knowledgeEntries = []
      const workflowRules = []
      const aliasMappings = []
      const rejected = []
      let knowledgeChanged = false
      let workflowsChanged = false
      let aliasesChanged = false

      for (const raw of Array.isArray(decision?.knowledgeEntries) ? decision.knowledgeEntries : []) {
        const kind = ['group_file', 'member_set', 'member_definition'].includes(raw?.kind || '') ? raw.kind : ''
        const subject = compactText(raw?.subject, 80)
        const subjectKey = compactText(raw?.subjectKey || normalizeSharedKey(subject), 120)
        const targetUserIds = uniqueNumericIds(raw?.targetUserIds)
        const resource = kind === 'group_file' && raw?.resource?.fileName
          ? {
              fileName: compactText(raw.resource.fileName, 180),
              fileId: compactText(raw.resource.fileId, 180),
              folderPath: compactText(raw.resource.folderPath, 240),
              origin: compactText(raw.resource.origin, 40)
            }
          : null
        if (!kind || !subject || !subjectKey || (kind === 'group_file' ? !resource : !targetUserIds.length)) {
          rejected.push({ kind: 'knowledge', subject, reason: 'invalid' })
          continue
        }
        const targetsById = new Map((Array.isArray(raw?.targets) ? raw.targets : []).map(item => [String(item?.userId || ''), item]))
        const entry = {
          id: '', kind, subject, subjectKey,
          aliases: [...new Set((Array.isArray(raw?.aliases) ? raw.aliases : [subject]).map(value => compactText(value, 80)).filter(Boolean))],
          ownerQQ: /^\d+$/.test(String(raw?.ownerQQ || '')) ? String(raw.ownerQQ) : '',
          ownerDisplay: compactText(raw?.ownerDisplay, 80),
          targetUserIds,
          targets: targetUserIds.map(userId => ({ userId, displayName: compactText(targetsById.get(userId)?.displayName || userId, 80) })),
          resource,
          sourceText: compactText(raw?.sourceText || context.text, 300),
          sourceMessageId,
          proposalId,
          createdBy: requesterQQ,
          at,
          updatedAt: at,
          enabled: raw?.enabled !== false
        }
        const index = nextKnowledge.findIndex(item => item?.kind === kind && item?.subjectKey === subjectKey &&
          (kind !== 'group_file' || String(item?.ownerQQ || '') === entry.ownerQQ))
        if (index >= 0) {
          const existing = nextKnowledge[index]!
          const sameTargets = sameIdList(existing?.targetUserIds, entry.targetUserIds)
          const sameResource = kind !== 'group_file' || String(existing?.resource?.fileId || existing?.resource?.fileName || '') === String(entry.resource?.fileId || entry.resource?.fileName || '')
          if (sameTargets && sameResource) {
            knowledgeEntries.push(existing)
            continue
          }
          if (!mayChangeSharedRecord(existing, requesterQQ, isGroupManager)) {
            rejected.push({ kind: 'knowledge', subject, reason: 'conflict' })
            continue
          }
          entry.id = String(existing.id || `knowledge_${nowMs().toString(36)}_${index}`)
          entry.at = Number(existing.at) || entry.at
          nextKnowledge[index] = entry
        } else {
          entry.id = `knowledge_${nowMs().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
          nextKnowledge.push(entry)
        }
        knowledgeChanged = true
        knowledgeEntries.push(entry)
      }

      for (const raw of Array.isArray(decision?.workflowRules) ? decision.workflowRules : []) {
        const condition = compactText(raw?.condition, 120)
        const conditionKey = compactText(raw?.conditionKey || normalizeSharedKey(condition), 160)
        const targetUserIds = uniqueNumericIds(raw?.targetUserIds)
        if (!condition || !conditionKey || !targetUserIds.length || raw?.kind !== 'mention_members') {
          rejected.push({ kind: 'workflow', condition, reason: 'invalid' })
          continue
        }
        if (!isGroupManager) {
          rejected.push({ kind: 'workflow', condition, reason: 'unauthorized' })
          continue
        }
        const targetsById = new Map((Array.isArray(raw?.targets) ? raw.targets : []).map(item => [String(item?.userId || ''), item]))
        const rule = {
          id: '', kind: 'mention_members', condition, conditionKey, targetUserIds,
          targets: targetUserIds.map(userId => ({ userId, displayName: compactText(targetsById.get(userId)?.displayName || userId, 80) })),
          sourceText: compactText(raw?.sourceText || context.text, 300), sourceMessageId, proposalId,
          createdBy: requesterQQ, at, updatedAt: at, enabled: raw?.enabled !== false
        }
        const index = nextWorkflows.findIndex(item => item?.kind === rule.kind && item?.conditionKey === rule.conditionKey)
        if (index >= 0) {
          const existing = nextWorkflows[index]!
          if (sameIdList(existing?.targetUserIds, rule.targetUserIds)) {
            workflowRules.push(existing)
            continue
          }
          // 管理员可更新任意工作流；普通成员在上面已经被拒绝。
          rule.id = String(existing.id || `wf_${nowMs().toString(36)}_${index}`)
          rule.at = Number(existing.at) || rule.at
          nextWorkflows[index] = rule
        } else {
          rule.id = `wf_${nowMs().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
          nextWorkflows.push(rule)
        }
        workflowsChanged = true
        workflowRules.push(rule)
      }

      for (const raw of Array.isArray(decision?.aliasMappings) ? decision.aliasMappings : []) {
        const alias = compactText(raw?.alias, 64)
        const targetQQ = String(raw?.targetUserId || raw?.targetQQ || '').trim()
        const key = normalizeAlias(alias)
        if (!alias || !key || !/^\d+$/.test(targetQQ)) {
          rejected.push({ kind: 'alias', alias, reason: 'invalid' })
          continue
        }
        const existing = nextAliasDoc[key]
        if (existing && String(existing.qq || '') === targetQQ) {
          aliasMappings.push({ alias, targetUserId: targetQQ, existing: true })
          continue
        }
        if (existing && !mayChangeSharedRecord(existing, requesterQQ, isGroupManager)) {
          rejected.push({ kind: 'alias', alias, reason: 'conflict' })
          continue
        }
        const res = upsertAlias(nextAliasDoc, {
          text: alias, qq: targetQQ, authority: 'teaching', confidence: 0.95,
          by: [requesterQQ], createdBy: requesterQQ, sourceMessageId, proposalId, at
        })
        if (!res.changed) {
          rejected.push({ kind: 'alias', alias, reason: 'protected' })
          continue
        }
        nextAliasDoc = res.doc
        aliasesChanged = true
        aliasMappings.push({ alias, targetUserId: targetQQ })
      }

      if (knowledgeChanged) {
        const max = Math.max(1, Number(this.config.maxGroupKnowledge) || 100)
        nextKnowledge.sort((a, b) => Number(b.updatedAt || b.at || 0) - Number(a.updatedAt || a.at || 0))
        await this.store.saveKnowledge(groupId, nextKnowledge.slice(0, max))
      }
      if (workflowsChanged) {
        const max = Math.max(1, Number(this.config.maxGroupWorkflows) || 50)
        nextWorkflows.sort((a, b) => Number(b.updatedAt || b.at || 0) - Number(a.updatedAt || a.at || 0))
        await this.store.saveWorkflows(groupId, nextWorkflows.slice(0, max))
      }
      if (aliasesChanged) await this.store.saveAlias(groupId, nextAliasDoc)

      const acceptedCount = knowledgeEntries.length + workflowRules.length + aliasMappings.length
      return {
        status: acceptedCount ? 'accepted' : (rejected.length ? 'rejected' : 'ignored'),
        written: Number(knowledgeChanged) + Number(workflowsChanged) + Number(aliasesChanged),
        knowledgeEntries, workflowRules, aliasMappings, rejected, proposalId, sourceMessageId
      }
    })
  }

  // ---- 明确教学的群工作流（兼容旧管理入口；新语义写入走 commitGroupMemoryDecision）----
  async upsertGroupWorkflowRules(groupId: MemoryId, rules: WorkflowRule[] = []) {
    if (!this.config.enabled || !Array.isArray(rules) || !rules.length) return { written: 0, rules: [] }
    return this.enqueueGroup(groupId, async () => {
      const meta = await this.store.getMeta(groupId)
      if (meta.disabled) return { written: 0, rules: [] }
      const existing = await this.store.getWorkflows(groupId)
      const next = Array.isArray(existing) ? [...existing] : []
      const saved = []
      for (const raw of rules) {
        const condition = compactText(raw?.condition, 120)
        const targetUserIds = [...new Set((Array.isArray(raw?.targetUserIds) ? raw.targetUserIds : [])
          .map(value => String(value || '').trim())
          .filter(value => /^\d+$/.test(value)))]
        if (!condition || !targetUserIds.length || raw?.kind !== 'mention_members') continue
        const conditionKey = compactText(raw?.conditionKey || condition.toLowerCase().replace(/[\s，,。；;：:！!？?、@]/g, ''), 160)
        if (!conditionKey) continue
        const targetsById = new Map((Array.isArray(raw?.targets) ? raw.targets : []).map(item => [String(item?.userId || ''), item]))
        const targets = targetUserIds.map(userId => ({
          userId,
          displayName: compactText(targetsById.get(userId)?.displayName || userId, 80)
        }))
        const rule = {
          id: '',
          kind: 'mention_members',
          condition,
          conditionKey,
          targetUserIds,
          targets,
          sourceText: compactText(raw?.sourceText, 300),
          sourceMessageId: String(raw?.sourceMessageId || ''),
          createdBy: String(raw?.createdBy || ''),
          at: Number(raw?.at) || nowMs(),
          updatedAt: nowMs(),
          enabled: raw?.enabled !== false
        }
        const index = next.findIndex(item => item?.kind === rule.kind && item?.conditionKey === rule.conditionKey)
        if (index >= 0) {
          rule.id = String(next[index]!.id || `wf_${nowMs().toString(36)}_${index}`)
          rule.at = Number(next[index]!.at) || rule.at
          next[index] = rule
        } else {
          rule.id = `wf_${nowMs().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
          next.push(rule)
        }
        saved.push(rule)
      }
      const max = Math.max(1, Number(this.config.maxGroupWorkflows) || 50)
      next.sort((a, b) => Number(b.updatedAt || b.at || 0) - Number(a.updatedAt || a.at || 0))
      await this.store.saveWorkflows(groupId, next.slice(0, max))
      return { written: saved.length, rules: saved }
    })
  }

  async getGroupWorkflowRules(groupId: MemoryId) {
    if (!this.config.enabled) return []
    const meta = await this.store.getMeta(groupId)
    if (meta.disabled) return []
    return this.store.getWorkflows(groupId)
  }

  async getGroupWorkflowPrompt(groupId: MemoryId, message: string) {
    const rules = await this.getGroupWorkflowRules(groupId)
    const relevant = selectRelevantGroupWorkflowRules(rules, message, this.config.workflowPromptMaxRules)
    return formatGroupWorkflowExecutionPrompt(relevant, message)
  }

  // ---- 明确教学的群知识（成员定义、成员组、群文件关系）----
  async upsertGroupKnowledgeEntries(groupId: MemoryId, entries: KnowledgeEntry[] = []) {
    if (!this.config.enabled || !Array.isArray(entries) || !entries.length) return { written: 0, entries: [] }
    return this.enqueueGroup(groupId, async () => {
      const meta = await this.store.getMeta(groupId)
      if (meta.disabled) return { written: 0, entries: [] }
      const existing = await this.store.getKnowledge(groupId)
      const next = Array.isArray(existing) ? [...existing] : []
      const saved = []
      for (const raw of entries) {
        const kind = ['group_file', 'member_set', 'member_definition'].includes(raw?.kind || '') ? raw.kind : ''
        const subject = compactText(raw?.subject, 80)
        const subjectKey = compactText(raw?.subjectKey || subject.toLowerCase().replace(/[\s，,。；;：:！!？?、@]/g, ''), 120)
        if (!kind || !subject || !subjectKey) continue
        const targetUserIds = [...new Set((Array.isArray(raw?.targetUserIds) ? raw.targetUserIds : [])
          .map(value => String(value || '').trim()).filter(value => /^\d+$/.test(value)))]
        const resource = kind === 'group_file' && raw?.resource?.fileName
          ? {
              fileName: compactText(raw.resource.fileName, 180),
              fileId: compactText(raw.resource.fileId, 180),
              folderPath: compactText(raw.resource.folderPath, 240),
              origin: compactText(raw.resource.origin, 40)
            }
          : null
        if (kind === 'group_file' && !resource) continue
        if (kind !== 'group_file' && !targetUserIds.length) continue
        const targetsById = new Map((Array.isArray(raw?.targets) ? raw.targets : []).map(item => [String(item?.userId || ''), item]))
        const targets = targetUserIds.map(userId => ({ userId, displayName: compactText(targetsById.get(userId)?.displayName || userId, 80) }))
        const aliases = [...new Set((Array.isArray(raw?.aliases) ? raw.aliases : [subject])
          .map(value => compactText(value, 80)).filter(Boolean))]
        const entry = {
          id: '', kind, subject, subjectKey, aliases,
          ownerQQ: /^\d+$/.test(String(raw?.ownerQQ || '')) ? String(raw.ownerQQ) : '',
          ownerDisplay: compactText(raw?.ownerDisplay, 80),
          targetUserIds, targets, resource,
          sourceText: compactText(raw?.sourceText, 300),
          sourceMessageId: String(raw?.sourceMessageId || ''),
          createdBy: String(raw?.createdBy || ''),
          at: Number(raw?.at) || nowMs(), updatedAt: nowMs(), enabled: raw?.enabled !== false
        }
        // File ownership definitions can coexist by owner; member/role definitions replace the same named subject.
        const index = next.findIndex(item => item?.kind === kind && item?.subjectKey === subjectKey &&
          (kind !== 'group_file' || String(item?.ownerQQ || '') === entry.ownerQQ))
        if (index >= 0) {
          entry.id = String(next[index]!.id || `knowledge_${nowMs().toString(36)}_${index}`)
          entry.at = Number(next[index]!.at) || entry.at
          next[index] = entry
        } else {
          entry.id = `knowledge_${nowMs().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
          next.push(entry)
        }
        saved.push(entry)
      }
      const max = Math.max(1, Number(this.config.maxGroupKnowledge) || 100)
      next.sort((a, b) => Number(b.updatedAt || b.at || 0) - Number(a.updatedAt || a.at || 0))
      await this.store.saveKnowledge(groupId, next.slice(0, max))
      return { written: saved.length, entries: saved }
    })
  }

  async getGroupKnowledgeEntries(groupId: MemoryId) {
    if (!this.config.enabled) return []
    const meta = await this.store.getMeta(groupId)
    if (meta.disabled) return []
    return this.store.getKnowledge(groupId)
  }

  async getGroupKnowledgePrompt(groupId: MemoryId, { speakerQQ = '', message = '' } = {}) {
    const entries = await this.getGroupKnowledgeEntries(groupId)
    const relevant = selectRelevantGroupKnowledge(entries, { text: message, speakerQQ, limit: this.config.knowledgePromptMaxEntries })
    return formatGroupKnowledgePrompt(relevant, { speakerQQ })
  }

  async interpretGroupKnowledgeInstruction(context: Record<string, unknown> & { memberMap?: Map<unknown, GroupMember>; text?: string; messageSegments?: Record<string, unknown>[]; creatorQQ?: MemoryId } = {}) {
    if (!this.extractor.canUse()) return { status: 'unavailable', knowledgeEntries: [], workflowRules: [], aliasMappings: [] }
    const members = membersFromContext(context.memberMap, context)
    const files = (Array.isArray(context.fileAssets) ? context.fileAssets : [])
      .map(asset => compactText(asset?.fileName || asset?.name || '', 180))
      .filter(Boolean)
    const prompt = [
      `发言者：QQ:${context.creatorQQ || ''}，群名片：${context.creatorDisplay || '未知'}`,
      `机器人 QQ:${context.botId || ''}`,
      `原话：${compactText(context.text, 500)}`,
      `当前群成员候选：${members.map(member => `${member.displayName}(QQ:${member.userId})`).join('；') || '无'}`,
      `当前消息可见群文件：${files.join('；') || '无'}`,
      '你是群共享状态写入裁决器。先理解说话人此刻是否明确要求机器人保存可供以后回答或执行的稳定群内状态；只有明确要求保存时才输出条目，否则输出 []。',
      '创作故事、给小说分配角色、跑团设定、临时任务、闲聊、解释内容、引用别人或机器人说过的话，都不是长期知识教学。即使原话里出现“记住了”，只要那是转述、引用或机器人回复，也输出 []。不要把角色列表或“甲和乙”合成一条关系。',
      '若确实要求保存，把每个独立关系拆成一个原子条目。只输出 JSON 数组：别名字段 kind(alias)、alias、targetNames；成员关系字段 kind(member_definition/member_set)、subject、owner(speaker/bot/QQ号/空)、targetNames；群文件字段 kind(group_file)、subject、owner、resourceFileName；通知规则字段 kind(workflow)、condition、targetNames。targetNames 和 resourceFileName 必须逐字使用候选。',
      '“我/我的/本人”指发言者；“你/你的/希洛”指机器人。不得编造成员、文件、关系或保存意图。'
    ].join('\n')
    try {
      const raw = await this.extractor._callChat([
        { role: 'system', content: '你是群知识语义裁决器，只输出严格 JSON 数组，不解释。' },
        { role: 'user', content: prompt }
      ], Math.max(100, Number(this.config.knowledgeDecisionMaxTokens) || 400), {
        timeoutMs: this.config.knowledgeDecisionTimeoutMs
      })
      const result = parseSemanticGroupMemoryOutput(raw, context)
      return {
        status: result.knowledgeEntries.length || result.workflowRules.length || result.aliasMappings.length ? 'accepted' : 'ignored',
        ...result
      }
    } catch {
      return { status: 'unavailable', knowledgeEntries: [], workflowRules: [], aliasMappings: [] }
    }
  }

  // §0.4 query 向量：embeddings 可用且 query 非空时算一次，否则 null。失败/未启用 → null。
  async _queryEmbedding(query: string) {
    if (!this.embeddings.canUse() || !String(query || '').trim()) return null
    const emb = await this.embeddings.embed(query)
    return Array.isArray(emb) ? emb : null
  }

  // 把某实体的 active facts 用 _rankEntityFacts 预排序+截断后，返回带新 facts 的浅拷贝实体。
  // 实体为空则原样返回（保持 null）。retriever 只消费这份已排序好的 facts。
  _rankEntityForPrompt(entity: MemoryEntity | null | undefined, query: string, queryEmb: number[] | null) {
    if (!entity) return entity
    const ranked = this._rankEntityFacts(entity.facts, query, queryEmb)
    return { ...entity, facts: ranked }
  }

  // §0.4 实体事实排序：
  // - queryEmb 且 facts 有 embedding → 按 cosine 降序；否则按 confidence desc, at desc。
  // - 身份锚点保护：当存在"严格高于其余所有事实"的最高 authority 事实时，强制把它提到最前
  //   （避免语义排序把身份/config 事实挤掉）。authority 全相同时不锚定，保留纯语义/置信度顺序。
  // - 取前 config.promptMaxEntityFacts（默认 6）。
  _rankEntityFacts(facts: Fact[], query: string, queryEmb: number[] | null) {
    const active = (facts || []).filter(f => f && !f.superseded && f.text)
    if (!active.length) return []

    const useEmbedding = Array.isArray(queryEmb) && active.some(f => Array.isArray(f.embedding))
    let sorted
    if (useEmbedding) {
      sorted = [...active]
        .map(f => ({ f, score: Array.isArray(f.embedding) ? cosineSimilarity(queryEmb, f.embedding) : -1 }))
        .sort((a, b) => b.score - a.score)
        .map(({ f }) => f)
    } else {
      sorted = [...active].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || (b.at ?? 0) - (a.at ?? 0))
    }

    // 身份锚点：仅在最高 authority 严格高于其余所有事实时置顶。
    const anchor = this._identityAnchorFact(active)
    if (anchor) {
      sorted = [anchor, ...sorted.filter(f => f !== anchor)]
    }

    const limit = Number.isFinite(this.config.promptMaxEntityFacts) ? this.config.promptMaxEntityFacts : 6
    return sorted.slice(0, Math.max(0, limit))
  }

  // 身份锚点：当且仅当存在唯一最高 authority 层级（严格高于次高层级）时，返回该层级中最强的一条；
  // 否则返回 null（authority 全相同 → 不锚定，纯语义/置信度排序）。
  _identityAnchorFact(facts: Fact[]) {
    const top = this._highestAuthorityFact(facts)
    if (!top) return null
    const topRank = authorityRank(top.authority)
    const hasLower = facts.some(f => (authorityRank(f.authority) ?? 0) < topRank)
    return hasLower ? top : null
  }

  // 取一组 facts 中 authority 最高的一条（并列时取 confidence 更高、其次 at 更新者）。
  _highestAuthorityFact(facts: Fact[]) {
    let best = null
    let bestRank = -1
    for (const f of facts) {
      const rank = authorityRank(f.authority) ?? 0
      if (rank > bestRank) { best = f; bestRank = rank; continue }
      if (rank === bestRank && best) {
        if ((f.confidence ?? 0) > (best.confidence ?? 0) || ((f.confidence ?? 0) === (best.confidence ?? 0) && (f.at ?? 0) > (best.at ?? 0))) {
          best = f
        }
      }
    }
    return best
  }

  // 遍历所有实体的 facts，收集 refs 命中说话人/被提及人的活跃 fact（排除目标实体自身的 fact）。
  _collectRefsFacts(entities: EntityMap, relevantQQs: Set<string>) {
    const out = []
    for (const [qq, entity] of Object.entries(entities || {})) {
      if (relevantQQs.has(qq)) continue
      for (const f of entity.facts || []) {
        if (f.superseded) continue
        if ((f.refs || []).some(ref => relevantQQs.has(String(ref)))) out.push(f)
      }
    }
    return out
  }

  // 群事实排序：queryEmb 存在（§0.4 复用同一 query 向量）→ cosine(queryEmb, fact.embedding) 排序取前 N；
  // 否则原样返回活跃 facts，交给 retriever 现有排序。
  _rankGroupFacts(facts: Fact[], queryEmb: number[] | null) {
    const active = (facts || []).filter(f => f && !f.superseded && f.text)
    if (!Array.isArray(queryEmb)) return active
    const limit = Number.isFinite(this.config.promptMaxGroupFacts) ? this.config.promptMaxGroupFacts : 6
    return [...active]
      .map(f => ({ f, score: Array.isArray(f.embedding) ? cosineSimilarity(queryEmb, f.embedding) : -1 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, limit))
      .map(({ f }) => f)
  }

  // 收集 eventAt 落在 [now - after*天, now + before*天] 的活跃 fact（仅 proactiveCallback 开启时）。
  _collectPendingFacts(entityList: (MemoryEntity | null | undefined)[], now: number) {
    if (!this.config.proactiveCallback) return []
    const before = (Number.isFinite(this.config.proactiveWindowDaysBefore) ? this.config.proactiveWindowDaysBefore : 3) * DAY_MS
    const after = (Number.isFinite(this.config.proactiveWindowDaysAfter) ? this.config.proactiveWindowDaysAfter : 7) * DAY_MS
    const lo = now - after
    const hi = now + before
    const out = []
    for (const entity of entityList) {
      for (const f of entity?.facts || []) {
        if (f.superseded || !Number.isFinite(f.eventAt)) continue
        if (Number(f.eventAt) >= lo && Number(f.eventAt) <= hi) out.push(f)
      }
    }
    return out
  }

  // ---- 注入（保留旧签名）----
  async getMemoryPromptForUser(groupId: MemoryId, userId: MemoryId, query = '') {
    if (!this.config.enabled) return ''
    const meta = await this.store.getMeta(groupId)
    if (meta.disabled) return ''
    const entities = await this.store.getEntities(groupId)
    return buildEntityPrompt(entities[String(userId)] || null, this.config.promptMaxChars)
  }

  async getGroupMemoryPrompt(groupId: MemoryId, query = '') {
    if (!this.config.enabled) return ''
    const meta = await this.store.getMeta(groupId)
    if (meta.disabled) return ''
    const facts = await this.store.getFacts(groupId)
    return buildGroupFactsPrompt(facts, query, this.config.promptMaxGroupFacts, this.config.promptMaxChars)
  }

  async getGroupAliasPrompt(groupId: MemoryId, query = '') {
    if (!this.config.enabled) return ''
    const meta = await this.store.getMeta(groupId)
    if (meta.disabled) return ''
    const aliasDoc = await this.store.getAlias(groupId)
    return buildAliasPrompt(aliasDoc, query, this.config.promptMaxChars)
  }

  // ---- 显式教学直喂别名表（替代旧 addGroupMemory(...,"member")）----
  async addAliasMapping(groupId: MemoryId, { alias, targetQQ, by, createdBy = '', sourceMessageId = '', proposalId = '', confidence = 0.95 }: { alias?: string; targetQQ?: MemoryId; by?: string[]; createdBy?: string; sourceMessageId?: string; proposalId?: string; confidence?: number }) {
    if (!alias || !targetQQ) return { written: 0 }
    return this.applyOps(groupId, [{ stream: 'alias', qq: String(targetQQ), text: compactText(alias, 64), authority: 'teaching', confidence: clamp(confidence), by: (by || []).map(String), createdBy: String(createdBy || by?.[0] || ''), sourceMessageId: String(sourceMessageId || ''), proposalId: String(proposalId || sourceMessageId || ''), at: nowMs() }])
  }

  // ---- config seed（identityBindings / userProfiles -> 实体）----
  async seedFromConfig(groupId: MemoryId, bindings: { qq?: MemoryId; name?: string; aliases?: string[]; notes?: string }[] = []) {
    const ops: Operation[] = []
    for (const b of bindings) {
      if (!b?.qq) continue
      for (const alias of [b.name, ...(b.aliases || [])].filter(Boolean)) {
        ops.push({ stream: 'alias', qq: String(b.qq), text: compactText(alias, 64), authority: 'config', confidence: 1, by: [], at: nowMs() })
      }
      if (b.notes) ops.push({ stream: 'entityFact', qq: String(b.qq), authority: 'config', fact: makeFact({ text: b.notes, tags: ['备注'], authority: 'config', confidence: 1, at: nowMs() }) })
    }
    return this.applyOps(groupId, ops)
  }

  // ---- 抽取入口（用户 + 群，后台 fire-and-forget）----
  // 用户记忆抽取:防抖 + 批量缓冲。同一用户的连续发言先攒到 buffer,
  // 静默 userExtractDebounceSeconds 后或攒满 userExtractMaxBatchMessages 时,一次性抽取,
  // 避免每条消息都打一次 LLM。
  async extractAndSaveMemories(groupId: MemoryId, userId: MemoryId, userMessage: string, _botReply = '', meta: MemoryExtractionMeta = {}) {
    if (!this.config.enabled) return { queued: false }
    await this.restorePendingExtractions(groupId)
    if ((await this.store.getMeta(groupId)).disabled) return {queued:false,reason:'disabled'}

    // §0.2 写入侧 opt-out：用户在 optedOut → 不缓冲不抽取（隐私）。同步查缓存，惰性预热。
    if (this._isOptedOut(groupId, userId)) {
      memStats.inc('extract.user.optedOut')
      return { queued: false, reason: 'opted-out' }
    }

    if (classifyBoundary(userMessage).verdict === 'drop') {
      memStats.inc('extract.boundary.drop')
      return { queued: false, reason: 'boundary' }
    }

    const at = finiteTimestamp(meta.at) ?? nowMs()
    const key = JSON.stringify([String(groupId),String(userId),personaSourceKey(meta.personaSource),memoryDate(at)])
    if (!this.userBuffers.has(key) && this._pendingBatchCount(groupId) >= this._pendingBatchLimit()) return {queued:false,reason:'pending-batches-full'}
    const buf = this.userBuffers.get(key) || this._createExtractionBuffer(groupId,userId,meta)
    const pendingLimit = Math.max(1,Math.min(500,Number(this.config.extractPendingMaxMessages) || 60))
    if (buf.messages.length >= pendingLimit || buf.retryExhausted) {
      memStats.inc('extract.user.pending-rejected')
      return {queued:false,reason:buf.retryExhausted ? 'retry-exhausted' : 'pending-full',buffered:buf.messages.length}
    }
    // Keep the actual utterance, including long quoted text and its source clock.
    // Pending input must survive a restart without a second lossy summary.
    buf.messages.push({content:userMessage,at,source:'user'})
    this.userBuffers.set(key, buf)
    try { await this._persistPendingExtractions(groupId) }
    catch { return this._retainFailedExtraction('user',key,buf,'pending-store') }

    const maxBatch = Math.max(1, Number(this.config.userExtractMaxBatchMessages) || 6)
    if (buf.messages.length >= maxBatch) {
      return this._flushUserBuffer(key)
    }

    if (buf.retryAt) return {queued:true,reason:'retry-wait',buffered:buf.messages.length,nextRetryAt:buf.retryAt}
    if (buf.running) return {queued:true,reason:'in-flight',buffered:buf.messages.length}
    const debounceMs = Math.max(0, Number(this.config.userExtractDebounceSeconds) || 0) * 1000
    if (debounceMs > 0) {
      this._scheduleExtractionBuffer('user',key,buf,debounceMs)
    } else {
      // 防抖关闭 → 退化为即时抽取
      return this._flushUserBuffer(key)
    }
    memStats.inc('extract.user.buffered')
    return { queued: true, buffered: buf.messages.length }
  }

  _createExtractionBuffer(groupId:MemoryId,userId:MemoryId,meta:MemoryExtractionMeta):ExtractionBuffer {
    const personaSource = normalizePersonaSource(meta.personaSource)
    return {groupId,userId,messages:[],timer:null,heardFrom:compactText(personaSource?.personaName || meta.heardFrom,24),...(personaSource ? {personaSource} : {}),attempts:0,retryAt:0,retryExhausted:false,running:false}
  }

  _pendingBatchCount(groupId:MemoryId) {
    return [...this.userBuffers.values(),...this.groupBuffers.values()].filter(buf => String(buf.groupId) === String(groupId)).length
  }

  _pendingBatchLimit() {
    return Math.max(1,Math.min(1000,Number(this.config.extractPendingMaxBatches) || 200))
  }

  _privacySafeGroupMessages(messages:MemoryExtractionMessage[],optedOut:string[]) {
    const excluded = new Set(optedOut)
    if (!excluded.size) return messages
    // Old group batches did not record authors. Forward/quote authorQQ identifies
    // the sender of the envelope, never the people inside it. With any opt-out,
    // unknown original authors cannot safely be sent to the extraction model.
    return messages.filter(message => message.source !== 'forward' && message.source !== 'quote'
      && typeof message.authorQQ === 'string' && Boolean(message.authorQQ.trim()) && !excluded.has(message.authorQQ.trim()))
  }

  /** Restore only a known group. No Redis-wide scan or model call is required. */
  restorePendingExtractions(groupId:MemoryId):Promise<void> {
    const groupKey = String(groupId)
    const existing = this.pendingRestoreTasks.get(groupKey)
    if (existing) return existing
    const task = this.enqueueGroup(groupId,async () => {
      const [pending,meta] = await Promise.all([this.store.getPendingExtractions(groupId),this.store.getMeta(groupId)])
      this.optedOutCache.set(groupKey,new Set(meta.optedOut))
      for (const raw of pending) {
        const entry = memoryRecord(raw)
        if ((entry.kind !== 'user' && entry.kind !== 'group') || typeof entry.key !== 'string' || String(entry.groupId) !== groupKey || !Array.isArray(entry.messages)) {
          memStats.inc('extract.pending.invalid')
          continue
        }
        const kind = entry.kind
        const userId = String(entry.userId || '')
        if (meta.disabled || (kind === 'user' && meta.optedOut.includes(userId))) continue
        const restoredMessages = entry.messages.flatMap(rawMessage => {
          const row = memoryRecord(rawMessage)
          if (typeof row.content !== 'string') return []
          const at = finiteTimestamp(row.at)
          return [{content:row.content,...(at !== undefined ? {at} : {}),...(typeof row.role === 'string' ? {role:row.role} : {}),...(typeof row.source === 'string' ? {source:row.source} : {}),...(typeof row.authorQQ === 'string' ? {authorQQ:row.authorQQ} : {})}]
        })
        const messages = kind === 'group' ? this._privacySafeGroupMessages(restoredMessages,meta.optedOut) : restoredMessages
        if (!messages.length) continue
        const personaSource = normalizePersonaSource(entry.personaSource)
        const key = kind === 'user'
          ? JSON.stringify([groupKey,userId,personaSourceKey(personaSource),memoryDate(finiteTimestamp(messages[0]?.at) ?? 0)])
          : JSON.stringify([groupKey,personaSourceKey(personaSource)])
        const buffers = kind === 'user' ? this.userBuffers : this.groupBuffers
        const buf = this._createExtractionBuffer(groupId,userId,{heardFrom:typeof entry.heardFrom === 'string' ? entry.heardFrom : '',...(personaSource ? {personaSource} : {})})
        buf.messages = messages
        buf.attempts = typeof entry.attempts === 'number' && Number.isInteger(entry.attempts) ? Math.max(0,entry.attempts) : 0
        buf.retryAt = finiteTimestamp(entry.retryAt) ?? 0
        buf.retryExhausted = entry.retryExhausted === true || buf.attempts >= Math.max(1,Math.min(6,Number(this.config.extractRetryMaxAttempts) || 3))
        if (typeof entry.lastFailure === 'string') buf.lastFailure = entry.lastFailure
        const live = buffers.get(key)
        if (live) buf.messages.push(...live.messages)
        buffers.set(key,buf)
        if (!buf.retryExhausted && buf.lastFailure !== 'unconfigured') {
          const delay = buf.retryAt > 0 ? Math.max(1,buf.retryAt - nowMs()) : Math.max(1,Number(this.config.userExtractDebounceSeconds) || 0)*1000
          this._scheduleExtractionBuffer(kind,key,buf,delay)
        }
      }
      if (meta.disabled || meta.optedOut.length) await this._savePendingExtractions(groupId)
    })
    this.pendingRestoreTasks.set(groupKey,task)
    task.catch(() => { if (this.pendingRestoreTasks.get(groupKey) === task) this.pendingRestoreTasks.delete(groupKey) })
    return task
  }

  // Called under enqueueGroup; never recursively enqueue the same group.
  _savePendingExtractions(groupId:MemoryId) {
    const pending:PendingMemoryExtraction[] = []
    for (const [kind,buffers] of [['user',this.userBuffers],['group',this.groupBuffers]] as const) {
      for (const [key,buf] of buffers) {
        if (String(buf.groupId) !== String(groupId) || !buf.messages.length) continue
        pending.push({key,kind,groupId:String(groupId),userId:String(buf.userId || ''),messages:buf.messages.map(message => ({...message})),heardFrom:buf.heardFrom,...(buf.personaSource ? {personaSource:buf.personaSource} : {}),attempts:buf.attempts,retryAt:buf.retryAt,retryExhausted:buf.retryExhausted,...(buf.lastFailure ? {lastFailure:buf.lastFailure} : {})})
      }
    }
    return this.store.savePendingExtractions(groupId,pending)
  }

  async _persistPendingExtractions(groupId:MemoryId) {
    await this.restorePendingExtractions(groupId)
    return this.enqueueGroup(groupId,() => this._savePendingExtractions(groupId))
  }

  _discardPendingExtractions(groupId:MemoryId,userId?:MemoryId) {
    for (const buffers of [this.userBuffers,this.groupBuffers]) {
      for (const [key,buf] of buffers) {
        if (String(buf.groupId) !== String(groupId) || (userId !== undefined && buf.userId && String(buf.userId) !== String(userId))) continue
        if (buf.timer) clearTimeout(buf.timer)
        buffers.delete(key)
      }
    }
  }

  _scheduleExtractionBuffer(kind:'user'|'group',key:string,buf:ExtractionBuffer,delayMs:number):void {
    if (buf.timer) clearTimeout(buf.timer)
    buf.timer = setTimeout(() => {
      buf.timer = null
      this._flushExtractionBuffer(kind,key).catch(() => ports.logger?.warn?.('[Memory] 抽取重试失败'))
    },Math.max(1,delayMs))
    buf.timer.unref?.()
  }

  /** Also used when a caller resumes a due batch; never exceeds the retry limit. */
  async retryPendingExtractions({now = nowMs(),groupId}:{now?:number;groupId?:MemoryId} = {}) {
    if (groupId !== undefined) await this.restorePendingExtractions(groupId)
    const results = []
    for (const [kind,buffers] of [['user',this.userBuffers],['group',this.groupBuffers]] as const) {
      for (const [key,buf] of buffers) {
        if ((groupId === undefined || String(buf.groupId) === String(groupId)) && !buf.running && !buf.retryExhausted && buf.retryAt <= now) results.push(await this._flushExtractionBuffer(kind,key,now))
      }
    }
    return results
  }

  // §0.2 同步判断用户是否 opt-out（读进程内缓存）。未知群 → 视为未 opt-out，并惰性后台预热缓存。
  _isOptedOut(groupId: MemoryId, userId: MemoryId) {
    const cached = this.optedOutCache.get(String(groupId))
    if (cached) return cached.has(String(userId))
    this._warmOptedOutCache(groupId)
    return false
  }

  // 后台读 meta.optedOut 填充缓存（fire-and-forget；失败静默）。
  _warmOptedOutCache(groupId: MemoryId) {
    if (this.optedOutCache.has(String(groupId))) return
    // 先占位空集合，避免并发重复预热。
    this.optedOutCache.set(String(groupId), new Set())
    Promise.resolve()
      .then(() => this.store.getMeta(groupId))
      .then(meta => this.optedOutCache.set(String(groupId), new Set((meta.optedOut || []).map(String))))
      .catch(() => {})
  }

  async _flushUserBuffer(key: string) {
    return this._flushExtractionBuffer('user',key)
  }

  async _flushExtractionBuffer(kind:'user'|'group',key:string,retryClock = nowMs()):Promise<{written:number;status:string;error?:boolean;reason?:string;nextRetryAt?:number;retryExhausted?:boolean}> {
    const buffers = kind === 'user' ? this.userBuffers : this.groupBuffers
    const buf = buffers.get(key)
    if (!buf || !buf.messages.length) return {written:0,status:'skipped',reason:'empty'}
    if (buf.running) return {written:0,status:'pending',reason:'in-flight'}
    if (buf.retryExhausted) return {written:0,status:'failed',reason:'retry-exhausted',retryExhausted:true}
    if (buf.retryAt > retryClock) return {written:0,status:'pending',reason:'retry-wait',nextRetryAt:buf.retryAt}
    if (buf.timer) clearTimeout(buf.timer)
    buf.timer = null
    buf.running = true
    let messages:MemoryExtractionMessage[] = []
    try {
      // Persist captured input before making a model request. A crash during
      // transport leaves the original utterances available for bounded replay.
      await this._persistPendingExtractions(buf.groupId)
      const storedMeta = await this.store.getMeta(buf.groupId)
      if (buffers.get(key) !== buf) return {written:0,status:'skipped',reason:'cancelled'}
      if (!this.config.enabled || storedMeta.disabled || (kind === 'user' && storedMeta.optedOut.includes(String(buf.userId)))) {
        buffers.delete(key)
        await this._persistPendingExtractions(buf.groupId)
        return {written:0,status:'skipped',reason:'disabled'}
      }
      if (kind === 'group') {
        const allowed = this._privacySafeGroupMessages(buf.messages,storedMeta.optedOut)
        if (allowed.length !== buf.messages.length) {
          buf.messages = allowed
          if (!allowed.length) buffers.delete(key)
          await this._persistPendingExtractions(buf.groupId)
          if (!allowed.length) return {written:0,status:'skipped',reason:'opted-out'}
          if (buffers.get(key) !== buf) return {written:0,status:'skipped',reason:'cancelled'}
        }
      }
      messages = buf.messages.slice()
      memStats.inc(`extract.${kind}.flushed`)
      const extracted = await this.extractor.extract({groupId:buf.groupId,speakerQQ:kind === 'user' ? String(buf.userId) : '',messages,at:finiteTimestamp(messages[0]?.at) ?? nowMs()})
      // Older injected extractors return arrays. Production extractors always
      // return a discriminated outcome, including a genuine empty success.
      const outcome:MemoryExtractionResult = Array.isArray(extracted) ? {status:'success',ops:extracted} : extracted
      if (buffers.get(key) !== buf) return {written:0,status:'skipped',reason:'cancelled'}
      if (outcome.status === 'skipped') {
        return await this.enqueueGroup(buf.groupId,async () => {
          if (buffers.get(key) !== buf) return {written:0,status:'skipped',reason:'cancelled'}
          buf.retryAt = 0
          buf.lastFailure = outcome.reason
          await this._savePendingExtractions(buf.groupId)
          await this._saveExtractOutcome(buf.groupId,'skipped',{reason:outcome.reason})
          return {written:0,status:'skipped',reason:outcome.reason}
        })
      }
      if (outcome.status === 'failed') return await this._retainFailedExtraction(kind,key,buf,outcome.reason)
      const safe = kind === 'group' ? outcome.ops.filter(op => op.stream === 'groupFact') : outcome.ops
      const ops = safe.map(op => 'fact' in op ? {...op,fact:{...op.fact,...(buf.heardFrom ? {heardFrom:buf.heardFrom} : {}),...(buf.personaSource ? {personaSource:buf.personaSource} : {})}} : op)
      const result = await this.applyOps(buf.groupId,ops,{isCurrent:() => buffers.get(key) === buf})
      // Remove only the captured input. New utterances arriving during the LLM
      // call remain queued and cannot be lost on either completion or failure.
      return await this.enqueueGroup(buf.groupId,async () => {
        if (buffers.get(key) !== buf) return {written:0,status:'skipped',reason:'cancelled'}
        const remaining = buf.messages.slice(messages.length)
        const previous = {attempts:buf.attempts,retryAt:buf.retryAt,lastFailure:buf.lastFailure}
        buf.messages = remaining
        buf.attempts = 0
        buf.retryAt = 0
        delete buf.lastFailure
        try {
          await this._savePendingExtractions(buf.groupId)
          await this._saveExtractOutcome(buf.groupId,'success')
        } catch (error) {
          // Requeue the committed facts on a failed acknowledgement; fact writes
          // already deduplicate on replay, so this remains at-least-once.
          buf.messages = [...messages,...buf.messages]
          buf.attempts = previous.attempts
          buf.retryAt = previous.retryAt
          if (previous.lastFailure) buf.lastFailure = previous.lastFailure
          throw error
        }
        if (!buf.messages.length) buffers.delete(key)
        else this._scheduleExtractionBuffer(kind,key,buf,Math.max(1,Number(this.config.userExtractDebounceSeconds) || 0)*1000)
        if (kind === 'group') this.lastGroupExtractAt.set(key,nowMs())
        return {...result,status:'success'}
      })
    } catch {
      return await this._retainFailedExtraction(kind,key,buf,'transport-or-store')
    } finally {
      buf.running = false
    }
  }

  async _retainFailedExtraction(kind:'user'|'group',key:string,buf:ExtractionBuffer,reason:string) {
    const buffers = kind === 'user' ? this.userBuffers : this.groupBuffers
    return this.enqueueGroup(buf.groupId,async () => {
      if (buffers.get(key) !== buf) return {written:0,status:'skipped',reason:'cancelled'}
      buf.attempts += 1
      buf.lastFailure = reason
      const maxAttempts = Math.max(1,Math.min(6,Number(this.config.extractRetryMaxAttempts) || 3))
      buf.retryExhausted = buf.attempts >= maxAttempts
      const delay = Math.min(300000,Math.max(1000,Number(this.config.extractRetryBaseMs) || 15000) * 2 ** Math.max(0,buf.attempts - 1))
      buf.retryAt = buf.retryExhausted ? 0 : nowMs() + delay
      if (!buf.retryExhausted) this._scheduleExtractionBuffer(kind,key,buf,delay)
      memStats.inc(`extract.${kind}.failed`)
      ports.logger?.warn?.(`[Memory] ${kind} extraction ${reason}; attempt=${buf.attempts}; ${buf.retryExhausted ? 'retry-exhausted' : 'retry-scheduled'}`)
      try {
        await this._savePendingExtractions(buf.groupId)
        await this._saveExtractOutcome(buf.groupId,'failed',{reason,nextRetryAt:buf.retryAt})
      } catch {
        memStats.inc('extract.pending.store-failed')
        ports.logger?.warn?.('[Memory] 待抽取队列持久化失败；本进程保留待处理原文')
      }
      return {written:0,status:'failed',error:true,reason,nextRetryAt:buf.retryAt,retryExhausted:buf.retryExhausted}
    })
  }

  // Only extraction outcomes update extraction status. Failure metadata is
  // durable alongside the original input and bounded-retry queue.
  _recordExtractOutcome(groupId: MemoryId, outcome:boolean|'success'|'failed'|'skipped', options:{reason?:string;nextRetryAt?:number} = {}) {
    return this.enqueueGroup(groupId,() => this._saveExtractOutcome(groupId,outcome,options)).catch(() => {})
  }

  async _saveExtractOutcome(groupId:MemoryId,outcome:boolean|'success'|'failed'|'skipped',options:{reason?:string;nextRetryAt?:number} = {}) {
      const meta = await this.store.getMeta(groupId)
      const status = typeof outcome === 'boolean' ? outcome ? 'success' : 'failed' : outcome
      const next = status === 'success'
        ? {...meta,lastExtractAt:nowMs(),lastExtractAttemptAt:nowMs(),lastExtractStatus:status,lastExtractFailure:'',nextRetryAt:0,failureCount:0}
        : status === 'failed'
          ? {...meta,lastExtractAttemptAt:nowMs(),lastExtractStatus:status,lastExtractFailure:options.reason || 'failed',nextRetryAt:options.nextRetryAt || 0,failureCount:(Number(meta.failureCount) || 0) + 1}
          : {...meta,lastExtractAttemptAt:nowMs(),lastExtractStatus:status,lastExtractFailure:options.reason || 'skipped'}
      await this.store.saveMeta(groupId, next)
  }

  // 群记忆抽取:最小间隔节流。距上次该群抽取不足 groupExtractMinIntervalMinutes 则跳过,
  // 避免每次回复都整理一遍群记忆。
  async extractAndSaveGroupMemories(groupId: MemoryId, chatHistory: MemoryExtractionMessage[] = [], meta: MemoryExtractionMeta = {}) {
    if (!this.config.enabled || !Array.isArray(chatHistory) || !chatHistory.length) return { queued: false }
    await this.restorePendingExtractions(groupId)
    const storedMeta = await this.store.getMeta(groupId)
    if (storedMeta.disabled) return {queued:false,reason:'disabled'}

    const intervalMs = Math.max(0, Number(this.config.groupExtractMinIntervalMinutes) || 0) * 60000
    const key = JSON.stringify([String(groupId),personaSourceKey(meta.personaSource)])
    const messages = this._privacySafeGroupMessages(chatHistory,storedMeta.optedOut)
      .filter(m => m.role !== 'assistant' && m.source !== 'send' && m.source !== 'tool' && classifyBoundary(m.content).verdict === 'candidate')
      .slice(-this.config.groupExtractMaxBatchMessages)
    const pending = this.groupBuffers.get(key)
    if (pending) {
      if (pending.retryExhausted) return {queued:false,reason:'retry-exhausted'}
      // Histories overlap between turns. Append only genuinely new rows while
      // keeping old failed input and its retry deadline intact.
      const rowKey = (message:MemoryExtractionMessage) => JSON.stringify([message.authorQQ || '',message.at ?? null,message.role || 'user',message.source || 'user',message.content])
      const seen = new Set(pending.messages.map(rowKey))
      const added = messages.filter(message => {
        const id = rowKey(message)
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      const limit = Math.max(1,Math.min(500,Number(this.config.extractPendingMaxMessages) || 60))
      if (pending.messages.length + added.length > limit) return {queued:false,reason:'pending-full',buffered:pending.messages.length,rejectedMessages:added.length}
      if (added.length) {
        pending.messages.push(...added.map(message => ({...message,content:String(message.content || '')})))
        await this._persistPendingExtractions(groupId)
      }
      return this._flushExtractionBuffer('group',key)
    }
    if (this._pendingBatchCount(groupId) >= this._pendingBatchLimit()) return {queued:false,reason:'pending-batches-full'}
    const last = this.lastGroupExtractAt.get(key) || 0
    if (intervalMs > 0 && nowMs() - last < intervalMs) {
      memStats.inc('extract.group.throttled')
      return { queued: false, reason: 'throttled' }
    }

    if (!messages.length) return { queued: false, reason: 'no-candidate' }

    memStats.inc('extract.group.run')
    const buf = this._createExtractionBuffer(groupId,'',meta)
    buf.messages = messages.map(message => ({...message,content:String(message.content || ''),...(finiteTimestamp(message.at) !== undefined ? {at:message.at!} : {})}))
    this.groupBuffers.set(key,buf)
    return this._flushExtractionBuffer('group',key)
  }

  // ---- admin 命令（保留返回契约）----
  // §P0-3 返回真实字段（去掉不存在的 importanceThreshold/lastAttemptAt 等）。
  async adminStatus({ groupId, userId }: AdminOptions = {}) {
    await this.restorePendingExtractions(groupId)
    const [meta, entities, facts, aliasDoc, workflows, knowledge] = await Promise.all([
      this.store.getMeta(groupId),
      this.store.getEntities(groupId),
      this.store.getFacts(groupId),
      this.store.getAlias(groupId),
      this.store.getWorkflows(groupId),
      this.store.getKnowledge(groupId)
    ])
    const userEntity = userId ? entities[String(userId)] : null
    const optedOut = userId ? (meta.optedOut || []).map(String).includes(String(userId)) : false
    const activeUserFacts = userEntity ? (userEntity.facts || []).filter(f => !f.superseded) : []
    const activeUserAliases = userEntity ? (userEntity.aliases || []).filter(a => !a.superseded) : []
    const activeGroupFacts = facts.filter(f => !f.superseded)
    return {
      enabled: this.config.enabled,
      user: userEntity
        ? { factCount: activeUserFacts.length, aliasCount: activeUserAliases.length, optedOut }
        : { factCount: 0, aliasCount: 0, optedOut },
      group: {
        entityCount: Object.keys(entities).length,
        factCount: activeGroupFacts.length,
        aliasCount: Object.keys(aliasDoc).length,
        workflowCount: workflows.filter(rule => rule?.enabled !== false).length,
        knowledgeCount: knowledge.filter(entry => entry?.enabled !== false).length,
        disabled: meta.disabled,
        lastExtractAt: Number(meta.lastExtractAt) || 0,
        failureCount: Number(meta.failureCount) || 0,
        lastExtractAttemptAt: Number(meta.lastExtractAttemptAt) || 0,
        lastExtractStatus: String(meta.lastExtractStatus || ''),
        lastExtractFailure: String(meta.lastExtractFailure || ''),
        nextRetryAt: Number(meta.nextRetryAt) || 0,
        pendingExtractions: [...this.userBuffers.values(),...this.groupBuffers.values()].filter(buf => String(buf.groupId) === String(groupId)).length
      },
      config: {
        saveStrictness: this.config.saveStrictness,
        semanticRecallEnabled: this.config.semanticRecallEnabled,
        proactiveCallback: this.config.proactiveCallback,
        maxEntitiesPerGroup: this.config.maxEntitiesPerGroup,
        maxFactsPerGroup: this.config.maxFactsPerGroup
      }
    }
  }

  // §P0-3 query 真过滤：text 含 query 或任一 tag 含 query；空 query → 不过滤。过滤后再截断。
  async adminListMemories({ scope = 'user', groupId, userId = null, query = '', limit = 30 }: AdminOptions = {}) {
    const entities = await this.store.getEntities(groupId)
    if (scope === 'user') {
      const e = entities[String(userId)]
      const all = e ? (e.facts || []).filter(f => !f.superseded) : []
      const facts = this._filterFactsByQuery(all, query)
      return { facts: facts.slice(0, limit), total: facts.length, entity: e || null }
    }
    const all = (await this.store.getFacts(groupId)).filter(f => !f.superseded)
    const facts = this._filterFactsByQuery(all, query)
    const aliasDoc = await this.store.getAlias(groupId)
    return { facts: facts.slice(0, limit), total: facts.length, aliases: Object.entries(aliasDoc).map(([k, v]) => ({ alias: v.display || k, qq: v.qq })) }
  }

  // text.includes(query) || (tags||[]).some(t=>t.includes(query))；query 空白 → 原样返回。
  _filterFactsByQuery(facts: Fact[], query: string) {
    const q = String(query || '').trim()
    if (!q) return facts
    return facts.filter(f => String(f.text || '').includes(q) || (f.tags || []).some(t => String(t).includes(q)))
  }

  async adminDeleteMemory({ scope = null, groupId, userId = null, id }: AdminOptions = {}) {
    // id 形如 "my:<shortid>"（软删自己事实）/ "alias:<别名>" / "fact:<群事实文本前缀>"
    if (!id) return { deleted: false, reason: 'missing-id' }
    return this.enqueueGroup(groupId, async () => {
      // §P0-3 my:<shortid> —— 在当前 userId 的 entity.facts 里软删 factShortId 命中的活跃事实。
      if (id.startsWith('my:')) {
        const shortId = id.slice('my:'.length).trim()
        if (!userId) return { deleted: false, reason: 'missing-user' }
        const entities = await this.store.getEntities(groupId)
        const entity = entities[String(userId)]
        if (!entity) return { deleted: false, reason: 'not-found' }
        const idx = (entity.facts || []).findIndex(f => !f.superseded && factShortId(f.text) === shortId)
        if (idx < 0) return { deleted: false, reason: 'not-found' }
        const nextFacts = entity.facts.map((f, i) => (i === idx ? { ...f, superseded: true } : f))
        entities[String(userId)] = { ...entity, facts: nextFacts, updatedAt: nowMs() }
        await this.store.saveEntities(groupId, entities)
        return { deleted: true, scope: 'my', id: shortId }
      }

      const aliasDoc = await this.store.getAlias(groupId)
      if (id.startsWith('alias:')) {
        const key = id.slice('alias:'.length).trim()
        const hit = resolveAlias(aliasDoc, key)
        if (hit) { const k = Object.keys(aliasDoc).find(kk => aliasDoc[kk] === hit); if (k === undefined) return { deleted: false, reason: "not-found" }; delete aliasDoc[k]; await this.store.saveAlias(groupId, aliasDoc); return { deleted: true, scope: 'alias', id: k } }
      }
      const facts = await this.store.getFacts(groupId)
      const idx = facts.findIndex(f => f.text.startsWith(id.replace(/^fact:/, '')))
      if (idx >= 0) { const removed = facts.splice(idx, 1); await this.store.saveFacts(groupId, facts); return { deleted: true, scope: 'group', id: removed[0]!.text } }
      return { deleted: false, reason: 'not-found' }
    })
  }

  async adminClearMemories({ groupId }: AdminOptions = {}) {
    await this.restorePendingExtractions(groupId)
    return this.enqueueGroup(groupId,async () => {
      this._discardPendingExtractions(groupId)
      this.optedOutCache.delete(String(groupId))
      const n = await this.store.clearGroup(groupId)
      return { cleared: n, groupId }
    })
  }

  async adminDeleteGroupWorkflow({ groupId, id }: AdminOptions = {}) {
    const target = String(id || '').trim()
    if (!target) return { deleted: false, reason: 'missing-id' }
    return this.enqueueGroup(groupId, async () => {
      const workflows = await this.store.getWorkflows(groupId)
      const next = workflows.filter(rule => String(rule?.id || '') !== target)
      if (next.length === workflows.length) return { deleted: false, reason: 'not-found' }
      await this.store.saveWorkflows(groupId, next)
      return { deleted: true, id: target }
    })
  }

  async adminDeleteGroupKnowledge({ groupId, id }: AdminOptions = {}) {
    const target = String(id || '').trim()
    if (!target) return { deleted: false, reason: 'missing-id' }
    return this.enqueueGroup(groupId, async () => {
      const entries = await this.store.getKnowledge(groupId)
      const next = entries.filter(entry => String(entry?.id || '') !== target)
      if (next.length === entries.length) return { deleted: false, reason: 'not-found' }
      await this.store.saveKnowledge(groupId, next)
      return { deleted: true, id: target }
    })
  }

  async forgetGroupKnowledge({ groupId, requesterQQ, requesterIsGroupManager = false, query }: AdminOptions = {}) {
    const requester = String(requesterQQ || '').trim()
    const target = compactText(query, 180)
    if (!groupId || !requester || !target) return { deleted: false, reason: 'invalid-request' }
    return this.enqueueGroup(groupId, async () => {
      const [entries, workflows, aliasDoc] = await Promise.all([
        this.store.getKnowledge(groupId),
        this.store.getWorkflows(groupId),
        this.store.getAlias(groupId)
      ])
      const knowledgeCandidates = findGroupKnowledgeDeletionCandidates(entries, {
        query: target,
        speakerQQ: requester,
        createdBy: ''
      }).filter(entry => mayChangeSharedRecord(entry, requester, requesterIsGroupManager))
      const key = normalizeSharedKey(target)
      const aliasCandidates = Object.entries(aliasDoc || {})
        .filter(([aliasKey, value]) => normalizeSharedKey(value?.display || aliasKey) === key)
        .filter(([, value]) => mayChangeSharedRecord(value, requester, requesterIsGroupManager))
        .map(([aliasKey, value]) => ({ type: 'alias', aliasKey, value, entry: undefined, rule: undefined, sourceMessageId: String(value?.sourceMessageId || ''), proposalId: String(value?.proposalId || '') }))
      const workflowCandidates = (Array.isArray(workflows) ? workflows : [])
        .filter(rule => normalizeSharedKey(rule?.condition) === key)
        .filter(rule => mayChangeSharedRecord(rule, requester, requesterIsGroupManager))
        .map(rule => ({ type: 'workflow', rule, entry: undefined, aliasKey: undefined, value: undefined, sourceMessageId: String(rule?.sourceMessageId || ''), proposalId: String(rule?.proposalId || '') }))
      const candidates = [
        ...knowledgeCandidates.map(entry => ({ type: 'knowledge', entry, rule: undefined, aliasKey: undefined, value: undefined, sourceMessageId: String(entry?.sourceMessageId || ''), proposalId: String(entry?.proposalId || '') })),
        ...aliasCandidates,
        ...workflowCandidates
      ]
      // One semantic proposal may create several records. Treat those records as one
      // deletion candidate so "forget X" removes the whole relationship atomically.
      const distinct = new Map<string, typeof candidates[number]>()
      for (const candidate of candidates) {
        const source = candidate.proposalId || candidate.sourceMessageId
        const identity = source || `${candidate.type}:${candidate.entry?.id || candidate.rule?.id || candidate.aliasKey || ''}`
        if (!distinct.has(identity)) distinct.set(identity, candidate)
      }
      const resolved = [...distinct.values()]
      if (resolved.length === 0) return { deleted: false, reason: 'not-found' }
      if (resolved.length > 1) {
        const candidateDescriptions = resolved.map(item => item.entry
          ? describeGroupKnowledgeEntry(item.entry)
          : item.rule
            ? `通知规则“${item.rule.condition}”`
            : `别名“${item.value?.display || item.aliasKey}”`)
        return { deleted: false, reason: 'ambiguous', candidates: resolved.map(item => item.entry || item.rule || item.value), candidateDescriptions }
      }
      const selected = resolved[0]!
      const sourceMessageId = selected.sourceMessageId
      const proposalId = selected.proposalId || sourceMessageId
      const removeBySource = (record: { proposalId?: string; sourceMessageId?: string }) => proposalId && String(record?.proposalId || record?.sourceMessageId || '') === proposalId
      const nextKnowledge = proposalId
        ? entries.filter(entry => !removeBySource(entry))
        : entries.filter(entry => String(entry?.id || '') !== String(selected.entry?.id || ''))
      const nextWorkflows = proposalId
        ? workflows.filter(rule => !removeBySource(rule))
        : workflows.filter(rule => String(rule?.id || '') !== String(selected.rule?.id || ''))
      const nextAliases = Object.fromEntries(Object.entries(aliasDoc || {}).filter(([aliasKey, value]) => {
        if (proposalId) return !removeBySource(value)
        return aliasKey !== selected.aliasKey
      }))
      await Promise.all([
        nextKnowledge.length !== entries.length ? this.store.saveKnowledge(groupId, nextKnowledge) : Promise.resolve(),
        nextWorkflows.length !== workflows.length ? this.store.saveWorkflows(groupId, nextWorkflows) : Promise.resolve(),
        Object.keys(nextAliases).length !== Object.keys(aliasDoc || {}).length ? this.store.saveAlias(groupId, nextAliases) : Promise.resolve()
      ])
      const entry = selected.entry || null
      const description = entry
        ? describeGroupKnowledgeEntry(entry)
        : selected.rule
          ? `通知规则“${selected.rule.condition}”`
          : `别名“${selected.value?.display || selected.aliasKey}”`
      return { deleted: true, entry, description, sourceMessageId, proposalId }
    })
  }

  // §0.2 per-user opt-out：enabled=false → 把 userId 加入 meta.optedOut；enabled=true → 移除。
  // 经 enqueueGroup 串行写 meta，并同步刷新进程内 optedOut 缓存（写入侧热路径用）。
  // 返回 { enabled: <是否在记> }（enabled=true 表示仍在记忆该用户）。
  async adminSetUserMemoryEnabled({ groupId, userId, enabled }: AdminOptions = {}) {
    const uid = String(userId)
    await this.restorePendingExtractions(groupId)
    return this.enqueueGroup(groupId, async () => {
      const meta = await this.store.getMeta(groupId)
      const current = new Set((meta.optedOut || []).map(String))
      if (enabled) current.delete(uid)
      else current.add(uid)
      const optedOut = [...current]
      await this.store.saveMeta(groupId, { ...meta, optedOut })
      this.optedOutCache.set(String(groupId), new Set(optedOut))
      if (!enabled) {
        // A group batch can include this person's utterance. Drop the batch
        // rather than retain their text in a shared pending queue.
        this._discardPendingExtractions(groupId,userId)
        await this._savePendingExtractions(groupId)
      }
      return { enabled: !current.has(uid) }
    })
  }
  async adminSetGroupMemoryEnabled({ groupId, enabled }: AdminOptions) {
    await this.restorePendingExtractions(groupId)
    return this.enqueueGroup(groupId,async () => {
      const meta = await this.store.getMeta(groupId)
      meta.disabled = !enabled
      await this.store.saveMeta(groupId, meta)
      if (!enabled) {
        this._discardPendingExtractions(groupId)
        await this._savePendingExtractions(groupId)
      }
      return { enabled: !meta.disabled }
    })
  }

  async clearGroupMemory(groupId: MemoryId) { return this.adminClearMemories({ groupId }) }
  async clearUserMemory(groupId: MemoryId, userId: MemoryId) {
    await this.restorePendingExtractions(groupId)
    return this.enqueueGroup(groupId, async () => {
      this._discardPendingExtractions(groupId,userId)
      await this._savePendingExtractions(groupId)
      const entities = await this.store.getEntities(groupId)
      delete entities[String(userId)]
      await this.store.saveEntities(groupId, entities)
      return { cleared: 1, scope: 'user', userId }
    })
  }

  // 兼容旧外部直接清键调用（apps/test.js admin）
  async clearGroupRedis(groupId: MemoryId) { return (await this.adminClearMemories({groupId})).cleared }
}
return MemoryManager
}

export type MemoryManagerInstance = InstanceType<ReturnType<typeof createMemoryManagerClass>>
