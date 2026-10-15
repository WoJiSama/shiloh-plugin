// Real memory modules with a caller-owned isolated store. This helper never
// imports host globals, production Redis or a platform transport.
import {createHash} from 'node:crypto';
const scope=value=>value&&['botId','personaId','personaVersion','personaName'].every(key=>typeof value[key]==='string')?Object.fromEntries(['botId','personaId','personaVersion','personaName'].map(key=>[key,value[key]])):undefined;

export async function createReplayMemory({load,config,redis,fetchImpl,scrub=String,dryRun=false,captures}) {
  if(!redis || typeof redis.get!=='function' || typeof redis.set!=='function' || typeof redis.del!=='function') throw new TypeError('An isolated replay store is required');
  const {createMemoryManagerClass}=await load('modules/memory/infrastructure/memoryManager.js');
  const {resolveChatCompletionUrl}=await load('modules/models/domain/chatCompletionUrl.js');
  const pending=new Set();
  const logger={warn(...args){captures.warnings.push(scrub(args.map(String).join(' ')))},error(...args){captures.errors.push({message:scrub(args.map(String).join(' '))})}};
  const llm={logger,call:async ({url,apikey,model,messages,temperature,maxTokens,timeoutMs}) => {
    const startedAt=Date.now();
    const evidence={model,messageHash:createHash('sha256').update(JSON.stringify(messages)).digest('hex'),temperature,maxTokens,timeoutMs};
    if(dryRun){captures.memoryNetwork.push({...evidence,stub:true,status:null,elapsedMs:0});return {ok:true,content:'[]'};}
    try {
      const response=await fetchImpl(resolveChatCompletionUrl(url),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${Array.isArray(apikey)?apikey[0]:apikey}`},body:JSON.stringify({model,messages,temperature,max_tokens:maxTokens,stream:false})},timeoutMs);
      const data=await response.json();
      const content=data?.choices?.[0]?.message?.content;
      captures.memoryNetwork.push({...evidence,status:response.status,elapsedMs:Date.now()-startedAt});
      return response.ok && typeof content==='string' ? {ok:true,content} : {ok:false,error:`HTTP ${response.status} or empty content`};
    } catch(error) {
      captures.memoryNetwork.push({...evidence,status:null,elapsedMs:Date.now()-startedAt,error:scrub(error instanceof Error?error.message:String(error))});
      return {ok:false,error:'isolated replay memory request failed'};
    }
  }};
  const MemoryManager=createMemoryManagerClass({llm,logger,defaultRedis:redis});
  const manager=new MemoryManager({...config.memorySystem,enabled:true,memoryAiConfig:config.memoryAiConfig||{},embeddingAiConfig:{},semanticRecallEnabled:false,userExtractDebounceSeconds:0,userExtractMaxBatchMessages:1,reflectEntityThreshold:1000,reflectGroupThreshold:1000},{redis});
  for(const name of ['extractAndSaveMemories','extractAndSaveGroupMemories']) {
    const original=manager[name].bind(manager);
    manager[name]=(...args)=>{
      const startedAt=Date.now();
      const work=Promise.resolve().then(()=>original(...args)).then(result=>{
        captures.memoryWrites.push({method:name,result:JSON.parse(scrub(JSON.stringify(result??null))),elapsedMs:Date.now()-startedAt});
        return result;
      });
      pending.add(work);
      work.then(()=>pending.delete(work),()=>pending.delete(work));
      return work;
    };
  }
  const recall=manager.getContextualMemoryPrompt.bind(manager);
  manager.getContextualMemoryPrompt=async (...args)=>{
    const prompt=await recall(...args);
    captures.memoryRecalls.push({query:String(args[2]||''),viewer:scope(args[4]?.viewer),at:args[3],prompt:scrub(prompt)});
    return prompt;
  };
  return {manager,
    async drain(){
      for(let pass=0;pass<20;pass++) {
        const jobs=[...pending,...manager.scopeQueues.values()];
        if(!jobs.length) return;
        const results=await Promise.allSettled(jobs);
        for(const result of results) if(result.status==='rejected') captures.errors.push({message:scrub(String(result.reason))});
      }
      throw new Error('isolated memory operations did not settle');
    },
    async snapshot(groupId){
      const [entities,facts,meta]=await Promise.all([manager.store.getEntities(groupId),manager.store.getFacts(groupId),manager.store.getMeta(groupId)]);
      const pendingExtractions=[...manager.userBuffers.values(),...manager.groupBuffers?.values()||[]].map(batch=>({attempts:batch.attempts,retryAt:batch.retryAt,retryExhausted:batch.retryExhausted,running:batch.running,messages:batch.messages?.map(message=>({content:message.content,at:message.at})),personaSource:scope(batch.personaSource)}));
      return JSON.parse(scrub(JSON.stringify({entities,facts,meta,pendingExtractions})));
    },
    dispose(){for(const buffers of [manager.userBuffers,manager.groupBuffers])for(const batch of buffers?.values()||[])if(batch.timer)clearTimeout(batch.timer);}
  };
}
