import { createChatFailureReply } from '../dist/backend/modules/conversation/application/chatFailureReply.js'
import {getCachedDiagnosisLine,triggerChatFailureDiagnosis} from './chatFailureDiagnosis.js'
export {isToneCorrectionMessage,hasMeaningfulUserText,buildVisibleChatFailureDetail} from '../dist/backend/modules/conversation/application/chatFailureReply.js'
export const buildGenericChatFailureReply=createChatFailureReply({getCachedDiagnosisLine,triggerChatFailureDiagnosis})
