import test from 'node:test'
import assert from 'node:assert/strict'
import {createHostSharedState} from '../dist/backend/modules/host/infrastructure/hostSharedState.js'
function runtime(){
 const jobs=[],published=[],installed=[];let refreshes=0
 class MessageManager{constructor(){this.GROUP_MAX_MESSAGES=100}setCacheExpire(options){this.cache=options}}
 class EmotionManager{constructor(config){this.config={eventWeights:{},...config}}}
 class MemoryManager{constructor(config){this.config=config}updateConfig(config){this.config=config}}
 class ExpressionLearner{constructor(config){this.config=config}}
 const music={musicCookies:{},updateTime:1,updateQQMusicCk:async()=>{refreshes++}}
 const snapshot={toolInstances:{searchMusicTool:music},functions:[],functionMap:new Map(),toolSkills:[],customToolCount:0,builtInToolCount:1}
 const shared=createHostSharedState({cwd:'/nonexistent',MessageManager,EmotionManager,MemoryManager,ExpressionLearner,localToolRegistry:{getSnapshot:()=>snapshot,reload:async()=>snapshot},logger:{info(){},error(){}},installRuntime:(config,state)=>installed.push({config,state}),publishState:state=>published.push(state),toolConfigHasName:()=>true,scheduleJob:(cron,job)=>jobs.push({cron,job})})
 return {...shared,jobs,published,installed,getRefreshes:()=>refreshes}
}
test('compiled shared state retains service identity and applies hot config',async()=>{const r=runtime();const first=r.initializeSharedState({groupMaxMessages:20,memorySystem:{enabled:true}});const second=r.initializeSharedState({groupMaxMessages:40,groupChatMemoryMinutes:15,memorySystem:{enabled:false},emotionSystem:{eventWeights:{reply:4}}});assert.equal(first,second);assert.equal(second.messageManager.GROUP_MAX_MESSAGES,40);assert.equal(second.messageManager.cache.cacheExpireMinutes,15);assert.equal(second.memoryManager.config.enabled,false);assert.equal(second.emotionManager.config.eventWeights.reply,4);assert.equal(r.published.length,1);assert.equal(r.installed.length,2)})
test('compiled shared state enables music refresh on hot update without duplicate jobs',()=>{const r=runtime();r.initializeSharedState({});assert.equal(r.jobs.length,0);r.initializeSharedState({qqMusicToken:'fixture'});r.initializeSharedState({qqMusicToken:'fixture'});assert.equal(r.jobs.length,1);assert.equal(r.getRefreshes(),1)})
