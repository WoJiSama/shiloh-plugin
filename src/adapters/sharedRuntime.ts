import type { ConfigSnapshot, MemoryCommandPort } from '../contracts/sharedRuntime.js'
import { createSharedRuntimeRegistry } from '../modules/runtime/application/sharedRuntime.js'

/** Bind the minimum command capability while retaining manager method receivers. */
export function projectMemoryCommands(manager: MemoryCommandPort): MemoryCommandPort {
  const methods = ['clearGroupRedis', 'adminClearMemories', 'adminStatus', 'adminListMemories',
    'getGroupWorkflowRules', 'getGroupKnowledgeEntries', 'adminDeleteGroupWorkflow',
    'adminDeleteGroupKnowledge', 'adminDeleteMemory', 'clearUserMemory', 'adminSetUserMemoryEnabled'] as const
  for (const method of methods) {
    if (typeof manager[method] !== 'function') throw new TypeError(`Missing memory command capability: ${method}`)
  }
  return {
    clearGroupRedis: id => manager.clearGroupRedis(id),
    adminClearMemories: scope => manager.adminClearMemories(scope),
    adminStatus: scope => manager.adminStatus(scope),
    adminListMemories: scope => manager.adminListMemories(scope),
    getGroupWorkflowRules: id => manager.getGroupWorkflowRules(id),
    getGroupKnowledgeEntries: id => manager.getGroupKnowledgeEntries(id),
    adminDeleteGroupWorkflow: scope => manager.adminDeleteGroupWorkflow(scope),
    adminDeleteGroupKnowledge: scope => manager.adminDeleteGroupKnowledge(scope),
    adminDeleteMemory: scope => manager.adminDeleteMemory(scope),
    clearUserMemory: (groupId, userId) => manager.clearUserMemory(groupId, userId),
    adminSetUserMemoryEnabled: scope => manager.adminSetUserMemoryEnabled(scope)
  }
}
export function createLegacySharedRuntime() {
  const registry = createSharedRuntimeRegistry()
  return {
    ...registry,
    getSharedRuntime() {
      const runtime = registry.getSharedRuntime()
      return runtime ? { memoryManager: runtime.memoryManager, getConfig: () => runtime.config.read() } : null
    },
    setSharedRuntime(value: { memoryManager?: MemoryCommandPort | null; getConfig?: () => ConfigSnapshot } | null) {
      registry.setSharedRuntime(value ? {
        memoryManager: value.memoryManager ? projectMemoryCommands(value.memoryManager) : null,
        config: { read: () => value.getConfig?.() || {} }
      } : null)
    }
  }
}
