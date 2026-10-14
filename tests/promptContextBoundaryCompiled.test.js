import test from 'node:test'
import assert from 'node:assert/strict'
import {decodeImagePromptContext,createPromptContext} from '../dist/backend/modules/conversation/infrastructure/promptContext.js'

test('image prompt boundary rejects structured tool arguments and malformed history without stringifying objects',()=>{
  const decoded=decodeImagePromptContext({prompt:{text:'untrusted object'},images:['https://example.com/a.png',null,3],groupUserMessages:[null,3,{role:'user',content:'画一只猫'},{role:'assistant',content:{text:'bad'}}]})
  assert.equal(decoded.prompt,undefined)
  assert.deepEqual(decoded.images,['https://example.com/a.png'])
  assert.deepEqual(decoded.groupUserMessages,[{role:'user',content:'画一只猫'},{role:'assistant',content:''}])
  assert.deepEqual(decodeImagePromptContext({groupUserMessages:{role:'user'},messages:null}),{groupUserMessages:[],messages:[]})
})

test('image prompt boundary preserves valid references, trace identity and text',()=>{
  const session={turnTrace:{addModelCall(){}}}
  const avatarDrawReference={images:['https://example.com/avatar.png'],promptHint:'使用成员头像'}
  const context=decodeImagePromptContext({prompt:'画一只猫',messages:[{role:'user',content:'之前的说明'}],session,avatarDrawReference})
  assert.equal(context.prompt,'画一只猫')
  assert.equal(context.session,session)
  assert.equal(context.avatarDrawReference,avatarDrawReference)
  assert.deepEqual(context.messages,[{role:'user',content:'之前的说明'}])
})

test('image edit entry handles nontext tool prompt with safe default',()=>{
  const api=createPromptContext({formatAvatarDrawReferencePrompt:()=>'',info(){}})
  const host={config:{},getQuotedPromptContextText:()=>'',getRecentPromptContextText:()=>'',getRecentDrawContextText:()=>''}
  const output=api.buildImageEditPrompt(host,{prompt:{bad:true},groupUserMessages:123})
  assert.match(output,/请按用户要求编辑这张图片/)
  assert.doesNotMatch(output,/\[object Object\]/)
})
