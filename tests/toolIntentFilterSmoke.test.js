import test from 'node:test'
import assert from 'node:assert/strict'
import {createConversationUtils} from '../dist/backend/modules/conversation/infrastructure/conversationUtils.js'
test('compiled intent tool filter executes with explicit dependencies and excludes unrequested search',()=>{
 const runtime=createConversationUtils({normalizeIntentText:s=>String(s||''),isRealtimeInfoRequest:()=>false,isExplicitSearchRequest:()=>false,isExplicitToolIntent:()=>false,isExplicitAdminCollectionMentionRequest:()=>false,filterToolsForEmojiExposure:()=>null,SEARCH_TOOL_NAMES:new Set(['searchInformationTool']),shouldExposeEmojiToolForMessage:()=>true})
 const tools=[{function:{name:'sendLocalEmojiTool'}},{function:{name:'searchInformationTool'}}]
 const result=runtime.filterToolsForMessageIntent(tools,{group_id:1,msg:'希洛你好吗'},'希洛你好吗',{allowSearch:false,emojiCooldownMs:120000})
 assert.deepEqual(result,[tools[0]])
})
