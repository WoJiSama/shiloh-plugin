import gzip,hashlib,json,shutil
from pathlib import Path
base=Path(__file__).parent
root=Path('/Users/shiqi/.codex/worktrees/task-grounding-20261015/bl-chat-plugin')
out=root/'docs/replays/2026-10-15-memory-social'
out.mkdir(parents=True,exist_ok=True)
private=json.loads((base/'evidence-scrub-map-private.json').read_text())
replacements={value:f'[CONFIG_QQ_{i+1}]' for i,value in enumerate(private['ids'])}
replacements.update({value:f'[CONFIG_ALIAS_{i+1}]' for i,value in enumerate(private['aliases'])})
records=[]
def export(source,name,compressed=False):
 raw=source.read_bytes()
 text=raw.decode()
 for old,new in sorted(replacements.items(),key=lambda item:-len(item[0])):text=text.replace(old,new)
 sanitized=text.encode()
 payload=gzip.compress(sanitized,mtime=0) if compressed else sanitized
 target=out/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(payload)
 records.append({'path':name,'rawSha256':hashlib.sha256(raw).hexdigest(),'exportSha256':hashlib.sha256(payload).hexdigest(),'configurationIdentifiersReplaced':sanitized!=raw,'compression':'gzip' if compressed else None})
files={
 'export_evidence.py':'export_evidence.py',
 'reveal_blind.py':'reveal_blind.py',
 'safe_writeback.py':'safe_writeback.py',
 'preservation-final.json':'preservation-final.json',
 'validation-summary.json':'validation-summary.json',
 'baseline-combined-results.json':'baseline.json',
 'candidate-0068ba2-combined-results.json':'intermediate-0068ba2.json',
 'candidate-ecc72ab-combined-results.json':'candidate.json',
 'baseline-6668bd3-scheduler.json':'baseline-scheduler.json',
 'candidate-0068ba2-scheduler.json':'intermediate-scheduler.json',
 'candidate-ecc72ab-scheduler.json':'candidate-scheduler.json',
 'final-comparison-integrity.json':'comparison-integrity.json',
 'final-statistics.json':'statistics.json',
 'feature-flags.json':'feature-flags.json',
 'test-repair-runtime-equivalence.json':'test-repair-runtime-equivalence.json',
 'audit-method-notes.json':'audit-method-notes.json',
 'audit_runtime.py':'audit_runtime.py',
 'pre-final-deploy-audit.json':'pre-final-deploy-audit.json',
 'post-final-deploy-audit.json':'post-deploy-audit.json',
 'final-writeback-preflight.json':'writeback-preflight.json',
 'final-writeback-audit.json':'writeback-audit.json',
 'original-writeback-validation.json':'writeback-validation.json',
 'commit-scope-audit.json':'commit-scope-audit.json',
 'prepare_blind.py':'prepare_blind.py',
 'analyze_replay.py':'analyze_replay.py',
 'blind-conversations.json':'blind-conversations.json',
 'blind-review.json':'blind-review.json',
 'blind-review-notes.md':'blind-review-notes.md',
 'blind-mapping-private.json':'blind-mapping-revealed.json',
 'blind-revealed-summary.json':'blind-revealed-summary.json',
 'technical-review.json':'technical-review.json',
 'technical-review.md':'technical-review.md',
}
for source,name in files.items():
 path=base/source
 if path.exists():export(path,name)
for name in ['final-verify-phase.log','final-deploy-phase-tests.log','final-deployment.log','followup-targeted.log','followup-typecheck.log','followup-build.log','gate-followup-targeted.log','original-writeback-targeted.log']:
 path=base/name
 if path.exists():export(path,name+'.gz',True)
for path in sorted((base/'frozen-eval').iterdir()):
 if path.is_file():export(path,'frozen-eval/'+path.name)
for path in out.rglob('*'):
 if path.is_file():
  text=(gzip.decompress(path.read_bytes()) if path.name.endswith('.gz') else path.read_bytes()).decode()
  assert not any(value in text for value in replacements),path
index={'schema':1,'privacy':{'rawConfigurationExported':False,'rawGroupRecordsExported':False,'configurationIdCount':len(private['ids']),'configurationAliasCount':len(private['aliases']),'transformation':'Exact deterministic replacement of configuration entity identifiers and aliases; synthetic scenario content and API outcomes preserved; raw originals remain restricted outside repository.'},'records':records}
(out/'evidence-index.json').write_text(json.dumps(index,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'files':len(records)+1,'bytes':sum(p.stat().st_size for p in out.rglob('*') if p.is_file()),'configurationFieldsReplaced':len(replacements)}))
