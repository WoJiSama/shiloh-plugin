import {safeTruncateUnicode} from '../../models/domain/unicodeText.js'
export interface UploadedFilePorts {
 getBufferFile(url:string,name:string):Promise<{buffer:string|null}>;
 lookup(name:string):string|false;
 extractFile(mime:string,buffer:string):Promise<string|null>;
 TotalTokens(text:string):Promise<{completion_tokens:number}>;
 logger:{log(...args:unknown[]):void;error(message:string,error:unknown):void}
}
export function createUploadedFileProcessor(ports:UploadedFilePorts){
 return async function processUploadedFile(fileUrl:string,fileName:string,userMessage:string,maxTokens=8000){
  if(!fileName)return userMessage
  try{
   const {buffer}=await ports.getBufferFile(fileUrl,fileName)
   if(buffer===null)return userMessage
   const result=await ports.extractFile(ports.lookup(fileName)||'application/octet-stream',buffer)
   if(result===null)return userMessage
   const {completion_tokens:tokens}=await ports.TotalTokens(result)
   ports.logger.log('文件总 token:',tokens)
   const content=tokens>maxTokens?safeTruncateUnicode(result,maxTokens,'...'):result
   const separator='='.repeat(50)
   const fileInfo=`${separator}\n文件名称: ${fileName}\n${separator}\n文件内容:\n${content}\n${separator}`
   ports.logger.log('文件信息:\n',fileInfo)
   return `${fileInfo}\n\n${userMessage}`
  }catch(error){ports.logger.error('处理文件时出错:',error);return userMessage}
 }
}
