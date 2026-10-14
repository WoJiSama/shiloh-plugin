import { createSmartConversation } from '../../dist/backend/modules/conversation/application/smartConversation.js'
import { updateGroupTopic, updateGroupSocial, detectAttentionHook } from '../../utils/groupContextState.js'
import { anchorEventConversation } from '../../utils/forbiddenWordGuard.js'
import { resolveLongTaskFeedbackPolicy } from '../../utils/longTaskFeedbackPolicy.js'
const runtime = createSmartConversation({logger:globalThis.logger,bot:()=>globalThis.Bot || {},updateGroupTopic,updateGroupSocial,detectAttentionHook,anchorEventConversation,resolveLongTaskFeedbackPolicy})
export const handleRandomReplySmart = runtime.handleRandomReplySmart
