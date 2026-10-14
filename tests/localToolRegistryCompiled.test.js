import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {LocalToolRegistry} from '../dist/backend/modules/tools/infrastructure/LocalToolRegistry.js'
const logger={info(){},warn(){},error(){}}
const tool=name=>({name,description:'Tool description',parameters:{type:'object',properties:{}},execute:async()=>name})
test('compiled local registry loads class exports, blocks builtin collisions and rejects malformed tools',async()=>{
 const root=await mkdtemp(join(tmpdir(),'shiloh-tools-'))
 try{
  await writeFile(join(root,'tools.mjs'),`export default class Custom { name='custom'; description='Custom'; parameters={type:'object',properties:{}};execute(){return 'custom'} }\nexport const invalid={name:'invalid'};export const collision={name:'builtin',description:'collision',parameters:{type:'object',properties:{}},execute(){return 'wrong'}}`)
  const registry=new LocalToolRegistry({pluginRoot:root,customToolsDir:root},{factories:[()=>tool('builtin'),()=>({})],logger})
  const state=await registry.reload({force:true})
  assert.equal(state.builtInToolCount,1)
  assert.equal(state.customToolCount,1)
  assert.deepEqual(Object.keys(state.toolInstances),['builtin','custom'])
  assert.equal(await state.toolInstances.builtin.execute({},{}),'builtin')
  assert.equal(await state.toolInstances.custom.execute({},{}),'custom')
  assert.equal(state.functionMap.get('custom').description,'Custom')
 }finally{await rm(root,{recursive:true,force:true})}
})
