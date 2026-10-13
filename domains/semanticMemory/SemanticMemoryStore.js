import { SemanticMemoryStore as TypedStore } from '../../dist/backend/modules/memory/infrastructure/SemanticMemoryStore.js'
export { BM25Index, tokenizeForBM25, normalizeEvolutionConfig, effectiveStrength } from '../../dist/backend/modules/memory/infrastructure/SemanticMemoryStore.js'
export class SemanticMemoryStore extends TypedStore { constructor(options = {}) { super({logger:globalThis.logger,...options}) } }
