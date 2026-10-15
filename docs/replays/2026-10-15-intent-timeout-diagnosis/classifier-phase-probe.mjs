import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const root='/opt/trss-yunzai/plugins/shiloh-plugin';
const base='/tmp/bl-intent-timeout-investigation-20261015';
const old='/tmp/bl-latest-forward-fix-20261015';
const require=createRequire(path.join(root,'package.json'));
const YAML=require('yaml');
const load=p=>import(pathToFileURL(path.join(root,p)).href);
const [{createSemanticToolIntent},{isExplicitAdminCollectionMentionRequest},{selectToolIntentCandidates},{buildToolSkillCatalog,normalizeToolSkillParams},{resolveMemberAvatarReferences},{resolvePersonaName},{hasSemanticPlannerCandidate,shouldRunSemanticToolPlanner},{resolveChatCompletionUrl},{buildTurnInteractionContext},{mergeDeepConfig},{decodeHostConfig}]=await Promise.all([
load('dist/backend/modules/tools/infrastructure/semanticToolIntent.js'),load('utils/mentionRoleRouting.js'),load('utils/toolIntentManifests.js'),load('utils/toolSkills.js'),load('apps/lib/avatarReference.js'),load('utils/personaSource.js'),load('utils/semanticToolPolicy.js'),load('utils/chatCompletionUrl.js'),load('dist/backend/modules/conversation/domain/turnInteractionContext.js'),load('dist/backend/modules/config/infrastructure/configStore.js'),load('dist/backend/modules/host/infrastructure/hostConfig.js')]);
const readYaml=p=>{const d=YAML.parse(fs.readFileSync(p,'utf8'));return d.pluginSettings||d;};
const config=decodeHostConfig(mergeDeepConfig(readYaml(path.join(root,'config_default/message.yaml')),readYaml(path.join(old,'config-snapshot/config/message.yaml'))));
const scenario=JSON.parse(fs.readFileSync(path.join(old,'tool-boundary-scenarios.json'),'utf8'))[0];
const local=[
{name:'reminderTool',description:'创建定时提醒，只在指定时间给用户发提醒，不等于替用户订餐、预约或付款。',parameters:{type:'object',properties:{action:{type:'string',enum:['create','list','cancel']},content:{type:'string'},time:{type:'string',description:'ISO8601提醒时间'}},required:['action']}},
{name:'searchInformationTool',description:'搜索网络获取信息。可以查营业时间，不能提交订单、付款或完成预约。',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}}
];
const mcp={name:'mcp_reserve_table',description:'向已接入的餐厅系统提交真实餐位预约；不处理付款。须有餐厅、时间、人数且用户要求提交。',parameters:{type:'object',properties:{restaurant:{type:'string'},dateTime:{type:'string'},partySize:{type:'integer'}},required:['restaurant','dateTime','partySize']}};
let captured;
const semantic=createSemanticToolIntent({logger:{warn(){},info(){}},isExplicitAdminCollectionMentionRequest,selectToolIntentCandidates,normalizeToolSkillParams,resolveMemberAvatarReferences,buildToolSkillCatalog,resolvePersonaName,hasSemanticPlannerCandidate,shouldRunSemanticToolPlanner,
 fetchWithTimeout:async(url,options,timeout)=>{captured={url,options,budgetMs:timeout};return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'chat',confidence:1})}}]}),{status:200});}
});
const host={config,toolInstances:Object.fromEntries(local.map(t=>[t.name,t])),resolveChatCompletionUrl,
buildImageGenerationPrompt:c=>c.prompt||c.currentIntentText||'',buildImageEditPrompt:c=>c.prompt||c.currentIntentText||'',
shouldUseSemanticToolIntent(...a){return semantic.shouldUseSemanticToolIntent(this,...a);},extractJsonObject(...a){return semantic.extractJsonObject(this,...a);},normalizeToolDecision(d,c){return semantic.normalizeToolDecision(this,d,c);},
getToolsByName(){throw new Error('Tools disabled');},buildForcedToolCall(){throw new Error('Tools disabled');},resolveContextualDrawGeneration(){return null;}};
const interactionContext=buildTurnInteractionContext({rawUserText:scenario.text,botId:'99',speaker:{userId:'202',name:'测试用户'},addressee:{targetKind:'bot'},quote:scenario.quote?{text:scenario.quote,userId:'303',messageId:'synthetic-quote',label:'另一位测试用户'}:undefined});
const definitions=[...local,...(scenario.mcp?[mcp]:[])].map(t=>({type:'function',function:t}));
const context={currentIntentText:scenario.text,args:scenario.text,msg:scenario.text,userContent:scenario.text+(scenario.quote?`\n[引用 另一位测试用户: ${scenario.quote}]`:''),images:[],videos:[],atQq:['99'],currentUserId:'202',interactionContext,sessionTools:definitions};
await semantic.classifySemanticToolIntent(host,context);
if(!captured)throw new Error('Expected classifier request');
const payload=JSON.parse(captured.options.body);
const output={checkedAt:new Date().toISOString(),kind:'phase_diagnostic_not_formal_replay',configuredModel:payload.model,productionBudgetMs:captured.budgetMs,syntheticScenarioId:scenario.id,toolExecutions:0,platformMessagesSent:0,productionStoreWrites:0,results:[]};
const file=path.join(base,'classifier-phase-results.json');
if(fs.existsSync(file))throw new Error('Refusing to overwrite probe results');
const save=()=>fs.writeFileSync(file,JSON.stringify(output,null,2)+'\n',{mode:0o600});
save();
async function probe(label,body){
 const t=performance.now(),ac=new AbortController(),timer=setTimeout(()=>ac.abort(),20000);
 const row={label,budgetMs:20000,requestBytes:Buffer.byteLength(JSON.stringify(body)),systemChars:body.messages.filter(x=>x.role==='system').reduce((s,x)=>s+x.content.length,0),bodyKeys:Object.keys(body),messageRoles:body.messages.map(m=>m.role),headersMs:null,firstBodyMs:null,bodyCompleteMs:null,status:null,bytes:0};
 try{
  const response=await fetch(captured.url,{...captured.options,body:JSON.stringify(body),signal:ac.signal});
  row.headersMs=Math.round(performance.now()-t);row.status=response.status;row.contentType=response.headers.get('content-type');
  const reader=response.body?.getReader(),chunks=[];
  if(reader)while(true){const {done,value}=await reader.read();if(done)break;if(row.firstBodyMs===null)row.firstBodyMs=Math.round(performance.now()-t);row.bytes+=value.byteLength;chunks.push(value);}
  row.bodyCompleteMs=Math.round(performance.now()-t);
  try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));const m=data.choices?.[0]?.message||{};row.jsonParsed=true;row.responseModel=data.model||null;row.finishReason=data.choices?.[0]?.finish_reason||null;row.contentChars=String(m.content||'').length;row.reasoningChars=String(m.reasoning_content||'').length;row.usage=data.usage||null;row.contentHash=createHash('sha256').update(String(m.content||'')).digest('hex');try{row.intent=JSON.parse(m.content).intent||null;}catch{}if(data.error)row.apiErrorType=String(data.error.type||data.error.code||'error').slice(0,80);}catch{row.jsonParsed=false;}
 }catch(e){row.error={name:e.name,code:e.code||e.cause?.code||null,timeout:ac.signal.aborted};}
 finally{clearTimeout(timer);row.elapsedMs=Math.round(performance.now()-t);row.withinProductionBudget=row.bodyCompleteMs!==null&&row.bodyCompleteMs<=captured.budgetMs;output.results.push(row);save();console.log(JSON.stringify(row));}
}
await probe('previous-minimal-diagnostic',{model:payload.model,temperature:0,stream:false,messages:[{role:'system',content:'你是意图分类器，只输出严格JSON。不要解释。'},{role:'user',content:'不需要调用任何工具，只聊天。输出 {"intent":"chat","confidence":1}'}]});
await probe('full-classifier-default',payload);
await probe('full-classifier-thinking-disabled',{...payload,thinking:{type:'disabled'}});
