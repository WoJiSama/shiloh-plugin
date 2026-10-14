import {createRecentImageContinuation} from '../dist/backend/modules/conversation/application/recentImageContinuation.js'
export const {isRecentImageContinuationRequest,resolveRecentBotImage,findRecentBotImage,resolveRecentUserImage}=createRecentImageContinuation(()=>globalThis.Bot?.uin)
