import type {Browser,LaunchOptions} from 'puppeteer'
import net from 'node:net'
import {WebContentExtractor,normalizeWebUrl} from './WebContentExtractor.js'
import type {WebBrowserPort} from './WebContentExtractor.js'
export interface WebParserOptions {maxRetries?:number;retryDelay?:number;proxy?:string|null;timeout?:number;proxyAuth?:{username:string;password:string}|null}
export function createWebParser(port:WebBrowserPort,executablePath:()=>string){
 return class WebParser extends WebContentExtractor {
 maxRetries:number;retryDelay:number;proxy:string|null;timeout:number;proxyAuth:WebParserOptions['proxyAuth'];useProxy=false;proxyInitialized=false;
 constructor(options:WebParserOptions={}){super(port);this.maxRetries=Math.max(1,options.maxRetries||2);this.MAX_RETRIES=this.maxRetries;this.retryDelay=options.retryDelay??2000;this.RETRY_DELAY=this.retryDelay;this.proxy=options.proxy||null;this.timeout=options.timeout||35000;this.NAVIGATION_TIMEOUT=this.timeout;this.proxyAuth=options.proxyAuth||null}
 async testProxy(proxyUrl:string){try{const parsed=new URL(proxyUrl.includes('://')?proxyUrl:`http://${proxyUrl}`);return await new Promise<boolean>(resolve=>{const socket=new net.Socket();let settled=false;const finish=(ok:boolean)=>{if(settled)return;settled=true;socket.destroy();resolve(ok)};socket.setTimeout(5000);socket.once('timeout',()=>finish(false));socket.once('error',()=>finish(false));socket.connect(Number(parsed.port)||80,parsed.hostname,()=>finish(true))})}catch{return false}}
 async initializeProxy(){this.useProxy=Boolean(this.proxy&&await this.testProxy(this.proxy));this.proxyInitialized=true}
 override getLaunchOptions():LaunchOptions{const options=super.getLaunchOptions();options.executablePath=executablePath();if(this.useProxy&&this.proxy)options.args=[...(options.args||[]),`--proxy-server=${this.proxy}`];return options}
 override async createPage(browser:Browser){const page=await super.createPage(browser);if(this.useProxy&&this.proxyAuth)await page.authenticate(this.proxyAuth);return page}
 async fetchContent(input:string){const url=normalizeWebUrl(input);if(!url)throw new Error('无效网页链接');if(!this.proxyInitialized)await this.initializeProxy();let lastError:unknown;for(let attempt=0;attempt<this.maxRetries;attempt++){let browser:Browser|undefined;try{browser=await port.launch(this.getLaunchOptions());return await this.loadPage(await this.createPage(browser),url)}catch(error){lastError=error;if(this.useProxy)this.useProxy=false}finally{await browser?.close().catch(()=>{})}if(attempt+1<this.maxRetries)await this.wait(this.retryDelay)}throw lastError}
 async processContent(url:string){if(!this.proxyInitialized)await this.initializeProxy();try{return await this.fetchAndCleanContent(url,true)}catch{return null}}
 }
}
