import { createForbiddenWordGuard } from '../dist/backend/modules/conversation/domain/forbiddenWordGuard.js'
const guard = createForbiddenWordGuard({warn: message => globalThis.logger?.warn?.(message)})
export const {compileForbiddenWords,findForbiddenWord,chatScopeKey,markConversationInterrupted,getConversationInterruptedAt,anchorEventConversation,isConversationInterrupted,extractReplyText} = guard
