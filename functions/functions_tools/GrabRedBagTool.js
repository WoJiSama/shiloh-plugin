import { createGrabRedBagTool } from '../../dist/backend/modules/qqTools/infrastructure/GrabRedBagTool.js'
export const { GrabRedBagTool } = createGrabRedBagTool({ getBot: () => globalThis.Bot })
