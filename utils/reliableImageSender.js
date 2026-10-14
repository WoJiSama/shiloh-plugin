import {sendImageReliably as send} from '../dist/backend/modules/image/infrastructure/reliableImageSender.js'
export {isMessageSendFailed,formatMessageSendFailure,resolveImageBuffer,getImageBufferMetadata} from '../dist/backend/modules/image/infrastructure/reliableImageSender.js'
export const sendImageReliably=(event,image,options={})=>send(event,image,{buildMessage:buffer=>[globalThis.segment.image(buffer)],...options})
