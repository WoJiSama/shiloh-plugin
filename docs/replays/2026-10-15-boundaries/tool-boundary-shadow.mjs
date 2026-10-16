// Classification-only shadow replay. Fixed synthetic schemas; no tool or platform execution.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
const [root,base,label]=process.argv.slice(2);
if(!root||!base||!/^[-a-zA-Z0-9_]+$/.test(label||''))throw new Error('runtime, private base and label required');
const require=createRequire(path.join(root,'package.json'));
const YAML=require('yaml');
const load=p=>import(pathToFileURL(path.join(root,p)).href);
const [{createSemanticToolIntent},{isExplicitAdminCollectionMentionRequest},{selectToolIntentCandidates},{buildToolSkillCatalog,normalizeToolSkillParams},{resolveMemberAvatarReferences},{resolvePersonaName},{hasSemanticPlannerCandidate,shouldRunSemanticToolPlanner},{fetchWithTimeout},{resolveChatCompletionUrl},{buildTurnInteractionContext},{mergeDeepConfig},{decodeHostConfig}]=await Promise.all([
  load('dist/backend/modules/tools/infrastructure/semanticToolIntent.js'),load('utils/mentionRoleRouting.js'),load('utils/toolIntentManifests.js'),load('utils/toolSkills.js'),load('apps/lib/avatarReference.js'),load('utils/personaSource.js'),load('utils/semanticToolPolicy.js'),load('utils/modelGateway.js'),load('utils/chatCompletionUrl.js'),load('dist/backend/modules/conversation/domain/turnInteractionContext.js'),load('dist/backend/modules/config/infrastructure/configStore.js'),load('dist/backend/modules/host/infrastructure/hostConfig.js')]);
