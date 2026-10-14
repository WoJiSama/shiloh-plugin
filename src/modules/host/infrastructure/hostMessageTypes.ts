import type {MediaSegment} from '../../../contracts/mediaRelay.js'
import type {createArchiveManagerClass} from '../../messaging/infrastructure/messageArchive.js'
import type {createMessageManagerClass} from '../../messaging/application/recentMessages.js'
import type {RecentOptions} from '../../../contracts/recentMessages.js'
import type {createDeliveryGatewayModule} from '../../messaging/infrastructure/deliveryGateway.js'
export type HostPluginBase=new(options:Record<string,unknown>)=>object
export type ArchiveManager=InstanceType<ReturnType<typeof createArchiveManagerClass>>
export type ArchiveRecord=Awaited<ReturnType<ArchiveManager['query']>>[number]
export type ArchiveContext=NonNullable<NonNullable<Parameters<ArchiveManager['formatRecord']>[1]>['context']>
export interface HostGroup {name?:string;getForwardMsg?(id:string):Promise<unknown>;getMemberMap?():Promise<Map<string|number,{nickname?:string;card?:string}>>;makeForwardMsg?(nodes:unknown[]):Promise<unknown>;sendFile?(file:string,name:string):Promise<unknown>}
export interface HostBot {uin?:string|number;sendApi(method:string,params:object):Promise<unknown>}
export interface HostEvent {msg:string;group_id?:string|number;user_id?:string|number;self_id?:string|number;isMaster?:boolean;sender?:{user_id?:string|number;nickname?:string;card?:string;role?:string};reply_id?:unknown;source?:{message_id?:unknown;seq?:unknown};message_id?:unknown;message?:unknown[];raw_message?:string;bot?:HostBot;group?:HostGroup;friend?:HostGroup;reply(message:unknown,quote?:boolean):Promise<unknown>}
export interface HostLogger {warn(message:string):void;error(message:string):void;info(message:string):void}
export interface ArchiveSearch {type:string;groupId:string;limit:number;around:number;contextAround?:number;qq?:string;keyword?:string;regex?:string;messageId?:string}
export interface PipelineJob {state?:string;envelope?:{groupId?:unknown};groupId?:unknown;lastError?:unknown;uncertain?:boolean;updatedAt?:number;id?:string}
export interface MessageHostPorts {MessageManager:new(options:RecentOptions)=>InstanceType<ReturnType<typeof createMessageManagerClass>>;archiveManager:ArchiveManager;getBase64Image(url:string,name:string):Promise<unknown>;getBot():HostBot;logger:HostLogger;segment:{image(value:unknown):MediaSegment;video?(file:string):MediaSegment;record?(file:string):unknown};getInstalledMessagePipeline():{store?:{list(kind:string):Promise<PipelineJob[]>};unavailableReason?:string;config?:{enabled?:boolean};pipeline?:{stopped?:boolean}}|null|undefined;sendCompleteLocalFile:ReturnType<typeof createDeliveryGatewayModule>['sendCompleteLocalFile']}
export interface ReplayNode {user_id:string|number;nickname:string;time?:unknown;message:unknown[]}
export interface HostConfig {pluginSettings:Record<string,unknown>}
export function hostRecord(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}
export function hostError(value:unknown):string{return value instanceof Error?value.message:String(value)}
