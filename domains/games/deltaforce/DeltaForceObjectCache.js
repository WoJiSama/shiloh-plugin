import {DeltaForceObjectCache as Runtime} from '../../../dist/backend/modules/games/infrastructure/DeltaForceObjectCache.js'
export {normalizeDeltaForceObjects} from '../../../dist/backend/modules/games/infrastructure/DeltaForceObjectCache.js'
export class DeltaForceObjectCache extends Runtime {constructor(options={}){super({logger:globalThis.logger,...options})}}
