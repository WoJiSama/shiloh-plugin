import hashlib, json, shutil, subprocess, sys
from pathlib import Path
from datetime import datetime,timezone
work=Path('/Users/shiqi/.codex/worktrees/task-grounding-20261015/bl-chat-plugin')
original=Path('/Users/shiqi/IdeaProjects/bl-chat-plugin')
start=Path('/var/folders/b4/nnqfwk655mxft_1v4mq3mt740000gn/T/bl-memory-social-start-20261015-hztsaa_p')
evidence=Path(__file__).parent
sha=lambda p: hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
git=lambda *args: subprocess.check_output(['git',*args],cwd=original)
head=git('rev-parse','HEAD').decode().strip()
expected_head=(start/'head.txt').read_text().strip()
index=git('diff','--cached','--binary')
manifest=json.loads((start/'manifest.json').read_text())
planning={'task_plan.md','progress.md','findings.md'}
targets=set(subprocess.check_output(['git','diff','--name-only','6668bd3..HEAD'],cwd=work).decode().splitlines())-planning
# Evidence/report files are added after deployment and copied only when explicitly requested.
if '--include-docs' in sys.argv:
 targets.add('docs/ai-memory-social-2026-10-15.md')
 targets.update(str(p.relative_to(work)) for p in (work/'docs/replays/2026-10-15-memory-social').rglob('*') if p.is_file())
assert not any(Path(name).is_absolute() or '..' in Path(name).parts or name.split('/')[0] in {'config','data','database','logs','backups','.git'} for name in targets)
conflicts=[];changed=[];already=[];new=[]
for name in sorted(targets):
 source=work/name; destination=original/name
 assert source.is_file() and not source.is_symlink(),name
 if destination.exists():
  assert destination.is_file() and not destination.is_symlink(),name
  current=sha(destination)
  if current==sha(source):already.append(name);continue
  prior=manifest.get(name)
  if prior is None:
   read=subprocess.run(['git','show',head+':'+name],cwd=original,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
   prior=hashlib.sha256(read.stdout).hexdigest() if read.returncode==0 else None
  if current!=prior:conflicts.append(name)
  else:changed.append(name)
 else:
  if name in manifest:conflicts.append(name)
  else:new.append(name)
protected={name:value for name,value in manifest.items() if name not in targets|planning}
protected_changed=[name for name,value in protected.items() if sha(original/name)!=value]
result={'checkedAtUtc':datetime.now(timezone.utc).isoformat(),'originalHead':head,'headUnchanged':head==expected_head,'indexUnchanged':index==(start/'index.diff').read_bytes(),'targetCount':len(targets),'conflicts':conflicts,'alreadyMatches':already,'newFiles':new,'changedTargets':changed,'protectedDirtyCount':len(protected),'protectedDirtyChanged':protected_changed,'planningHandledByAppend':True,'applied':False}
assert result['headUnchanged'] and result['indexUnchanged'] and not conflicts and not protected_changed, result
if '--apply' in sys.argv:
 backup=evidence/'writeback-original-targets'
 backup.mkdir(exist_ok=False)
 for name in changed:
  saved=backup/name;saved.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(original/name,saved)
 for name in changed+new:
  destination=original/name;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(work/name,destination)
 result['applied']=True
 result['targetMismatchesAfter']=[name for name in targets if sha(original/name)!=sha(work/name)]
 result['protectedDirtyChangedAfter']=[name for name,value in protected.items() if sha(original/name)!=value]
 result['headUnchangedAfter']=git('rev-parse','HEAD').decode().strip()==head
 result['indexUnchangedAfter']=git('diff','--cached','--binary')==index
 result['sourceTsMismatchesAfter']=[str(p.relative_to(work)) for p in (work/'src').rglob('*.ts') if sha(original/p.relative_to(work))!=sha(p)]
 assert not result['targetMismatchesAfter'] and not result['protectedDirtyChangedAfter'] and not result['sourceTsMismatchesAfter']
 assert result['headUnchangedAfter'] and result['indexUnchangedAfter']
output=evidence/('final-writeback-audit.json' if result['applied'] else 'final-writeback-preflight.json')
assert not output.exists(),output
output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if not isinstance(v,list) or k.endswith('After') or k in {'conflicts','protectedDirtyChanged'}},ensure_ascii=False))
