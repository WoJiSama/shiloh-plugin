import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { GlobalStyleLearnerManager } from '../domains/memory/GlobalStyleLearnerManager.js'

test('legacy global style memory retains valid learned fields through save and reload', () => {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'style-persist-'))
 const config={baseDir:path.join(cwd,'style')}
 try {
  const first=new GlobalStyleLearnerManager({cwd})
  const memory=first.readMemory(config)
  memory.totalSamples=42;memory.groupCount={'100':42};memory.samplePool=[{at:'2026-01-01',groupId:'100',essence:['brief'],dross:[],text:'sample',hash:'sample-hash',sequence:false}]
  memory.semanticSamples=[{hash:'hash',embedding:[1,0],patterns:['brief'],sceneKey:'chat',scene:'chat',source:'bot:100',weight:1,feedbackTags:['positive'],sequence:false,at:'2026-01-01',usedCount:2,lastUsedAt:'2026-01-02'}]
  first.writeMemory(config)
  const loaded=new GlobalStyleLearnerManager({cwd}).readMemory(config)
  assert.equal(loaded.totalSamples,42)
  assert.deepEqual(loaded.groupCount,{'100':42})
  assert.deepEqual(loaded.samplePool,memory.samplePool)
  assert.deepEqual(loaded.semanticSamples,memory.semanticSamples)
 } finally {fs.rmSync(cwd,{recursive:true,force:true})}
})
test('broken arrays and nonfinite JSON numbers are sanitized without breaking memory load', () => {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'style-broken-'))
 const config={baseDir:path.join(cwd,'style')}
 try {
  const manager=new GlobalStyleLearnerManager({cwd})
  fs.mkdirSync(config.baseDir)
  fs.writeFileSync(manager.getMemoryPath(config),' {"totalSamples":1e999,"groupCount":{"x":1e999,"y":3},"samplePool":[null,1,[],{"text":5}],"semanticSamples":[{"embedding":[1,1e999]}],"recentSignals":{},"aiRules":{"absorb":[null,"bad",[]]}}')
  const memory=manager.readMemory(config)
  assert.equal(memory.totalSamples,0)
  assert.deepEqual(memory.groupCount,{y:3})
  assert.deepEqual(memory.semanticSamples,[])
  assert.deepEqual(memory.aiRules.absorb,[])
  assert.equal(memory.samplePool[0].text,'')
  assert.doesNotThrow(()=>manager.writeMemory(config))
 } finally {fs.rmSync(cwd,{recursive:true,force:true})}
})
