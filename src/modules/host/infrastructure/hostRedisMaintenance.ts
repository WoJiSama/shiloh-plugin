export interface MaintenanceRedis {get(key:string):Promise<string|null>;set(key:string,value:string,options:{EX:number}):Promise<unknown>;del(...keys:string[]):Promise<unknown>;keys(pattern:string):Promise<string[]>;scan(cursor:string,...args:unknown[]):Promise<unknown>;scanIterator?(options:{MATCH:string;COUNT:number}):AsyncIterable<string|string[]>}
function record(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}
export function decodeScanResult(value:unknown):{cursor:string;keys:string[]}{const r=record(value),cursor=Array.isArray(value)?value[0]:r.cursor,keys=Array.isArray(value)?value[1]:r.keys;if((typeof cursor!=='string'&&typeof cursor!=='number')||!Array.isArray(keys)||!keys.every(item=>typeof item==='string'))throw new Error('Redis SCAN结果无效');return {cursor:String(cursor),keys}}
export function createHostRedisMaintenance(redis:MaintenanceRedis,logger:{warn(message:string):void;info(message:string):void}){
 async function scanRedisKeys(pattern:string){try{
  if(redis.scanIterator){const keys:string[]=[];for await(const batch of redis.scanIterator({MATCH:pattern,COUNT:200}))keys.push(...typeof batch==='string'?[batch]:batch);return [...new Set(keys)]}
  const keys:string[]=[],seen=new Set<string>();let cursor='0';do{if(seen.has(cursor))throw new Error('Redis SCAN游标重复');seen.add(cursor);const page=decodeScanResult(await redis.scan(cursor,{MATCH:pattern,COUNT:200}));cursor=page.cursor;keys.push(...page.keys)}while(cursor!=='0');return [...new Set(keys)]
 }catch(error){logger.warn(`[Redis] SCAN失败，回退KEYS：${error instanceof Error?error.message:String(error)}`);return await redis.keys(pattern)}}
 async function deleteRedisKeys(keys:string[]=[]){for(let i=0;i<keys.length;i+=200){const chunk=keys.slice(i,i+200).filter(Boolean);if(chunk.length)await redis.del(...chunk)}}
 async function markStaleToolTasksFailed(options:{taskPrefix:string;activePrefix:string;staleMinutes:number;ttlSeconds:number}){let checked=0,marked=0;const now=Date.now(),ttl=Math.max(60000,options.staleMinutes*60000)
  for(const pattern of [options.taskPrefix+'*',options.activePrefix+'*'])for(const key of await scanRedisKeys(pattern)){checked++;try{const raw=await redis.get(key);if(!raw)continue;const value=record(JSON.parse(raw));if(!['processing','tool_running','running','queued'].includes(String(value.status)))continue;const at=Number(value.updatedAt||value.startedAt||0);if(at&&now-at<ttl)continue;await redis.set(key,JSON.stringify({...value,status:'tool_failed',error:'服务重启或进程退出导致任务中断，请重新发起',updatedAt:now}),{EX:options.ttlSeconds});marked++}catch(error){logger.warn(`[持久任务] 清理失败 key=${key}: ${error instanceof Error?error.message:String(error)}`)}}
  if(marked)logger.warn(`[持久任务] 已将 ${marked}/${checked} 个残留运行中任务标记为失败`)
  return {checked,marked}
 }
 async function clearAllMessages(prefix:string){const keys=await scanRedisKeys(prefix+'*');if(keys.length){await deleteRedisKeys(keys);logger.info(`已清除${keys.length}条消息历史记录`)}}
 return {scanRedisKeys,deleteRedisKeys,markStaleToolTasksFailed,clearAllMessages}
}
