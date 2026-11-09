// 委托记忆纯函数:归一/上限/召回匹配/唤醒注入段。全部显式传参,不碰环境。
import type {DelegatedMemoryConfigSection,DelegatedMemoryEntry} from '../../../contracts/delegatedMemory.js'

export function resolvedDelegatedConfig(section:DelegatedMemoryConfigSection = {}):Required<DelegatedMemoryConfigSection> {
  const clamp=(value:unknown,min:number,max:number,fallback:number)=>{
    const num=Number(value)
    if(!Number.isFinite(num))return fallback
    return Math.min(max,Math.max(min,Math.round(num)))
  }
  return {maxPerGroup:clamp(section.maxPerGroup,1,200,50),maxPerOwner:clamp(section.maxPerOwner,1,50,20)}
}

export function normalizeDelegatedEntry(value:unknown,now:number):DelegatedMemoryEntry|null {
  if(value===null||typeof value!=='object'||Array.isArray(value))return null
  const r=value as Record<string,unknown>
  if(typeof r.id!=='string'||typeof r.owner!=='string'||typeof r.content!=='string'||!r.content.trim())return null
  return {
    id:r.id,owner:r.owner,ownerName:String(r.ownerName||''),
    content:r.content.slice(0,300),
    dueAt:Number(r.dueAt)||0,
    status:r.status==='done'?'done':'active',
    createdAt:Number(r.createdAt)||now,updatedAt:Number(r.updatedAt)||now
  }
}

export function normalizeDelegatedEntries(values:unknown[],now:number):DelegatedMemoryEntry[] {
  return (Array.isArray(values)?values:[]).map(v=>normalizeDelegatedEntry(v,now)).filter((e):e is DelegatedMemoryEntry=>e!==null)
}

export function checkDelegatedCaps(entries:DelegatedMemoryEntry[],owner:string,cfg:Required<DelegatedMemoryConfigSection>):string|null {
  const active=entries.filter(e=>e.status==='active')
  if(active.length>=cfg.maxPerGroup)return `我替这个群记的事已经满了（上限 ${cfg.maxPerGroup} 条），先让我忘掉一条再记`
  const mine=active.filter(e=>e.owner===owner)
  if(mine.length>=cfg.maxPerOwner)return `我替你记的事已经满了（每人上限 ${cfg.maxPerOwner} 条），先让我忘掉一条`
  return null
}

/** 召回匹配:查询词按非空白切段,命中段数多的靠前;无查询词=不匹配(由调用方走全量列表) */
export function scoreDelegatedMatch(entry:DelegatedMemoryEntry,query:string):number {
  const text=`${entry.content} ${entry.ownerName}`.toLowerCase()
  const tokens=String(query||'').toLowerCase().split(/[\s,，。、;；?？!！]+/).map(t=>t.trim()).filter(t=>t.length>=1)
  if(!tokens.length)return 0
  return tokens.reduce((score,token)=>score+(text.includes(token)?1:0),0)
}

function beijingDate(at:number):string {
  return new Date(at+8*3600_000).toISOString().slice(5,10)
}

export function formatDelegatedLine(entry:DelegatedMemoryEntry,now:number):string {
  const dueNote=entry.dueAt>0?(now>=entry.dueAt?'（到点了，看情况自然提一嘴）':`（${beijingDate(entry.dueAt)} 到期）`):''
  return `- ${entry.ownerName||entry.owner} 记于 ${beijingDate(entry.createdAt)}：「${entry.content}」${dueNote}`
}

/** 唤醒 prompt 注入段:在场群友的托付优先,到期的高亮;无活跃条目返回空串(不注入) */
export function formatDelegatedSection(entries:DelegatedMemoryEntry[],now:number,speakerIds:string[]=[]):string {
  const active=entries.filter(e=>e.status==='active')
  if(!active.length)return ''
  const speakers=new Set(speakerIds.map(String))
  const ranked=[...active].sort((a,b)=>{
    const aDue=a.dueAt>0&&now>=a.dueAt?1:0,bDue=b.dueAt>0&&now>=b.dueAt?1:0
    if(aDue!==bDue)return bDue-aDue
    const aIn=speakers.has(a.owner)?1:0,bIn=speakers.has(b.owner)?1:0
    if(aIn!==bIn)return bIn-aIn
    return b.createdAt-a.createdAt
  }).slice(0,8)
  const lines=[
    '【群友托付的事】你替群友记着的原话——他们问起要答得出原文，答不出就说记岔了别编；标了"到点"的看气氛自然提一句，别硬提醒：',
    ...ranked.map(e=>formatDelegatedLine(e,now))
  ]
  return lines.join('\n')
}
