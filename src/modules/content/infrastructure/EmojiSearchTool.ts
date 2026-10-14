import {AbstractTool} from '../../toolSupport/infrastructure/AbstractTool.js'
import {extractDeliveryMessageId} from '../../messaging/domain/deliveryObservability.js'
import {record,imageUrls,shuffle,countValue,accessible,type ImageSearchPorts} from './imageSearchPorts.js'
export function createEmojiSearchTool(ports:ImageSearchPorts){
 const fetchImpl:typeof globalThis.fetch=(input,init)=>(ports.fetchImpl??globalThis.fetch)(input,init)
 const sleep=ports.sleep??((ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms)))
 class EmojiSearchTool extends AbstractTool {
  constructor(){super();this.name='emojiSearchTool';this.description='根据关键词搜索表情包，并随机发送指定数量的表情包';this.parameters={type:'object',properties:{keyword:{type:'string',description:'表情包的搜索关键词'},count:{type:'number',description:'要发送的表情包数量(1-10)',minimum:1,maximum:10,default:1}},required:['keyword','count'],additionalProperties:false}}
  async searchDuitangImages(keyword:string,maxImages=24){
   maxImages=Math.min(200,Math.max(24,Math.floor(maxImages)||24))
   const found=new Set<string>()
   try{
    for(let page=0;page<10&&found.size<maxImages;page++){
     const response=await fetchImpl(`https://www.duitang.com/napi/blog/list/by_search/?kw=${encodeURIComponent(keyword)}&start=${page*24}&limit=24`,{headers:{accept:'application/json','user-agent':'Mozilla/5.0','x-requested-with':'XMLHttpRequest'},signal:AbortSignal.timeout(10000)})
     if(!response.ok)break
     const data=record(record(await response.json()).data),items=data.object_list
     if(!Array.isArray(items)||!items.length)break
     const before=found.size
     for(const url of imageUrls(items.map(item=>record(record(item).photo)),'path'))found.add(url)
     if(found.size===before)break
     if(found.size<maxImages)await sleep(1000)
    }
   }catch{}
   return shuffle([...found]).slice(0,maxImages)
  }
  async func(opts:Record<string,unknown>,event:unknown){
   const keyword=typeof opts.keyword==='string'?opts.keyword.trim():'';if(!keyword)return '搜索关键词（keyword）是必填项。'
   const count=countValue(opts.count,1),urls=await this.searchDuitangImages(keyword,count*20),images:unknown[]=[]
   for(const url of urls){if(images.length>=count)break;if(await accessible(fetchImpl,url,4000)){try{images.push(ports.image(url))}catch{}}}
   if(!images.length)return '抱歉，未找到可用的图片，请重试。'
   let sent=0
   for(let index=0;index<images.length;index+=8){
    const batch=images.slice(index,index+8)
    try{
     if(!ports.sendImages)throw new Error('缺少发送接口')
     const receipt=await ports.sendImages(event,batch)
     if(!extractDeliveryMessageId(receipt))return `已确认发送 ${sent} 张图片；当前批次结果未确认，已停止后续发送，请检查聊天记录。`
     sent+=batch.length
    }catch{return `已确认发送 ${sent} 张图片；当前批次结果未确认，已停止后续发送，请检查聊天记录。`}
    if(index+8<images.length)await sleep(2000)
   }
   return `已成功发送 ${sent} 张图片~`
  }
 }
 return {EmojiSearchTool}
}
