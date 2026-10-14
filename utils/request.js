import {createRequestClient} from '../dist/backend/modules/shared/infrastructure/request.js'
export {qs} from '../dist/backend/modules/shared/infrastructure/request.js'
export default createRequestClient({logger:{error:error=>globalThis.logger?.error?.(error)},image:(...args)=>globalThis.segment.image(...args)})
