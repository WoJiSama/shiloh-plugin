import type {ChatTurnSession} from '../../../contracts/chatTurn.js'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import type {createMemoryManagerClass} from '../../memory/infrastructure/memoryManager.js'
import type {createEmotionManagerClass} from '../../memory/application/emotionManager.js'
import type {createExpressionLearnerClass} from '../../memory/application/expressionLearner.js'
import type {createMessageManagerClass} from '../../messaging/application/recentMessages.js'
import KnowledgeSearcher from '../../knowledge/infrastructure/KnowledgeSearcher.js'
import KnowledgeExpander from '../../knowledge/infrastructure/KnowledgeExpander.js'
import {applyToolRegistrySnapshot,refreshLocalToolSnapshot,type LocalToolRegistry} from '../../tools/infrastructure/LocalToolRegistry.js'
type MemoryClass=ReturnType<typeof createMemoryManagerClass>
type EmotionClass=ReturnType<typeof createEmotionManagerClass>
type ExpressionClass=ReturnType<typeof createExpressionLearnerClass>
type MessageClass=ReturnType<typeof createMessageManagerClass>
export interface HostSharedConfig {
 groupMaxMessages?:number;groupChatMemoryMinutes?:number;groupChatMemoryDays?:number;
 emotionSystem?:ConstructorParameters<EmotionClass>[0];memorySystem?:ConstructorParameters<MemoryClass>[0];
 expressionLearning?:ConstructorParameters<ExpressionClass>[0];memoryAiConfig?:{memoryAiUrl?:string;memoryAiApikey?:string;memoryAiModel?:string}|null;
 embeddingAiConfig?:{embeddingApiKey?:string;embeddingApiUrl?:string;embeddingApiModel?:string}|null;
 knowledgeSystem?:{enabled?:boolean;topN?:number;threshold?:number};oneapi_tools?:unknown;qqMusicToken?:string
}
interface SharedCore {messageManager:InstanceType<MessageClass>;emotionManager:InstanceType<EmotionClass>;memoryManager:InstanceType<MemoryClass>;expressionLearner:InstanceType<ExpressionClass>;knowledgeSearcher:KnowledgeSearcher|null;sessionMap:Map<string,ChatTurnSession>}
export type HostSharedState=SharedCore & Omit<ReturnType<LocalToolRegistry['getSnapshot']>,'toolSkills'>
interface MusicTool {musicCookies:{qqmusic?:string};updateTime:number;updateQQMusicCk():Promise<unknown>}
function musicTool(value:unknown):value is MusicTool {if(!value||typeof value!=='object')return false;return 'musicCookies' in value&&!!value.musicCookies&&typeof value.musicCookies==='object'&&'updateQQMusicCk'in value&&typeof value.updateQQMusicCk==='function'}
export interface HostSharedPorts {
 cwd:string;MessageManager:MessageClass;MemoryManager:MemoryClass;EmotionManager:EmotionClass;ExpressionLearner:ExpressionClass;
 localToolRegistry:LocalToolRegistry;logger:{info(message:string):void;error(message:string,error?:unknown):void};
 installRuntime(config:HostSharedConfig,state:HostSharedState):void;publishState(state:HostSharedState):void;
 toolConfigHasName(config:unknown,name:string):boolean;scheduleJob(expression:string,work:()=>Promise<void>):unknown
}
export function createHostSharedState(ports:HostSharedPorts){
 let state:HostSharedState|null=null
 let musicJobStarted=false
 const memoryConfig=(config:HostSharedConfig)=>({...config.memorySystem,...(config.memoryAiConfig?{memoryAiConfig:config.memoryAiConfig}:{}) ,...(config.embeddingAiConfig?{embeddingAiConfig:config.embeddingAiConfig}:{})})
 const cacheOptions=(config:HostSharedConfig)=>({...config.groupChatMemoryMinutes===undefined?{}:{cacheExpireMinutes:config.groupChatMemoryMinutes},...config.groupChatMemoryDays===undefined?{}:{cacheExpireDays:config.groupChatMemoryDays}})
 const knowledgeConfig=(config:HostSharedConfig)=>({apiKey:config.embeddingAiConfig?.embeddingApiKey||'',apiUrl:config.embeddingAiConfig?.embeddingApiUrl||'',dbPath:path.join(ports.cwd,'plugins/shiloh-plugin/database/knowledge-db.ndjson'),model:config.embeddingAiConfig?.embeddingApiModel||'text-embedding-3-small',topN:config.knowledgeSystem?.topN||4,threshold:config.knowledgeSystem?.threshold||0.6})
 function initMusicCookieRefresh(tool:unknown,config:HostSharedConfig){
  if(!musicTool(tool)||!config.qqMusicToken||musicJobStarted)return
  musicJobStarted=true;tool.musicCookies.qqmusic=config.qqMusicToken
  void tool.updateQQMusicCk().catch(error=>ports.logger.error('[SearchMusicTool] 初始化刷新失败',error))
  ports.scheduleJob('*/10 * * * *',async()=>{try{
   const raw:unknown=YAML.parse(fs.readFileSync(path.join(ports.cwd,'plugins/shiloh-plugin/config/message.yaml'),'utf8'))
   if(raw&&typeof raw==='object'&&'pluginSettings'in raw){const settings=raw.pluginSettings;if(settings&&typeof settings==='object'&&'qqMusicToken'in settings&&typeof settings.qqMusicToken==='string')tool.musicCookies.qqmusic=settings.qqMusicToken}
   tool.updateTime=0;await tool.updateQQMusicCk()
  }catch(error){ports.logger.error('[SearchMusicTool] 定时刷新失败',error)}})
 }
 function initializeSharedState(config:HostSharedConfig):HostSharedState {
  if(state){
   state.messageManager.GROUP_MAX_MESSAGES=config.groupMaxMessages||100;state.messageManager.setCacheExpire(cacheOptions(config))
   Object.assign(state.emotionManager.config,{decayRate:config.emotionSystem?.decayRate||0.02,eventWeights:{...state.emotionManager.config.eventWeights,...config.emotionSystem?.eventWeights}})
   state.memoryManager.updateConfig(memoryConfig(config));Object.assign(state.expressionLearner.config,{...config.expressionLearning,memoryAiConfig:config.memoryAiConfig||null})
   if(config.knowledgeSystem?.enabled){if(state.knowledgeSearcher)Object.assign(state.knowledgeSearcher,knowledgeConfig(config));else state.knowledgeSearcher=new KnowledgeSearcher(knowledgeConfig(config))}else state.knowledgeSearcher=null
  }else{
   state=applyToolRegistrySnapshot({messageManager:new ports.MessageManager({privateMaxMessages:100,...config.groupMaxMessages===undefined?{}:{groupMaxMessages:config.groupMaxMessages},messageMaxLength:9999,...cacheOptions(config)}),emotionManager:new ports.EmotionManager(config.emotionSystem||{}),memoryManager:new ports.MemoryManager(memoryConfig(config)),expressionLearner:new ports.ExpressionLearner({...config.expressionLearning,memoryAiConfig:config.memoryAiConfig||null}),knowledgeSearcher:config.knowledgeSystem?.enabled?new KnowledgeSearcher(knowledgeConfig(config)):null,sessionMap:new Map<string,ChatTurnSession>()},ports.localToolRegistry.getSnapshot())
   ports.publishState(state)
   const db=knowledgeConfig(config).dbPath,source=path.join(ports.cwd,'plugins/shiloh-plugin/database_default/knowledge-base.txt')
   if(config.knowledgeSystem?.enabled&&!fs.existsSync(db)&&fs.existsSync(source)){
    fs.mkdirSync(path.dirname(db),{recursive:true});const texts=fs.readFileSync(source,'utf8').split('\n').filter(Boolean),expander=new KnowledgeExpander(knowledgeConfig(config))
    void(async()=>{for(let i=0;i<texts.length;i+=50){try{const result=await expander.expand(texts.slice(i,i+50));ports.logger.info(`[知识库] 新增 ${result.added} 条`)}catch(error){ports.logger.error('[知识库] 自动导入失败',error)}if(i+50<texts.length)await new Promise(resolve=>setTimeout(resolve,1000))}})().catch(error=>ports.logger.error('[知识库] 自动导入失败',error))
   }
  }
  ports.installRuntime(config,state)
  void refreshLocalToolSnapshot(state,ports.localToolRegistry,{force:true}).catch(error=>ports.logger.error('[LocalToolRegistry] 工具刷新失败',error))
  applyToolRegistrySnapshot(state,ports.localToolRegistry.getSnapshot())
  if(ports.toolConfigHasName(config.oneapi_tools,'searchMusicTool'))initMusicCookieRefresh(state.toolInstances.searchMusicTool,config)
  return state
 }
 return {initializeSharedState,initMusicCookieRefresh,getState:()=>state,applyToolRegistrySnapshot:(current:HostSharedState=state!)=>applyToolRegistrySnapshot(current,ports.localToolRegistry.getSnapshot()),refreshLocalTools:(current:HostSharedState=state!,options:{force?:boolean}={})=>refreshLocalToolSnapshot(current,ports.localToolRegistry,options)}
}
