import type {HostSharedState} from '../../../host/infrastructure/hostSharedState.js'
import type {createPersonaLibrary} from '../../../conversation/infrastructure/personaLibrary.js'
export interface PluginBridgeInstance {
 config:Record<string,unknown>;
 personaLibrary?:ReturnType<typeof createPersonaLibrary>;
 getPersonaFor?(event:unknown):unknown;
 sendSegmentedMessage?(event:unknown,message:string,interval:number):Promise<unknown>;
 scheduleWaitReply?(event:unknown,seconds:number,reason:unknown):unknown;
 getTaskStatusTtlSeconds?():number;
 updateUserToolTaskStatus?(status:Record<string,unknown>):Promise<unknown>;
 clearUserToolTaskStatus?(status:Record<string,unknown>):Promise<unknown>;
 saveTaskStatus?(status:Record<string,unknown>):Promise<unknown>;
}
export const pluginBridge:{instance:PluginBridgeInstance|null;sharedState:HostSharedState|null}={instance:null,sharedState:null}
