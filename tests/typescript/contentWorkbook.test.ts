import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {createAiMindMapTool} from '../../src/modules/content/infrastructure/AiMindMapTool.js'
import {createExcelWorkbookTool} from '../../src/modules/content/infrastructure/ExcelWorkbookTool.js'
import {parseExcelEvent} from '../../src/modules/content/infrastructure/excelFileContext.js'
import ExcelJS from 'exceljs'

test('Excel cache deduplicates loads and rejects failed load entries',async()=>{
 const workbook=new ExcelJS.Workbook();workbook.addWorksheet('data').getCell('A1').value=42
 const bytes=Buffer.from(await workbook.xlsx.writeBuffer());let downloads=0
 const {ExcelWorkbookTool}=createExcelWorkbookTool()
 const tool=new ExcelWorkbookTool({downloadFile:async()=>{downloads++;if(downloads===1)throw new Error('network');return bytes},workbookCache:new Map()})
 const file={fileUrl:'https://example.test/file',fileName:'file.xlsx',origin:'current'}
 await assert.rejects(tool.getWorkbook(file,{user_id:1}),/network/)
 const [left,right]=await Promise.all([tool.getWorkbook(file,{user_id:1}),tool.getWorkbook(file,{user_id:1})])
 assert.equal(downloads,2);assert.equal(left.workbook,right.workbook)
 await tool.getWorkbook(file,{user_id:2});assert.equal(downloads,3)
})
test('Excel event decoder preserves bound adapter and quoted-file methods',async()=>{
 const event={user_id:42,group_id:1,value:'url',async getReply(){return this.value},group:{value:'https://example.test/a.xlsx',async getFileUrl(_id:string){return this.value}}}
 const parsed=parseExcelEvent(event)
 assert.equal(await parsed.getReply?.(),'url');assert.equal(await parsed.group?.getFileUrl?.('id'),'https://example.test/a.xlsx')
})
test('mindmap closes failed renders and reports unconfirmed sends without retry',async()=>{
 let closes=0,sends=0;const files:string[]=[],html:string[]=[]
 const {AiMindMapTool}=createAiMindMapTool({cwd:'/tmp',image:file=>file,readConfig:async()=>({pluginSettings:{}}),fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'# title'}}]}),{status:200}),transform:()=>({root:{content:'</script><script>bad</script>'}}),launch:async()=>({close:async()=>{closes++},newPage:async()=>({setViewport:async()=>{},setContent:async content=>{html.push(content)},waitForFunction:async()=>{},screenshot:async options=>{files.push(options.path);await fs.writeFile(options.path,'image')}})})})
 const tool=new AiMindMapTool()
 const [a,b]=await Promise.all([tool.func({prompt:'one'},{reply:async()=>{sends++;return false}}),tool.func({prompt:'two'},{reply:async()=>{sends++;return {message_id:2}}})])
 assert.match(a,/投递结果未确认/);assert.match(b,/已经发/);assert.equal(sends,2);assert.equal(closes,2);assert.equal(new Set(files).size,2)
 assert.ok(html.every(value=>!value.includes('</script><script>bad')))
 for(const file of files)await assert.rejects(fs.access(file))
 const failure=createAiMindMapTool({cwd:'/tmp',image:file=>file,transform:()=>({root:{}}),readConfig:async()=>{throw new Error('missing config')}})
 assert.match(await new failure.AiMindMapTool().func({prompt:'x'},{}),/missing config/)
})
test('mindmap rendering exceptions release browser and temporary files without sending',async()=>{
 let closed=0,sends=0,screenshotPath=''
 const {AiMindMapTool}=createAiMindMapTool({cwd:'/tmp',image:file=>file,readConfig:async()=>({pluginSettings:{}}),fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'# title'}}]}),{status:200}),transform:()=>({root:{}}),launch:async()=>({close:async()=>{closed++},newPage:async()=>({setViewport:async()=>{},setContent:async()=>{},waitForFunction:async()=>{},screenshot:async options=>{screenshotPath=options.path;throw new Error('screenshot failed')}})})})
 assert.match(await new AiMindMapTool().func({prompt:'x'},{reply:async()=>{sends++;return {message_id:1}}}),/screenshot failed/)
 assert.equal(closed,1);assert.equal(sends,0);await assert.rejects(fs.access(screenshotPath))
})
