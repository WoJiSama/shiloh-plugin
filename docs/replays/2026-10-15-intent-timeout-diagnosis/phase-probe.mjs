import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

const root='/opt/trss-yunzai/plugins/shiloh-plugin';
const base='/tmp/bl-intent-timeout-investigation-20261015';
const old='/tmp/bl-latest-forward-fix-20261015';
const require=createRequire(path.join(root,'package.json'));
const YAML=require('yaml');
const load=p=>import(pathToFileURL(path.join(root,p)).href);
const [{mergeDeepConfig},{decodeHostConfig},{resolveChatCompletionUrl}]=await Promise.all([
  load('dist/backend/modules/config/infrastructure/configStore.js'),
  load('dist/backend/modules/host/infrastructure/hostConfig.js'),
  load('dist/backend/modules/models/domain/chatCompletionUrl.js')
]);
const read=p=>{const d=YAML.parse(fs.readFileSync(p,'utf8'));return d.pluginSettings||d;};
const defaults=read(path.join(root,'config_default/message.yaml'));
const config=p=>decodeHostConfig(mergeDeepConfig(defaults,read(p)));
const live=config(path.join(root,'config/message.yaml'));
const frozen=config(path.join(old,'config-snapshot/config/message.yaml'));
const route=c=>({url:resolveChatCompletionUrl(c.intentAiConfig?.intentAiUrl||c.toolsAiConfig?.toolsAiUrl),key:c.intentAiConfig?.intentAiApikey||c.toolsAiConfig?.toolsAiApikey,model:c.intentAiConfig?.intentAiModel||c.toolsAiConfig?.toolsAiModel});
const lr=route(live),fr=route(frozen);
const pid=execFileSync('systemctl',['show','trss-yunzai','--property=MainPID','--value'],{encoding:'utf8'}).trim();
const liveEnv=Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`,'utf8').split('\0').filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));
const variables=['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NODE_USE_ENV_PROXY','NODE_OPTIONS','NODE_EXTRA_CA_CERTS'];
const meta={checkedAt:new Date().toISOString(),node:process.version,route:{model:lr.model,liveEqualsFrozen:{url:lr.url===fr.url,key:lr.key===fr.key,model:lr.model===fr.model},protocol:new URL(lr.url).protocol,path:new URL(lr.url).pathname,source:live.intentAiConfig?.intentAiUrl?'intentAiConfig':'toolsAiConfig'},environment: Object.fromEntries(variables.map(k=>[k,{standalonePresent:!!process.env[k],servicePresent:!!liveEnv[k],equal:(process.env[k]||'')===(liveEnv[k]||'')}]))};
const output={metadata:meta,results:[]};
const outfile=path.join(base,'phase-probe-results.json');
if(fs.existsSync(outfile))throw new Error('Refusing to overwrite probe results');
const save=()=>fs.writeFileSync(outfile,JSON.stringify(output,null,2)+'\n',{mode:0o600});
save();console.log(JSON.stringify({metadata:meta}));
async function probe(label,extra={}){
 const t=performance.now();const ac=new AbortController();const timer=setTimeout(()=>ac.abort(),20000);
 const row={label,model:lr.model,budgetMs:20000,headersMs:null,firstBodyMs:null,bodyCompleteMs:null,status:null,bytes:0};
 try{
  const response=await fetch(lr.url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${lr.key}`},body:JSON.stringify({model:lr.model,stream:false,temperature:0,messages:[{role:'user',content:'Reply only OK.'}],...extra}),signal:ac.signal});
  row.headersMs=Math.round(performance.now()-t);row.status=response.status;row.contentType=response.headers.get('content-type');
  const chunks=[];if(response.body){const reader=response.body.getReader();while(true){const {done,value}=await reader.read();if(done)break;if(row.firstBodyMs===null)row.firstBodyMs=Math.round(performance.now()-t);row.bytes+=value.byteLength;chunks.push(value);}}
  row.bodyCompleteMs=Math.round(performance.now()-t);
  const text=Buffer.concat(chunks).toString('utf8');
  try{const data=JSON.parse(text);row.jsonParsed=true;row.responseModel=data.model||null;row.contentPresent=typeof data.choices?.[0]?.message?.content==='string';row.contentIsOK=data.choices?.[0]?.message?.content?.trim()==='OK';row.reasoningPresent=!!data.choices?.[0]?.message?.reasoning_content;row.finishReason=data.choices?.[0]?.finish_reason||null;if(data.error)row.apiErrorType=String(data.error.type||data.error.code||'error').slice(0,80);}catch{row.jsonParsed=false;}
 }catch(e){row.error={name:e.name,code:e.code||e.cause?.code||null,timeout:ac.signal.aborted};}
 finally{clearTimeout(timer);row.elapsedMs=Math.round(performance.now()-t);output.results.push(row);save();console.log(JSON.stringify(row));}
}
await probe('minimal-default');
await probe('minimal-thinking-disabled',{thinking:{type:'disabled'}});
