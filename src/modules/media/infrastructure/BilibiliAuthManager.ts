import fs from 'node:fs'
import path from 'node:path'
import type {MediaFetch,MediaLogger} from '../../../contracts/mediaRelay.js'
import {mediaRecord,mediaString} from './mediaDecoders.js'
const GENERATE_URL='https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
const POLL_URL='https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
export interface BilibiliAuthOptions {file?:string;fetchImpl?:MediaFetch;logger?:MediaLogger|undefined}
export interface BilibiliQrPort {toBuffer(url:string,options:{type:'png';margin:number;width:number}):Promise<Buffer>}
export function createBilibiliAuthManager(qr:BilibiliQrPort) {
 return class BilibiliAuthManager {
  file:string;fetch:MediaFetch;logger:MediaLogger|undefined;pending:{key:string;expiresAt:number}|null=null
  constructor({file=path.join(process.cwd(),'plugins/shiloh-plugin/config/bilibili-auth.json'),fetchImpl=globalThis.fetch,logger}:BilibiliAuthOptions={}) {this.file=file;this.fetch=fetchImpl;this.logger=logger}
  read(){try{return mediaRecord(JSON.parse(fs.readFileSync(this.file,'utf8')))}catch{return {}}}
  status(){const data=this.read();return {authorized:Boolean(mediaString(data.cookie)),updatedAt:Number(data.updatedAt)||0}}
  cookie(){return mediaString(this.read().cookie)}
  canUseHighQuality({isMaster=false,groupId='',userId='',whitelist={}}:{isMaster?:boolean;groupId?:string|number;userId?:string|number;whitelist?:Record<string,(string|number)[]>}={}) {return isMaster||(whitelist[String(groupId)]||[]).map(String).includes(String(userId))}
  async start(){
   if(this.pending)throw new Error('已有等待扫码的B站登录会话')
   const payload=mediaRecord(await (await this.fetch(GENERATE_URL)).json()),data=mediaRecord(payload.data)
   const key=mediaString(data.qrcode_key),url=mediaString(data.url)
   if(payload.code!==0||!key||!url)throw new Error(mediaString(payload.message)||'B站未返回登录二维码')
   const png=await qr.toBuffer(url,{type:'png',margin:2,width:480}),expiresAt=Date.now()+170_000
   this.pending={key,expiresAt};return {image:`base64://${png.toString('base64')}`,expiresAt}
  }
  async poll(){
   const pending=this.pending
   if(!pending)return {state:'idle'}
   if(Date.now()>=pending.expiresAt){this.pending=null;return {state:'expired'}}
   const payload=mediaRecord(await (await this.fetch(`${POLL_URL}?qrcode_key=${encodeURIComponent(pending.key)}`)).json()),data=mediaRecord(payload.data)
   const code=Number(data.code)
   if(code===0){
    const url=new URL(mediaString(data.url))
    const cookie=['SESSDATA','bili_jct','DedeUserID'].map(name=>url.searchParams.get(name)?`${name}=${url.searchParams.get(name)}`:'').filter(Boolean).join('; ')
    if(!cookie)throw new Error('B站登录成功但未返回授权凭据')
    fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file,JSON.stringify({cookie,updatedAt:Date.now()}),{mode:0o600});fs.chmodSync(this.file,0o600)
    this.pending=null;return {state:'success'}
   }
   if(code===86038){this.pending=null;return {state:'expired'}}
   return {state:'waiting'}
  }
  logout(){this.pending=null;fs.rmSync(this.file,{force:true});return {state:'logged_out'}}
 }
}
