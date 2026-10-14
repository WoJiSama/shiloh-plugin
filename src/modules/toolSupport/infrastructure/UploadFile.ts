import type {FileEvent,SourceMessage,DownloadPorts} from '../../../contracts/toolSupport.js'
import {toolRecord} from '../../../contracts/toolExecution.js'
export async function takeSourceMsg(e:FileEvent,{img,file}:{img?:boolean;file?:boolean}={}) {
 let source:SourceMessage|null|undefined=null
 if(e.getReply)source=await e.getReply()
 else if(e.source){
  if(e.group?.getChatHistory)source=(await e.group.getChatHistory(e.source.seq,1)).pop()
  else if(e.friend?.getChatHistory)source=(await e.friend.getChatHistory(e.source.time,1)).pop()
 }
 if(!source)return false
 if(img){const images=source.message.filter(item=>item.type==='image').map(item=>item.url).filter((url):url is string=>typeof url==='string');return images.length?images:false}
 if(file){const first=source.message[0];if(first?.type!=='file')return false;return e.group_id?e.group?.getFileUrl?.(first.fid):e.friend?.getFileUrl?.(first.fid)}
 return source
}
export function createFileDownload(ports:DownloadPorts){
 async function getBufferFile(fileUrl:string,filename:string){
  try{
   const response=await ports.get(fileUrl)
   if(response.status>=400)return {type:null,buffer:null}
   if(String(response.headers['content-type']||'').includes('application/json')){
    const json=toolRecord(JSON.parse(new TextDecoder().decode(response.data)))
    if(typeof json.retmsg==='string'&&json.retmsg.includes('expired'))return {type:null,buffer:null}
   }
   return {type:ports.lookup(filename)||'application/octet-stream',buffer:Buffer.from(response.data).toString('base64')}
  }catch(error){ports.logger.error('校验失败:',error);return {type:null,buffer:null}}
 }
 return {getBufferFile}
}
export function createTakeFiles(getFileInfo:(event:FileEvent)=>Promise<{fileUrl?:string;fileName?:string}>){
 return async function TakeFiles(event:FileEvent){const info=await getFileInfo(event);return info.fileUrl?[info]:false}
}
