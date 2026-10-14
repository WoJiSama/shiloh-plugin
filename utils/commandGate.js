import {evaluateCommandGate as evaluate,guardCommand as guard} from '../dist/backend/modules/platform/infrastructure/commandGate.js'
export {getCommandGateSettings} from '../dist/backend/modules/platform/infrastructure/commandGate.js'
export const evaluateCommandGate=(settings={},event={},options={})=>evaluate(settings,event,options,globalThis.Bot?.uin)
export const guardCommand=(event,options={},storage={})=>guard(event,options,storage,globalThis.Bot?.uin)