const {createReplayScrubber}=await import(pathToFileURL(path.join(base,'eval/conversationQualityReplay.mjs')).href);
const hash=v=>createHash('sha256').update(v).digest('hex');
const readYaml=p=>{const d=YAML.parse(fs.readFileSync(p,'utf8'));return d.pluginSettings||d;};
const configFile=path.join(base,'config-snapshot/config/message.yaml');
const config=decodeHostConfig(mergeDeepConfig(readYaml(path.join(root,'config_default/message.yaml')),readYaml(configFile)));
const scrub=createReplayScrubber(config);
const scenarioFile=path.join(base,'tool-boundary-scenarios.json');
const scenarios=JSON.parse(fs.readFileSync(scenarioFile,'utf8'));
const local=[
 {name:'reminderTool',description:'创建定时提醒，只在指定时间给用户发提醒，不等于替用户订餐、预约或付款。',parameters:{type:'object',properties:{action:{type:'string',enum:['create','list','cancel']},content:{type:'string'},time:{type:'string',description:'ISO8601提醒时间'}},required:['action']}},
 {name:'searchInformationTool',description:'搜索网络获取信息。可以查营业时间，不能提交订单、付款或完成预约。',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}}
];
const mcp={name:'mcp_reserve_table',description:'向已接入的餐厅系统提交真实餐位预约；不处理付款。须有餐厅、时间、人数且用户要求提交。',parameters:{type:'object',properties:{restaurant:{type:'string'},dateTime:{type:'string'},partySize:{type:'integer'}},required:['restaurant','dateTime','partySize']}};
const output=path.join(base,`${label}-tool-decisions.json`);
if(fs.existsSync(output))throw new Error('Refusing to overwrite an existing run');
const document={complete:false,label,repetitions:3,concurrency:3,fixtureKind:'fixed_synthetic_tool_schemas_with_real_classifier_model',toolExecutions:0,platformMessagesSent:0,productionStoreWrites:0,metadata:{runtimeCommit:JSON.parse(fs.readFileSync(path.join(root,'release-manifest.json'),'utf8')).commit,scriptHash:hash(fs.readFileSync(fileURLToPath(import.meta.url))),scenariosHash:hash(fs.readFileSync(scenarioFile)),schemasHash:hash(JSON.stringify({local,mcp})),configHash:hash(fs.readFileSync(configFile)),configuredIntentModel:config.intentAiConfig?.intentAiModel||config.toolsAiConfig?.toolsAiModel||null},results:[]};
function save(){fs.writeFileSync(output+'.tmp',JSON.stringify(document,null,2),{mode:0o600});fs.renameSync(output+'.tmp',output);}
save();
async function run(scenario,sampleIndex){
 const warnings=[],network=[];let rawDecision=null;
 const semantic=createSemanticToolIntent({logger:{warn:m=>warnings.push(scrub(m)),info(){}},isExplicitAdminCollectionMentionRequest,selectToolIntentCandidates,normalizeToolSkillParams,resolveMemberAvatarReferences,buildToolSkillCatalog,resolvePersonaName,hasSemanticPlannerCandidate,shouldRunSemanticToolPlanner,
  fetchWithTimeout:async(url,options,timeout)=>{const payload=JSON.parse(options.body);const receipt={model:payload.model,temperature:payload.temperature,urlHost:new URL(url).host};try{const r=await fetchWithTimeout(url,options,timeout);network.push({...receipt,status:r.status});return r;}catch(e){network.push({...receipt,status:null,error:scrub(String(e.message||e))});throw e;}}
 });
 const host={config,toolInstances:Object.fromEntries(local.map(t=>[t.name,t])),resolveChatCompletionUrl,
  buildImageGenerationPrompt:c=>c.prompt||c.currentIntentText||'',buildImageEditPrompt:c=>c.prompt||c.currentIntentText||'',
  shouldUseSemanticToolIntent(...a){return semantic.shouldUseSemanticToolIntent(this,...a);},extractJsonObject(...a){return semantic.extractJsonObject(this,...a);},normalizeToolDecision(d,c){rawDecision=structuredClone(d);return semantic.normalizeToolDecision(this,d,c);},
  getToolsByName(){throw new Error('Tool execution is disabled in this replay');},buildForcedToolCall(){throw new Error('Tool execution is disabled in this replay');},resolveContextualDrawGeneration(){return null;}
 };
 const interactionContext=buildTurnInteractionContext({rawUserText:scenario.text,botId:'99',speaker:{userId:'202',name:'测试用户'},addressee:{targetKind:'bot'},quote:scenario.quote?{text:scenario.quote,userId:'303',messageId:'synthetic-quote',label:'另一位测试用户'}:undefined});
 const definitions=[...local,...(scenario.mcp?[mcp]:[])].map(t=>({type:'function',function:t}));
 const context={currentIntentText:scenario.text,args:scenario.text,msg:scenario.text,userContent:scenario.text+(scenario.quote?`\n[引用 另一位测试用户: ${scenario.quote}]`:''),images:[],videos:[],atQq:['99'],currentUserId:'202',interactionContext,sessionTools:definitions};
 let decision,error;try{decision=await semantic.classifySemanticToolIntent(host,context);}catch(e){error=scrub(String(e.message||e));}
 const actual=decision?.intent==='chat'?'chat':decision?.toolName||null;
 return {id:scenario.id,sampleIndex,input:scenario.text,...(scenario.quote?{quote:scenario.quote}:{}),expected:scenario.expected,actual,passed:actual===scenario.expected,decision,rawDecision:rawDecision?JSON.parse(scrub(JSON.stringify(rawDecision))):null,network,warnings,...(error?{error}:{})};
}
const jobs=scenarios.flatMap(s=>Array.from({length:3},(_,i)=>[s,i+1]));let next=0;
async function worker(){while(next<jobs.length){const [s,i]=jobs[next++];document.results.push(await run(s,i));save();}}
await Promise.all([worker(),worker(),worker()]);
document.results.sort((a,b)=>scenarios.findIndex(s=>s.id===a.id)-scenarios.findIndex(s=>s.id===b.id)||a.sampleIndex-b.sampleIndex);
document.complete=true;save();
console.log(JSON.stringify({complete:true,label,total:document.results.length,passed:document.results.filter(r=>r.passed).length,toolExecutions:0,platformMessagesSent:0,productionStoreWrites:0}));
