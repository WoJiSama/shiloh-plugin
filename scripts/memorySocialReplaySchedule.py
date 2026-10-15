"""Run both arms with identical ordering, repetition count and concurrency.
Only sanitized runner outputs are aggregated; config stays in its snapshot dir.
"""
import concurrent.futures
import json
import os
import subprocess
import sys
import time
from pathlib import Path

os.umask(0o077)
base, runtime, label = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
assert label.replace('-', '').replace('_', '').isalnum()
evaluation = base / 'eval'
scenarios = json.loads((evaluation / 'memorySocialReplayScenarios.json').read_text())
output = base / label
output.mkdir(exist_ok=False)
manifest = {'label': label, 'repetitions': 3, 'concurrency': 3,
            'scenarioOrder': [s['id'] for s in scenarios],
            'sampling': 'three independent conversations per scenario; no resampling or discarded failures',
            'runs': {}, 'complete': False}

def save():
    temporary = output / 'scheduler.json.tmp'
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    temporary.replace(output / 'scheduler.json')

def run(scenario):
    name = scenario['id']
    started = time.time()
    command = ['node', str(evaluation / 'conversationQualityReplay.mjs'),
               '--memory-integration', '--plugin-root', str(runtime),
               '--config-root', str(base / 'config-snapshot'),
               '--scenarios', str(evaluation / 'memorySocialReplayScenarios.json'),
               '--scenario', name, '--repetitions', '3', '--label', label,
               '--output-dir', str(output / name)]
    with (output / (name + '.log')).open('w') as log:
        result = subprocess.run(command, cwd='/opt/trss-yunzai', stdout=log, stderr=subprocess.STDOUT)
    return name, {'exitCode': result.returncode, 'elapsedSeconds': round(time.time() - started, 3)}

save()
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    for future in concurrent.futures.as_completed([pool.submit(run, scenario) for scenario in scenarios]):
        name, result = future.result()
        manifest['runs'][name] = result
        save()
        print(json.dumps({'finished': name, **result}), flush=True)

parts = [json.loads((output / s['id'] / 'results.json').read_text()) for s in scenarios]
keys = ['runnerHash', 'memoryHelperHash', 'scenariosHash', 'configHash', 'effectiveConfigHash',
        'personaHash', 'personaLibraryHash', 'runtimeTreeHash', 'runtimeFileCount']
for part in parts[1:]:
    for key in keys:
        assert part['metadata'][key] == parts[0]['metadata'][key], key
results = [r for part in parts for r in part['results']]
expected = sum(1 + len(s.get('followups', [])) for s in scenarios) * 3
assert len(results) == len({(r['id'], r['sampleIndex'], r['turnIndex']) for r in results}) == expected
assert all(part['complete'] and part['platformMessagesSent'] == part['productionStoreWrites'] == 0 for part in parts)
document = {key: value for key, value in parts[0].items() if key not in ['results', 'metadata', 'complete']}
document.update({'metadata': {**{k: v for k, v in parts[0]['metadata'].items() if k != 'selectedScenarioHashes'},
                'selectedScenarioHashes': {key: value for p in parts for key, value in p['metadata']['selectedScenarioHashes'].items()},
                'schedulerConcurrency': 3, 'scenarioProcesses': len(parts)},
                'complete': True, 'results': results})
(output / 'combined-results.json').write_text(json.dumps(document, ensure_ascii=False, indent=2))
manifest['complete'] = True
save()
print(json.dumps({'complete': True, 'turns': expected}), flush=True)
