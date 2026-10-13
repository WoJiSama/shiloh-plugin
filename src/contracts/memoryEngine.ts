export type MemoryId = string | number | null | undefined
export interface Claim {authority:string;at:number;by?:string[]}
export interface MemoryAlias extends Claim {text:string;confidence:number;by:string[];superseded:boolean}
export interface MemoryFact extends Claim {text:string;tags:string[];refs:string[];confidence:number;superseded:boolean;embedding:number[]|null;eventAt:number|null;origin:string;heardFrom?:string}
export interface MemoryEntity {qq:string|null;canonicalName:string|null;aliases:MemoryAlias[];facts:MemoryFact[];updatedAt:number}
export interface AliasEntry extends Claim {qq:string;confidence:number;by:string[];createdBy:string;sourceMessageId:string;proposalId:string;display:unknown}
export interface MemoryRedisClient {get(key:string):Promise<unknown>;set(key:string,value:string):Promise<unknown>;del(key:string):Promise<unknown>}
export function memoryRecord(value:unknown):Record<string,unknown> {return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}
export interface MemoryLlmConfig {memoryAiConfig?:{memoryAiUrl?:string;memoryAiApikey?:string;memoryAiModel?:string};[key:string]:unknown}
export interface MemoryLlmPorts {call(input:{url?:string|undefined;apikey?:string|undefined;model:string;messages:{role:string;content:string}[];temperature:number;maxTokens:number;timeoutMs:number}):Promise<{ok:boolean;error?:string;content?:string}>;logger?:{warn?(message:string):void}}
export interface GroupMember {user_id?:MemoryId;card?:string;nickname?:string}
export interface KnowledgeEntry {subjectKey?:string;condition?:string;conditionKey?:string;ownerDisplay?:string;sourceText?:string;sourceMessageId?:string;proposalId?:string;targetUserIds?:string[];id?:string;kind?:string;subject?:string;aliases?:string[];ownerQQ?:MemoryId;targets?:{userId:string;displayName?:string}[];resource?:{fileName?:string;folderPath?:string;fileId?:string;origin?:string}|null;enabled?:boolean;createdBy?:MemoryId;at?:number;updatedAt?:number}
export interface KnowledgeContext {memberMap?:Map<unknown,GroupMember>;botId?:string;creatorQQ?:MemoryId;creatorDisplay?:string;text?:string;sourceMessageId?:MemoryId;now?:number;fileAssets?:Record<string,unknown>[]}
export interface WorkflowRule {subject?:string;subjectKey?:string;conditionKey?:string;createdBy?:MemoryId;ownerQQ?:MemoryId;ownerDisplay?:string;sourceText?:string;sourceMessageId?:string;proposalId?:string;id?:string;kind?:string;condition?:string;targetUserIds?:string[];targets?:{userId:string;displayName?:string}[];enabled?:boolean;at?:number;updatedAt?:number}
