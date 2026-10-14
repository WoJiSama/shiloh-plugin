import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import {TextImageTool} from '../dist/backend/modules/rendering/infrastructure/TextImageTool.js'
import {createPreviewRenderer} from '../dist/backend/modules/rendering/infrastructure/preview.js'
import {createBaseModel} from '../dist/backend/modules/rendering/infrastructure/base.js'
const ports={guardText:text=>text,image:file=>({type:'image',file}),getSharedBrowser:async()=>{throw new Error('unexpected browser')},scheduleSharedBrowserClose(){}}

test('compiled chat SVG renders highlighted code with a defined palette',async()=>{
 const tool=new TextImageTool(ports)
 const file=await tool.renderChatImage({text:'```javascript\nconst value = 42\n```',nickname:'',avatarUrl:''})
 try {const meta=await sharp(file).metadata();assert.equal(meta.format,'png');assert.ok(meta.width>200);assert.ok(meta.height>70)}finally{await fs.unlink(file)}
})

test('compiled text image removes a generated file when delivery fails and rejects absent reply',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'text-image-failure-')),file=path.join(directory,'image.png')
 const tool=new TextImageTool(ports)
 tool.renderChatImage=async()=>{await fs.writeFile(file,'image');return file}
 try{
  await assert.rejects(tool.func({text:'hello'},{reply:async()=>{throw new Error('send failed')}}),/send failed/)
  await assert.rejects(fs.stat(file),{code:'ENOENT'})
  await assert.rejects(tool.func({text:'hello'},{}),/可回复/)
 }finally{await fs.rm(directory,{recursive:true,force:true})}
})

test('compiled preview extracts code and releases browser/pages after successful frontend rendering',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'preview-compiled-'))
 let closed=0,browserClosed=0,calls=0
 const screenshots=[]
 const page={setDefaultTimeout(){},setContent:async()=>{},setViewport:async()=>{},close:async()=>{closed++},waitForSelector:async()=>{},
  evaluate:async()=>{calls++;return calls===1?undefined:calls===2?{width:400,height:200}:calls===3?false:{x:0,y:0,width:400,height:200}},
  screenshot:async options=>{screenshots.push(options)}}
 const renderer=createPreviewRenderer({launch:async()=>({newPage:async()=>page,pages:async()=>[page],close:async()=>{browserClosed++}})})
 assert.deepEqual(renderer.extractCodeBlocks('```html\n<b>Hello</b>\n```'),[{language:'html',code:'<b>Hello</b>'}])
 try{
  const output=await renderer.extractAndRender('```html\n<b>Hello</b>\n```',{outputDir:directory,puppeteerUserDataDir:directory})
  assert.equal(output.length,1);assert.equal(output[0].type,'code');assert.equal(screenshots[0].clip.width,400)
  assert.equal(closed,2);assert.equal(browserClosed,1)
 }finally{await fs.rm(directory,{recursive:true,force:true})}
})

test('compiled preview skips empty pages while still releasing the browser',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'preview-empty-'))
 let calls=0,closed=0
 const page={setDefaultTimeout(){},setContent:async()=>{},setViewport:async()=>{},close:async()=>{},waitForSelector:async()=>{},evaluate:async()=>{calls++;return calls===1?undefined:calls===2?{width:0,height:0}:true},screenshot:async()=>{throw new Error('blank screenshot')}}
 const renderer=createPreviewRenderer({launch:async()=>({newPage:async()=>page,pages:async()=>[],close:async()=>{closed++}})})
 try{assert.deepEqual(await renderer.extractAndRender('```html\n<div></div>\n```',{outputDir:directory,puppeteerUserDataDir:directory}),[]);assert.equal(closed,1)}finally{await fs.rm(directory,{recursive:true,force:true})}
})

test('compiled base model preserves template identity and rejects invalid package metadata',()=>{
 const Base=createBaseModel('shiloh-plugin'),base=new Base({user_id:123})
 base.model='report'
 assert.equal(base.prefix,'Yz:shiloh-plugin:report:');assert.equal(base.screenData.saveId,123)
 assert.equal(base.screenData.tplFile,'./plugins/shiloh-plugin/resources/html/report/report.html')
 assert.throws(()=>createBaseModel({name:'wrong'}),/名称/)
})
