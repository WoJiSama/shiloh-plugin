import type {DrawOptions,DrawEvent,DrawRecord} from '../../../contracts/bananaTool.js'
import {toolRecord} from '../../../contracts/toolExecution.js'
export function parseDrawOptions(value:unknown):DrawOptions {
 const raw=toolRecord(value),opts:DrawOptions={...raw}
 for(const key of ['prompt','provider','aspectRatio','referencePurpose','progressText','agentContext'] as const){if(typeof raw[key]==='string')opts[key]=raw[key];else delete opts[key]}
 if(Array.isArray(raw.images))opts.images=raw.images.filter((image):image is string=>typeof image==='string')
 else if(typeof raw.images==='string')opts.images=raw.images
 else delete opts.images
 return opts
}
export function parseDrawEvent(value:unknown):DrawEvent {
 const raw=toolRecord(value)
 if(typeof raw.reply!=='function')throw new Error('绘图事件缺少 reply 接口')
 // Live host events carry prototype methods; validate accessed scalar/container boundaries.
 for(const key of ['group_id','user_id','self_id','message_id'] as const){if(raw[key]!==undefined&&raw[key]!==null&&typeof raw[key]!=='string'&&typeof raw[key]!=='number')throw new Error(`无效事件标识 ${key}`)}
 for(const key of ['msg','raw_message','nickname','message_type'] as const){if(raw[key]!==undefined&&typeof raw[key]!=='string')throw new Error(`无效事件文本 ${key}`)}
 if(raw.sender!==undefined){const sender=toolRecord(raw.sender);for(const key of ['nickname','card'] as const){if(sender[key]!==undefined&&typeof sender[key]!=='string')throw new Error(`无效发送者 ${key}`)}}
 if(raw.bot!==undefined&&raw.bot!==null){
  const bot=toolRecord(raw.bot)
  for(const key of ['pickGroup','pickFriend','sendApi'] as const){if(bot[key]!==undefined&&typeof bot[key]!=='function')throw new Error(`无效机器人接口 ${key}`)}
 }
 const sender=toolRecord(raw.sender)
 if(sender.user_id!==undefined&&typeof sender.user_id!=='string'&&typeof sender.user_id!=='number')throw new Error('无效发送者标识')
 if(raw._progressReplyState!==undefined){const state=toolRecord(raw._progressReplyState);for(const key of ['sent','reserved'] as const){if(state[key]!==undefined&&typeof state[key]!=='boolean')throw new Error('无效进度状态')}}
 return value as DrawEvent
}
export function parseDrawRecord(value:unknown):DrawRecord|null {
 const raw=toolRecord(value)
 if(typeof raw.id!=='string'||!raw.id||typeof raw.scopeKey!=='string'||!raw.scopeKey)return null
 const sender=toolRecord(raw.sender)
 return {id:raw.id,opts:parseDrawOptions(raw.opts),scopeKey:raw.scopeKey,requesterName:String(raw.requesterName||''),requesterId:String(raw.requesterId||raw.userId||''),userId:String(raw.userId||raw.requesterId||''),groupId:String(raw.groupId||''),messageId:String(raw.messageId||''),messageType:String(raw.messageType||''),selfId:String(raw.selfId||''),sender:{nickname:String(sender.nickname||''),card:String(sender.card||'')},queuedAt:typeof raw.queuedAt==='number'?raw.queuedAt:Date.now(),notifyFailure:raw.notifyFailure===true,skipProgressNotice:raw.skipProgressNotice===true}
}
