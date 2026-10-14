import {ensureGuobaJumpLink as ensure,watchGuobaJumpLink as watch} from '../dist/backend/modules/platform/infrastructure/admin/guobaJumpLink.js'
export {resolveGuobaIndexPath} from '../dist/backend/modules/platform/infrastructure/admin/guobaJumpLink.js'
export const ensureGuobaJumpLink=(options={})=>ensure({logger:globalThis.logger,...options})
export const watchGuobaJumpLink=(options={})=>watch({logger:globalThis.logger,...options})
