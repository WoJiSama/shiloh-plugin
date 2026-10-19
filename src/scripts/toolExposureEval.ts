import fs from 'node:fs'
import path from 'node:path'
import {createBuiltinToolManifests} from '../modules/tools/domain/builtinToolManifests.js'
import {initializeBuiltinToolManifests} from '../modules/tools/domain/toolManifestRegistry.js'
import {createToolIntentManifests} from '../modules/tools/domain/toolIntentManifests.js'
import {createSemanticToolIntent} from '../modules/tools/infrastructure/semanticToolIntent.js'
import {buildToolSkillCatalog,normalizeToolSkillParams} from '../modules/tools/domain/toolSkills.js'
import {createRouteDecision} from '../modules/conversation/application/routeDecision.js'
import {classifyIntentWithModel} from '../modules/conversation/application/modelIntentClassifier.js'
import {createConversationUtils} from '../modules/conversation/infrastructure/conversationUtils.js'
import {createTurnPlan,deriveTurnPlanRequest} from '../modules/conversation/infrastructure/turnPlan.js'
import {buildChatRequestData} from '../modules/models/domain/modelGateway.js'
import {resolveChatCompletionUrl} from '../modules/models/domain/chatCompletionUrl.js'
import {shouldSkipIntentModel} from '../modules/conversation/domain/intentFastPath.js'
import {shouldRunSemanticToolPlanner,hasSemanticPlannerCandidate} from '../modules/tools/domain/semanticToolPolicy.js'
import {normalizeIntentText,isExplicitSearchRequest,isExplicitToolIntent,isRealtimeInfoRequest,SEARCH_TOOL_NAMES} from '../modules/conversation/domain/messageIntent.js'
import {isExplicitAdminCollectionMentionRequest} from '../modules/conversation/domain/mentionRoleRouting.js'
import {getEmojiToolIntentPatterns,classifyEmojiToolExposure,filterToolsForEmojiExposure,shouldExposeEmojiToolForMessage} from '../modules/conversation/domain/emojiToolPolicy.js'
import {buildExcelToolParams} from '../modules/content/infrastructure/excelRequestPolicy.js'
import {parseModrinthRequestOptions} from '../modules/media/infrastructure/modrinth.js'
import {extractGroupKnowledgeForgetTarget} from '../modules/knowledge/domain/groupKnowledgeForgetPolicy.js'
import {extractValidBtihMagnetUri} from '../modules/media/infrastructure/torrentDownload.js'
import {PIXIV_DOWNLOAD_TOOL_MANIFEST,PIXIV_SEARCH_TOOL_MANIFEST} from '../modules/media/domain/pixivIntent.js'
import {resolveNaturalDeltaForceToolCall} from '../modules/games/domain/deltaForceIntent.js'
import type {ToolDefinition,ToolCall,ToolSemanticContext,SemanticToolHost,SemanticDecision,SemanticMember,SemanticToolPorts,ToolSkillSource} from '../contracts/toolExecution.js'
import type {RouteContext} from '../modules/conversation/application/routeDecision.js'
import type {TurnPlanInput} from '../contracts/turnPlan.js'
import type {ChatTool,ToolChoice} from '../contracts/modelGateway.js'

