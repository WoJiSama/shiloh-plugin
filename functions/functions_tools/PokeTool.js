import { createPokeTool } from '../../dist/backend/modules/qqTools/infrastructure/PokeTool.js'
export const { PokeTool } = createPokeTool({ getBot: () => globalThis.Bot })
