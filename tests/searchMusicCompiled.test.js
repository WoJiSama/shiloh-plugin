import test from 'node:test'
import assert from 'node:assert/strict'
import {createSearchMusicTool} from '../dist/backend/modules/media/infrastructure/SearchMusicTool.js'
function fixture(){
 const payload={code:0,search:{data:{body:{song:{list:[{mid:'abc',title:'<em>歌</em>',singer:[{name:'作者'}]}]}}}}}
 const Tool=createSearchMusicTool({fetch:async()=>new Response(JSON.stringify(payload)),getBot:()=>({uin:1,sendApi:async()=>{throw Error('wrong account')}}),logger:{info(){},error(){}}})
 return {tool:new Tool()}
}

test('music tool sends through event bot and unknown receipt is not reported as success',async()=>{
 const {tool}=fixture();let sends=0
 tool.getPlayUrl=async()=> 'https://audio.example/song'
 const result=await tool.func({keyword:'歌'},{reply:async()=>{},bot:{uin:2,sendApi:async(action,data)=>{assert.equal(action,'send_group_msg');assert.equal(data.message[0].data.title,'歌');sends++;return undefined}},group_id:3})
 assert.match(result,/未确认/);assert.equal(sends,1)
})
test('music search filters invalid provider rows and preserves equals in cookies',async()=>{
 const {tool}=fixture();tool.postJson=async()=>({code:0,search:{data:{body:{song:{list:[null,{mid:'x'}, {mid:'ok',title:'song'}]}}}}})
 const result=await tool.searchQQMusic('query');assert.equal(result.data.length,1);assert.equal(result.data[0].mid,'ok')
 tool.musicCookies.qqmusic='token=abc==;uin=123';assert.equal(tool.getCookieMap().get('token'),'abc==')
})
