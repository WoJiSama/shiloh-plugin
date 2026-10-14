import {createThinkingForward} from '../dist/backend/modules/conversation/application/thinkingForward.js'
import {isThinkingForwardEnabled} from './thinkingForwardSettings.js'
import {findForbiddenWord,isConversationInterrupted} from './forbiddenWordGuard.js'
const api=createThinkingForward({enabled:isThinkingForwardEnabled,botId:()=>globalThis.Bot?.uin,warn:message=>globalThis.logger?.warn?.(message),guard:{findForbiddenWord,isConversationInterrupted}})
export const {collectThinking,sendThinkingForward}=api
