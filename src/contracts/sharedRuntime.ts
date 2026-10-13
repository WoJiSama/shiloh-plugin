import type { RuntimeIdentity } from './runtime.js'

export type ConfigSnapshot = Readonly<Record<string, unknown>>
export interface ConfigPort { read(): ConfigSnapshot }
export interface MemoryScope { groupId?: RuntimeIdentity; userId?: RuntimeIdentity }
export interface MemoryDeleteResult { deleted: boolean; reason?: string }
export interface MemoryFact { text: string; tags?: string[]; id?: string }
export interface MemoryEntry {
  id: string; condition?: string; createdBy?: RuntimeIdentity; subject?: string; kind?: string
  targets?: { userId: RuntimeIdentity; displayName?: string }[]
  ownerQQ?: RuntimeIdentity; resource?: { fileName?: string }
}
/** Only the commands used by the memory entrypoint are exposed by the registry. */
export interface MemoryCommandPort {
  clearGroupRedis(groupId: RuntimeIdentity): Promise<number>
  adminClearMemories(scope: MemoryScope): Promise<{ cleared: number }>
  adminStatus(scope: MemoryScope): Promise<Record<string, unknown>>
  adminListMemories(scope: MemoryScope & { scope: 'user' | 'group'; limit: number; query?: string }): Promise<{ facts: MemoryFact[] }>
  getGroupWorkflowRules(groupId: RuntimeIdentity): Promise<MemoryEntry[]>
  getGroupKnowledgeEntries(groupId: RuntimeIdentity): Promise<MemoryEntry[]>
  adminDeleteGroupWorkflow(scope: MemoryScope & { id: string }): Promise<MemoryDeleteResult>
  adminDeleteGroupKnowledge(scope: MemoryScope & { id: string }): Promise<MemoryDeleteResult>
  adminDeleteMemory(scope: MemoryScope & { id: string }): Promise<MemoryDeleteResult>
  clearUserMemory(groupId: RuntimeIdentity, userId: RuntimeIdentity): Promise<{ cleared: number }>
  adminSetUserMemoryEnabled(scope: MemoryScope & { enabled: boolean }): Promise<{ enabled: boolean }>
}
export interface SharedRuntime { memoryManager: MemoryCommandPort | null; config: ConfigPort }
