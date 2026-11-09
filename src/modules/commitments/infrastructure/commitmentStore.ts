// 承诺账本 redis 存储:pending:list(按 next_run_at 排序)+ detail:{id},锁模式对齐 ReminderTool。
import {randomUUID} from 'node:crypto'
import type {CommitmentData,CommitmentRedisLike} from '../../../contracts/commitments.js'

const REDIS_KEY_PREFIX='bl-chat:commitment:'
const PENDING_LIST_KEY=`${REDIS_KEY_PREFIX}pending:list`
const FAILLOG_KEY=`${REDIS_KEY_PREFIX}faillog`
const FAILLOG_LIMIT=20
const LOCK_KEY=`${REDIS_KEY_PREFIX}lock`
const LOCK_TIMEOUT=15000
const LOCK_ACQUIRE_TIMEOUT=1500

interface PendingEntry{id:string;next_run_at:number}

function record(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}

export function decodeCommitment(data:string):CommitmentData {
  const r=record(JSON.parse(data))
  if(typeof r.id!=='string'||typeof r.group_id!=='string'||typeof r.creator_id!=='string'||typeof r.intent!=='string')throw new Error('承诺详情损坏')
  const schedule=record(r.schedule)
  const normalizedSchedule=schedule.kind==='daily'
    ?{kind:'daily' as const,time:String(schedule.time||'')}
    :{kind:'once' as const,time:Number(schedule.time)||0}
  const status=r.status
  if(status!=='active'&&status!=='completed'&&status!=='failed'&&status!=='expired')throw new Error('承诺状态无效')
  const deliver=r.deliver==='static'?'static':'agent'
  return {
    id:r.id,group_id:r.group_id,creator_id:r.creator_id,creator_name:String(r.creator_name||''),
    intent:r.intent,schedule:normalizedSchedule,deliver,
    static_message:typeof r.static_message==='string'?r.static_message:null,
    expiry_at:Number(r.expiry_at)||0,renewal_asked_at:Number(r.renewal_asked_at)||0,
    next_run_at:Number(r.next_run_at)||0,status,
    last_run_at:Number(r.last_run_at)||0,last_result:String(r.last_result||''),retry_count:Number(r.retry_count)||0,
    created_at:Number(r.created_at)||0,bot_id:String(r.bot_id||'')
  }
}

