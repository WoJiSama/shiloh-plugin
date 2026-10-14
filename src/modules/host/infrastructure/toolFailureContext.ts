import type {ExecutionEvent,ExecutionSession,ExecutionMessage} from '../../../contracts/toolExecution.js'
import type {FinalEvent,FinalSession} from '../../conversation/application/finalReply.js'
import {decodeReplyEvent} from './hostEvent.js'
export interface ToolFailureContext {factualReply?:string;error?:unknown;messages?:ExecutionMessage[];e?:ExecutionEvent;session?:ExecutionSession}
function record(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}
export function normalizeFailureMessages(messages:ExecutionMessage[]=[]){return messages.map(message=>({role:message.role||'user',content:message.content||'',...(message.tool_call_id?{tool_call_id:message.tool_call_id}:{}),...(message.name?{name:message.name}:{})}))}
export function normalizeFailureSession(session:ExecutionSession):FinalSession {
 // Normalize only the final-reply message view; retain the session identity so reply state writes persist.
 const messages=normalizeFailureMessages(session.groupUserMessages)
 return Object.assign(session,{groupUserMessages:messages})
}
export function normalizeFailureEvent(event:ExecutionEvent):FinalEvent {
 const normalized=decodeReplyEvent(event)
 const raw=record(event)
 if(typeof raw.message_id!=='string'&&typeof raw.message_id!=='number')delete raw.message_id
 return normalized
}
