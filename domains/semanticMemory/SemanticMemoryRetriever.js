import { SemanticMemoryRetriever as TypedRetriever } from '../../dist/backend/modules/memory/infrastructure/SemanticMemoryRetriever.js'
export { rrfFuse } from '../../dist/backend/modules/memory/infrastructure/SemanticMemoryRetriever.js'
export class SemanticMemoryRetriever extends TypedRetriever { constructor(options = {}) { super({logger:globalThis.logger,...options}) } }
