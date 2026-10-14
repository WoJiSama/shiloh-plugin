import {AbstractTool} from './AbstractTool.js'
import {WebContentExtractor,normalizeWebUrl,webTextSimilarity} from '../../media/infrastructure/WebContentExtractor.js'
import type {WebBrowserPort} from '../../media/infrastructure/WebContentExtractor.js'
import {buildVisibleFailureDetail} from '../../models/domain/visibleFailure.js'
import {parseDrawEvent} from './bananaDecoders.js'
import type {DrawEvent} from '../../../contracts/bananaTool.js'
export function createWebParserTool(ports:{browser:WebBrowserPort;image(bytes:Uint8Array):unknown;sendLongTaskOpening(event:DrawEvent,kind:string):Promise<unknown>}){
 return class WebParserTool extends AbstractTool {
 constructor(){super();this.name='webParserTool';this.description='如果用户需要解析网页链接, 解析网页链接内容，提取关键信息';this.parameters={type:'object',properties:{url:{type:'string',description:'需要解析的网页URL',minLength:1,maxLength:2000}},required:['url'],additionalProperties:false}}
 processUrl=normalizeWebUrl;calculateSimilarity=webTextSimilarity;
 async fetchAndCleanContent(url:string){return new WebContentExtractor(ports.browser).fetchAndCleanContent(url,true)}
 override async func(opts:Record<string,unknown>,event:unknown){if(!opts.url)return '请提供网页链接。';const url=this.processUrl(opts.url);if(!url)return '请提供有效的网页链接。';const e=parseDrawEvent(event);await ports.sendLongTaskOpening(e,'web');try{const result=await this.fetchAndCleanContent(url);if(result.screenshot){await e.reply([`标题：${result.title}\n`,ports.image(result.screenshot)]);return `页面解析完成，已发送页面截图。网页主要内容: \n\n${result.text}`}return result}catch(error){return `网页解析失败：${buildVisibleFailureDetail(error)}`}}
 }
}
