import { SemanticMemoryIndexer as TypedIndexer } from '../../dist/backend/modules/memory/infrastructure/SemanticMemoryIndexer.js'
export class SemanticMemoryIndexer extends TypedIndexer { constructor(options = {}) { super({logger:globalThis.logger,...options}) } }
