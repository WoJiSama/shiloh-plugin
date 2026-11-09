// 承诺账本纯函数:时间归一/顺延/上限/卡片渲染。全部显式传入 now,不碰环境。
import type {CommitmentData,CommitmentSchedule,CommitmentConfigSection} from '../../../contracts/commitments.js'

const DAY_MS=86400_000
const SHANGHAI_OFFSET_MS=8*3600_000

export function resolvedCommitmentConfig(section:CommitmentConfigSection = {}):Required<CommitmentConfigSection> {
  return {
    maxActivePerGroup: clampInt(section.maxActivePerGroup,1,50,10),
    maxPerCreator: clampInt(section.maxPerCreator,1,20,5),
    defaultExpiryDays: clampInt(section.defaultExpiryDays,1,365,30)
  }
}

function clampInt(value:unknown,min:number,max:number,fallback:number):number {
  const num=Number(value)
  if(!Number.isFinite(num))return fallback
  return Math.min(max,Math.max(min,Math.round(num)))
}

/** daily 时刻(HH:mm)→ 下一次执行的绝对时间(北京时间语义,UTC+8 无夏令时) */
export function computeNextDailyRun(hhmm:string,now:number):number|null {
  const match=/^(\d{1,2}):(\d{2})$/.exec(String(hhmm||'').trim())
  if(!match)return null
  const hour=Number(match[1]),minute=Number(match[2])
  if(hour>23||minute>59)return null
  const shifted=new Date(now+SHANGHAI_OFFSET_MS)
  shifted.setUTCHours(hour,minute,0,0)
  let next=shifted.getTime()-SHANGHAI_OFFSET_MS
  if(next<=now)next+=DAY_MS
  return next
}

/** once 时刻:ISO 8601(缺时区按北京时间补 +08:00)或毫秒时间戳 → 绝对时间 */
export function parseOnceTime(input:unknown):number|null {
  if(typeof input==='number'&&Number.isFinite(input))return input>0?input:null
  const text=String(input||'').trim()
  if(!text)return null
  const withZone=/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)?text:`${text}+08:00`
  const parsed=Date.parse(withZone)
  return Number.isFinite(parsed)?parsed:null
}

export function normalizeSchedule(kind:unknown,time:unknown,now:number):{schedule:CommitmentSchedule;nextRunAt:number}|{error:string} {
  const kindText=String(kind||'').trim()
  if(kindText==='daily'){
    const hhmm=String(time||'').trim().replace(/^(\d{1,2}):(\d)$/,'$1:0$2')
    const next=computeNextDailyRun(hhmm,now)
    if(next===null)return {error:`每日循环的时刻格式不对（要 HH:mm，24小时制），收到的是「${String(time||'')}」`}
    return {schedule:{kind:'daily',time:hhmm},nextRunAt:next}
  }
  if(kindText==='once'){
    const at=parseOnceTime(time)
    if(at===null)return {error:`一次性任务的时间没法解析（要 ISO 8601，比如 2026-11-10T12:00:00+08:00），收到的是「${String(time||'')}」`}
    if(at<=now+30_000)return {error:'一次性任务的时间已经过去（或就在半分钟内），定一个将来的时间'}
    return {schedule:{kind:'once',time:at},nextRunAt:at}
  }
  return {error:'schedule_kind 只能是 once（一次）或 daily（每天）'}
}

export function checkCommitmentCaps(active:CommitmentData[],groupId:string,creatorId:string,cfg:Required<CommitmentConfigSection>):string|null {
  const groupActive=active.filter(c=>c.group_id===groupId&&c.status==='active')
  if(groupActive.length>=cfg.maxActivePerGroup)return `这个群的定时任务已经满了（上限 ${cfg.maxActivePerGroup} 个），先取消一个再加`
  const mine=groupActive.filter(c=>c.creator_id===creatorId)
  if(mine.length>=cfg.maxPerCreator)return `你名下的定时任务已经满了（每人上限 ${cfg.maxPerCreator} 个）`
  return null
}

export function isCommitmentExpired(c:CommitmentData,now:number):boolean {
  return c.expiry_at>0&&now>=c.expiry_at
}

