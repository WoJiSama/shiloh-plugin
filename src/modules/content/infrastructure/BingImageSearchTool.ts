import {AbstractTool} from '../../toolSupport/infrastructure/AbstractTool.js'
import crypto from 'node:crypto'
import {extractDeliveryMessageId} from '../../messaging/domain/deliveryObservability.js'
import {record,imageUrls,shuffle,countValue,accessible,type ImageSearchPorts} from './imageSearchPorts.js'
export function createBingImageSearchTool(ports:ImageSearchPorts){
 const fetchImpl:typeof globalThis.fetch=(input,init)=>(ports.fetchImpl??globalThis.fetch)(input,init)
 const sleep=ports.sleep??((ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms)))
 class BingImageSearchTool extends AbstractTool {
 constructor(){super();this.name='bingImageSearchTool';this.description='根据关键词搜索图片并返回图片 URL 列表';this.parameters={type:'object',properties:{query:{type:'string',description:'搜索的图片关键词'},count:{type:'number',description:'返回结果数量,最多10个',default:10}},required:['query','count']}}
    async buildHeaders() {
        const gecSignature = crypto.randomBytes(32).toString('hex').toUpperCase();
        const clientData = Buffer.from(JSON.stringify({
            "1": "2",
            "2": "1",
            "3": "0",
            "4": Date.now().toString(),
            "6": "stable",
            "7": Math.floor(Math.random() * 9999999999999),
            "9": "desktop"
        })).toString('base64');

        return {
            'accept': '*/*',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'sec-ch-ua': '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'sec-ms-gec': gecSignature,
            'sec-ms-gec-version': '1-131.0.2903.112',
            'x-client-data': clientData,
            'x-edge-shopping-flag': '1',
            'Referer': 'https://cn.bing.com/visualsearch',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };
    }

 async searchImages(query:string,count=10):Promise<string[]|null>{
  count=countValue(count,10)
  const url=new URL('https://cn.bing.com/images/vsasync');url.searchParams.set('q',query);url.searchParams.set('count',String(count))
  const found=new Set<string>()
  try{
   for(let attempt=0;attempt<3&&found.size<count;attempt++){
    const response=await fetchImpl(url,{headers:await this.buildHeaders(),signal:AbortSignal.timeout(10000)})
    if(response.ok){const data=record(await response.json());for(const value of imageUrls(data.results,'imageUrl'))found.add(value)}
    if(attempt<2&&found.size<count)await sleep(1000)
   }
   return shuffle([...found]).slice(0,count)
  }catch{return found.size?shuffle([...found]).slice(0,count):null}
 }
 async searchWallpapers(query:string,numResults=10):Promise<string[]|null>{
  try{
   const params=new URLSearchParams({product_id:'52',version_code:'28103',page:'0',search_word:query,maxWidth:'99999',minWidth:'0',maxHeight:'99999',minHeight:'0',searchMode:'ACCURATE_SEARCH',sort:'0',sign:crypto.randomBytes(32).toString('hex')})
   const response=await fetchImpl('https://wallpaper.soutushenqi.com/v1/wallpaper/list',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:params.toString(),signal:AbortSignal.timeout(10000)})
   if(!response.ok)return null
   const data=record(await response.json())
   return shuffle(imageUrls(data.data,'largeUrl').filter(url=>!url.includes('fw480'))).slice(0,countValue(numResults,10))
  }catch{return null}
 }
 async func(opts:Record<string,unknown>,event:unknown){
  const query=typeof opts.query==='string'?opts.query.trim():'';if(!query)return '搜索关键词（query）是必填项。'
  const count=countValue(opts.count,10)
  let urls=await this.searchWallpapers(query,count)??[]
  if(urls.length<count)urls=[...new Set([...urls,...await this.searchImages(query,count-urls.length)??[]])].slice(0,count)
  if(!urls.length)return '抱歉，未搜索到相关图片，请换个关键词试试。'
  const checked=await Promise.all(shuffle(urls).map(async url=>({url,ok:await accessible(fetchImpl,url,3000)})))
  const valid=checked.filter(item=>item.ok).map(item=>item.url).slice(0,count)
  if(!valid.length)return '抱歉，未找到可用的图片，请重试。'
  const images:unknown[]=[];for(const url of valid){try{images.push(ports.image(url))}catch{}}
  if(!images.length)return '抱歉，所有图片都无法发送，请重试。'
  try{
   if(!ports.sendForward)throw new Error('缺少转发接口')
   const receipt=await ports.sendForward(event,images.map(message=>({user_id:'',nickname:'',message})))
   if(!extractDeliveryMessageId(receipt))return '图片发送结果未确认，请检查聊天记录；不会自动重复发送。'
   return `已成功发送 ${images.length} 张图片~`
  }catch{return '图片发送结果未确认，请检查聊天记录；不会自动重复发送。'}
 }
 }
 return {BingImageSearchTool}
}
