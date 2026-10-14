import {writeFile,mkdir} from 'node:fs/promises'
import {join,dirname} from 'node:path'
export function createGroupNameCache(names:Record<string,string>,filePath=join(process.cwd(),'data','group_names.json')) {
 let pending=Promise.resolve()
 return async (groupId:string|number,name:string):Promise<void>=>{
  if(names[String(groupId)]===name)return
  names[String(groupId)]=name
  const snapshot=JSON.stringify(names,null,2)
  pending=pending.catch(()=>{}).then(async()=>{await mkdir(dirname(filePath),{recursive:true});await writeFile(filePath,snapshot)})
  await pending
 }
}
