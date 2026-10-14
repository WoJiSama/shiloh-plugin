import {Agent} from 'node:https'
import type {SecureVersion} from 'node:tls'
export type ResponseType='buffer'|'json'|'text'|'arrayBuffer'|'formData'|'blob'
export interface RequestOptions extends Omit<RequestInit,'body'> {url?:string;body?:BodyInit|null;params?:Record<string,unknown>;data?:unknown;responseType?:ResponseType;statusCode?:ResponseType;closeCheckStatus?:boolean;origError?:boolean;outErrorLog?:boolean;cf?:boolean}
export interface RequestPorts {fetch?:typeof fetch;logger?:{error(error:unknown):void};image?(url:string,cache?:boolean,timeout?:number,headers?:HeadersInit):unknown}
export class HTTPResponseError extends Error {constructor(public readonly response:Response){super(`HTTP 响应错误：${response.status} ${response.statusText}`)}}
export function qs(obj:Record<string,unknown>):string {return Object.entries(obj).map(([key,value])=>`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&')}
const CHROME_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36'
export function createRequestClient(ports:RequestPorts={}) {
 const fetchImpl=ports.fetch ?? globalThis.fetch
 async function request(url:string,options:RequestOptions,method:string):Promise<unknown> {
  const headers=new Headers(options.headers)
  if(!headers.has('User-Agent'))headers.set('User-Agent',options.cf?'PostmanRuntime/7.29.0':CHROME_UA)
  if(method==='POST' && !headers.has('Content-Type'))headers.set('Content-Type','application/json')
  const target=new URL(url)
  for(const [key,value] of Object.entries(options.params ?? {}))target.searchParams.append(key,String(value))
  let body=options.body
  if(options.data!==undefined){
   const contentType=headers.get('Content-Type') || ''
   if(/json/i.test(contentType))body=JSON.stringify(options.data)
   else if(/x-www-form-urlencoded/i.test(contentType)){
    if(!options.data || typeof options.data!=='object' || Array.isArray(options.data))throw new TypeError('表单数据必须是对象')
    body=qs(options.data as Record<string,unknown>)
   }else if(typeof options.data==='string'||options.data instanceof Blob||options.data instanceof FormData||options.data instanceof URLSearchParams)body=options.data
   else throw new TypeError('不支持的请求数据类型')
  }
  const {params:_,data:__,responseType,statusCode,closeCheckStatus,origError,outErrorLog,cf:___,url:____,...init}=options
  try{
   const response=await fetchImpl(target,{...init,method,headers,...(body===undefined?{}:{body})})
   if(!closeCheckStatus&&!response.ok)throw new HTTPResponseError(response)
   const type=responseType||statusCode
   if(type==='buffer')return Buffer.from(await response.arrayBuffer())
   if(type)return await response[type]()
   return response
  }catch(error){
   if(outErrorLog!==false)ports.logger?.error(error)
   if(origError)throw error
   const message=error instanceof Error?error.message:String(error)
   throw new Error(`请求错误：${method} 失败，${message.match(/reason:(.*)/)?.[1]||message}`,{cause:error})
  }
 }
 return {
  get:(url:string,options:RequestOptions={})=>request(url,options,'GET'),
  post:(url:string,options:RequestOptions={})=>request(url,options,'POST'),
  cfGet:(url:string,options:RequestOptions={})=>request(url,{...options,cf:true},'GET'),
  cfPost:(url:string,options:RequestOptions={})=>request(url,{...options,cf:true},'POST'),
  // Legacy configuration never enabled a proxy. Do not imply proxy or CF bypass support.
  getAgent:(_cf?:boolean,_isProxy=true):false=>false,
  verifyIsProxy:(_url:string):boolean=>false,
  getTlsVersionAgent:(address:string,version:SecureVersion,isProxy:boolean)=>{if(isProxy&&/^https?:/i.test(address))throw new Error('此请求适配器未配置代理传输');return new Agent({minVersion:version,maxVersion:version})},
  proxyRequestImg:(url:string,options:{cache?:boolean;timeout?:number;headers?:HeadersInit}={})=>{if(!ports.image)throw new Error('缺少图片消息端口');return ports.image(url,options.cache,options.timeout,options.headers)}
 }
}
export type RequestClient=ReturnType<typeof createRequestClient>
