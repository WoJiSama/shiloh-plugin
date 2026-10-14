import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jwt from 'jsonwebtoken'
import {createGuobaLoginTrust,resetGuobaJwtSecretCache} from '../dist/backend/modules/platform/infrastructure/admin/guobaLoginTrust.js'
import {createAdminCommands} from '../dist/backend/modules/platform/infrastructure/admin/adminCommands.js'
import {explainCompiledPluginUpdate} from '../dist/backend/modules/platform/infrastructure/admin/pluginUpdateBuild.js'
test('compiled guoba authentication fails closed without a secret and isolates root cache',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guoba-typed-'));t.after(()=>{fs.rmSync(dir,{recursive:true,force:true});resetGuobaJwtSecretCache()});const secret='01234567890123456789012345678901';const token=jwt.sign({user:1},secret);const trust=createGuobaLoginTrust(()=>({get:async()=>token}),(token,key)=>jwt.verify(token,key));const root=path.join(dir,'a','plugin');fs.mkdirSync(path.join(dir,'a','Guoba-Plugin','config'),{recursive:true});fs.writeFileSync(path.join(dir,'a','Guoba-Plugin','config','application.yaml'),`jwt:\n  secret: "${secret}"\n`);assert.equal(await trust.checkGuobaLoginToken(token,root),true);assert.equal(await trust.checkGuobaLoginToken(token,path.join(dir,'b','plugin')),false)
})
test('compiled admin command rejects non-master and malformed MCP arguments',async()=>{
 let calls=0;const commands=createAdminCommands({mcpManager:{getStatusSummary:()=>'',executeToolByAlias:async()=>{calls++;return ''}},applyFlatUpdates:()=>{},logger:{mark(){},error(){}}});const messages=[];const host={sendObservedReply:async(_,text)=>messages.push(text),replyLongForward:async()=>{}}
 await commands.testMCPTool(host,{isMaster:false,msg:'#mcp 测试 test {}'});assert.equal(calls,0);assert.match(messages.pop(),/主人/)
 await commands.testMCPTool(host,{isMaster:true,msg:'#mcp 测试 test []'});assert.equal(calls,0);assert.match(messages.pop(),/JSON/)
 assert.match(commands.resolvePersonaTargetGroup(host,{message_type:'group',group_id:123456,isMaster:false},'987654').error,/主人/)
})
test('compiled update notice is owner-only and explicitly requires build deployment',async()=>{let text='';const event={isMaster:false,reply:async value=>{text=value}};assert.equal(await explainCompiledPluginUpdate(event),false);assert.equal(text,'');event.isMaster=true;assert.equal(await explainCompiledPluginUpdate(event),true);assert.match(text,/scripts\/deploy.sh/);assert.match(text,/强制更新也不能/)} )
test('typed session factory preserves business fields through tool refresh and lifecycle sweep',async()=>{
 const {createTypedTurnSessionStore}=await import('../dist/backend/modules/runtime/domain/turnSession.js');let time=100;const store=createTypedTurnSessionStore({now:()=>time,ttlMs:10,createSession:tools=>({tools:tools||[],groupUserMessages:[],actionOutcomes:[],domain:'chat'})});const session=store.getOrCreate('turn',[{name:'old'}]);assert.equal(session.domain,'chat');store.refreshTools([{name:'new'}]);assert.equal(session.tools[0].name,'new');assert.equal(store.getOrCreate('turn'),session);time=111;assert.equal(store.sweep(),1);assert.equal(store.get('turn'),undefined)
})
