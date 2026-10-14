import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import KnowledgeSearcher from '../../src/modules/knowledge/infrastructure/KnowledgeSearcher.js'
import KnowledgeExpander from '../../src/modules/knowledge/infrastructure/KnowledgeExpander.js'
import {parseEmbeddingResponse} from '../../src/modules/knowledge/domain/knowledgeData.js'

test('knowledge reader ignores malformed vectors and ranks finite matching records',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'knowledge-types-')),dbPath=path.join(dir,'db.ndjson')
 try{
 await writeFile(dbPath,[JSON.stringify({text:'正确',embedding:[1,0]}),JSON.stringify({text:'坏数据',embedding:['x',0]}),'not-json',JSON.stringify({text:'空向量',embedding:[]})].join('\n'))
 const searcher=new KnowledgeSearcher({apiKey:'fixture',apiUrl:'https://fixture.invalid',dbPath})
 searcher.getEmbedding=async()=>({data:[{embedding:[1,0]}]})
 const result=await searcher.search('正确');assert.match(result?.knowledgeContext||'',/正确/);assert.doesNotMatch(result?.knowledgeContext||'',/坏数据/)
 assert.equal(searcher.cosineSimilarity([1],[1,0]),0)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('knowledge expansion deduplicates within request and persisted data',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'knowledge-types-')),dbPath=path.join(dir,'db.ndjson')
 try{
 const expander=new KnowledgeExpander({apiKey:'fixture',apiUrl:'https://fixture.invalid',dbPath})
 expander.getEmbedding=async input=>({data:(Array.isArray(input)?input:[input]).map(()=>({embedding:[1,0]}))})
 assert.equal((await expander.expand(['one','one','two'])).added,2)
 assert.equal((await expander.expand(['one'])).added,0)
 assert.equal((await readFile(dbPath,'utf8')).trim().split('\n').length,2)
 assert.throws(()=>parseEmbeddingResponse({data:[{embedding:['bad']}]}),/向量无效/)
 }finally{await rm(dir,{recursive:true,force:true})}
})
