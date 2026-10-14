import {safeTruncateUnicode} from '../../models/domain/unicodeText.js'
export interface HostGroupEvent {group_id?:string|number;group_name?:string;bot?:{uin?:string|number;sendApi?(action:string,params:Record<string,unknown>):Promise<unknown>};group?:{group_name?:string;name?:string;info?:{group_name?:string;name?:string}}}
export interface GroupContext {groupId:string;groupName:string;groupNotice:string}
const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'?value as Record<string,unknown>:{}
export function createHostGroupContext(ports:{getBot():HostGroupEvent['bot'];debug(message:string):void}){
 const cache=new Map<string,{at:number;data:GroupContext}>()
 async function callOneBotApi(e:HostGroupEvent,action:string,params:Record<string,unknown>={}){const bot=e.bot||ports.getBot();if(!bot?.sendApi)throw new Error('找不到 OneBot API 调用接口');return await bot.sendApi(action,params)}
 function normalizeGroupContextText(value:unknown,maxLength=800){return safeTruncateUnicode(String(value||'').replace(/\r\n/g,'\n').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim(),maxLength)}
 function pickNoticeText(value:unknown,seen=new Set<object>(),depth=0):string{
  if(!value||depth>24)return '';if(typeof value==='string')return value;if(typeof value!=='object'||seen.has(value))return '';seen.add(value)
  if(Array.isArray(value))return value.map(item=>pickNoticeText(item,seen,depth+1)).filter(Boolean).join('')
  for(const key of ['content','text','msg','message','notice','title','data']){const text=pickNoticeText(record(value)[key],seen,depth+1);if(text)return text}return ''
 }
 function extractGroupNoticeText(response:unknown){const payload=record(response).data??response,r=record(payload),notices=Array.isArray(payload)?payload:Array.isArray(r.notices)?r.notices:Array.isArray(r.notice)?r.notice:[payload].filter(Boolean)
  const time=(item:unknown)=>{const r=record(item);return Number(r.publish_time||r.time||r.create_time||r.updated_at||0)}
  for(const notice of notices.slice().sort((a,b)=>time(b)-time(a))){const text=normalizeGroupContextText(pickNoticeText(notice));if(text)return text}return ''
 }
 function getBasicGroupContext(e:HostGroupEvent):GroupContext{return {groupId:String(e.group_id||''),groupName:normalizeGroupContextText(e.group_name||e.group?.group_name||e.group?.name||e.group?.info?.group_name||e.group?.info?.name,120),groupNotice:''}}
 async function getCurrentGroupContext(e:HostGroupEvent):Promise<GroupContext>{const basic=getBasicGroupContext(e);if(!basic.groupId)return basic
  const key=`${e.bot?.uin||ports.getBot()?.uin||''}:${basic.groupId}`,cached=cache.get(key)
  if(cached&&Date.now()-cached.at<300000)return {...cached.data,groupName:basic.groupName}
  let groupNotice='';for(const action of ['get_group_notice','_get_group_notice']){try{groupNotice=extractGroupNoticeText(await callOneBotApi(e,action,{group_id:Number(basic.groupId)}));if(groupNotice)break}catch(error){ports.debug(`[群上下文] ${action} 获取公告失败 group=${basic.groupId}: ${error instanceof Error?error.message:String(error)}`)}}
  const data={...basic,groupNotice};if(cache.size>=1000)cache.delete(cache.keys().next().value||'');cache.set(key,{at:Date.now(),data});return data
 }
 return {callOneBotApi,normalizeGroupContextText,pickNoticeText,extractGroupNoticeText,getBasicGroupContext,getCurrentGroupContext}
}
