// Legacy logger composition for typed artifact lifecycle.
import { MediaArtifactStore as TypedMediaArtifactStore } from '../../dist/backend/modules/messaging/infrastructure/mediaArtifactStore.js'
export { buildMediaArtifactKey } from '../../dist/backend/modules/messaging/infrastructure/mediaArtifactStore.js'
export class MediaArtifactStore extends TypedMediaArtifactStore { constructor(options = {}) { super({ logger: globalThis.logger, ...options }) } }