export function createCommitmentStore(ports:{redis:CommitmentRedisLike;logger:{warn(message:string):void}}) {
  const {redis,logger}=ports

  async function acquireLock(timeout=LOCK_ACQUIRE_TIMEOUT){
    const token=randomUUID(),end=Date.now()+timeout
    while(Date.now()<end){
      const result=await redis.set(LOCK_KEY,token,{PX:LOCK_TIMEOUT,NX:true})
      if(result==='OK'||result===true)return token
      await new Promise(resolve=>setTimeout(resolve,50))
    }
    return null
  }

  async function releaseLock(token:string){
    await redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',{keys:[LOCK_KEY],arguments:[token]})
  }

  async function withLock<T>(operation:()=>Promise<T>):Promise<T> {
    const lockValue=await acquireLock()
    if(!lockValue)throw new Error('获取锁超时')
    try{return await operation()}finally{await releaseLock(lockValue)}
  }

  async function getPendingList():Promise<PendingEntry[]>{
    const data=await redis.get(PENDING_LIST_KEY)
    if(!data)return []
    const parsed:unknown=JSON.parse(data)
    if(!Array.isArray(parsed))throw new Error('承诺索引损坏，停止修改')
    return parsed.map(value=>{
      const r=record(value)
      if(typeof r.id!=='string'||!Number.isFinite(Number(r.next_run_at)))throw new Error('承诺索引损坏')
      return {id:r.id,next_run_at:Number(r.next_run_at)}
    })
  }

  async function savePendingList(list:PendingEntry[]){
    await redis.set(PENDING_LIST_KEY,JSON.stringify([...list].sort((a,b)=>a.next_run_at-b.next_run_at)))
  }

  async function saveCommitment(c:CommitmentData){
    await redis.set(`${REDIS_KEY_PREFIX}detail:${c.id}`,JSON.stringify(c))
  }

  async function getCommitment(id:string):Promise<CommitmentData|null>{
    const data=await redis.get(`${REDIS_KEY_PREFIX}detail:${id}`)
    if(!data)return null
    try{return decodeCommitment(data)}catch(error){logger.warn(`[承诺] 读取 ${id} 失败: ${error instanceof Error?error.message:String(error)}`);return null}
  }

  async function createCommitment(c:CommitmentData){
    await saveCommitment(c)
    await withLock(async()=>{
      const list=await getPendingList()
      list.push({id:c.id,next_run_at:c.next_run_at})
      await savePendingList(list)
    })
  }

  async function cancelCommitment(id:string){
    await withLock(async()=>{
      const list=await getPendingList()
      await savePendingList(list.filter(item=>item.id!==id))
    })
    await redis.del(`${REDIS_KEY_PREFIX}detail:${id}`)
  }

  /** 取出到期承诺(先移出列表防下一秒重复触发);到期的过期承诺就地标记不再返回。
   *  先无锁 peek(对齐 ReminderTool):99% 的时间池子为空或全是未到期项,不进锁。 */
  async function takeDueCommitments(now:number):Promise<CommitmentData[]>{
    const peek=await getPendingList()
    if(!peek.length||!peek.some(item=>item.next_run_at<=now))return []
    return await withLock(async()=>{
      const list=await getPendingList()
      const due=list.filter(item=>item.next_run_at<=now)
      if(!due.length)return []
      await savePendingList(list.filter(item=>item.next_run_at>now))
      const out:CommitmentData[]=[]
      for(const item of due){
        const c=await getCommitment(item.id)
        if(!c)continue
        out.push(c)
      }
      return out
    })
  }

  /** 执行后回写:active 且有下次时间→回列;终态→只留详情24h */
  async function commitRunOutcome(c:CommitmentData){
    await saveCommitment(c)
    if(c.status==='active'&&c.next_run_at>0){
      await withLock(async()=>{
        const list=await getPendingList()
        if(!list.some(item=>item.id===c.id))list.push({id:c.id,next_run_at:c.next_run_at})
        await savePendingList(list)
      })
    }else{
      await redis.set(`${REDIS_KEY_PREFIX}detail:${c.id}`,JSON.stringify(c),{EX:86400})
    }
  }

  /** 失败重试:+10s 回列,超限置 failed。返回终态(failed)供调用方失约明说。 */
  async function requeueForRetry(c:CommitmentData,at:number):Promise<'retrying'|'failed'>{
    const retry=c.retry_count+1
    if(retry>=3){
      await commitRunOutcome({...c,retry_count:retry,status:'failed',last_result:c.last_result||'重试超限'})
      return 'failed'
    }
    const next={...c,retry_count:retry,next_run_at:at+10000}
    await commitRunOutcome(next)
    return 'retrying'
  }

  /** 终态失败日志(截断 20 条):健康哨兵读它告警;控制台托付页展示/清理。只存 id/intent/群/原因/时间。 */
  async function appendFailLog(entry:{id:string;intent:string;group_id:string;reason:string;at:number}){
    const current=await readFailLog()
    await redis.set(FAILLOG_KEY,JSON.stringify([entry,...current].slice(0,FAILLOG_LIMIT)))
  }

  async function readFailLog():Promise<{id?:string;intent?:string;group_id?:string;reason?:string;at?:number}[]>{
    const raw=await redis.get(FAILLOG_KEY)
    if(!raw)return []
    try{
      const parsed:unknown=JSON.parse(raw)
      return Array.isArray(parsed)?parsed.filter(v=>v!==null&&typeof v==='object'):[]
    }catch{
      logger.warn('[承诺] 失败日志损坏，按空处理')
      return []
    }
  }

  async function clearFailLog():Promise<void>{
    await redis.del(FAILLOG_KEY)
  }

  /** 活跃承诺全量(上限小,逐条取详情可接受) */
  async function listActiveCommitments():Promise<CommitmentData[]>{
    const list=await getPendingList()
    const out:CommitmentData[]=[]
    for(const item of list){
      const c=await getCommitment(item.id)
      if(c&&c.status==='active')out.push(c)
    }
    return out
  }

  return {createCommitment,getCommitment,cancelCommitment,takeDueCommitments,commitRunOutcome,requeueForRetry,listActiveCommitments,appendFailLog,readFailLog,clearFailLog}
}
