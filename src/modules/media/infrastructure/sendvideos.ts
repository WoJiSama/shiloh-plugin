import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {BilibiliParseResult,MediaSegment} from '../../../contracts/mediaRelay.js'
import {fetchDownloadToFile} from '../../shared/infrastructure/parallelDownload.js'
import {mediaError} from './mediaDecoders.js'
export interface SendVideosPorts {
 parse(answer:string):Promise<BilibiliParseResult[]>;
 video(file:string):MediaSegment;
 download?:(url:string,file:string,options:{maxBytes:number;timeoutMs:number})=>Promise<unknown>;
 log?:(message:string)=>void;
}
/** Each invocation owns its temporary directory; never remove another concurrent request's files. */
export function createSendVideos(ports:SendVideosPorts) {
 return async function sendvideos(answer:string,event:{reply(message:MediaSegment):Promise<unknown>}) {
  let directory=''
  try {
   const results=await ports.parse(answer)
   directory=await fs.mkdtemp(path.join(os.tmpdir(),'shiloh-plugin-sendvideos-'))
   let sent=0
   for(const result of results){
    if(sent>=2)break
    if(!result.success||!result.videoUrl)continue
    const file=path.join(directory,`video-${sent}.mp4`)
    try{
     await (ports.download||fetchDownloadToFile)(result.videoUrl,file,{maxBytes:30*1024*1024,timeoutMs:40000})
     await event.reply(ports.video(file));sent++
    }catch(error){ports.log?.(`视频处理失败，跳过: ${mediaError(error).message}`)}
    finally{await fs.unlink(file).catch(()=>{})}
   }
  }catch(error){ports.log?.(`视频处理出错，跳过: ${mediaError(error).message}`)}
  finally{if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{})}
 }
}
