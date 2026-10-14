import { createOutputGuardPipeline } from '../dist/backend/modules/conversation/application/outputGuardPipeline.js'
import {personaFeedbackManager} from '../domains/memory/PersonaFeedbackManager.js'
const pipeline = createOutputGuardPipeline({manager:personaFeedbackManager,info:message=>globalThis.logger?.info?.(message)})
export const {getOutputGuardStats,resetOutputGuardStats,applyOutputPersonaGuards}=pipeline
