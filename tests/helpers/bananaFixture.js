import {BananaTool as CompiledBananaTool} from '../../dist/backend/modules/toolSupport/infrastructure/BananaTool.js'
import {pluginBridge} from '../../utils/pluginBridge.js'
import {getImageBufferMetadata,resolveImageBuffer,isMessageSendFailed,formatMessageSendFailure} from '../../dist/backend/modules/image/infrastructure/reliableImageSender.js'
import {createImageResource} from '../../dist/backend/modules/image/infrastructure/imageResource.js'
import {serializeMultipartFormData} from '../../dist/backend/modules/image/infrastructure/multipartFormData.js'
import {encodeDrawMultipart} from '../../dist/backend/modules/toolSupport/infrastructure/bananaAdapters.js'
import FormData from 'form-data'
export class BananaTool extends CompiledBananaTool {
 constructor(options={}){super(options,{
  getRedis:()=>globalThis.redis||null,getBot:()=>globalThis.Bot||null,getBridge:()=>pluginBridge.instance,
  normalizeImageUrls:async images=>images,guardReply:text=>text,
  segment:{image:buffer=>({type:'image',buffer}),at:id=>({type:'at',qq:id}),reply:id=>globalThis.segment?.reply?.(id)||{type:'reply',id:String(id),data:{id:String(id)}}},
  logger:{info:(...args)=>globalThis.logger?.info?.(...args),warn:(...args)=>globalThis.logger?.warn?.(...args),error:(...args)=>globalThis.logger?.error?.(...args)},
  resolveImageBuffer,getImageBufferMetadata,isMessageSendFailed,formatMessageSendFailure,isUrlAvailable:async()=>false,
  imageService:{fetch:(...args)=>globalThis.fetch(...args),loadReference:async()=> 'data:image/png;base64,aGVsbG8=',encodeMultipart:(fields,files)=>encodeDrawMultipart(fields,files,()=>new FormData(),serializeMultipartFormData),resolveImage:async(image,signal)=>(await createImageResource({fetch:(...args)=>globalThis.fetch(...args)})(image,signal)).buffer,metadata:bytes=>getImageBufferMetadata(Buffer.from(bytes))}
 })}
}
