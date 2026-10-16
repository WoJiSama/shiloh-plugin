import json,hashlib
from pathlib import Path
base=Path(__file__).parent
scenarios={s['id']:s for s in json.loads((base/'frozen-eval/memorySocialReplayScenarios.json').read_text())}
docs=[json.loads((base/name).read_text()) for name in ['baseline-combined-results.json','candidate-ecc72ab-combined-results.json']]
groups=[];mapping=[]
for sid,scenario in scenarios.items():
    for sample in range(1,4):
        key=hashlib.sha256(('fixed-blind-v1/'+sid+'/'+str(sample)).encode()).hexdigest()[:12]
        order=[0,1] if int(key[0],16)%2 else [1,0]
        arms={}
        for anonymous,arm in zip(['A','B'],order):
            rows=sorted([r for r in docs[arm]['results'] if r['id']==sid and r['sampleIndex']==sample],key=lambda r:r['turnIndex'])
            turns=[scenario,*scenario.get('followups',[])]
            currentPersona={'name':rows[0]['personaName'],'wordingRubric':'Default persona is identical across arms. Its private full prompt is withheld; assess consistency and speech ownership, not exact conformance to unpublished wording.'}
            outputs=[]
            for r,t in zip(rows,turns):
                if t.get('personaOverride'):currentPersona=t['personaOverride']
                outputs.append({'turn':r['turnIndex'],'input':r['input'],'output':r['output'],'botId':r['botId'],'persona':currentPersona,'scenarioAt':t.get('at'),'expectedBehavior':t.get('expect',scenario.get('expect'))})
            arms[anonymous]=outputs
            mapping.append({'blindId':key,'anonymousArm':anonymous,'realLabel':docs[arm]['label'],'scenario':sid,'sampleIndex':sample})
        groups.append({'blindId':key,'scenario':sid,'sample':sample,'context':{'quote':scenario.get('quote'),'onlyForwardNodesReadable':80 if scenario.get('forwardCount') else None,'totalForwardNodes':scenario.get('forwardCount'),'memoryOnlyFollowups':[i+1 for i,t in enumerate(scenario.get('followups',[])) if t.get('memoryOnly')]},'arms':arms})
blind={'reviewUnit':'complete conversation per scenario and sample; judge A and B independently before preference','scoreKeys':['continuity','persona_source','addressee','fact_conditions','naturalness'],'scoreRule':'0 substantive violation; 1 usable but weak; 2 correct and fitting; null only if not applicable. Cite turn and short quote. Report hard errors separately. Do not turn unknown into pass.','boundaries':['Only language output and synthetic context are provided; no technical labels, hashes, timing, or outcome tells.','Default persona prompt remains private; exact persona wording conformance is unscored there.','Explicit scenario timestamps cross midnight; runtime wall clock was not frozen. Flag relative-date conflicts separately and state that execution clocks differ. Absolute stored dates must be audited later against technical evidence.','Tools, Gate, addressee and platform stores were isolated/stubbed; do not infer production routing or delivery quality.','These are 24 scripted conversations per arm, not general population statistics.'],'conversations':groups}
(base/'blind-conversations.json').write_text(json.dumps(blind,ensure_ascii=False,indent=2))
(base/'blind-mapping-private.json').write_text(json.dumps(mapping,indent=2))
print('wrote',len(groups),'anonymous paired conversations')
