import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  parseReplayOptions,runReplaySamples,hashReplayValue,generationEvidence,
  createReplayScrubber,rebindReplayTaskFacts,validateReplayScenarios,writeReplayCheckpoint
} from '../scripts/conversationQualityReplay.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runner=path.join(root,'scripts/conversationQualityReplay.mjs');
const simpleScenario={id:'case-a',rawUserText:'第一轮',expectedKind:'conversation',followups:[{rawUserText:'第二轮',expectedKind:'conversation'}]};
const scratch=t=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bl-replay-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;};

test('importing the CLI does not parse argv, read config, create output, or start a replay',t=>{
  const cwd=scratch(t);
  const forbidden=path.join(cwd,'must-not-exist');
  const code=`process.argv.push('--repetitions','0'); const module=await import(${JSON.stringify(new URL('../scripts/conversationQualityReplay.mjs',import.meta.url).href)}); console.log(typeof module.main);`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd,encoding:'utf8',env:{...process.env,BL_SHADOW_PLUGIN_ROOT:forbidden,BL_SHADOW_CONFIG_ROOT:forbidden,BL_SHADOW_OUTPUT_DIR:forbidden}});
  assert.equal(child.status,0,child.stderr);
  assert.equal(child.stdout.trim(),'function');
  assert.equal(child.stderr,'');
  assert.equal(fs.existsSync(forbidden),false);
});

test('--help does not require a built runtime or touch configured private paths',t=>{
  const cwd=scratch(t);
  const missing=path.join(cwd,'missing-runtime');
  const child=spawnSync(process.execPath,[runner,'--help','--plugin-root',missing,'--config-root',missing,'--output-dir',missing],{cwd,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  assert.match(child.stdout,/--repetitions positive-integer/);
  assert.equal(fs.existsSync(missing),false);
});

test('compiled-path dry replay repeats independent multiline conversations without reading private config',t=>{
  const directory=scratch(t);
  const privateRoot=path.join(directory,'private');
  const outputDir=path.join(directory,'output');
  fs.mkdirSync(path.join(privateRoot,'config'),{recursive:true});
  fs.writeFileSync(path.join(privateRoot,'config/message.yaml'),'invalid: [private config must never be parsed');
  fs.writeFileSync(path.join(privateRoot,'config/persona-library.yaml'),'invalid: [private persona library must never be parsed');
  const code=`
    import fs from 'node:fs';
    const privateRoot=${JSON.stringify(privateRoot)};
    const originalRead=fs.readFileSync;
    fs.readFileSync=(file,...args)=>{if(String(file).startsWith(privateRoot))throw new Error('private config was read');return originalRead(file,...args);};
    const originalLog=console.log;console.log=()=>{};
    const {main}=await import(${JSON.stringify(new URL('../scripts/conversationQualityReplay.mjs',import.meta.url).href)});
    const replay=await main(['--dry-run','--plugin-root',${JSON.stringify(root)},'--config-root',privateRoot,'--scenarios',${JSON.stringify(path.join(root,'tests/fixtures/conversation-stability-scenarios.json'))},'--scenario','successive-praise','--repetitions','2','--output-dir',${JSON.stringify(outputDir)}],{});
    originalLog(JSON.stringify({exitCode:replay.exitCode,turns:replay.results.length,results:replay.results.map(r=>({sampleIndex:r.sampleIndex,turnIndex:r.turnIndex,failures:r.failures,output:r.output,checks:r.checks,network:r.network})),configHash:replay.metadata.configHash,personaLibraryHash:replay.metadata.personaLibraryHash}));
  `;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:directory,encoding:'utf8',timeout:30000});
  assert.equal(child.status,0,child.stderr);
  const replay=JSON.parse(child.stdout);
  assert.equal(replay.exitCode,0,child.stdout);
  assert.equal(replay.turns,6);
  assert.deepEqual(replay.results.map(r=>r.sampleIndex),[1,1,1,2,2,2]);
  for(const result of replay.results){
    assert.deepEqual(result.failures,[]);
    assert.deepEqual(result.network,[]);
    assert.match(result.output,/\n/);
    if(result.turnIndex>0)assert.equal(result.checks.ownActualHistory,true);
  }
  assert.equal(replay.configHash,null);
  assert.equal(replay.personaLibraryHash,null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outputDir,'dry-results.json'),'utf8')).complete,true);
});

