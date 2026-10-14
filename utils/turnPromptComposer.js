import { createTurnPromptComposer } from "../dist/backend/modules/conversation/infrastructure/turnPromptComposer.js"
export const {composeTurnPromptLayers} = createTurnPromptComposer(globalThis.logger)
