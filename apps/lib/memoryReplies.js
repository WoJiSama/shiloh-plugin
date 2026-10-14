import {factShortId} from '../../domains/memory/engine/entityModel.js'
import {createMemoryReplies} from '../../dist/backend/modules/conversation/application/memoryReplies.js'
import common from '../../../../lib/common/common.js'
const api=createMemoryReplies({factShortId,makeForwardMsg:(...args)=>common.makeForwardMsg(...args),warn:(...args)=>globalThis.logger?.warn?.(...args)})
export const {formatMemoryFactLines,formatMemoryFacts,replyMemoryForward,replyLongForward}=api
