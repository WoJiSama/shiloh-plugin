import {createReplyRendering} from '../../dist/backend/modules/conversation/application/replyRendering.js'
import {createForbiddenWordGuard} from '../../dist/backend/modules/conversation/domain/forbiddenWordGuard.js'
export function replyRenderingFixture(overrides={}) {
 const sent=[], guarded=[]
 const api=createReplyRendering({logger:{info(){},warn(){},mark(){},error(){}},bot:()=>({uin:99,nickname:'bot'}),at:qq=>({type:'at',qq}),lastIncoming:()=>0,shouldCancelProactiveReply:()=>false,guard:createForbiddenWordGuard({warn(){}}),applyOutputPersonaGuards:(text)=>{guarded.push(text);return text+'守卫'},TotalTokens:async()=>({total_tokens:5}),stats:()=>null,...overrides})
 const host={config:{replyRhythm:{enabled:false},sendPacing:{enabled:false}},splitMessage:text=>[text],convertAtInString:async()=>({hasAt:false,msgSegments:null})}
 host.sendObservedReply=(...args)=>api.sendObservedReply(host,...args)
 const event={group_id:1,user_id:2,self_id:99,msg:'hi',reply:async payload=>{sent.push(payload);return {message_id:sent.length}}}
 return {api,host,event,sent,guarded}
}
