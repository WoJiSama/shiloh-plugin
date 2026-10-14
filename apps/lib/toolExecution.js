import { collectThinking } from "../../utils/thinkingForward.js"
import { resolveEmojiTurnSkips, looksLikeDirectPersonalQuestion, recordEmojiOnlySend } from "../../utils/emojiToolPolicy.js"
import { buildModrinthBilingualReplyInstruction, parseModrinthRankingData, collectModrinthTranslations, cacheModrinthTranslations, buildModrinthCardItemsFromData, buildModrinthForwardItemsFromData, buildModrinthTranslationMessages, parseModrinthTranslationResponse, wrapModrinthForwardItems } from "../../utils/modrinth.js"
import { resolveToolRoundLimit } from "../../utils/agentIntelligence.js"
import { isExplicitAdminCollectionMentionRequest } from "../../utils/mentionRoleRouting.js"
import { mcpManager } from "../../utils/MCPClient.js"
import { buildAgentProgressContext } from "../../utils/agentReplyComposer.js"
import { buildChatRequestData, fetchWithTimeout } from "../../utils/modelGateway.js"
import { clearDrawFailureNote, isImageDeliveryToolName, recordDrawTextFallback } from "../../utils/drawFailureNote.js"
import { formatTurnPlanLog, recordTurnPlanToolOutcome } from "../../utils/turnPlan.js"
import { looksLikeImageVerificationRequest } from "../../utils/imageRequestGuard.js"
import { resolveMemberAvatarReferences, assembleReferenceImages } from "./avatarReference.js"
import {createToolExecution} from "../../dist/backend/modules/tools/infrastructure/toolExecution.js"
const execution=createToolExecution({logger:{info:message=>globalThis.logger?.info?.(message),warn:message=>globalThis.logger?.warn?.(message),error:(message,error)=>globalThis.logger?.error?.(message,error)},collectThinking,resolveEmojiTurnSkips,looksLikeDirectPersonalQuestion,recordEmojiOnlySend,buildModrinthBilingualReplyInstruction,parseModrinthRankingData,collectModrinthTranslations,cacheModrinthTranslations,buildModrinthCardItemsFromData,buildModrinthForwardItemsFromData,buildModrinthTranslationMessages,parseModrinthTranslationResponse,wrapModrinthForwardItems,resolveToolRoundLimit,isExplicitAdminCollectionMentionRequest,mcpManager,buildAgentProgressContext,buildChatRequestData,clearDrawFailureNote,isImageDeliveryToolName,recordDrawTextFallback,formatTurnPlanLog,recordTurnPlanToolOutcome,looksLikeImageVerificationRequest,resolveMemberAvatarReferences,assembleReferenceImages})
export const normalizeAssistantToolMessage=execution.normalizeAssistantToolMessage
export const serializeToolResult=execution.serializeToolResult
export const getToolCallName=execution.getToolCallName
export const shouldRunTerminalToolsInBackground=execution.shouldRunTerminalToolsInBackground
export const buildGroundedImageAnalysisPrompt=execution.buildGroundedImageAnalysisPrompt
export const extractToolResultText=execution.extractToolResultText
export const buildImageVerificationSearchToolCall=execution.buildImageVerificationSearchToolCall
export const startBackgroundTerminalToolCalls=execution.startBackgroundTerminalToolCalls
export const runToolCall=execution.runToolCall
export const dedupeToolCalls=execution.dedupeToolCalls
export const processToolCalls=execution.processToolCalls
export const executeTool=execution.executeTool
