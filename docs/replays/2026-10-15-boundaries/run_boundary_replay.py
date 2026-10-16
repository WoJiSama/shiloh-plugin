import concurrent.futures,subprocess,json,time,os,sys
from pathlib import Path
os.umask(0o077)
base=Path('/tmp/bl-latest-forward-fix-20261015');runtime=Path(sys.argv[1]);label=sys.argv[2]
assert label.replace('-','').replace('_','').isalnum()
scenarios=json.loads((base/'eval/conversation-boundary-scenarios.json').read_text());output=base/label;output.mkdir(exist_ok=False)
manifest={'label':label,'repetitions':5,'concurrency':3,'scenarioOrder':[s['id'] for s in scenarios],'sampling':'one fixed run per scenario, fresh conversation for each of five repetitions; no resampling or dropped failures','runs':{},'complete':False}
def save():
 tmp=output/'scheduler.json.tmp';tmp.write_text(json.dumps(manifest,ensure_ascii=False,indent=2));tmp.replace(output/'scheduler.json')
def run(s):
 name=s['id'];start=time.time()
 cmd=['node',str(base/'eval/conversationQualityReplay.mjs'),'--plugin-root',str(runtime),'--config-root',str(base/'config-snapshot'),'--scenarios',str(base/'eval/conversation-boundary-scenarios.json'),'--scenario',name,'--repetitions','5','--label',label,'--output-dir',str(output/name)]
 with (output/(name+'.log')).open('w') as log:r=subprocess.run(cmd,cwd='/opt/trss-yunzai',stdout=log,stderr=subprocess.STDOUT)
 return name,{'exitCode':r.returncode,'elapsedSeconds':round(time.time()-start,3)}
save()
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
 for t in concurrent.futures.as_completed([pool.submit(run,s) for s in scenarios]):
  name,r=t.result();manifest['runs'][name]=r;save();print(json.dumps({'finished':name,**r}),flush=True)
parts=[json.loads((output/s['id']/'results.json').read_text()) for s in scenarios]
keys=['runnerHash','scenariosHash','configHash','effectiveConfigHash','personaHash','personaLibraryHash','runtimeTreeHash','runtimeFileCount']
for x in parts[1:]:
 for k in keys:assert x['metadata'][k]==parts[0]['metadata'][k],k
results=[r for x in parts for r in x['results']];expected=sum(1+len(s.get('followups',[])) for s in scenarios)*5
assert len(results)==expected and len({(r['id'],r['sampleIndex'],r['turnIndex']) for r in results})==expected
assert all(x['complete'] and x['platformMessagesSent']==x['productionStoreWrites']==0 for x in parts)
doc={k:v for k,v in parts[0].items() if k not in ['results','metadata','complete']};doc.update({'metadata':{**{k:v for k,v in parts[0]['metadata'].items() if k!='selectedScenarioHashes'},'selectedScenarioHashes':{k:v for x in parts for k,v in x['metadata']['selectedScenarioHashes'].items()},'schedulerConcurrency':3,'scenarioProcesses':len(parts),'aggregation':'fixture order, all five samples and errors preserved'},'complete':True,'results':results})
(output/'combined-results.json').write_text(json.dumps(doc,ensure_ascii=False,indent=2));manifest['complete']=True;save();print(json.dumps({'complete':True,'turns':expected}),flush=True)
