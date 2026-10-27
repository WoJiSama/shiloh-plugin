import { createStrictConversation } from '../../dist/backend/modules/conversation/infrastructure/strictConversation.js'
import { diceManager } from '../../domains/dice/DiceManager.js'
import { globalStyleLearnerManager } from '../../domains/memory/GlobalStyleLearnerManager.js'
import { anchorEventConversation } from '../../utils/forbiddenWordGuard.js'
import { getRedBagType, isExclusiveForUser } from '../../utils/redBagUtils.js'
import { toolConfigHasName } from './conversationUtils.js'
import { simulationRuntime } from '../../utils/simulationRuntime.js'
const runtime = createStrictConversation({logger:globalThis.logger,bot:()=>globalThis.Bot || {},diceManager,globalStyleLearnerManager,anchorEventConversation,getRedBagType,isExclusiveForUser,toolConfigHasName,
  // 仿真模式分流：isCapture 判定走运行时缓存的启用群清单；未启用时零开销直落原链路
  simulation:{isCapture:e=>simulationRuntime.isCapture(e),ingest:e=>simulationRuntime.ingest(e)}})
export const setTrackingWithTimer = runtime.setTrackingWithTimer
export const joinRepeat = runtime.joinRepeat
export const detectGroupRepeat = runtime.detectGroupRepeat
export const isUserTalkingToBot = runtime.isUserTalkingToBot
export const addToBatchJudgment = runtime.addToBatchJudgment
export const processBatchJudgments = runtime.processBatchJudgments
export const batchIsUserTalkingToBot = runtime.batchIsUserTalkingToBot
export const fallbackToSingleJudgment = runtime.fallbackToSingleJudgment
export const handleRandomReply = runtime.handleRandomReply

export const getActiveConversation=runtime.getActiveConversation
export const trackingConversationKey=runtime.trackingConversationKey
