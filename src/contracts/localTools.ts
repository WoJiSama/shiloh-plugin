import type {ToolManifest,ToolSkillSource} from './toolExecution.js'
export interface LocalToolInfo {name:string;description:string;parameters:{type:string;properties:Record<string,unknown>;required?:unknown[]}}
export interface RegisteredLocalTool extends Omit<ToolSkillSource,'name'|'description'|'parameters'>,LocalToolInfo {execute(params:Record<string,unknown>,event:unknown):unknown;manifest?:ToolManifest;recoverDurableJobs?():Promise<unknown>;getToolInfo?():LocalToolInfo}
export interface LocalRegistryOptions {pluginRoot?:string;customToolsDir?:string;reloadIntervalMs?:number}
export interface LocalRegistryPorts {factories:(()=>unknown)[];logger:{info(message:string):void;warn(message:string):void;error(message:string,error?:unknown):void}}
