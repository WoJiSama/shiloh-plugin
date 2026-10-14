import type {ChatTurnEvent,ChatTurnMember,ChatGroup,ChatId} from '../../../contracts/chatTurn.js'
import type {ReplyEvent} from '../../conversation/application/replyRendering.js'
function object(value:unknown,label:string):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label}不是有效对象`);return value as Record<string,unknown>}
function id(value:unknown):ChatId|undefined {return typeof value==='string'||typeof value==='number'?value:undefined}
function member(value:unknown):ChatTurnMember {const raw=object(value,'群成员');const result:ChatTurnMember={};for(const key of ['card','nickname','role','title','group_name'] as const)if(typeof raw[key]==='string')result[key]=raw[key];const uid=id(raw.user_id);if(uid!==undefined)result.user_id=uid;return result}
function memberMap(value:unknown):Map<number,ChatTurnMember>{if(!(value instanceof Map))throw new Error('群成员接口未返回Map');const output=new Map<number,ChatTurnMember>();for(const [key,valueMember] of value){const number=Number(key);if(!Number.isFinite(number))continue;output.set(number,member(valueMember))}return output}
function group(value:unknown):ChatGroup {const raw=object(value,'群');const getMembers=raw.getMemberMap,pick=raw.pickMember;if(typeof getMembers!=='function'||typeof pick!=='function')throw new Error('群接口缺少getMemberMap或pickMember');return Object.assign(raw,{getMemberMap:async()=>memberMap(await Reflect.apply(getMembers,value,[])),pickMember:(userId:ChatId|null|undefined)=>{const selected=object(Reflect.apply(pick,value,[userId]),'群成员句柄');return Object.assign(selected,{info:Promise.resolve(selected.info).then(member)})}})}
/** Normalize in place so host lifecycle flags and downstream mutations keep one identity. */
export function normalizeHostChatEvent(input:unknown,fallbackBot:unknown):ChatTurnEvent & ReplyEvent {
 const raw=object(input,'消息事件');const reply=raw.reply;if(typeof reply!=='function')throw new Error('消息事件缺少reply接口');
 const botValue=raw.bot ?? fallbackBot,botRaw=object(botValue,'机器人');const pick=botRaw.pickGroup;if(typeof pick!=='function')throw new Error('机器人缺少pickGroup接口');
 for(const key of ['uin'] as const){const value=id(botRaw[key]);if(value===undefined)delete botRaw[key];else botRaw[key]=value}
 if(botRaw.nickname!==undefined&&typeof botRaw.nickname!=='string')delete botRaw.nickname;
 const normalizedBot=Object.assign(botRaw,{pickGroup:(groupId:ChatId|undefined)=>group(Reflect.apply(pick,botValue,[groupId]))});
 const sender=raw.sender===undefined?{}:member(raw.sender);
 const normalized=Object.assign(raw,{sender,bot:normalizedBot,reply:async(payload:unknown,quote?:boolean):Promise<unknown>=>Reflect.apply(reply,input,[payload,quote]) as unknown});
 for(const key of ['group_id','user_id','self_id'] as const){const value=id(raw[key]);if(value===undefined)delete raw[key];else raw[key]=value}
 if(typeof raw.msg!=='string')raw.msg=String(raw.msg||'');
 if(raw.group!==undefined)raw.group=group(raw.group);
 // Known transport fields are validated at the host boundary; unknown lifecycle fields remain attached.
 if(raw.message!==undefined){if(!Array.isArray(raw.message))throw new Error('消息分段不是数组');raw.message=raw.message.map(segment=>{if(typeof segment==='string')return {type:'text',text:segment};const item=object(segment,'消息分段');if(item.type!==undefined&&typeof item.type!=='string')throw new Error('消息分段类型无效');if(item.text!==undefined&&typeof item.text!=='string')throw new Error('消息分段文本无效');if(item.data!==undefined)object(item.data,'消息分段data');return item})}
 if(typeof raw.getReply==='function'){const getReply=raw.getReply;raw.getReply=async()=>{const quoted:unknown=await Reflect.apply(getReply,input,[]);return quoted==null?null:object(quoted,'引用消息')}}
 return normalized
}
/** Minimal send adapter also preserves receiver binding and identity. */
export function decodeReplyEvent(input:unknown):ReplyEvent {
 const raw=object(input,'回复事件'),reply=raw.reply;if(typeof reply!=='function')throw new Error('回复事件缺少reply接口');
 for(const key of ['group_id','user_id','self_id'] as const){const value=id(raw[key]);if(value===undefined)delete raw[key];else raw[key]=value}
 if(raw.group!==undefined){const groupRaw=object(raw.group,'群'),getMembers=groupRaw.getMemberMap;if(typeof getMembers!=='function')throw new Error('群接口缺少getMemberMap');Object.assign(groupRaw,{getMemberMap:async()=>memberMap(await Reflect.apply(getMembers,groupRaw,[]))})}
 return Object.assign(raw,{reply:async(payload:unknown,quote?:boolean):Promise<unknown>=>Reflect.apply(reply,input,[payload,quote]) as unknown})
}
