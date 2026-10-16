import type {ActionFactsEvent,ActionFactsQuery,TurnActionFacts,TurnTaskFact} from './turnActionFacts.js'
import type {TurnInteractionContext} from './turnInteraction.js'
export interface ToolCall {id?:string;type?:string;function?:{name?:string;arguments?:string};[key:string]:unknown}
export interface ToolResult {toolName:string;result:unknown;toolCallId?:string}
export type ToolContinuation = 'direct_result'|'chat_only'|'tool_loop'
export interface ToolExecutorPort {execute(name:string,params:Record<string,unknown>,signal?:AbortSignal):Promise<unknown>}
export function toolRecord(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}

export interface ToolIntentContext { hasExcelContext?: boolean; hasPixivSearchSession?: boolean; [key:string]:unknown }
export interface ToolManifest {name?:string; terminal?:boolean; background?:boolean; triggers?:RegExp[]; disclosure?:string; deterministicResolver?:((text:string,context:ToolIntentContext)=>Record<string,unknown>|null)|null; [key:string]:unknown}
export interface RegisteredToolIntentManifest {triggers:RegExp[];disclosure:string;deterministicResolver:((text:string,context:ToolIntentContext)=>Record<string,unknown>|null)|null}
export interface BuiltinManifestPorts {
 getEmojiToolIntentPatterns():RegExp[];
 buildExcelToolParams(text:string,context:{hasExcelContext:boolean}):Record<string,unknown>|null;
 parseModrinthRequestOptions(text:string):Record<string,unknown>|null;
 extractGroupKnowledgeForgetTarget(text:string):string;
 extractValidBtihMagnetUri(text:string):string|null;
 PIXIV_DOWNLOAD_TOOL_MANIFEST:ToolManifest;
 PIXIV_SEARCH_TOOL_MANIFEST:ToolManifest;
}

export interface SemanticEvent {msg?:string; raw_message?:string; _mergedRawCqTexts?:string[]}
export interface SemanticMember {user_id?:string|number|null;card?:string;nickname?:string;role?:string;title?:string}
export interface ToolDefinition {type?:string;function?:{name?:string;description?:string;parameters?:unknown}}
export interface AvatarReference {qq:string;role:string}
export interface ToolSemanticContext {
 e?:SemanticEvent|undefined; currentIntentText?:string|undefined;args?:string|undefined;msg?:string|undefined;userContent?:string|undefined;
 images?:string[]|undefined;videos?:string[]|undefined;atQq?:(string|number)[]|undefined;
 memberMap?:Map<number,SemanticMember>|null|undefined;currentUserId?:string|number|null|undefined;replyTargetUserId?:string|number|null|undefined;
 sessionTools?:ToolDefinition[];tools?:ToolDefinition[];availableToolNames?:string[];authorizedToolNames?:string[];
 interactionContext?:TurnInteractionContext|undefined;modelIntent?:string|undefined;toolDecision?:SemanticDecision|null|undefined;
 groupWorkflowPrompt?:string;groupUserMessages?:unknown;
 session?:{turnTrace?:{addModelCall(kind:string,duration:number):void}};
 prompt?:string;modelCommittedToDraw?:boolean
}
export interface SemanticDecision {intent:string;toolName?:string;params?:Record<string,unknown>;goal?:string}
export interface SemanticToolHost {
 config:{intentAiConfig?:{intentAiUrl?:string;intentAiApikey?:string;intentAiModel?:string};toolsAiConfig?:{toolsAiUrl?:string;toolsAiApikey?:string;toolsAiModel?:string};persona?:unknown};
 toolInstances?:Record<string,unknown>;
 buildImageGenerationPrompt(context:ToolSemanticContext):string;
 buildImageEditPrompt(context:ToolSemanticContext):string;
 getPersonaFor?(event?:SemanticEvent):unknown;
 resolveChatCompletionUrl(url:string):string;
 shouldUseSemanticToolIntent(event?:SemanticEvent,text?:string,images?:string[],videos?:string[],options?:{knownToolCandidates?:string[];hasMemberMentions?:boolean;modelIntent?:string|undefined}):boolean;
 extractJsonObject(text?:string):Record<string,unknown>|null;
 normalizeToolDecision(decision:Record<string,unknown>|null,context:ToolSemanticContext):SemanticDecision|null;
 getToolsByName(names:string[]):ToolDefinition[];
 buildForcedToolCall(name:string,params:Record<string,unknown>):ToolCall;
 resolveContextualDrawGeneration(context:ToolSemanticContext):{reason?:string;prompt?:string}|null
}
export interface SemanticToolPorts {
 logger:{warn(message:string):void;info(message:string):void};
 isExplicitAdminCollectionMentionRequest(text:string):boolean;
 selectToolIntentCandidates(text:string,names:string[]):string[];
 normalizeToolSkillParams(tool:unknown,params:Record<string,unknown>,context:{userText:string;currentIntentText:string;decision:Record<string,unknown>}):Record<string,unknown>;
 resolveMemberAvatarReferences(references:unknown,context:Pick<ToolSemanticContext,'memberMap'|'atQq'|'currentUserId'|'replyTargetUserId'>):AvatarReference[];
 buildToolSkillCatalog(tools:Record<string,unknown>|undefined,names:string[],definitions?:ToolDefinition[]):string;
 resolvePersonaName(persona:unknown):string;
 hasSemanticPlannerCandidate(names:string[]):boolean;
 shouldRunSemanticToolPlanner(options:{hasMedia:boolean;hasKnownToolCandidate:boolean;hasExplicitToolIntent:boolean;hasRealtimeRequest:boolean;hasExplicitSearchRequest:boolean;hasMemberMentions:boolean}):boolean;
 fetchWithTimeout(url:string,options:RequestInit,timeout:number):Promise<Response>
}

