import {createSmartReply} from '../dist/backend/modules/conversation/application/smartReply.js'
let shared
const api=createSmartReply({getTextImageTool:async()=>{if(!shared){const {TextImageTool}=await import('../functions/functions_tools/TextImageTool.js');shared=new TextImageTool()}return shared},warn:message=>globalThis.logger?.warn?.(message)})
export const {analyzeReplyText,sendSmartReply}=api