export type ModelReplay = 'tool'|'chat'|'low_confidence'|'timeout'|'unavailable'|'invalid'
export type StageState = 'pass'|'drop'|'bypass'|'n/a'
export interface ExposureScenario {
  id:string; text:string; family:string; difficulty:'direct'|'colloquial'|'context'; split:'regression'|'holdout';
  expectedAction:'tool'|'answer'|'clarify'; expectedTool?:string; expectedParams?:Record<string,unknown>;
  context?:{atQq?:(string|number)[];replyTargetUserId?:string|number;currentUserId?:string|number;members?:SemanticMember[];quote?:string;history?:{user_id:string|number;content:string}[];images?:string[];videos?:string[];hasExcelContext?:boolean};
  availableTools?:string[]; config?:{useTools?:boolean;keepAutoToolsOnChatTurn?:boolean};
}
export interface ScenarioFixture {schema:1;description:string;tools:Record<string,{description:string;parameters:Record<string,unknown>}>;scenarios:ExposureScenario[]}
export interface ExposureStage {state:StageState;reason:string;tools?:string[]}
export interface ExposureReplay {
  id:string;family:string;split:string;difficulty:string;text:string;modelReplay:ModelReplay;modelAssumption:string;expectedAction:string;expectedTool:string|null;
  candidates:string[];stages:Record<string,ExposureStage>;primaryIntent:string;plannerDecision:SemanticDecision|null;appliedRules:string[];
  executionMode:string;toolChoice:unknown;requestTools:string[];directTool:string|null;actualParams:Record<string,unknown>|null;
  routingSuccess:boolean|null;parameterStatus:'pass'|'fail'|'unmeasured'|'n/a';unsafeDirectCall:boolean;negativeToolsExposed:boolean;deadAt:string|null;
  modelCalls:{intent:number;planner:number};answerQuality:'unmeasured';toolResult:'not_executed';
}
function record(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}
const names=(tools:ToolDefinition[]=[]):string[]=>tools.map(tool=>tool.function?.name).filter((name):name is string=>Boolean(name))
const forcedCall=(name:string,params:Record<string,unknown>):ToolCall=>({id:'eval-only',type:'function',function:{name,arguments:JSON.stringify(params)}})
const assumptions:Record<ModelReplay,string>={tool:'固定正确模型输出（不代表真实模型准确率）',chat:'固定明确不执行输出',low_confidence:'固定低置信度输出',timeout:'模型超时的兜底覆盖率',unavailable:'模型未配置的兜底覆盖率',invalid:'无效模型输出的兜底覆盖率'}
export const MODEL_REPLAYS:ModelReplay[]=['tool','chat','low_confidence','timeout','unavailable','invalid']

export function validateExposureFixture(input:unknown):ScenarioFixture {
  const fixture=record(input),scenarios=fixture.scenarios
  if(fixture.schema!==1||!Array.isArray(scenarios)||!Object.keys(record(fixture.tools)).length)throw new Error('评测场景需要 schema=1、tools 与 scenarios')
  const seen=new Set<string>()
  for(const raw of scenarios){
    const scenario=record(raw),id=String(scenario.id||'')
    if(!id||seen.has(id)||!String(scenario.text||'').trim())throw new Error(`场景 id 缺失/重复或正文为空: ${id}`)
    seen.add(id)
    if(!['tool','answer','clarify'].includes(String(scenario.expectedAction)))throw new Error(`场景 expectedAction 无效: ${id}`)
    if(scenario.expectedAction==='tool'&&!record(fixture.tools)[String(scenario.expectedTool)])throw new Error(`场景缺少已定义 expectedTool: ${id}`)
    if(scenario.expectedParams!==undefined&&(!scenario.expectedParams||typeof scenario.expectedParams!=='object'||Array.isArray(scenario.expectedParams)))throw new Error(`场景 expectedParams 必须是对象: ${id}`)
    if(scenario.availableTools!==undefined&&(!Array.isArray(scenario.availableTools)||scenario.availableTools.some(name=>!record(fixture.tools)[String(name)])))throw new Error(`场景 availableTools 包含未知工具: ${id}`)
    if(!['regression','holdout'].includes(String(scenario.split))||!['direct','colloquial','context'].includes(String(scenario.difficulty)))throw new Error(`场景 split/difficulty 无效: ${id}`)
  }
  return input as ScenarioFixture
}

function initializeManifests(){
  const manifests=createBuiltinToolManifests({getEmojiToolIntentPatterns,buildExcelToolParams,parseModrinthRequestOptions,extractGroupKnowledgeForgetTarget,extractValidBtihMagnetUri,PIXIV_DOWNLOAD_TOOL_MANIFEST,PIXIV_SEARCH_TOOL_MANIFEST})
  initializeBuiltinToolManifests(manifests.BUILTIN_TOOL_MANIFESTS)
}

function modelPayload(scenario:ExposureScenario,mode:ModelReplay,planner:boolean):Record<string,unknown>|string {
  if(mode==='invalid')return 'invalid JSON from mock model'
  const action=mode==='chat'||scenario.expectedAction!=='tool'?'chat':planner?'tool':({searchInformationTool:'search',deltaForceTool:'deltaforce',searchMusicTool:'music',sendLocalEmojiTool:'emoji'}[scenario.expectedTool||'']||'other_tool')
  return {intent:action,confidence:mode==='low_confidence'?0.2:0.98,reason:'评测固定响应',...(planner&&action==='tool'?{toolName:scenario.expectedTool,params:scenario.expectedParams||{}}:{})}
}

