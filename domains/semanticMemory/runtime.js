import { installSemanticMemoryRuntime as install } from '../../dist/backend/modules/memory/infrastructure/semanticRuntime.js'
export { DEFAULT_SEMANTIC_MEMORY_CONFIG, normalizeSemanticMemoryConfig, getSemanticMemoryRuntime, __resetSemanticMemoryRuntimeForTest } from '../../dist/backend/modules/memory/infrastructure/semanticRuntime.js'
export const installSemanticMemoryRuntime = (options = {}) => install({logger:globalThis.logger,...options})
