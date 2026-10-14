import type {QqToolBot,QqToolEvent,QqToolPorts} from '../../../contracts/qqTools.js'
export function asRecord(value:unknown):Record<string,unknown>{return value!==null && typeof value==='object' && !Array.isArray(value)?value as Record<string,unknown>:{}}
export function errorText(error:unknown):string{return error instanceof Error?error.message:String(error)}
export function apiOk(value:unknown):boolean{const r=asRecord(value);return value===true || ((r.status==='ok'||r.retcode===0||r.code===0) && r.status!=='failed' && (r.retcode===undefined||r.retcode===0) && (r.code===undefined||r.code===0))}
export function eventBot(event:QqToolEvent,ports:QqToolPorts):QqToolBot{const bot=event.bot??ports.getBot();if(!bot)throw new Error('未找到事件机器人');return bot}
