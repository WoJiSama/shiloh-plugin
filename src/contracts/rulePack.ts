export type RuleValue=string|number|boolean|null
export interface RuleActor {kind:string;id:string;name:string;role:string;self:boolean}
export interface RuleMember {user_id?:string|number|undefined;card?:string;nickname?:string;role?:string}
export interface RuleEvent {user_id?:string|number|undefined;group_id?:string|number|undefined;sender?:RuleMember;isMaster?:boolean;group?:{getMemberMap?():Promise<unknown>};getReply?():Promise<unknown>}
export interface RuleStored {values:Record<string,unknown>;_packageVersion?:string;version?:string;updatedAt?:string;statuses?:Record<string,RuleStatusState>;inventory?:Record<string,RuleItemState>;abilities?:Record<string,RuleAbilityState>}
export interface RuleStatusState {remaining?:number;id?:string|undefined;stacks:number;duration:number|null;appliedAt?:string;source?:string}
export interface RuleItemState {quantity:number;equipped?:boolean;slot?:string}
export interface RuleAbilityState {learned?:boolean;rank:number;cooldown:number;uses?:number}
export interface RuleNpc {id?:string;name:string;ruleData?:RuleStored|null;createdBy?:string;createdAt?:string}
export interface RuleInitiative {kind:string;id:string;name:string;role?:string;self?:boolean;value:number}
export interface RuleSession {previousPhase?:string;logOwned?:boolean;logFile?:string;id?:string;campaignId?:string;paused?:boolean;startedAt?:string;startedBy?:string;endedAt?:string;endedBy?:string;active:boolean;title:string;round:number;turn:number;phase:string;initiative:RuleInitiative[];current:RuleInitiative|null}
export interface RuleGroupState {roles:Record<string,string>;npcs:Record<string,RuleNpc>;group:RuleStored;session:RuleSession;audit:RuleAudit[];privateDeliveries:RulePrivateDelivery[];sessions:RuleSession[];campaigns:Record<string,RuleCampaign>;activeCampaignId:string;snapshots:RuleSnapshot[]}
export interface RuleState {groups:Record<string,{diceRuleSessions?:Record<string,RuleGroupState>}>}
export interface RuleCardScope {_scopeVersion:2;groups:Record<string,RuleStored>;migratedAt?:string}
export interface RuleCampaign {id:string;name:string;status:string;createdAt:string;createdBy:string;members:Record<string,{userId:string;name:string;character:string;joinedAt:string}>;chapters:{id:string;title:string;startedAt:string;startedBy:string;endedAt:string}[];records:{id:string;type:string;content:string;at:string;by:string}[];sessions:string[]}
export interface RuleAudit {id:string;at:string;packId:string;packageVersion:string;command:string;visibility:string;invoker:{id:string;name:string};targets:unknown;seed:string;actions:unknown;output:string;[key:string]:unknown}
export interface RulePrivateDelivery {deliveryId:string;userId:string;text:string;createdAt:string;attempts:number;lastError:string;lastAttemptAt?:string;state?:"sent"|"failed"|"unknown";sentAt?:string}
export interface RuleSnapshot {id:string;name:string;createdAt:string;createdBy:string;group:RuleStored;npcs:Record<string,RuleNpc>;session:RuleSession;players:Record<string,RuleStored>}
