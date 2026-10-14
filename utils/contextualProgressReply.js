import {generateContextualProgressReply as generate} from '../dist/backend/modules/conversation/application/contextualProgressReply.js'
export {normalizeContextualProgressReply,inventsImageProgressDetail,buildContextualProgressMessages} from '../dist/backend/modules/conversation/application/contextualProgressReply.js'
export const generateContextualProgressReply = (options={}) => generate({...options,debug:message=>globalThis.logger?.debug?.(message)})
