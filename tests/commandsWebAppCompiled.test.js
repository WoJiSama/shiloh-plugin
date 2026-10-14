import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {createCommandsWebApp,saveSealSourceVersion} from '../dist/backend/modules/platform/infrastructure/console/commandsWebApp.js'
import {DiceManager} from '../dist/backend/modules/dice/infrastructure/DiceManager.js'
import {DiceRulePackManager} from '../dist/backend/modules/dice/infrastructure/DiceRulePackManager.js'
const source = command => `const ext=seal.ext.new('web-edit-test','tester','1');seal.ext.register(ext);const cmd=seal.ext.newCmdItemInfo();cmd.name='${command}';cmd.solve=()=>seal.ext.newCmdExecuteResult(true);ext.cmdMap['${command}']=cmd;`
function fixture(t){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'commands-compiled-'))
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}))
  const root=path.join(cwd,'plugins','shiloh-plugin')
  fs.mkdirSync(path.join(root,'config_default'),{recursive:true})
  fs.writeFileSync(path.join(root,'config_default','message.yaml'),'pluginSettings:\n  diceSystem:\n    enabled: true\n    customRulesEnabled: true\n    baseDir: data/dice\n')
  const logger={warn(){},info(){},error(){}}
  const diceManager=new DiceManager({cwd,logger})
  return {root,manager:new DiceRulePackManager({cwd,diceManager,logger})}
}
async function seed(manager){
  const staged=await manager.stageImport(source('first'),'seed')
  assert.equal(staged.ok,true)
  await manager.confirmImport(staged.pack.id,'seed',{stageId:staged.pending.stageId})
  await manager.mutateIndex(index=>{index.groups['100']={active:{'web-edit-test':1}};index.groups['200']={active:{}}})
}
test('compiled source editing versions and verifies hashes while preserving old source',async t=>{
  const {manager}=fixture(t);await seed(manager)
  const old=manager.getVersionRecord('web-edit-test')
  const result=await saveSealSourceVersion(manager,'web-edit-test',source('second'))
  assert.equal(result.version,2);assert.deepEqual(result.commands,['second'])
  const latest=manager.getVersionRecord('web-edit-test')
  assert.equal(latest.hash,crypto.createHash('sha256').update(source('second')).digest('hex'))
  assert.equal(fs.readFileSync(manager.resolveRulePath(old.sourceFile),'utf8'),source('first'))
  assert.ok(manager.loadPack('web-edit-test',1));assert.ok(manager.loadPack('web-edit-test',2))
  assert.equal(manager.readIndex().groups['100'].active['web-edit-test'],2)
  assert.deepEqual(manager.readIndex().groups['200'].active,{})
})
test('failed preflight and confirmation preserve active group versions',async t=>{
  const {manager}=fixture(t);await seed(manager)
  await assert.rejects(saveSealSourceVersion(manager,'web-edit-test','seal.ext.new('))
  assert.equal(manager.readIndex().groups['100'].active['web-edit-test'],1)
  manager.confirmImport=async()=>{throw new Error('registration failure')}
  await assert.rejects(saveSealSourceVersion(manager,'web-edit-test',source('second')),/registration failure/)
  assert.equal(manager.readIndex().groups['100'].active['web-edit-test'],1)
  assert.equal(manager.getVersionRecord('web-edit-test').version,1)
})
test('compiled command APIs reject missing and observe credentials and accept owner credentials',async t=>{
  const {root}=fixture(t);let handler
  const app=createCommandsWebApp({app:()=>({use(_path,fn){handler=fn}}),deckManager:{},diceManager:{},emojiPackManager:{},readUserSettings:()=>({}),applyFlatUpdates(){},checkGuobaLoginToken:async token=>token==='guoba-valid',collectBotGroupNames:()=>({100:'Group'}),collectBotIdentities:()=>[],ensureGuobaJumpLink(){},watchGuobaJumpLink(){},watch(){},registerObserveWebApp(){},registerSemanticMemoryWebApp(){},registerQzoneWebApp(){}})
  await app.registerCommandsWebApp(root)
  const tokens=JSON.parse(fs.readFileSync(path.join(root,'config','commands-web.json'),'utf8'))
  async function request(query){const res={code:200,status(code){this.code=code;return this},json(value){this.value=value}};await handler({path:'/api/group-names',method:'GET',query},res,()=>{});return res}
  assert.equal((await request({})).code,401)
  assert.equal((await request({token:tokens.observeToken})).code,401)
  assert.deepEqual((await request({token:tokens.token})).value,{groups:{100:'Group'}})
  assert.equal((await request({guoba_token:'guoba-valid'})).code,200)
})
