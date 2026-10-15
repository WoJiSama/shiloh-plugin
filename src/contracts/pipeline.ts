export interface RedisJobClient {
 get?(key: string): Promise<unknown>
 set?(key: string,value:string,options:Record<string,unknown>):Promise<unknown>
 del?(key:string):Promise<unknown>
 eval?(script:string,options:{keys:string[];arguments:string[]}):Promise<unknown>
 scanIterator?(options:{MATCH:string;COUNT:number}):AsyncIterable<unknown>
 scan?(cursor:string,...args:(string|number)[]):Promise<[string|number,string[]]>
 keys?(pattern:string):Promise<string[]>
}
export interface PipelineLogger { info?(message:string):void; warn?(message:string):void }
export interface MessageSegment { type?: string; url?: string; qq?: unknown; data?: Record<string,unknown>; [field:string]:unknown }
export interface EventEnvelope { version:number; eventId:string; postType:string; messageType:string; noticeType:string; subType:string; botId:string; conversationType:string; conversationId:string; groupId:string; groupName:string; userId:string; messageId:string; occurredAt:number; capturedAt:number; rawMessage:string; message:MessageSegment[]; sender:unknown; source:unknown; operatorId:string; targetId:string; adapterId:string; adapterName:string; forwardContext?:ForwardContext;forwardContextFailure?:import('./forwardContext.js').ForwardCompleteness }
export interface ForwardContext {text?:string;forwardIds?:unknown[];media?:unknown[];forwardNodes?:unknown[];completeness?:import('./forwardContext.js').ForwardCompleteness}
export interface EventJob {version:number;id:string;envelope:EventEnvelope;state:string;attempts:number;consumers:Record<string,string>;createdAt:number;updatedAt:number;nextRetryAt:number;leaseUntil:number;ownerRunId:string;lastError:string}
