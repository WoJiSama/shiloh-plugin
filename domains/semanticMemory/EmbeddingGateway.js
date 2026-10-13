import { EmbeddingGateway as TypedGateway } from '../../dist/backend/modules/memory/infrastructure/EmbeddingGateway.js'
export class EmbeddingGateway extends TypedGateway { constructor(options = {}) { super({ logger:globalThis.logger, ...options }) } }
