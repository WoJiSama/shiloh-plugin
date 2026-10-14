import {createMessageFormatting} from '../../dist/backend/modules/conversation/application/messageFormatting.js'
const api=createMessageFormatting({botId:()=>globalThis.Bot?.uin,error:(message,error)=>console.error(message,error)})
export const {formatTime,buildMessageContent,formatMessages}=api
