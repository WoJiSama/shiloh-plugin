import {memoryRecord} from '../../../../contracts/memoryEngine.js'
import type {MemoryId,MemoryRedisClient,AliasEntry,KnowledgeEntry,WorkflowRule,PendingMemoryExtraction} from '../../../../contracts/memoryEngine.js'
// utils/memory/redisStore.js
import { KEY } from './constants.js'
import { slimEntityDoc, slimGroupFacts } from './entityModel.js'

function safeParse(raw:unknown, fallback:unknown):unknown {
  if (!raw) return fallback
  try { return JSON.parse(String(raw)) as unknown } catch { return fallback }
}

function parseTeachingEntry(value:unknown):KnowledgeEntry & WorkflowRule {
 const item=memoryRecord(value),resource=memoryRecord(item.resource)
 const output:KnowledgeEntry & WorkflowRule={}
 for(const key of ['id','kind','subject','subjectKey','condition','conditionKey','createdBy','ownerQQ','ownerDisplay','sourceText','sourceMessageId','proposalId'] as const)if(typeof item[key]==='string')output[key]=item[key]
 if(typeof item.enabled==='boolean')output.enabled=item.enabled
 for(const key of ['at','updatedAt'] as const)if(typeof item[key]==='number')output[key]=item[key]
 if(Array.isArray(item.aliases))output.aliases=item.aliases.map(String)
 if(Array.isArray(item.targetUserIds))output.targetUserIds=item.targetUserIds.map(String)
 if(Array.isArray(item.targets))output.targets=item.targets.map(memoryRecord).filter(target=>target.userId!==undefined).map(target=>({userId:String(target.userId),displayName:String(target.displayName||'')}))
 if(typeof resource.fileName==='string')output.resource={fileName:resource.fileName,folderPath:String(resource.folderPath||''),fileId:String(resource.fileId||''),origin:String(resource.origin||'')}
 return output
}
const DEFAULT_META = { disabled: false, optedOut: [], lastExtractAt: 0, nextRetryAt: 0, failureCount: 0, lastExtractAttemptAt:0, lastExtractStatus:'', lastExtractFailure:'' }

export class RedisStore {
 redis:MemoryRedisClient
  // 注入 redis 以便单测；生产默认用全局 redis
  constructor({ redis }: {redis:MemoryRedisClient}) {
    this.redis = redis
  }

  async _setRaw(key:string, value:string) {
    await this.redis.set(key, value)
  }

  async _getJson(key:string, fallback:unknown) {
    return safeParse(await this.redis.get(key), fallback)
  }

  async getEntities(groupId:MemoryId) {
    return slimEntityDoc(await this._getJson(KEY.entities(groupId), {}))
  }
  async saveEntities(groupId:MemoryId, doc:unknown) {
    await this._setRaw(KEY.entities(groupId), JSON.stringify(slimEntityDoc(doc)))
  }

  async getAlias(groupId:MemoryId) {
    const raw=memoryRecord(await this._getJson(KEY.alias(groupId), {}))
    const result:Record<string,AliasEntry>={}
    for(const [key,value] of Object.entries(raw)) {
      const item=memoryRecord(value)
      if(!item.qq)continue
      result[key]={qq:String(item.qq),authority:String(item.authority||'mention'),confidence:Number(item.confidence)||0,at:Number(item.at)||0,by:Array.isArray(item.by)?item.by.map(String):[],createdBy:String(item.createdBy||''),sourceMessageId:String(item.sourceMessageId||''),proposalId:String(item.proposalId||''),display:item.display}
    }
    return result
  }
  async saveAlias(groupId:MemoryId, doc:unknown) {
    await this._setRaw(KEY.alias(groupId), JSON.stringify(doc || {}))
  }

  async getFacts(groupId:MemoryId) {
    return slimGroupFacts(await this._getJson(KEY.facts(groupId), []))
  }
  async saveFacts(groupId:MemoryId, facts:unknown) {
    await this._setRaw(KEY.facts(groupId), JSON.stringify(slimGroupFacts(facts)))
  }

  async getWorkflows(groupId:MemoryId):Promise<WorkflowRule[]> {
    const value = await this._getJson(KEY.workflows(groupId), [])
    return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)).map(parseTeachingEntry) : []
  }
  async saveWorkflows(groupId:MemoryId, workflows:unknown) {
    await this._setRaw(KEY.workflows(groupId), JSON.stringify(Array.isArray(workflows) ? workflows : []))
  }

  async getKnowledge(groupId:MemoryId):Promise<KnowledgeEntry[]> {
    const value = await this._getJson(KEY.knowledge(groupId), [])
    return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)).map(parseTeachingEntry) : []
  }
  async saveKnowledge(groupId:MemoryId, entries:unknown) {
    await this._setRaw(KEY.knowledge(groupId), JSON.stringify(Array.isArray(entries) ? entries : []))
  }

  async getMeta(groupId:MemoryId) {
    const meta=memoryRecord(await this._getJson(KEY.meta(groupId), {}))
    const finiteNumber = (value:unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0,value) : 0
    return { ...DEFAULT_META, ...meta, disabled:meta.disabled===true, optedOut:Array.isArray(meta.optedOut)?meta.optedOut.map(String):[],lastExtractAt:finiteNumber(meta.lastExtractAt),nextRetryAt:finiteNumber(meta.nextRetryAt),failureCount:finiteNumber(meta.failureCount),lastExtractAttemptAt:finiteNumber(meta.lastExtractAttemptAt),lastExtractStatus:typeof meta.lastExtractStatus === 'string' ? meta.lastExtractStatus : '',lastExtractFailure:typeof meta.lastExtractFailure === 'string' ? meta.lastExtractFailure : '' }
  }
  async saveMeta(groupId:MemoryId, meta:unknown) {
    await this._setRaw(KEY.meta(groupId), JSON.stringify({ ...DEFAULT_META, ...memoryRecord(meta) }))
  }

  async getPendingExtractions(groupId:MemoryId):Promise<unknown[]> {
    const value = await this._getJson(KEY.pending(groupId), [])
    return Array.isArray(value) ? value : []
  }
  async savePendingExtractions(groupId:MemoryId, pending:PendingMemoryExtraction[]) {
    if (!pending.length) return this.redis.del(KEY.pending(groupId))
    return this._setRaw(KEY.pending(groupId), JSON.stringify(pending))
  }

  async clearGroup(groupId:MemoryId) {
    const keys = [KEY.entities(groupId), KEY.alias(groupId), KEY.facts(groupId), KEY.workflows(groupId), KEY.knowledge(groupId), KEY.meta(groupId), KEY.pending(groupId)]
    for (const k of keys) await this.redis.del(k)
    return keys.length
  }
}
