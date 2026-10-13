import { MidtermSummaryManager as TypedManager, installMidtermMemoryRuntime as install } from '../../dist/backend/modules/memory/infrastructure/MidtermSummaryManager.js'
export { DEFAULT_MIDTERM_CONFIG, normalizeMidtermConfig, getMidtermMemoryManager, __resetMidtermMemoryForTest } from '../../dist/backend/modules/memory/infrastructure/MidtermSummaryManager.js'
export class MidtermSummaryManager extends TypedManager { constructor(options = {}) { super({logger:globalThis.logger,...options}) } }
export const installMidtermMemoryRuntime = (options = {}) => install({logger:globalThis.logger,...options})
