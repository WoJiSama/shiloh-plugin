import type { EventEnvelope,MessageSegment } from '../contracts/pipeline.js'
import type {ForwardCompleteness} from '../contracts/forwardContext.js'
interface Group {getForwardMsg?:unknown}
interface Bot {pickGroup?(id:number|string):Group|undefined}
interface ForwardAsset {type?:unknown;label?:unknown;fileName?:unknown;source?:unknown}
interface ForwardPorts {
 getBot():Bot|undefined
 extractForwardIdsFromSegments(message:MessageSegment[]|undefined):string[]
 collectForwardContext(group:Group,message:MessageSegment[]|undefined,limits:Record<string,number>):Promise<{text?:string;media?:ForwardAsset[];forwardNodes?:unknown[];completeness?:ForwardCompleteness}>
}
export function createPipelineForwardResolver(ports:ForwardPorts) {
 return async function resolvePipelineForwardContext(envelope:Partial<EventEnvelope>={},bot?:Bot) {
  const forwardIds=ports.extractForwardIdsFromSegments(envelope.message)
  if(!forwardIds.length||!envelope.groupId)return null
  try {
   const root=ports.getBot()||bot
   const group=root?.pickGroup?.(Number(envelope.groupId))||root?.pickGroup?.(envelope.groupId)
   if(!group?.getForwardMsg)throw new Error('OneBot group context is not ready')
   const context=await ports.collectForwardContext(group,envelope.message,{maxDepth:3,maxNodes:80,maxImages:12,maxText:6000})
   if(context.completeness?.state==='unavailable') {
    const error=new Error('OneBot returned no readable forward nodes')
    Object.assign(error,{completeness:context.completeness})
    throw error
   }
   if(!context.text&&!context.media?.length)throw new Error('OneBot returned no forward nodes')
   return {forwardIds,text:String(context.text || ''),media:(context.media||[]).map(asset=>({type:asset.type,label:asset.label,fileName:asset.fileName||'',source:asset.source||''})),forwardNodes:Array.isArray(context.forwardNodes)?context.forwardNodes:[],...(context.completeness?{completeness:context.completeness}:{})}
  }catch(cause){const error=new Error(`OneBot forward context is not ready: ${cause instanceof Error?cause.message:String(cause)}`);Object.assign(error,{code:'forward_context_unavailable',...(cause&&typeof cause==='object'&&'completeness'in cause?{completeness:cause.completeness}:{})});throw error}
 }
}
