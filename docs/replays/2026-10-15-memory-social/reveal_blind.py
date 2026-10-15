import collections,json,hashlib
from pathlib import Path
base=Path(__file__).parent
review=json.loads((base/'blind-review.json').read_text())
inputs=json.loads((base/'blind-conversations.json').read_text())
mapping=json.loads((base/'blind-mapping-private.json').read_text())
by_key={(r['blindId'],r['anonymousArm']):r for r in mapping}
cases={r['blindId']:r for r in inputs['conversations']}
summary={'reviewSha256':hashlib.sha256((base/'blind-review.json').read_bytes()).hexdigest(),'completePairedConversations':len(review['conversations']),'wins':{},'perScenario':{},'dimensions':{},'hardErrors':[],'observations':[],'limitations':['One independent model evaluator, uncalibrated ordinal scores, 24 paired scripted conversations; not human or population preference statistics','Default private persona exact wording withheld','Different execution/scenario clocks limit relative-date conclusions','Technical results were hidden throughout blind scoring']}
wins=collections.Counter();scenarios=collections.defaultdict(collections.Counter);scores=collections.defaultdict(lambda:collections.defaultdict(list))
assert len(review['conversations'])==len(cases)==24
for r in review['conversations']:
 bid=r['blindId'];case=cases[bid]
 pref=r['preference'];winner='tie' if pref=='tie' else by_key[(bid,pref)]['realLabel']
 wins[winner]+=1;scenarios[case['scenario']][winner]+=1
 for arm,result in r['arms'].items():
  info=by_key[(bid,arm)];label=info['realLabel']
  outputs={v['turn']:v['output'] for v in case['arms'][arm]}
  for dimension,value in result['scores'].items():
   score=value['score'];assert score in [0,1,2,None]
   scores[label][dimension].append(score)
   for evidence in value['evidence']:assert evidence['quote'] in outputs[evidence['turn']],(bid,arm,dimension,evidence)
  for error in result.get('hardErrors',[]):summary['hardErrors'].append({'scenario':case['scenario'],'sample':case['sample'],'label':label,**error})
  for observation in result.get('observations',[]):summary['observations'].append({'scenario':case['scenario'],'sample':case['sample'],'label':label,**observation})
summary['wins']=dict(wins)
summary['perScenario']={k:dict(v) for k,v in scenarios.items()}
summary['dimensions']={label:{dimension:{'counts':dict(collections.Counter(str(v) for v in values)),'meanOrdinalScore':round(sum(v for v in values if v is not None)/sum(v is not None for v in values),4)} for dimension,values in dimensions.items()} for label,dimensions in scores.items()}
summary['hardErrorCounts']=dict(collections.Counter(r['label'] for r in summary['hardErrors']))
summary['overallAnonymousReview']=review['overall']
(base/'blind-revealed-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in summary.items() if k not in ['observations','overallAnonymousReview']},ensure_ascii=False,indent=2))