/** 到期前 3 天进入续约问询窗;只问一次(renewal_asked_at 持久化),对方不回应就自然过期 */
export const RENEWAL_LEAD_MS=3*86400_000
const RENEWAL_LINE_SUFFIX_MS=7*86400_000

export function daysUntilExpiry(c:CommitmentData,now:number):number {
  return c.expiry_at>0?Math.max(0,Math.ceil((c.expiry_at-now)/86400_000)):0
}

export function shouldAskRenewal(c:CommitmentData,now:number):boolean {
  if(c.status!=='active'||c.expiry_at<=0)return false
  if(now<c.expiry_at-RENEWAL_LEAD_MS)return false
  if(now>=c.expiry_at)return false
  return !c.renewal_asked_at
}

/** 续约问询的仿真唤醒卡:agent 据此自然地问创建人,用户答应就 renew */
export function renderRenewalCard(c:CommitmentData,now:number):string {
  const days=daysUntilExpiry(c,now)
  return `${c.creator_name||c.creator_id} 托付的「${c.intent}」还有 ${days} 天到期（到期就不再执行）。自然地问 TA 还要不要继续：要续就调 commitmentTool（action=renew，commitment_id 用 list 查）；TA 没接话或没回应就当默认到期，不再追问。`
}

/** static/非仿真群的续约问询直发文案(出站前仍经 sanitize) */
export function buildRenewalAskText(c:CommitmentData,now:number):string {
  return `你托付的「${c.intent.slice(0,80)}」还有 ${daysUntilExpiry(c,now)} 天到期，到期就不再执行了——要继续的话跟我说一声「续」就行`
}

/** 失约明说:重试超限转 failed 时向群坦白(失败可见 > 失约本身伤信任) */
export function buildMissAdmissionText(c:CommitmentData,reason:string):string {
  const clean=String(reason||'原因不明').slice(0,80)
  return `你托付的「${c.intent.slice(0,80)}」这次没办成：${clean}。已停手不再重试了，还需要的话跟我说一声重新安排`
}

/** 执行后顺延:daily=下次同时刻;once=完结。拿不到下次时刻按失败收尾(P1 明说)。 */
export function advanceCommitmentAfterRun(c:CommitmentData,now:number):{nextRunAt:number|null;status:CommitmentData['status']} {
  if(c.schedule.kind==='daily'){
    const next=computeNextDailyRun(c.schedule.time,now)
    return next!==null?{nextRunAt:next,status:'active'}:{nextRunAt:null,status:'failed'}
  }
  return {nextRunAt:null,status:'completed'}
}

export function formatBeijingClock(at:number):string {
  return new Date(at+SHANGHAI_OFFSET_MS).toISOString().slice(5,16).replace('T',' ')
}

export function formatScheduleText(s:CommitmentSchedule):string {
  return s.kind==='daily'?`每天 ${s.time}`:formatBeijingClock(s.time)
}

/** 承诺到期卡片:注入仿真唤醒 prompt 的 reason detail,agent 据此兑现 */
export function renderCommitmentCard(c:CommitmentData):string {
  const deliverText=c.deliver==='agent'?'需要你自己动手完成':`到点直接发：「${c.static_message||''}」`
  return `${c.creator_name||c.creator_id} 托付的事：「${c.intent}」（${formatScheduleText(c.schedule)}，${deliverText}）。`
}

export function formatCommitmentLine(c:CommitmentData,now:number):string {
  const nearExpiry=c.status==='active'&&c.expiry_at>0&&c.expiry_at-now<=RENEWAL_LINE_SUFFIX_MS&&c.expiry_at>now
    ?`（${daysUntilExpiry(c,now)} 天后到期）`:''
  const tail=c.status!=='active'
    ?`【${c.status}${c.last_result?`：${c.last_result.slice(0,40)}`:''}】`
    :c.next_run_at>now?`下次 ${formatBeijingClock(c.next_run_at)}`:'马上执行'
  return `- [${c.id.slice(4,14)}] ${formatScheduleText(c.schedule)}「${c.intent.slice(0,60)}」${nearExpiry} 创建人:${c.creator_name||c.creator_id} ${tail}`
}
