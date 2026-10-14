import type {ExecutionMessage,ToolCall} from '../../../contracts/toolExecution.js'
export interface HostModelResponse {error?:unknown;choices?:{message?:ExecutionMessage;[key:string]:unknown}[];usage?:{total_tokens?:number;[key:string]:unknown};[key:string]:unknown}
function object(value:unknown,label:string):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label} must be an object`);return value as Record<string,unknown>}
function message(value:unknown):ExecutionMessage {
 const raw=object(value,'Model message');const result:ExecutionMessage={}
 for(const key of ['role','name','reasoning_content','tool_call_id'] as const){const value=raw[key];if(value===undefined||value===null)continue;if(typeof value!=='string')throw new Error(`Model message ${key} must be text`);result[key]=value}
 if(raw.content!==undefined&&raw.content!==null){if(typeof raw.content!=='string')throw new Error('Model message content must be text or null');result.content=raw.content}
 if(raw.tool_calls!==undefined){if(!Array.isArray(raw.tool_calls))throw new Error('Model tool_calls must be an array');result.tool_calls=raw.tool_calls.map((value:unknown):ToolCall=>{
  const raw=object(value,'Tool call');const call:ToolCall={...raw}
  for(const key of ['id','type'] as const){if(raw[key]!==undefined&&typeof raw[key]!=='string')throw new Error(`Tool call ${key} must be text`);if(typeof raw[key]==='string')call[key]=raw[key]}
  if(raw.function!==undefined){const fn=object(raw.function,'Tool function');const decoded:{name?:string;arguments?:string}={};for(const key of ['name','arguments'] as const){if(fn[key]!==undefined&&typeof fn[key]!=='string')throw new Error(`Tool function ${key} must be text`);if(typeof fn[key]==='string')decoded[key]=fn[key]}call.function=decoded}
  return call
 })}
 return result
}
export function decodeHostModelResponse(value:unknown):HostModelResponse {
 const raw=object(value,'Model response');const result:HostModelResponse={...raw}
 if(raw.choices!==undefined){if(!Array.isArray(raw.choices))throw new Error('Model choices must be an array');result.choices=raw.choices.map((value:unknown)=>{const choice=object(value,'Model choice');return {...choice,...choice.message===undefined?{}:{message:message(choice.message)}}})}
 if(raw.usage!==undefined&&raw.usage!==null){const usage=object(raw.usage,'Model usage');if(usage.total_tokens!==undefined&&(typeof usage.total_tokens!=='number'||!Number.isFinite(usage.total_tokens)))throw new Error('Model token usage must be finite');result.usage={...usage,...typeof usage.total_tokens==='number'?{total_tokens:usage.total_tokens}:{}}}else delete result.usage
 return result
}
