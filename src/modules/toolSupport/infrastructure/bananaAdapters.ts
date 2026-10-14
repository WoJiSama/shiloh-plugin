export interface DrawForm {append(name:string,value:string|Buffer,options?:{filename:string;contentType:string;knownLength:number}):void}
export function encodeDrawMultipart<T extends DrawForm>(fields:Record<string,string>,files:{data:Uint8Array;filename:string;mimeType:string}[],createForm:()=>T,serialize:(form:T)=>Promise<{headers:Record<string,string>;body:BodyInit}>){
 const form=createForm();for(const [name,value]of Object.entries(fields))form.append(name,value)
 for(const file of files)form.append('image',Buffer.from(file.data),{filename:file.filename,contentType:file.mimeType,knownLength:file.data.length})
 return serialize(form)
}
export async function checkDrawImageUrl(url:string,fetcher:typeof fetch):Promise<boolean>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000)
 try{
  const response=await fetcher(url,{signal:controller.signal});if(!response.ok)return false
  const data=Buffer.from(await response.arrayBuffer())
  if(response.headers.get('content-type')?.includes('application/json')&&/retcode|error/.test(data.toString()))return false
  return [[255,216],[137,80,78,71],[71,73,70],[82,73,70,70],[66,77]].some(signature=>signature.every((value,index)=>data[index]===value))
 }catch{return false}finally{clearTimeout(timer)}
}
