import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {DiceManager} from '../dist/backend/modules/dice/infrastructure/DiceManager.js'
import {decodeDiceState,numericDiceTotal} from '../dist/backend/modules/dice/infrastructure/diceDecoders.js'
import {loadJsRuleSource,resolveDiceRuleImportSource} from '../dist/backend/modules/dice/infrastructure/DiceRuleImport.js'

test('compiled dice state rejects malformed top-level and card records without replacing valid state',()=>{
 for(const data of [null,[],{users:[]},{groups:'bad'},{users:{u:null}},{users:{u:{cards:{bad:null}}}}])assert.throws(()=>decodeDiceState(data),/损坏|根节点/)
 const state=decodeDiceState({users:{u:{activeCard:'调查员',cards:{调查员:{name:'调查员',attrs:{SAN:60},skills:{侦查:50},ruleData:{rules:{values:{health:3}}}}}}},groups:{}})
 assert.equal(state.users.u.cards.调查员.attrs.SAN,60)
 assert.deepEqual(state.users.u.cards.调查员.ruleData,{rules:{values:{health:3}}})
})

test('compiled dice expression preserves comparison display but prevents text counts from corrupting numerical stats',()=>{
 const manager=new DiceManager({cwd:os.tmpdir()})
 const config=manager.getConfig()
 const result=manager.rollExpression('2d6>=4',config,()=>0.5)
 assert.equal(result.total,'成功 2/2');assert.match(result.detail,/4✓/)
 assert.throws(()=>numericDiceTotal(result.total),/数值骰点/)
 assert.equal(numericDiceTotal(manager.rollExpression('2d6+1',config,()=>0.5).total),9)
})

test('compiled dice log reader skips scalar and malformed JSON records',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dice-log-decoder-'))
 try{const file=path.join(directory,'log.jsonl');await fs.writeFile(file,'null\n42\n[]\ninvalid\n{"content":"掷骰", "userId":123}\n');const result=new DiceManager().readLogLines(file);assert.deepEqual(result,[{content:'掷骰',userId:'123'}])}finally{await fs.rm(directory,{recursive:true,force:true})}
})

test('compiled rule import honors declared and streamed package size bounds',async()=>{
 const event={message:[{type:'file',name:'rule.yaml',url:'https://example.test/rule.yaml'}]}
 await assert.rejects(resolveDiceRuleImportSource(event,'',{fetchImpl:async()=>new Response('small',{headers:{'content-length':String(64*1024+1)}})}),/字节上限/)
 await assert.rejects(resolveDiceRuleImportSource(event,'',{fetchImpl:async()=>new Response('x'.repeat(64*1024+1))}),/字节上限/)
 assert.equal(await resolveDiceRuleImportSource({},'```yaml\nid: example\n```'),'id: example')
})

test('compiled JS rule loader exposes validated functions and cleans its temporary module',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dice-js-loader-'))
 try{
  const loaded=await loadJsRuleSource('module.exports={id:"test", functions:{sum:(args)=>args.reduce((a,b)=>a+b,0)}}',{rulesDir:directory})
  assert.equal(loaded.packObject.id,'test');assert.deepEqual(loaded.functionNames,['sum']);assert.equal(loaded.functions.sum([1,2],{}),3)
  assert.deepEqual(await fs.readdir(path.join(directory,'pending','.js-load')),[])
  await assert.rejects(loadJsRuleSource('module.exports={functions:{bad:123}}',{rulesDir:directory}),/必须是函数/)
  assert.deepEqual(await fs.readdir(path.join(directory,'pending','.js-load')),[])
 }finally{await fs.rm(directory,{recursive:true,force:true})}
})