function mockModelFetch(scenario:ExposureScenario,mode:ModelReplay,planner:boolean,counter:{calls:number}):typeof fetch {
  return async()=>{
    counter.calls++
    if(mode==='timeout')throw new DOMException('Eval simulated timeout','AbortError')
    const payload=modelPayload(scenario,mode,planner)
    return new Response(JSON.stringify({choices:[{message:{content:typeof payload==='string'?payload:JSON.stringify(payload)}}]}),{status:200,headers:{'Content-Type':'application/json'}})
  }
}

function semanticHarness(definitions:ToolDefinition[],scenario:ExposureScenario,config:SemanticToolHost['config'],fetchImpl:typeof fetch){
  const intents=createToolIntentManifests(classifyEmojiToolExposure)
  const logger={warn(_message:string){},info(_message:string){}}
  const toolInstances:Record<string,ToolSkillSource>={}
  const ports:SemanticToolPorts={logger,isExplicitAdminCollectionMentionRequest,selectToolIntentCandidates:intents.selectToolIntentCandidates,normalizeToolSkillParams:(tool,params,context)=>normalizeToolSkillParams(tool as ToolSkillSource|undefined,params,context),resolveMemberAvatarReferences:()=>[],buildToolSkillCatalog,resolvePersonaName:()=> '评测机器人',hasSemanticPlannerCandidate,shouldRunSemanticToolPlanner,fetchWithTimeout:async(url,options,timeout)=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout)
    try{return await fetchImpl(url,{...options,signal:controller.signal})}finally{clearTimeout(timer)}
  }}
  const api=createSemanticToolIntent(ports)
  const host:SemanticToolHost={config,toolInstances,buildImageGenerationPrompt:context=>context.prompt||context.currentIntentText||'',buildImageEditPrompt:context=>context.prompt||context.currentIntentText||'',resolveChatCompletionUrl,shouldUseSemanticToolIntent:(...args)=>api.shouldUseSemanticToolIntent(host,...args),extractJsonObject:text=>api.extractJsonObject(host,text),normalizeToolDecision:(decision,context)=>api.normalizeToolDecision(host,decision,context),getToolsByName:requested=>definitions.filter(tool=>requested.includes(tool.function?.name||'')),buildForcedToolCall:forcedCall,resolveContextualDrawGeneration:()=>null}
  return {api,host,intents}
}