test('repetitions default to one and accept only positive safe integer CLI values',()=>{
  assert.equal(parseReplayOptions([],{},'/tmp/replay-options').repetitions,1);
  assert.equal(parseReplayOptions(['--repetitions','5'],{},'/tmp/replay-options').repetitions,5);
  for(const value of ['0','-1','1.5','1e2','NaN',' 5','Infinity','9007199254740992'])assert.throws(()=>parseReplayOptions(['--repetitions',value]),/positive safe integer/);
  assert.throws(()=>parseReplayOptions(['--repetitions']),/requires a value/);
  assert.throws(()=>parseReplayOptions(['--repetitions','2','--repetitions','3']),/Duplicate/);
  assert.throws(()=>parseReplayOptions(['--unknown']),/Unknown/);
});

test('memory integration dry replay runs the real isolated memory path without private config or network',t=>{
  const directory=scratch(t),outputDir=path.join(directory,'output'),privateRoot=path.join(directory,'must-not-read');
  const code=`
    import fs from 'node:fs';
    const originalRead=fs.readFileSync;
    fs.readFileSync=(file,...args)=>{if(String(file).startsWith(${JSON.stringify(privateRoot)}))throw new Error('private config was read');return originalRead(file,...args);};
    globalThis.fetch=()=>{throw new Error('network must stay disabled');};
    const originalLog=console.log;console.log=()=>{};
    const {main}=await import(${JSON.stringify(new URL('../scripts/conversationQualityReplay.mjs',import.meta.url).href)});
    const replay=await main(['--dry-run','--memory-integration','--plugin-root',${JSON.stringify(root)},'--config-root',${JSON.stringify(privateRoot)},'--scenarios',${JSON.stringify(path.join(root,'tests/fixtures/memorySocialReplayScenarios.json'))},'--scenario','dated-memory-next-turn','--output-dir',${JSON.stringify(outputDir)}],{});
    originalLog(JSON.stringify({metadata:replay.metadata,results:replay.results}));
  `;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:directory,encoding:'utf8',timeout:30000});
  assert.equal(child.status,0,child.stderr);
  const replay=JSON.parse(child.stdout);
  assert.equal(replay.metadata.memoryIntegration,true);
  assert.equal(replay.metadata.configHash,null);
  assert.equal(replay.results.length,2);
  for(const result of replay.results){
    assert.equal(result.checks.noRuntimeError,true,JSON.stringify(result.errors));
    assert.equal(result.checks.rawBody,true);
    assert.ok(result.memory.snapshot);
    assert.ok(result.memory.extractions.some(item=>item.method==='extractAndSaveMemories'));
    assert.ok(result.memory.network.every(item=>item.stub===true&&item.status===null));
    assert.deepEqual(result.network,[]);
  }
  assert.ok(replay.results[1].memory.recalls.some(item=>item.query==='我之前说的数学考试是哪天？'));
  const saved=JSON.parse(fs.readFileSync(path.join(outputDir,'dry-results.json'),'utf8'));
  assert.equal(saved.complete,true);
  assert.equal(saved.platformMessagesSent,0);
  assert.equal(saved.productionStoreWrites,0);
  assert.equal(fs.existsSync(privateRoot),false);
});

