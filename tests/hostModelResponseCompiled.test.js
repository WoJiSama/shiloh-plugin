import test from 'node:test'
import assert from 'node:assert/strict'
import {decodeHostModelResponse} from '../dist/backend/modules/host/infrastructure/hostModelResponse.js'
test('host model response keeps tool calls, reasoning and usage with null tool-only content',()=>{
 const input={id:'response-1',choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,reasoning_content:'summary',tool_calls:[{id:'call-1',type:'function',function:{name:'search',arguments:'{"q":"hello"}'}}]}}],usage:{total_tokens:42,prompt_tokens:30}}
 const result=decodeHostModelResponse(input);assert.equal(result.id,input.id);assert.deepEqual(result.choices[0].message.tool_calls,input.choices[0].message.tool_calls);assert.equal(result.choices[0].message.reasoning_content,'summary');assert.equal(result.choices[0].message.content,undefined);assert.equal(result.choices[0].finish_reason,'tool_calls');assert.deepEqual(result.usage,input.usage)
})
test('host model response rejects malformed text, tool arguments and token counts',()=>{
 for(const input of [{choices:[{message:{content:{text:'bad'}}}]},{choices:[{message:{content:['bad']}}]},{choices:[{message:{tool_calls:[{function:{arguments:{q:'bad'}}}]}}]},{choices:[{message:{reasoning_content:42}}]},{usage:{total_tokens:NaN}},{choices:{message:{content:'bad'}}}])assert.throws(()=>decodeHostModelResponse(input))
 assert.equal(decodeHostModelResponse({choices:[{message:{content:'answer'}}]}).choices[0].message.content,'answer')
})