export async function replayToolExposureScenario(scenario:ExposureScenario,fixture:ScenarioFixture,mode:ModelReplay='tool'):Promise<ExposureReplay>{
  initializeManifests()
  const available=scenario.availableTools||Object.keys(fixture.tools)
  const definitions:ToolDefinition[]=available.map(name=>({type:'function',function:{name,...fixture.tools[name]}}))
  const ctx=scenario.context||{},text=scenario.text,atQq=ctx.atQq||[],images=ctx.images||[],videos=ctx.videos||[]
  const memberMap=new Map((ctx.members||[]).map(member=>[Number(member.user_id),member]))
  const intentCount={calls:0},plannerCount={calls:0}
  const modelConfig=mode==='unavailable'?{}:{intentAiConfig:{intentAiUrl:'https://eval.invalid/v1',intentAiApikey:'eval-placeholder-no-network',intentAiModel:'fixed-fixture'}}
  const {api,host,intents}=semanticHarness(definitions,scenario,modelConfig,mockModelFetch(scenario,mode,true,plannerCount))
  const candidates=intents.selectToolIntentCandidates(text,available)
  const deterministicContext={hasExcelContext:ctx.hasExcelContext===true,hasPixivSearchSession:false,atQq,replyTargetUserId:ctx.replyTargetUserId,currentUserId:ctx.currentUserId||'10001',memberMap,rawText:text}
  const deterministic=intents.resolveDeterministicToolIntent(text,available,deterministicContext)
  const skip=Boolean(deterministic)||shouldSkipIntentModel({text,hasImages:images.length>0,hasVideos:videos.length>0,toolCandidates:candidates})
  const primaryRaw=skip||mode==='unavailable'?null:await classifyIntentWithModel({text,hasImages:images.length>0,config:modelConfig,fetchImpl:mockModelFetch(scenario,mode,false,intentCount)})
  // resolvePrimaryModelIntent is the production adapter around the classifier:
  // unavailable and confidence<0.7 are null before any routing/filter decisions.
  const primary=primaryRaw&&primaryRaw.intent!=='unavailable'&&primaryRaw.confidence>=0.7?primaryRaw:null
  const history=(ctx.history||[]).map(item=>({role:'user',content:item.content}))
  const session:RouteContext['session']={tools:[...definitions],atQq,memberMap,groupUserMessages:history,groupContextAssets:{...(ctx.replyTargetUserId?{replyTargetUserId:ctx.replyTargetUserId}:{})}}
  const promptContext=():ToolSemanticContext=>({e:{msg:text,raw_message:text},currentIntentText:text,args:text,msg:text,userContent:ctx.quote?`当前消息: ${text}\n引用消息（来源材料）: ${ctx.quote}`:text,images,videos,atQq,memberMap,currentUserId:ctx.currentUserId||'10001',replyTargetUserId:ctx.replyTargetUserId,groupUserMessages:history,modelIntent:primary?.intent,sessionTools:definitions})
  let plannerVisited=false
  const routeApi=createRouteDecision({resolveDeterministicToolIntent:intents.resolveDeterministicToolIntent,resolveNaturalDeltaForceToolCall:(text,options)=>{const result=resolveNaturalDeltaForceToolCall(text,options);return result?{params:{...result.params}}:null}})
  const route=await routeApi.resolveToolRoute({intentText:text,rawMsg:text,args:text,...(primary?{modelIntent:primary.intent}:{}),images,videos,groupId:'eval-group',userId:ctx.currentUserId||'10001',botName:'评测机器人',emojiCooldownMs:0,memberMap,hasExcelContext:ctx.hasExcelContext===true,hasPixivSearchSession:false,session,promptContext,imageGenerationReferenceImages:()=>images,applyTools:requested=>{session.tools=definitions.filter(tool=>requested.includes(tool.function?.name||''));return session.tools},log(){},helpers:{resolveSingularOwnerMention:()=>null,resolveForcedReplyTextRate:async()=>1,buildForcedToolCall:forcedCall,buildImageEditPrompt:host.buildImageEditPrompt,buildImageGenerationPrompt:host.buildImageGenerationPrompt,resolveContextualDrawGeneration:()=>null,buildToolCallFromDecision:(decision,context)=>api.buildToolCallFromDecision(host,decision,context) as ReturnType<RouteContext['helpers']['buildToolCallFromDecision']>,classifySemanticToolIntent:async context=>{plannerVisited=true;return api.classifySemanticToolIntent(host,context)},semanticSessionTools:()=>definitions}})
  let choice=route.toolChoice
  const beforeFilter=names(session.tools)
  const filterApplied=!route.toolScopeLocked&&choice==='auto'
  if(filterApplied){
    const utils=createConversationUtils({normalizeIntentText,isExplicitAdminCollectionMentionRequest,filterToolsForEmojiExposure:(tools,text,options)=>{const filtered=filterToolsForEmojiExposure(tools,text,options);return filtered?filtered.map(tool=>({...tool})):null},isRealtimeInfoRequest,isExplicitSearchRequest,SEARCH_TOOL_NAMES,shouldExposeEmojiToolForMessage,isExplicitToolIntent})
    // This is the production policy. New versions accept the candidates too;
    // old snapshots ignore the extra option, preserving their original behavior.
    const options={allowSearch:primary?.intent==='search',emojiCooldownMs:0,toolCandidates:candidates}
    session.tools=utils.filterToolsForMessageIntent(session.tools as (ToolDefinition & Record<string,unknown>)[],{msg:text,group_id:'eval-group'},text,options)
    if(!session.tools.length)choice='none'
  }
  const afterFilter=names(session.tools)
  const requested=route.toolDecision?(route.toolDecision.toolName?[route.toolDecision.toolName]:[]):intents.selectToolIntentCandidates(text,afterFilter)
  const planInput:TurnPlanInput&{keepAutoToolsOnChatTurn?:boolean}={responseKind:'chat',intentText:text,availableCapabilities:afterFilter,requiredCapabilities:requested,toolDecision:route.toolDecision,toolChoice:choice,toolScopeLocked:route.toolScopeLocked,forcedToolCall:route.forcedToolCall,explicitEmojiRequest:classifyEmojiToolExposure(text)==='explicit',historyMode:'full',selectedHistoryCount:history.length,...(scenario.config?.keepAutoToolsOnChatTurn!==undefined?{keepAutoToolsOnChatTurn:scenario.config.keepAutoToolsOnChatTurn}:{})}
  const plan=createTurnPlan(planInput),requestPlan=deriveTurnPlanRequest(plan)
  const executionNames=plan.execution.mode==='tool'?(plan.capabilities.required.length?plan.capabilities.required:plan.capabilities.optional):[]
  const executionTools=definitions.filter(tool=>executionNames.includes(tool.function?.name||''))
  const request=buildChatRequestData({useTools:scenario.config?.useTools!==false},[{role:'user',content:text}],executionTools as ChatTool[],requestPlan.toolChoice as ToolChoice)
  const directTool=route.forcedToolCall?.function?.name||null
  // chatTurn dispatches a forced call and returns before any main request.
  // Schemas in a hypothetical constructed request are not model exposure.
  const requestTools=directTool?[]:names(request.tools)
  const paramsRaw=route.forcedToolCall?.function?.arguments
  let actualParams:Record<string,unknown>|null=null
  try{actualParams=paramsRaw?record(JSON.parse(paramsRaw)):null}catch{}
  const expected=scenario.expectedTool||null,positive=scenario.expectedAction==='tool'
  const routingSuccess=positive?Boolean(expected&&(directTool===expected||(!directTool&&requestTools.includes(expected)))):null
  const parameterStatus:ExposureReplay['parameterStatus']=!positive?'n/a':!directTool?'unmeasured':!scenario.expectedParams?'n/a':directTool===expected&&Object.entries(scenario.expectedParams).every(([key,value])=>JSON.stringify(actualParams?.[key])===JSON.stringify(value))?'pass':'fail'
  const wanted=(tools:string[])=>positive?tools.includes(expected||''):tools.length>0
  const plannerGate=api.shouldUseSemanticToolIntent(host,{},text,images,videos,{knownToolCandidates:hasSemanticPlannerCandidate(candidates)?candidates:[],hasMemberMentions:atQq.length>0||Boolean(ctx.replyTargetUserId),modelIntent:primary?.intent})
  const stages:Record<string,ExposureStage>={
    manifest:{state:wanted(candidates)?'pass':'drop',reason:wanted(candidates)?'expected_manifest_candidate':candidates.length?'only_unrelated_candidates':'no_manifest_candidate',tools:candidates},
    intent:{state:deterministic?'bypass':skip?'drop':mode==='unavailable'?'n/a':'pass',reason:deterministic?'deterministic_skip':skip?'fast_path_skip':primary?.intent||'unavailable'},
    planner:{state:!plannerVisited?'bypass':mode==='unavailable'?'n/a':!plannerGate?'drop':route.toolDecision?'pass':'drop',reason:!plannerVisited?'earlier_direct_route':mode==='unavailable'?'unconfigured':!plannerGate?'planner_gate_closed':route.toolDecision?.intent||mode},
    filter:{state:!filterApplied?'bypass':wanted(afterFilter)?'pass':'drop',reason:!filterApplied?'locked_or_forced':wanted(afterFilter)?'exposed':afterFilter.length?'only_unrelated_tools':'empty_after_filter',tools:afterFilter},
    turnPlan:{state:wanted(executionNames)?'pass':'drop',reason:plan.observability.routeReason,tools:executionNames},
    request:{state:directTool?'bypass':wanted(requestTools)?'pass':'drop',reason:directTool?'direct_dispatch_no_main_request':requestTools.length?'tools_in_request':'no_tools_in_request',tools:requestTools}
  }
  const deadAt=!positive||routingSuccess?null:directTool?'wrong_direct_tool':route.toolDecision?.intent==='chat'?'planner_chat':!wanted(afterFilter)&&filterApplied?'filter':!executionNames.includes(expected||'')?'turnPlan':!requestTools.includes(expected||'')?'request':'unknown'
  return {id:scenario.id,family:scenario.family,split:scenario.split,difficulty:scenario.difficulty,text,modelReplay:mode,modelAssumption:assumptions[mode],expectedAction:scenario.expectedAction,expectedTool:expected,candidates,stages,primaryIntent:deterministic?'tool(deterministic_skip)':skip?'chat(fast_path_skip)':primary?.intent||'unavailable',plannerDecision:route.toolDecision,appliedRules:route.applied,executionMode:plan.execution.mode,toolChoice:requestPlan.toolChoice,requestTools,directTool,actualParams,routingSuccess,parameterStatus,unsafeDirectCall:!positive&&Boolean(directTool),negativeToolsExposed:!positive&&requestTools.length>0,deadAt,modelCalls:{intent:intentCount.calls,planner:plannerCount.calls},answerQuality:'unmeasured',toolResult:'not_executed'}
}

