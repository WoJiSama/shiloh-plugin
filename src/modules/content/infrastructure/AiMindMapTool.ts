import {AbstractTool} from '../../toolSupport/infrastructure/AbstractTool.js'
import puppeteer from 'puppeteer'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import YAML from 'yaml'
import {extractDeliveryMessageId} from '../../messaging/domain/deliveryObservability.js'
const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'?value as Record<string,unknown>:{}
interface RenderPage {
 setViewport(options:{width:number;height:number}):Promise<void>
 setContent(html:string,options:{waitUntil:'load'}):Promise<void>
 waitForFunction(expression:string,options:{timeout:number}):Promise<unknown>
 screenshot(options:{path:string;fullPage:boolean;type:'png'}):Promise<unknown>
}
interface RenderBrowser {newPage():Promise<RenderPage>;close():Promise<void>}
interface MindMapPorts {
 transform(markdown:string):{root:unknown}
 cwd:string
 image(file:string):unknown
 logger?:{info(message:string):void;error(message:string):void}
 fetchImpl?:typeof globalThis.fetch
 launch?:()=>Promise<RenderBrowser>
 readConfig?:()=>Promise<unknown>
}
export function createAiMindMapTool(ports:MindMapPorts) {
 class AiMindMapTool extends AbstractTool {
  constructor(){
   super()
   this.name='aiMindMapTool'
   this.description='基于描述生成Markmap格式的思维导图'
   this.parameters={type:'object',properties:{prompt:{type:'string',description:'思维导图内容描述',minLength:1,maxLength:4000},width:{type:'number',description:'输出图片宽度',default:2400},height:{type:'number',description:'输出图片高度',default:1600},waitTime:{type:'number',description:'渲染等待时间（毫秒）',default:8000}},required:['prompt'],additionalProperties:false}
  }
  generateSystemPrompt(_opts:unknown={}){return `你是一个专业的思维导图生成助手。请根据用户的描述生成符合Markdown语法的思维导图代码。
要求：
1. 只输出Markdown代码，不要其他解释或代码块标记
2. 确保语法正确，适合Markmap渲染
3. 使用#表示主节点，##表示一级子节点，###表示二级子节点，以此类推
4. 合理组织层级结构，最多5级
5. 使用简洁清晰的描述
6. 避免非Markdown内容（如HTML标签或其他格式）
7. 确保每个节点有清晰的标题`}
  validateMarkdown(markdown:string){const lines=markdown.split('\n').map(line=>line.trim());return lines.some(line=>line.startsWith('#'))&&lines.every(line=>!line.includes('```'))}
  async func(opts:Record<string,unknown>,event:unknown){
   const prompt=typeof opts.prompt==='string'?opts.prompt.trim():''
   if(!prompt)return '思维导图描述内容不能为空'
   const bounded=(value:unknown,fallback:number,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)?Math.max(min,Math.min(max,Math.floor(value))):fallback
   const width=bounded(opts.width,2400,320,4096),height=bounded(opts.height,1600,240,4096),waitTime=bounded(opts.waitTime,8000,1000,30000)
   let browser:RenderBrowser|undefined,outputDirectory:string|undefined
   try {
    const configFile=ports.readConfig?await ports.readConfig():YAML.parse(await fs.readFile(path.join(ports.cwd,'plugins/shiloh-plugin/config/message.yaml'),'utf8'))
    const config=record(record(configFile).pluginSettings),chat=record(config.chatAiConfig)
    const messages=[{role:'system',content:this.generateSystemPrompt(opts)},{role:'user',content:`请根据以下描述生成思维导图：${prompt}`}]
    const response=await (ports.fetchImpl??globalThis.fetch)(String(chat.chatApiUrl||'https://api.openai.com/v1/chat/completions'),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${String(chat.chatApiKey||'sk-xxxxxx')}`},body:JSON.stringify({model:chat.chatApiModel||'gemini-3-pro-preview',messages,stream:false}),signal:AbortSignal.timeout(60000)})
    if(!response.ok)throw new Error(`模型请求失败: HTTP ${response.status}`)
    const json=record(await response.json()),choice=record(Array.isArray(json.choices)?json.choices[0]:undefined),content=record(choice.message).content
    if(typeof content!=='string'||!content.trim())return '生成失败，请检查输入或稍后重试'
    if(!this.validateMarkdown(content))return '生成失败：Markdown内容无效，请确保包含正确的标题层级'
    const {root}=ports.transform(content)
    // Inline script data must not terminate its script element.
    const data=JSON.stringify(root).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029')
    browser=await (ports.launch?ports.launch():puppeteer.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox']}))
    const page=await browser.newPage()
    await page.setViewport({width,height})
    await page.setContent(`<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.jsdelivr.net/npm/d3@6"></script><script src="https://cdn.jsdelivr.net/npm/markmap-view@0.18.10"></script><style>body,html{margin:0;padding:0;height:100%;overflow:hidden}#markmap{width:100%;height:100%}</style></head><body><svg id="markmap" width="${width}" height="${height}"></svg><script>const mm=window.markmap.Markmap.create(document.getElementById('markmap'),null,${data});setTimeout(()=>mm.fit(),100);</script></body></html>`,{waitUntil:'load'})
    await page.waitForFunction('document.querySelector("#markmap").children.length > 0',{timeout:waitTime})
    outputDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'shiloh-mindmap-'))
    const outputPath=path.join(outputDirectory,'markmap.png')
    await page.screenshot({path:outputPath,fullPage:true,type:'png'})
    const reply=record(event).reply
    if(typeof reply!=='function')throw new Error('当前事件缺少图片发送接口')
    const receipt:unknown=await reply.call(event,ports.image(outputPath))
    if(!extractDeliveryMessageId(receipt))throw new Error('图片投递结果未确认，请检查聊天记录；不会自动重复发送')
    ports.logger?.info('Markmap 图片投递完成')
    return 'Markmap 图片已生成, 我已经发到群聊了'
   }catch(error){const message=error instanceof Error?error.message:String(error);ports.logger?.error(`思维导图生成错误: ${message}`);return `生成失败: ${message}`}
   finally {
    if(browser)await browser.close().catch(()=>{})
    if(outputDirectory)await fs.rm(outputDirectory,{recursive:true,force:true}).catch(()=>{})
   }
  }
 }
 return {AiMindMapTool}
}
