import {BananaTool as TypedBananaTool} from '../../dist/backend/modules/toolSupport/infrastructure/BananaTool.js'
import {createImageResource} from '../../dist/backend/modules/image/infrastructure/imageResource.js'
import {getBase64Image,normalizeImageUrls} from '../../utils/fileUtils.js'
import {dependencies} from '../../dependence/dependencies.js'
import {pluginBridge} from '../../utils/pluginBridge.js'
import {personaFeedbackManager} from '../../domains/memory/PersonaFeedbackManager.js'
import {serializeMultipartFormData} from '../../utils/multipartFormData.js'
import {formatMessageSendFailure,getImageBufferMetadata,isMessageSendFailed,resolveImageBuffer} from '../../utils/reliableImageSender.js'
import {encodeDrawMultipart,checkDrawImageUrl} from '../../dist/backend/modules/toolSupport/infrastructure/bananaAdapters.js'
const logger={info:(...args)=>(globalThis.logger||console).info(...args),warn:(...args)=>(globalThis.logger||console).warn(...args),error:(...args)=>(globalThis.logger||console).error(...args)}
const ports={
 getRedis:()=>globalThis.redis||null,getBot:selfId=>globalThis.Bot?.[selfId]||globalThis.Bot||globalThis.bot||null,getBridge:()=>pluginBridge.instance,
 normalizeImageUrls,guardReply:(...args)=>personaFeedbackManager.guardReply(...args),
 segment:{image:buffer=>globalThis.segment.image(buffer),at:id=>globalThis.segment?.at?.(id)||{type:'at',qq:id},reply:id=>globalThis.segment?.reply?.(id)||{type:'reply',id:String(id),data:{id:String(id)}}},
 logger,resolveImageBuffer,getImageBufferMetadata,isMessageSendFailed,formatMessageSendFailure,isUrlAvailable:url=>checkDrawImageUrl(url,globalThis.fetch),
 imageService:{fetch:(...args)=>globalThis.fetch(...args),loadReference:async(url,signal)=>{signal?.throwIfAborted();const value=await getBase64Image(url,'reference.png');signal?.throwIfAborted();return value},encodeMultipart:(fields,files)=>encodeDrawMultipart(fields,files,()=>new dependencies.FormData(),serializeMultipartFormData),resolveImage:async(image,signal)=>(await createImageResource({fetch:(...args)=>globalThis.fetch(...args)})(image,signal)).buffer,metadata:bytes=>getImageBufferMetadata(Buffer.from(bytes)),logInfo:logger.info,logWarn:logger.warn}
}
export class BananaTool extends TypedBananaTool {constructor(options={}){super(options,ports)}}