export function summarizeExposureRows(rows:ExposureReplay[]){
  const grouped:Record<string,{total:number;positives:number;reached:number;direct:number;exposed:number;unsafeDirect:number;negativeExposed:number;paramsMeasured:number;paramsPassed:number;stages:Record<string,{drop:number;applicable:number;dropRate:number}>}>={}
  for(const row of rows){
    const key=`${row.modelReplay}/${row.expectedTool||row.family}/${row.split}`
    const group=grouped[key]??={total:0,positives:0,reached:0,direct:0,exposed:0,unsafeDirect:0,negativeExposed:0,paramsMeasured:0,paramsPassed:0,stages:{}}
    group.total++;if(row.expectedAction==='tool'){group.positives++;if(row.routingSuccess)group.reached++}
    if(row.directTool)group.direct++;if(row.requestTools.length)group.exposed++
    if(row.unsafeDirectCall)group.unsafeDirect++;if(row.negativeToolsExposed)group.negativeExposed++
    if(row.parameterStatus==='pass'||row.parameterStatus==='fail'){group.paramsMeasured++;if(row.parameterStatus==='pass')group.paramsPassed++}
    for(const [stage,result] of Object.entries(row.stages)){
      const value=group.stages[stage]??={drop:0,applicable:0,dropRate:0}
      if(result.state==='pass'||result.state==='drop'){value.applicable++;if(result.state==='drop')value.drop++}
      value.dropRate=value.applicable?Math.round(value.drop/value.applicable*1000)/10:0
    }
    grouped[key]=group
  }
  return grouped
}

