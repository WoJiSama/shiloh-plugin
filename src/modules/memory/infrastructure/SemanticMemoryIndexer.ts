import type { SemanticMemoryStore, MemoryChunk } from './SemanticMemoryStore.js'
import type { EmbeddingGateway } from './EmbeddingGateway.js'
export interface ArchiveRecord {archive_kind?:string;sender?:{user_id?:unknown;card?:string;nickname?:string};user_id?:unknown;timestamp?:number;message_id?:unknown;group_id?:unknown;[key:string]:unknown}
export interface ArchivePort {formatRecord(record:ArchiveRecord,options:{compact:boolean}):string;readAllGroupMessages(groupId:string):Promise<ArchiveRecord[]>;readRecentGroupMessages(groupId:string,count:number):Promise<ArchiveRecord[]>;listArchiveGroupIds():Promise<string[]>;addWriteListener?(callback:(record:ArchiveRecord)=>void):()=>void}
export interface IndexConfig {windowSize?:number;stride?:number;includeGroups?:string[];excludeGroups?:string[];botIds?:string[];indexOnWrite?:boolean}
interface Options {store:SemanticMemoryStore;gateway:EmbeddingGateway;archiveManager:ArchivePort;config?:IndexConfig;logger?:{info?(message:string):void;warn?(message:string):void}}
interface Line {userId:string;name:string;text:string;timestamp:number;messageId:string}
// 语义记忆索引器:把聊天归档切成带说话人的滑动窗口分块并建立向量索引。
// 全量回填(重建命令)+ 增量尾部重切(归档写入钩子触发,防抖合并),
// 分块 id = 群:最后一条消息id,天然幂等,重放不产生重复。
import { safeTruncateUnicode } from "../../models/domain/unicodeText.js"

const DEFAULT_CHUNK_TEXT_LIMIT = 1600
const FLUSH_DEBOUNCE_MS = 30000

export class SemanticMemoryIndexer {
 store:SemanticMemoryStore;gateway:EmbeddingGateway;archiveManager:ArchivePort;config:IndexConfig;logger:Options["logger"];dirtyGroups:Set<string>;flushTimer:ReturnType<typeof setTimeout>|null;flushing:boolean;stats:{backfilledGroups:number;chunksIndexed:number;embedTexts:number;flushes:number}
  constructor({ store, gateway, archiveManager, config = {}, logger }:Options) {
    this.store = store
    this.gateway = gateway
    this.archiveManager = archiveManager
    this.config = config
    this.logger = logger
    this.dirtyGroups = new Set()
    this.flushTimer = null
    this.flushing = false
    this.stats = { backfilledGroups: 0, chunksIndexed: 0, embedTexts: 0, flushes: 0 }
  }

  get windowSize() {
    return Math.max(2, Number(this.config.windowSize) || 8)
  }

  get stride() {
    return Math.max(1, Number(this.config.stride) || 4)
  }

  groupAllowed(groupId:string) {
    const id = String(groupId || "")
    if (!id) return false
    const include = this.config.includeGroups || []
    const exclude = this.config.excludeGroups || []
    if (include.length && !include.includes(id)) return false
    return !exclude.includes(id)
  }

  recordToLine(record:ArchiveRecord, nameResolver:((userId:string)=>string)|null = null) {
    if (!record || record.archive_kind === "notice") return null
    const userId = String(record.sender?.user_id || record.user_id || "")
    if (this.config.botIds?.includes(userId)) return null
    const text = this.archiveManager.formatRecord(record, { compact: true })
    if (!text || text.length < 2) return null
    const name = nameResolver?.(userId) || record.sender?.card || record.sender?.nickname || userId
    return { userId, name: String(name).slice(0, 24), text: safeTruncateUnicode(text, 400), timestamp: Number(record.timestamp || 0), messageId: String(record.message_id ?? "") }
  }

  // 滑动窗口分块:窗口 windowSize、步长 stride,尾窗兜底保证最后几条消息总被覆盖。
  buildChunks(groupId:string, lines:(Line|null)[] = []) {
    const usable = lines.filter((line):line is Line=>Boolean(line))
    if (!usable.length) return []
    const chunks = []
    const windowSize = Math.min(this.windowSize, usable.length)
    const stride = Math.min(this.stride, windowSize)
    for (let start = 0; start + windowSize <= usable.length; start += stride) {
      const slice = usable.slice(start, start + windowSize)
      chunks.push(this.buildChunk(groupId, slice))
    }
    const lastStart = usable.length - windowSize
    if (lastStart < 0) {
      chunks.push(this.buildChunk(groupId, usable))
    } else if (lastStart % stride !== 0) {
      chunks.push(this.buildChunk(groupId, usable.slice(lastStart)))
    }
    const unique = new Map(chunks.map(chunk => [chunk.id, chunk]))
    return [...unique.values()]
  }

