import test from 'node:test'
import assert from 'node:assert/strict'
import {createConversationUtils} from '../dist/backend/modules/conversation/infrastructure/conversationUtils.js'
test('compiled intent tool filter executes with explicit dependencies and excludes unrequested search',()=>{
 const runtime=createConversationUtils({normalizeIntentText:s=>String(s||''),isRealtimeInfoRequest:()=>false,isExplicitSearchRequest:()=>false,isExplicitToolIntent:()=>false,isExplicitAdminCollectionMentionRequest:()=>false,filterToolsForEmojiExposure:()=>null,SEARCH_TOOL_NAMES:new Set(['searchInformationTool']),shouldExposeEmojiToolForMessage:()=>true})
 const tools=[{function:{name:'sendLocalEmojiTool'}},{function:{name:'searchInformationTool'}}]
 const result=runtime.filterToolsForMessageIntent(tools,{group_id:1,msg:'希洛你好吗'},'希洛你好吗',{allowSearch:false,emojiCooldownMs:120000})
 assert.deepEqual(result,[tools[0]])
})


test('manifest candidates survive exposure without opening unrelated action tools', () => {
 const runtime=createConversationUtils({normalizeIntentText:s=>String(s||''),isRealtimeInfoRequest:()=>false,isExplicitSearchRequest:()=>false,isExplicitToolIntent:()=>false,isExplicitAdminCollectionMentionRequest:()=>false,filterToolsForEmojiExposure:()=>null,SEARCH_TOOL_NAMES:new Set(['searchInformationTool']),shouldExposeEmojiToolForMessage:()=>false})
 const tools=['searchMusicTool','memberInfoTool','jinyanTool','reminderTool'].map(name=>({function:{name}}))
 assert.deepEqual(runtime.filterToolsForMessageIntent(tools,{msg:'来首周杰伦的'},'来首周杰伦的',{toolCandidates:['searchMusicTool']}),[tools[0]])
 assert.deepEqual(runtime.filterToolsForMessageIntent(tools,{msg:'那哥们是谁来着'},'那哥们是谁来着',{toolCandidates:['memberInfoTool']}),[tools[1]])
})

test('primary search intent survives optional emoji candidates', () => {
 const runtime=createConversationUtils({normalizeIntentText:s=>String(s||''),isRealtimeInfoRequest:()=>false,isExplicitSearchRequest:()=>false,isExplicitToolIntent:()=>false,isExplicitAdminCollectionMentionRequest:()=>false,filterToolsForEmojiExposure:()=>null,SEARCH_TOOL_NAMES:new Set(['searchInformationTool']),shouldExposeEmojiToolForMessage:()=>true})
 const tools=['sendLocalEmojiTool','searchInformationTool','jinyanTool'].map(name=>({function:{name}}))
 assert.deepEqual(runtime.filterToolsForMessageIntent(tools,{msg:'最近成都天气怎么样'},'最近成都天气怎么样',{allowSearch:true,toolCandidates:['sendLocalEmojiTool']}),tools.slice(0,2))
})
