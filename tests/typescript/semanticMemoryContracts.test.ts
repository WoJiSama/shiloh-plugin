import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { BM25Index, SemanticMemoryStore } from '../../src/modules/memory/infrastructure/SemanticMemoryStore.js'
import { recordEpisode, recallEpisodes, resetEpisodicMemoryForTests } from '../../src/modules/memory/infrastructure/episodicMemory.js'
import { MidtermSummaryManager } from '../../src/modules/memory/infrastructure/MidtermSummaryManager.js'

test('BM25 removal decrements document frequency once despite repeated terms', () => {
 const index = new BM25Index()
 index.add('a', ['word','word','word']); index.add('b', ['word'])
 index.remove('a')
 assert.equal(index.df.get('word'), 1)
 assert.equal(index.search(['word'])[0]?.id, 'b')
})
test('malformed persisted memory is ignored and valid provenance survives reload', async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(),'semantic-contract-'))
 try {
  const store = new SemanticMemoryStore({baseDir:dir,dimension:2})
  await store.appendChunks('100', [{ id:'chunk',text:'original',end_ts:Date.now(),vector:[1,0],source_bot_ids:['bot1','bot2'],source_group_id:'100' }])
  fs.appendFileSync(path.join(dir,'group','100.ndjson'), '\n'+JSON.stringify({id:'bad',emb:'AA==',text:[],end_ts:'bad'})+'\n')
  const loaded = new SemanticMemoryStore({baseDir:dir,dimension:2}).loadGroup('100')
  assert.equal(loaded.chunks.size,1)
  assert.deepEqual(loaded.chunks.get('chunk')?.source_bot_ids,['bot1','bot2'])
  assert.equal(loaded.chunks.get('chunk')?.source_group_id,'100')
  const manager = new MidtermSummaryManager({baseDir:dir})
  fs.writeFileSync(path.join(dir,'group','200.json'), '{"summary":{},"updated_at":1}')
  assert.equal(manager.loadSummary('200'),null)
 } finally {fs.rmSync(dir,{recursive:true,force:true})}
})
test('episodic caches isolate equal group ids in different data roots', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'episode-contract-'))
 try {
  resetEpisodicMemoryForTests()
  recordEpisode({groupId:'100',summary:'left',baseDir:path.join(dir,'left')})
  recordEpisode({groupId:'100',summary:'right',baseDir:path.join(dir,'right')})
  assert.equal(recallEpisodes({groupId:'100',baseDir:path.join(dir,'left')})[0]?.summary,'left')
  assert.equal(recallEpisodes({groupId:'100',baseDir:path.join(dir,'right')})[0]?.summary,'right')
 } finally {resetEpisodicMemoryForTests();fs.rmSync(dir,{recursive:true,force:true})}
})

test('semantic runtime disable restores archive hook without accumulating wrappers', async () => {
 const { installSemanticMemoryRuntime, __resetSemanticMemoryRuntimeForTest } = await import('../../src/modules/memory/infrastructure/semanticRuntime.js')
 const recordMessage = async () => null
 const archive = { recordMessage, getBaseDir:()=>'/tmp/memory-hook-fixture/archive', formatRecord:()=>'', readAllGroupMessages:async()=>[],readRecentGroupMessages:async()=>[],listArchiveGroupIds:async()=>[] }
 const pluginSettings = { semanticMemory:{enabled:true}, embeddingAiConfig:{embeddingApiUrl:'https://unused.invalid',embeddingApiKey:'fixture',embeddingApiModel:'fixture'} }
 try {
  installSemanticMemoryRuntime({pluginSettings,archiveManager:archive})
  assert.notEqual(archive.recordMessage,recordMessage)
  installSemanticMemoryRuntime({pluginSettings:{semanticMemory:{enabled:false}},archiveManager:archive})
  assert.equal(archive.recordMessage,recordMessage)
  installSemanticMemoryRuntime({pluginSettings,archiveManager:archive})
  __resetSemanticMemoryRuntimeForTest()
  assert.equal(archive.recordMessage,recordMessage)
 } finally {__resetSemanticMemoryRuntimeForTest()}
})
test('semantic and midterm hooks survive interleaved reinstall and detach exactly once',async()=>{
 const semantic=await import('../../src/modules/memory/infrastructure/semanticRuntime.js')
 const midterm=await import('../../src/modules/memory/infrastructure/MidtermSummaryManager.js')
 let baseCalls=0,indexCalls=0,summaryCalls=0
 const original=async()=>{baseCalls++;return {group_id:'100',raw_message:'sample'}}
 const archive={recordMessage:original,getBaseDir:()=>'/tmp/memory-hook-fixture/archive',formatRecord:()=>'',readAllGroupMessages:async()=>[],readRecentGroupMessages:async()=>[],listArchiveGroupIds:async()=>[]}
 const semanticSettings={semanticMemory:{enabled:true},embeddingAiConfig:{embeddingApiUrl:'https://unused.invalid',embeddingApiKey:'fixture',embeddingApiModel:'fixture'}}
 const midtermSettings={midtermMemory:{enabled:true},memoryAiConfig:{memoryAiUrl:'https://unused.invalid',memoryAiApikey:'fixture'}}
 const installSemantic=()=>{const runtime=semantic.installSemanticMemoryRuntime({pluginSettings:semanticSettings,archiveManager:archive})!;runtime.indexer.onArchivedRecord=()=>{indexCalls++}}
 const installMidterm=()=>{const runtime=midterm.installMidtermMemoryRuntime({pluginSettings:midtermSettings,archiveManager:archive})!;runtime.onArchivedRecord=()=>{summaryCalls++}}
 try {
  installSemantic();installMidterm();installSemantic()
  await archive.recordMessage();assert.deepEqual([baseCalls,indexCalls,summaryCalls],[1,1,1])
  semantic.installSemanticMemoryRuntime({pluginSettings:{semanticMemory:{enabled:false}},archiveManager:archive})
  await archive.recordMessage();assert.deepEqual([baseCalls,indexCalls,summaryCalls],[2,1,2])
  installSemantic();installMidterm()
  midterm.__resetMidtermMemoryForTest()
  await archive.recordMessage();assert.deepEqual([baseCalls,indexCalls,summaryCalls],[3,2,2])
  semantic.__resetSemanticMemoryRuntimeForTest()
  assert.equal(archive.recordMessage,original)
 } finally {semantic.__resetSemanticMemoryRuntimeForTest();midterm.__resetMidtermMemoryForTest()}
})
