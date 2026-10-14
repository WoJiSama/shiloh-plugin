import { createSendGiftTool } from '../../dist/backend/modules/qqTools/infrastructure/SendGiftTool.js'
export const { SendGiftTool } = createSendGiftTool({ getBot: () => globalThis.Bot })
export default SendGiftTool