export async function evaluateToolExposure(fixture:ScenarioFixture,{modes=MODEL_REPLAYS,scenarioIds}:{modes?:ModelReplay[];scenarioIds?:string[]}={}){
  const selected=fixture.scenarios.filter(scenario=>!scenarioIds?.length||scenarioIds.includes(scenario.id)),rows:ExposureReplay[]=[]
  for(const scenario of selected)for(const mode of modes)rows.push(await replayToolExposureScenario(scenario,fixture,mode))
  return {schema:1,generatedAt:new Date().toISOString(),kind:'offline_branch_replay',scenarioCount:selected.length,modelReplays:modes,limitations:['固定输出只测试路由分支，不代表模型准确率','直调或进入模型网关请求的工具列表都算路由到达；未追踪后端降级后的消费，不代表实际调用','未执行任何工具、未访问 QQ、最终回答与证据真实性未测量','answer/clarify 场景仅统计误直调和曝光；最终答复是否正确需 live 主模型或运行时回放','负例曝光包含可选emoji，不等于误调用；误直调单独计数'],summary:summarizeExposureRows(rows),rows}
}

export function formatExposureReport(report:Awaited<ReturnType<typeof evaluateToolExposure>>,{details=true}={}){
  const lines=[`工具调用分支回放: ${report.scenarioCount} 个场景 / ${report.rows.length} 次；固定模型结果，不代表模型准确率。`,'直调或模型网关入口可见 = 路由到达，不代表后端消费/执行；参数只在已生成调用时计分。','工具/模型分支/样本组 | 到达 | 参数正确 | 负例直调 | 负例曝光 | A/B/C/D/E/F 丢分率']
  for(const [key,value] of Object.entries(report.summary))lines.push(`${key} | ${value.reached}/${value.positives} | ${value.paramsPassed}/${value.paramsMeasured} | ${value.unsafeDirect} | ${value.negativeExposed} | ${Object.values(value.stages).map(stage=>stage.applicable?`${stage.dropRate}%`:'n/a').join('/')}`)
  if(details){lines.push('\n逐条场景（A候选 B意图 C规划 D过滤 E计划 F请求；bypass为成功旁路，n/a不参与丢分率）:');for(const row of report.rows)lines.push(`${row.id} [${row.modelReplay}] ${row.text} | ${Object.values(row.stages).map(stage=>stage.state).join('/')} | direct=${row.directTool||'-'} tools=${row.requestTools.join(',')||'-'} | ${row.expectedAction==='tool'?(row.routingSuccess?'reached':`blocked:${row.deadAt}`):`negative direct=${row.unsafeDirectCall} exposed=${row.negativeToolsExposed}`} params=${row.parameterStatus}`)}
  lines.push('\n超时/未配置/无效输出分别统计兜底覆盖率。工具结果、最终回答与澄清质量未测量。')
  return lines.join('\n')
}

