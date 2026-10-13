import { createConfigStore as createTypedConfigStore } from '../../dist/backend/modules/config/infrastructure/configStore.js'
export { mergeDeepConfig } from '../../dist/backend/modules/config/infrastructure/configStore.js'
export function createConfigStore(options = {}) { return createTypedConfigStore({ logger: globalThis.logger, ...options }) }
