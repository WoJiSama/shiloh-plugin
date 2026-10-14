import {createLongTaskFeedback} from '../dist/backend/modules/conversation/application/longTaskFeedbackPolicy.js'
import {isImageGenerationRequest,isImageCompositionEditRequest,isImageAnalysisRequest} from '../core/intent/messageIntent.js'
import {isLongRunningTaskLinkRequest} from './smartLockPolicy.js'
export {LONG_TASK_FEEDBACK_POLICIES} from '../dist/backend/modules/conversation/application/longTaskFeedbackPolicy.js'
const runtime=createLongTaskFeedback({isImageGenerationRequest,isImageCompositionEditRequest,isImageAnalysisRequest,isLongRunningTaskLinkRequest,logger:{info:message=>globalThis.logger?.info?.(message),warn:message=>globalThis.logger?.warn?.(message)}})
export const {classifyLongTaskFeedback,resolveLongTaskFeedbackPolicy,sendLongTaskOpening}=runtime
