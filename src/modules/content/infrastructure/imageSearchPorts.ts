export interface ImageSearchPorts {
 fetchImpl?:typeof globalThis.fetch
 image(url:string):unknown
 sendImages?(event:unknown,images:unknown[]):Promise<unknown>
 sendForward?(event:unknown,nodes:{user_id:string;nickname:string;message:unknown}[]):Promise<unknown>
 sleep?(ms:number):Promise<void>
}
export const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'?value as Record<string,unknown>:{}
export function imageUrls(value:unknown,key:string):string[]{
 if(!Array.isArray(value))return []
 return [...new Set(value.flatMap(item=>{const url=record(item)[key];if(typeof url!=='string')return [];try{const parsed=new URL(url);return ['http:','https:'].includes(parsed.protocol)?[url]:[]}catch{return []}}))]
}
export function shuffle<T>(values:T[]):T[]{const result=[...values];for(let i=result.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)),left=result[i]!,right=result[j]!;result[i]=right;result[j]=left}return result}
export function countValue(value:unknown,fallback:number){const count=Number.parseInt(String(value));return Number.isFinite(count)?Math.min(10,Math.max(1,count)):fallback}
export async function accessible(fetchImpl:typeof globalThis.fetch,url:string,timeout:number){try{const response=await fetchImpl(url,{method:'HEAD',signal:AbortSignal.timeout(timeout)});return response.ok&&Boolean(response.headers.get('content-type')?.startsWith('image/'))}catch{return false}}