export interface ExecutionEvent extends SemanticEvent {
 group_id?:string|number;user_id?:string|number;message_id?:unknown;self_id?:string|number;bot?:{uin?:string|number};
 _groupContextImagePrompt?:string;_longRunningToolTask?:boolean;_quotedPromptContext?:{text?:string}
}
export interface ExecutionMessage {role?:string;content?:string;tool_calls?:ToolCall[];reasoning_content?:string;tool_call_id?:string|undefined;name?:string}
export interface ExecutionResult {toolCall:ToolCall;toolName:string;result:string;elapsed?:number}
export interface ExecutionAvatar {images:string[];targets?:{userId:string;label:string}[];promptHint?:string}
export interface ExecutionSession {
 rawArgs?:string;rawUserText?:string;interactionContext?:TurnInteractionContext;actionFactsQuery?:ActionFactsQuery;toolDecision?:SemanticDecision|null;executionTools?:ToolDefinition[];userContent?:string;groupContextImagePrompt?:string;tools?:ToolDefinition[];images?:string[];
 imageVerificationNeedsSearch?:boolean;imageVerificationSearchDone?:boolean;imageVerificationMode?:string;imageVerificationFinalInstructionAdded?:boolean;
 taskDedupeToolTouched?:boolean;backgroundTerminalToolTouched?:boolean;toolName?:string|undefined;toolResults?:ExecutionResult[];
 groupUserMessages?:ExecutionMessage[];editAssets?:{promptHint?:string};avatarEditBase?:{promptHint?:string};avatarDrawReference?:ExecutionAvatar;
 memberMap?:Map<number,SemanticMember>|null;atQq?:(string|number)[];groupContextAssets?:{replyTargetUserId?:string|number};taskContext?:{messageId?:unknown};
 turnPlan?:import('./turnPlan.js').TurnPlan;emojiToolSentThisTurn?:number;toolContent?:unknown;modrinthCardItems?:unknown[];
 turnTrace?:{addTool(name:string,success:boolean,elapsed:number):void;addModelCall(kind:string,elapsed:number):void};
 outboundArbiter?:{resolveToolOutcomes():void}
}
export interface LocalExecutableTool {execute(params:Record<string,unknown>,event:ExecutionEvent):unknown}
export interface ExecutionConfig {emoji?:{perTurnMax?:number};emojiSystem?:{emojiCooldownMs?:number};taskAiConfig?:{translation?:{model?:string}};chatAiConfig?:{chatApiModel?:string};[key:string]:unknown}
export interface ExecutionFailureContext {e:ExecutionEvent;session:ExecutionSession;stage:string;error:unknown}
export interface ToolExecutionHost {
 config:ExecutionConfig;toolInstances:Record<string,LocalExecutableTool>;memoryManager?:unknown;
 getToolCallName(call?:ToolCall):string;buildForcedToolCall(name:string,params:Record<string,unknown>):ToolCall;
 isToolResultError(result:unknown):boolean;extractToolResultText(result:unknown):string;
 runToolCall(call:ToolCall,event:ExecutionEvent,session:ExecutionSession,role?:string):Promise<ExecutionResult|null>;
 handleToolFailureResponse(name:string|undefined,context:{messages:ExecutionMessage[];factualReply:string;e:ExecutionEvent;session:ExecutionSession}):Promise<unknown>;
 getFriendlyFailureMessage(name:string|undefined,context:ExecutionFailureContext):string;
 buildGroundedImageAnalysisPrompt(prompt:unknown,session:ExecutionSession,event:ExecutionEvent):string;
 buildImageEditPrompt(context:Omit<ToolSemanticContext,'prompt'> & {prompt?:unknown}):string;
 buildImageGenerationPrompt(context:Omit<ToolSemanticContext,'prompt'|'images'> & {prompt?:unknown;images?:unknown;avatarDrawReference?:ExecutionAvatar|undefined}):string;
 getImageGenerationReferenceImages(images:unknown,session:ExecutionSession):string[];
 isDedupeTool(name:string):boolean;getToolRunKey(groupId:string|number|undefined,userId:string|number|undefined,name:string,event?:ActionFactsEvent):string;
 saveTaskStatus(status:{groupId?:string|number|undefined;userId?:string|number|undefined;messageId:unknown;status:string;toolName:string;error?:string;event?:ActionFactsEvent;actionFacts?:TurnTaskFact}):Promise<unknown>;
 getTurnActionFacts?(event:ActionFactsEvent,query?:ActionFactsQuery):Promise<TurnActionFacts>;
 executeTool(tool:string|LocalExecutableTool|undefined,params:Record<string,unknown>,event:ExecutionEvent,retry?:boolean):Promise<unknown>;
 serializeToolResult(result:unknown):string;isRawToolFailure(result:string):boolean;
 dedupeToolCalls(calls:ToolCall[]):ToolCall[];normalizeAssistantToolMessage(message:ExecutionMessage):ExecutionMessage;
 shouldRunTerminalToolsInBackground(calls:ToolCall[]):boolean;
 startBackgroundTerminalToolCalls(calls:ToolCall[],event:ExecutionEvent,session:ExecutionSession,role:string|undefined,messages:ExecutionMessage[]):void;
 buildImageVerificationSearchToolCall(results:ExecutionResult[],session:ExecutionSession,event:ExecutionEvent):ToolCall|null;
 handleTextResponse(text:string,event:ExecutionEvent,session:ExecutionSession,messages:ExecutionMessage[],name?:string):Promise<unknown>;
 retryRequest(request:unknown,content:unknown,count:number,name?:string,options?:unknown):Promise<{choices?:{message?:ExecutionMessage}[];error?:unknown}|null>
}
export interface ModrinthRanking {items:{projectId:string;[key:string]:unknown}[];[key:string]:unknown}
export interface ToolExecutionPorts {
 logger:{info(message:string):void;warn(message:string):void;error(message:string,error?:unknown):void};
 collectThinking(session:ExecutionSession,message:ExecutionMessage|undefined,event:ExecutionEvent):void;
 resolveEmojiTurnSkips(names:string[],sent:number,max:number):boolean[];
 looksLikeDirectPersonalQuestion(text:string):boolean;recordEmojiOnlySend(groupId:string|number,ms:number):void;
 buildModrinthBilingualReplyInstruction():string;parseModrinthRankingData(text:unknown):ModrinthRanking|null;
 collectModrinthTranslations(ranking:ModrinthRanking):{cached:Map<string,string>;missing:{projectId:string;[key:string]:unknown}[]};
 cacheModrinthTranslations(ranking:ModrinthRanking,translations:Map<string,string>):void;
 buildModrinthCardItemsFromData(ranking:ModrinthRanking,translations:Map<string,string>):unknown[];
 buildModrinthForwardItemsFromData(ranking:ModrinthRanking,translations:Map<string,string>):unknown[];
 buildModrinthTranslationMessages(missing:{projectId:string;[key:string]:unknown}[]):ExecutionMessage[];
 parseModrinthTranslationResponse(text:string|undefined,ids:string[]):Map<string,string>|null;wrapModrinthForwardItems(items:unknown[]):string;
 resolveToolRoundLimit(config:ExecutionConfig,context:{messages:ExecutionMessage[];toolNames:string[]}):number;
 isExplicitAdminCollectionMentionRequest(text:string):boolean;
 mcpManager:{isMCPTool(name:string):boolean;executeToolByAlias(name:string,params:Record<string,unknown>):Promise<unknown>};
 buildAgentProgressContext(context:{userContent:string;quotedContext:string;messages:ExecutionMessage[]}):unknown;
 buildChatRequestData(config:ExecutionConfig,messages:ExecutionMessage[],tools:ToolDefinition[]|undefined,choice:string):unknown;
 clearDrawFailureNote(group:string|number):void;isImageDeliveryToolName(name:string):boolean;recordDrawTextFallback(group:string|number,text:string):void;
 formatTurnPlanLog(plan:ExecutionSession['turnPlan']):string;recordTurnPlanToolOutcome(plan:ExecutionSession['turnPlan'],outcome:{toolName:string;success:boolean}):void;
 looksLikeImageVerificationRequest(text:string):boolean;
 resolveMemberAvatarReferences(references:unknown,context:Pick<ToolSemanticContext,'memberMap'|'atQq'|'currentUserId'|'replyTargetUserId'>):(AvatarReference & {image:string;label:string})[];
 assembleReferenceImages(input:{existingImages:unknown[];resolved:(AvatarReference & {image:string;label:string})[];existingRole:string}):{images:string[];manifest:string}
}
export interface ToolSkillSource {name?:string;description?:string;parameters?:unknown;skill?:unknown;getSkill?():unknown;normalizeParameters?(params:Record<string,unknown>,context:Record<string,unknown>):unknown}
