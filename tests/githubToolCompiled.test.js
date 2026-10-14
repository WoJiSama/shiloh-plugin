import test from 'node:test'
import assert from 'node:assert/strict'
import {createGitHubRepoTool} from '../dist/backend/modules/knowledge/infrastructure/GithubTool.js'
test('GitHub primary error preserves HTTP failure instead of returning malformed success',async()=>{
 const Tool=createGitHubRepoTool({githubToken:'',fetch:async()=>new Response(JSON.stringify({message:'rate limited'}),{status:429}),logger:{info(){}}})
 const result=await new Tool().func({repoUrl:'https://github.com/user/repo'},{});assert.equal(result.status,'error');assert.match(result.message,/429/)
})
test('GitHub optional API failures do not discard valid repository data',async()=>{
 const Tool=createGitHubRepoTool({githubToken:'',fetch:async url=>String(url).endsWith('/repos/user/repo')?new Response(JSON.stringify({name:'repo',created_at:'2026-01-01',updated_at:'2026-01-02'})):new Response('null',{status:503}),logger:{info(){}}})
 const result=await new Tool().func({repoUrl:'https://github.com/user/repo'},{});assert.equal(result.status,'success');assert.deepEqual(result.data.最近提交,[])
})
