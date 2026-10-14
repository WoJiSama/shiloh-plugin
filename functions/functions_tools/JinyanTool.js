import { createJinyanTool } from '../../dist/backend/modules/qqTools/infrastructure/JinyanTool.js'
export const { JinyanTool } = createJinyanTool({ getBot: () => globalThis.Bot })
