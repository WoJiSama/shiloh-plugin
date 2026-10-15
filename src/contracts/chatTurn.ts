import type {KnowledgeEntry,WorkflowRule} from './memoryEngine.js'
import type {ExecutionEvent,ExecutionSession,ExecutionMessage,ToolDefinition,ToolCall,SemanticDecision,ToolSemanticContext,SemanticMember,ExecutionAvatar,ExecutionConfig} from './toolExecution.js'
import type {TurnPlan,ToolChoice} from './turnPlan.js'
import type {ActionFactsQuery, TurnActionFacts} from './turnActionFacts.js'
import type {PersonaGuardConfig, PersonaIdentity, PersonaScope, PersonaSnapshot} from './persona.js'
export type ChatId=string|number
export interface IdentityBinding {qq?:string|number|null|undefined;name?:string;aliases?:string[];notes?:string}
export interface ChatTurnMember extends SemanticMember {group_name?:string}
export interface ChatGroup {group_name?:string;getMemberMap():Promise<Map<number,ChatTurnMember>>;pickMember(id:ChatId|null|undefined):{info:ChatTurnMember|Promise<ChatTurnMember>}}
export interface ChatTurnEvent extends ExecutionEvent {_personaSnapshot?:PersonaSnapshot;_pendingPersonaSnapshot?:PersonaSnapshot;message_type?:string;self_id?:ChatId;group?:ChatGroup;group_name?:string;sender:ChatTurnMember;bot:{uin?:ChatId;nickname?:string;pickGroup(id:ChatId|undefined):ChatGroup};message?:import('./chatEvent.js').MessageSegment[];isMaster?:boolean;sessionId?:string;_turnId?:string;_triggerContext?:{mode?:string;[key:string]:unknown};_progressReplyState?:{sent:boolean;reserved:boolean};_receivedAt?:number;_groupContextAssets?:GroupAssets;reply_id?:unknown;getReply?():Promise<QuotedMessage|null>;_prefilterKind?:string;forceGrabRedBag?:boolean;_mergedMessageCount?:number;_quotedPromptContext?:{text?:string;messageId?:unknown}}
export interface QuotedMessage {message?:unknown;[key:string]:unknown}
export interface GroupMediaReference {source?:string;type?:string;origin?:string}
export interface GroupAssets {images:{source:string;origin?:string}[];currentImages:unknown[];quotedImages:unknown[];forwardImages:unknown[];videos:(string|GroupMediaReference)[];media?:GroupMediaReference[];files?:unknown[];replyTargetUserId?:ChatId;replyTargetLabel?:string;currentForwardText?:string;quotedForwardText?:string}
export interface AvatarAssets extends ExecutionAvatar {targets:{userId:string;label:string}[];references?:{id:string}[]}
export interface TraceRecord {modelCalls:unknown[];tools:unknown[]}
export interface ChatTrace {id:string;setTrigger(mode:string|undefined,context:unknown):void;setIntent(intent:string,confidence:number|null|undefined,source:string):void;addModelCall(kind:string,elapsed:number,options?:{tokens:number}):void;addTool(name:string,success:boolean,elapsed:number):void;finish():TraceRecord}
export interface ChatArbiter {wrapEvent(e:ChatTurnEvent):ChatTurnEvent;beginToolOutcomes():void;enqueue(kind:string,send:()=>Promise<unknown>):unknown;settle(outcomes:{toolName:string;success:boolean}[]):void;resolveToolOutcomes():void}
export interface ChatTurnMessage extends ExecutionMessage {messageId?:unknown;userId?:unknown;contextSection?:string}
export interface ChatTurnSession extends Omit<ExecutionSession,'groupContextAssets'|'memberMap'|'turnTrace'|'outboundArbiter'|'groupUserMessages'> {
 __createdAt?:number;__lastActiveAt?:number;personaSnapshot?:PersonaSnapshot;actionOutcomes?:unknown[];context?:unknown;taskContext?:{messageId?:unknown};groupContextAssets?:GroupAssets;recentUserImage?:{image:string};recentImageContinuation?:{image:string};memberMap?:Map<number,ChatTurnMember>|null;
 avatarInspection?:AvatarAssets;turnDrawRequested?:boolean;modelIntentDecision?:{intent:string;confidence?:number}|null;addresseeSignal?:unknown;promptLayerProfile?:{profile:string};promptLayerReport?:unknown;
 historySelectionMode?:string;selectedGroupHistoryCount?:number;groupUserMessages:ChatTurnMessage[];cardPresentation?:string;initialExecutionRoute?:{mode:string;reason:string};cardAcknowledged?:boolean;responseAttempted?:boolean;turnTrace?:ChatTrace;outboundArbiter?:ChatArbiter;
}
export interface ChatTurnConfig extends ExecutionConfig {personaGuard?:PersonaGuardConfig;enabled?:boolean;concurrentLimit?:number;triggerPrefixes?:string[];turnTrace?:{archiveEnabled?:boolean;archiveDir?:string;retentionDays?:number};memorySystem?:{enabled?:boolean;knowledgeDecisionInlineWaitMs?:number};persona?:{name?:string};identityBindings?:IdentityBinding[];episodicMemory?:{enabled?:boolean;recallDays?:number;proactiveEnabled?:boolean};systemContent?:string;groupHistory?:boolean;agentIntelligence?:{enabled?:boolean;[key:string]:unknown}}
export interface GroupMemoryCommit {status:string;knowledgeEntries?:KnowledgeEntry[];workflowRules?:WorkflowRule[];aliasMappings?:Record<string,unknown>[]}
export interface ChatModelResponse {choices?:{message?:ExecutionMessage}[];error?:unknown;usage?:{total_tokens?:number}}
export interface ChatToolDecision {tools:ToolDefinition[];toolCall:ToolCall;toolName:string;reason?:string}
export interface ChatTurnHost {
 config:ChatTurnConfig;tools:ToolDefinition[];toolInstances:Record<string,unknown>;
 _groupLimiters:Map<unknown,unknown>;_seededGroups?:Set<ChatId>;localToolsReadyPromise?:Promise<unknown>;
 isUserBlacklisted(e:ChatTurnEvent):boolean;scheduleMergedToolRequest(e:ChatTurnEvent,handle:(e:ChatTurnEvent)=>Promise<void>):boolean|unknown;
 handleTool(e:ChatTurnEvent):Promise<unknown>;refreshLocalToolRegistry(options:{silent:boolean}):Promise<unknown>;waitForMCPReady():Promise<unknown>;
 beginConversationTask(e:ChatTurnEvent):Promise<{messageId?:unknown}>;getOrCreateSession(id:string,tools:ToolDefinition[]):ChatTurnSession;
 clearSession(id:string):void;sendObservedReply(e:ChatTurnEvent,text:string):Promise<unknown>;sendSegmentedMessage(e:ChatTurnEvent,text:string,delay:number):Promise<unknown>;
 handleActiveDrawStatusQuestion(e:ChatTurnEvent,text:string):Promise<boolean>;buildMessageContent(sender:ChatTurnMember,args:string,images:string[],atQq:ChatId[],group?:ChatGroup,event?:ChatTurnEvent):Promise<string>;
 resolvePrimaryModelIntent(text:string,options:{hasImages:boolean}):Promise<{intent:string;confidence?:number}|null>;
 getSmartState(groupId:ChatId|undefined,event:ChatTurnEvent):{lastBotReplyToUserId?:ChatId|null}|null;
 getPersonaFor(e:ChatTurnEvent):{name?:string;[key:string]:unknown};getPersonaSnapshotFor?(e:ChatTurnEvent):PersonaSnapshot;getChatConfig(e:ChatTurnEvent):ChatTurnConfig;
 memoryManager:{interpretGroupKnowledgeInstruction(context:unknown):Promise<GroupMemoryCommit>;commitGroupMemoryDecision(groupId:ChatId,decision:GroupMemoryCommit,context:Record<string,unknown>):Promise<GroupMemoryCommit>;seedFromConfig(groupId:ChatId,bindings:IdentityBinding[]):Promise<unknown>};
 emotionManager:unknown;expressionLearner:unknown;knowledgeSearcher:unknown;
 getCurrentGroupContext(e:ChatTurnEvent):Promise<{groupId?:ChatId;groupName?:string;groupNotice?:unknown}>;getBasicGroupContext(e:ChatTurnEvent):{groupId?:ChatId;groupName?:string;groupNotice?:unknown};
 buildMergedDirectTriggerPrompt(e:ChatTurnEvent):string;
 messageManager:{getMessages(type:string|undefined,id:ChatId|undefined):Promise<{message_id?:unknown;source?:string;personaSource?:PersonaScope;content?:string;at?:unknown;time?:unknown;sender:{user_id?:ChatId|undefined;nickname?:string|undefined;role?:string|undefined}}[]>};
 getTaskStatus(groupId:ChatId|undefined,messageId:unknown):Promise<unknown>;formatTaskStatusForPrompt(status:unknown):string;
 getTurnActionFacts?(event:ChatTurnEvent,query:ActionFactsQuery):Promise<TurnActionFacts>;
 resolveUnderstandingPrompt(context:unknown):Promise<string>;trimMessageHistory(messages:ChatTurnMessage[]):ChatTurnMessage[];filterChatByQQ(messages:ChatTurnMessage[],userId:ChatId|undefined):ChatTurnMessage[];
 formatMessages(messages:ChatTurnMessage[],event:ChatTurnEvent,content:string):ChatTurnMessage[];
 getImageGenerationReferenceImages(images:string[],session:ChatTurnSession):string[];getToolsByName(names:string[]):ToolDefinition[];resolveForcedReplyTextRate(groupId:ChatId|undefined):Promise<number>;
 buildForcedToolCall(name:string,params:unknown):ToolCall;buildToolCallFromDecision(decision:unknown,context:unknown):unknown;buildImageEditPrompt(context:unknown):string;buildImageGenerationPrompt(context:unknown):string;resolveContextualDrawGeneration(context:unknown):unknown;classifySemanticToolIntent(context:unknown):Promise<unknown>;
 processToolCalls(message:ExecutionMessage,e:ChatTurnEvent,session:ChatTurnSession,messages:ChatTurnMessage[],atQq:ChatId[],role:string,options?:{syntheticToolCall?:boolean}):Promise<unknown>;
 retryRequest(request:unknown,content:unknown,count:number,name?:string,options?:unknown):Promise<ChatModelResponse|null>;
 getFriendlyFailureMessage(name:string,context:unknown):string;buildMissingToolCommitmentCall(content:string,context:unknown):ChatToolDecision|null;handleTextResponse(content:string,e:ChatTurnEvent,session:ChatTurnSession,messages:ChatTurnMessage[]):Promise<unknown>;
 finishConversationTask(task:unknown,session:ChatTurnSession):Promise<unknown>;recordReplyLatency(groupId:ChatId,elapsed:number,e:ChatTurnEvent):void
}
export interface ChatTurnRoute {warn?:string;aborted?:string;toolChoice:ToolChoice;forcedToolCall:ToolCall|null;toolScopeLocked:boolean;toolDecision?:SemanticDecision|null;applied:string[]}
export interface ChatTurnPorts {
 logger:{info(message:string,meta?:unknown):void;warn(message:string):void;error(message:string,error?:unknown):void;debug(message:string):void};
 botIdentity(e:ChatTurnEvent):{uin:ChatId;nickname:string};cacheGroupName(groupId:ChatId,name:string):Promise<void>;loadTurnContinuity(context:{groupId:ChatId|undefined;userId:ChatId|undefined;botId:ChatId;persona?:PersonaIdentity}):Promise<{botId?:string;persona?:PersonaIdentity;lastReply?:string;intent?:string;tools?:unknown[]}|null>;
 resolveConversationContext(e:ChatTurnEvent):unknown;collectThinking(session:ChatTurnSession,message:ExecutionMessage,e:ChatTurnEvent):void;sendThinkingForward(host:ChatTurnHost,e:ChatTurnEvent,session:ChatTurnSession):Promise<unknown>;
 globalStyleLearnerManager:unknown;personProfileInjector:unknown;personaFeedbackManager:unknown;getMidtermMemoryManager():unknown;
 formatGroupKnowledgeTeachingPrompt(entries:unknown[]):string;formatGroupWorkflowTeachingPrompt(entries:unknown[]):string;
 getSemanticMemoryRuntime():{indexer:{groupAllowed(groupId:ChatId|undefined):boolean};config:{rerankInChat?:boolean};retriever:{search(groupId:ChatId|undefined,text:string,options:{rerank:boolean}):Promise<SemanticMemoryResult>;renderContext(result:SemanticMemoryResult):string}}|null;
 mcpManager:{getMCPSystemPrompts(context:unknown):string};recordActionOutcomes(session:ChatTurnSession,kind:string,entries:unknown[]):void;
 computeAddresseeSignal(options:unknown):unknown;buildAddresseePrompt(signal:unknown):string;
 resolveHistorySelectionBudget(config:unknown,options:unknown):{recentCount:number;relevantCount:number;maxMessages:number;mode:string};selectRelevantGroupHistory(messages:ChatTurnMessage[],options:unknown):ChatTurnMessage[];
 isAiConversationEnabled(config:ChatTurnConfig):boolean;evaluatePrivateChatGate(options:unknown):{allowed:boolean;reason:string};
 buildDrawFailureNoteMessage(note:unknown):string;recordDrawTextFallback(groupId:ChatId|undefined,text:string):void;takeDrawFailureNote(groupId:ChatId|undefined):unknown;
 prepareImageEditAssets(options:unknown):AvatarAssets|null;resolveAvatarEditBase(options:unknown):AvatarAssets|null;
 classifyEmojiToolExposure(text:string):string;buildEpisodicPrompt(episodes:unknown,options?:{viewer?:PersonaSnapshot}):string;buildUserCallbackPrompt(episodes:unknown,options:unknown):string;hasTemporalDeixis(text:string):boolean;recallEpisodes(options:unknown):unknown;recallUserEpisodes(options:unknown):unknown;
 buildExcelToolParams(text:string,options:unknown):unknown;hasExcelWorkbookContext(options:unknown):boolean;shouldUseExcelWorkbookTool(text:string,options:unknown):boolean;TakeImages(e:ChatTurnEvent):Promise<string[]>;
 formatGroupContextImagePrompt(images:GroupAssets['images']):string;resolveGroupContextAssets(options:unknown):Promise<GroupAssets>;
 getGroupSocialPrompt(groupId:ChatId|undefined):string;getGroupTopicPrompt(groupId:ChatId|undefined):string;buildImageFailureReply(error:string):string;
 buildMissingImageAnalysisReply():string;shouldAskForMissingImageForVisualRequest(text:string):boolean;shouldRequireImageEditBase(text:string):boolean;shouldSkipIntentModel(options:unknown):boolean;containsInternalStatusLeak(text:string|undefined):boolean;
 noteInjectedChunks(groupId:ChatId|undefined,items:SemanticMemoryResult['items']):void;resolveSingularOwnerMention(context:unknown):unknown;
 createOutboundArbiter(options:unknown):ChatArbiter;buildChatRequestData(config:ChatTurnConfig,messages:ChatTurnMessage[],tools:ToolDefinition[]|undefined,choice:ToolChoice):unknown;
 rollPersonaMood(persona:unknown,scope:ChatId|undefined):{name:string}|null;hasRecentPixivSearch(options:unknown):boolean;resolvePromptLayerProfile(options:unknown):{profile:string};
 resolveRecentBotImage(e:ChatTurnEvent,options:unknown):Promise<{image:string}|null>;resolveRecentUserImage(e:ChatTurnEvent,options:unknown):Promise<{image:string}|null>;
 resolveToolRoute(options:unknown):Promise<ChatTurnRoute>;buildMainSystemPrompt(options:unknown):string;buildToolIntentDisclosure(names:string[]):string;resolveDeterministicToolIntent(text:string,names:string[],options:unknown):unknown;selectToolIntentCandidates(text:string,names:string[]):string[];extractEmbeddedToolCalls(text:string):{calls:{name:string;params:unknown}[];remainder:string};
 buildCommittedActionReply(session:ChatTurnSession):string;buildTurnContinuityPrompt(continuity:unknown):string;recordTurnDiagnostics(context:unknown):void;
 createTurnPlan(context:unknown):TurnPlan;deriveTurnPlanRequest(plan:TurnPlan,config:ChatTurnConfig):{toolChoice:ToolChoice;executionPrompt?:string;requestOptions?:{taskBackend?:string;[key:string]:unknown}};formatTurnPlanLog(plan:TurnPlan|undefined):string;
 isEducationalExplanationRequest(text:string):boolean;resolveCardPresentation(text:string,kind:string):string;composeTurnPromptLayers(context:unknown):Promise<{layerValues:Record<string,string>;report:unknown;prompt:string}>;
 createTurnTrace(context:unknown):ChatTrace;resolveTurnTraceArchiveDir():string;resolveAvatarDrawReference(options:unknown):AvatarAssets|null;resolveAvatarInspectionTargets(options:unknown):AvatarAssets|null;
 formatIdentityBindingsPrompt(bindings:IdentityBinding[]|undefined,userId:ChatId|undefined):string;cardAcknowledgement(presentation:string):string;
 delay(ms:number):Promise<void>;getOrCreateGroupLimiter(limiters:Map<unknown,unknown>,groupId:ChatId|undefined,limit:number):<T>(job:()=>Promise<T>)=>Promise<T>;filterToolsForMessageIntent(tools:ToolDefinition[]|undefined,e:ChatTurnEvent,args:string,options:unknown):ToolDefinition[]
}
export interface SemanticMemoryResult {items:{vectorScore:number;[key:string]:unknown}[];elapsedMs?:number;vectorMs?:number;bm25Ms?:number;reason?:string}