test('each repeated sample owns fresh state and only its own previous output',async()=>{
  const fixtures=[];
  const scenarios=[structuredClone(simpleScenario),{id:'case-b',rawUserText:'独立场景',expectedKind:'conversation'}];
  const before=structuredClone(scenarios);
  const results=await runReplaySamples({
    scenarios,repetitions:3,
    createFixture:scenario=>{scenario.localMutation='fixture only';const f={history:[],store:new Map(),session:{},seeded:0,seedContinuity(){this.seeded++;}};fixtures.push(f);return f;},
    executeTurn:({fixture,turn,turnIndex,previousResult,sampleIndex,scenario})=>{
      assert.equal(fixture.seeded,1);
      assert.equal(fixture.history.length,turnIndex);
      assert.equal(previousResult?.sampleIndex,turnIndex?sampleIndex:undefined);
      assert.equal(previousResult?.id,turnIndex?scenario.id:undefined);
      fixture.history.push(turn.rawUserText);
      fixture.store.set('count',fixture.history.length);
      return {output:`${scenario.id}/${sampleIndex}/${fixture.history.length}`,failures:[]};
    }
  });
  assert.equal(results.length,9);
  assert.equal(fixtures.length,6);
  assert.equal(new Set(fixtures.map(f=>f.history)).size,6);
  assert.equal(new Set(fixtures.map(f=>f.store)).size,6);
  assert.deepEqual(scenarios,before);
  assert.deepEqual(results.map(r=>r.sampleId),['case-a:sample-1','case-a:sample-1','case-a:sample-2','case-a:sample-2','case-a:sample-3','case-a:sample-3','case-b:sample-1','case-b:sample-2','case-b:sample-3']);
});

test('exceptions retain earlier and partial outputs, checkpoint every turn, and continue later samples',async t=>{
  const file=path.join(scratch(t),'results.json');
  const counts=[];
  const scrub=createReplayScrubber({apiKey:'private-test-api-key',systemContent:'private\nfixture prompt text'});
  const results=await runReplaySamples({
    scenarios:[simpleScenario],repetitions:2,scrub,
    createFixture:()=>({partialOutput:''}),
    executeTurn:({fixture,sampleIndex,turnIndex})=>{
      if(sampleIndex===1&&turnIndex===1){fixture.partialOutput='partially emitted result';throw new Error('private-test-api-key private\nfixture prompt text');}
      return {output:`success-${sampleIndex}-${turnIndex}`,failures:[]};
    },
    describeFailure:({fixture})=>({output:fixture.partialOutput,network:[{status:503}],failures:['incomplete_reply']}),
    onResult:(_result,allResults)=>{counts.push(allResults.length);writeReplayCheckpoint(file,{results:allResults});assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).results.length,allResults.length);}
  });
  assert.deepEqual(counts,[1,2,3,4]);
  assert.equal(results[0].output,'success-1-0');
  assert.equal(results[1].output,'partially emitted result');
  assert.deepEqual(results[1].failures,['incomplete_reply','exception']);
  assert.equal(results[1].error,'[REDACTED] [REDACTED]');
  assert.deepEqual(results[1].network,[{status:503}]);
  assert.equal(results[3].output,'success-2-1');
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).results.length,4);
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert.equal(fs.existsSync(`${file}.tmp`),false);
});

test('a session setup failure is recorded for every skipped turn without aborting later samples',async()=>{
  let fixtures=0;
  const results=await runReplaySamples({scenarios:[simpleScenario],repetitions:2,createFixture:()=>{if(++fixtures===1)throw new Error('fixture failed');return {};},executeTurn:()=>({output:'later sample',failures:[]})});
  assert.deepEqual(results.map(r=>r.failures),[['session_setup_failed'],['session_setup_failed'],[],[]]);
  assert.equal(results[2].sampleIndex,2);
});

test('checkpoint persistence failure aborts rather than claiming the run completed',async()=>{
  let calls=0;
  await assert.rejects(runReplaySamples({scenarios:[simpleScenario],createFixture:()=>({}),executeTurn:()=>{calls++;return {output:'captured',failures:[]};},onResult:()=>{throw new Error('disk unavailable');}}),/disk unavailable/);
  assert.equal(calls,1);
});

test('generation evidence is deterministic and excludes prompts, credentials, URLs, and tool bodies',()=>{
  const payload={model:'fixture-model',temperature:0.5,top_p:0.9,reasoning_effort:'high',max_tokens:800,messages:[{role:'system',content:'private prompt'}],apiKey:'secret-value',url:'https://private.invalid',tools:[{name:'private-tool'}]};
  const evidence=generationEvidence(payload);
  assert.deepEqual(evidence.parameters,{model:'fixture-model',temperature:0.5,top_p:0.9,max_tokens:800,reasoning_effort:'high'});
  assert.equal(evidence.hash,hashReplayValue({max_tokens:800,model:'fixture-model',reasoning_effort:'high',top_p:0.9,temperature:0.5}));
  assert.doesNotMatch(JSON.stringify(evidence),/private|secret|messages|tools|url/);
  assert.notEqual(evidence.hash,generationEvidence({...payload,temperature:0.6}).hash);
});

