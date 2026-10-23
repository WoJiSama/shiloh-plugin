import type {ChatTurnConfig} from '../../../contracts/chatTurn.js'
import type {ToolAssemblyConfig} from '../../../contracts/toolAssembly.js'
import type {HostSharedConfig} from './hostSharedState.js'
import type {EntryHost} from '../../conversation/infrastructure/conversationEntryPolicy.js'
import type {PrefilterHost} from '../../conversation/infrastructure/conversationPrefilter.js'
import type {SchedulingHost} from '../../conversation/infrastructure/conversationScheduling.js'
import type {StrictConversationHost} from '../../conversation/infrastructure/strictConversation.js'
import type {SmartConversationHost} from '../../conversation/application/smartConversation.js'
import type {SmartDynamicsConfig} from '../../conversation/domain/smartDynamics.js'
export type HostConfig=ChatTurnConfig & ToolAssemblyConfig & HostSharedConfig & EntryHost['config'] & PrefilterHost['config'] & SchedulingHost['config'] & StrictConversationHost['config'] & SmartConversationHost['config'] & {
 enableGroupWhitelist?:boolean;allowedGroups:string[];triggerPrefixes:string[];excludeMessageTypes:string[];
 smartTrigger?:SmartDynamicsConfig & {activeChatTtlHours?:number};observabilityLog?:{enabled?:boolean;retentionDays?:number};chatTurnDurability?:{enabled?:boolean;staleSeconds?:number;recoverDelayMs?:number;ttlSeconds?:number};longRunningToolStaleMinutes?:number;
 intentAiConfig?:{intentAiUrl?:string;intentAiModel?:string;intentAiApikey?:string};emojiSystem?:{forcedReplyTextEnabled?:boolean;forcedReplyTextRate?:number;emojiCooldownMs?:number;postSendCooldownMs?:number};
}
function object(value:unknown):Record<string,unknown>{if(value===undefined||value===null)return {};if(typeof value!=='object'||Array.isArray(value))throw new Error('配置应为对象');return value as Record<string,unknown>}
function strings(value:unknown,fallback:string[]=[]):string[]{if(value===undefined)return fallback;if(!Array.isArray(value)||!value.every(v=>typeof v==='string'))throw new Error('配置应为字符串数组');return value}
function validatePrimitiveFields(value:Record<string,unknown>,booleans:string[],numbers:string[],texts:string[]=[]){for(const key of booleans)if(value[key]!==undefined&&typeof value[key]!=='boolean')throw new Error(`配置 ${key} 应为布尔值`);for(const key of numbers)if(value[key]!==undefined&&(typeof value[key]!=='number'||!Number.isFinite(value[key])))throw new Error(`配置 ${key} 应为有限数值`);for(const key of texts)if(value[key]!==undefined&&typeof value[key]!=='string')throw new Error(`配置 ${key} 应为文本`)}
function numericMap(value:unknown){for(const [key,v]of Object.entries(object(value)))if(typeof v!=='number'||!Number.isFinite(v))throw new Error(`配置 ${key} 应为数值`)}
function validateBackend(value:unknown,label:string,allowKeyArrays=true):Record<string,unknown> {
 const backend={...object(value)}
 for(const [field,v] of Object.entries(backend)) {
  if(v===undefined)continue
  if(/(?:Url|Model|ReasoningEffort|label)$/.test(field)&&typeof v!=='string')throw new Error(`配置${label}.${field}应为文本`)
  if(/(?:Key|Apikey)$/.test(field)&&typeof v!=='string'&&!(allowKeyArrays&&Array.isArray(v)&&v.every(x=>typeof x==='string')))throw new Error(`配置${label}.${field}密钥格式错误`)
 }
 return backend
}
/** Validate known runtime fields, preserving extension-owned keys for their own decoders. */
export function decodeHostConfig(value:unknown):HostConfig {
 const r={...object(value)}
 // Optional object null means absent; never expose null through an optional-object contract.
 for(const key of ['smartTrigger','observabilityLog','chatTurnDurability','turnTrace','episodicMemory','agentIntelligence','emoji','emojiSystem','knowledgeSystem','groupContextState','privateChat','forbiddenWords','torrentDownload','userBlacklist','globalStyleLearning','persona','expressionLearning','emotionSystem','memorySystem','chatAiConfig','toolsAiConfig','trackAiConfig','searchAiConfig','memoryAiConfig','embeddingAiConfig','intentAiConfig','taskAiConfig'])if(r[key]===null)delete r[key]
 validatePrimitiveFields(r,['enabled','enableGroupWhitelist','useTools','groupHistory','conversationTrackingEnabled'],['concurrentLimit','groupMaxMessages','groupChatMemoryMinutes','groupChatMemoryDays','longRunningToolStaleMinutes','conversationTrackingTimeout','batchJudgmentDelay','conversationTrackingThrottle'],['providers','chatTriggerMode','systemContent'])
 r.allowedGroups=strings(r.allowedGroups);r.triggerPrefixes=strings(r.triggerPrefixes);r.excludeMessageTypes=strings(r.excludeMessageTypes)
 const smart=object(r.smartTrigger)
 validatePrimitiveFields(smart,['waitToolEnabled','skipWhenAddressedOther','skipWhenEmptyText','continuationFollowupMatch','continuationKeywordMatch','continuationQuestionMatch','continuationFeedbackMatch','deferredGateEnabled','inevitableAtReply','mentionedNameReply','fadingForceGate','repeatJoinEnabled','enableTalkValueRules','idleCompensationEnabled'],['activeChatTtlHours','quickResponseMs','continuationLookbackMs','avgLatencyDefaultMs','minDeferredMs','maxDeferredMs','toolRequestMergeMs','replyDebounceMs','maxConsecutiveInterrupts','focusDurationMs','focusMaxReplies','fadingDurationMs','focusMaxNoAction','maxRepliesPer10Min','continuationKeywordMaxCount','repeatMaxTextLength','repeatDetectionWindow','repeatMinCount','repeatJoinCooldownMs','repeatJoinProbability','rateLimitCooldownMs','talkValue','directTriggerMergeMs','directTriggerMergeMaxMessages'])
 for(const key of ['smartLockTimeoutMs','timingGateCooldownSeconds'])if(smart[key]!==undefined&&smart[key]!==null&&typeof smart[key]!=='string'&&typeof smart[key]!=='number')throw new Error(`配置 ${key} 无效`)
 validatePrimitiveFields(object(smart.attentionDrift),['enabled'],['windowMinutes'],['level'])
 if(smart.talkValueRules!==undefined){if(!Array.isArray(smart.talkValueRules))throw new Error('talkValueRules应为数组');for(const rule of smart.talkValueRules)validatePrimitiveFields(object(rule),[],[],['range'])}
 if(smart.groupTalkValues!==undefined&&!Array.isArray(smart.groupTalkValues))object(smart.groupTalkValues)
 r.smartTrigger=smart
 for(const [key,bool,num,text]of [
 ['observabilityLog',['enabled'],['retentionDays'],[]],['chatTurnDurability',['enabled'],['staleSeconds','recoverDelayMs','ttlSeconds'],[]],['turnTrace',['archiveEnabled'],['retentionDays'],['archiveDir']],['episodicMemory',['enabled','proactiveEnabled'],['recallDays'],[]],['agentIntelligence',['enabled'],[],[]],['emoji',['enabled'],['perTurnMax'],[]],['emojiSystem',['enabled','forcedReplyTextEnabled'],['emojiCooldownMs','forcedReplyTextRate'],[]],['knowledgeSystem',['enabled'],['topN','threshold'],[]],['groupContextState',['topicEnabled','socialEnabled'],[],[]],['privateChat',['enabled'],['cooldownSeconds'],[]],['forbiddenWords',['enabled','blockOutput'],[],['replyText']],['torrentDownload',['autoDetect'],[],[]],['userBlacklist',['enabled'],[],[]],['globalStyleLearning',['enabled'],[],[]],['persona',[],[],['name']],['expressionLearning',['enabled','aiLearningEnabled'],['minWordFrequency','maxWords','aiLearningMessageThreshold','sequenceWindowMs','maxSequenceTurns','maxSequenceSamples'],[]],['emotionSystem',['enabled'],['decayRate'],[]]
 ] as const){if(r[key]!==undefined&&r[key]!==null){const nested=object(r[key]);validatePrimitiveFields(nested,[...bool],[...num],[...text]);r[key]=nested}}
 const emotion=object(r.emotionSystem);if(emotion.eventWeights!==undefined)numericMap(emotion.eventWeights)
 const expression=object(r.expressionLearning);if(expression.blockedWords!==undefined)strings(expression.blockedWords)
 for(const key of ['allowedUsers','words','users']){const parent=key==='allowedUsers'?'privateChat':key==='words'?'forbiddenWords':'userBlacklist';const item=object(r[parent])[key];if(item!==undefined&&!Array.isArray(item))throw new Error(`配置${parent}.${key}应为数组`)}
 for(const key of ['oneapi_tools','openai_tools','identityBindings'])if(r[key]!==undefined&&!Array.isArray(r[key]))throw new Error(`配置${key}应为数组`)
 const memory={...object(r.memorySystem)};validatePrimitiveFields(memory,['enabled','semanticRecallEnabled','proactiveCallback'],['maxEntitiesPerGroup','maxFactsPerGroup','maxFactsPerEntity','userExtractDebounceSeconds','userExtractMaxBatchMessages','groupExtractMinIntervalMinutes','groupExtractMaxBatchMessages','promptMaxGroupFacts','promptMaxEntityFacts','promptMaxChars','reflectEntityThreshold','reflectGroupThreshold','recallMaxMentionedEntities','proactiveWindowDaysBefore','proactiveWindowDaysAfter','semanticDupCosine','maxGroupWorkflows','workflowPromptMaxRules','knowledgeDecisionInlineWaitMs','maxGroupKnowledge','knowledgePromptMaxEntries','knowledgeDecisionTimeoutMs','knowledgeDecisionMaxTokens'],['saveStrictness'])
 for(const key of ['chatAiConfig','toolsAiConfig','trackAiConfig','searchAiConfig','memoryAiConfig','embeddingAiConfig','intentAiConfig']) {
  if(r[key]!==undefined)r[key]=validateBackend(r[key],key,!['toolsAiConfig','memoryAiConfig','embeddingAiConfig','intentAiConfig'].includes(key))
 }
 for(const key of ['memoryAiConfig','embeddingAiConfig'])if(memory[key]!==undefined&&memory[key]!==null)memory[key]=validateBackend(memory[key],`memorySystem.${key}`,false);else if(memory[key]===null)delete memory[key]
 if(r.memorySystem!==undefined)r.memorySystem=memory
 const track=object(r.trackAiConfig);r.trackAiConfig={...track,trackAiUrl:String(track.trackAiUrl||''),trackAiModel:String(track.trackAiModel||''),trackAiApikey:Array.isArray(track.trackAiApikey)?track.trackAiApikey.join(','):String(track.trackAiApikey||'')}
 if(r.taskAiConfig!==undefined){
  const tasks={...object(r.taskAiConfig)}
  for(const [key,value] of Object.entries(tasks)){
   if(value===null)throw new Error(`配置taskAiConfig.${key}应为对象`)
   const backend=validateBackend(value,`taskAiConfig.${key}`)
   validatePrimitiveFields(backend,[],['maxOutputTokens'],['apiUrl','model','label','reasoningEffort','maxTokensField'])
   if(backend.apiKey!==undefined&&typeof backend.apiKey!=='string'&&!(Array.isArray(backend.apiKey)&&backend.apiKey.every(v=>typeof v==='string')))throw new Error(`配置taskAiConfig.${key}.apiKey密钥格式错误`)
   if(backend.complexity!==undefined){const c=object(backend.complexity);if(typeof c.score!=='number'||!Number.isFinite(c.score)||!Array.isArray(c.signals))throw new Error('complexity配置无效');strings(c.signals)}
   tasks[key]=backend
  }
  r.taskAiConfig=tasks
 }
 // Every concrete host-owned property is checked above; unknown extension keys remain opaque.
 return r as HostConfig
}
