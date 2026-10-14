import { createChangeCardTool } from '../../dist/backend/modules/qqTools/infrastructure/ChangeCardTool.js'
export const { ChangeCardTool } = createChangeCardTool({ getBot: () => globalThis.Bot })