test('scrubbing removes both raw and JSON-escaped private prompt and credential values',()=>{
  const config={systemContent:'A private prompt\nwith a second line',model:{apiKey:'test-secret-token'},extra:{token:'other-long-token'}};
  const scrub=createReplayScrubber(config);
  const serialized=JSON.stringify({body:config.systemContent,key:config.model.apiKey});
  assert.doesNotMatch(scrub(serialized),/private prompt|test-secret-token/);
  assert.equal(scrub('Bearer abc.DEF_123-456'),'Bearer [REDACTED]');
});

test('synthetic task facts are rebound to the current sample and matched to the requested task',()=>{
  const declared={scope:{botId:'production-bot',conversationId:'production-group',userId:'production-user'},observedAt:1,lookup:'ok',tasks:[
    {taskId:'task-a',requestMessageId:'request-a',observedAt:1,execution:'completed',delivery:{state:'sent',messageId:'receipt-a'},followUp:{state:'none'}},
    {taskId:'task-b',requestMessageId:'request-b',observedAt:1,execution:'running',delivery:{state:'not_attempted'},followUp:{state:'registered',id:'followup-b'}}
  ]};
  const event={self_id:99,group_id:900001,user_id:202};
  const byRequest=rebindReplayTaskFacts(declared,event,1234,{referenceMessageId:'request-a',recentRequestMessageIds:['request-b']});
  assert.deepEqual(byRequest.scope,{botId:'99',conversationId:'group:900001',userId:'202'});
  assert.equal(byRequest.observedAt,1234);
  assert.deepEqual(byRequest.tasks.map(task=>task.taskId),['task-a']);
  assert.equal(byRequest.tasks[0].observedAt,1234);
  assert.equal(rebindReplayTaskFacts(declared,event,1234,{referenceMessageId:'missing',recentRequestMessageIds:['request-b']}).tasks.length,0);
  assert.equal(rebindReplayTaskFacts(declared,event,1234,{referenceMessageId:'receipt-a'}).tasks[0].taskId,'task-a');
  assert.deepEqual(rebindReplayTaskFacts(declared.tasks,event,1234,{recentRequestMessageIds:['request-b']}).tasks.map(task=>task.taskId),['task-b']);
  byRequest.tasks[0].delivery.state='failed';
  assert.equal(declared.tasks[0].delivery.state,'sent');
  assert.equal(declared.observedAt,1);
});

test('twelve stability cases retain human semantic rubrics and continuous turns without keyword scores',()=>{
  const scenarios=validateReplayScenarios(JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/conversation-stability-scenarios.json'),'utf8')));
  assert.equal(scenarios.length,12);
  assert.ok(scenarios.filter(s=>(s.followups||[]).length).length>=10);
  for(const scenario of scenarios){
    assert.ok(scenario.semanticChecks.length>0,scenario.id);
    assert.ok(scenario.manualReview.length>0,scenario.id);
    for(const check of scenario.semanticChecks)assert.equal(check.evaluation,'semantic_judgment');
    assert.equal(scenario.anti,undefined);
    assert.equal(scenario.keywords,undefined);
  }
  assert.ok(scenarios.some(s=>s.taskFacts?.tasks?.some(task=>task.followUp.state==='registered')));
  assert.ok(scenarios.some(s=>s.followups?.some(turn=>turn.taskFacts?.tasks?.some(task=>task.followUp.state==='none'))));
  assert.ok(scenarios.some(s=>s.id==='real-burning-fault-no-visible-mark-then-inspection'));
  assert.ok(scenarios.some(s=>s.id==='fictional-meme-updated-duration-and-negative-fault'));
});