  buildChunk(groupId:string, slice:Line[]):MemoryChunk {
    const last = slice[slice.length - 1]!
    const text = slice.map(line => `${line.name}: ${line.text}`).join("\n")
    return {
      id: `${groupId}:${last.messageId}`,
      group_id: String(groupId),
      start_ts: slice[0]!.timestamp,
      end_ts: last.timestamp,
      message_ids: slice.map(line => line.messageId).filter(Boolean),
      speakers: [...new Set(slice.map(line => line.name))].slice(0, 8),
      text: safeTruncateUnicode(text, DEFAULT_CHUNK_TEXT_LIMIT),
      model: this.gateway.model
    }
  }

  async embedAndStore(groupId:string, drafts:MemoryChunk[] = []) {
    if (!drafts.length) return 0
    const state = this.store.loadGroup(groupId)
    const fresh = drafts.filter(draft => !state.chunks.has(draft.id))
    if (!fresh.length) return 0
    const vectors = await this.gateway.embedBatch(fresh.map(draft => draft.text))
    this.stats.embedTexts += fresh.length
    const firstVector = vectors.find(vector => vector)
    if (firstVector && firstVector.length !== this.store.dimension) {
      const previousDimension = this.store.dimension
      this.store.setDimension(firstVector.length)
      this.logger?.info?.(`[SemanticMemory] 向量维度自适应 ${firstVector.length}(原 ${previousDimension})`)
    }
    const ready = fresh
      .map((draft, index) => ({ ...draft, vector: vectors[index] }))
      .filter((chunk):chunk is MemoryChunk & {vector:Float32Array} => chunk.vector instanceof Float32Array)
    if (!ready.length) return 0
    const appended = await this.store.appendChunks(groupId, ready)
    this.stats.chunksIndexed += appended
    return appended
  }

  async backfillGroup(groupId:string) {
    if (!this.groupAllowed(groupId)) return { group: String(groupId), skipped: "group not allowed", chunks: 0 }
    const records = await this.archiveManager.readAllGroupMessages(groupId)
    const lines = records.map(record => this.recordToLine(record))
    const drafts = this.buildChunks(groupId, lines)
    const stored = await this.embedAndStore(groupId, drafts)
    this.stats.backfilledGroups++
    return { group: String(groupId), messages: lines.filter((line):line is Line=>Boolean(line)).length, chunks: drafts.length, indexed: stored }
  }

  async backfillAll() {
    const groupIds = await this.archiveManager.listArchiveGroupIds()
    const results = []
    for (const groupId of groupIds) {
      try {
        results.push(await this.backfillGroup(groupId))
      } catch (error) {
        this.logger?.warn?.(`[SemanticMemory] 回填群 ${groupId} 失败: ${error instanceof Error ? error.message : String(error)}`)
        results.push({ group: String(groupId), error: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
  }

  // 增量:归档每写一条消息就标记脏群,防抖后读归档尾部重切窗口。
  onArchivedRecord(record:ArchiveRecord = {}) {
    if (this.config.indexOnWrite === false) return
    const groupId = String(record.group_id || "")
    if (!groupId || record.archive_kind === "notice") return
    if (!this.groupAllowed(groupId)) return
    this.dirtyGroups.add(groupId)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushDirtyGroups().catch(error =>
        this.logger?.warn?.(`[SemanticMemory] 增量索引失败: ${error instanceof Error ? error.message : String(error)}`))
    }, FLUSH_DEBOUNCE_MS)
    this.flushTimer.unref?.()
  }

  async flushDirtyGroups() {
    if (this.flushing) return
    this.flushing = true
    try {
      const groups = [...this.dirtyGroups]
      this.dirtyGroups.clear()
      for (const groupId of groups) {
        const tailSize = this.windowSize + this.stride * 3
        const records = await this.archiveManager.readRecentGroupMessages(groupId, tailSize)
        const lines = records.map(record => this.recordToLine(record))
        const drafts = this.buildChunks(groupId, lines)
        // 尾部重切的窗口锚点与全量回填可能错位:只追加结束时间晚于现有最新分块的草稿,
        // 避免每次增量都重复覆盖已索引区间
        const state = this.store.loadGroup(groupId)
        let newestEndTs = 0
        for (const chunk of state.chunks.values()) newestEndTs = Math.max(newestEndTs, Number(chunk.end_ts || 0))
        const pending = drafts.filter(draft => Number(draft.end_ts || 0) > newestEndTs)
        const indexed = await this.embedAndStore(groupId, pending)
        if (indexed > 0) {
          this.stats.flushes++
          this.logger?.info?.(`[SemanticMemory] 增量索引 group=${groupId} chunks=+${indexed}`)
        }
      }
    } finally {
      this.flushing = false
    }
  }
}
