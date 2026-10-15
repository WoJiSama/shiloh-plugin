import json,collections,math,sys
from pathlib import Path

def summary(document):
    results=document['results']
    latency=lambda values: {'n':len(values),'p50':sorted(values)[max(0,math.ceil(len(values)*.5)-1)],'p95':sorted(values)[max(0,math.ceil(len(values)*.95)-1)],'max':max(values)} if values else {'n':0}
    checks={key:{'pass':sum(r['checks'].get(key) is True for r in results),'fail':sum(r['checks'].get(key) is False for r in results)} for key in sorted({key for r in results for key in r['checks']})}
    latest={}
    for r in results:latest[(r['id'],r['sampleIndex'])]=r
    counter=lambda rows,key: dict(collections.Counter(str(row.get(key)) for row in rows))
    memory=[n for r in results for n in (r.get('memory') or {}).get('network',[])]
    network=[n for r in results for n in r.get('network',[])]
    return {'turns':len(results),'conversations':len(latest),'allStructuralPassTurns':sum(not r['failures'] for r in results),'failureCounts':dict(collections.Counter(f for r in results for f in r['failures'])),'checks':checks,'generationNetworkStatus':counter(network,'status'),'generationModels':counter(network,'model'),'generationParameters':dict(collections.Counter(json.dumps(n.get('generation'),sort_keys=True) for n in network)),'memoryNetworkStatus':counter(memory,'status'),'memoryModels':counter(memory,'model'),'memoryExtractionResults':dict(collections.Counter(str((e.get('result') or {}).get('status','legacy_unclassified')) for r in results for e in (r.get('memory') or {}).get('extractions',[]))),'understandingStatus':counter([n for r in results for n in r.get('understanding',[])],'status'),'guardChangedTurns':sum(r.get('guardChanged',False) for r in results),'runtimeErrorTurns':sum(bool(r.get('errors')) for r in results),'pendingBatchesAtConversationEnd':sum(len((r.get('memory') or {}).get('snapshot',{}).get('pendingExtractions',[])) for r in latest.values()),'exhaustedBatchesAtConversationEnd':sum(bool(b.get('retryExhausted')) for r in latest.values() for b in (r.get('memory') or {}).get('snapshot',{}).get('pendingExtractions',[])),'replyElapsedMs':latency([r['replyElapsedMs'] for r in results if isinstance(r.get('replyElapsedMs'),(int,float))]),'memoryDrainElapsedMs':latency([r['memoryDrainElapsedMs'] for r in results if isinstance(r.get('memoryDrainElapsedMs'),(int,float))]),'platformMessagesSent':document['platformMessagesSent'],'productionStoreWrites':document['productionStoreWrites']}

if __name__=='__main__':
    documents=[json.loads(Path(p).read_text()) for p in sys.argv[1:]]
    print(json.dumps({document['label']:summary(document) for document in documents},ensure_ascii=False,indent=2))
