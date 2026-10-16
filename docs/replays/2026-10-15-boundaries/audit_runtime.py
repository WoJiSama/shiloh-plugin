import sys, json, hashlib, subprocess, re, urllib.request
from pathlib import Path
from datetime import datetime, timezone

base = Path('/tmp/bl-latest-forward-fix-20261015')
runtime = Path(sys.argv[1])
output = Path(sys.argv[2])
expected_runtime = Path(sys.argv[3]) if len(sys.argv) > 3 else None
replay_file = Path(sys.argv[4]) if len(sys.argv) > 4 else None
if output.exists():
    raise RuntimeError('Do not overwrite an earlier audit')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest = json.loads((runtime / 'release-manifest.json').read_text())
mismatches = [name for name, digest in manifest['files'].items()
              if not (runtime / name).is_file() or sha(runtime / name) != digest]
js_files = {str(p.relative_to(runtime / 'dist/backend')): sha(p)
            for p in sorted((runtime / 'dist/backend').rglob('*.js'))}
tree_hash = hashlib.sha256(json.dumps(js_files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
result = {'checkedAtUtc': datetime.now(timezone.utc).isoformat(),
          'commit': manifest['commit'], 'managedFiles': len(manifest['files']),
          'mismatches': mismatches, 'runtimeTreeHash': tree_hash,
          'runtimeFileCount': len(js_files), 'configs': {}}
for name in ['message.yaml', 'persona-library.yaml']:
    frozen = base / 'config-snapshot/config' / name
    current = runtime / 'config' / name
    result['configs'][name] = {'sha256': sha(current), 'matchesFrozenSnapshot': sha(current) == sha(frozen)}
if expected_runtime:
    other = json.loads((expected_runtime / 'release-manifest.json').read_text())
    result['expectedCommit'] = other['commit']
    result['expectedManifestMatches'] = other == manifest
    result['expectedManagedFilePayloadMatches'] = other['files'] == manifest['files']
    payload_differences = [name for name in sorted(set(other['files']) | set(manifest['files']))
                           if other['files'].get(name) != manifest['files'].get(name)]
    result['expectedManagedPayloadDifferences'] = payload_differences
    result['nonGeneratedPayloadMismatches'] = [name for name in payload_differences
        if name != 'dist/backend/manifest.json' and not name.startswith('console/frontend/dist/')]
    expected_backend_manifest = json.loads((expected_runtime / 'dist/backend/manifest.json').read_text())
    live_backend_manifest = json.loads((runtime / 'dist/backend/manifest.json').read_text())
    result['backendManifestOutputMatchesCandidate'] = expected_backend_manifest['files'] == live_backend_manifest['files']
    result['backendManifestSourceMatchesCandidate'] = expected_backend_manifest['sources'] == live_backend_manifest['sources']
    result['backendManifestChangedKeys'] = [key for key in expected_backend_manifest
        if expected_backend_manifest.get(key) != live_backend_manifest.get(key)]
    expected_js = {str(p.relative_to(expected_runtime / 'dist/backend')): sha(p)
                   for p in sorted((expected_runtime / 'dist/backend').rglob('*.js'))}
    result['expectedRuntimeJsMatches'] = expected_js == js_files
if replay_file:
    replay = json.loads(replay_file.read_text())
    result['replayRuntimeMatches'] = replay['metadata']['runtimeTreeHash'] == tree_hash
    result['replayRunnerMatches'] = replay['metadata']['runnerHash'] == sha(runtime / 'scripts/conversationQualityReplay.mjs')
result['services'] = {}
for service in ['trss-yunzai', 'bl-console']:
    raw = subprocess.check_output(['systemctl', 'show', service, '-p', 'MainPID', '-p', 'NRestarts', '-p', 'ActiveState', '-p', 'ActiveEnterTimestamp'], text=True)
    result['services'][service] = dict(row.split('=', 1) for row in raw.splitlines())
since = result['services']['trss-yunzai']['ActiveEnterTimestamp']
journal = subprocess.check_output(['journalctl', '-u', 'trss-yunzai', '--since', since, '--no-pager'], text=True)
result['loadErrorsSinceCurrentStart'] = sum(bool(re.search(r'载入插件错误|ReferenceError|SyntaxError|is not defined|unhandled', row)) for row in journal.splitlines())
result['pipelineStartsSinceCurrentStart'] = sum(bool(re.search(r'MessagePipeline.*已启动', row)) for row in journal.splitlines())
result['http'] = {}
for name, url in [('commands', 'http://127.0.0.1:2536/bl-chat/commands'), ('console', 'http://127.0.0.1:8787/')]:
    with urllib.request.urlopen(url, timeout=5) as response:
        result['http'][name] = response.status
result['platformTestMessagesSent'] = 0
result['productionMemoryTestWrites'] = 0
output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
assert not mismatches
assert all(x['matchesFrozenSnapshot'] for x in result['configs'].values())
if expected_runtime:
    assert not result['nonGeneratedPayloadMismatches'] and result['expectedRuntimeJsMatches']
    assert result['backendManifestOutputMatchesCandidate'] and result['backendManifestSourceMatchesCandidate']
    assert set(result['backendManifestChangedKeys']) <= {'commit'}
if replay_file:
    assert result['replayRuntimeMatches'] and result['replayRunnerMatches']
assert all(x['ActiveState'] == 'active' for x in result['services'].values())
assert result['loadErrorsSinceCurrentStart'] == 0 and result['pipelineStartsSinceCurrentStart'] >= 1
assert set(result['http'].values()) == {200}
