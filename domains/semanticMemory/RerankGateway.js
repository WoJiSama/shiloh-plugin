import { RerankGateway as TypedGateway } from '../../dist/backend/modules/memory/infrastructure/RerankGateway.js'
export { rerankUrlFromEmbeddingUrl } from '../../dist/backend/modules/memory/infrastructure/RerankGateway.js'
export class RerankGateway extends TypedGateway { constructor(options = {}) { super({ logger:globalThis.logger, ...options }) } }