export interface LiveModelObservation {stage:string;status:'ok'|'skipped'|'error';model:string|null;ms:number;outputKind:string;intent?:string;confidence?:number;accepted?:boolean;tool?:string|null;parameters?:Record<string,unknown>|null;reason?:string;answer?:string;calls?:{name:string;params:Record<string,unknown>}[]}
export interface LiveConfig {intentAiConfig?:Record<string,unknown>;toolsAiConfig?:Record<string,unknown>;chatAiConfig?:Record<string,unknown>;providers?:string;useTools?:boolean}
function redactLiveText(text:string){return text.replace(/https?:\/\/[^\s"'<>]+/gi,'[endpoint]').replace(/\bsk-[A-Za-z0-9_-]+/g,'[secret]').replace(/Bearer\s+\S+/gi,'Bearer [secret]')}
export async function runLiveExposure(fixture:ScenarioFixture,config:LiveConfig,{scenarioIds,mainModel=false,fetchImpl=fetch}:{scenarioIds?:string[];mainModel?:boolean;fetchImpl?:typeof fetch}={}){
  initializeManifests()
  const observations:{id:string;expectedAction:string;expectedTool:string|null;models:LiveModelObservation[]}[]=[]
  const fast=config.intentAiConfig||{},tools=config.toolsAiConfig||{},chosen=fast.intentAiUrl?fast:tools
  const firstKey=(value:unknown)=>String(Array.isArray(value)?value[0]||'':value||'')
  const configured=(endpoint:unknown,key:unknown,model:unknown)=>Boolean(endpoint&&key&&model&&!String(key).includes('sk-xxx'))
  // Production intentionally chooses a whole backend for primary intent, but
  // resolves the semantic planner backend with per-field fallbacks.
  const intentKey=firstKey(chosen.intentAiApikey||chosen.toolsAiApikey),intentModel=String(chosen.intentAiModel||chosen.toolsAiModel||'gpt-4o-mini'),intentEndpoint=String(chosen.intentAiUrl||chosen.toolsAiUrl||'')
  const plannerKey=firstKey(fast.intentAiApikey||tools.toolsAiApikey),plannerModel=String(fast.intentAiModel||tools.toolsAiModel||''),plannerEndpoint=String(fast.intentAiUrl||tools.toolsAiUrl||'')
  const intentConfigured=configured(intentEndpoint,intentKey,intentModel),plannerConfigured=configured(plannerEndpoint,plannerKey,plannerModel)
  const productionConfig:SemanticToolHost['config']={intentAiConfig:{...(fast.intentAiUrl?{intentAiUrl:String(fast.intentAiUrl)}:{}),...(fast.intentAiApikey?{intentAiApikey:firstKey(fast.intentAiApikey)}:{}),...(fast.intentAiModel?{intentAiModel:String(fast.intentAiModel)}:{})},toolsAiConfig:{...(tools.toolsAiUrl?{toolsAiUrl:String(tools.toolsAiUrl)}:{}),...(tools.toolsAiApikey?{toolsAiApikey:firstKey(tools.toolsAiApikey)}:{}),...(tools.toolsAiModel?{toolsAiModel:String(tools.toolsAiModel)}:{})}}
  for(const scenario of fixture.scenarios.filter(item=>!scenarioIds?.length||scenarioIds.includes(item.id))){
    const models:LiveModelObservation[]=[],ctx=scenario.context||{}
    let intent:Awaited<ReturnType<typeof classifyIntentWithModel>>|null=null
    if(!intentConfigured)models.push({stage:'intent',status:'skipped',model:intentEndpoint?intentModel:null,ms:0,outputKind:'none',reason:'生产意图后端缺少 endpoint/key'})
    else{
      const start=Date.now()
      intent=await classifyIntentWithModel({text:scenario.text,hasImages:Boolean(ctx.images?.length),config:productionConfig,fetchImpl})
      models.push({stage:'intent',status:intent.intent==='unavailable'?'error':'ok',model:intentModel,ms:Date.now()-start,outputKind:'classification',intent:intent.intent,confidence:intent.confidence,accepted:intent.intent!=='unavailable'&&intent.confidence>=0.7,reason:redactLiveText(intent.reason)})
    }
    const accepted=Boolean(intent&&intent.intent!=='unavailable'&&intent.confidence>=0.7)
    if(!plannerConfigured)models.push({stage:'planner',status:'skipped',model:plannerModel||null,ms:0,outputKind:'none',reason:'生产规划器后端缺少 endpoint/key/model'})
    else{
      const definitions=(scenario.availableTools||Object.keys(fixture.tools)).map(name=>({type:'function',function:{name,...fixture.tools[name]}}))
      let called=false
      const {api,host}=semanticHarness(definitions,scenario,productionConfig,async(...args)=>{called=true;return fetchImpl(...args)})
      const memberMap=new Map((ctx.members||[]).map(member=>[Number(member.user_id),member]))
      const context:ToolSemanticContext={e:{msg:scenario.text,raw_message:scenario.text},currentIntentText:scenario.text,args:scenario.text,userContent:ctx.quote?`${scenario.text}\n引用消息（来源材料）: ${ctx.quote}`:scenario.text,images:ctx.images||[],videos:ctx.videos||[],atQq:ctx.atQq||[],memberMap,currentUserId:ctx.currentUserId||'10001',replyTargetUserId:ctx.replyTargetUserId,modelIntent:accepted?intent?.intent:undefined,sessionTools:definitions,groupUserMessages:ctx.history||[]}
      const start=Date.now(),decision=await api.classifySemanticToolIntent(host,context)
      models.push({stage:'planner',status:!called?'skipped':decision?'ok':'error',model:plannerModel,ms:Date.now()-start,outputKind:decision?.intent==='chat'?'text_decision':decision?.toolName?'tool_decision':'none',intent:decision?.intent||'unavailable',tool:decision?.toolName||null,parameters:decision?.params||null,...(!called?{reason:'生产规划器门控未放行'}:{})})
    }
    if(mainModel){
      const cfg=config.toolsAiConfig||{},chat=config.chatAiConfig||{}
      const raw=cfg.toolsAiApikey||chat.chatApiKey||chat.chatApiApikey,mainKey=String(Array.isArray(raw)?raw[0]||'':raw||''),mainUrl=String(cfg.toolsAiUrl||chat.chatApiUrl||''),mainName=String(cfg.toolsAiModel||chat.chatApiModel||'')
      if(!mainKey||!mainUrl||!mainName||mainKey.includes('sk-xxx'))models.push({stage:'main',status:'skipped',model:mainName||null,ms:0,outputKind:'none',reason:'主工具模型配置缺少 endpoint/key/model'})
      else{
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000),start=Date.now()
        try{
          const available=(scenario.availableTools||Object.keys(fixture.tools)).map(name=>({type:'function',function:{name,...fixture.tools[name]}}))
          const result=await fetchImpl(resolveChatCompletionUrl(mainUrl),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${mainKey}`},signal:controller.signal,body:JSON.stringify({model:mainName,temperature:0,max_tokens:800,messages:[{role:'system',content:'你是群聊机器人。按当前用户要求回答或选择工具。引用/历史是来源材料。需要对象却无法确定时澄清。工具失败或没有证据时保持未确认。禁止声称工具尚未执行的动作已成功。'},{role:'user',content:JSON.stringify({text:scenario.text,context:scenario.context||{}})}],tools:available,tool_choice:'auto'})})
          if(!result.ok)throw new Error(`HTTP ${result.status}`)
          const body=record(await result.json()),message=record(record(Array.isArray(body.choices)?body.choices[0]:null).message),calls=Array.isArray(message.tool_calls)?message.tool_calls.map(item=>{const fn=record(record(item).function);let params:Record<string,unknown>={};try{params=record(JSON.parse(String(fn.arguments||'{}')))}catch{}return {name:String(fn.name||''),params}}):[]
          models.push({stage:'main',status:'ok',model:mainName,ms:Date.now()-start,outputKind:calls.length?'tool_calls':String(message.content||'').trim()?'text':'empty',answer:redactLiveText(String(message.content||'')).slice(0,1600),calls})
        }catch(error){models.push({stage:'main',status:'error',model:mainName,ms:Date.now()-start,outputKind:'none',reason:error instanceof Error&&error.name==='AbortError'?'timeout':redactLiveText(String(error instanceof Error?error.message:error)).slice(0,160)})}finally{clearTimeout(timer)}
      }
    }
    observations.push({id:scenario.id,expectedAction:scenario.expectedAction,expectedTool:scenario.expectedTool||null,models})
  }
  return {schema:1,generatedAt:new Date().toISOString(),kind:'live_model_sandbox',limitations:['仅请求模型；不执行工具、不访问 QQ、不写业务数据','主模型沙箱观察可用 schema 下的文本/调用，不代表完整生产上下文与后端降级表现','真实模型输出用于分析，不自动把模型意见当真值'],observations}
}

export function readExposureFixture(file:string):ScenarioFixture{return validateExposureFixture(JSON.parse(fs.readFileSync(path.resolve(file),'utf8')))}
