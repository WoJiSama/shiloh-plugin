import { isToneCorrectionMessage } from '../../utils/chatFailureReply.js'
import { createPersonaFeedbackModule } from '../../dist/backend/modules/memory/infrastructure/personaFeedbackManager.js'
const api = createPersonaFeedbackModule({ isToneCorrectionMessage, logger: globalThis.logger })
export const PersonaFeedbackManager = api.PersonaFeedbackManager
export const DEFAULT_BAD_PATTERNS = api.DEFAULT_BAD_PATTERNS
export const IDENTITY_DEFLECTION_POOL = api.IDENTITY_DEFLECTION_POOL
export const looksLikeBotIdentityChallenge = api.looksLikeBotIdentityChallenge
export const personaFeedbackManager = new PersonaFeedbackManager()
