import {installObservabilityLog as install} from '../dist/backend/modules/platform/infrastructure/admin/obsLog.js'
export * from '../dist/backend/modules/platform/infrastructure/admin/obsLog.js'
export const installObservabilityLog=(options={})=>install({logger:globalThis.logger,...options})
