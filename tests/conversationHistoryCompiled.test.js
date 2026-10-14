import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createConversationHistory} from '../dist/backend/modules/conversation/infrastructure/conversationHistory.js'
import {createTaskStatus} from '../dist/backend/modules/conversation/infrastructure/taskStatus.js'

test('compiled history falls back to disk for empty Redis and validates records',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'conversation-history-'))
 t.after(()=>fs.rm(dir,{recursive:true,force:true}))
 const saved=[]
 const api=createConversationHistory({loadData:async()=>[],saveData:async(...args)=>saved.push(args),deleteKey:async()=>{},debug(){},error(){}})
 const host={messageHistoriesRedisKey:'history',messageHistoriesDir:dir,MAX_HISTORY:2}
 await fs.writeFile(path.join(dir,'1_2.json'),JSON.stringify([{role:'user',content:'older'},null,{bad:'row'}]))
 assert.deepEqual(await api.getGroupUserMessages(host,1,2),[{role:'user',content:'older'}])
 assert.equal(saved.length,1)
 assert.deepEqual(api.trimMessageHistory(host,[{role:'system',content:'sys'},{role:'user',content:'1'},{role:'user',content:'2'},{role:'user',content:'3'}]).map(x=>x.content),['sys','2','3'])
})

test('compiled nested forwards preserve sender and stop cycles',async()=>{
 const api=createConversationHistory({loadData:async()=>[],saveData:async()=>{},deleteKey:async()=>{},debug(){},error(){}})
 const host={collectForwardPromptLines:(...args)=>api.collectForwardPromptLines(host,...args)}
 const group={getForwardMsg:async()=>[{sender:{nickname:'A'},message:[{type:'text',text:'hello'},{type:'forward',id:'same'}]}]}
 const lines=await api.collectForwardPromptLines(host,group,'same')
 assert.match(lines.join('\n'),/hello/)
 assert.match(lines.join('\n'),/重复/)
})

test('compiled task status rejects malformed persistence and answers active draw',async()=>{
 const rows=new Map(),sent=[]
 const api=createTaskStatus({store:()=>({get:async key=>rows.get(key),set:async(key,value)=>rows.set(key,value),del:async key=>rows.delete(key)}),logger:{warn(){},info(){}},activeDedupeToolRuns:new Map()})
 const host={TASK_STATUS_PREFIX:'status:',ACTIVE_TOOL_TASK_PREFIX:'active:',config:{},getToolRunKey:(g,u,t)=>`${g}:${u}:${t}`}
 for(const [name,fn] of Object.entries(api))host[name]=(...args)=>fn(host,...args)
 host.sendObservedReply=async(_e,payload)=>sent.push(payload)
 rows.set('status:1:3','{"status":{},"toolName":"x"}')
 assert.equal(await host.getTaskStatus(1,3),null)
 await host.updateUserToolTaskStatus({groupId:1,userId:2,messageId:4,toolName:'bananaTool',status:'running'})
 assert.equal(await host.handleActiveDrawStatusQuestion({group_id:1,user_id:2},'图呢'),true)
 assert.equal(sent.length,1)
})
