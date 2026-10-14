import { createLikeTool } from '../../dist/backend/modules/qqTools/infrastructure/LikeTool.js'
export const { LikeTool } = createLikeTool({ getBot: () => globalThis.Bot })
